// Measures cross-agent read overlap in a real run: how many files were read by more
// than one agent, and how much redundant reading that represents.
//
// The question this answers: sessions are isolated, so a parent cannot pass "what I
// already read" to a sibling. Is that redundancy a rounding error or the dominant
// cost of the fan-out? Only the logs can say.
//
// Usage: node tools/measure-read-overlap.mjs <session-dir> [...]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';

/** Locate the end of the first zstd frame, where the next one begins. */
function frameEnd(buf) {
  for (let i = 4; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) return i;
  }
  return buf.length;
}

/** Decompress a concatenated-zstd log frame by frame. */
async function decompressAll(buf) {
  let rest = buf;
  let text = '';
  while (rest.length > 0) {
    const slice = rest.subarray(0, frameEnd(rest));
    try {
      text += await new Promise((resolve, reject) => {
        const chunks = [];
        const dec = createZstdDecompress();
        dec.on('data', (chunk) => chunks.push(chunk));
        dec.on('error', reject);
        dec.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        dec.end(slice);
      });
    } catch {
      break;
    }
    if (slice.length >= rest.length) break;
    rest = rest.subarray(slice.length);
  }
  return text;
}

const READ_TOOLS = new Set(['read', 'ops_inspect_local_file']);

/** Normalize a path argument so the same file spelled two ways counts once. */
function normalize(value) {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\\/g, '/').toLowerCase().trim();
}

/**
 * Read one tool call's arguments. The log stores them as a JSON *string*, not as an
 * object — reading `arguments.path` off it silently yields nothing, which made the
 * first version of this tool report zero overlap on a run full of reads.
 * @param data - the `tool/call` event's data.
 * @returns the parsed arguments, or an empty object.
 */
function parseArguments(data) {
  const raw = data?.arguments ?? data?.message?.arguments;
  if (typeof raw === 'object' && raw !== null) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Pull (agent, path) read pairs out of one session log. */
async function readsOf(dir) {
  const text = await decompressAll(readFileSync(join(dir, 'session.v4.jsonl.zstd')));
  const events = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const header = events[0];
  const reads = [];
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const name = event.data?.name ?? event.data?.message?.name;
    if (!READ_TOOLS.has(name)) continue;
    const args = parseArguments(event.data);
    const path = args.path ?? args.file_path;
    const norm = normalize(path);
    if (norm !== undefined) reads.push({ path: norm, depth: header?.delegationDepth });
  }
  return { id: dir.split(/[\\/]/).pop(), depth: header?.delegationDepth, reads };
}

const sessions = [];
for (const dir of process.argv.slice(2)) sessions.push(await readsOf(dir));

/** How many distinct agents touched each file. */
const byPath = new Map();
for (const session of sessions) {
  for (const path of new Set(session.reads.map((r) => r.path))) {
    const list = byPath.get(path) ?? [];
    list.push(session.id.slice(0, 8));
    byPath.set(path, list);
  }
}

const totalReads = sessions.reduce((sum, s) => sum + s.reads.length, 0);
const shared = [...byPath.entries()].filter(([, agents]) => agents.length > 1);
const sharedReads = sessions.reduce(
  (sum, s) => sum + s.reads.filter((r) => (byPath.get(r.path)?.length ?? 0) > 1).length,
  0,
);

process.stdout.write(`\n${sessions.length} session(s), ${totalReads} read calls, ${byPath.size} distinct paths\n`);
process.stdout.write(
  `paths read by more than one agent: ${shared.length} (${((shared.length / Math.max(1, byPath.size)) * 100).toFixed(1)}% of paths)\n`,
);
process.stdout.write(
  `read calls that hit a path another agent also read: ${sharedReads} (${((sharedReads / Math.max(1, totalReads)) * 100).toFixed(1)}% of reads)\n`,
);

const worst = shared.sort((a, b) => b[1].length - a[1].length).slice(0, 12);
if (worst.length > 0) {
  process.stdout.write('\nmost shared paths:\n');
  for (const [path, agents] of worst) {
    process.stdout.write(`  ${String(agents.length)}× ${path.slice(-96)}\n`);
  }
}
