/**
 * InfraGenie — shared contract for Feature 1 (PRD & Plan Generator).
 *
 * SINGLE SOURCE OF TRUTH. Zod schemas are authoritative; TypeScript types are
 * inferred from them. Never hand-write a parallel interface — infer it here.
 *
 * Owned by: architect. Consumed by: backend (validation + generation),
 * frontend (form state + rendering). Changes require an architect sign-off
 * comment on the kanban board so both sides move together.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

export const productTypeSchema = z.enum([
  'web-app',
  'saas',
  'marketplace',
  'api-service',
  'internal-tool',
  'mobile-backend',
]);

/** Monthly-active-user buckets. Buckets (not free numbers) keep cost
 *  prediction in Feature 2 comparable across generated PRDs. */
export const userScaleSchema = z.enum([
  'prototype', // < 100 MAU
  'small', // 100 – 1k MAU
  'medium', // 1k – 50k MAU
  'large', // 50k – 500k MAU
  'very-large', // > 500k MAU
]);

export const growthExpectationSchema = z.enum(['flat', 'steady', 'aggressive']);

export const regionSchema = z.enum([
  'us-east',
  'us-west',
  'eu-west',
  'eu-central',
  'ap-south',
  'ap-southeast',
  'global-edge',
]);

export const budgetBandSchema = z.enum([
  'free-tier', // $0
  'hobby', // < $25 / mo
  'startup', // $25 – $250 / mo
  'growth', // $250 – $2k / mo
  'enterprise', // > $2k / mo
]);

export const frontendPrefSchema = z.enum(['nextjs', 'react-spa', 'svelte', 'vue', 'none', 'no-preference']);
export const backendPrefSchema = z.enum(['next-api-routes', 'node-express', 'nestjs', 'python-fastapi', 'go', 'no-preference']);
export const databasePrefSchema = z.enum(['postgres', 'mysql', 'mongodb', 'sqlite', 'dynamodb', 'none', 'no-preference']);
export const hostingPrefSchema = z.enum(['vercel', 'aws', 'render', 'fly-io', 'cloudflare', 'self-hosted', 'no-preference']);

export const authMethodSchema = z.enum([
  'email-password',
  'magic-link',
  'oauth-google',
  'oauth-github',
  'sso-saml',
  'api-keys',
]);

export const complianceSchema = z.enum(['none', 'gdpr', 'soc2', 'hipaa', 'pci']);

export const integrationSchema = z.enum([
  'payments',
  'transactional-email',
  'file-storage',
  'search',
  'analytics',
  'llm-api',
  'webhooks',
  'maps',
  'sms',
]);

export const fieldTypeSchema = z.enum(['string', 'text', 'number', 'boolean', 'date', 'json', 'enum', 'relation']);

export const prioritySchema = z.enum(['p0', 'p1', 'p2']);
export const workAreaSchema = z.enum(['frontend', 'backend', 'database', 'infra', 'design', 'qa']);

/* -------------------------------------------------------------------------- */
/* Questionnaire answers — what the user gives us BEFORE we generate anything */
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
  fields: z.array(entityFieldSchema).max(30).default([]),
});

/** Step 1 — Basics */
export const basicsSchema = z.object({
  projectName: z.string().min(2).max(80),
  oneLiner: z.string().min(10).max(200),
  productType: productTypeSchema,
  targetAudience: z.string().min(3).max(200),
  problemStatement: z.string().min(10).max(1000),
});

/** Step 2 — Scale & traffic */
export const scaleSchema = z.object({
  userScale: userScaleSchema,
  peakRequestsPerSecond: z.number().int().min(0).max(1_000_000),
  dataVolumeGb: z.number().min(0).max(1_000_000),
  growthExpectation: growthExpectationSchema,
  regions: z.array(regionSchema).min(1).max(7),
  uptimeTargetPercent: z.number().min(90).max(99.999).default(99.9),
});

/** Step 3 — Budget & team */
export const budgetSchema = z.object({
  monthlyBudgetBand: budgetBandSchema,
  budgetIsHardLimit: z.boolean().default(false),
  teamSize: z.number().int().min(1).max(500),
  timelineWeeks: z.number().int().min(1).max(104),
});

