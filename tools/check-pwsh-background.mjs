// Checks whether `run_in_background` still exists inside a session's `pwsh` tool
// schema — the one property this preset enforces structurally rather than by asking
// the model nicely.
//
// A whole-log substring search cannot answer it: the phrase also appears in
// `ops_bash`'s own description on this machine, so the naive check reports "present"
// for a session where the parameter has genuinely been removed.
//
// Usage: node tools/check-pwsh-background.mjs <session-dir> [...]

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

/**
 * Find every `"name":"<tool>"` occurrence and return the window of text that follows
 * it — close enough to hold that tool's own parameters object.
 * @param text - whole decompressed log.
 * @param tool - tool name to locate.
 * @returns the following windows, longest first.
 */
function windowsAfter(text, tool) {
  const needle = `\\"name\\":\\"${tool}\\"`;
  const plain = `"name":"${tool}"`;
  const out = [];
  for (const pattern of [needle, plain]) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(pattern, from);
      if (at === -1) break;
      out.push(text.slice(at, at + 4000));
      from = at + pattern.length;
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

for (const dir of process.argv.slice(2)) {
  const text = await decompressAll(readFileSync(join(dir, 'session.v4.jsonl.zstd')));
  const header = JSON.parse(text.split('\n')[0]);

  const pwshWindows = windowsAfter(text, 'pwsh');
  // The parameters object is the one that mentions the tool's own argument names.
  const schemaWindow = pwshWindows.find((w) => w.includes('workdir') || w.includes('command')) ?? pwshWindows[0] ?? '';
  const backgroundInSchema = /run_in_background/.test(schemaWindow);
  const backgroundAnywhere = text.includes('run_in_background');

  process.stdout.write(
    `\n${dir.split(/[\\/]/).pop().slice(0, 20)}  depth=${header?.delegationDepth}\n` +
      `  "run_in_background" anywhere in the log : ${backgroundAnywhere}\n` +
      `  inside the pwsh schema window          : ${backgroundInSchema}` +
      `${backgroundInSchema ? '  <-- the parameter is still offered' : '  <-- removed, as intended'}\n` +
      `  pwsh schema window size                 : ${schemaWindow.length} chars\n`,
  );
  if (backgroundAnywhere && !backgroundInSchema) {
    const at = text.indexOf('run_in_background');
    process.stdout.write(`  first mention context: …${text.slice(Math.max(0, at - 120), at + 60)}…\n`);
  }
}
