/**
 * Shared test fixtures for Feature 1.
 *
 * `makePrdDocument()` returns a document that satisfies EVERY floor in
 * `prdDocumentSchema` (stories, FRs, NFRs, entities, components, endpoints,
 * milestones, tasks) with a valid, acyclic dependency graph. Tests that need
 * an invalid document should start here and break one thing, so it stays
 * obvious what is under test.
 *
 * Not shipped: `*.test-support.ts` is excluded from the production build.
 */

import {
  MIN_API_ENDPOINTS,
  MIN_COMPONENTS,
  MIN_ENTITIES,
  MIN_FUNCTIONAL_REQUIREMENTS,
  MIN_GOALS,
  MIN_MILESTONES,
  MIN_NON_FUNCTIONAL_REQUIREMENTS,
  MIN_PLAN_TASKS,
  MIN_RISKS,
  MIN_SUCCESS_METRICS,
  MIN_USER_STORIES,
  type ApiEndpoint,
  type ArchitectureComponent,
  type Entity,
  type Milestone,
  type NonFunctionalRequirement,
  type PlanTask,
  type PrdDocument,
  type ProjectBrief,
  type Requirement,
  type UserStory,
} from '@/types/prd';

export const VALID_BRIEF: ProjectBrief = {
  idea: 'A marketplace where local bakeries list same-day surplus bread at a discount and nearby customers reserve it for pickup before closing time.',
  context: {
    userScale: 'medium',
    trafficPattern: 'business-hours',
    budgetBand: 'startup',
    timelineWeeks: 12,
    constraints: 'Must launch in the EU and be GDPR compliant.',
  },
  clarifications: [
    { question: 'Do bakeries need their own dashboard?', answer: 'Yes, a simple one.' },
    { question: 'Are payments taken up front?', answer: '' }, // skipped on purpose
  ],
  additionalNotes: 'Pickup only for v1 — no delivery.',
};

const COMPONENT_KINDS: ArchitectureComponent['kind'][] = [
  'client',
  'service',
  'datastore',
  'cache',
  'external',
];

const NFR_CATEGORIES: NonFunctionalRequirement['category'][] = [
  'performance',
  'scalability',
  'security',
  'availability',
  'observability',
  'compliance',
];

const AREAS: PlanTask['area'][] = ['infra', 'database', 'backend', 'frontend', 'qa', 'design'];

function stories(n = MIN_USER_STORIES): UserStory[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `US-${i + 1}`,
    asA: 'customer',
    iWant: `capability ${i + 1}`,
    soThat: `outcome ${i + 1}`,
    priority: (['p0', 'p1', 'p2'] as const)[i % 3],
    acceptanceCriteria: [`criterion ${i + 1}`],
  }));
}

function functionalRequirements(n = MIN_FUNCTIONAL_REQUIREMENTS): Requirement[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `FR-${i + 1}`,
    title: `Functional requirement ${i + 1}`,
    detail: `The system shall do thing ${i + 1}.`,
    priority: (['p0', 'p1', 'p2'] as const)[i % 3],
  }));
}

function nonFunctionalRequirements(
  n = MIN_NON_FUNCTIONAL_REQUIREMENTS,
): NonFunctionalRequirement[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `NFR-${i + 1}`,
    category: NFR_CATEGORIES[i % NFR_CATEGORIES.length],
    requirement: `Non-functional requirement ${i + 1}`,
    rationale: `Because reason ${i + 1}.`,
  }));
}

function entities(n = MIN_ENTITIES): Entity[] {
  const names = ['Bakery', 'Listing', 'Reservation', 'Customer', 'Review'];
  return Array.from({ length: n }, (_, i) => ({
    name: names[i % names.length] + (i >= names.length ? String(i) : ''),
    description: `The ${names[i % names.length]} entity.`,
    fields: [
      { name: 'id', type: 'string' as const, required: true },
      { name: 'createdAt', type: 'date' as const, required: true },
    ],
  }));
}

function components(n = MIN_COMPONENTS): ArchitectureComponent[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `Component ${i + 1}`,
    kind: COMPONENT_KINDS[i % COMPONENT_KINDS.length],
    responsibility: `Handles concern ${i + 1}.`,
    technology: 'TypeScript',
  }));
}

