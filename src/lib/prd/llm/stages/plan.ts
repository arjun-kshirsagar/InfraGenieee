/**
 * InfraGenie — Stage 3: the plan section (draft).
 *
 * SERVER-ONLY. Sees the brief, stage 1's PRD, and stage 2's architecture, then
 * breaks the work into milestones and small, independently-shippable tasks with
 * real acceptance criteria and a sane `dependsOn` graph.
 *
 * Returns milestones only. Assembly repairs the dependency graph and derives
 * `criticalPath`, `totalEstimateHours`, and `estimatedCalendarWeeks` — the
 * model never computes those.
 *
 * ## Why a stage-local validation schema
 * `planDraftSchema` enforces `milestones.min(3)` but NOT the ≥12 total-task
 * floor — that floor lives in a `superRefine` on `planSectionSchema`, which
 * only runs at final assembly. If we validated the draft with `planDraftSchema`
 * alone, a thin 6-task plan would pass here and then fail hard at assembly with
 * no chance for the one under-volume retry. So this stage validates against a
 * schema that ALSO carries the ≥12 floor as an array-min, making a thin plan an
 * extend-retryable under-volume miss exactly as intended.
 */

import { z } from 'zod';

import {
  milestoneSchema,
  planTaskSchema,
  MIN_MILESTONES,
  MIN_PLAN_TASKS,
  type ArchitectureSection,
  type Milestone,
  type PrdSection,
} from '@/types/prd';
import type { StageContext } from '@/lib/prd/generation';
import { formatBrief, runStage } from '@/lib/prd/llm/shared';

/** Plan can be the largest stage: an enterprise plan has many milestones and
 *  well over a dozen tasks, each with description + acceptance criteria. Keep
 *  generous headroom so a rich plan doesn't truncate into invalid_output. */
const PLAN_MAX_TOKENS = 16000;

/**
 * The plan stage's target: milestones (≥3) whose FLATTENED tasks number ≥12.
 * The `tasks` array on the sentinel milestone is a device: we expose the total
 * task count as an array-min so `runStage`'s under-volume detector can see it
 * and issue the one targeted "add more tasks" retry. The real per-milestone
 * tasks stay in `milestones`; the sentinel is stripped before returning.
 *
 * We can't put a total-count `.min()` directly on a nested flatMap in plain
 * zod, so instead we validate milestones with a superRefine that reports a
 * `too_small` array issue on the `milestones` path when the flattened count is
 * short. `runStage` treats that as under-volume.
 */
const planStageSchema = z
  .object({
    milestones: z.array(milestoneSchema).min(MIN_MILESTONES),
  })
  .superRefine((plan, ctx) => {
    const total = plan.milestones.flatMap((m) => m.tasks).length;
    if (total < MIN_PLAN_TASKS) {
      // Report as an array `too_small` on `milestones` so the under-volume
      // detector recognises it and the retry prompt asks for more tasks.
      ctx.addIssue({
        code: 'too_small',
        minimum: MIN_PLAN_TASKS,
        origin: 'array',
        inclusive: true,
        path: ['milestones'],
        input: plan.milestones,
        message: `Plan has ${total} tasks across its milestones; at least ${MIN_PLAN_TASKS} are required.`,
      });
    }
  });

type PlanStageOutput = z.infer<typeof planStageSchema>;

const SYSTEM_PROMPT = `You are a senior staff engineering lead breaking a product into an executable delivery plan. You are given the brief, the PRD (stage 1), and the architecture (stage 2). Another AI coding agent will pick up tasks from this plan and ship them, so each task must be small, concrete, and independently completable, with acceptance criteria a reviewer could check off.

## Hard requirements — rejected below any of these floors:
- milestones: at least ${MIN_MILESTONES}. Each: id, name, goal, and its tasks. Order them so earlier milestones unblock later ones. Let the brief's timeline shape how much lands in the first milestone.
- tasks (across all milestones): at least ${MIN_PLAN_TASKS} in total. Each task: id, title, description, area (frontend/backend/database/infra/design/qa), estimateHours (a realistic number, 0.5–200), dependsOn (ids of OTHER tasks in this plan — see below), and at least one acceptanceCriteria.

## The dependency graph — get this right
- \`dependsOn\` may reference ONLY the ids of OTHER tasks that appear in THIS response. Never reference a task id that doesn't exist here, never make a task depend on itself, and never create a cycle (if A depends on B, B must not — directly or transitively — depend on A).
- Model REAL ordering: schema/migrations before the endpoints that use them, backend endpoints before the frontend that calls them, infra/scaffolding before feature work, QA after the thing it tests. A task with no prerequisites has an empty \`dependsOn\`.
- Keep tasks small — prefer many 2–8h tasks over a few 40h ones. A coding agent ships small tasks reliably; large ones stall.

## Grounding
- Cover the architecture: every entity needs the migration/model task and CRUD/endpoint tasks its user stories imply; every component of substance needs a build task; NFRs like observability/security/compliance need their own explicit tasks (don't assume they happen for free).
- Estimate honestly against the brief's timeline and scale — a prototype's auth task is smaller than an enterprise SSO+audit task.

Do NOT emit criticalPath, totalEstimateHours, or estimatedCalendarWeeks — those are derived downstream from your tasks and dependencies. Respond ONLY by calling the provided tool.`;

export async function generatePlanSection(
  ctx: StageContext & { prd: PrdSection; architecture: ArchitectureSection },
): Promise<Milestone[]> {
  const briefText = formatBrief(ctx.brief);
  const planContext = summarizeForPlan(ctx.prd, ctx.architecture);

  const result = await runStage<PlanStageOutput>({
    model: ctx.model,
    stage: 'plan',
    toolName: 'emit_plan',
    toolDescription: 'Emit the delivery plan as milestones, each containing small, dependency-linked tasks.',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${briefText}\n\n${planContext}\n\nProduce the delivery plan now, via the tool.`,
      },
    ],
    schema: planStageSchema,
    maxTokens: PLAN_MAX_TOKENS,
    signal: ctx.signal,
  });

  return result.milestones;
}

/** The plan stage needs the entities, components, endpoints, and stories. */
function summarizeForPlan(prd: PrdSection, architecture: ArchitectureSection): string {
  return [
    '# Context from earlier stages (build the plan to deliver ALL of this)',
    '',
    '## User stories (each implies tasks)',
    prd.userStories.map((s) => `- [${s.id}] As ${s.asA}, I want ${s.iWant} so that ${s.soThat}`).join('\n'),
    '',
    '## Data-model entities (each needs schema + endpoint tasks)',
    architecture.dataModel.entities.map((e) => `- ${e.name}: ${e.fields.map((f) => f.name).join(', ')}`).join('\n'),
    '',
    '## Components (each of substance needs a build task)',
    architecture.components.map((c) => `- ${c.name} [${c.kind}] — ${c.responsibility} (${c.technology})`).join('\n'),
    '',
    '## API endpoints (each needs an implementation task)',
    architecture.apiEndpoints.map((e) => `- ${e.method} ${e.path} — ${e.purpose}`).join('\n'),
    '',
    '## Pattern & infrastructure',
    `Pattern: ${architecture.pattern}. Hosting: ${architecture.infrastructure.hosting}. CI/CD: ${architecture.infrastructure.cicd}.`,
  ].join('\n');
}

// Re-export the raw task schema for tests that build fixtures.
export { planTaskSchema };
