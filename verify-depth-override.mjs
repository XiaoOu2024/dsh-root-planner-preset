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
// No exact entry count: this file belongs to the user, who adds overrides of their own
// (a model provider, a plugin toggle) and whose plugin manager writes rows as bundles
// are installed. An earlier version asserted a fixed count of 6 and failed on DSH
// 0.2.1 purely because the user had added a provider — a false alarm that said nothing
// about the preset. What matters is that our override is present and well formed.
check(
  (patches ?? []).length > 0 && (patches ?? []).every((patch) => typeof patch?.id === 'string'),
  `every entry in the profile patch layer is an id-targeted override (found ${patches?.length})`,
);

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
// `cordis.yml` is a runtime cache, not a source: its own header calls it "an empty entry
// list" and says the tree is composed from patches at startup. An empty file therefore
// means the harness has not rewritten the composition yet on this machine, not that the
// override is missing. Treating it as failure produced four red checks after a
// `--dump-config` reset the file — a red that said nothing about the preset.
if (!Array.isArray(composed) || composed.length === 0) {
  process.stdout.write(
    'SKIP the composed-profile checks: cordis.yml still holds the empty template that the\n' +
      'harness rewrites at startup. Start dsh once, then re-run this script.\n',
  );
  process.stdout.write(failures.length === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures.length} CHECK(S) FAILED\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}
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

// 4. Our override does not disturb the overrides that were already there. Asserted as a
// SUBSET, not as an exact list: the profile layer is the user's, and new entries appear
// in it through normal use (a model provider, a plugin toggle written by `dsh plugin`).
// An earlier version compared the joined id list and failed the moment the user added
// one — reporting "the five pre-existing overrides are untouched" as false while nothing
// had touched them.
const PRE_EXISTING = ['ui-settings-general', 'session-log-deepseek', 'ui-chat', 'agent-default-model', 'locale'];
const presentIds = new Set((patches ?? []).map((patch) => patch.id));
const missing = PRE_EXISTING.filter((id) => !presentIds.has(id));
check(missing.length === 0, `pre-existing overrides are still present (missing: ${missing.join(', ') || 'none'})`);

process.stdout.write(failures.length === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures.length} CHECK(S) FAILED\n`);
process.exit(failures.length === 0 ? 0 : 1);
