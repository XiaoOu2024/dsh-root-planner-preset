# dsh-root-planner-preset

An agent preset for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that **separates deciding from doing**.

The root agent's context holds the plan and the decisions; reading, editing and running commands go to subagents that report back summaries. Subagents are full workers — they have `write`, `edit` and a shell — and the one thing none of them may leave behind is **a process still running**.

> The root decides, the workers do the work, and nothing outlives the task.

[中文说明](README.zh.md) | [Install](INSTALL.md) | [Maintainer notes](docs/DEVELOPMENT.md)

## The problem it solves

On a long task a coding agent's context fills up with raw file contents and command output, and it forgets the goal, loses the plan, and starts repeating work. The usual answer — "delegate more to subagents" — fails in two opposite directions: a delegate with no hands cannot do anything, so every step bounces back; and a fleet of delegates with no bounds will edit whatever they like and leave servers running.

This preset takes the middle line: **workers with tools, bounded by their task.**

| Requirement | Mechanism | Strength |
|---|---|---|
| A subagent can read, **edit files and run commands** | `toolFilter.allow` on both delegation tools includes `write`, `edit`, `ops_replace`, `pwsh` | Grant, not restriction — a worker without tools is not a worker |
| A subagent cannot leave a process running | `enableRunInBackground: false` on the preset's `pwsh` row: the call is refused **and** `run_in_background` is removed from the tool schema | **Structural** — no model at any depth can reach for a detached process |
| Nobody runs an unbounded service | Persona rules for the root and for subagents | Prompt-level, covering what a schema cannot (`ops_bash` has no job registry) |
| A subagent stays inside the task it was given | Persona rules: named files only, no drive-by fixes, no racing siblings | Prompt-level |
| Delegation depth is the user's setting | The runtime depth cap (`subagent.maxDepth`) | **Structural**: past the cap it throws `SubagentDepthError` |
| Live children are capped as well | `subagent.maxActiveSubagents` | **Structural**: past the cap a delegation fails with `subagent limit reached`, and it does not queue |
| The root decides; workers execute | Persona rules | Prompt-level |

The mask is an **allow** list: a tool added by a future plugin is invisible to subagents until it is added here.

### Two limits you will meet on a broad task

Both are Host settings, both are structural, and both are documented because they read
like defects the first time:

- **`subagent limit reached (active child limit: N)`** — a delegated child is
  *resident*, not merely running: a slot returns only after its turn ends, its inbox
  is empty, and its own children are disposed. A wide fan-out therefore holds every
  slot until that work actually finishes, and the batch does not queue behind the
  cap. Raise `maxActiveSubagents` (**Settings → Subagents**) if the machine can
  carry more live agents, or dispatch a batch you can finish and collect it before
  opening the next. The author's own profile carries 16 for this reason.
- **`subagent depth N exceeds maxDepth M`** — a delegation from a leaf. That is the
  cap working, not a failure; the child reads the material itself.

## How it works

```
root agent  ──delegates──▶  subagent  ──delegates──▶  … until maxDepth
   │                            │
   └── decides, integrates, and states what each worker may touch
```

Two mechanisms decide how deep the tree goes, and they pull in the same direction:

- **The mask** gives *every* subagent, at *every* level, the same working set — read,
  write, shell — and withholds the same things. The grant does not weaken with
  depth, and neither does the bound.
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

- **Root agent**: plans first (goal, success criteria, constraints, ordered task list), dispatches work that is heavy enough to be worth the round trip, keeps the integration and the decisions, and states in every delegation which files may be touched.
- **Subagent**: does the task — reads, edits the files it was given, runs the commands that belong to it — and reports the conclusion with the minimum evidence, plus exactly what it changed.
- **The root decides** what changes and who makes them; a worker that changes something outside its task is a defect, not initiative.

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

> ⚠️ **The easiest mistake to make: the root session must actually be composed with Root Planner.** In one real trial the root session was still `standard`, so the root was bound by none of this preset while the subagents it spawned *were* `root-planner` — every rule and permission in the tree was mismatched, and a batch of confident conclusions about the preset followed from it. **To check:** run `node tools/verify-session.mjs <session-dir>`, which reports the preset and depth of the root and every descendant, and fails loudly when the root is not `root-planner`.

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
