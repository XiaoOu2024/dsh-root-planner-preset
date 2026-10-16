// Extracts the runtime's own global-tool inventory from a session log.
//
// `tools.restrict()` prints every known global tool when it refuses a name, so a
// session that hit `names unknown global tool` carries the authoritative list for
// its own environment. That list is what the child mask has to be a subset of, and
// it is the only trustworthy source — a mask built from memory breaks every child
// creation, which is exactly what happened twice in this repository.
//
// Usage: node tools/extract-tool-inventory.mjs <session.jsonl.zstd> [...]

import { readFileSync } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';

/** Locate the end of the first zstd frame, where the next one begins. */
function firstFrameEnd(buf) {
  for (let i = 4; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) return i;
  }
  return buf.length;
}

/**
 * Decompress a concatenated-zstd log frame by frame. A single decompress call
 * stops at the first frame, which is why a naive read of these logs returns a few
 * hundred bytes out of tens of kilobytes and hides every event.
 * @param {string} path - the .jsonl.zstd log.
 * @returns {Promise<string>} the whole decompressed text.
 */
async function decompressAll(path) {
  let rest = readFileSync(path);
  let text = '';
  while (rest.length > 0) {
    const slice = rest.subarray(0, firstFrameEnd(rest));
    try {
      text += await new Promise((resolve, reject) => {
        const chunks = [];
        const decoder = createZstdDecompress();
        decoder.on('data', (chunk) => chunks.push(chunk));
        decoder.on('error', reject);
        decoder.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        decoder.end(slice);
      });
    } catch {
      break;
    }
    if (slice.length >= rest.length) break;
    rest = rest.subarray(slice.length);
  }
  return text;
}

for (const path of process.argv.slice(2)) {
  const text = await decompressAll(path);
  const match = /known global tools: ([^"\\\]]+)/.exec(text);
  process.stdout.write(`\n=== ${path.split(/[\\/]/).pop()} (${text.length} chars decompressed) ===\n`);
  if (match === null) {
    process.stdout.write(`no inventory line found. mentions "unknown global tool": ${text.includes('unknown global tool')}\n`);
    continue;
  }
  const tools = match[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  process.stdout.write(`${tools.length} global tools:\n  ${tools.join('\n  ')}\n`);
}
