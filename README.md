# root-planner preset bundle

An agent preset for DSH Web that splits **reading** from **planning and mutating**:
the root agent keeps its context for analysis, planning, and decisions, delegates
file reading and information queries to subagents, and is the only agent in the
tree allowed to create, modify, or delete files.

First published in the author's `web` profile as `@local/dsh-root-planner-preset`; the
package is now named `dsh-root-planner-preset` and is installable from a checkout or
a git repository. The preset id is `root-planner`, displayed as "Root Planner",
ordered after the shipped presets.

## Files

| File | Role |
|---|---|
| `persona.txt` | The persona prose. **This is the file to edit.** |
| `build-patch.mjs` | Generates `cordis.patch.yml` from `persona.txt`. |
| `cordis.patch.yml` | Generated. Do not hand-edit — regenerate instead. |
| `lib-yaml.mjs` | Resolves a YAML parser from the local DSH installation, so the scripts need no dependencies. |
| `verify-patch.mjs` | Parses the generated patch and checks persona integrity, role wiring, and the child mask. |
| `verify-depth-override.mjs` | Checks that the profile patch layer still parses and that the `subagent` depth override landed in the composed profile. |
| `package.json` | Bundle manifest (`dsh.bundle.patch`). |

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
| npm registry | `dsh-root-planner-preset` or `…@1.0.0` | **Not published yet**, and `private: true` blocks it. Drop `private`, bump the version, then publish. |
| Tarball URL | `https://…/dsh-root-planner-preset-1.0.0.tgz` | For a file server or release asset. |

### What the recipient's environment must provide

1. **A DSH version whose presets carry the same tool row ids.** The patch mirrors
   the shipped `standard` preset's rows. A DSH that renamed or dropped one of those
   rows makes this preset fail activation with a row diagnostic; the roster keeps
   the row and no session can compose from it until the patch is fixed.
2. **The same global tool names.** The child mask is an allow list, and
   `tools.restrict()` *throws* on an unknown global name when a child is created.
   At minimum the profile must register: `read`, `glob`, `grep`, `read_image`,
   `skill`, `todo_write`, `ask_user_question`, `get_goal`, `create_goal`,
   `update_goal`, `list_agents`, `send_message`, `interrupt_agent`, `subagent`,
   `subagent_fork`, plus `web_search`/`web_fetch` and the three `ops_*` readers if
   they publish them. A profile missing any of these needs its mask edited —
   `verify-patch.mjs` cross-checks the names against a list near the bottom.
3. **The depth setting.** `maxDepth` is a Host setting, *not* part of this bundle.
   Set **Settings → Subagents → depth limit** to `2` (0 disables all delegation and
   breaks the design). `verify-depth-override.mjs` validates that override on the
   machine that has it and prints a SKIP elsewhere.
4. **Node**, for the two scripts only. The bundle itself needs nothing.

There is no `.gitignore` and no build output: the whole bundle is the six text
files listed above.

## How one persona serves both roles

A subagent joins its parent's preset (`applyChildComposition` →
`composeFrom`), so it receives **this same persona text**. There is no separate
subagent prompt, and a preset `persona` row cannot be made child-specific.

Two facts make one body sufficient:

- DSH inserts a fixed runtime-context statement into every subagent's prompt:
  *"You are a delegated subagent: your permission scope was fixed when you were
  started…"*. It appears in the runtime-context snapshot, before the persona
  section, and it is impossible to remove.
- Therefore role is a **decision the text can instruct**, not a variable it can
  substitute. The only prompt variables a preset persona may use are `{{cwd}}`,
  `{{model}}`, and `{{provider}}` — there is no `{{role}}` or `{{parent_agent_id}}`.

So "Which role you are in" reads its own prompt for that fixed statement. No
extra plugin, no duplicated preset, no drift between the parent's copy and the
child's.

## What is enforced, and where

| Requirement | Mechanism | Strength |
|---|---|---|
| Subagents cannot create, modify, or delete files | `toolFilter.allow` on both delegation tools | **Structural**: absent tools cannot be called. `write`, `edit`, `ops_replace` are not in the mask. |
| Subagents have no shell | Same mask | **Structural**: `ops_bash` and `pwsh` are absent. |
| Root owns all mutations | Persona rule 6 + the mask applies only to children | **Prompt-level** for the root; structural for children. |
| Root delegates reading | Persona rules 2–4 | **Prompt-level** only. The root keeps `read`/`glob`/`grep` deliberately, so it can verify a claim when a summary is thin. |
| No runaway task passing | Runtime depth limit (`subagent.maxDepth`, set to `2` — see Constraints) | **Structural**: `resolveChildDepth` = parent depth + 1 and throws `SubagentDepthError` past the cap. With `2` the tree is root(0) → subagent(1) → grandchild(2), and the depth-2 agents cannot delegate further. |
| Intermediate agents do not re-delegate reflexively | Persona rule 7 + "When to pass work down" | Prompt-level, and load-bearing at `maxDepth: 2`: depth-1 agents *can* delegate, so the three-question test is what keeps a wide fan-out from becoming a deep chain. |
| Subagents report needed changes upward | Persona subagent rule 2 + root rule 8 | Prompt-level; a child cannot act on it anyway. |

