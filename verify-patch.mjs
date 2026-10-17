// Validates the generated root-planner patch before installation:
//  1. every patch file parses as YAML,
//  2. the preset row and its delegation rows exist,
//  3. the parsed persona is byte-identical to persona.txt (no YAML mangling),
//  4. the child tool mask names only global tools, keeps the write and shell tools
//     a worker needs, and excludes agent-scoped names tools.restrict() would reject,
//  5. the "no unbounded process" property holds: the preset's pwsh row has
//     background jobs switched off.
//
// Usage: node verify-patch.mjs

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHILD_TOOLS, FORBIDDEN_CAPABILITIES, SCOPE_LOCAL_TOOLS } from './child-tools.mjs';
import { loadYaml, loaderSchema as makeLoaderSchema } from './lib-yaml.mjs';

const yaml = loadYaml();

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
const check = (ok, label) => {
  if (ok) process.stdout.write(`ok   ${label}\n`);
  else {
    process.stdout.write(`FAIL ${label}\n`);
    failures.push(label);
  }
};

/**
 * The loader's own YAML dialect includes `!!js` scalars, which the default
 * schema rejects. They are marker expressions the Loader evaluates later, so
 * this validator reads them as opaque strings.
 */
const loaderSchema = makeLoaderSchema(yaml);

/** Parse one loader patch file, returning its list of patch entries. */
function loadPatches(name) {
  const text = readFileSync(join(here, name), 'utf8');
  const parsed = yaml.load(text, { schema: loaderSchema });
  if (!Array.isArray(parsed)) throw new Error(`${name} is not a YAML sequence`);
  return parsed;
}

const patches = loadPatches('cordis.patch.yml');
const inserted = patches.flatMap((patch) => patch.insert ?? []);
const presetRow = inserted.find((row) => row.id === 'preset-root-planner');
check(presetRow !== undefined, 'patch inserts the preset-root-planner row');
check(presetRow?.config?.id === 'root-planner', 'preset id is root-planner');
check(presetRow?.config?.order === 5, 'preset order is 5 (after the shipped presets)');

const plugins = presetRow?.config?.plugins ?? [];
const personaRow = plugins.find((row) => row.id === 'persona');
check(personaRow?.config?.suffix === 'Your working directory is {{cwd}}.', 'persona suffix matches the deployment text');

