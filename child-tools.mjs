/**
 * The child tool mask — the single source of truth shared by the generator and
 * the verifier, so the two cannot disagree about what a subagent may call.
 *
 * These are the only GLOBAL tools a subagent may call. Everything absent is
 * invisible to the child, including every mutation entry point.
 *
 * `subagent` is deliberately NOT here, and cannot be. With
 * `modelSelectionSettings: true` that tool is registered per agent inside the
 * composed Agent's own scope (`dsh-tool-subagent` mounts it through
 * `installScoped`), and `tools.restrict()` takes a mask of *global* tools only —
 * it throws on a scope-local name exactly as it throws on an unknown one:
 *
 *   Error: tools.restrict() names unknown global tool "subagent"; known global
 *   tools: ask_user_question, create_goal, edit, … subagent_fork, …
 *
 * `subagent_fork` is registered in the preset's own scope instead, so it IS
 * visible to the mask and stays. Both names were in this list until a real
 * subagent spawn failed, which is exactly the class of mistake no amount of
 * reading the source had caught.
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
