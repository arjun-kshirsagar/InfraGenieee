/**
 * Tests for the generation pipeline assembly (`runGenerationPipeline`).
 *
 * Every test runs OFFLINE and FREE: the three LLM stage functions and the title
 * stage are mocked with `vi.mock`, so no network call is ever made and the suite
 * bills nothing. We assert the ASSEMBLY logic, not prompt quality:
 *
 *   - happy path assembles a schema-valid PrdDocument
 *   - derived fields (diagramMermaid, criticalPath, totalEstimateHours,
 *     estimatedCalendarWeeks) are DERIVED in TS, not passed through from a stage
 *   - the dependency graph is repaired (bad edges dropped) before derivation
 *   - onProgress fires start/done around each stage in order
 *   - a title-stage failure falls back deterministically, never sinking the doc
 *   - an assembled document that violates a floor throws invalid_output
 *
 * The under-volume single-retry behaviour lives in `runStage` and is covered in
 * shared.test.ts against a mocked client — here the stages are fully mocked, so
 * retry is out of scope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MIN_MILESTONES,
  prdDocumentSchema,
  type ArchitectureDraft,
  type Milestone,
  type PrdSection,
} from '@/types/prd';
import { GenerationError } from '@/lib/prd/generation';

/* -------------------------------------------------------------------------- */
/* Mock the four stage modules. Each test can override the return value.       */
/* -------------------------------------------------------------------------- */

const generatePrdSection = vi.fn<(ctx: unknown) => Promise<unknown>>();
const generateArchitectureSection = vi.fn<(ctx: unknown) => Promise<unknown>>();
const generatePlanSection = vi.fn<(ctx: unknown) => Promise<unknown>>();
const generateTitle = vi.fn<(brief: unknown, prd: unknown, signal: unknown) => Promise<string>>();
const fallbackTitle = vi.fn<(brief: unknown) => string>(() => 'Deterministic Fallback');

vi.mock('@/lib/prd/llm/stages/prd', () => ({
  generatePrdSection: (ctx: unknown) => generatePrdSection(ctx),
}));
vi.mock('@/lib/prd/llm/stages/architecture', () => ({
  generateArchitectureSection: (ctx: unknown) => generateArchitectureSection(ctx),
}));
vi.mock('@/lib/prd/llm/stages/plan', () => ({
  generatePlanSection: (ctx: unknown) => generatePlanSection(ctx),
}));
vi.mock('@/lib/prd/llm/stages/title', () => ({
  generateTitle: (brief: unknown, prd: unknown, signal: unknown) =>
    generateTitle(brief, prd, signal),
  fallbackTitle: (brief: unknown) => fallbackTitle(brief),
}));

// Import AFTER the mocks are registered.
import { runGenerationPipeline } from '@/lib/prd/llm/pipeline';
import { VALID_BRIEF } from '@/lib/prd/fixtures.test-support';

/* -------------------------------------------------------------------------- */
/* Stage output builders (drafts — no derived fields)                          */
/* -------------------------------------------------------------------------- */

function prdOutput(): PrdSection {
  return {
    overview: {
      problem: 'Bakeries waste surplus bread.',
      solution: 'A same-day discount marketplace.',
      targetUsers: 'Bakeries and price-conscious locals.',
      valueProposition: ['Less waste', 'Cheaper bread'],
    },
    goals: ['g1', 'g2', 'g3'],
    nonGoals: ['no delivery'],
    userStories: Array.from({ length: 5 }, (_, i) => ({
      id: `US-${i + 1}`,
      asA: 'customer',
      iWant: `thing ${i + 1}`,
      soThat: `benefit ${i + 1}`,
      priority: 'p1' as const,
      acceptanceCriteria: ['ok'],
    })),
    functionalRequirements: Array.from({ length: 8 }, (_, i) => ({
      id: `FR-${i + 1}`,
      title: `FR ${i + 1}`,
      detail: 'detail',
      priority: 'p1' as const,
    })),
    nonFunctionalRequirements: Array.from({ length: 5 }, (_, i) => ({
      id: `NFR-${i + 1}`,
      category: 'security' as const,
      requirement: `req ${i + 1}`,
      rationale: 'because the brief says startup budget',
    })),
    successMetrics: ['m1', 'm2', 'm3'],
    risks: Array.from({ length: 3 }, (_, i) => ({
      risk: `r${i + 1}`,
      impact: 'p1' as const,
      mitigation: 'mit',
    })),
    openQuestions: [],
    assumptions: ['Assumed pickup-only.'],
  };
}

