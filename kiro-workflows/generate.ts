#!/usr/bin/env bun
/**
 * Translate the AI-DLC workflow definition into Kiro Workflows recipes.
 *
 * Source of truth (AI-DLC side):
 *   - core/aidlc-common/stages/<phase>/<slug>.md   YAML frontmatter per stage
 *     (authoritative; contract in core/aidlc-common/protocols/stage-definition.md)
 *   - tools/data/stage-graph.json                  compiled stage graph
 *   - tools/data/scope-grid.json                   EXECUTE/SKIP per scope
 *   - core/scopes/aidlc-<scope>.md                 scope frontmatter
 *
 * Target (Kiro side): https://kiro.dev/docs/workflows/authoring.md
 *   one `*.workflow.json` recipe per AI-DLC scope, written to ./workflows/
 *
 * Usage:
 *   bun kiro-workflows/generate.ts                       # uses dist/kiro/.kiro/tools/data
 *   bun kiro-workflows/generate.ts --graph G --grid R    # explicit inputs
 *   bun kiro-workflows/generate.ts --out DIR
 *   bun kiro-workflows/generate.ts --check               # fail if output would change
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// ---------------------------------------------------------------- AI-DLC side

interface Consume {
  artifact: string;
  required: boolean;
  conditional_on?: string;
}

interface StageNode {
  slug: string;
  number: string;
  name: string;
  phase: string;
  execution: string;
  condition: string;
  lead_agent: string;
  support_agents: string[];
  mode: string;
  for_each?: string;
  workspace_requires?: boolean;
  summary_confirmation?: string;
  produces: string[];
  optional_produces?: string[];
  consumes: Consume[];
  requires_stage: string[];
  reviewer?: string;
  review_artifact?: string;
  reviewer_max_iterations?: number;
  review_class?: string;
  sensors?: string[];
  inputs: string;
  outputs: string;
}

type ScopeGrid = Record<string, { stages: Record<string, 'EXECUTE' | 'SKIP'> }>;

const PHASES = ['initialization', 'ideation', 'inception', 'construction', 'operation'] as const;

/** AI-DLC stage leads are custom agents shipped by the install; `orchestrator` is the
 *  conductor itself, which has no workflow-agent equivalent, so it maps to a bundled one. */
const AGENT_MAP: Record<string, string> = { orchestrator: 'wf-coder' };

const PER_UNIT_MAX_ITERATIONS = 12;

/** AI-DLC's human gate allows 3 change-request cycles before "Accept as-is"; a reviewed
 *  stage spends its reviewer budget inside the same Kiro repeat. */
const HUMAN_GATE_CYCLES = 3;

/** CodeKB is space-level in AI-DLC, shared across intents, not under the intent record. */
const DIR_OVERRIDE: Record<string, string> = { 'reverse-engineering': '{{codekb_dir}}' };

// ---------------------------------------------------------------- Kiro side

interface KiroStep {
  type: 'step';
  id: string;
  agent: string;
  prompt: string;
  artifacts?: Record<string, string>;
}

interface KiroSequence {
  type: 'sequence';
  id: string;
  steps: KiroNode[];
}

interface KiroRepeat {
  type: 'repeat';
  id: string;
  maxIterations: number;
  onMaxIterations: 'abort' | 'continue' | 'pause';
  stopCondition?: {
    fileCheck?: { path: string; jsonPath: string; value: unknown };
    containsText?: string;
    completionSignal?: string;
  };
  steps: KiroNode[];
}

type KiroNode = KiroStep | KiroSequence | KiroRepeat;

interface KiroRecipe {
  name: string;
  description: string;
  inputs: Record<string, string>;
  steps: KiroNode[];
}

const MAX_STEPS = 50;
const MAX_DEPTH = 8;

// ---------------------------------------------------------------- helpers

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Artifact logical keys are template identifiers: `{{artifacts.unit_of_work}}`. */
function key(name: string): string {
  return name.replace(/-/g, '_');
}

/** `traceability` is JSON, every other declared artifact is Markdown. The stage's
 *  `outputs:` prose names the real filenames, so read the extension from there. */
