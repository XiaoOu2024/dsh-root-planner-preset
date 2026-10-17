// Unit test for the workspace guard's boundary logic (guard.js, shipped in this package).
//
// The guard is the only thing standing between a delegated agent and the parent's
// files, so its decisions are tested directly rather than inferred from a live run:
// a denial here is a refused tool call in production, and an accidental allow is a
// silent write into the parent's directory.
//
// Paths are built with `join` from a platform-appropriate root, because the first
// version of this file hardcoded `D:\work\project` and every "expected allow" case
// failed on the Linux CI runner: a drive-letter path is RELATIVE on POSIX, so the guard
// resolved it under the checkout and correctly reported it outside the workspace. The
// guard was right; the test was Windows-only without saying so. Two shell cases stay
// Windows-only on purpose — the command scan looks for drive-letter paths, and that is a
// real limitation worth stating rather than papering over here.
//
// Usage: node test-guard.mjs

import { join } from 'node:path'
import { makeGuard } from './guard.js'

const isWindows = process.platform === 'win32'

// A Windows-flavoured root on Windows and a POSIX one elsewhere, so the same semantics
// are asserted on both platforms instead of silently skipped on one of them.
const cwd = isWindows ? 'D:\\work\\project' : '/work/project'
const workspace = join(cwd, '_agents')
const outside = isWindows ? 'D:\\other\\x.txt' : '/other/x.txt'
const guard = makeGuard(cwd, workspace)

let passed = 0
let failed = 0
let skipped = 0

/**
 * Assert one guard decision.
 * @param label - what the case proves.
 * @param exec - the tool call the guard sees.
 * @param shouldAllow - whether the call must be permitted.
 * @param windowsOnly - skip where the behaviour is deliberately Windows-only.
 */
function check(label, exec, shouldAllow, windowsOnly = false) {
  if (windowsOnly && !isWindows) {
    skipped += 1
    process.stdout.write(`skip ${label}  (Windows-only behaviour)\n`)
    return
  }
  const verdict = guard(exec)
  const allowed = verdict === undefined
  if (allowed === shouldAllow) {
    passed += 1
    process.stdout.write(`ok   ${label}  ${allowed ? '(allowed)' : `(denied: ${String(verdict).split('.')[0]})`}\n`)
  } else {
    failed += 1
    process.stdout.write(
      `FAIL ${label} — expected ${shouldAllow ? 'allow' : 'deny'}, got ${allowed ? 'allow' : 'deny'}${verdict ? `: ${verdict}` : ''}\n`,
    )
  }
}

// ── containment ──────────────────────────────────────────────────────────────
check('contains: same path', { name: 'write', arguments: { path: workspace } }, true)
check('contains: child path', { name: 'write', arguments: { path: join(workspace, 'a', 'x.txt') } }, true)

// ── file tools: the structural part ──────────────────────────────────────────
check('write inside workspace', { name: 'write', arguments: { path: join(workspace, 'a', 'out.txt') } }, true)
check('write inside workspace, relative', { name: 'write', arguments: { path: join('_agents', 'a', 'out.txt') } }, true)
check('write in parent file', { name: 'write', arguments: { path: join(cwd, 'report.md') } }, false)
check('write sibling workspace (same root)', { name: 'write', arguments: { path: join(workspace, 'b', 'out.txt') } }, true)
check('write outside the project', { name: 'write', arguments: { path: outside } }, false)
check('write escaping with ..', { name: 'write', arguments: { path: join('_agents', '..', '..', 'escape.txt') } }, false)
check('edit in parent file', { name: 'edit', arguments: { path: join(cwd, 'A_文件导航.md') } }, false)
check('ops_replace in parent file', { name: 'ops_replace', arguments: { path: join(cwd, 'readme.md') } }, false)
check('ops_replace inside workspace', { name: 'ops_replace', arguments: { path: join(workspace, 'a', 'x.ps1') } }, true)
check('prefix trap: _agents-other is not _agents', { name: 'write', arguments: { path: join(cwd, '_agents-other', 'x.txt') } }, false)
check('no path argument is not a boundary call', { name: 'write', arguments: {} }, true)

// ── shell: the best-effort part ──────────────────────────────────────────────
check('pwsh without workdir (would run in parent)', { name: 'pwsh', arguments: { command: 'echo x > y.txt' } }, false)
check('pwsh with workdir inside', { name: 'pwsh', arguments: { command: 'echo x > y.txt', workdir: join(workspace, 'a') } }, true)
check('pwsh with workdir outside', { name: 'pwsh', arguments: { command: 'ls', workdir: cwd } }, false)
check('pwsh relative workdir inside', { name: 'pwsh', arguments: { command: 'ls', workdir: join('_agents', 'a') } }, true)

// The command scan matches drive-letter paths, so these only hold on Windows. On POSIX
// an absolute path inside a command is not detected at all — a documented limitation.
check(
  'pwsh absolute write outside',
  { name: 'pwsh', arguments: { command: `copy x.txt ${join(cwd, 'report.md')}`, workdir: join(workspace, 'a') } },
  false,
  true,
)
check(
  'pwsh absolute write inside',
  { name: 'pwsh', arguments: { command: `copy x.txt ${join(workspace, 'a', 'report.md')}`, workdir: join(workspace, 'a') } },
  true,
  true,
)

// ── unrelated tools ──────────────────────────────────────────────────────────
check('read is untouched', { name: 'read', arguments: { path: join(cwd, 'report.md') } }, true)
check('unknown tool is untouched', { name: 'ops_grep', arguments: { pattern: 'x', path: cwd } }, true)

process.stdout.write(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}\n`)
process.exit(failed === 0 ? 0 : 1)
