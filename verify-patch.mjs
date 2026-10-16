// Validates the generated root-planner patch before installation:
//  1. every patch file parses as YAML,
//  2. the preset row and its delegation rows exist,
//  3. the parsed persona is byte-identical to persona.txt (no YAML mangling),
//  4. the child tool mask contains only names that exist in this profile.
//
// Usage: node verify-patch.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
check(/read-only/.test(personaRow?.config?.prefix ?? ''), 'persona states the read-only rule for subagents');

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

// The mask must deny every mutation entry point this profile registers.
const mutations = ['write', 'edit', 'ops_replace', 'ops_bash', 'pwsh', 'bash', 'ops_run_background'];
for (const { id, allow } of childTools) {
  check(Array.isArray(allow) && allow.length > 0, `${id} declares a non-empty allow list`);
  for (const denied of mutations) {
    check(!allow?.includes(denied), `${id} mask excludes ${denied}`);
  }
  check(allow?.includes('read'), `${id} mask keeps read`);
  check(allow?.includes('subagent'), `${id} mask keeps subagent (read-only recursion stays possible)`);
}

// Every masked name must be a tool this profile actually registers, because
// tools.restrict() rejects unknown global names when a child is created.
const liveTools = new Set([
  'read',
  'glob',
  'grep',
  'ops_inspect_local_file',
  'ops_glob',
  'ops_grep',
  'ops_replace',
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
  'subagent',
  'subagent_fork',
  'present',
  'write',
  'edit',
  'pwsh',
  'ops_bash',
  'job_output',
  'job_list',
  'job_kill',
  'workflow',
  'exit_plan_mode',
]);
for (const { id, allow } of childTools) {
  const unknown = (allow ?? []).filter((name) => !liveTools.has(name));
  check(unknown.length === 0, `${id} mask names only live tools${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`);
}

process.stdout.write(failures.length === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures.length} CHECK(S) FAILED\n`);
process.exit(failures.length === 0 ? 0 : 1);
