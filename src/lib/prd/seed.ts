import { prdDocumentSchema, type PrdDocument, type ProjectBrief } from '@/types/prd';

interface SeedConfig {
  id: string;
  title: string;
  idea: string;
  targetUsers: string;
  solution: string;
  database: string;
  createdAt: string;
  prefix: string;
}

function brief(idea: string): ProjectBrief {
  return {
    idea,
    context: {
      userScale: 'small',
      trafficPattern: 'business-hours',
      budgetBand: 'startup',
      timelineWeeks: 8,
      constraints: 'Use Supabase Auth for identity and MongoDB for application persistence.',
    },
    clarifications: [
      {
        question: 'Should generated PRDs be account-scoped?',
        answer: 'Yes. A signed-in user should only see their own generated documents.',
      },
    ],
    additionalNotes: 'Prioritize a shippable MVP with clear API boundaries and request validation.',
  };
}

function makeSeedDocument(config: SeedConfig): PrdDocument {
  const entities = [
    {
      name: 'Workspace',
      description: 'An account-owned project space for generated planning artifacts.',
      fields: [
        { name: 'id', type: 'string' as const, required: true },
        { name: 'ownerUserId', type: 'string' as const, required: true },
        { name: 'name', type: 'string' as const, required: true },
      ],
    },
    {
      name: 'PrdDocument',
      description: 'A generated PRD, architecture, and task plan.',
      fields: [
        { name: 'id', type: 'string' as const, required: true },
        { name: 'workspaceId', type: 'relation' as const, required: true },
        { name: 'payload', type: 'json' as const, required: true },
      ],
    },
    {
      name: 'GenerationRequest',
      description: 'The validated user brief submitted for AI generation.',
      fields: [
        { name: 'id', type: 'string' as const, required: true },
        { name: 'brief', type: 'json' as const, required: true },
        { name: 'status', type: 'enum' as const, required: true },
      ],
    },
  ];

  const tasks = Array.from({ length: 12 }, (_, i) => ({
    id: `${config.prefix}-T${String(i + 1).padStart(2, '0')}`,
    title: [
      'Define account data contract',
      'Create auth callback route',
      'Add Mongo connection singleton',
      'Implement PRD save endpoint',
      'Implement PRD list endpoint',
      'Implement PRD detail endpoint',
      'Wire generated document save',
      'Add account document picker',
      'Add seed request flow',
      'Write ownership tests',
      'Run live smoke checks',
      'Document deployment variables',
    ][i],
    description: 'Deliver one verifiable slice of the authenticated PRD workflow.',
    area: (i < 2 ? 'backend' : i < 8 ? 'database' : i < 10 ? 'frontend' : 'qa') as
      | 'backend'
      | 'database'
      | 'frontend'
      | 'qa',
    estimateHours: i < 8 ? 3 : 2,
    dependsOn: i === 0 ? [] : [`${config.prefix}-T${String(i).padStart(2, '0')}`],
    acceptanceCriteria: ['The change is reachable through an HTTP request and validates ownership.'],
  }));

  const document: PrdDocument = {
    id: config.id,
    createdAt: config.createdAt,
    generatorVersion: 'seed-1.0.0',
    model: 'seed-fixture',
    title: config.title,
    brief: brief(config.idea),
    prd: {
      overview: {
        problem: 'Generated planning artifacts are currently tied to one browser and disappear when local storage is cleared.',
        solution: config.solution,
        targetUsers: config.targetUsers,
        valueProposition: [
          'Users can access generated PRDs after signing in.',
          'Server APIs enforce account ownership before reading or writing documents.',
          'The product keeps a guest fallback for quick demos.',
        ],
      },
      goals: [
        'Persist generated PRDs to an account-owned database.',
        'Keep the generation request path validated and observable.',
        'Make seeded examples available for cost and deploy workflows.',
      ],
      nonGoals: ['Building a collaborative multi-user workspace in this milestone.'],
      userStories: Array.from({ length: 5 }, (_, i) => ({
        id: `${config.prefix}-US${i + 1}`,
        asA: ['founder', 'engineer', 'product manager', 'solo builder', 'operator'][i],
        iWant: 'to retrieve my generated PRD after signing in',
        soThat: 'I can keep planning work attached to my account',
        priority: i < 3 ? 'p0' : 'p1',
        acceptanceCriteria: ['Only the owning signed-in user can read the document.'],
      })),
      functionalRequirements: Array.from({ length: 8 }, (_, i) => ({
        id: `${config.prefix}-FR${i + 1}`,
        title: [
          'Authenticate users with Supabase Auth',
          'Persist generated documents in MongoDB',
          'List documents for the current user',
          'Load one document by id',
          'Seed sample PRDs through an authenticated request',
          'Fallback to browser storage for guests',
          'Validate every request body with zod',
          'Avoid exposing server secrets to the browser',
        ][i],
        detail: 'The requirement must be implemented as a request-driven workflow with server-side validation.',
        priority: i < 5 ? 'p0' : 'p1',
      })),
      nonFunctionalRequirements: [
        { id: `${config.prefix}-NFR1`, category: 'security', requirement: 'All Mongo queries include the verified Supabase user id.', rationale: 'MongoDB does not enforce Supabase RLS.' },
        { id: `${config.prefix}-NFR2`, category: 'availability', requirement: 'Guest mode continues to work if auth is not configured.', rationale: 'The prototype remains demoable.' },
        { id: `${config.prefix}-NFR3`, category: 'observability', requirement: 'Server routes return clear status codes for auth and validation failures.', rationale: 'Debugging setup errors should not require secret inspection.' },
        { id: `${config.prefix}-NFR4`, category: 'performance', requirement: 'Document list reads return summaries rather than full payloads.', rationale: 'PRDs can be large.' },
        { id: `${config.prefix}-NFR5`, category: 'cost', requirement: 'Seed data does not call the paid LLM pipeline.', rationale: 'Development setup should be cheap and repeatable.' },
      ],
      successMetrics: [
        'A signed-in user can seed at least two PRDs.',
        'A signed-in user can open a seeded PRD detail route.',
        'Unauthenticated API requests return 401.',
      ],
      risks: [
        { risk: 'A client sends another user id', impact: 'p0', mitigation: 'Ignore client user ids and derive ownership from Supabase cookies.' },
        { risk: 'Database credentials are missing in deployment', impact: 'p1', mitigation: 'Fail server APIs with setup-visible errors and document env vars.' },
        { risk: 'Seed data pollutes production', impact: 'p2', mitigation: 'Make seeding an explicit signed-in request, not automatic startup behavior.' },
      ],
      openQuestions: ['Should production expose the seed action after private beta?'],
      assumptions: ['Email and password auth is acceptable for the first auth milestone.'],
    },
    architecture: {
      summary: 'Next.js API routes verify Supabase sessions and persist account-owned PRD documents to MongoDB.',
      pattern: 'Authenticated server-route backend with browser fallback',
      components: [
        { name: 'Next.js App Router', kind: 'client', responsibility: 'Renders PRD, cost, deploy, and auth pages.', technology: 'React 19 / Next.js 16' },
        { name: 'Auth API', kind: 'external', responsibility: 'Issues and verifies user sessions.', technology: 'Supabase Auth' },
        { name: 'PRD API Routes', kind: 'service', responsibility: 'Validate requests and enforce document ownership.', technology: 'Next.js route handlers' },
        { name: 'Document Store', kind: 'datastore', responsibility: 'Stores generated PRD documents by user id.', technology: config.database },
      ],
      dataModel: {
        entities,
        relationships: [
          { from: 'Workspace', to: 'PrdDocument', kind: 'one-to-many', description: 'A workspace owns many generated documents.' },
          { from: 'GenerationRequest', to: 'PrdDocument', kind: 'one-to-one', description: 'A successful request creates one document.' },
        ],
      },
      apiEndpoints: [
        { method: 'POST', path: '/api/prd/generate', purpose: 'Generate a PRD from a validated brief.', authRequired: false },
        { method: 'GET', path: '/api/prd/documents', purpose: 'List current user PRD summaries.', authRequired: true },
        { method: 'POST', path: '/api/prd/documents', purpose: 'Persist a generated PRD for the current user.', authRequired: true },
        { method: 'GET', path: '/api/prd/documents/:id', purpose: 'Fetch one current-user PRD document.', authRequired: true },
        { method: 'POST', path: '/api/prd/seed', purpose: 'Create sample PRD documents for the current user.', authRequired: true },
      ],
      infrastructure: {
        hosting: 'Vercel',
        database: config.database,
        cache: null,
        storage: null,
        cicd: 'GitHub Actions',
        environments: ['preview', 'production'],
        rationale: ['Supabase Auth separates identity from MongoDB application persistence.'],
      },
      diagramMermaid: 'graph TD;Browser-->PRDAPI;PRDAPI-->SupabaseAuth;PRDAPI-->MongoDB;',
    },
    plan: {
      milestones: [
        { id: `${config.prefix}-M1`, name: 'Auth foundation', goal: 'Users can sign in and out.', tasks: tasks.slice(0, 4) },
        { id: `${config.prefix}-M2`, name: 'Document persistence', goal: 'Generated PRDs are stored and loaded by account.', tasks: tasks.slice(4, 8) },
        { id: `${config.prefix}-M3`, name: 'Validation and QA', goal: 'Seed, test, and verify the request flow.', tasks: tasks.slice(8) },
      ],
      criticalPath: tasks.map((task) => task.id),
      totalEstimateHours: tasks.reduce((sum, task) => sum + task.estimateHours, 0),
      estimatedCalendarWeeks: 2,
    },
  };

  return prdDocumentSchema.parse(document);
}

export function seedPrdDocuments(now = new Date()): PrdDocument[] {
  const first = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const second = now.toISOString();

  return [
    makeSeedDocument({
      id: 'prd_seed_auth_mongo_prd',
      title: 'Authenticated PRD Workspace',
      idea: 'A planning workspace where founders generate PRDs, architectures, and task plans, then retrieve them from any browser after signing in.',
      targetUsers: 'Solo founders and small engineering teams using AI to turn product ideas into build plans.',
      solution: 'A Supabase-authenticated PRD workspace backed by MongoDB documents and account-scoped API routes.',
      database: 'MongoDB Atlas',
      createdAt: second,
      prefix: 'AUTH',
    }),
    makeSeedDocument({
      id: 'prd_seed_deploy_cost_context',
      title: 'Deploy Cost Context Library',
      idea: 'A saved library of generated PRDs that can be reused as context for cost prediction and deployment planning workflows.',
      targetUsers: 'Builders comparing deployment vendors before shipping a generated application plan.',
      solution: 'A request-validated document library that exposes generated PRDs to downstream cost and deploy workflows.',
      database: 'MongoDB Atlas',
      createdAt: first,
      prefix: 'CTX',
    }),
  ];
}