function architectureOutput(): ArchitectureDraft {
  return {
    summary: 'Modular monolith on serverless.',
    pattern: 'Modular monolith',
    components: [
      { name: 'Web', kind: 'client', responsibility: 'UI', technology: 'Next.js' },
      { name: 'API', kind: 'service', responsibility: 'business logic', technology: 'Next.js routes' },
      { name: 'DB', kind: 'datastore', responsibility: 'storage', technology: 'Postgres' },
    ],
    dataModel: {
      entities: [
        { name: 'Bakery', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Listing', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Reservation', fields: [{ name: 'id', type: 'string', required: true }] },
      ],
      relationships: [{ from: 'Bakery', to: 'Listing', kind: 'one-to-many' }],
    },
    apiEndpoints: [
      { method: 'GET', path: '/a', purpose: 'p', authRequired: false },
      { method: 'POST', path: '/b', purpose: 'p', authRequired: true },
      { method: 'GET', path: '/c', purpose: 'p', authRequired: false },
      { method: 'PATCH', path: '/d', purpose: 'p', authRequired: true },
      { method: 'DELETE', path: '/e', purpose: 'p', authRequired: true },
    ],
    infrastructure: {
      hosting: 'Vercel',
      database: 'Neon Postgres',
      cache: null,
      storage: null,
      cicd: 'GitHub Actions',
      environments: ['preview', 'production'],
      rationale: ['Startup budget favours managed serverless.'],
    },
  };
}

/**
 * 12 tasks across 3 milestones. Each task depends on its predecessor — a clean
 * chain, so criticalPath is the whole chain. One task also carries a BAD edge
 * (to a nonexistent id) so we can assert graph repair drops it.
 */
function milestonesOutput(withBadEdge = false): Milestone[] {
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    id: `T-${i + 1}`,
    title: `Task ${i + 1}`,
    description: 'do it',
    area: 'backend' as const,
    estimateHours: 5,
    dependsOn:
      i === 0
        ? withBadEdge
          ? ['DOES-NOT-EXIST']
          : []
        : [`T-${i}`],
    acceptanceCriteria: ['done'],
  }));
  const per = Math.ceil(tasks.length / MIN_MILESTONES);
  return Array.from({ length: MIN_MILESTONES }, (_, m) => ({
    id: `M-${m + 1}`,
    name: `Milestone ${m + 1}`,
    goal: 'goal',
    tasks: tasks.slice(m * per, (m + 1) * per),
  })).filter((m) => m.tasks.length > 0);
}

/* -------------------------------------------------------------------------- */

beforeEach(() => {
  generatePrdSection.mockResolvedValue(prdOutput());
  generateArchitectureSection.mockResolvedValue(architectureOutput());
  generatePlanSection.mockResolvedValue(milestonesOutput());
  generateTitle.mockResolvedValue('Surplus Bread Marketplace');
  fallbackTitle.mockReturnValue('Deterministic Fallback');
});

afterEach(() => {
  vi.clearAllMocks();
});

const ID = 'prd_test01';
const CREATED = '2026-01-01T00:00:00.000Z';

