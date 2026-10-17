// Restricts a Root Planner worker to the curated child toolset.
//
// DSH 0.2.1 removed `toolFilter` from `dsh-tool-subagent` — its error says to "configure
// persona and tool plugins in an Agent Preset and select it with agentPreset (spawn
// only)". A preset decides which tool plugins are mounted for that agent, but not which
// globally mounted tools it may call: several newer tools (tool-cordis, plugin-manager,
// working-directory, schedule) are registered at the app level and would reach every
// agent regardless of the preset's rows. `tools.restrict()` is the mechanism that still
// subtracts them, and this module is that call, mounted as a row inside the worker
// preset so it applies to the worker's own agent scope.
//
// The allow list lives in `child-tools.mjs` — the same file the previous mask used, so
// the curated set is still declared once.

import { CHILD_TOOLS } from './child-tools.mjs'

export const name = 'root-planner-worker-mask'

export const inject = ['tools']

export function apply(ctx) {
  // `tools.restrict()` requires a scoped context: it refuses to run from a global one
  // because that would mask every agent in the process. A preset row is mounted into the
  // agent's own scope, which is exactly the scope this needs.
  ctx.effect(() => {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
    if (tools === undefined) return () => {}
    return tools.restrict({ allow: CHILD_TOOLS })
  })
}
