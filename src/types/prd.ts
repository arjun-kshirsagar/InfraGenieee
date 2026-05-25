/**
 * InfraGenie — shared contract for Feature 1 (AI-generated PRD & Plan).
 *
 * SINGLE SOURCE OF TRUTH. Zod schemas are authoritative; TypeScript types are
 * inferred from them. Never hand-write a parallel interface — infer it here.
 *
 * Owned by: architect. Consumed by: backend (LLM generation + validation),
 * frontend (form state + rendering). Changes require an architect sign-off
 * comment on the kanban board so both sides move together.
 *
 * ## The shape of this feature
 *
 * The user supplies a short **ProjectBrief** — their idea in free text plus a
 * handful of high-level context answers. An LLM then REASONS OUT everything
 * else: entities, requirements, architecture, and the task plan. The user is
 * never asked to enumerate entities or fields; inferring those is the product.
 *
 *     ProjectBrief  ──LLM──▶  PrdDocument { prd, architecture, plan }
 *
 * ## Two layers of schema, and why
 *
 * `*Draft` schemas describe what the MODEL emits. The non-draft schemas
 * describe the FINAL document, and include fields we compute deterministically
 * in TypeScript rather than trusting the model to produce:
 *
 *   - `architecture.diagramMermaid` — derived from components + relationships.
 *   - `plan.criticalPath` / `totalEstimateHours` / `estimatedCalendarWeeks`
 *     — derived by topological sort over the model's `dependsOn` edges.
 *
 * LLMs reason well about substance and badly about mechanical graph/diagram
 * syntax, so we split the work along exactly that line.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Minimum-volume floors                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A generated document below any of these floors is not useful to hand to a
 * coding agent, so it is treated as a generation failure.
 *
 * These are enforced by the schemas below — NOT merely documented in prose.
 * A previous iteration of this feature stated the floors only in
 * `docs/api-contracts.md`; the route self-validated against a schema that had
 * no `.min()` anywhere, so a thin document sailed through. Encoding them here
 * means an under-volume document literally cannot parse, and therefore cannot
 * be returned.
 */
export const MIN_USER_STORIES = 5;
export const MIN_FUNCTIONAL_REQUIREMENTS = 8;
export const MIN_NON_FUNCTIONAL_REQUIREMENTS = 5;
export const MIN_ENTITIES = 3;
export const MIN_COMPONENTS = 3;
export const MIN_API_ENDPOINTS = 5;
export const MIN_MILESTONES = 3;
export const MIN_PLAN_TASKS = 12;
export const MIN_GOALS = 3;
export const MIN_SUCCESS_METRICS = 3;
export const MIN_RISKS = 3;

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/** Monthly-active-user buckets. Buckets (not free numbers) keep cost
 *  prediction in Feature 2 comparable across generated PRDs. */
export const userScaleSchema = z.enum([
  'prototype', // < 100 MAU
  'small', // 100 – 1k MAU
  'medium', // 1k – 50k MAU
  'large', // 50k – 500k MAU
  'very-large', // > 500k MAU
]);

/** How load is distributed over time — drives autoscaling / serverless-vs-VM
 *  reasoning in the architecture stage and cost modelling in Feature 2. */
export const trafficPatternSchema = z.enum([
  'steady', // roughly flat around the clock
  'business-hours', // weekday daytime peaks
  'spiky', // unpredictable bursts (launches, virality)
  'seasonal', // predictable periodic peaks
  'unknown', // user genuinely doesn't know — the AI should assume and say so
]);

export const budgetBandSchema = z.enum([
  'free-tier', // $0
  'hobby', // < $25 / mo
  'startup', // $25 – $250 / mo
  'growth', // $250 – $2k / mo
  'enterprise', // > $2k / mo
]);

export const fieldTypeSchema = z.enum([
  'string',
  'text',
  'number',
  'boolean',
  'date',
  'json',
  'enum',
  'relation',
]);

export const prioritySchema = z.enum(['p0', 'p1', 'p2']);
export const workAreaSchema = z.enum(['frontend', 'backend', 'database', 'infra', 'design', 'qa']);

/* -------------------------------------------------------------------------- */
/* Input — the ProjectBrief                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One adaptive question the AI asked back, with the user's answer.
 *
 * The clarifier step is OPTIONAL and MINIMAL by design: the AI asks only what
 * it genuinely cannot infer, and may legitimately ask nothing at all. An empty
 * array is a valid, common state — never block generation on it.
 */
