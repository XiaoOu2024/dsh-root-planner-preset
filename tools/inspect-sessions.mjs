// Forensics on the real root-planner test run: which preset did the root session
// compose with, and what tools did each level actually receive?
//
// Usage: node inspect-sessions.mjs <rootSessionDir> [childSessionDir ...]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** Read one .jsonl.zstd session log into parsed events. */
function readSession(dir) {
  const raw = zstdDecompressSync(readFileSync(join(dir, 'session.v4.jsonl.zstd')));
  return raw
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

for (const dir of process.argv.slice(2)) {
  const events = readSession(dir);
  const types = new Map();
  for (const event of events) types.set(event.type, (types.get(event.type) ?? 0) + 1);

  process.stdout.write(`\n===== ${dir.split(/[\\/]/).pop()} — ${events.length} events =====\n`);
  process.stdout.write(`event types: ${[...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `${t}×${n}`).join(', ')}\n`);

  // Session header: the composition that was actually in force.
  for (const event of events) {
    if (event.type === 'session/header' || event.type === 'session/start') {
      const h = event.data ?? event;
      process.stdout.write(
        `header: origin=${h.header?.origin ?? h.origin} parent=${h.header?.parentSession ?? h.parentSession} ` +
          `depth=${h.header?.delegationDepth ?? h.delegationDepth} preset=${h.preset ?? h.presetId ?? '(not in header)'}\n`,
      );
    }
  }

  // Tool names actually offered to this session, from its request payloads.
  const offered = new Set();
  for (const event of events) {
    const message = event.data?.request?.messages ?? event.request?.messages;
    if (!Array.isArray(message)) continue;
    for (const entry of message) {
      if (entry?.role !== 'system') continue;
      const text = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
      for (const match of text.matchAll(/"name":\s*"([a-z_0-9]+)"/g)) offered.add(match[1]);
    }
  }
  if (offered.size > 0) {
    process.stdout.write(`tools seen in request payloads (${offered.size}): ${[...offered].sort().join(', ')}\n`);
  }

  // Any tool error mentioning a mask or an executor.
  for (const event of events) {
    const text = JSON.stringify(event);
    for (const needle of ['unknown global tool', 'EXECUTOR_UNAVAILABLE', 'SubagentDepthError', 'exceeds maxDepth']) {
      if (text.includes(needle)) {
        const start = Math.max(0, text.indexOf(needle) - 220);
        process.stdout.write(`  [${needle}] …${text.slice(start, text.indexOf(needle) + 220)}…\n`);
      }
    }
  }
}
