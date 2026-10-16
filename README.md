# dsh-root-planner-preset

An agent preset for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that **separates reading from deciding**.

The root agent's context holds task analysis, planning and decisions; file reading and information queries go to subagents that return summaries only. Creating, modifying and deleting files stays with the root agent — subagents do not even have the tools.

> One agent in the tree has hands. Every other agent has only eyes.

[中文说明](README.zh.md) | [Install](INSTALL.md) | [Maintainer notes](docs/DEVELOPMENT.md)

## The problem it solves

On a long task a coding agent's context fills up with raw file contents, and it forgets the goal, loses the plan, and starts repeating work. The usual answer — "delegate more to subagents" — does not hold on its own: a subagent will still edit files on its way past, and work gets passed further down without limit.

This preset turns both of those into structural constraints rather than good intentions:

| Requirement | Mechanism | Strength |
|---|---|---|
| Subagents **cannot** create, modify or delete files | A `toolFilter.allow` list on both delegation tools, without `write`, `edit`, `ops_replace` | **Structural**: an absent tool cannot be called |
| Subagents **have no shell** to work around it | The same list, without `ops_bash`, `pwsh` | **Structural** |
| Delegation depth is bounded by configuration | The runtime depth cap (`subagent.maxDepth`, a Host setting) | **Structural**: past the cap it throws `SubagentDepthError` |
| The root agent owns every mutation | Persona rules (the mask applies to children only) | Prompt-level |
| A heavy task is decomposed rather than ground through | Persona rule 2 | Prompt-level |

The mask is an **allow** list, not a deny list: a tool added by a future plugin is invisible to subagents until it is added here — **with one exception, and it is what makes recursion work.**

## How it works

```
root agent  ──delegates──▶  subagent  ──delegates──▶  … until maxDepth
   │                            │
   └── the only one with write / edit / shell; every level stays read-only
```

Two mechanisms decide how deep the tree goes, and they pull in the same direction:

- **The mask** strips every mutation entry point from *every* subagent, at *every*
  level — the guarantee does not weaken with depth.
- **The depth cap** (`subagent.maxDepth`, a Host setting you control) decides how
  many levels exist. `2` means root → child → grandchild; raise it and the tree
  deepens, set it to `1` and children become leaves.

A `toolFilter` is a mask of **global** tools, and `subagent` is not one: with
`modelSelectionSettings: true` it is mounted inside each composed Agent's own
scope, so a mask can never name it. That is why it is absent from
`child-tools.mjs` — **not** because children lack it. Scoped registrations stay
visible through a restriction, and every child inherits this preset, so each level
gets its own `subagent` and can delegate onward until the depth cap stops it.

An earlier version of this bundle did list `subagent` in the mask, and **every
subagent creation failed** with
`tools.restrict() names unknown global tool "subagent"` — the mask rejecting a
name it could never legally contain, not the tool being missing.

- **Root agent**: plans first (goal, success criteria, constraints, ordered task list), delegates reading, searching and locating by default, and reads directly only for one known file, a short targeted range, or to check a claim a subagent made.
- **Subagent**: reads, locates and summarizes. On finding that a file **needs changing** it does not act; it reports the exact change — target path, location (`file:line`), current content, proposed replacement, and why.
- **The root agent decides** on that proposal and then makes the change itself.

How does a subagent know it is a subagent? DSH force-inserts the sentence `You are a delegated subagent: …` into every subagent's prompt, injected by the runtime and impossible to remove — while a preset persona has **no** `{{role}}`-style variable available. So the persona states a **test** instead: read your own prompt for that sentence. One persona then serves both roles, and parent and child read the same text, which is what prevents the drift where a parent believes a child is constrained and the child never saw it.

## Quick start

Install from npm (prebuilt, no build-approval step):

```sh
dsh plugin --profile web add dsh-root-planner-preset
```

Or straight from GitHub source:

```sh
dsh plugin --profile web add github:XiaoOu2024/dsh-root-planner-preset
```