export const clarificationSchema = z.object({
  question: z.string().min(1).max(300),
  /** Empty string = user skipped this question. Still valid; the generator
   *  must treat a skipped clarifier as "infer it yourself". */
  answer: z.string().max(1000),
});

/** The handful of things the AI cannot reasonably guess from the idea alone. */
export const briefContextSchema = z.object({
  userScale: userScaleSchema,
  trafficPattern: trafficPatternSchema,
  budgetBand: budgetBandSchema,
  timelineWeeks: z.number().int().min(1).max(104),
  /** Hard constraints: "must run on-prem", "team only knows Python",
   *  "must be HIPAA compliant", "no vendor lock-in". Free text on purpose —
   *  an enum here would just push users into the wrong bucket. */
  constraints: z.string().max(1000).optional(),
});

/**
 * Everything the user gives us. Note what is ABSENT: no entity list, no field
 * definitions, no auth-method checkboxes, no integration matrix. Inferring
 * those from `idea` is the entire value proposition.
 */
export const projectBriefSchema = z.object({
  /** The user's idea/vision in their own words. The 30-char floor rejects
   *  "an app" — the model needs something to reason from. */
  idea: z.string().min(30).max(4000),
  context: briefContextSchema,
  clarifications: z.array(clarificationSchema).max(5).default([]),
  additionalNotes: z.string().max(2000).optional(),
});

/** In-progress brief for autosave — every field optional.
 *
 *  `.strict()` matters: without it zod silently STRIPS unknown keys, so a
 *  stale or foreign blob in localStorage would parse to `{}` and masquerade as
 *  a valid empty draft. Strict makes it fail, and the store's read path then
 *  correctly treats it as absent. */
export const projectBriefDraftSchema = z
  .object({
    idea: z.string().max(4000).optional(),
    context: briefContextSchema.partial().optional(),
    clarifications: z.array(clarificationSchema).max(5).optional(),
    additionalNotes: z.string().max(2000).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Output — PRD section                                                       */
/* -------------------------------------------------------------------------- */

export const userStorySchema = z.object({
  id: z.string(),
  asA: z.string(),
  iWant: z.string(),
  soThat: z.string(),
  priority: prioritySchema,
  acceptanceCriteria: z.array(z.string()).min(1),
});

export const requirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  priority: prioritySchema,
});

export const nonFunctionalRequirementSchema = z.object({
  id: z.string(),
  category: z.enum([
    'performance',
    'scalability',
    'security',
    'availability',
    'observability',
    'compliance',
    'cost',
  ]),
  requirement: z.string(),
  rationale: z.string(),
});

export const prdSectionSchema = z.object({
  overview: z.object({
    problem: z.string(),
    solution: z.string(),
    targetUsers: z.string(),
    valueProposition: z.array(z.string()).min(1),
  }),
  goals: z.array(z.string()).min(MIN_GOALS),
  nonGoals: z.array(z.string()).min(1),
  userStories: z.array(userStorySchema).min(MIN_USER_STORIES),
  functionalRequirements: z.array(requirementSchema).min(MIN_FUNCTIONAL_REQUIREMENTS),
  nonFunctionalRequirements: z
    .array(nonFunctionalRequirementSchema)
    .min(MIN_NON_FUNCTIONAL_REQUIREMENTS),
  successMetrics: z.array(z.string()).min(MIN_SUCCESS_METRICS),
  risks: z
    .array(z.object({ risk: z.string(), impact: prioritySchema, mitigation: z.string() }))
    .min(MIN_RISKS),
  openQuestions: z.array(z.string()),
  /**
   * Assumptions the AI made where the brief was silent. This is a first-class
   * output, not a footnote: the user did not specify entities or auth, so the
   * document MUST be explicit about what it decided on their behalf.
   */
  assumptions: z.array(z.string()).min(1),
});

/* -------------------------------------------------------------------------- */
/* Output — architecture section                                              */
/* -------------------------------------------------------------------------- */

export const entityFieldSchema = z.object({
  name: z.string().min(1).max(60),
  type: fieldTypeSchema,
  required: z.boolean().default(false),
  notes: z.string().max(200).optional(),
});

export const entitySchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(300).optional(),
  /** AI-inferred, so a real floor: an entity with no fields is useless to a
   *  build agent. */
  fields: z.array(entityFieldSchema).min(1).max(30),
});

export const architectureComponentSchema = z.object({
  name: z.string(),
  kind: z.enum(['client', 'service', 'datastore', 'cache', 'queue', 'external', 'cdn']),
  responsibility: z.string(),
  technology: z.string(),
});

