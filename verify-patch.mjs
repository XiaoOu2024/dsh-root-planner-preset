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

import { readFileSync } from 'node:fs';
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
check(/read-only/.test(personaRow?.config?.prefix ?? '') === false, 'persona no longer claims subagents are read-only (they are workers with write and shell)');
check(
  /Never leave something running/.test(personaRow?.config?.prefix ?? ''),
  'persona forbids long-running processes for subagents',
);

/**
 * Rule count, asserted on purpose.
 *
 * Byte-identity above only proves the patch matches `persona.txt` in the working
 * tree. It says nothing about what was PUBLISHED: 1.1.6 shipped a package.json bump
 * while the two collaboration rules added in the same session stayed in the working
 * tree, so npm carried a 13-rule persona while the repository had 14. The byte check
 * could not see that, because both files agreed with each other.
 *
 * Update this number in the same commit as the rule it counts, so the release is the
 * act that carries it.
 */
const ROOT_RULE_COUNT = 16;
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

const delegation = plugins.find((row) => row.id === 'delegation');
check(delegation?.group === true, 'delegation is a group row');
const delegationRows = delegation?.config ?? [];

// Loader row id -> the model-facing tool name that row publishes.
const childTools = [
  { id: 'tool-subagent', toolName: 'subagent' },
  { id: 'tool-subagent-fork', toolName: 'subagent_fork' },
].map(({ id, toolName }) => {
  const row = delegationRows.find((entry) => entry.id === id);
  check(row !== undefined, `delegation declares ${id}`);
  check(row?.config?.toolName === toolName, `${id} publishes the tool name ${toolName}`);
  return { id, toolName, allow: row?.config?.toolFilter?.allow };
});

// A subagent is a worker: it keeps the write and shell tools, so the mask must
// only exclude what a mask can name and what would unbounded a child's process.
for (const { id, allow } of childTools) {
  check(Array.isArray(allow) && allow.length > 0, `${id} declares a non-empty allow list`);
  check(allow?.includes('read'), `${id} mask keeps read`);
  for (const worker of ['write', 'edit', 'ops_replace', 'pwsh']) {
    check(allow?.includes(worker), `${id} mask keeps ${worker} (a subagent must be able to work)`);
  }
  for (const scoped of SCOPE_LOCAL_TOOLS) {
    check(
      !allow?.includes(scoped),
      `${id} mask excludes the agent-scoped tool "${scoped}" (tools.restrict() would refuse it)`,
    );
  }
}

// "No unbounded process": with the shell tools present, the property lives in the
// preset's own rows rather than in the mask.
const pwshRow = plugins.find((row) => row.id === 'tool-pwsh');
check(pwshRow !== undefined, 'the preset declares tool-pwsh');
check(
  pwshRow?.config?.enableRunInBackground === FORBIDDEN_CAPABILITIES.pwshConfig.enableRunInBackground,
  `tool-pwsh sets enableRunInBackground=${FORBIDDEN_CAPABILITIES.pwshConfig.enableRunInBackground} ` +
    `(found ${JSON.stringify(pwshRow?.config?.enableRunInBackground)}) — without it a subagent could detach a server`,
);

/**
 * The global tool inventory of the author's profile, captured from a runtime
 * error rather than hand-kept: `tools.restrict()` prints every known global tool
 * when it refuses a name. Replace this list with the equivalent line from your
 * own environment — it is what makes the check below meaningful.
 */
const OBSERVED_GLOBAL_TOOLS = new Set([
  'ask_user_question',
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
  'present',
  'pwsh',
  'read',
  'read_image',
  'send_message',
  'skill',
  'subagent_fork',
  'todo_write',
  'update_goal',
  'web_fetch',
  'web_search',
  'workflow',
  'write',
]);

/**
 * Tools that are agent-scoped rather than global, so the mask can never name
 * them. `subagent` is the one this bundle ran into: with
 * `modelSelectionSettings: true` it is mounted inside each composed Agent's own
 * scope, and `tools.restrict()` accepts global names only.
 */
for (const { id, allow } of childTools) {
  const unknown = (allow ?? []).filter((name) => !OBSERVED_GLOBAL_TOOLS.has(name));
  check(
    unknown.length === 0,
    `${id} mask names only tools the runtime reports as global` +
      (unknown.length ? ` (not global: ${unknown.join(', ')})` : ''),
  );
  const missing = CHILD_TOOLS.filter((name) => !(allow ?? []).includes(name));
  const extra = (allow ?? []).filter((name) => !CHILD_TOOLS.includes(name));
  check(
    missing.length === 0 && extra.length === 0,
    `${id} mask matches child-tools.mjs (${CHILD_TOOLS.length} entries)` +
      (missing.length ? ` — missing: ${missing.join(', ')}` : '') +
      (extra.length ? ` — unexpected: ${extra.join(', ')}` : ''),
  );
}

process.stdout.write(failures.length === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures.length} CHECK(S) FAILED\n`);
process.exit(failures.length === 0 ? 0 : 1);
