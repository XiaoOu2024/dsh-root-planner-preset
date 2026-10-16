/**
 * The child tool mask — the single source of truth shared by the generator and
 * the verifier, so the two cannot disagree about what a subagent may call.
 *
 * These are the only GLOBAL tools a subagent may call. Everything absent is
 * invisible to the child.
 *
 * ## What a subagent MAY do
 *
 * A subagent reads, **changes files, and runs commands**. It has to: a delegate
 * that cannot create anything is not a worker, and a "read-only worker" in a code
 * project cannot run tests, git, or a verification script, so every executable
 * step bounces back to the root and the parallelism the tree exists for buys
 * nothing. `write`, `edit`, `ops_replace`, `ops_bash` and `pwsh` are all in the
 * mask for that reason.
 *
 * ## What is forbidden, and how it is enforced
 *
 * The line is not "may not change anything" — it is **unbounded processes**. A
 * subagent must not leave a service, watcher or daemon running past its task.
 * That is enforced, not merely advised:
 *
 *  1. `enableRunInBackground: false` on the preset's `tool-pwsh` row (set in
 *     `build-patch.mjs`). The tool then refuses a background call *and omits
 *     `run_in_background` from its schema*, so no model at any depth can reach for
 *     a detached process at all. Structural.
 *  2. A persona rule covers what a schema cannot: `ops_bash` is a host tool with
 *     no per-preset config and no job registry, so a command blocking inside it is
 *     bounded only by the call timeout.
 *
 * A subagent that starts a long-running server is therefore self-limiting — the
 * call holds until its timeout and the process dies with it.
 *
 * ## Why `subagent` is absent, and what that does NOT mean
 *
 * With `modelSelectionSettings: true` the spawn tool is mounted inside each composed
 * Agent's own scope (`dsh-tool-subagent` registers it through
 * `installScoped`), and `tools.restrict()` takes a mask of *global* tools
 * only. It throws on a scope-local name exactly as it throws on an unknown
 * one, which is how this bundle broke: every subagent creation failed with
 * `tools.restrict() names unknown global tool "subagent"`.
 *
 * Its absence does **not** make a child a leaf. Restrictions filter globals only —
 * "scoped registrations remain visible" — and a child inherits this preset, so it
 * gets its own scoped `subagent` and delegates onward until the runtime depth cap
 * stops it. Depth is the user's setting; the mask is not a depth limit. Do not add
 * it back; `verify-patch.mjs` asserts its absence on purpose.
 */
export const CHILD_TOOLS = [
  'read',
  'glob',
  'grep',
  'ops_inspect_local_file',
  'ops_glob',
  'ops_grep',
  'web_search',
  'web_fetch',
  'read_image',
  'skill',
  'write',
  'edit',
  'ops_replace',
  // Running commands. `pwsh` is the one shell this profile reports as a global
  // tool, and background jobs are switched off for it in the preset (see above).
  //
  // `ops_bash` is deliberately NOT here, and it is not an oversight — it CANNOT be
  // here, for the same reason `subagent` cannot:
  //
  //   * dsh-ops publishes it per AGENT, not globally. `lib/session-shells.js`
  //     mounts a child plugin on each `agent.ctx` and registers the tool there
  //     (`entry.ctx.tools.register(definition)`), then walks the agents again to
  //     `tools.restrict({ deny: [BASH_TOOL] })` on the ones it may not serve. So it
  //     never appears in the runtime's global inventory, and naming it in a mask
  //     fails child creation the way `subagent` did.
  //   * It cannot be granted because it does not need granting. `allowed(agent)`
  //     tests the agent's OWN session policy — full access, or a confinement
  //     provider available — and a child qualifies on the same terms as the root,
  //     so a child receives `ops_bash` from dsh-ops by itself. That project's own
  //     manual-validation notes say it plainly: a restricted session does not
  //     publish `ops_bash`; it appears only with full access, `publishBashTool`,
  //     a resolvable bash payload and an available subprocess service.
  //
  // The consequence worth knowing: a child's shell can differ from the root's
  // because of its own permission mode, not because of anything this mask says.
  'pwsh',
  'todo_write',
  'ask_user_question',
  'get_goal',
  'create_goal',
  'update_goal',
  'list_agents',
  'send_message',
  'interrupt_agent',
  'subagent_fork',
];

/**
 * Tools that are agent-scoped rather than global, so a mask can never name them.
 * Kept separate so the verifier can assert their absence by intent rather than
 * by accident.
 */
export const SCOPE_LOCAL_TOOLS = ['subagent'];

/**
 * The capabilities a subagent must not reach. It is deliberately no longer a list
 * of "things that write" — a subagent is *expected* to write, so forbidding that
 * would contradict the mask above. What it must not reach is an unbounded process,
 * and because the shell tool is present rather than absent, the property to verify
 * is the tool's configuration, not its absence.
 */
export const FORBIDDEN_CAPABILITIES = {
  /** The preset's `tool-pwsh` row must carry this, or a child could detach a server. */
  pwshConfig: { enableRunInBackground: false },
};