export const apiEndpointSchema = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  path: z.string(),
  purpose: z.string(),
  authRequired: z.boolean(),
});

export const relationshipSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['one-to-one', 'one-to-many', 'many-to-many']),
  description: z.string().optional(),
});

/**
 * The data model, with the integrity rules the old hand-entered version
 * lacked. Entity-name uniqueness used to be a display-only warning in the
 * wizard, so two entities named `Tenant` produced duplicated endpoints,
 * stories and plan tasks. It is now a parse error, and the normalizer must
 * dedupe before it ever reaches here.
 */
export const dataModelSchema = z
  .object({
    entities: z.array(entitySchema).min(MIN_ENTITIES).max(25),
    relationships: z.array(relationshipSchema),
  })
  .superRefine((dm, ctx) => {
    const seen = new Set<string>();
    dm.entities.forEach((e, i) => {
      const key = e.name.trim().toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entities', i, 'name'],
          message: `Duplicate entity name "${e.name}" — entity names must be unique.`,
        });
      }
      seen.add(key);

      // Same class of bug one level down: duplicate fields within an entity.
      const fieldSeen = new Set<string>();
      e.fields.forEach((f, fi) => {
        const fkey = f.name.trim().toLowerCase();
        if (fieldSeen.has(fkey)) {
          ctx.addIssue({
            code: 'custom',
            path: ['entities', i, 'fields', fi, 'name'],
            message: `Duplicate field "${f.name}" on entity "${e.name}".`,
          });
        }
        fieldSeen.add(fkey);
      });
    });

    // Relationships must reference entities that actually exist, or the
    // derived Mermaid diagram renders edges to nowhere.
    const names = new Set(dm.entities.map((e) => e.name.trim().toLowerCase()));
    dm.relationships.forEach((r, i) => {
      for (const [side, value] of [
        ['from', r.from],
        ['to', r.to],
      ] as const) {
        if (!names.has(value.trim().toLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            path: ['relationships', i, side],
            message: `Relationship ${side} "${value}" is not a declared entity.`,
          });
        }
      }
    });
  });

export const infrastructureSchema = z.object({
  hosting: z.string(),
  database: z.string(),
  cache: z.string().nullable(),
  storage: z.string().nullable(),
  cicd: z.string(),
  environments: z.array(z.string()).min(1),
  /** Why each choice was made, in the AI's own reasoning. Must reference the
   *  brief (scale/budget/constraints), not generic best practice. */
  rationale: z.array(z.string()).min(1),
});

export const architectureSectionSchema = z.object({
  summary: z.string(),
  pattern: z.string(),
  components: z.array(architectureComponentSchema).min(MIN_COMPONENTS),
  dataModel: dataModelSchema,
  apiEndpoints: z.array(apiEndpointSchema).min(MIN_API_ENDPOINTS),
  infrastructure: infrastructureSchema,
  /** DERIVED in TypeScript from `components` + `dataModel.relationships`.
   *  The model never writes Mermaid syntax — see the header note. */
  diagramMermaid: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* Output — plan section                                                      */
/* -------------------------------------------------------------------------- */

export const planTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  area: workAreaSchema,
  estimateHours: z.number().min(0.5).max(200),
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).min(1),
});

export const milestoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  tasks: z.array(planTaskSchema).min(1),
});

/**
 * The plan, with graph integrity enforced at parse time.
 *
 * `criticalPath`, `totalEstimateHours` and `estimatedCalendarWeeks` are all
 * DERIVED in TypeScript — the model supplies only milestones, tasks and
 * `dependsOn` edges. The refinements below are the safety net that makes the
 * route's self-validation actually meaningful.
 */
