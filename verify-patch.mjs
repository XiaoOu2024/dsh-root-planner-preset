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
check(workerRow?.config?.order === 6, 'the worker preset order is 6');
const workerPlugins = workerRow?.config?.plugins ?? [];
const workerRowIds = new Set(workerPlugins.map((row) => row.id));

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