describe('runGenerationPipeline — happy assembly', () => {
  it('assembles a schema-valid PrdDocument from the three stages', async () => {
    const doc = await runGenerationPipeline(VALID_BRIEF, ID, CREATED, { model: 'claude-sonnet-5' });

    // The final document must satisfy the full schema (all floors).
    expect(prdDocumentSchema.safeParse(doc).success).toBe(true);

    // Caller-supplied provenance is injected, not invented.
    expect(doc.id).toBe(ID);
    expect(doc.createdAt).toBe(CREATED);
    expect(doc.model).toBe('claude-sonnet-5');
    expect(doc.brief).toEqual(VALID_BRIEF);
    expect(doc.title).toBe('Surplus Bread Marketplace');
  });

  it('runs the stages in order, feeding each the previous outputs', async () => {
    await runGenerationPipeline(VALID_BRIEF, ID, CREATED);

    // Architecture stage received the PRD; plan stage received prd + architecture.
    const archArg = generateArchitectureSection.mock.calls[0][0] as { prd: PrdSection };
    expect(archArg.prd).toBeDefined();
    expect(archArg.prd.overview.problem).toContain('Bakeries');

    const planArg = generatePlanSection.mock.calls[0][0] as {
      prd: PrdSection;
      architecture: { diagramMermaid: string };
    };
    expect(planArg.prd).toBeDefined();
    expect(planArg.architecture).toBeDefined();
    // The architecture the plan sees already carries the DERIVED diagram.
    expect(planArg.architecture.diagramMermaid).toContain('flowchart TD');
  });
});

describe('runGenerationPipeline — derived fields are derived, not passed through', () => {
  it('derives diagramMermaid from components (the stage never supplied it)', async () => {
    const doc = await runGenerationPipeline(VALID_BRIEF, ID, CREATED);
    expect(doc.architecture.diagramMermaid).toContain('flowchart TD');
    // Contains a node for each component name.
    expect(doc.architecture.diagramMermaid).toContain('Web');
    expect(doc.architecture.diagramMermaid).toContain('API');
    expect(doc.architecture.diagramMermaid).toContain('DB');
  });

  it('derives criticalPath / totalEstimateHours / estimatedCalendarWeeks in TS', async () => {
    const doc = await runGenerationPipeline(VALID_BRIEF, ID, CREATED);

    // 12 tasks in a single chain, 5h each → total 60h, critical path all 12.
    expect(doc.plan.totalEstimateHours).toBe(60);
    expect(doc.plan.criticalPath).toHaveLength(12);
    expect(doc.plan.criticalPath[0]).toBe('T-1');
    expect(doc.plan.criticalPath[11]).toBe('T-12');
    // Calendar weeks is a positive derived number, floored by the critical path.
    expect(doc.plan.estimatedCalendarWeeks).toBeGreaterThan(0);
  });
});

describe('runGenerationPipeline — dependency-graph repair', () => {
  it('drops a dangling edge before derivation so the document still validates', async () => {
    generatePlanSection.mockResolvedValue(milestonesOutput(true)); // T-1 → DOES-NOT-EXIST

    const doc = await runGenerationPipeline(VALID_BRIEF, ID, CREATED);

    // The bad edge was dropped: T-1 now has no dependencies, and the doc parses.
    const t1 = doc.plan.milestones.flatMap((m) => m.tasks).find((t) => t.id === 'T-1');
    expect(t1?.dependsOn).toEqual([]);
    expect(prdDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

describe('runGenerationPipeline — progress reporting', () => {
  it('fires start/done around each stage in order', async () => {
    const events: string[] = [];
    await runGenerationPipeline(VALID_BRIEF, ID, CREATED, {
      onProgress: (stage, status) => events.push(`${stage}:${status}`),
    });
    expect(events).toEqual([
      'prd:start',
      'prd:done',
      'architecture:start',
      'architecture:done',
      'plan:start',
      'plan:done',
    ]);
  });
});

describe('runGenerationPipeline — title fallback', () => {
  it('uses the deterministic fallback when the title stage throws, not failing the doc', async () => {
    generateTitle.mockRejectedValue(new GenerationError('unavailable', 'title down', { stage: 'title' }));

    const doc = await runGenerationPipeline(VALID_BRIEF, ID, CREATED);

    expect(fallbackTitle).toHaveBeenCalledOnce();
    expect(doc.title).toBe('Deterministic Fallback');
    expect(prdDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

describe('runGenerationPipeline — final validation gate', () => {
  it('throws invalid_output when an assembled section violates a floor', async () => {
    // Architecture returns only 2 components — below MIN_COMPONENTS (3).
    const thin = architectureOutput();
    thin.components = thin.components.slice(0, 2);
    generateArchitectureSection.mockResolvedValue(thin);

    await expect(runGenerationPipeline(VALID_BRIEF, ID, CREATED)).rejects.toMatchObject({
      name: 'GenerationError',
      code: 'invalid_output',
    });
  });
});