export const planSectionSchema = z
  .object({
    milestones: z.array(milestoneSchema).min(MIN_MILESTONES),
    criticalPath: z.array(z.string()).min(1),
    totalEstimateHours: z.number().positive(),
    estimatedCalendarWeeks: z.number().positive(),
  })
  .superRefine((plan, ctx) => {
    const tasks = plan.milestones.flatMap((m) => m.tasks);

    if (tasks.length < MIN_PLAN_TASKS) {
      ctx.addIssue({
        code: 'custom',
        path: ['milestones'],
        message: `Plan has ${tasks.length} tasks; at least ${MIN_PLAN_TASKS} are required to be useful.`,
      });
    }

    const ids = new Set<string>();
    for (const t of tasks) {
      if (ids.has(t.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['milestones'],
          message: `Duplicate plan task id "${t.id}".`,
        });
      }
      ids.add(t.id);
    }

    // No dangling edges and no self-dependencies. Cycles are broken by the
    // deriver before this point; this only guards against a regression there.
    for (const t of tasks) {
      for (const dep of t.dependsOn) {
        if (dep === t.id) {
          ctx.addIssue({
            code: 'custom',
            path: ['milestones'],
            message: `Task "${t.id}" depends on itself.`,
          });
        } else if (!ids.has(dep)) {
          ctx.addIssue({
            code: 'custom',
            path: ['milestones'],
            message: `Task "${t.id}" depends on unknown task "${dep}".`,
          });
        }
      }
    }

    for (const id of plan.criticalPath) {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['criticalPath'],
          message: `criticalPath references unknown task "${id}".`,
        });
      }
    }
  });

/* -------------------------------------------------------------------------- */
/* Output — the document                                                      */
/* -------------------------------------------------------------------------- */

export const prdDocumentSchema = z.object({
  id: z.string(),
  createdAt: z.string(), // ISO-8601
  generatorVersion: z.string(),
  /** Which Anthropic model produced this document. Provenance matters when
   *  comparing output quality across models. */
  model: z.string(),
  title: z.string(),
  /** Echoed back verbatim so the document view can show what was asked for. */
  brief: projectBriefSchema,
  prd: prdSectionSchema,
  architecture: architectureSectionSchema,
  plan: planSectionSchema,
});

/* -------------------------------------------------------------------------- */
/* LLM stage outputs — exactly what each model call must return               */
/* -------------------------------------------------------------------------- */

/**
 * Generation runs as three sequential LLM calls rather than one. A full
 * document is ~10–15k output tokens and the measured throughput is ~140 tok/s,
 * so a single-shot call takes ~85s — too slow for the UI and too close to
 * serverless timeouts. Staging also improves quality (each call reasons about
 * one thing) and makes failures individually retryable.
 *
 *   Stage 1  prdDraft           ← brief
 *   Stage 2  architectureDraft  ← brief + stage 1
 *   Stage 3  planDraft          ← brief + stages 1 & 2
 *
 * Each `*Draft` schema is the exact target for that call's forced-tool-use
 * JSON Schema. Drafts omit every derived field.
 */

/** Stage 1 output. Identical to the final PRD section. */
export const prdDraftSchema = prdSectionSchema;

/** Stage 2 output — everything except the derived `diagramMermaid`. */
export const architectureDraftSchema = z.object({
  summary: z.string(),
  pattern: z.string(),
  components: z.array(architectureComponentSchema).min(MIN_COMPONENTS),
  dataModel: dataModelSchema,
  apiEndpoints: z.array(apiEndpointSchema).min(MIN_API_ENDPOINTS),
  infrastructure: infrastructureSchema,
});

/** Stage 3 output — milestones only; the graph maths is derived. */
export const planDraftSchema = z.object({
  milestones: z.array(milestoneSchema).min(MIN_MILESTONES),
});

/** The short title the AI derives from the idea (the user never types one). */
export const documentTitleSchema = z.string().min(2).max(80);

/* -------------------------------------------------------------------------- */
/* API envelopes                                                              */
/* -------------------------------------------------------------------------- */

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      'validation_error',
      'not_found',
      'generation_failed',
      'bad_request',
      'internal_error',
      /** Upstream LLM refused, timed out, or is rate-limited. Retryable. */
      'llm_unavailable',
      /** Server is missing ANTHROPIC_API_KEY — a deployment fault, not a user
       *  error. Never echo any part of the key or env in the message. */
      'llm_not_configured',
      /** Feature 2: no price book could be produced for ANY provider (e.g.
       *  TAVILY_API_KEY missing, or every vendor page failed). Partial failures
       *  do NOT use this — they return 200 with `gaps[]` so four working
       *  providers are still comparable. Retryable. */
      'pricing_unavailable',
    ]),
    message: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

/** `POST /api/prd/clarify` — the adaptive question step. */
export const clarifyRequestSchema = z.object({
  idea: z.string().min(30).max(4000),
  context: briefContextSchema,
});

export const clarifyQuestionSchema = z.object({
  id: z.string(),
  question: z.string().min(1).max(300),
  /** Why the AI needs this — shown to the user so the step feels purposeful
   *  rather than like another form. */
  why: z.string().max(200),
  /** Optional suggested answers, rendered as one-tap chips. The user may
   *  always type their own instead. */
  suggestions: z.array(z.string().max(120)).max(4).default([]),
});

