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

/**
 * The oldest DSH this preset actually works on. 0.2.1 introduced `agentPreset` on the
 * delegation tool and removed `toolFilter`; on 0.2.0 the preset still composes and then
 * silently runs every child on the platform's default preset. Kept as one constant so the
 * manifest, this check and any future packaging step cannot drift apart.
 */
const MINIMUM_DSH = '>=0.2.1-rc.2';

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
// The suffix is intentionally not the deployment's text any more: that one interpolates
// {{cwd}}, which DSH 0.2.1 rejects (only provider and model are registered variables). The
// variable-free replacement is asserted below for both presets.
check(
  typeof personaRow?.config?.suffix === 'string' && personaRow.config.suffix.length > 0,
  'persona suffix is set',
);

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
const EVERY_AGENT_RULES = 3;
const DELEGATOR_RULES = 15;
const DELEGATED_RULES = 15;

/** Read one section of the persona by its heading, up to the next level-2 heading. */
function section(heading) {
  const persona = personaRow?.config?.prefix ?? '';
  const start = persona.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const rest = persona.slice(start + heading.length + 3);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Rule numbers in one section, in document order. */
function ruleNumbers(text) {
  return [...text.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
}

for (const [heading, expected] of [
  ['Rules for every agent', EVERY_AGENT_RULES],
  ['When you delegate', DELEGATOR_RULES],
  ['When you are delegated to', DELEGATED_RULES],
]) {
  const text = section(heading);
  const numbers = ruleNumbers(text);
  check(numbers.length === expected, `section "${heading}" carries ${expected} rules (found ${numbers.length})`);
  check(
    numbers.every((value, index) => value === index + 1),
    `section "${heading}" numbering is 1..${numbers.length} with no gaps or repeats (found ${numbers.join(',')})`,
  );
}

// The role model is two-sided on purpose: every agent is the delegated side of the edge
// above it and the delegating side of the edges below it. If a future edit drops the
// sentence that ties the two blocks together, a mid-level agent goes back to reading only
// the subagent half — the gap this restructure exists to close.
check(
  /You hold two sides at once/.test(personaRow?.config?.prefix ?? ''),
  'the role section states that one agent holds both sides along different edges',
);
check(
  !/A delegated task is not delegated again/.test(personaRow?.config?.prefix ?? ''),
  'the old single-hop sentence is gone (it contradicted the depth cap and told workers not to delegate)',
);
check(
  /If `_agents\/` is missing from your parent's workspace, that is a defect/.test(personaRow?.config?.prefix ?? ''),
  'a missing parent _agents directory is reported as a defect instead of silently created',
);
check(
  /and the child creates it/.test(personaRow?.config?.prefix ?? ''),
  'the delegating side names the workspace but does not create it for the child',
);
check(
  /Use absolute paths for everything you write/.test(personaRow?.config?.prefix ?? ''),
  'the delegated side is told to use absolute paths (a relative path resolves to the session cwd, not its workspace)',
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
  // The preset depends on 0.2.1 *behaviour*, not merely on 0.2.1 packaging: `agentPreset`
  // on the delegation tool is what the worker split relies on, and on 0.2.0 the removed
  // `toolFilter` is stripped silently so children fall back to the platform's default
  // preset. Without this floor the package installs on a runtime where it looks fine and
  // quietly does the wrong thing — the failure mode this repo has spent the most effort
  // removing. Verify the range admits the floor itself too, so a typo cannot turn the
  // guard into a lockout of the very version it is written for.
  check(
    manifest.engines?.dsh === MINIMUM_DSH,
    `package.json declares engines.dsh ${MINIMUM_DSH} (found ${JSON.stringify(manifest.engines?.dsh)})`,
  );
  // A shape check that always runs, rather than an optional semver import that silently
  // becomes a no-op on a machine without the module. `^>=` also rules out a strict `>`,
  // which would lock out the very runtime the range names.
  check(
    /^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.engines.dsh ?? ''),
    `engines.dsh is an inclusive >= lower bound on a concrete version (found ${JSON.stringify(manifest.engines?.dsh)})`,
  );
}
const delegationRows = delegation?.config ?? [];

// DSH 0.2.1 removed `toolFilter` from the delegation tool, and it does not warn: zod
// strips the key and the child then runs the platform's DEFAULT preset. The worker's tool
// set is now decided by which rows the worker preset mounts, because a preset's rows
// register their tools in the agent scope while `tools.restrict()` filters GLOBAL tools
// only ("restrictions intersect; scoped registrations remain visible"). A mask row was
// tried first and failed at activation with:
//   tools.restrict() names unknown global tools "read", "glob", "write", ...
//   known global tools: ops_glob, ops_grep, ops_inspect_local_file, ops_replace,
//                       working_directory
// Those five are the entire global set on this machine; everything else a worker sees
// comes from a row. So the assertions below are about rows, and they are two-sided:
// required rows must exist, forbidden rows must not.
const workerRow = inserted.find((row) => row.id === 'preset-root-planner-worker');
check(workerRow !== undefined, 'the patch declares a worker preset');
check(workerRow?.config?.id === 'root-planner-worker', 'the worker preset id is root-planner-worker');
check(workerRow?.config?.order === 6, 'the worker preset order is 6');const workerPlugins = workerRow?.config?.plugins ?? [];
const workerRowIds = new Set(workerPlugins.map((row) => row.id));

// The third preset: 深度创造 (deep creation). It reuses the planner's rows through the
// generator's `rootRows(true)`, so the assertions are about the two things that make it
// different, plus the guarantee that it did not drift from the planner everywhere else.
const deepRow = inserted.find((row) => row.id === 'preset-root-planner-cordis');
check(deepRow !== undefined, 'the patch declares the deep-creation preset');
check(deepRow?.config?.id === 'root-planner-cordis', 'the deep-creation preset id is root-planner-cordis');
check(deepRow?.config?.order === 7, 'the deep-creation preset order is 7 (last, so it sorts after the other two)');
check(deepRow?.config?.name === '深度创造', 'the deep-creation preset is labelled 深度创造');
const deepPlugins = deepRow?.config?.plugins ?? [];
const deepRowIds = new Set(deepPlugins.map((row) => row.id));
check(
  deepRowIds.has('tool-cordis'),
  'the deep-creation preset mounts tool-cordis (runtime inspection is the point of the preset)',
);
check(
  deepRowIds.has('time-context'),
  'the deep-creation preset mounts time-context, like the platform creation preset',
);
const deepSkills = deepPlugins.find((row) => row.id === 'skill-filesystem');
check(
  Array.isArray(deepSkills?.config?.customSkillDirs) && deepSkills.config.customSkillDirs.length > 0,
  'the deep-creation preset points skill-filesystem at the Cordis development skills',
);
// The subagent rows live inside the `delegation` group, whose `config` IS the child list
// (not `config.plugins`), so they never appear as top-level ids in the parsed row list.
const deepDelegation = deepPlugins.find((row) => row.id === 'delegation');
const deepDelegationChildren = (Array.isArray(deepDelegation?.config) ? deepDelegation.config : []).map(
  (row) => row?.id,
);
const deepDelegationMissing = ['tool-subagent', 'tool-subagent-fork'].filter(
  (id) => !deepDelegationChildren.includes(id),
);
check(
  deepDelegation !== undefined && deepDelegationMissing.length === 0,
  `the deep-creation preset keeps the delegation group with its subagent rows (missing: ${deepDelegationMissing.join(',') || 'none'})`,
);
check(
  !deepRowIds.has('tool-jobs'),
  'the deep-creation preset does not mount the dead tool-jobs row',
);
// Everything the planner mounts, the creation preset mounts too — one row list, not two.
const plannerIds = new Set((presetRow?.config?.plugins ?? []).map((row) => row.id));
const missingFromDeep = [...plannerIds].filter((id) => !deepRowIds.has(id));
check(
  missingFromDeep.length === 0,
  `the deep-creation preset mounts every row the planner does (missing: ${missingFromDeep.join(',') || 'none'})`,
);
// And the extra surface stays confined to it: the planner must not gain inspection.
check(
  !plannerIds.has('tool-cordis'),
  'the planner preset does not mount tool-cordis (inspection belongs to the creation preset)',
);


/** Rows a worker needs: persona, the working tools, and delegation so the tree recurses. */
const WORKER_REQUIRED_ROWS = [
  'persona',
  'agent-instructions',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-skill',
  'tool-web',
  'tool-todo',
  'tool-ask-user',
  'delegation',
];
for (const id of WORKER_REQUIRED_ROWS) {
  check(workerRowIds.has(id), `the worker preset mounts ${id}`);
}

/**
 * Rows a worker must not have. Each one was in the root preset and not here: workflow
 * orchestration, deliverables, job control, plan mode, plugin management. Anything that
 * lets a worker outlive its task or re-plan the tree belongs to the root.
 */
const WORKER_FORBIDDEN_ROWS = ['tool-workflow', 'workflow-ptc', 'present', 'tool-jobs', 'tool-plugin-manager', 'planning'];
for (const id of WORKER_FORBIDDEN_ROWS) {
  check(!workerRowIds.has(id), `the worker preset does not mount ${id}`);
}
check(
  !workerPlugins.some((row) => /worker-mask/.test(String(row?.id)) || /worker-mask/.test(String(row?.name))),
  'no mask row is mounted (a restriction cannot narrow a preset\'s own tools)',
);

const workerDelegation = workerPlugins.find((row) => row.id === 'delegation');
const workerDelegationRows = workerDelegation?.config ?? [];

// Loader row id -> the model-facing tool name that row publishes, plus the provider whose
// capability decides whether a preset may be selected for it.
const childTools = [
  { id: 'tool-subagent', toolName: 'subagent', provider: 'spawn' },
  { id: 'tool-subagent-fork', toolName: 'subagent_fork', provider: 'fork' },
].map(({ id, toolName, provider }) => {
  const row = delegationRows.find((entry) => entry.id === id);
  check(row !== undefined, `delegation declares ${id}`);
  check(row?.config?.toolName === toolName, `${id} publishes the tool name ${toolName}`);
  check(row?.config?.provider === provider, `${id} uses the ${provider} provider`);
  check(
    row?.config?.toolFilter === undefined,
    `${id} carries no toolFilter (DSH 0.2.1 removed it and strips it silently)`,
  );
  // Only the spawn provider supports independent preset selection. A grandchild spawned
  // through it must land in the worker preset too, or the tree degrades at depth 2: the
  // platform default persona and the full tool list come back one level down.
  if (provider === 'spawn') {
    check(row?.config?.agentPreset === 'root-planner-worker', `${id} spawns into the worker preset`);
    const nested = workerDelegationRows.find((entry) => entry.id === id);
    check(nested?.config?.agentPreset === 'root-planner-worker', `worker ${id} spawns into the worker preset too`);
  }
  return { id, toolName, provider };
});

// The fork provider declares `agentPreset: false` together with
// `inheritsParentContext: true`, and its row throws at activation when a preset is
// configured for it — which is what made the whole preset fail to load on DSH 0.2.1.
// Assert the absence in both presets so a later edit cannot reintroduce it.
for (const [label, rows] of [
  ['the root preset', delegationRows],
  ['the worker preset', workerDelegationRows],
]) {
  const fork = rows.find((entry) => entry.id === 'tool-subagent-fork');
  check(
    fork?.config?.agentPreset === undefined,
    `${label} sets no agentPreset on the fork row (the fork provider rejects one)`,
  );
}

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

// DSH 0.2.1 validates every `{{name}}` in a prompt section against the registered prompt
// variables, which on this machine are `provider` and `model` only. The persona suffix used
// to say "Your working directory is {{cwd}}." and that now fails the whole run with
//   unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"
// so the suffix is variable-free and points at the tool that reports the path.
for (const [label, rows] of [
  ['the root preset', plugins],
  ['the worker preset', workerPlugins],
]) {
  const suffix = rows.find((entry) => entry.id === 'persona')?.config?.suffix ?? '';
  check(typeof suffix === 'string' && suffix.length > 0, `${label} declares a persona suffix`);
  check(
    !/\{\{/.test(suffix),
    `${label} persona suffix declares no prompt variables (only provider and model are registered)`,
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

// The curated child toolset is not checkable against a static global inventory, and this
// file must not pretend otherwise. In DSH 0.2.1 a preset row registers its tool in the
// agent scope, and `tools.restrict()` filters GLOBAL tools only, so the names in
// `child-tools.mjs` are not global names. What proves the toolset is the row list —
// asserted above — plus one live run: spawn from a Root Planner session and read the
// child's `request/header` with `node tools/extract-offered-tools.mjs <session-dir>`.

process.stdout.write(failures.length === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures.length} CHECK(S) FAILED\n`);
process.exit(failures.length === 0 ? 0 : 1);
