# root-planner preset bundle — maintainer notes

[English README](../README.md) | [中文说明](../README.zh.md) | [Install](../INSTALL.md)

An agent preset for DSH Web that splits **reading** from **planning and mutating**:
the root agent keeps its context for analysis, planning, and decisions, delegates
file reading and information queries to subagents, and is the only agent in the
tree allowed to create, modify, or delete files.

First published in the author's `web` profile as `@local/dsh-root-planner-preset`; the
package is now named `dsh-root-planner-preset` and is installable from a checkout or
a git repository. The preset id is `root-planner`, displayed as "Root Planner",
ordered after the shipped presets.

This file is for whoever maintains the bundle. Recipients should read
[INSTALL.md](../INSTALL.md).

## Files

Paths below are relative to the repository root; this file lives in `docs/`.

| File | Role |
|---|---|
| `persona.txt` | The persona prose. **This is the file to edit.** |
| `build-patch.mjs` | Generates `cordis.patch.yml` from `persona.txt`. |
| `cordis.patch.yml` | Generated. Do not hand-edit — regenerate instead. |
| `lib-yaml.mjs` | Resolves a YAML parser from the local DSH installation, so the scripts need no dependencies. |
| `verify-patch.mjs` | Parses the generated patch and checks persona integrity, the three rule sections, the worker preset row list, the delegation rows, the guard wiring and `engines.dsh`. |
| `child-tools.mjs` | The worker toolset this bundle intends, plus the scope-local names it must not try to restrict. Documentation and single source of intent, no longer a runtime mask. |
| `release.mjs` | One-command release: regenerate, verify, bump, commit, push, publish to the **official** registry, confirm the version is live, upgrade the local profile. `--dry-run` changes nothing. Run it from a terminal, not from inside the DSH sandbox, whose piped-stdio boundary makes its `spawn` calls fail with `EPERM` on Windows. |
| `tools/verify-session.mjs` | Reads a real run's `.jsonl.zstd` logs (frame by frame — one decompress call returns 323 bytes of a 140 KB log) and checks that the **root** and every descendant composed with root-planner, at the expected depth. |
| `tools/extract-tool-inventory.mjs` | Pulls the runtime's own `known global tools:` line out of a log. Useful after a DSH upgrade to see which tools no preset can remove. |
| `verify-depth-override.mjs` | Checks that the profile patch layer still parses and that the `subagent` depth override landed in the composed profile. |
| `package.json` | Bundle manifest (`dsh.bundle.patch`). |
| `.gitattributes` | Pins LF; without it a Windows checkout breaks the byte-identity check. |
| `README.md` / `README.zh.md` | The English and Chinese front pages, cross-linked. npm renders the repository root `README.md`, which is why the English one holds that name. |
| `INSTALL.md` | Recipient-facing setup steps and troubleshooting (Chinese). |
| `.github/CONTRIBUTING.md` | The contributor workflow: regenerate, verify, and the rules a change must not break. |
| `.github/workflows/verify.yml` | CI: fails when `cordis.patch.yml` drifts from `persona.txt`, then runs the patch and guard checks. |

```sh
node build-patch.mjs             # after every persona.txt edit
node verify-patch.mjs            # before trusting the result
node verify-depth-override.mjs   # after any change to the depth override
```

The generator exists because a ~6 KB persona has to be indented into a YAML
block scalar exactly: a mis-indented line silently truncates the prompt. It also
asserts that no placeholder survived, that both `allow:` blocks are indented
20/22 spaces, and that the persona block scalar is present exactly once.

## Installing this bundle elsewhere

Nothing in the bundle is machine-specific: it is a preset declaration, a persona,
and three scripts that resolve their own YAML parser. `package.json` declares no
dependencies and no build step.

Install it with `plugin_manager`, `action: install_bundle`, and one of these
targets:

| Target form | Example | Notes |
|---|---|---|
| Absolute path | `C:\path\to\root-planner-preset` | Works from a checkout, a share, or a USB drive. Already-installed bundles must be addressed by package name, not path. |
| Git repository | `github:you/root-planner-preset` | Also `https://…`, `git+…`, `gitlab:`/`gist:` forms. The manager pre-checks GitHub reachability with `git ls-remote`. |
| npm registry | `dsh-root-planner-preset` (`@1.0.0` to pin) | **Published.** Preferred: a prebuilt install skips pnpm's build-approval step. |
| Tarball URL | `https://…/dsh-root-planner-preset-1.0.0.tgz` | For a file server or release asset. |

### Publishing to npm

The package is live at <https://www.npmjs.com/package/dsh-root-planner-preset>.
Two things about this machine and account cost real time to discover; both are
permanent conditions, not accidents:

- **The configured registry is `registry.npmmirror.com`**, a read-only mirror.
  Every publish must name the official registry explicitly:
  `npm publish --registry https://registry.npmjs.org/ --access public`.