/**
 * Zero questions is a valid, expected response when the idea is already clear
 * enough. The cap is 3: this step exists to fill genuine gaps, not to
 * reintroduce the questionnaire we just deleted.
 */
export const clarifyResponseSchema = z.object({
  questions: z.array(clarifyQuestionSchema).max(3),
});

/** `POST /api/prd/generate` — the full document. */
export const generateRequestSchema = z.object({
  brief: projectBriefSchema,
});

export const generateResponseSchema = z.object({
  document: prdDocumentSchema,
});

/* -------------------------------------------------------------------------- */
/* Inferred types                                                             */
/* -------------------------------------------------------------------------- */

export type UserScale = z.infer<typeof userScaleSchema>;
export type TrafficPattern = z.infer<typeof trafficPatternSchema>;
export type BudgetBand = z.infer<typeof budgetBandSchema>;
export type FieldType = z.infer<typeof fieldTypeSchema>;
export type Priority = z.infer<typeof prioritySchema>;
export type WorkArea = z.infer<typeof workAreaSchema>;

export type Clarification = z.infer<typeof clarificationSchema>;
export type BriefContext = z.infer<typeof briefContextSchema>;
export type ProjectBrief = z.infer<typeof projectBriefSchema>;
export type ProjectBriefDraft = z.infer<typeof projectBriefDraftSchema>;

export type EntityField = z.infer<typeof entityFieldSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type UserStory = z.infer<typeof userStorySchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type NonFunctionalRequirement = z.infer<typeof nonFunctionalRequirementSchema>;
export type PrdSection = z.infer<typeof prdSectionSchema>;

export type ArchitectureComponent = z.infer<typeof architectureComponentSchema>;
export type ApiEndpoint = z.infer<typeof apiEndpointSchema>;
export type Relationship = z.infer<typeof relationshipSchema>;
export type DataModel = z.infer<typeof dataModelSchema>;
export type Infrastructure = z.infer<typeof infrastructureSchema>;
export type ArchitectureSection = z.infer<typeof architectureSectionSchema>;

export type PlanTask = z.infer<typeof planTaskSchema>;
export type Milestone = z.infer<typeof milestoneSchema>;
export type PlanSection = z.infer<typeof planSectionSchema>;
export type PrdDocument = z.infer<typeof prdDocumentSchema>;

export type PrdDraft = z.infer<typeof prdDraftSchema>;
export type ArchitectureDraft = z.infer<typeof architectureDraftSchema>;
export type PlanDraft = z.infer<typeof planDraftSchema>;

export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = ApiError['error']['code'];
export type ClarifyRequest = z.infer<typeof clarifyRequestSchema>;
export type ClarifyQuestion = z.infer<typeof clarifyQuestionSchema>;
export type ClarifyResponse = z.infer<typeof clarifyResponseSchema>;
export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export type GenerateResponse = z.infer<typeof generateResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Display metadata for the brief's context fields                            */
/* -------------------------------------------------------------------------- */

/** Human labels for the enum buckets. Frontend-facing; keeps wording
 *  consistent between the input form, the document view, and Feature 2. */
export const USER_SCALE_LABEL: Record<UserScale, string> = {
  prototype: 'Prototype — under 100 users',
  small: 'Small — 100 to 1,000 users',
  medium: 'Medium — 1,000 to 50,000 users',
  large: 'Large — 50,000 to 500,000 users',
  'very-large': 'Very large — over 500,000 users',
};

export const TRAFFIC_PATTERN_LABEL: Record<TrafficPattern, string> = {
  steady: 'Steady — roughly constant load',
  'business-hours': 'Business hours — weekday daytime peaks',
  spiky: 'Spiky — unpredictable bursts',
  seasonal: 'Seasonal — predictable periodic peaks',
  unknown: "Not sure yet",
};

export const BUDGET_BAND_LABEL: Record<BudgetBand, string> = {
  'free-tier': 'Free tier — $0 / month',
  hobby: 'Hobby — under $25 / month',
  startup: 'Startup — $25 to $250 / month',
  growth: 'Growth — $250 to $2,000 / month',
  enterprise: 'Enterprise — over $2,000 / month',
};

/** Bumped when the generation pipeline changes in a way that alters output. */
export const GENERATOR_VERSION = '2.0.0';
