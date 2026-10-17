// Keeps a delegated subagent inside the workspace its parent gave it.
//
// This module ships inside `dsh-root-planner-preset` and is mounted as one of the
// preset's own plugin rows (`dsh-root-planner-preset/guard`), so installing the preset
// brings the protocol and its enforcement together. That placement is deliberate: the
// `_agents/` convention is defined by this preset's persona, and a guard installed
// without it would fence agents that were never told where they may write.
//
// One guard, registered once on the plugin's own context, inspects every tool call
// and decides from the calling agent's session header. That is deliberately simpler
// than wiring per-agent listeners: `ToolExecution` already carries `agent`, so the
// guard needs neither the `agent/created` payload shape nor a per-agent context, and
// nothing has to be registered or torn down when a child appears or disappears.
//
// Why a guard rather than a prompt rule: `tools.guard()` is synchronous and monotonic.
// It refuses the call instead of asking the model not to make it, and no later guard
// can force-allow a call this one denied.
//
// Two strengths are in play and the difference is not cosmetic:
//
//   * File tools carry the target path in their arguments, so a write, edit or
//     replace outside `_agents/` is refused structurally — the call never runs.
//   * Shell tools carry a command string, and a command can name a path no argument
//     scan will see (`$env:HOME` + '..', a script that writes, a Here-String). For
//     those the guard enforces the two things it can prove: the working directory
//     must be inside the workspace, and an absolute path written into the command
//     must not point at the parent's files. Anything assembled at runtime still gets
//     past — the parent's timestamp check is the backstop for that, and this file
//     says so rather than pretending the shell is confined.

import { appendFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** Tools that take a target file path as an argument. */
const FILE_TOOLS = new Set(['write', 'edit', 'ops_replace'])

/** Tools that take a command string, where the guard is best-effort. */
const SHELL_TOOLS = new Set(['pwsh', 'ops_bash'])

/** Argument keys the file tools use for their target. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'targetPath']

/** Argument keys the shell tools use for the working directory. */
const WORKDIR_KEYS = ['workdir', 'cwd']

/**
 * Compare two absolute paths for containment, case-insensitively because this runs
 * on Windows where `D:\X` and `d:\x` are the same directory.
 * @param parent - the directory that must contain `child`.
 * @param child - the candidate path.
 * @returns whether `child` is `parent` or below it.
 */
function contains(parent, child) {
  const p = parent.replace(/[\\/]+$/, '').toLowerCase()
  const c = child.replace(/[\\/]+$/, '').toLowerCase()
  if (c === p) return true
  return c.startsWith(`${p}${sep}`) || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`)
}

/**
 * Pull the first string argument under any of the given keys.
 * @param args - the parsed call arguments.
 * @param keys - candidate keys in priority order.
 * @returns the value, or `undefined` when none is a string.
 */
function firstString(args, keys) {
  if (typeof args !== 'object' || args === null) return undefined
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Resolve one guard for a single agent.
 * @param cwd - the session working directory, used to resolve relative paths.
 * @param workspace - the absolute directory the agent may write in.
 * @returns a synchronous guard.
 */
function makeGuard(cwd, workspace) {
  const describe = (target) =>
    `outside your workspace. You may write only inside ${JSON.stringify(workspace)}; ` +
    `everything else in the parent's directory is read-only to you. ` +
    `Send your parent a change request instead of writing ${JSON.stringify(target)} directly.`

  return (exec) => {
    const name = exec?.name
    const args = exec?.arguments
    if (typeof name !== 'string') return undefined

    if (FILE_TOOLS.has(name)) {
      const raw = firstString(args, PATH_KEYS)
      // No path argument at all is the tool's own validation problem, not a boundary
      // violation — refusing here would only hide the real error message.
      if (raw === undefined) return undefined
      const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
      if (!contains(workspace, abs)) return `${name}: ${describe(abs)}`
      return undefined
    }

    if (SHELL_TOOLS.has(name)) {
      // A shell with no explicit workdir runs in the session cwd, which is the
      // parent's directory — precisely the place the child may not write. Requiring
      // the workspace as workdir makes every relative path in the command land where
      // it belongs.
      const workdir = firstString(args, WORKDIR_KEYS)
      const effective = workdir === undefined ? cwd : isAbsolute(workdir) ? resolve(workdir) : resolve(cwd, workdir)
      if (!contains(workspace, effective)) {
        return (
          `${name}: the working directory ${JSON.stringify(effective)} is outside your workspace. ` +
          `Pass workdir: ${JSON.stringify(workspace)} (or a directory inside it) and use relative paths ` +
          `so everything you create stays in your workspace.`
        )
      }
      // Best effort: refuse an absolute path in the command that points at the
      // parent's files. A path assembled at runtime defeats this; the parent's
      // timestamp check is the backstop.
      const command = typeof args?.command === 'string' ? args.command : ''
      const escaped = [...command.matchAll(/[A-Za-z]:[\\/][^\s"'`;|&)]*/g)].map((match) => match[0])
      const outside = escaped.find((candidate) => {
        const abs = resolve(candidate)
        return !contains(workspace, abs) && contains(cwd, abs)
      })
      if (outside !== undefined) return `${name}: the command writes ${JSON.stringify(outside)}, ${describe(outside)}`
      return undefined
    }

    return undefined
  }
}

export const name = 'root-planner-guard'

export const inject = ['tools']

// No `Config` export on purpose: Cordis validates a declared Config with a zod schema
// (`schema.validate`), and a plain JSON Schema object throws at activation with
// "Cannot read properties of undefined (reading 'validate')". Shipping no schema and
// coercing the optional fields in `apply` keeps the row usable without pulling a
// dependency into a plugin that is installed by directory link.
const DEFAULTS = { enabled: true, directoryName: '_agents', guardShell: true }

/** Exported for the unit test: the boundary logic is worth testing without a session. */
export { contains, makeGuard }

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(typeof config === 'object' && config !== null ? config : {}) }
  if (settings.enabled === false) return
  const directoryName =
    typeof settings.directoryName === 'string' && settings.directoryName.length > 0
      ? settings.directoryName
      : DEFAULTS.directoryName
  const guardShell = settings.guardShell !== false

  const trace = (line) => {
    if (settings.debug !== true) return
    try {
      appendFileSync(
        settings.debugFile ?? `${process.cwd()}\\guard-debug.log`,
        `${new Date().toISOString()} ${line}\n`,
      )
    } catch {
      /* a probe must never break the plugin */
    }
  }

  trace(`apply: listening on the plugin context (directoryName=${directoryName})`)

  // Registered on the plugin's own context: a plain-context guard applies globally,
  // and the decision is made per call from `exec.agent`, so no per-agent wiring is
  // needed and no registration leaks when an agent is disposed.
  //
  // The service is read with `ctx.get` rather than `ctx.tools` on purpose: a missing
  // service should leave the guard absent and silent, not throw inside the effect where
  // the failure would look like a plugin that simply does nothing.
  ctx.effect(() => {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
    if (tools === undefined) {
      trace('no tools service — guard not registered')
      return () => {}
    }
    const dispose = tools.guard((exec) => {
      const header = exec?.agent?.session?.header
      // Only delegated sessions are fenced: the root owns the workspace and must be
      // able to write anywhere in it, or it could not integrate a child's artifacts.
      if (header?.origin !== 'subagent') return undefined
      const cwd = header.cwd ?? process.cwd()
      if (typeof cwd !== 'string' || cwd.length === 0) return undefined
      const workspace = join(cwd, directoryName)
      const guard = makeGuard(cwd, workspace)
      const verdict = guardShell ? guard(exec) : SHELL_TOOLS.has(exec?.name) ? undefined : guard(exec)
      trace(`call ${exec?.name} from ${String(header.id)} -> ${verdict === undefined ? 'allow' : 'DENY'}`)
      return verdict
    })
    trace('guard registered')
    return dispose
  })
}