- **The publishing account uses npm's staged publishing.** A `npm publish` can
  report success and still leave the version off the registry, because it went to
  the stage instead; `npm stage list` may show nothing while the registry refuses
  that version with `E409 Cannot publish over previously staged version`. The
  reliable check is never the command's exit code — it is
  `https://registry.npmjs.org/<name>/<version>` returning 200. Version `1.0.0`
  reached the registry only after approval on npmjs.com, not from the CLI.

The `0.0.0-stage` version on the registry is an automatic placeholder from that
workflow. It is harmless but pointless; deprecate it rather than treat it as a
release. Never publish a real version below it.

### What the recipient's environment must provide

1. **A DSH version whose presets carry the same tool row ids.** The patch mirrors
   the shipped `standard` preset's rows. A DSH that renamed or dropped one of those
   rows makes this preset fail activation with a row diagnostic; the roster keeps
   the row and no session can compose from it until the patch is fixed.
2. **A delegation tool that supports `agentPreset`.** DSH 0.2.1 replaced the old
   `toolFilter` mask with preset selection: the curated child toolset is the
   `root-planner-worker` preset's row list, and both delegation rows name it. On an older
   runtime `toolFilter` is stripped silently and children fall back to the platform's
   default preset — which is why `package.json` declares `engines.dsh >= 0.2.1-rc.2`.
   Tools registered **globally** by the Host (`ops_*`, `working_directory`) cannot be
   removed by any preset; workers will always see those.
3. **The depth setting.** `maxDepth` is a Host setting, *not* part of this bundle.
   Set **Settings → Subagents → depth limit** to `2` (0 disables all delegation and
   breaks the design). `verify-depth-override.mjs` validates that override on the
   machine that has it and prints a SKIP elsewhere.
4. **Node**, for the two scripts only. The bundle itself needs nothing.

There is no `.gitignore` and no build output: the whole bundle is the six text
files listed above.

## How one persona serves both sides

A delegation row names `agentPreset: root-planner-worker`, so a child is composed from the
**worker preset**, not from its parent's. Both presets mount the **same `persona.txt`**,
which is why one body has to serve every node: there is no per-role prompt, and a preset
`persona` row cannot be made child-specific.

Three facts shape how the text is written:

- DSH inserts a fixed runtime-context statement into every subagent's prompt: *"You are a
  delegated subagent: your permission scope was fixed when you were started…"*. It is
  authoritative and cannot be removed.
- DSH also injects `Your parent agent id is "<id>". Before you finish, send your result to
  that agent with send_message(…)` as a message after the task. That is the only upward
  address a child is given, and it cannot be derived from the persona.
- Role is therefore a **decision the text can instruct**, not a variable it can substitute.
  On 0.2.1 the only prompt variables a preset persona may use are `{{provider}}` and
  `{{model}}`; `{{cwd}}` was removed and now fails the whole run with *unknown prompt
  variable*. There is no `{{role}}` and no `{{parent_agent_id}}`.

So "Which role you are in" reads its own prompt for that fixed statement, and the rules are
filed **by side rather than by agent**: a depth-1 agent is the delegated side of the edge
above it and the delegating side of the edges below it, and it needs both halves at once.
Filing them by role instead is what made a mid-level agent read only the worker half and
treat itself as a leaf.

## What is enforced, and where

| Requirement | Mechanism | Strength |
|---|---|---|
| Subagents can read, edit files and run commands | The `root-planner-worker` preset mounts `tool-fs`, `tool-pwsh`, `tool-web`, `tool-skill`, `tool-todo` and the delegation rows; both delegation tools set `agentPreset: root-planner-worker` | **Structural**: a worker gets a tool only if a row provides it |
| Subagents cannot leave a process running | `enableRunInBackground: false` on `tool-pwsh` in **both** presets — the call is refused *and* `run_in_background` disappears from the schema | **Structural** |
| A subagent cannot write outside the tree's `_agents/` | `guard.js`, a profile-level tool guard keyed on the calling session's `origin` | **Structural for file tools** (the call is refused, the file is not created); **best-effort for shell** — an absolute path in the command is refused, a path built at runtime is not |
| A subagent reports a change instead of making it | Delegated-side rules (write only in your workspace; change outside it is a request) | Prompt-level |
| The delegating side owns mutation decisions | Delegator rules (state which files may change; answer change requests) | Prompt-level |
| The delegating side delegates reading | Delegator rules (delegate research; read directly only when cheap) | Prompt-level — the delegating agent keeps `read`/`glob`/`grep` so it can verify a thin summary |
| No runaway depth | Runtime depth limit (`subagent.maxDepth`, set to `2` — see Constraints) | **Structural**: `resolveChildDepth` = parent depth + 1 and throws `SubagentDepthError` past the cap |
| Depth-1 agents may delegate as well | The worker preset contains the same delegation rows, so the tree recurses to the cap | **Structural** (the capability) + prompt-level (the budget that decides whether to use it) |