const expected = readFileSync(join(here, 'persona.txt'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
check(personaRow?.config?.prefix === expected, 'parsed persona is byte-identical to persona.txt');
check(!personaRow?.config?.prefix?.includes('\t'), 'persona contains no tab characters');
check(
  /You can read, change files, and run commands/.test(personaRow?.config?.prefix ?? ''),
  'persona states that a subagent is a worker with write and shell',
);
// The exact wrong sentence this bundle once shipped. A loose /read-only/ test is no
// good now that the persona legitimately calls the PARENT's files read-only.
check(
  !/You are read-only, and this is structural/.test(personaRow?.config?.prefix ?? ''),
  'persona does not claim subagents themselves are read-only',
);
check(
  /Write only inside your own workspace/.test(personaRow?.config?.prefix ?? ''),
  'persona confines a subagent to its own workspace',
);
check(
  /Never leave something running/.test(personaRow?.config?.prefix ?? ''),
  'persona forbids long-running processes for subagents',
);


/**
 * Rule counts, asserted on purpose.
 *
 * Byte-identity above only proves the patch matches `persona.txt` in the working
 * tree. It says nothing about what was PUBLISHED: 1.1.6 shipped a package.json bump
 * while the two collaboration rules added in the same session stayed in the working
 * tree, so npm carried a 13-rule persona while the repository had 14. The byte check
 * could not see that, because both files agreed with each other.
 *
 * Update these numbers in the same commit as the rule they count, so the release is
 * the act that carries it.
 */
const ROOT_RULE_COUNT = 18;
const SUBAGENT_RULE_COUNT = 13;
const rootSection = (personaRow?.config?.prefix ?? '').split('## Root agent rules')[1]?.split('## Subagent rules')[0] ?? '';
const rootRules = [...rootSection.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
check(
  rootRules.length === ROOT_RULE_COUNT,
  `persona carries ${ROOT_RULE_COUNT} root rules (found ${rootRules.length})`,
);
check(
  rootRules.every((value, index) => value === index + 1),
  `root rule numbering is 1..${rootRules.length} with no gaps or repeats (found ${rootRules.join(',')})`,
);

const subagentSection = (personaRow?.config?.prefix ?? '').split('## Subagent rules')[1]?.split('## When to pass work down')[0] ?? '';
const subagentRules = [...subagentSection.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
check(
  subagentRules.length === SUBAGENT_RULE_COUNT,
  `persona carries ${SUBAGENT_RULE_COUNT} subagent rules (found ${subagentRules.length})`,
);
check(
  subagentRules.every((value, index) => value === index + 1),
  `subagent rule numbering is 1..${subagentRules.length} with no gaps or repeats (found ${subagentRules.join(',')})`,
);

const delegation = plugins.find((row) => row.id === 'delegation');
check(delegation?.group === true, 'delegation is a group row');

// The workspace fence travels with the preset, so one install carries the protocol and
// its enforcement. It must be a TOP-LEVEL insert, not a row inside `config.plugins`.
//
// That distinction is measured, not stylistic: while this guard was declared as a preset
// row, a live six-step probe came back all-allowed — the row exists in the composed
// config yet registers nothing that sees a tool call. As a sibling entry (the shape the
// standalone guard bundle was proved in) one instance sees every call. The last check
// here keeps a future refactor from quietly moving it back.
const guardRow = inserted.find((row) => row.id === 'root-planner-guard');
check(guardRow !== undefined, 'the patch inserts the workspace guard as a top-level entry');
check(
  guardRow?.name === 'dsh-root-planner-preset/guard',
  `the guard row resolves to this package's subpath (found ${JSON.stringify(guardRow?.name)})`,
);
check(guardRow?.disabled !== true, 'the guard row is enabled');
check(guardRow?.config?.directoryName === '_agents', 'the guard fences the _agents/ directory');
check(guardRow?.config?.guardShell === true, 'the guard also applies the shell rules');
check(
  plugins.every((row) => row.id !== 'root-planner-guard'),
  'the guard is NOT declared as a preset plugin row (that mount registers nothing)',
);
check(existsSync(join(here, 'guard.js')), 'guard.js ships inside the package');
{
  const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
  check(manifest.exports?.['./guard'] === './guard.js', 'package.json exports ./guard');
  check((manifest.files ?? []).includes('guard.js'), 'guard.js is in the published files list');
}
const delegationRows = delegation?.config ?? [];

// DSH 0.2.1 removed `toolFilter` from the delegation tool. It does not warn: zod strips
// the key and the child then runs the platform's DEFAULT preset, which is how a live child
// ended up with all 39 tools and the wrong persona. The curated child toolset therefore
// moved to two places at once — a worker preset (which decides the mounted tool plugins)
// and `worker-mask` (which subtracts the app-level tools a preset cannot omit).
const workerRow = inserted.find((row) => row.id === 'preset-root-planner-worker');
check(workerRow !== undefined, 'the patch declares a worker preset');
check(workerRow?.config?.id === 'root-planner-worker', 'the worker preset id is root-planner-worker');
check(workerRow?.config?.order === 6, 'the worker preset order is 6');
const workerPlugins = workerRow?.config?.plugins ?? [];
check(
  workerPlugins.some((row) => row.id === 'worker-mask' && row.name === 'dsh-root-planner-preset/worker-mask'),
  'the worker preset mounts worker-mask (the tool restriction)',
);
const workerDelegation = workerPlugins.find((row) => row.id === 'delegation');
const workerDelegationRows = workerDelegation?.config ?? [];

// Loader row id -> the model-facing tool name that row publishes.
const childTools = [
  { id: 'tool-subagent', toolName: 'subagent' },
  { id: 'tool-subagent-fork', toolName: 'subagent_fork' },
].map(({ id, toolName }) => {
  const row = delegationRows.find((entry) => entry.id === id);
  check(row !== undefined, `delegation declares ${id}`);
  check(row?.config?.toolName === toolName, `${id} publishes the tool name ${toolName}`);
  check(row?.config?.agentPreset === 'root-planner-worker', `${id} spawns into the worker preset`);
  check(
    row?.config?.toolFilter === undefined,
    `${id} carries no toolFilter (DSH 0.2.1 removed it and strips it silently)`,
  );
  // A grandchild must land in the worker preset too, or the tree degrades at depth 2:
  // the platform default persona and the full tool list come back one level down.
  const nested = workerDelegationRows.find((entry) => entry.id === id);
  check(nested?.config?.agentPreset === 'root-planner-worker', `worker ${id} spawns into the worker preset too`);
  return { id, toolName };
});

// A subagent is a worker: the curated set keeps the write and shell tools.
for (const worker of ['read', 'write', 'edit', 'ops_replace', 'pwsh']) {
  check(CHILD_TOOLS.includes(worker), `the curated set keeps ${worker} (a subagent must be able to work)`);
}
for (const scoped of SCOPE_LOCAL_TOOLS) {
  check(
    !CHILD_TOOLS.includes(scoped),
    `the curated set excludes the agent-scoped tool "${scoped}" (tools.restrict() would refuse it)`,
  );
}

// "No unbounded process": with the shell tools present, the property lives in each
// preset's own rows rather than in a mask — the worker needs it as much as the root.
for (const [label, rows] of [
  ['the root preset', plugins],
  ['the worker preset', workerPlugins],
]) {
  const row = rows.find((entry) => entry.id === 'tool-pwsh');
  check(row !== undefined, `${label} declares tool-pwsh`);
  check(
    row?.config?.enableRunInBackground === FORBIDDEN_CAPABILITIES.pwshConfig.enableRunInBackground,
    `${label} sets enableRunInBackground=${FORBIDDEN_CAPABILITIES.pwshConfig.enableRunInBackground} ` +
      `(found ${JSON.stringify(row?.config?.enableRunInBackground)}) — without it a subagent could detach a server`,
  );
}

/**
 * The global tool inventory of the author's profile, captured from a runtime
 * error rather than hand-kept: `tools.restrict()` prints every known global tool
 * when it refuses a name. Replace this list with the equivalent line from your
 * own environment — it is what makes the check below meaningful.
 *
 * Provenance: transcribed on DSH 0.2.1-rc.2. The upgrade from 0.2.0-rc.2 added
 * `working_directory`, the four `schedule_*` tools, `cordis_inspect_list`,
 * `cordis_inspect_query` and `plugin_manager`; all are registered by profile-level tool
 * packages, so they are global. None of them is in the child mask, which is the intended
 * behaviour of an allow list — a new tool is invisible to children until it is named.
 *
 * Regenerate after a DSH upgrade: break the mask on purpose (add a bogus name), let the
 * agent-creation error print the list, and transcribe it — `tools/extract-tool-inventory.mjs`
 * reads exactly that line out of a session log.
 */
const OBSERVED_GLOBAL_TOOLS = new Set([
  'ask_user_question',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'get_goal',
  'glob',
  'grep',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'ops_glob',
  'ops_grep',
  'ops_inspect_local_file',
  'ops_replace',
  'plugin_manager',
  'present',
  'pwsh',
  'read',
  'read_image',
  'schedule_create',
  'schedule_delete',
  'schedule_list',
  'schedule_update',
  'send_message',
  'skill',
  'subagent_fork',
  'todo_write',
  'update_goal',
  'web_fetch',
  'web_search',
  'workflow',
  'working_directory',
  'write',
]);

/**
 * Tools that are agent-scoped rather than global, so `tools.restrict()` can never name
 * them. `subagent` is the one this bundle ran into: with `modelSelectionSettings: true`
 * it is mounted inside each composed Agent's own scope, and a restriction accepts global
 * names only. The curated set is the source of truth now — the old per-call mask is gone.
 */
{
  const unknown = CHILD_TOOLS.filter((name) => !OBSERVED_GLOBAL_TOOLS.has(name));
  const scoped = new Set(SCOPE_LOCAL_TOOLS);
  const unexpected = unknown.filter((name) => !scoped.has(name));
  check(
    unexpected.length === 0,
    `the curated set names only tools the runtime reports as global` +
      (unexpected.length ? ` (not global: ${unexpected.join(', ')})` : ''),
  );
  // `subagent` reaches a worker through the preset's own delegation row rather than the
  // restriction, so it may legitimately sit in the curated set while being scope-local.
  for (const name of unknown) {
    check(scoped.has(name), `the only scope-local name in the curated set is declared as such (${name})`);
  }
}

process.stdout.write(failures.length === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures.length} CHECK(S) FAILED\n`);
process.exit(failures.length === 0 ? 0 : 1);
