/**
 * The child tool mask — the single source of truth shared by the generator and
 * the verifier, so the two cannot disagree about what a subagent may call.
 *
 * These are the only GLOBAL tools a subagent may call. Everything absent is
 * invisible to the child, including every mutation entry point.
 *
 * `subagent` is deliberately NOT here, and cannot be — but that does NOT mean a
 * subagent lacks it. Two separate facts:
 *
 *  1. With `modelSelectionSettings: true` the tool is mounted inside each composed
 *     Agent's own scope (`dsh-tool-subagent` registers it through
 *     `installScoped`), and `tools.restrict()` takes a mask of *global* tools
 *     only. It throws on a scope-local name exactly as it throws on an unknown
 *     one, which is how this bundle broke: every subagent creation failed with
 *     `tools.restrict() names unknown global tool "subagent"`.
 *  2. Restrictions only filter globals — "scoped registrations remain visible".
 *     A child inherits this preset, so it gets its own scoped `subagent` and can
 *     delegate onward until the runtime depth cap stops it.
 *
 * So the mask is not what makes a child a leaf; `subagent.maxDepth` is. Listing
 * `subagent` here rejected a name the mask can never legally contain. Do not add
 * it back; `verify-patch.mjs` asserts its absence on purpose.
 *
 * `subagent_fork` IS registered in the preset's own scope and is observable as a
 * global, so it stays in the list.
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
 * The mutation entry points this bundle promises a subagent cannot reach. The
 * verifier asserts each one is absent; `ops_bash` and `bash` are included even
 * when a profile registers neither, because their absence is the property.
 */
export const MUTATION_TOOLS = ['write', 'edit', 'ops_replace', 'ops_bash', 'pwsh', 'bash'];