/** Step 4 — Stack preferences */
export const stackSchema = z.object({
  frontend: frontendPrefSchema,
  backend: backendPrefSchema,
  database: databasePrefSchema,
  hosting: hostingPrefSchema,
  mustUse: z.array(z.string().max(60)).max(20).default([]),
  mustAvoid: z.array(z.string().max(60)).max(20).default([]),
});

/** Step 5 — Data model */
export const dataModelAnswersSchema = z.object({
  entities: z.array(entitySchema).min(1).max(25),
  relationshipNotes: z.string().max(1000).optional(),
});

/** Step 6 — Auth & compliance */
export const authAnswersSchema = z.object({
  authRequired: z.boolean(),
  authMethods: z.array(authMethodSchema).max(6).default([]),
  roles: z.array(z.string().max(40)).max(20).default([]),
  multiTenant: z.boolean().default(false),
  compliance: z.array(complianceSchema).max(5).default(['none']),
});

/** Step 7 — Integrations & workloads */
export const integrationsAnswersSchema = z.object({
  integrations: z.array(integrationSchema).max(9).default([]),
  needsRealtime: z.boolean().default(false),
  needsBackgroundJobs: z.boolean().default(false),
  needsFileUploads: z.boolean().default(false),
  notes: z.string().max(1000).optional(),
});

export const questionnaireAnswersSchema = z.object({
  basics: basicsSchema,
  scale: scaleSchema,
  budget: budgetSchema,
  stack: stackSchema,
  dataModel: dataModelAnswersSchema,
  auth: authAnswersSchema,
  integrations: integrationsAnswersSchema,
});

/** A draft in progress: every step optional so the UI can autosave partials. */
export const questionnaireDraftSchema = questionnaireAnswersSchema.partial();

/* -------------------------------------------------------------------------- */
/* Generated output — the PRD document                                        */
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
  category: z.enum(['performance', 'scalability', 'security', 'availability', 'observability', 'compliance', 'cost']),
  requirement: z.string(),
  rationale: z.string(),
});

export const prdSectionSchema = z.object({
  overview: z.object({
    problem: z.string(),
    solution: z.string(),
    targetUsers: z.string(),
    valueProposition: z.array(z.string()),
  }),
  goals: z.array(z.string()),
  nonGoals: z.array(z.string()),
  userStories: z.array(userStorySchema),
  functionalRequirements: z.array(requirementSchema),
  nonFunctionalRequirements: z.array(nonFunctionalRequirementSchema),
  successMetrics: z.array(z.string()),
  risks: z.array(z.object({ risk: z.string(), impact: prioritySchema, mitigation: z.string() })),
  openQuestions: z.array(z.string()),
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

export const architectureSectionSchema = z.object({
  summary: z.string(),
  pattern: z.string(),
  components: z.array(architectureComponentSchema),
  dataModel: z.object({
    entities: z.array(entitySchema),
    relationships: z.array(relationshipSchema),
  }),
  apiEndpoints: z.array(apiEndpointSchema),
  infrastructure: z.object({
    hosting: z.string(),
    database: z.string(),
    cache: z.string().nullable(),
    storage: z.string().nullable(),
    cicd: z.string(),
    environments: z.array(z.string()),
    rationale: z.array(z.string()),
  }),
  /** Mermaid `flowchart` source. Rendering is the frontend's choice. */
  diagramMermaid: z.string(),
});

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
  tasks: z.array(planTaskSchema),
});

export const planSectionSchema = z.object({
  milestones: z.array(milestoneSchema),
  criticalPath: z.array(z.string()),
  totalEstimateHours: z.number(),
  estimatedCalendarWeeks: z.number(),
});

export const prdDocumentSchema = z.object({
  id: z.string(),
  createdAt: z.string(), // ISO-8601
  generatorVersion: z.string(),
  title: z.string(),
  answers: questionnaireAnswersSchema,
  prd: prdSectionSchema,
  architecture: architectureSectionSchema,
  plan: planSectionSchema,
});

/* -------------------------------------------------------------------------- */
/* API envelopes                                                              */
/* -------------------------------------------------------------------------- */

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(['validation_error', 'not_found', 'generation_failed', 'bad_request', 'internal_error']),
    message: z.string(),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
  }),
});

export const generateRequestSchema = z.object({
  answers: questionnaireAnswersSchema,
});

export const generateResponseSchema = z.object({
  document: prdDocumentSchema,
});

/* -------------------------------------------------------------------------- */
/* Questionnaire definition — data-driven form metadata                       */
/* -------------------------------------------------------------------------- */

