// Generates root-planner-preset/cordis.patch.yml from persona.txt.
//
// The persona is a long multi-paragraph text, and hand-indenting it into a YAML
// block scalar is exactly the kind of edit that silently produces a truncated or
// mis-indented prompt. This generator owns that indentation instead: edit
// persona.txt, re-run this script, and the patch stays valid.
//
// Usage: node build-patch.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHILD_TOOLS } from './child-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Read persona.txt, normalize line endings, and require content. */
function readPersona() {
  const text = readFileSync(join(here, 'persona.txt'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
  if (text.length === 0) throw new Error('persona.txt is empty');
  if (text.includes('\t')) throw new Error('persona.txt contains a tab: YAML block scalars forbid tab indentation');
  return text;
}

/**
 * Indent a block scalar body for `prefix: |-`. Every line gets `depth` spaces,
 * because the first line of a literal block scalar sits on its own line at the
 * same indentation as the rest; blank lines stay empty so no trailing
 * whitespace reaches the prompt.
 */
function blockScalar(text, depth) {
  const pad = ' '.repeat(depth);
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .map((line) => (line.length === 0 ? '' : pad + line))
    .join('\n');
}

/** Render one `allow:` key and its entry list at the given indentation. */
function allowList(names, keyDepth) {
  const keyPad = ' '.repeat(keyDepth);
  const itemPad = ' '.repeat(keyDepth + 2);
  return [`${keyPad}allow:`, ...names.map((name) => `${itemPad}- ${name}`)].join('\n');
}

/**
 * The child mask lives in `child-tools.mjs` so this generator and
 * `verify-patch.mjs` cannot disagree about it. See that file for why `subagent`
 * cannot appear in the list.
 */
const persona = readPersona();

/** The delegation group is shared by both shapes of child, so the mask is declared once. */

/**
 * The plugin rows shared by every preset this bundle ships: the planner, the worker
 * (a subset, defined separately below) and 深度创造. One list, so a row added for the
 * planner cannot silently miss the creation preset.
 *
 * `cordis: true` adds exactly what the platform's own creation preset adds — runtime
 * inspection through `tool-cordis` and the Cordis development skills through
 * `skill-filesystem.customSkillDirs` — and nothing else. In particular it does NOT
 * re-enable background processes: the platform's `cordis` preset also disables
 * `tool-pwsh` and mounts `tool-jobs` whose jobs nothing can start, so "deep creation"
 * here still means no process outlives its task.
 */
const CORDIS_EXTRA_ROWS = [
  '          - id: time-context',
  "            name: '@deepseek-ai/dsh-time-context'",
  '          - id: tool-cordis',
  "            name: '@deepseek-ai/dsh-tool-cordis'",
].join('\n')

// Same expression the shipped cordis preset uses, so the skills resolve from whichever
// installation owns this preset rather than from a hard-coded path.
const CORDIS_SKILL_DIRS = [
  '            config:',
  '              customSkillDirs:',
  "                - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')",
].join('\n')

const ROOT_ROWS = `          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: Your working directory is the session workspace; call the working_directory tool to read its absolute path when you need it.
              prefix: |-
<PERSONA>
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
            # Subagents get a shell here (see child-tools.mjs), so background jobs
            # are switched off for the whole preset. This is the one place the
            # "no long-running services" rule is enforceable rather than advisory:
            # with enableRunInBackground false the tool refuses a background call
            # AND omits run_in_background from its schema entirely, so no model at
            # any depth can reach for a detached process. A server a child starts
            # without backgrounding holds its own call until the timeout and dies
            # with it, which is the behaviour this preset wants.
            config:
              enableRunInBackground: false
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
__CORDIS_ROWS__          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
__SKILL_DIRS__          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
          - id: command-goal
            name: '@deepseek-ai/dsh-command-goal'
          - id: tool-goal
            name: '@deepseek-ai/dsh-tool-goal'
          - id: planning
            name: cordis:group
            group: true
            isolate:
              planMode: true
            config:
              - id: plan-mode
                name: '@deepseek-ai/dsh-plan-mode'
                config:
                  section: |
                    You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement, including an answer confirming something you asked, approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

                    Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

                    The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed only to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

                    Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

                    Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

                    When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
          # Delegation. Both tools share ONE mask (child-tools.mjs), so every child
          # in the tree gets the same working set — read, write, shell — no matter
          # which tool produced it, and every child is bounded the same way.
          # maxDepth is left unset on purpose: it resolves from the Host
          # subagent.maxDepth setting, which is what decides how many levels exist.
          # Raising it deepens the tree; setting it to 0 disables delegation and
          # breaks this preset's design.
          - id: delegation
            name: cordis:group
            group: true
            isolate:
              workflowEngine: true
            config:
              - id: tool-subagent-control
                name: '@deepseek-ai/dsh-tool-subagent-control'
              - id: tool-subagent-list-agents
                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent
                  modelSelectionSettings: true
                  agentPreset: root-planner-worker
              - id: tool-subagent-fork
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: fork
                  toolName: subagent_fork
                  # No agentPreset, on purpose. The fork provider declares
                  # inheritsParentContext true and agentPreset false, and configuring a
                  # preset for it makes the row throw at activation — which is exactly how
                  # the first attempt at this migration made the whole preset fail to load.
                  # A forked child inherits its parent's preset: from a worker that is
                  # still the worker preset, from the root it is the root preset.
              - id: tool-subagent-codex
                name: '@deepseek-ai/dsh-tool-subagent'
                disabled: true
                config:
                  provider: codex
                  toolName: subagent_codex
                  backgroundMode: one-shot
                  maxDepth: provider-managed
              - id: tool-subagent-claude-code
                name: '@deepseek-ai/dsh-tool-subagent'
                disabled: true
                config:
                  provider: claude-code
                  toolName: subagent_claude_code
                  backgroundMode: one-shot
                  maxDepth: provider-managed
              - id: workflow-ptc
                name: '@deepseek-ai/dsh-workflow-ptc'
                config:
                  provider: spawn
              - id: tool-workflow
                name: '@deepseek-ai/dsh-tool-workflow'
              - id: tool-ralph
                name: '@deepseek-ai/dsh-tool-ralph'
                disabled: true
                config:
                  subagentProvider: spawn
                  maxRounds: 64
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: true
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000
          - id: present
            name: '@deepseek-ai/dsh-tool-present'
          - id: tool-plugin-manager
            name: '@deepseek-ai/dsh-plugin-manager/tools'
            disabled: true`

/** Render the shared rows, optionally with the deep-creation additions. */
function rootRows(cordis) {
  // The placeholders sit at the start of a line whose newline belongs to the preceding
  // row, so each insertion carries its own trailing newline; without it the next row is
  // glued onto the last inserted line and the YAML stops parsing.
  return ROOT_ROWS
    .replace('__CORDIS_ROWS__', cordis ? `${CORDIS_EXTRA_ROWS}\n` : '')
    .replace('__SKILL_DIRS__', cordis ? `${CORDIS_SKILL_DIRS}\n` : '')
}

const patch = `# Generated by build-patch.mjs from persona.txt. Do not hand-edit:
# edit persona.txt and re-run the generator.

# The root-planner preset. It mirrors the shipped standard preset's tool list
# so behavior differs only where this design intends it to, and it declares no
# persona line on a delegation tool: the child must inherit this same
# persona, because the persona itself carries the subagent rules.
- insert:
    - id: preset-root-planner
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: root-planner
        name: Root Planner
        description: Keeps the plan and the decisions in the root agent, dispatches reading, edits and commands to subagent workers, and lets nothing outlive the task.
        order: 5
        plugins:
${rootRows(false)}

# The worker preset. DSH 0.2.1 removed toolFilter from the delegation tool — its own
# error says to configure persona and tool plugins in an Agent Preset and select it with
# agentPreset (spawn only) — so a curated child toolset is now expressed as a preset
# rather than as a mask on the spawn call. Measured on 0.2.1-rc.2 before this change: the
# mask was stripped silently and children arrived with all 39 tools and the platform's
# default persona instead of this preset's.
#
# The worker preset carries the same persona (it addresses both roles) and only the tool
# plugins a worker needs. What the worker can call is decided HERE, by which rows exist:
# in 0.2.1 a preset's rows register their tools per agent scope, and tools.restrict()
# filters GLOBAL tools only — "restrictions intersect; scoped registrations remain
# visible". A restriction therefore cannot narrow a preset's own tools, which is why an
# earlier attempt on this branch mounted a mask row and failed with
#   tools.restrict() names unknown global tools "read", "glob", "write", ...
#   known global tools: ops_glob, ops_grep, ops_inspect_local_file, ops_replace,
#                       working_directory
# That short list is the whole set of globally mounted tools on this machine; every other
# tool a worker sees comes from a row below. So the curated set is the row list itself,
# and omitting a row really does remove its tools.
- insert:
    - id: preset-root-planner-worker
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: root-planner-worker
        name: Root Planner Worker
        description: The worker half of the Root Planner preset — read, write and run commands inside its own _agents/ workspace, and never leave anything running. Spawned by the root; not a preset to pick by hand.
        order: 6
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: Your working directory is the session workspace; call the working_directory tool to read its absolute path when you need it.
              prefix: |-
<PERSONA>
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
            # Same process bound as the root preset: the worker gets a shell, and the
            # shell cannot detach anything.
            config:
              enableRunInBackground: false
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
          - id: command-goal
            name: '@deepseek-ai/dsh-command-goal'
          - id: tool-goal
            name: '@deepseek-ai/dsh-tool-goal'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
          # The worker delegates too, and its children are workers as well, so the depth
          # limit stays the only thing that ends the tree.
          - id: delegation
            name: cordis:group
            group: true
            config:
              - id: tool-subagent-control
                name: '@deepseek-ai/dsh-tool-subagent-control'
              - id: tool-subagent-list-agents
                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent
                  modelSelectionSettings: true
                  agentPreset: root-planner-worker
              - id: tool-subagent-fork
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: fork
                  toolName: subagent_fork
                  # Inherits its parent's preset; see the note on the root preset's fork row.
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: true
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000

# The workspace fence travels in the same package, but as a SIBLING entry rather than a
# row inside the preset above. A preset row is mounted per agent, and measured against a
# live session that mount never took effect: six probe steps (write outside, .. escape,
# shell without workdir, shell absolute path, plus the two allowed controls) all came
# back allowed. As a profile-level entry — the shape the standalone guard bundle was
# proved in — one instance sees every call and decides from the calling agent's session
# header, which is all this guard needs. Shipping it here still means one install carries
# the protocol and its enforcement together.
- insert:
    - id: root-planner-guard
      name: 'dsh-root-planner-preset/guard'
      config:
        directoryName: _agents
        guardShell: true
`;

// Substitution happens after the template so the emitted indentation is owned by
// blockScalar/allowList rather than by the whitespace in this file.
const deepCreationPreset = `

# 深度创造 (deep creation): the planner preset plus the two things plugin work needs and
# this bundle otherwise omits — runtime inspection (cordis_inspect_*) and the Cordis
# development skills. It is a separate preset rather than extra rows on the planner on
# purpose: inspection mounts host services, and a session that only plans and delegates
# should not carry that surface.
- insert:
    - id: preset-root-planner-cordis
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: root-planner-cordis
        name: 深度创造
        description: For complex plugin work — the planner preset plus runtime inspection and the Cordis development skills, dispatching edits and research to the same fenced workers.
        order: 7
        plugins:
${rootRows(true)}`

const rendered = (patch + deepCreationPreset).replaceAll('<PERSONA>', blockScalar(persona, 16));

if (rendered.includes('<PERSONA>') || rendered.includes('<MASK>')) {
  throw new Error('a placeholder survived substitution');
}
// Structural checks on the emitted text. A literal "N spaces" assertion is
// fragile against editor whitespace handling, so indentation is measured.
const maskBlocks = [...rendered.matchAll(/^([ ]+)allow:\n([ ]+)- read\n/gm)];
if (maskBlocks.length !== 0) {
  throw new Error(
    `found ${maskBlocks.length} toolFilter allow block(s): DSH 0.2.1 removed toolFilter from the delegation tool and strips it silently, so a mask here would do nothing`,
  );
}
const personaBlock = rendered.match(/^([ ]+)prefix: \|-\n/gm);
if (personaBlock === null || personaBlock.length !== 3) {
  throw new Error(`expected 3 persona block scalars (planner + worker + deep creation), found ${personaBlock?.length ?? 0}`);
}

writeFileSync(join(here, 'cordis.patch.yml'), rendered, 'utf8');
process.stdout.write(`wrote cordis.patch.yml (persona ${persona.length} chars, ${persona.split('\n').length} lines)\n`);
