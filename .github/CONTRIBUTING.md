# Contributing

Thanks for looking. This repository is meant to be maintained by more than its
author — the license is [MIT](../LICENSE), and issues and pull requests are open
to anyone.
## The one thing to know first

**`cordis.patch.yml` is generated. Do not edit it by hand.**

It is produced from `persona.txt` by `build-patch.mjs`, and it has to be indented
into a YAML block scalar exactly — a single mis-indented line silently truncates
the ~6 KB persona, which is very hard to spot in review and easy to introduce by
hand. That is the whole reason the generator exists.

So to change what the agent is told:

```sh
$EDITOR persona.txt
node build-patch.mjs      # regenerates cordis.patch.yml
node verify-patch.mjs     # must print ALL CHECKS PASSED
```

Commit **both** files. CI re-runs the generator and fails if the committed patch
does not match `persona.txt` byte for byte, so forgetting the second command is
caught for you.

## Setup

The bundle itself ships no dependencies. The repository's scripts need one YAML
parser, which `lib-yaml.mjs` resolves from your own DSH installation — or from a
local install:

```sh
npm ci        # installs js-yaml, the only devDependency
```

## What the checks mean

`node verify-patch.mjs` asserts, among other things:

- the patch parses as loader YAML (including the `!!js` scalars, read as opaque);
- the persona parsed out of the patch is **byte-identical** to `persona.txt`;
- both delegation tools publish `subagent` / `subagent_fork`;
- both `toolFilter.allow` masks exclude every mutation entry point
  (`write`, `edit`, `ops_replace`, `ops_bash`, `pwsh`) and name **only tools that
  exist** — a name that is not a registered global tool makes
  `tools.restrict()` throw the first time a subagent is created.

That last point is the most likely thing to need changing on your machine: the
mask was written against the author's profile. If your profile registers a
different set of global tools, the mask is what has to adapt — edit the list near
the bottom of `verify-patch.mjs` in the same commit.

`node verify-depth-override.mjs` checks the delegation depth override. Depth is a
**Host setting, not part of this bundle**, so on a machine that never set it the
script prints `SKIP` and explains why. That is a pass, not a failure.

## Most valuable contributions, in order

1. **Bug reports with real error text**, plus your DSH version and which global
   tools your profile registers. The `Not verified` section of the
   [README](../README.md) names exactly where this matters: no subagent has been
   spawned under this preset in the author's environment to date.
2. **Mask fixes for other environments** — see above.
3. **Persona improvements** — the text itself, when you have an observed failure
   it would have prevented.
4. **Documentation and translations** — [README.zh.md](../README.zh.md) and
   [INSTALL.md](../INSTALL.md) especially.

## Ground rules

- **One concern per pull request.** A persona change and a mask change are two
  pull requests unless one requires the other.
- Say which preset you tested with, and on which platform.
- Do not weaken the **process bound**. `enableRunInBackground: false` must stay on
  the preset's `tool-pwsh` row: a change that lets a subagent detach a server drops
  the one property this preset enforces structurally rather than by asking nicely.
  `verify-patch.mjs` fails if it is missing.
- A subagent keeps `write`, `edit`, `ops_replace` and `pwsh`. They are workers —
  taking their tools away turns every executable step back into the root's own work,
  which is the failure mode this preset exists to avoid.
- Keep `main` linear — the branch protection refuses merge commits, so rebase
  rather than merge.

## Releasing

`node release.mjs <patch|minor|major|X.Y.Z>` does the whole sequence. Every step in
it exists because the manual version went wrong at least once:

1. regenerates `cordis.patch.yml` and refuses to continue unless
   `verify-patch.mjs` passes;
2. bumps `package.json` and commits with a local-time stamp;
3. pushes (the owner bypasses branch protection; a collaborator's push is refused,
   so open a pull request instead);
4. publishes to `https://registry.npmjs.org/` **explicitly** — the configured
   registry is a read-only mirror that also lags behind, which is how an install
   right after a release fails with *No matching version found*;
5. **polls the registry for the exact version** rather than trusting the exit code,
   because publishing on this account is staged and `npm publish` can print success
   without the version ever appearing;
6. upgrades the local profile so the machine runs what was published.

`--dry-run` walks the whole thing without changing anything; `--skip-install` and
`--skip-gh` drop the last two steps.

Run it from a terminal. Inside DSH's own sandbox its `spawn` calls fail with
`EPERM` on Windows — that is the sandbox's piped-stdio boundary, not a defect in
the script.

**A release is not a verification.** The script can put a version on npm while the
preset stays unproven. Restart `dsh web`, open a new session on Root Planner, and
confirm the *root* actually composed with it — `node tools/verify-session.mjs
<session-dir>` — before believing anything about behaviour.

## How `main` is protected

`main` requires the `verify` status check (strict: the branch must be up to date),
refuses force pushes and deletions, requires linear history, and requires
conversations to be resolved. The repository owner can bypass these for a direct
push in an emergency; **collaborators cannot** — send a pull request and let CI
run.

If you are added as a collaborator and want to be able to merge your own pull
requests without waiting for the owner, say so: review requirements are off
deliberately, because a single-maintainer repository that requires an approval it
cannot get would deadlock.
