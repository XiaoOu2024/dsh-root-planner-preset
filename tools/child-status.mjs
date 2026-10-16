// Reports whether each child session in a run is finished or still active, from its
// own log — the question behind "subagent limit reached": are slots being held by
// children that already stopped, or by children that are genuinely still working?
//
// Usage: node tools/child-status.mjs <root-session-dir>

import { readdirSync, readFileSync, statSync } from 'node:fs';
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

const rootDir = process.argv[2];
if (rootDir === undefined) {
  process.stderr.write('usage: node tools/child-status.mjs <root-session-dir>\n');
  process.exit(2);
}

const base = join(rootDir, '..');
const rootId = rootDir.split(/[\\/]/).pop();
const rows = [];

for (const name of readdirSync(base)) {
  const file = join(base, name, 'session.v4.jsonl.zstd');
  try {
    if (!statSync(file).isFile()) continue;
  } catch {
    continue;
  }
  const text = await decompressAll(readFileSync(file));
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
  if (name !== rootId && header?.origin !== 'subagent') continue;

  const types = new Map();
  for (const event of events) types.set(event.type, (types.get(event.type) ?? 0) + 1);

  const last = events[events.length - 1];
  rows.push({
    id: name,
    depth: header?.delegationDepth,
    mtime: statSync(file).mtime,
    events: events.length,
    lastType: last?.type,
    lastTime: last?.time,
    // A turn that ended and left nothing pending is the shape of a settled child.
    turnEnds: types.get('turn/end') ?? 0,
    hasInboxPending: types.has('agent/inbox/spliced') && !types.has('agent/inbox/claimed'),
    cancels: types.get('agent/cancel') ?? 0,
  });
}

rows.sort((a, b) => (a.lastTime ?? 0) - (b.lastTime ?? 0));
const fmt = (ms) => (ms === undefined ? '?' : new Date(ms).toISOString().slice(11, 19));

process.stdout.write(`${rows.length} agent session(s) under ${base}\n\n`);
process.stdout.write('depth  turnEnds  events  last event type           last event time  session\n');
for (const row of rows) {
  process.stdout.write(
    `${String(row.depth ?? '-').padEnd(6)} ${String(row.turnEnds).padEnd(9)} ${String(row.events).padEnd(7)} ` +
      `${String(row.lastType ?? '-').padEnd(25)} ${fmt(row.lastTime).padEnd(16)} ${row.id.slice(0, 20)}\n`,
  );
}
