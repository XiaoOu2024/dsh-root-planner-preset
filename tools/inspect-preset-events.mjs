// Reports the preset-related events in one session log — the durable evidence of
// which preset a session was composed with, and whether a selection was attempted.
//
// Usage: node tools/inspect-preset-events.mjs <session-dir>

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';

/** Locate the end of the first zstd frame, where the next one begins. */
function firstFrameEnd(buf) {
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
    const slice = rest.subarray(0, firstFrameEnd(rest));
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

const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write('usage: node tools/inspect-preset-events.mjs <session-dir>\n');
  process.exit(2);
}

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

process.stdout.write(`${events.length} events, ${text.length} chars\n\n`);

const header = events[0];
process.stdout.write(`header: id=${header?.id}\n  agentPreset=${header?.agentPreset}\n  origin=${header?.origin} depth=${header?.delegationDepth}\n`);

process.stdout.write('\npreset-related events:\n');
let found = 0;
for (const event of events) {
  const type = String(event.type ?? '');
  if (!/preset/i.test(type)) continue;
  found += 1;
  process.stdout.write(`  #${events.indexOf(event)} ${type} ${JSON.stringify(event.data ?? event).slice(0, 220)}\n`);
}
if (found === 0) process.stdout.write('  (none — no agent-preset/selected event was ever appended)\n');

process.stdout.write('\nuser messages (first 3):\n');
let users = 0;
for (const event of events) {
  const content = event.data?.message?.content ?? event.message?.content;
  const role = event.data?.message?.role ?? event.message?.role;
  if (role !== 'user' || typeof content !== 'string') continue;
  users += 1;
  if (users > 3) break;
  process.stdout.write(`  #${events.indexOf(event)} ${JSON.stringify(content.slice(0, 160))}\n`);
}
if (users === 0) process.stdout.write('  (no user messages recorded yet)\n');
