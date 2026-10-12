# AI-DLC translated to Kiro Workflows

This directory holds the AI-DLC workflow graph expressed as [Kiro Workflows](https://kiro.dev/docs/workflows/)
recipes — one `*.workflow.json` per AI-DLC scope — plus the generator that produced
them from the authored AI-DLC sources.

## Where the AI-DLC workflow is defined

AI-DLC does not keep its workflow in one file. The definition is distributed across
four authored surfaces, all under `core/`:

| What | Where | Role |
|---|---|---|
| **Stage definitions** | `core/aidlc-common/stages/<phase>/<slug>.md` | 33 stage files. The YAML frontmatter of each file is the authoritative node declaration: `phase`, `execution`, `lead_agent`, `support_agents`, `mode`, `reviewer`, `review_artifact`, `review_class`, `reviewer_max_iterations`, `summary_confirmation`, `for_each`, `workspace_requires`, `produces`, `consumes`, `requires_stage`, `scopes`. The Markdown body under `## Steps` is the stage's executable instruction. |
| **The frontmatter contract** | `core/aidlc-common/protocols/stage-definition.md` | Field-by-field schema for the above, including which fields are authored and which are computed. |
| **Runtime behaviour** | `core/aidlc-common/protocols/stage-protocol*.md` | Approval gates, question flow, reviewer invocation (§12a), the collaboration modes, recovery, learnings. These are the semantics a stage body assumes. |
| **Scopes** | `core/scopes/aidlc-<scope>.md` | 11 scopes. A stage's `scopes:` list marks it EXECUTE under those scopes; absence marks SKIP. Scope frontmatter also carries depth and ceremony settings. |

Two compiled artifacts are generated from those sources by `aidlc-graph compile`
(run as part of `bun scripts/package.ts`) and are what the engine and this
generator read:

- `dist/<harness>/.kiro/tools/data/stage-graph.json` — the 33 nodes with computed
  `display_order` (`number`), resolved sensors, and rules-in-context.
- `dist/<harness>/.kiro/tools/data/scope-grid.json` — the EXECUTE/SKIP matrix,
  scope × stage.

The phase order is fixed: `initialization` (0.x) → `ideation` (1.x) →
`inception` (2.x) → `construction` (3.x) → `operation` (4.x).

## What this directory contains

```
kiro-workflows/
  generate.ts                            translator (bun), deterministic
  workflows/aidlc-<scope>.workflow.json  11 recipes
```

| Recipe | Stages on path | Step nodes |
|---|---:|---:|
| `aidlc-enterprise` | 33/33 | 46 |
| `aidlc-feature` | 33/33 | 46 |
| `aidlc-workshop` | 26/33 | 37 |
| `aidlc-mvp` | 23/33 | 36 |
| `aidlc-classic` | 18/33 | 29 |
| `aidlc-infra` | 13/33 | 17 |
| `aidlc-refactor` | 10/33 | 13 |
| `aidlc-security-patch` | 10/33 | 13 |
| `aidlc-express` | 10/33 | 12 |
| `aidlc-bugfix` | 9/33 | 11 |
| `aidlc-poc` | 8/33 | 11 |

Kiro caps a recipe at 50 `step` nodes and 8 nesting levels. The largest recipe
uses 46 steps and 4 levels, so every scope fits with headroom. Container nodes
(`sequence`, `repeat`) do not count against the step budget, which is why every
stage can afford its own gate loop.

## How the translation maps

| AI-DLC | Kiro Workflows |
|---|---|
| Phase | `sequence` node `phase-<phase>` |
| Stage | `step` node with `id: <slug>` |
| `lead_agent` | the step's `agent`. `orchestrator` has no workflow-agent equivalent, so the three initialization stages use the bundled `wf-coder` |
| `produces[]` | `artifacts` map → `{{run_dir}}/<phase>/<slug>/<name>.md` (`.json` where the stage's `outputs:` names a `.json` file) |
| `consumes[]` | `{{artifacts.<name>}}` references, resolved to the latest producer that runs earlier **on this scope's path** |
| a required `consumes[]` whose producer is off the scope's path | named in the prompt as an expected gap (AI-DLC's `consumes_absent` with `expected: true`), with instructions to degrade gracefully |
| `mode` (`inline`, `subagent`, `pipeline`, `mob`) | prose in the step prompt describing the topology, the support personas, and where contribution files go. Kiro has no topology primitive; the step agent owns it |
| `reviewer` + `review_artifact` | a second `step` node `<slug>-review` with the reviewer agent, reading only the named artifact and writing `review.json` |
| `review_class: adversarial` / `advisory` | the reviewer's instruction to withhold or merely record approval. Both classes still gate on the person |
| human approval gate (`stage-protocol.md` §2) | a `repeat` node `<slug>-gate-loop` whose `stopCondition` is a `fileCheck` on `gate.json` → `decision == "approved"`. The step presents the gate with `send_message` severity `warning` and records the person's decision in that file |
| `summary_confirmation` | a pre-artifact `send_message` severity `warning` checkpoint requiring the exact reply `Looks correct` |
| 3 change-request cycles then "Accept as-is" | `maxIterations: 3` (+ the reviewer budget on reviewed stages), `onMaxIterations: "pause"` |
| `for_each: unit-of-work` | a `repeat` node `<slug>-per-unit` gated on `units-status.json` → `remaining == 0`, with the step owning unit selection |
| `workspace_requires: true` | an explicit instruction that Markdown alone does not complete the stage |
| `sensors[]` | named in the prompt as advisory checks to run and report at the gate |

### The gate is a file, not a sentence

AI-DLC's core tenet is that the tools own control state and the human owns
judgement. Kiro's only enforceable loop condition is `fileCheck`, so each stage's
gate loop exits on a recorded decision in `gate.json` rather than on an agent
saying it is done. A change request is written back as
`{"decision": "changes-requested", "feedback": "<their words>"}`, the loop runs
the stage again, and the step is told to revise from that feedback rather than
restart. On a reviewed stage the reviewer step presents the gate, because it is
the last node of the stage; it still may not edit any artifact.

## Known divergences

These are places where Kiro Workflows cannot express an AI-DLC mechanism, so the
translation approximates it. Each is a deliberate choice, not an oversight.

1. **No engine, no receipts.** AI-DLC's audit chain, tokens, part counts, guard
   hooks, and plan-approval fingerprints are enforced by `aidlc-*.ts` tools and
   hooks. A Kiro recipe has no equivalent, so these recipes carry the *shape* of
   the workflow and the human gates, not the deterministic receipts behind them.
   A guard that cannot be enforced is stated as an instruction, which is weaker.
2. **`for_each` has no loop variable.** Kiro repeats cannot parameterize a node
   per item, so per-unit stages iterate through a step-managed
   `units-status.json` and keep durable per-unit copies under
   `<stage-dir>/units/<unit-id>/`. The registered artifact path is the current
   unit's handoff, and `gate.json` carries a `unit` field so a decision is
   attributable.
3. **Collaboration modes become prose.** `subagent`, `pipeline`, and `mob` are
   topologies the AI-DLC conductor enforces through dispatch and receipts. Here
   they are instructions to the step agent, which may use sub-agents when its own
   configuration permits. Nested sub-agents are not workflow nodes and cannot
   signal the parent step.
4. **The reviewer presents the gate.** In AI-DLC the conductor presents the
   approval question and the reviewer never does. Keeping that separation would
   need a third step node per reviewed stage, which pushes the full-lifecycle
   scopes past Kiro's 50-step cap, so the reviewer step presents the gate on the
   conductor's behalf.
5. **One cap for two budgets.** `reviewer_max_iterations` and the human's
   change-request cycles share a single `maxIterations` on the gate loop.
6. **CodeKB is space-level.** `reverse-engineering` writes to
   `aidlc/spaces/<space>/codekb/<repo>/` in AI-DLC, outside any single intent
   record, so its artifacts route to a separate `codekb_dir` input rather than
   `run_dir`.
7. **Scope ceremony settings are not translated.** `guard_policy`, `sensors`,
   `learnings`, `plan_approval`, and depth live in scope and memory layers the
   engine reads at runtime. Only the stage membership and the depth label survive
   into the recipe description.
8. **Stage bodies are referenced, not inlined.** Each prompt points at
   `.kiro/aidlc-common/stages/<phase>/<slug>.md` as authoritative, with a
   generated summary as the fallback. This keeps the stage files the single source
   of truth; it also means a recipe run in a workspace without an AI-DLC install
   gets the summary only.

## Using the recipes

Workflows are opt-in per client — see [Turn it on](https://kiro.dev/docs/workflows.md).
Then:

```sh
# Project-scoped recipes
mkdir -p .kiro/workflows && cp kiro-workflows/workflows/*.workflow.json .kiro/workflows/

# CLI launch
/workflow run aidlc-poc --intent "Prove that X is feasible" --run_dir aidlc/spaces/default/intents/260407-x
```

`run_dir` must be inside an allowed workspace root — every artifact path and
`fileCheck` in these recipes resolves under it, and a `fileCheck` outside the
workspace fails its node. Give concurrent runs different `run_dir` values.

The step agents are the AI-DLC custom agents (`aidlc-product-agent`,
`aidlc-architect-agent`, …), so an AI-DLC install must be present in the
workspace for a recipe to resolve its agents. Those agents auto-approve writes
only under `aidlc/spaces/**`; a stage that writes source code (`code-generation`)
will prompt for approval outside that tree.

**Validate before relying on one.** Kiro's own validator catches load-time
constraints the generator does not model:

```text
Run `validate_workflow` on `.kiro/workflows/aidlc-poc.workflow.json`. Report every
error and warning, and do not launch the Workflow.
```

A passing validation does not prove a run can start: the standalone validator
cannot check that a custom-agent name resolves.

## Regenerating

```sh
bun scripts/package.ts                  # produces the compiled graph + grid
bun kiro-workflows/generate.ts          # writes workflows/
bun kiro-workflows/generate.ts --check  # fails on drift
```

The generator reads `dist/kiro/.kiro/tools/data/{stage-graph,scope-grid}.json` by
default; override with `--graph`, `--grid`, and `--out`. Before writing, it
enforces Kiro's documented limits — 50 step nodes, 8 nesting levels, unique node
IDs — and the happens-before rule for structured templates, so no
`{{artifacts.x}}` reference can point at a producer that has not run.
