// Portable YAML loader for the root-planner bundle scripts.
//
// The bundle declares no dependencies on purpose: it is a preset declaration plus
// scripts, and the recipient's Harness already ships a YAML parser for its own
// loader. So instead of adding `js-yaml` to package.json, this walks the known
// locations a DSH installation keeps one in. Nothing here is machine-specific.

import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Directories that may hold a resolvable YAML parser, most specific first. */
function candidates() {
  const list = [];
  if (process.env.DSH_PROFILE_DIR) list.push(process.env.DSH_PROFILE_DIR);
  if (process.env.DSH_HOME) list.push(process.env.DSH_HOME);
  list.push(join(homedir(), '.dsh'));
  list.push(here);
  list.push(join(here, '..'));
  return list;
}

/** One level of `profiles/<name>` under a DSH home, where profile packages live. */
function profileDirs(home) {
  const profiles = join(home, 'profiles');
  try {
    return readdirSync(profiles)
      .map((name) => join(profiles, name))
      .filter((path) => statSync(path).isDirectory());
  } catch {
    return [];
  }
}

/**
 * Load a YAML parser from any reachable installation.
 * @returns The module namespace, exposing `load` and `DEFAULT_SCHEMA`.
 * @throws when no installation ships one, naming what was tried.
 */
export function loadYaml() {
  const tried = [];
  const roots = [...candidates(), ...candidates().flatMap(profileDirs)];
  for (const root of roots) {
    const base = resolve(root);
    tried.push(base);
    const require = createRequire(join(base, 'noop.js'));
    for (const name of ['js-yaml', 'yaml']) {
      try {
        return require(name);
      } catch {
        /* try the next name or root */
      }
    }
  }
  throw new Error(`no YAML parser (js-yaml or yaml) is reachable from:\n  ${tried.join('\n  ')}`);
}

/**
 * The loader's YAML dialect includes `!!js` scalars, which a plain schema rejects.
 * They are marker expressions the Loader evaluates later, so a validator reads
 * them as opaque strings.
 */
export function loaderSchema(yaml) {
  const schema = yaml.DEFAULT_SCHEMA;
  if (typeof schema?.extend !== 'function') return schema;
  return schema.extend([
    new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => String(data) }),
  ]);
}