The mask is an **allow** list, not a deny list: a tool added by a future plugin is
invisible to subagents until it is added here. `tools.restrict()` also rejects
unknown names when a child is created, so every name in the mask must be a tool
this profile actually registers — that is why `verify-patch.mjs` cross-checks the
mask against the profile's live tool inventory.

## Constraints

- **Do not move or delete this directory.** The profile installs it as a link:
  `"@local/dsh-root-planner-preset": "link:C:/Users/Admin/Documents/deepseek-harness/default-workspace/root-planner-preset"`.
  Moving it breaks the install.
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
- Changing `persona.txt` or the mask requires either toggling `preset-root-planner`
  off and on in the plugin list, or simply opening a **new session**: an existing
  session and its children keep the plugin revision they started with.
- The preset mirrors the `standard` preset's tool rows. A DSH upgrade that adds
  tools to `standard` does not add them here.

## Verified

- `verify-patch.mjs`: patch parses as loader YAML (`!!js` tags treated as opaque),
  preset id/order correct, **parsed persona byte-identical to `persona.txt`**, no
  tabs, both delegation rows publish `subagent`/`subagent_fork`, both masks
  exclude every mutation entry point and include only live tools — all checks pass.
- Bundle installed with `application: applied`; `preset-root-planner` is live and
  its `config.plugins` validates against the shipped Config schema.
- `verify-depth-override.mjs`: the profile patch layer still parses, the `subagent`
  override is well-formed, and the **composed** profile
  (`~/.dsh/profiles/web/cordis.yml`) resolves `subagent.maxDepth` to `2`. That
  composed file was rewritten seconds after the patch edit, so the running profile
  re-composed rather than waiting for a restart — and `resolveMaxDepth` reads the
  live config at delegation time, so the new depth applies to the next delegation.

## Not verified

- **No subagent has actually been spawned under this preset, at any depth.** Verifying
  the mask and the depth cap at runtime needs a session running `root-planner`, and
  the agent that authored this bundle ran under the `cordis` preset. To confirm it
  yourself: start a new session with the **Root Planner** preset, delegate one
  research task, and check
  - that the child's tool list contains no `write`, `edit`, `ops_replace`, or shell
    tool, and
  - that the child *can* delegate one more level, while its own child cannot.

  A mask name that is not a registered global tool would fail child creation with
  `tools.restrict() names unknown global tool …`; the allow list was built by
  cross-checking the profile's live tool inventory, so this is not expected.

## Where conventions live (and why they are not in the persona)

Machine and project conventions deliberately do **not** live in this bundle. The
persona is identity; a convention file is a maintained document. The user's
operations convention is actively appended to (new tool paths get written back into
it), so folding it into the persona would mean a `persona.txt` edit, a regeneration,
a bundle reinstall, a **restart**, and a **new session** for every added tool path.

DSH has a native layer for this, active in every preset via
`@deepseek-ai/dsh-agent-instructions` (`maxBytes: 65536`), which loads the
instruction chain per request without a restart:

| Content | Location |
|---|---|
| Machine-wide: pwsh7 enforcement, absolute tool paths, python dependency pre-check, time format | `~/.dsh/AGENTS.md` |
| Project rules: git commit granularity, `A_文件导航.md` register, output layout | that project's root `AGENTS.md` (on demand, only where rules exist) |
| Private values: hosts, ports, credentials | project root `AGENTS.local.md` + `.gitignore` |

Discovery is anchored on `.git`: `findProjectRoot` walks upward from the session cwd
to the first directory holding the marker, then the chain runs root → cwd. **With no
marker anywhere on the chain the root degrades to cwd itself**, so a file in a parent
directory is not read. `CLAUDE.md` is loaded with the same candidates, and identical
sibling files render once.

The persona carries one precedence clause instead of the conventions themselves:
project files apply, but the subagent read-only rule wins where they conflict,
because the runtime enforces it and a project file cannot.
