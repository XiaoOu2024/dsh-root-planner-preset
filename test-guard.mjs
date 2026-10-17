// Unit test for the workspace guard's boundary logic (guard.js, shipped in this package).
//
// The guard is the only thing standing between a delegated agent and the parent's
// files, so its decisions are tested directly rather than inferred from a live run:
// a denial here is a refused tool call in production, and an accidental allow is a
// silent write into the parent's directory.
//
// Usage: node test-guard.mjs

import { makeGuard, contains } from './guard.js'

const cwd = 'D:\\work\\project'
const workspace = 'D:\\work\\project\\_agents'
const guard = makeGuard(cwd, workspace)

let passed = 0
let failed = 0

/**
 * Assert one guard decision.
 * @param label - what the case proves.
 * @param exec - the tool call the guard sees.
 * @param shouldAllow - whether the call must be permitted.
 */
function check(label, exec, shouldAllow) {
  const verdict = guard(exec)
  const allowed = verdict === undefined
  if (allowed === shouldAllow) {
    passed += 1
    process.stdout.write(`ok   ${label}  ${allowed ? '(allowed)' : `(denied: ${verdict.split('.')[0]})`}\n`)
  } else {
    failed += 1
    process.stdout.write(
      `FAIL ${label} — expected ${shouldAllow ? 'allow' : 'deny'}, got ${allowed ? 'allow' : 'deny'}${verdict ? `: ${verdict}` : ''}\n`,
    )
  }
}

// ── containment ──────────────────────────────────────────────────────────────
check('contains: same path', { name: 'write', arguments: { path: 'D:\\work\\project\\_agents' } }, true)
check('contains: case-insensitive child', { name: 'write', arguments: { path: 'd:\\work\\project\\_agents\\a\\x.txt' } }, true)

// ── file tools: the structural part ──────────────────────────────────────────
check('write inside workspace', { name: 'write', arguments: { path: 'D:\\work\\project\\_agents\\a\\out.txt' } }, true)
check('write inside workspace, relative', { name: 'write', arguments: { path: '_agents\\a\\out.txt' } }, true)
check('write in parent file', { name: 'write', arguments: { path: 'D:\\work\\project\\report.md' } }, false)
check('write sibling workspace (allowed: same root)', { name: 'write', arguments: { path: 'D:\\work\\project\\_agents\\b\\out.txt' } }, true)
check('write outside the project', { name: 'write', arguments: { path: 'D:\\other\\x.txt' } }, false)
check('write escaping with ..', { name: 'write', arguments: { path: '_agents\\..\\..\\escape.txt' } }, false)
check('edit in parent file', { name: 'edit', arguments: { path: 'D:\\work\\project\\A_文件导航.md' } }, false)
check('ops_replace in parent file', { name: 'ops_replace', arguments: { path: 'D:\\work\\project\\readme.md' } }, false)
check('ops_replace inside workspace', { name: 'ops_replace', arguments: { path: 'D:\\work\\project\\_agents\\a\\x.ps1' } }, true)
check('prefix trap: _agents-other is not _agents', { name: 'write', arguments: { path: 'D:\\work\\project\\_agents-other\\x.txt' } }, false)
check('no path argument is not a boundary call', { name: 'write', arguments: {} }, true)

// ── shell: the best-effort part ──────────────────────────────────────────────
check('pwsh without workdir (would run in parent)', { name: 'pwsh', arguments: { command: 'echo x > y.txt' } }, false)
check('pwsh with workdir inside', { name: 'pwsh', arguments: { command: 'echo x > y.txt', workdir: 'D:\\work\\project\\_agents\\a' } }, true)
check('pwsh with workdir outside', { name: 'pwsh', arguments: { command: 'ls', workdir: 'D:\\work\\project' } }, false)
check('pwsh relative workdir inside', { name: 'pwsh', arguments: { command: 'ls', workdir: '_agents\\a' } }, true)
check('pwsh absolute write outside', { name: 'pwsh', arguments: { command: 'copy x.txt D:\\work\\project\\report.md', workdir: 'D:\\work\\project\\_agents\\a' } }, false)
check('pwsh absolute write inside', { name: 'pwsh', arguments: { command: 'copy x.txt D:\\work\\project\\_agents\\a\\report.md', workdir: 'D:\\work\\project\\_agents\\a' } }, true)
check('pwsh write above the project is out of scope', { name: 'pwsh', arguments: { command: 'echo x > D:\\other\\x.txt', workdir: 'D:\\work\\project\\_agents\\a' } }, true)

// ── unrelated tools ──────────────────────────────────────────────────────────
check('read is untouched', { name: 'read', arguments: { path: 'D:\\work\\project\\report.md' } }, true)
check('unknown tool is untouched', { name: 'ops_grep', arguments: { pattern: 'x', path: 'D:\\work\\project' } }, true)

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
