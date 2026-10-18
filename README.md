# dsh-root-planner-preset

An agent preset for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that **separates deciding from doing**.

The root agent's context holds the plan and the decisions; reading, editing and running commands go to subagents that report back summaries. Subagents are full workers — they have `write`, `edit` and a shell — and the one thing none of them may leave behind is **a process still running**.

> The root decides, the workers do the work, and nothing outlives the task.

**Requires DSH `0.2.1-rc.2` or newer.** The package declares it as `engines.dsh`, so the plugin manager refuses to install on an older runtime. The floor is not cosmetic: 0.2.1 introduced `agentPreset` on the delegation tool and removed `toolFilter`. On 0.2.0 this preset still composes, and then quietly runs every child on the platform's default preset — wrong persona, twice the tools — which is worse than not installing it at all.

[中文说明](README.zh.md) | [Install](INSTALL.md) | [Maintainer notes](docs/DEVELOPMENT.md)

## The problem it solves

On a long task a coding agent's context fills up with raw file contents and command output, and it forgets the goal, loses the plan, and starts repeating work. The usual answer — "delegate more to subagents" — fails in two opposite directions: a delegate with no hands cannot do anything, so every step bounces back; and a fleet of delegates with no bounds will edit whatever they like and leave servers running.

This preset takes the middle line: **workers with tools, bounded by their task.**

| Requirement | Mechanism | Strength |
|---|---|---|
| A subagent can read, **edit files and run commands** | The `root-planner-worker` preset mounts `tool-fs`, `tool-pwsh`, `tool-web` and the delegation rows; every delegation spawns into that preset by name | Grant by construction — a worker without tools is not a worker |
| A subagent cannot leave a process running | `enableRunInBackground: false` on the preset's `pwsh` row: the call is refused **and** `run_in_background` is removed from the tool schema | **Structural** — no model at any depth can reach for a detached process |
| Nobody runs an unbounded service | Persona rules for the root and for subagents | Prompt-level, covering what a schema cannot (`ops_bash` has no job registry) |
| A subagent stays inside its own workspace | Persona rules: write only under `_agents/<label>/`, the parent's files read-only to it, outside changes sent as a request | Prompt-level, **verified** by the parent (see below) |
| Delegation depth is the user's setting | The runtime depth cap (`subagent.maxDepth`) | **Structural**: past the cap it throws `SubagentDepthError` |
| Live children are capped as well | `subagent.maxActiveSubagents` | **Structural**: past the cap a delegation fails with `subagent limit reached`, and it does not queue |
| The root decides; workers execute | Persona rules | Prompt-level |

The worker's toolset is an **allow list by construction**: a tool exists for a worker only if the worker preset mounts the plugin that provides it. A tool added by a future plugin — or by the app — is invisible to workers until a row is added here.

One caveat, measured rather than assumed: a small number of tools are registered **globally** by the Host and cannot be removed by any preset. On 0.2.1-rc.2 those were `ops_glob`, `ops_grep`, `ops_inspect_local_file`, `ops_replace` (from the `dsh-ops` plugin) and `working_directory`. A worker sees them whatever this package does; the curated set below is what the rows add on top.

### One workspace per worker

Concurrency is handled by separation rather than by coordination. Before delegating,
the root creates `_agents/<label>/` and puts that absolute path in the task; the child
writes **only** there, reads the parent's files freely, and sends a change request
instead of editing anything outside. On completion the child reports its artifacts and
the root decides which to copy in — merging into an existing file where that is what the
change means, keeping them separate where it is not. `_agents/` stays (and belongs in
`.gitignore`) so the same agent can be continued later.

**The boundary is enforced, not just agreed.** This preset's package also ships the fence
as a profile-level entry (`dsh-root-planner-preset/guard`), so one install carries the
protocol and its enforcement together. It refuses a `write`, `edit` or `ops_replace` whose
target resolves outside `<workspace>/_agents/`, and refuses a shell call whose `workdir` is
outside it or whose command names an absolute path into your files:

```
write: outside your workspace. You may write only inside "...\_agents"; everything else
in the parent's directory is read-only to you. Send your parent a change request instead
of writing "...\report.md" directly.
```

The root session is never fenced: it owns the workspace and has to be able to write
anywhere in it to integrate a child's artifacts.

**Being profile-level, it fences every delegated agent in this profile** — including
subagents under a different preset, which were never told about `_agents/`. If that matters
on your machine, turn the entry off in your profile patch:

```yaml
- id: root-planner-guard
  disabled: true
```

Declaring the guard as a row *inside* the preset would scope it to this preset only, and
that was tried first: measured against a live session it registered nothing — six probe
steps all came back allowed while the composed config looked correct. `verify-patch.mjs`
now fails if anyone declares it as a preset row again.

One limitation survives, and it is worth knowing before you rely on this: a shell command
can build a path at runtime (`$env:X` + `'..'`, a script that writes, a Here-String), and
no argument scan can see it. The command scan matches **drive-letter** paths, so on POSIX
it detects nothing at all — the two CI cases for it are skipped there rather than pretending
otherwise. Confining a child's shell properly would need a narrower
sandbox write root, which DSH cannot give a child — `sandboxPolicy.resolve()` accepts only
`{ session, mode }` and derives `workspaceRoot` from the immutable, inherited
`session.header.cwd`. So keep the parent's check as the backstop:

```sh
# before delegating
touch _agents/.mark-<label>
# after the child reports
find . -path ./_agents -prune -o -type f -newer _agents/.mark-<label> -print
```

No output means the child touched nothing outside its own directory; any output is a
file to inspect. The command needs no git repository — which matters, because the
workspace this was developed against is not one.

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

Two mechanisms decide what a worker gets and how far the tree goes, and they pull in the
same direction:

- **The worker preset** gives *every* subagent, at *every* level, the same working set —
  read, write, shell — and withholds the same things, because each level spawns into the
  same preset. The grant does not weaken with depth, and neither does the bound.
- **The depth cap** (`subagent.maxDepth`, a Host setting you control) decides how
  many levels exist. `2` means root → child → grandchild; raise it and the tree
  deepens, set it to `1` and children become leaves.

Both delegation rows carry `agentPreset: root-planner-worker`, and so do the two rows
*inside* that preset — which is what makes the tree recursive rather than one level deep.
One row deliberately does not: `subagent_fork` takes no `agentPreset`, because the fork
provider declares `inheritsParentContext: true` and `agentPreset: false`, and configuring
one for it makes the row throw at activation. A forked child therefore inherits its
parent's preset; from a worker that is still the worker preset, from the root it is the
root preset. That asymmetry is the price of the fork provider's design, not an oversight.

Until 0.2.1 this section described a `toolFilter` mask instead. That field was removed in
0.2.1 along with the mechanism behind it: zod strips it silently, and children then run
the platform's default preset. `verify-patch.mjs` fails if it reappears.

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
| `verify-patch.mjs` | Checks patch structure, the worker preset's row list, the guard's wiring, the persona's byte identity and the declared `engines.dsh` |
| `verify-depth-override.mjs` | Checks that the depth override reached the composed profile |
| `lib-yaml.mjs` | Resolves a YAML parser from the local DSH install, so this package has **no dependencies** |
| `docs/DEVELOPMENT.md` | Maintainer notes: design trade-offs, mechanics, verified/unverified boundaries |

## Verified / not verified

**Verified**: the patch parses as loader YAML; the parsed persona is **byte-identical** to `persona.txt`; the worker preset mounts exactly the rows it should and none of the root-only ones; both delegation rows name the worker preset and neither carries a removed `toolFilter`; the guard is a top-level entry that ships inside the package; the declared `engines.dsh` exists and is an inclusive floor; a clean checkout passes verification (`.gitattributes` pins LF, without which a Windows clone breaks the byte-identity check).

**Verified end to end on a real task**, on two DSH versions. Every line below was read from the session logs' own persisted tool schemas — the registry's output, not a model's recollection:

| Property | Evidence |
|---|---|
| The worker preset reaches every child | On 0.2.1-rc.2 a root-planner session spawned 4 children and each was offered **26** tools against the platform default's **39**; the 13 absent ones are exactly the root-only rows (`workflow`, `present`, `job_*`, `plugin_manager`, `schedule_*`, `cordis_inspect_*`, `exit_plan_mode`). Earlier, under the pre-0.2.1 mask, the same comparison measured 31 root / 25 child — the same idea, one mechanism earlier. |
| Subagents really are workers | `write`, `edit`, `ops_replace` and `pwsh` are present at every depth and were used: 10 `write` and 60 `edit` from the root, 14 `write` from one depth-1 agent, 20 `write` from a depth-2 agent. |
| No subagent can leave a process running | `run_in_background` is absent from the `pwsh` schema at all three depths. (A naive log search says otherwise — the phrase also occurs in `ops_bash`'s own description, which is why `tools/check-pwsh-background.mjs` inspects the schema window instead.) |
| Recursion works | 12 direct children, 4 of which delegated onward to 12 grandchildren; the root itself made 14 `subagent` calls. |
| The depth cap holds | The tree stops at depth 2; no depth-3 session exists anywhere in the log directory. |
| The live-child cap is soft, not fatal | One `subagent limit reached (active child limit: 8)` during an 8-wide fan-out. Settlements returned slots as children finished, and every later delegation succeeded. |
| The write fence is real | A child's write outside `_agents/` is refused with `write: outside your workspace.` and the file is **not** created; the same call inside `_agents/` succeeds. Re-checked after the standalone guard bundle was uninstalled, because the fence now ships only in this package. |

**Corrected twice, and both corrections are why the layout looks like this.** An early
version claimed the mask made children leaf agents; it does not, and recursion is bounded
by `maxDepth`. Then DSH 0.2.1 removed the mask mechanism altogether: `toolFilter` is now
stripped silently, so this package moved the working set into a second preset and selects
it with `agentPreset`. A stopgap that kept a `tools.restrict()` row failed for a different
reason — a restriction filters global tools only, and a preset's own rows register in the
agent's scope.

**How to check it yourself**: `tools/verify-session.mjs` proves which preset each
session ran and at what depth, but it does not read tool schemas. Use
`tools/extract-offered-tools.mjs` for the per-level tool list,
`tools/check-pwsh-background.mjs` for the process bound, and
`tools/count-tool-calls.mjs` for what a level actually called.

## Contributing

Issues and pull requests are welcome — this repository is meant to be maintained by more than its author. The license is [MIT](LICENSE), so forking, modifying and redistributing are all permitted. **[CONTRIBUTING.md](.github/CONTRIBUTING.md) has the workflow, the checks, and the ground rules** — read it before changing the persona.

Useful contributions, roughly in order of value:

- **Report what broke**, with the error text and your DSH version. The unverified area above is exactly where real reports matter most.
- **Report a toolset mismatch** on your platform: the tools a worker is offered, and which ones your profile registers globally — those cannot be removed by this package.
- **Improve the persona** (`persona.txt`) — but run `node build-patch.mjs && node verify-patch.mjs` and include the result, since `cordis.patch.yml` is generated and a hand-edited one will be rejected.
- **Translate or fix the docs** — [README.zh.md](README.zh.md) and [INSTALL.md](INSTALL.md).

Please keep a change to one concern per pull request, and say which preset it was tested with.

## License

[MIT](LICENSE)