function extensionFor(stage: StageNode, artifact: string): string {
  return new RegExp(`\\b${artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.json\\b`).test(
    stage.outputs,
  )
    ? 'json'
    : 'md';
}

function stageDir(stage: StageNode): string {
  return DIR_OVERRIDE[stage.slug] ?? `{{run_dir}}/${stage.phase}/${stage.slug}`;
}

function artifactPath(stage: StageNode, artifact: string): string {
  return `${stageDir(stage)}/${artifact}.${extensionFor(stage, artifact)}`;
}

function reviewPath(stage: StageNode): string {
  return `{{run_dir}}/${stage.phase}/${stage.slug}/review.json`;
}

function gatePath(stage: StageNode): string {
  return `{{run_dir}}/${stage.phase}/${stage.slug}/gate.json`;
}

function agentFor(slug: string): string {
  return AGENT_MAP[slug] ?? slug;
}

function countSteps(nodes: KiroNode[]): number {
  return nodes.reduce(
    (n, node) => n + (node.type === 'step' ? 1 : countSteps(node.steps)),
    0,
  );
}

function maxDepth(nodes: KiroNode[], depth = 1): number {
  return nodes.reduce(
    (d, node) => Math.max(d, node.type === 'step' ? depth : maxDepth(node.steps, depth + 1)),
    depth,
  );
}

function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const f = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (f?.[2].trim()) out[f[1]] = f[2].trim();
  }
  return out;
}

// ---------------------------------------------------------------- prompts

function modeNote(stage: StageNode): string {
  const supports = stage.support_agents.join(', ');
  const contributions = `${stageDir(stage)}/contributions/<agent-slug>.md`;
  switch (stage.mode) {
    case 'inline':
      return supports
        ? `Collaboration (AI-DLC mode \`inline\`): adopt the lead voice and the supporting voices (${supports}) yourself. Do not dispatch sub-agents for this stage.`
        : 'Collaboration (AI-DLC mode `inline`): do the work yourself. Do not dispatch sub-agents for this stage.';
    case 'subagent':
      return `Collaboration (AI-DLC mode \`subagent\`, hub-and-spoke): draft as the lead, then consult each support persona as a mutually blind sub-agent (${supports || 'none declared — draft and integrate alone'}). Each support persona writes its own contribution to \`${contributions}\`; you alone edit the artifacts listed below.`;
    case 'pipeline':
      return `Collaboration (AI-DLC mode \`pipeline\`, serialized chain): ${[stage.lead_agent, ...stage.support_agents].join(' -> ')}. Each link sees all upstream work and advances the artifacts directly; record each link's handoff under \`${stageDir(stage)}/contributions/\` before the next link starts.`;
    case 'mob':
      return `Collaboration (AI-DLC mode \`mob\`, mesh): run one room with ${supports}. Allow cross-talk, record dissent in \`${contributions}\`, and surface any judgement-call objection to the person mid-stage with send_message severity warning rather than resolving it yourself.`;
    default:
      return `Collaboration (AI-DLC mode \`${stage.mode}\`): not implemented by this translation. Stop and report with send_message severity error.`;
  }
}

function gateBlock(stage: StageNode, presenter: 'stage' | 'reviewer'): string {
  const lines = [
    'Human gate (AI-DLC `stage-protocol.md` section 2). This stage does not end on your own judgement:',
  ];
  if (presenter === 'reviewer') {
    lines.push(
      `1. Present the review brief and then the approval question with send_message severity \`warning\`: the stage name, the artifact paths, your verdict, and the open findings.`,
    );
  } else {
    lines.push(
      `1. Present the completion message with send_message severity \`warning\`: the stage name, a 5-10 line table of the artifacts you produced and their top-level contents, and the artifact paths.`,
    );
  }
  lines.push(
    '2. Stop there and wait for the person. Do not decide for them and do not infer approval from silence.',
    `3. Record their decision in \`${gatePath(stage)}\` — this file, not your prose, is what ends the stage:`,
    '```json',
    '{ "decision": "approved", "feedback": "<their words>", "cycle": 1 }',
    '```',
    '   Use `"approved"` only for an explicit approval (or an explicit "Accept as-is"). For a change request use `"changes-requested"` with their exact words as `feedback`; the stage then runs again and revises from that feedback.',
    ...(stage.for_each
      ? ['   Include `"unit": "<unit-id>"` so the decision is attributable to the unit you worked on.']
      : []),
    '4. Finish with send_message severity `success` and a one-line outcome once the decision is written.',
  );
  return lines.join('\n');
}