function endpoints(n = MIN_API_ENDPOINTS): ApiEndpoint[] {
  const methods = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
  return Array.from({ length: n }, (_, i) => ({
    method: methods[i % methods.length],
    path: `/api/resource-${i + 1}`,
    purpose: `Operate on resource ${i + 1}.`,
    authRequired: i % 2 === 0,
  }));
}

/**
 * `MIN_PLAN_TASKS` tasks spread across `MIN_MILESTONES` milestones, each task
 * depending only on its predecessor — a valid chain, so `topoSort` and
 * `criticalPath` both succeed.
 */
function milestones(
  taskCount = MIN_PLAN_TASKS,
  milestoneCount = MIN_MILESTONES,
): Milestone[] {
  const perMilestone = Math.ceil(taskCount / milestoneCount);
  const all: PlanTask[] = Array.from({ length: taskCount }, (_, i) => ({
    id: `T-${i + 1}`,
    title: `Task ${i + 1}`,
    description: `Do the work of task ${i + 1}.`,
    area: AREAS[i % AREAS.length],
    estimateHours: 4,
    dependsOn: i === 0 ? [] : [`T-${i}`],
    acceptanceCriteria: [`Task ${i + 1} is verifiably complete.`],
  }));

  return Array.from({ length: milestoneCount }, (_, m) => ({
    id: `M-${m + 1}`,
    name: `Milestone ${m + 1}`,
    goal: `Reach checkpoint ${m + 1}.`,
    tasks: all.slice(m * perMilestone, (m + 1) * perMilestone),
  })).filter((m) => m.tasks.length > 0);
}

/** A fully valid `PrdDocument`. Override any slice for a specific test. */
export function makePrdDocument(overrides: Partial<PrdDocument> = {}): PrdDocument {
  const ms = milestones();
  const tasks = ms.flatMap((m) => m.tasks);
  const ents = entities();

  return {
    id: 'prd_abcdef012345',
    createdAt: '2026-01-01T00:00:00.000Z',
    generatorVersion: '2.0.0',
    model: 'claude-sonnet-5',
    title: 'Surplus Bread Marketplace',
    brief: VALID_BRIEF,
    prd: {
      overview: {
        problem: 'Bakeries throw away unsold bread every night.',
        solution: 'A marketplace for discounted same-day surplus.',
        targetUsers: 'Local bakeries and nearby price-conscious customers.',
        valueProposition: ['Less waste', 'Cheaper bread'],
      },
      goals: Array.from({ length: MIN_GOALS }, (_, i) => `Goal ${i + 1}`),
      nonGoals: ['No delivery in v1'],
      userStories: stories(),
      functionalRequirements: functionalRequirements(),
      nonFunctionalRequirements: nonFunctionalRequirements(),
      successMetrics: Array.from({ length: MIN_SUCCESS_METRICS }, (_, i) => `Metric ${i + 1}`),
      risks: Array.from({ length: MIN_RISKS }, (_, i) => ({
        risk: `Risk ${i + 1}`,
        impact: (['p0', 'p1', 'p2'] as const)[i % 3],
        mitigation: `Mitigation ${i + 1}`,
      })),
      openQuestions: ['Which payment provider?'],
      assumptions: ['Assumed pickup-only fulfilment for v1.'],
    },
    architecture: {
      summary: 'A Next.js app with a Postgres datastore.',
      pattern: 'Modular monolith',
      components: components(),
      dataModel: {
        entities: ents,
        relationships: [
          { from: ents[0].name, to: ents[1].name, kind: 'one-to-many', description: 'lists' },
        ],
      },
      apiEndpoints: endpoints(),
      infrastructure: {
        hosting: 'Vercel',
        database: 'Neon Postgres',
        cache: null,
        storage: null,
        cicd: 'GitHub Actions',
        environments: ['preview', 'production'],
        rationale: ['Startup budget band favours managed services.'],
      },
      diagramMermaid: 'flowchart TD\n  A["Component 1"]\n  B["Component 2"]\n  A --> B',
    },
    plan: {
      milestones: ms,
      criticalPath: tasks.map((t) => t.id),
      totalEstimateHours: tasks.reduce((s, t) => s + t.estimateHours, 0),
      estimatedCalendarWeeks: 6,
    },
    ...overrides,
  };
}