export const questionKindSchema = z.enum([
  'text',
  'textarea',
  'number',
  'select',
  'multi-select',
  'boolean',
  'tag-list',
  'entity-builder',
]);

export const questionOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  hint: z.string().optional(),
});

export const questionDefSchema = z.object({
  /** Dot-path into QuestionnaireAnswers, e.g. `basics.projectName`. */
  path: z.string(),
  label: z.string(),
  kind: questionKindSchema,
  help: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean().default(true),
  options: z.array(questionOptionSchema).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Show only when this sibling path is truthy/equal. */
  visibleWhen: z.object({ path: z.string(), equals: z.union([z.string(), z.boolean(), z.number()]) }).optional(),
});

export const questionnaireStepSchema = z.object({
  /** Key of QuestionnaireAnswers this step fills. */
  key: z.enum(['basics', 'scale', 'budget', 'stack', 'dataModel', 'auth', 'integrations']),
  title: z.string(),
  description: z.string(),
  questions: z.array(questionDefSchema),
});

export const questionnaireDefSchema = z.object({
  version: z.string(),
  steps: z.array(questionnaireStepSchema),
});

/* -------------------------------------------------------------------------- */
/* Inferred types                                                             */
/* -------------------------------------------------------------------------- */

export type ProductType = z.infer<typeof productTypeSchema>;
export type UserScale = z.infer<typeof userScaleSchema>;
export type GrowthExpectation = z.infer<typeof growthExpectationSchema>;
export type Region = z.infer<typeof regionSchema>;
export type BudgetBand = z.infer<typeof budgetBandSchema>;
export type AuthMethod = z.infer<typeof authMethodSchema>;
export type Compliance = z.infer<typeof complianceSchema>;
export type Integration = z.infer<typeof integrationSchema>;
export type FieldType = z.infer<typeof fieldTypeSchema>;
export type Priority = z.infer<typeof prioritySchema>;
export type WorkArea = z.infer<typeof workAreaSchema>;

export type EntityField = z.infer<typeof entityFieldSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type Basics = z.infer<typeof basicsSchema>;
export type Scale = z.infer<typeof scaleSchema>;
export type Budget = z.infer<typeof budgetSchema>;
export type Stack = z.infer<typeof stackSchema>;
export type DataModelAnswers = z.infer<typeof dataModelAnswersSchema>;
export type AuthAnswers = z.infer<typeof authAnswersSchema>;
export type IntegrationsAnswers = z.infer<typeof integrationsAnswersSchema>;
export type QuestionnaireAnswers = z.infer<typeof questionnaireAnswersSchema>;
export type QuestionnaireDraft = z.infer<typeof questionnaireDraftSchema>;

export type UserStory = z.infer<typeof userStorySchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type NonFunctionalRequirement = z.infer<typeof nonFunctionalRequirementSchema>;
export type PrdSection = z.infer<typeof prdSectionSchema>;
export type ArchitectureComponent = z.infer<typeof architectureComponentSchema>;
export type ApiEndpoint = z.infer<typeof apiEndpointSchema>;
export type Relationship = z.infer<typeof relationshipSchema>;
export type ArchitectureSection = z.infer<typeof architectureSectionSchema>;
export type PlanTask = z.infer<typeof planTaskSchema>;
export type Milestone = z.infer<typeof milestoneSchema>;
export type PlanSection = z.infer<typeof planSectionSchema>;
export type PrdDocument = z.infer<typeof prdDocumentSchema>;

export type ApiError = z.infer<typeof apiErrorSchema>;
export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export type GenerateResponse = z.infer<typeof generateResponseSchema>;

export type QuestionKind = z.infer<typeof questionKindSchema>;
export type QuestionOption = z.infer<typeof questionOptionSchema>;
export type QuestionDef = z.infer<typeof questionDefSchema>;
export type QuestionnaireStep = z.infer<typeof questionnaireStepSchema>;
export type QuestionnaireDef = z.infer<typeof questionnaireDefSchema>;

/** Step keys in canonical order. UI must not reorder these. */
export const STEP_ORDER = [
  'basics',
  'scale',
  'budget',
  'stack',
  'dataModel',
  'auth',
  'integrations',
] as const satisfies readonly QuestionnaireStep['key'][];

export const GENERATOR_VERSION = '1.0.0';