function revisionBlock(stage: StageNode): string {
  return [
    `Revision entry: read \`${gatePath(stage)}\` first. If it exists and records \`"changes-requested"\`, you are in a revision cycle — revise the existing artifacts from the recorded \`feedback\` rather than rewriting them from scratch, and increment \`cycle\` when you record the next decision. If the file is absent, this is the first pass.`,
  ].join('\n');
}

function stagePrompt(
  stage: StageNode,
  scope: string,
  upstream: { artifact: string; path: string; required: boolean }[],
  absent: string[],
  perUnit: boolean,
  reviewed: boolean,
): string {
  const lines: string[] = [];

  lines.push(
    `AI-DLC stage ${stage.number} ${stage.name} — phase \`${stage.phase}\`, scope \`${scope}\`.`,
    '',
    'Intent for this run: {{intent}}',
    '',
    `Authoritative contract: read \`.kiro/aidlc-common/stages/${stage.phase}/${stage.slug}.md\` and follow its \`## Steps\` section exactly, together with \`.kiro/aidlc-common/protocols/stage-protocol.md\`. If those files are absent from this workspace, apply the summary below instead and say in one line that you did.`,
    '',
    `Condition: ${stage.condition}`,
    `Declared inputs: ${stage.inputs}`,
    `Declared outputs: ${stage.outputs}`,
    '',
    revisionBlock(stage),
    '',
  );

  if (upstream.length) {
    lines.push('Read these upstream artifacts before you start:');
    for (const u of upstream) {
      lines.push(`- ${u.artifact}${u.required ? '' : ' (optional)'}: ${u.path}`);
    }
    lines.push('An optional input that does not exist is not an input — proceed without it.', '');
  } else {
    lines.push(
      "No upstream AI-DLC artifacts on this scope's path: work from the intent and the repository.",
      '',
    );
  }

  if (absent.length) {
    lines.push(
      `Declared inputs whose producing stage is off the \`${scope}\` path, so they will not exist: ${absent.join(', ')}. This absence is by design — degrade gracefully, infer what you need from the intent and the repository, and record the gap in your artifacts rather than blocking on it.`,
      '',
    );
  }

  if (stage.produces.length) {
    lines.push('Write exactly these artifacts:');
    for (const a of stage.produces) {
      const optional = stage.optional_produces?.includes(a);
      lines.push(`- ${artifactPath(stage, a)}${optional ? ' (only when applicable)' : ''}`);
    }
    lines.push('');
  } else {
    lines.push(
      'This stage produces no document artifacts; its effect is on the workspace and the run record.',
      '',
    );
  }

  if (perUnit) {
    lines.push(
      `Per-unit execution (AI-DLC \`for_each: ${stage.for_each}\`). Kiro repeats have no loop variable, so this step owns the iteration:`,
      `1. Read \`{{run_dir}}/construction/units-status.json\`. Create it on the first iteration from the units of work in {{artifacts.unit_of_work}}, as \`{"units": [{"id": "...", "stages": {}}], "remaining": <n>}\`.`,
      '2. Pick the first unit whose entry does not record this stage as done. Work that one unit only.',
      `3. Write the artifacts above for the current unit, and keep a durable per-unit copy under \`${stageDir(stage)}/units/<unit-id>/\`.`,
      '4. Mark this stage done for that unit, recompute `remaining` as the number of units still missing this stage, and write the file back before you finish.',
      `5. The gate file \`${gatePath(stage)}\` is shared across units, so record \`"unit": "<unit-id>"\` in it. A decision recorded for a different unit is not a decision about this one: treat it as absent.`,
      '',
    );
  }

  lines.push(modeNote(stage), '');

  if (stage.summary_confirmation) {
    lines.push(
      `Answer review (AI-DLC \`summary_confirmation: ${stage.summary_confirmation}\`): before writing any artifact, write the stage questions file, present the consolidated answers with send_message severity \`warning\`, and wait for the exact reply \`Looks correct\`. Treat anything else as a correction to apply before you continue.`,
      '',
    );
  }

  if (stage.sensors?.length) {
    lines.push(
      `Sensors declared for this stage (advisory): ${stage.sensors.join(', ')}. Run the matching checks under \`.kiro/sensors/\` when they exist and report findings at the gate.`,
      '',
    );
  }

  if (stage.workspace_requires) {
    lines.push(
      'This stage must write real source code to the workspace, not only planning documents. A pass that produced only Markdown has not completed this stage.',
      '',
    );
  }

  if (reviewed) {
    lines.push(
      `An independent reviewer runs after you and owns the human gate for this stage. Do not present the gate yourself and do not write \`${gatePath(stage)}\`. Finish with send_message severity \`success\` and a one-line summary of what you produced.`,
    );
  } else {
    lines.push(gateBlock(stage, 'stage'));
  }

  return lines.join('\n');
}

