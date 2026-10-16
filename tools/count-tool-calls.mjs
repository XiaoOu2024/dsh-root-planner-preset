// Counts the tool calls actually made in one session, by name.
//
// Written to settle a question that string counting cannot: which delegation tool a
// given level really called, and therefore which tools the child mask actually left
// visible. A raw occurrence count of "subagent" matches "subagent_fork" too, and the
// preset's own prose mentions both.
//
// Usage: node tools/count-tool-calls.mjs <session-dir> [...]

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

for (const dir of process.argv.slice(2)) {
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
  const calls = new Map();
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const name = event.data?.name ?? event.data?.message?.name;
    if (typeof name !== 'string') continue;
    calls.set(name, (calls.get(name) ?? 0) + 1);
  }

  const name = dir.split(/[\\/]/).pop().slice(0, 20);
  process.stdout.write(
    `\n${name}  depth=${header?.delegationDepth}  origin=${header?.origin}  ${events.length} events\n`,
  );
  const rows = [...calls.entries()].sort((a, b) => b[1] - a[1]);
  process.stdout.write(`  ${rows.length} distinct tools called: ${rows.map(([t, n]) => `${t}×${n}`).join(', ') || '(none)'}\n`);
  const delegation = rows.filter(([t]) => t.startsWith('subagent'));
  process.stdout.write(
    `  delegation calls: ${delegation.map(([t, n]) => `${t}×${n}`).join(', ') || '(none)'}\n`,
  );
}