Then **one required step**: set **Settings → Subagents → depth limit** to **`2`**. (This is the Host's `subagent` settings section — global, and **not** part of the bundle. Setting it to `0` disables all delegation and breaks the design.)

Then **start a new session** and pick **Root Planner** in the preset selector. Full steps and troubleshooting are in [INSTALL.md](INSTALL.md).

> ⚠️ **The easiest mistake to make: the root session must actually be composed with Root Planner.** In one real trial the root session was still `standard`, so the root was bound by none of this preset while the subagents it spawned *were* `root-planner` — every rule and permission in the tree was mismatched, and a batch of confident conclusions about the preset followed from it. **To check:** the first line of `~/.dsh/sessions/<cwd>/<session-id>/session.v4.jsonl.zstd` carries `"agentPreset"`, which must read `root-planner`; or run `node tools/inspect-sessions.mjs <session-dir>` to print the preset, depth and tool inventory of the root and every child at once.

## When it fits, and when it does not

**Fits**: long research-heavy tasks across many files, reverse engineering, code review — anything read-heavy, or where a change must be carefully decided.

**Does not fit**:

- changing one file quickly — the extra delegation layer is pure overhead;
- wanting subagents to **write code in parallel** — this preset forbids that on purpose; use the `standard` preset instead;
- an environment missing the DSH tooling listed in [INSTALL.md](INSTALL.md).

## Repository contents

| File | Purpose |
|---|---|
| `cordis.patch.yml` | The preset declaration (**generated — do not hand-edit**) |
| `persona.txt` | The persona prose; **edit this one** |
| `build-patch.mjs` | Generates `cordis.patch.yml` from `persona.txt` |
| `verify-patch.mjs` | Checks patch structure and the tool mask, and asserts byte identity of the persona |
| `verify-depth-override.mjs` | Checks that the depth override reached the composed profile |
| `lib-yaml.mjs` | Resolves a YAML parser from the local DSH install, so this package has **no dependencies** |
| `docs/DEVELOPMENT.md` | Maintainer notes: design trade-offs, mechanics, verified/unverified boundaries |

## Verified / not verified

**Verified**: the patch parses as loader YAML; the parsed persona is **byte-identical** to `persona.txt`; both delegation masks exclude every mutation entry point and name only tools the runtime reports as global; a clean checkout passes verification (`.gitattributes` pins LF, without which a Windows clone breaks the byte-identity check); the depth override reached the composed profile.

**Fixed after a real failure**: a subagent spawn on a live `root-planner` session failed with `tools.restrict() names unknown global tool "subagent"`. The cause was a design error in this bundle, not a misconfiguration — `subagent` is registered inside each composed Agent's own scope, and a `toolFilter` takes global names only, so the mask was naming something it could never contain. The mask no longer names it, `verify-patch.mjs` asserts its absence by intent, and the mask is defined once in `child-tools.mjs` so the generator and the verifier cannot drift apart.

**Still not verified**: **no subagent has been spawned successfully under this preset yet.** Recursion is expected to work for the reason given above — the child inherits the preset and therefore its own scoped `subagent`, and a restriction does not hide scoped registrations — but that reasoning is exactly the kind that this bundle has already been wrong about once. Treat it as unconfirmed until someone reports a two-level delegation working.

## Contributing

Issues and pull requests are welcome — this repository is meant to be maintained by more than its author. The license is [MIT](LICENSE), so forking, modifying and redistributing are all permitted. **[CONTRIBUTING.md](.github/CONTRIBUTING.md) has the workflow, the checks, and the ground rules** — read it before changing the persona.

Useful contributions, roughly in order of value:

- **Report what broke**, with the error text and your DSH version. The unverified area above is exactly where real reports matter most.
- **Report a mask mismatch** on your platform: which global tools your profile registers and which name the mask got wrong.
- **Improve the persona** (`persona.txt`) — but run `node build-patch.mjs && node verify-patch.mjs` and include the result, since `cordis.patch.yml` is generated and a hand-edited one will be rejected.
- **Translate or fix the docs** — [README.zh.md](README.zh.md) and [INSTALL.md](INSTALL.md).

Please keep a change to one concern per pull request, and say which preset it was tested with.

## License

[MIT](LICENSE)