function reviewerPrompt(stage: StageNode, reviewArtifactPath: string): string {
  const adversarial = (stage.review_class ?? 'adversarial') === 'adversarial';
  return [
    `Independent review and human gate for AI-DLC stage ${stage.number} ${stage.name}. Review class: \`${stage.review_class ?? 'adversarial'}\`.`,
    '',
    'Follow `.kiro/aidlc-common/protocols/stage-protocol-reviewer.md` section 12a.',
    '',
    `Review this artifact and nothing else: ${reviewArtifactPath}`,
    "You did not write it and you must not edit it, or any other artifact of the stage. You judge the artifact, not the author's reasoning — you cannot see that session.",
    '',
    `Write your verdict to ${reviewPath(stage)} as JSON:`,
    '```json',
    '{',
    '  "verdict": "APPROVED",',
    '  "artifact": "<artifact under review>",',
    '  "findings": [',
    '    { "id": "R-01", "severity": "blocking|major|minor", "finding": "...", "recommendation": "..." }',
    '  ]',
    '}',
    '```',
    adversarial
      ? 'Use `REVISE` while any blocking or major finding stands. Never approve to let the run proceed.'
      : 'This review is advisory: your verdict informs the person, it does not decide for them. Record findings honestly either way.',
    '',
    gateBlock(stage, 'reviewer'),
  ].join('\n');
}

// ---------------------------------------------------------------- translation

