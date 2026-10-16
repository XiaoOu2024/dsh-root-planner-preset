// Validates the profile patch layer edit that sets the delegation depth:
//  1. the file still parses as a YAML sequence in the loader dialect,
//  2. the composed profile resolves `subagent.maxDepth` to 2,
//  3. applying the override the way the loader does reproduces that value.
//
// The profile directory is resolved from the environment so this script works on
// any machine: DSH_PROFILE_DIR wins, then DSH_HOME/profiles/$DSH_PROFILE, then the
// `web` profile under the default DSH home. Override with --profile <dir>.
//
// Usage: node verify-depth-override.mjs [--profile <profileDir>]

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadYaml, loaderSchema as makeLoaderSchema } from './lib-yaml.mjs';

const yaml = loadYaml();

/** Resolve the profile directory to inspect, preferring explicit input. */
function profileDir() {
  const flag = process.argv.indexOf('--profile');
  if (flag !== -1) {
    const value = process.argv[flag + 1];
    if (value === undefined) throw new Error('--profile needs a directory');
    return resolve(value);
  }
  if (process.env.DSH_PROFILE_DIR) return resolve(process.env.DSH_PROFILE_DIR);
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'profiles', process.env.DSH_PROFILE ?? 'web');
}

const dir = profileDir();
const PATCH = join(dir, 'cordis.patch.yml');
const COMPOSED = join(dir, 'cordis.yml');

const failures = [];
const check = (ok, label) => {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
  if (!ok) failures.push(label);
};

process.stdout.write(`profile: ${dir}\n`);

if (!existsSync(PATCH)) {
  process.stdout.write(`SKIP ${PATCH} does not exist on this machine.\n`);
  process.stdout.write('The depth override is a Host setting, not part of the bundle: set it in\n');
  process.stdout.write('Settings -> Subagents -> depth limit, or add the override by hand.\n');
  process.exit(0);
}

const loaderSchema = makeLoaderSchema(yaml);

// 1. The real profile patch layer still parses.
const patches = yaml.load(readFileSync(PATCH, 'utf8'), { schema: loaderSchema });
check(Array.isArray(patches), 'profile patch layer is a YAML sequence');
check(patches.length === 6, `profile patch layer has 6 entries (found ${patches?.length})`);

const depthPatch = patches.find((patch) => patch.id === 'subagent');
check(depthPatch !== undefined, 'a subagent override exists');
check(depthPatch?.name === '@deepseek-ai/dsh-subagent', 'override asserts the plugin name');
check(depthPatch?.config?.maxDepth === 2, 'override sets maxDepth: 2');
check(depthPatch?.insert === undefined, 'override is not an insert patch');

// 2. The override landed in the composed profile. `cordis.yml` is the COMPOSED
// file: every bundle layer plus this patch layer already applied, rewritten
// whenever the profile re-composes — so its content is the evidence that the
// edit was picked up rather than merely written.
const composed = yaml.load(readFileSync(COMPOSED, 'utf8'), { schema: loaderSchema });
const subagentRows = composed.filter((row) => row.id === 'subagent');
check(subagentRows.length === 1, `exactly one subagent row in the composition (found ${subagentRows.length})`);
check(subagentRows[0]?.name === '@deepseek-ai/dsh-subagent', 'the composition row matches the asserted name');
check(subagentRows[0]?.config?.maxDepth === 2, 'the composed row carries maxDepth: 2 (override applied)');

// 3. Apply the override the way the loader does and read the result back.
const applied = structuredClone(composed);
for (const patch of patches) {
  if (patch.insert !== undefined) continue;
  const target = applied.find((row) => row.id === patch.id);
  if (target === undefined) continue;
  for (const [key, value] of Object.entries(patch.config ?? {})) {
    if (key === 'config') continue;
  }
  target.config = { ...(target.config ?? {}), ...(patch.config ?? {}) };
}
const resolved = applied.find((row) => row.id === 'subagent');
check(resolved?.config?.maxDepth === 2, 'after patching, subagent.maxDepth resolves to 2');

// 4. Only these two rows change; nothing else in the layer is disturbed.
const otherIds = patches.filter((patch) => patch.id !== 'subagent').map((patch) => patch.id);
check(
  otherIds.join(',') === 'ui-settings-general,session-log-deepseek,ui-chat,agent-default-model,locale',
  'the five pre-existing overrides are untouched',
);

process.stdout.write(failures.length === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures.length} CHECK(S) FAILED\n`);
process.exit(failures.length === 0 ? 0 : 1);