The persona files its rules **by side, not by agent**: "Rules for every agent", "When you
delegate", "When you are delegated to". That is what lets a depth-1 agent apply the
delegating half to its own children while still following the delegated half toward its
parent. A curated child toolset cannot be expressed as a mask any more — DSH 0.2.1 removed
`toolFilter` and strips it silently — so the curated set is the worker preset's row list,
and `verify-patch.mjs` asserts that list in both directions.

## Constraints

- **Do not move or delete this directory.** The profile installs it from npm
  (`dsh-root-planner-preset`), not as a link; the bundle is resolved from the profile's
  `node_modules`.
- **Depth is `2`, set as a Host override.** `maxDepth` is deliberately left unset
  on both delegation tool rows so it resolves from
  **Settings → Subagents → depth limit** (`subagent.maxDepth`). The tool rows
  respect whatever the Host says, so the depth stays adjustable from the UI — and
  a literal `maxDepth` here would silently *lower* an intentional higher Host
  value, which is why it is absent.
  The value lives in the profile patch layer
  `~/.dsh/profiles/web/cordis.patch.yml` as an override of the `subagent` row:

  ```yaml
  - id: subagent
    name: "@deepseek-ai/dsh-subagent"
    config:
      maxDepth: 2
      maxActiveSubagents: 8
  ```

  This is exactly what the Settings page writes, so editing the depth there keeps
  working and stays consistent with this file. With `2` the tree is
  root(0) → subagent(1) → grandchild(2); depth-2 agents are leaves. Setting it to
  `0` disables all delegation and breaks the design.
- Changing `persona.txt` or the preset's rows requires either toggling
  `preset-root-planner` off and on in the plugin list, or simply opening a **new
  session**: an existing session and its children keep the plugin revision they started
  with. Editing the installed copy is not enough — publish and reinstall, or the running
  Harness keeps the old module generation until it restarts.
- The preset mirrors the `standard` preset's tool rows. A DSH upgrade that adds
  tools to `standard` does not add them here.

## Verified

- `verify-patch.mjs`: the patch parses as loader YAML (`!!js` tags treated as opaque);
  preset ids and orders are correct; the **parsed persona is byte-identical to
  `persona.txt`**; the three rule sections carry the expected counts with contiguous
  numbering; the worker preset mounts the required rows and none of the root-only ones;
  both delegation rows name the worker preset and carry no `toolFilter`; the guard is a
  top-level entry shipped inside the package; `engines.dsh` is an inclusive floor; no tabs.
- The bundle installs with `application: applied` and composes.
- `verify-depth-override.mjs`: the profile patch layer parses, the `subagent` override is
  well-formed, and the composed profile resolves `subagent.maxDepth` to `2`. When
  `cordis.yml` still holds the empty template it reports **SKIP** rather than failing —
  that file is a runtime cache the harness rewrites at startup.
- `test-guard.mjs`: 21 boundary assertions over the write fence.
- **End to end on a live session (DSH 0.2.1-rc.2).** A root-planner session spawned four
  children; each was offered **26** tools against the platform default's **39**; each
  carried this preset's persona; a child's write outside `_agents/` was refused
  (`write: outside your workspace.`) and the file was **not** created, while the same
  call inside `_agents/` succeeded. Re-checked after the standalone guard bundle was
  uninstalled, because the fence now ships only in this package.
- **Recursion under the two-preset layout, and the nested workspace protocol** — measured
  on a three-level tree (`session-cf2b2c67` → `9136c2a6` → `5e38b6b5`, on DSH 0.2.1-rc.2):
  - depth 2 exists, and the depth-2 agent is composed from the **worker** preset like its
    parent: 26 tools at both depths, no root-only tool at either.
  - the **restructured persona reached every level** (`Rules for every agent` present in
    root, child and grandchild), so the by-side filing survives composition.
  - the root created `_agents/` itself (a `write` of `_agents/.keep`), then named the
    child's workspace in the task.
  - the child **created its own** `_agents/probe/`, then created
    `_agents/probe/_agents/leaf/` for its own child, which created nothing above its own
    directory — the layout on disk is `_agents/probe/_agents/leaf/`.
  - the grandchild reported upward with `send_message` to its *own* parent (the runtime's
    parent-id injection), and the child sent the root a checkpoint and a final report.
  - four out-of-tree writes from the child were refused, and the target file does not
    exist on disk.

## Not verified

- **The "parent skipped `_agents/`" defect path.** The rule exists and
  `verify-patch.mjs` asserts its wording, but no run has yet hit a child whose parent
  forgot to create the directory — the observed run had the parent create it first.
- **Platforms other than Windows**, and any DSH newer than 0.2.1-rc.2.