function buildRecipe(
  scope: string,
  scopeMeta: Record<string, string>,
  graph: StageNode[],
  grid: ScopeGrid,
): KiroRecipe {
  const ordered = [...graph].sort((a, b) => {
    const [ap, as] = a.number.split('.').map(Number);
    const [bp, bs] = b.number.split('.').map(Number);
    return ap - bp || as - bs;
  });

  const onPath = ordered.filter((s) => grid[scope].stages[s.slug] === 'EXECUTE');
  const onPathSlugs = new Set(onPath.map((s) => s.slug));
  const unitsOnPath = onPathSlugs.has('units-generation');

  // Artifact name -> logical key. Namespace only when several executing stages
  // produce the same artifact name, so prompts stay readable.
  const producers = new Map<string, StageNode[]>();
  for (const s of onPath) {
    for (const a of [...s.produces]) {
      producers.set(a, [...(producers.get(a) ?? []), s]);
    }
  }
  const logicalKey = (stage: StageNode, artifact: string): string =>
    (producers.get(artifact)?.length ?? 0) > 1
      ? key(`${artifact}_from_${stage.slug}`)
      : key(artifact);

  const position = new Map(onPath.map((s, i) => [s.slug, i]));

  const phaseNodes: KiroNode[] = [];

  for (const phase of PHASES) {
    const stages = onPath.filter((s) => s.phase === phase);
    if (!stages.length) continue;

    const children: KiroNode[] = [];

    for (const stage of stages) {
      // Resolve consumed artifacts to artifact templates whose producer runs earlier.
      const upstream: { artifact: string; path: string; required: boolean }[] = [];
      const absent: string[] = [];
      for (const c of stage.consumes) {
        const candidates = (producers.get(c.artifact) ?? []).filter(
          (p) => (position.get(p.slug) ?? -1) < (position.get(stage.slug) ?? -1),
        );
        const producer = candidates[candidates.length - 1];
        if (!producer) {
          // Required-but-unproducible is AI-DLC's `consumes_absent` with `expected: true`:
          // the producing stage is off this scope's path. Optional absence is simply dropped.
          if (c.required) absent.push(c.artifact);
          continue;
        }
        upstream.push({
          artifact: c.artifact,
          path: `{{artifacts.${logicalKey(producer, c.artifact)}}}`,
          required: c.required,
        });
      }

      const perUnit = Boolean(stage.for_each) && unitsOnPath;
      const reviewed = Boolean(stage.reviewer && stage.review_artifact);

      const artifacts: Record<string, string> = {};
      for (const a of stage.produces) {
        artifacts[logicalKey(stage, a)] = artifactPath(stage, a);
      }

      const stageStep: KiroStep = {
        type: 'step',
        id: stage.slug,
        agent: agentFor(stage.lead_agent),
        prompt: stagePrompt(stage, scope, upstream, absent, perUnit, reviewed),
        ...(Object.keys(artifacts).length ? { artifacts } : {}),
      };

      const body: KiroNode[] = [stageStep];

      if (reviewed) {
        body.push({
          type: 'step',
          id: `${stage.slug}-review`,
          agent: agentFor(stage.reviewer as string),
          prompt: reviewerPrompt(stage, artifactPath(stage, stage.review_artifact as string)),
          artifacts: {
            [key(`${stage.slug}_review`)]: reviewPath(stage),
            [key(`${stage.slug}_gate`)]: gatePath(stage),
          },
        });
      }

      // Every stage gets its own gate loop. The loop ends on the person's recorded
      // decision, never on an agent's prose claim; a change request runs the stage
      // again with that feedback. Container nodes cost no step budget.
      let node: KiroNode = {
        type: 'repeat',
        id: `${stage.slug}-gate-loop`,
        maxIterations: HUMAN_GATE_CYCLES + (reviewed ? stage.reviewer_max_iterations ?? 2 : 0),
        onMaxIterations: 'pause',
        stopCondition: {
          fileCheck: { path: gatePath(stage), jsonPath: 'decision', value: 'approved' },
        },
        steps: body,
      };

      if (perUnit) {
        node = {
          type: 'repeat',
          id: `${stage.slug}-per-unit`,
          maxIterations: PER_UNIT_MAX_ITERATIONS,
          onMaxIterations: 'pause',
          stopCondition: {
            fileCheck: {
              path: '{{run_dir}}/construction/units-status.json',
              jsonPath: 'remaining',
              value: 0,
            },
          },
          steps: [node],
        };
      }

      children.push(node);
    }

    phaseNodes.push({ type: 'sequence', id: `phase-${phase}`, steps: children });
  }

  const depth = scopeMeta.depth ?? 'Standard';
  const needsCodeKb = onPathSlugs.has('reverse-engineering');
  return {
    name: `aidlc-${scope}`,
    description: `AI-DLC ${scope} scope translated to a Kiro workflow — ${scopeMeta.description ?? 'AI-DLC lifecycle'} (${depth} depth, ${onPath.length}/${graph.length} stages).`,
    inputs: {
      intent: 'prompt',
      run_dir: 'string',
      ...(needsCodeKb ? { codekb_dir: 'string' } : {}),
    },
    steps: phaseNodes,
  };
}

// ---------------------------------------------------------------- main

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const defaultData = join(repoRoot, 'dist/kiro/.kiro/tools/data');
const graphPath = arg('--graph') ?? join(defaultData, 'stage-graph.json');
const gridPath = arg('--grid') ?? join(defaultData, 'scope-grid.json');
const outDir = arg('--out') ?? join(repoRoot, 'kiro-workflows/workflows');
const check = process.argv.includes('--check');

for (const p of [graphPath, gridPath]) {
  if (!existsSync(p)) {
    console.error(
      `missing input: ${p}\nRun \`bun scripts/package.ts\` first, or pass --graph/--grid.`,
    );
    process.exit(1);
  }
}

const graph: StageNode[] = JSON.parse(readFileSync(graphPath, 'utf8'));
const grid: ScopeGrid = JSON.parse(readFileSync(gridPath, 'utf8'));

