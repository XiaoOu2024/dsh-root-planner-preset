// Extracts the tool names a session was actually offered, from the tool schemas the
// session log persists.
//
// Why this exists: a subagent's own account of its tools is a language-model
// recollection, and it can be wrong in both directions (the first such report
// omitted `write` from its list while claiming to discuss it). The persisted
// schemas are the registry's own output, so they settle questions like "does the
// child mask really apply?" and "is run_in_background gone?" without guessing.
//
// Usage: node tools/extract-offered-tools.mjs <session-dir> [...]

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

  // A tool schema is an object carrying `name` plus `parameters` (and `description`).
  // Collect every name that appears next to a parameters object anywhere in the log.
  const names = new Set();
  for (const match of text.matchAll(/\{\\?"name\\?":\\?"([a-zA-Z_][a-zA-Z0-9_]*)\\?":\{[^{}]*\\?"type\\?":\\?"object\\?"/g)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/\\?"name\\?":\\?"([a-zA-Z_][a-zA-Z0-9_]*)\\?",\\?"description\\?":/g)) {
    names.add(match[1]);
  }

  const header = JSON.parse(text.split('\n')[0]);
  const listed = [...names].sort();
  process.stdout.write(
    `\n${dir.split(/[\\/]/).pop().slice(0, 20)}  depth=${header?.delegationDepth}\n  ${listed.length} names: ${listed.join(', ')}\n`,
  );
  for (const probe of ['workflow', 'present', 'job_output', 'exit_plan_mode', 'subagent', 'subagent_fork', 'pwsh', 'write']) {
    process.stdout.write(`    ${probe.padEnd(16)} ${names.has(probe) ? 'present' : 'ABSENT'}\n`);
  }
}
