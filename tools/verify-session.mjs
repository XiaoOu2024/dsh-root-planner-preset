// Verifies a real root-planner run from its own session logs.
//
// Why this exists: twice now, a conclusion about this preset was drawn from a run
// whose ROOT session was composed with a different preset (the children were
// root-planner while the root was `standard`), so every rule and permission in the
// tree was mismatched — and the run looked like a bundle defect. Reading the logs
// is the only way to tell. This script does it mechanically.
//
// Usage:
//   node tools/verify-session.mjs <session-dir> [--expect-depth N] [--quiet]
//
// <session-dir> is the ROOT session directory under
// ~/.dsh/sessions/<cwd-slug>/ ; child directories sitting beside it are found by
// parentSession, so pass only the root.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';

/** Locate the end of the first zstd frame, where the next one begins. */
function frameBytes(buf) {
  for (let i = 4; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) return i;
  }
  return buf.length;
}

/**
 * Decompress a concatenated-zstd file frame by frame.
 *
 * A single decompress call stops at the first frame, which is why a naive read of
 * these logs returns 323 bytes out of 139 KB and silently hides every event.
 * Measured on a real log: frame-by-frame reads 143 654 characters where one call
 * read 323.
 * @param {Buffer} buf - whole file.
 * @returns {Promise<string>} the complete decompressed text.
 */
async function decompressAll(buf) {
  let rest = buf;
  let text = '';
  while (rest.length > 0) {
    const slice = rest.subarray(0, frameBytes(rest));
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

/** Read one session directory into {header, events}. */
async function readSession(dir) {
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
  return { header: events[0], events };
}

const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
const expectDepthIndex = argv.indexOf('--expect-depth');
const expectDepth = expectDepthIndex === -1 ? undefined : Number(argv[expectDepthIndex + 1]);
const rootDir = argv.find((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg));

if (rootDir === undefined) {
  process.stderr.write('usage: node tools/verify-session.mjs <root-session-dir> [--expect-depth N]\n');
  process.exit(2);
}

const base = join(rootDir, '..');
const root = await readSession(rootDir);

const sessions = [{ dir: rootDir, ...root }];
const candidates = [];
for (const name of readdirSync(base)) {
  if (name === rootDir.split(/[\\/]/).pop()) continue;
  const candidate = join(base, name);
  try {
    if (!statSync(join(candidate, 'session.v4.jsonl.zstd')).isFile()) continue;
  } catch {
    continue;
  }
  const session = await readSession(candidate);
  // Only real children count. Sibling ROOT sessions of other conversations live in
  // the same directory and have no parentSession — including them made this report
  // claim a run had failed when it had not.
  if (session.header?.origin !== 'subagent') continue;
  candidates.push({ dir: candidate, ...session });
}

/**
 * Keep only the root's real descendants. Other presets delegate too, and their
 * subagent sessions sit in the same directory; without this walk they appear as
 * children of this run and fail the preset check for the wrong reason.
 */
const rootId = root.header?.id;
const childrenOf = new Map();
for (const session of candidates) {
  const parent = session.header?.parentSession;
  if (parent === undefined) continue;
  const list = childrenOf.get(parent) ?? [];
  list.push(session);
  childrenOf.set(parent, list);
}
const queue = [...(childrenOf.get(rootId) ?? [])];
while (queue.length > 0) {
  const session = queue.shift();
  sessions.push(session);
  queue.push(...(childrenOf.get(session.header?.id) ?? []));
}

const failures = [];
const check = (ok, label) => {
  if (ok) {
    if (!quiet) process.stdout.write(`ok   ${label}\n`);
  } else {
    process.stdout.write(`FAIL ${label}\n`);
    failures.push(label);
  }
};

if (!quiet) process.stdout.write(`root session: ${root.header?.id}\n`);

check(
  root.header?.agentPreset === 'root-planner',
  `root session is composed with root-planner (found "${root.header?.agentPreset ?? '?'}") — if this fails, the run proves nothing about the preset`,
);
check(root.header?.delegationDepth === 0, `root is at depth 0 (found ${root.header?.delegationDepth})`);

const children = sessions.filter((session) => session.header?.parentSession === root.header?.id);
const byId = new Map(sessions.map((session) => [session.header?.id, session]));
const depths = new Map([[root.header?.id, 0]]);
const depthOf = (session) => {
  const known = depths.get(session.header?.id);
  if (known !== undefined) return known;
  const parent = byId.get(session.header?.parentSession);
  const value = parent === undefined ? 1 : depthOf(parent) + 1;
  depths.set(session.header?.id, value);
  return value;
};

if (!quiet) {
  process.stdout.write(`\n${sessions.length} session(s) total:\n`);
  for (const session of sessions) {
    process.stdout.write(
      `  ${String(session.header?.id).slice(0, 20)}  preset=${String(session.header?.agentPreset).padEnd(14)} ` +
        `depth=${depthOf(session)}  parent=${String(session.header?.parentSession ?? '(root)').slice(0, 20)}\n`,
    );
  }
  process.stdout.write('\n');
}

const descendants = sessions.filter((session) => session !== sessions[0]);
check(descendants.length > 0, 'the root actually delegated (at least one child session exists)');

for (const session of descendants) {
  const depth = depthOf(session);
  check(
    session.header?.agentPreset === 'root-planner',
    `child ${String(session.header?.id).slice(0, 8)} at depth ${depth} inherits root-planner (found "${session.header?.agentPreset ?? '?'}")`,
  );
}

const maxDepth = Math.max(0, ...[...sessions].map((session) => depthOf(session)));
if (expectDepth !== undefined) {
  check(maxDepth === expectDepth, `deepest session is depth ${expectDepth} (found ${maxDepth})`);
}

// A delegation attempted from a leaf is the depth cap doing its job, not a defect.
let capped = 0;
for (const session of sessions) {
  const text = JSON.stringify(session.events);
  for (const needle of ['exceeds maxDepth', 'SubagentDepthError', 'unknown global tool']) {
    if (text.includes(needle)) capped += 1;
  }
}
if (!quiet && capped > 0) process.stdout.write(`note: ${capped} depth-cap or mask rejection(s) recorded in the logs\n`);

process.stdout.write(
  failures.length === 0
    ? `\nVERIFIED: root and all ${descendants.length} descendant session(s) used root-planner; max depth ${maxDepth}.\n`
    : `\n${failures.length} CHECK(S) FAILED — this run does not demonstrate the preset.\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