const scopeMetaDir = join(repoRoot, 'core/scopes');
const scopeMeta: Record<string, Record<string, string>> = {};
if (existsSync(scopeMetaDir)) {
  for (const f of readdirSync(scopeMetaDir)) {
    const m = /^aidlc-(.+)\.md$/.exec(f);
    if (m) scopeMeta[m[1]] = parseFrontmatter(readFileSync(join(scopeMetaDir, f), 'utf8'));
  }
}

mkdirSync(outDir, { recursive: true });

let drift = false;
const rows: string[] = [];

for (const scope of Object.keys(grid).sort()) {
  const recipe = buildRecipe(scope, scopeMeta[scope] ?? {}, graph, grid);
  const steps = countSteps(recipe.steps);
  const depth = maxDepth(recipe.steps);

  if (steps > MAX_STEPS) {
    console.error(`${recipe.name}: ${steps} steps exceeds Kiro's limit of ${MAX_STEPS}`);
    process.exit(1);
  }
  if (depth > MAX_DEPTH) {
    console.error(`${recipe.name}: nesting depth ${depth} exceeds Kiro's limit of ${MAX_DEPTH}`);
    process.exit(1);
  }

  const ids = new Set<string>();
  const walk = (nodes: KiroNode[]) => {
    for (const n of nodes) {
      if (ids.has(n.id)) {
        console.error(`${recipe.name}: duplicate node id ${n.id}`);
        process.exit(1);
      }
      ids.add(n.id);
      if (n.type !== 'step') walk(n.steps);
    }
  };
  walk(recipe.steps);

  // Happens-before check for structured templates: every `{{artifacts.X}}` must be
  // registered by a step that runs earlier in document order, and every bare
  // `{{x}}` must be a declared input. Kiro fails a step whose reference it cannot
  // resolve, so catch it here instead of mid-run.
  const flat: KiroStep[] = [];
  const flatten = (nodes: KiroNode[]) => {
    for (const n of nodes) (n.type === 'step' ? flat.push(n) : flatten(n.steps));
  };
  flatten(recipe.steps);

  const declared = new Set(Object.keys(recipe.inputs));
  const registered = new Set<string>();
  for (const step of flat) {
    const blob = `${step.prompt} ${JSON.stringify(step.artifacts ?? {})}`;
    for (const [, ref] of blob.matchAll(/\{\{([a-zA-Z0-9_.]+)\}\}/g)) {
      if (ref.startsWith('artifacts.')) {
        const k = ref.slice('artifacts.'.length);
        if (!registered.has(k)) {
          console.error(`${recipe.name}/${step.id}: artifact reference ${k} has no earlier producer`);
          process.exit(1);
        }
      } else if (!ref.includes('.') && !declared.has(ref)) {
        console.error(`${recipe.name}/${step.id}: undeclared input ${ref}`);
        process.exit(1);
      }
    }
    for (const k of Object.keys(step.artifacts ?? {})) registered.add(k);
  }

  const checkPaths = (nodes: KiroNode[]) => {
    for (const n of nodes) {
      const fc = n.type === 'repeat' ? n.stopCondition?.fileCheck : undefined;
      if (fc) {
        for (const [, ref] of fc.path.matchAll(/\{\{([a-zA-Z0-9_.]+)\}\}/g)) {
          if (!declared.has(ref)) {
            console.error(`${recipe.name}/${n.id}: fileCheck path uses ${ref}, which is not an input`);
            process.exit(1);
          }
        }
      }
      if (n.type !== 'step') checkPaths(n.steps);
    }
  };
  checkPaths(recipe.steps);

  const file = join(outDir, `aidlc-${scope}.workflow.json`);
  const text = `${JSON.stringify(recipe, null, 2)}\n`;

  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current !== text) {
      console.error(`drift: ${file}`);
      drift = true;
    }
  } else {
    writeFileSync(file, text);
  }

  rows.push(`  aidlc-${scope.padEnd(15)} ${String(steps).padStart(2)} steps  depth ${depth}  ${ids.size} nodes`);
}

console.log(`${check ? 'checked' : 'wrote'} ${rows.length} recipes in ${outDir}`);
console.log(rows.join('\n'));

if (drift) process.exit(1);
