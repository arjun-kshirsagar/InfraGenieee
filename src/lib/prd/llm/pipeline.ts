/**
 * InfraGenie — the three-stage generation pipeline + document assembly.
 *
 * SERVER-ONLY. This is the backend implementation behind the architect-owned
 * seam `generatePrdDocument` in `src/lib/prd/generation.ts`. Keeping the logic
 * here (rather than in the seam file) leaves the contract file a thin interface
 * and puts the moving parts in a backend-owned module.
 *
 * Flow (docs/feature-1-ai-prd.md §4):
 *
 *   brief ─▶ stage 1 prd            ─▶ PrdSection
 *         ─▶ stage 2 architecture   ─▶ ArchitectureDraft   [sees brief + prd]
 *         ─▶ stage 3 plan           ─▶ Milestone[]         [sees brief + prd + arch]
 *
 * Then, entirely in TypeScript (never asked of the model):
 *   - repairDependencyGraph(milestones) — drop self/unknown/cycle edges, log them
 *   - derive criticalPath, totalEstimateHours, estimatedCalendarWeeks
 *   - buildArchitectureMermaid(title, components) for diagramMermaid
 *   - assemble with the supplied id/createdAt, the model used, and an AI title
 *   - parse the whole thing with prdDocumentSchema; on failure → invalid_output
 */

import {
  GENERATOR_VERSION,
  prdDocumentSchema,
  type ArchitectureSection,
  type PlanSection,
  type PrdDocument,
  type ProjectBrief,
} from '@/types/prd';
import {
  DEFAULT_GENERATION_MODEL,
  GenerationError,
  type GenerateOptions,
  type StageContext,
} from '@/lib/prd/generation';
import {
  buildArchitectureMermaid,
  criticalPath,
  estimateCalendarWeeks,
  repairDependencyGraph,
  totalEstimateHours,
} from '@/lib/prd/derive';
import { generatePrdSection } from '@/lib/prd/llm/stages/prd';
import { generateArchitectureSection } from '@/lib/prd/llm/stages/architecture';
import { generatePlanSection } from '@/lib/prd/llm/stages/plan';
import { fallbackTitle, generateTitle } from '@/lib/prd/llm/stages/title';

/** Default team size for the calendar-week estimate (docs §4). */
const DEFAULT_TEAM_SIZE = 3;

/**
 * Run the full pipeline and return a validated `PrdDocument`.
 *
 * `id` and `createdAt` are injected by the caller so the pipeline stays free of
 * ambient clock/randomness. Any stage failure surfaces as a `GenerationError`.
 */
export async function runGenerationPipeline(
  brief: ProjectBrief,
  id: string,
  createdAt: string,
  options?: GenerateOptions,
): Promise<PrdDocument> {
  const model = options?.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_GENERATION_MODEL;
  const signal = options?.signal;
  const onProgress = options?.onProgress;

  const stageCtx: StageContext = { brief, model, signal };

  // ---- Stage 1: PRD -------------------------------------------------------
  onProgress?.('prd', 'start');
  const prd = await generatePrdSection(stageCtx);
  onProgress?.('prd', 'done');

  // ---- Stage 2: architecture (draft — no diagram yet) ---------------------
  onProgress?.('architecture', 'start');
  const architectureDraft = await generateArchitectureSection({ ...stageCtx, prd });
  onProgress?.('architecture', 'done');

  // Derive the Mermaid diagram from the components the model chose. The model
  // never writes Mermaid (it produces broken syntax often enough to break the
  // diagram tab). Use a provisional title for the diagram comment; the real
  // title is derived below and doesn't change the diagram body.
  const diagramMermaid = buildArchitectureMermaid(
    brief.idea.slice(0, 60),
    architectureDraft.components,
  );
  const architecture: ArchitectureSection = { ...architectureDraft, diagramMermaid };

  // ---- Stage 3: plan (milestones only) ------------------------------------
  onProgress?.('plan', 'start');
  const rawMilestones = await generatePlanSection({ ...stageCtx, prd, architecture });
  onProgress?.('plan', 'done');

  // Repair the dependency graph BEFORE any derivation. A model WILL occasionally
  // reference a nonexistent task or close a cycle; we drop the offending edges
  // and keep the tasks rather than fail an expensive, otherwise-excellent
  // generation over one bad edge. Log what we removed.
  const { milestones, removedEdges } = repairDependencyGraph(rawMilestones);
  if (removedEdges.length > 0) {
    console.info(
      '[prd.llm] graph repair removed %d edge(s): %s',
      removedEdges.length,
      removedEdges.map((e) => `${e.from}->${e.to}(${e.reason})`).join(', '),
    );
  }

  // Derive the graph maths in TypeScript — NEVER from the model.
  const tasks = milestones.flatMap((m) => m.tasks);
  const plan: PlanSection = {
    milestones,
    criticalPath: criticalPath(tasks),
    totalEstimateHours: totalEstimateHours(tasks),
    estimatedCalendarWeeks: estimateCalendarWeeks(tasks, DEFAULT_TEAM_SIZE),
  };

  // ---- Title (cheap 4th call; never sink the document over a name) --------
  let title: string;
  try {
    title = await generateTitle(brief, prd, signal);
  } catch (err) {
    console.info('[prd.llm] title generation failed; using deterministic fallback', {
      reason: err instanceof Error ? err.name : 'unknown',
    });
    title = fallbackTitle(brief);
  }

  // ---- Assemble & self-validate -------------------------------------------
  const candidate: PrdDocument = {
    id,
    createdAt,
    generatorVersion: GENERATOR_VERSION,
    model,
    title,
    brief,
    prd,
    architecture,
    plan,
  };

  const parsed = prdDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new GenerationError(
      'invalid_output',
      `Assembled document failed final validation: ${issues}`,
      { stage: 'plan' },
    );
  }

  return parsed.data;
}
