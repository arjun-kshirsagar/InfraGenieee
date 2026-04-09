/**
 * InfraGenie — deterministic PRD-section generator (Feature 1, backend).
 *
 * Pure function: same `QuestionnaireAnswers` in → same `PrdSection` out.
 * No `Date.now()`, no `Math.random()`, no network, no I/O.
 *
 * The output is *derived* from the answers, not templated boilerplate: user
 * stories come from entities/auth/integrations, requirements from the same
 * plus the `needs*` booleans, and every NFR names the answer that produced it.
 * A reviewer diffing two different answer sets must see materially different
 * documents — that is the design goal, and it is unit-tested.
 *
 * Contract minimums (docs/api-contracts.md): ≥ 5 user stories,
 * ≥ 8 functional requirements, ≥ 5 non-functional requirements.
 *
 * Owned by: backend. Consumes the architect-owned contract in `@/types/prd`.
 */

import type {
  NonFunctionalRequirement,
  Priority,
  PrdSection,
  QuestionnaireAnswers,
  Requirement,
  UserStory,
} from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Human labels for the enums, so prose reads naturally and deterministically. */
const AUTH_METHOD_LABEL: Record<string, string> = {
  'email-password': 'email and password',
  'magic-link': 'a magic link',
  'oauth-google': 'their Google account',
  'oauth-github': 'their GitHub account',
  'sso-saml': 'enterprise SSO (SAML)',
  'api-keys': 'an API key',
};

const INTEGRATION_LABEL: Record<string, string> = {
  payments: 'payments',
  'transactional-email': 'transactional email',
  'file-storage': 'file storage',
  search: 'full-text search',
  analytics: 'product analytics',
  'llm-api': 'an LLM / AI API',
  webhooks: 'outbound webhooks',
  maps: 'maps / geolocation',
  sms: 'SMS messaging',
};

const COMPLIANCE_LABEL: Record<string, string> = {
  gdpr: 'GDPR',
  soc2: 'SOC 2',
  hipaa: 'HIPAA',
  pci: 'PCI-DSS',
};

/** Rough traffic-tier weighting so scale-driven prose actually scales. */
const SCALE_RANK: Record<QuestionnaireAnswers['scale']['userScale'], number> = {
  prototype: 0,
  small: 1,
  medium: 2,
  large: 3,
  'very-large': 4,
};

/** Success-metric targets scaled to the user-scale bucket. Deterministic. */
const SCALE_METRIC_TARGET: Record<QuestionnaireAnswers['scale']['userScale'], string> = {
  prototype: '50 monthly active users within the first 8 weeks',
  small: '1,000 monthly active users within the first quarter',
  medium: '10,000 monthly active users within two quarters',
  large: '100,000 monthly active users within the first year',
  'very-large': '500,000+ monthly active users sustained',
};

/** An indefinite-article helper kept deterministic (no locale surprises). */
function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/* -------------------------------------------------------------------------- */
/* User stories                                                               */
/* -------------------------------------------------------------------------- */

function buildUserStories(answers: QuestionnaireAnswers): UserStory[] {
  const { dataModel, auth, integrations, basics } = answers;
  const stories: UserStory[] = [];
  let n = 0;
  const nextId = () => `US-${++n}`;

  const actor = auth.roles.length > 0 ? auth.roles[0] : auth.authRequired ? 'authenticated user' : 'user';

  // Auth stories first — sign-up / sign-in per configured method.
  if (auth.authRequired) {
    const methods = auth.authMethods.length > 0 ? auth.authMethods : ['email-password'];
    for (const method of methods) {
      const label = AUTH_METHOD_LABEL[method] ?? method;
      stories.push({
        id: nextId(),
        asA: 'new user',
        iWant: `to sign up and sign in using ${label}`,
        soThat: 'I can access the product securely',
        priority: 'p0',
        acceptanceCriteria: [
          `A user can create an account and authenticate with ${label}.`,
          'Invalid credentials are rejected with a clear error and no session is issued.',
          'A successful sign-in establishes a session and redirects to the app.',
        ],
      });
    }

    // Role separation when more than one role exists.
    if (auth.roles.length > 1) {
      stories.push({
        id: nextId(),
        asA: 'an administrator',
        iWant: `to manage what each role (${auth.roles.join(', ')}) can access`,
        soThat: 'permissions match each user\u2019s responsibilities',
        priority: 'p0',
        acceptanceCriteria: [
          `Each of the ${auth.roles.length} roles (${auth.roles.join(', ')}) is enforced on protected actions.`,
          'A user without the required role receives a 403 and cannot perform the action.',
        ],
      });
    }

    // Organisation switching when multi-tenant.
    if (auth.multiTenant) {
      stories.push({
        id: nextId(),
        asA: 'a member of multiple organisations',
        iWant: 'to switch between the organisations I belong to',
        soThat: 'I only see the data for the organisation I am working in',
        priority: 'p0',
        acceptanceCriteria: [
          'A user can switch the active organisation and the view updates to that tenant\u2019s data.',
          'Data from one organisation is never visible to a member of another organisation.',
        ],
      });
    }
  } else {
    // No auth: still a story about frictionless access.
    stories.push({
      id: nextId(),
      asA: 'a visitor',
      iWant: 'to use the product without creating an account',
      soThat: 'I can get value immediately with zero friction',
      priority: 'p1',
      acceptanceCriteria: [
        'Core functionality is usable without authentication.',
        'No personal account data is collected or required.',
      ],
    });
  }

  // Entity CRUD stories. Two CRUD verbs per entity keeps volume proportional
  // to the data model without exploding into noise.
  for (const entity of dataModel.entities) {
    const name = entity.name;
    stories.push({
      id: nextId(),
      asA: actor,
      iWant: `to create and manage ${name} records`,
      soThat: `the ${lower(basics.productType.replace('-', ' '))} reflects my ${name} data`,
      priority: 'p0',
      acceptanceCriteria: [
        `A ${name} can be created with its required fields validated on input.`,
        `${name} records can be listed, viewed, updated and deleted by an authorised user.`,
        ...(entity.fields.some((f) => f.required)
          ? [`Saving a ${name} without required fields (${entity.fields.filter((f) => f.required).map((f) => f.name).join(', ')}) is rejected.`]
          : []),
      ],
    });
  }

  // One story per integration.
  for (const integ of integrations.integrations) {
    const label = INTEGRATION_LABEL[integ] ?? integ;
    stories.push({
      id: nextId(),
      asA: actor,
      iWant: `the product to use ${label}`,
      soThat: `I get the value that ${label} provides without leaving the product`,
      priority: 'p1',
      acceptanceCriteria: [
        `${label.charAt(0).toUpperCase() + label.slice(1)} is integrated via a server-side service with credentials kept in environment variables.`,
        `Failures from ${label} are handled gracefully and surfaced to the user without crashing the flow.`,
      ],
    });
  }

  // Realtime / background-job / upload stories, derived from the needs* flags.
  if (integrations.needsRealtime) {
    stories.push({
      id: nextId(),
      asA: actor,
      iWant: 'to see updates in real time without refreshing',
      soThat: 'I always work against the latest data',
      priority: 'p1',
      acceptanceCriteria: ['Relevant views update live when the underlying data changes.'],
    });
  }
  if (integrations.needsFileUploads) {
    stories.push({
      id: nextId(),
      asA: actor,
      iWant: 'to upload files and attach them to my records',
      soThat: 'I can keep related documents in one place',
      priority: 'p1',
      acceptanceCriteria: [
        'A user can upload a file, see progress, and the file is stored durably in object storage.',
        'Unsupported file types or oversized files are rejected with a clear message.',
      ],
    });
  }

  // Guarantee the contract minimum of 5 stories with a genuinely-derived
  // catch-all: a discoverability story every product needs. Only appended if
  // we are still short, so richer inputs never get padded.
  if (stories.length < 5) {
    stories.push({
      id: nextId(),
      asA: 'a first-time visitor',
      iWant: `to understand what ${basics.projectName} does and how to start`,
      soThat: 'I can decide whether it solves my problem',
      priority: 'p2',
      acceptanceCriteria: [
        `The landing experience states the value proposition ("${basics.oneLiner}") and a clear primary action.`,
      ],
    });
  }
  if (stories.length < 5) {
    stories.push({
      id: nextId(),
      asA: actor,
      iWant: 'to find and filter records quickly as data grows',
      soThat: 'I can work efficiently even with a large dataset',
      priority: 'p2',
      acceptanceCriteria: ['List views support search/filter and remain responsive as records accumulate.'],
    });
  }
  if (stories.length < 5) {
    stories.push({
      id: nextId(),
      asA: actor,
      iWant: 'to be shown clear, actionable errors when something goes wrong',
      soThat: 'I understand what happened and how to recover',
      priority: 'p2',
      acceptanceCriteria: ['User-facing errors are human-readable and never expose stack traces or secrets.'],
    });
  }

  return stories;
}

/* -------------------------------------------------------------------------- */
/* Functional requirements                                                    */
/* -------------------------------------------------------------------------- */

function buildFunctionalRequirements(answers: QuestionnaireAnswers): Requirement[] {
  const { dataModel, auth, integrations } = answers;
  const reqs: Requirement[] = [];
  let n = 0;
  const push = (title: string, detail: string, priority: Priority) =>
    reqs.push({ id: `FR-${++n}`, title, detail, priority });

  // Auth requirements.
  if (auth.authRequired) {
    const methods = auth.authMethods.length > 0 ? auth.authMethods : ['email-password'];
    push(
      'Authentication',
      `The system authenticates users via ${methods.map((m) => AUTH_METHOD_LABEL[m] ?? m).join(', ')} and issues a server-validated session.`,
      'p0',
    );
    if (auth.roles.length > 1) {
      push(
        'Role-based access control',
        `Authorisation is enforced for the roles ${auth.roles.join(', ')}; every protected action checks the caller\u2019s role.`,
        'p0',
      );
    }
    if (auth.multiTenant) {
      push(
        'Tenant isolation',
        'Every data query is scoped to the active organisation; cross-tenant access is impossible by construction.',
        'p0',
      );
    }
  } else {
    push('Anonymous access', 'Core features are usable without authentication; no account is required.', 'p1');
  }

  // One CRUD requirement per entity (this is the backbone of volume).
  for (const entity of dataModel.entities) {
    const req = entity.fields.filter((f) => f.required).map((f) => f.name);
    push(
      `${entity.name} management`,
      `The system provides create, read, update and delete for ${entity.name}${req.length ? `, validating required fields (${req.join(', ')})` : ''}.`,
      'p0',
    );
  }

  // One requirement per integration.
  for (const integ of integrations.integrations) {
    const label = INTEGRATION_LABEL[integ] ?? integ;
    push(
      `${label.charAt(0).toUpperCase() + label.slice(1)} integration`,
      `The system integrates ${label} server-side, with credentials in environment variables and graceful handling of upstream failures.`,
      'p1',
    );
  }

  // needs* booleans each add a concrete capability.
  if (integrations.needsRealtime) {
    push('Realtime updates', 'The system pushes live updates to connected clients (websockets or server-sent events).', 'p1');
  }
  if (integrations.needsBackgroundJobs) {
    push('Background jobs', 'The system runs asynchronous/scheduled work off the request path via a job queue or scheduler.', 'p1');
  }
  if (integrations.needsFileUploads) {
    push('File uploads', 'The system accepts user file uploads, stores them in object storage, and enforces type/size limits.', 'p1');
  }

  // Data-export / audit requirement whenever compliance applies — derived, not filler.
  const activeCompliance = auth.compliance.filter((c) => c !== 'none');
  if (activeCompliance.length > 0) {
    push(
      'Auditability & data-subject controls',
      `To satisfy ${activeCompliance.map((c) => COMPLIANCE_LABEL[c] ?? c).join(', ')}, the system logs access to sensitive data and supports data export/erasure requests.`,
      'p1',
    );
  }

  // Ensure the contract minimum of 8. These are still real requirements every
  // product needs; appended only while short so rich inputs aren't padded.
  const backstops: Array<[string, string, Priority]> = [
    ['Input validation', 'All write endpoints validate input against a shared schema and reject malformed requests with structured errors.', 'p0'],
    ['Error handling', 'User-facing errors are actionable and never leak stack traces or secrets.', 'p1'],
    ['Observability hooks', 'The system emits structured logs for key actions to support debugging and monitoring.', 'p2'],
    ['Configuration via environment', 'All secrets and environment-specific settings are read from environment variables, never hardcoded.', 'p0'],
    ['Health checks', 'The system exposes a health/readiness endpoint so hosting and CI can verify deploys.', 'p1'],
    ['Responsive UI', 'The interface is usable on both desktop and mobile viewport widths.', 'p2'],
    ['Data validation on read', 'Persisted data is validated on read so a schema change never crashes the app on stale data.', 'p2'],
  ];
  for (const [title, detail, priority] of backstops) {
    if (reqs.length >= 8) break;
    push(title, detail, priority);
  }

  return reqs;
}

/* -------------------------------------------------------------------------- */
/* Non-functional requirements                                                */
/* -------------------------------------------------------------------------- */

function buildNonFunctionalRequirements(answers: QuestionnaireAnswers): NonFunctionalRequirement[] {
  const { scale, budget, auth } = answers;
  const nfrs: NonFunctionalRequirement[] = [];
  let n = 0;
  const push = (
    category: NonFunctionalRequirement['category'],
    requirement: string,
    rationale: string,
  ) => nfrs.push({ id: `NFR-${++n}`, category, requirement, rationale });

  // Performance — from peakRequestsPerSecond.
  const rps = scale.peakRequestsPerSecond;
  push(
    'performance',
    rps > 0
      ? `Sustain ${rps} requests/second at peak with p95 latency under 300ms for read paths.`
      : 'Keep p95 latency under 300ms for read paths under expected load.',
    rps > 0
      ? `Peak load was given as ${rps} rps, so the architecture must be sized and load-tested for it.`
      : 'No peak rps was provided (0), so a conservative latency budget is set until load is characterised.',
  );

  // Scalability — from userScale / growthExpectation.
  push(
    'scalability',
    scale.growthExpectation === 'aggressive' || SCALE_RANK[scale.userScale] >= 3
      ? 'Scale horizontally with no code changes; no single-node bottlenecks on the hot path.'
      : 'Handle 3x the initial expected load without re-architecture.',
    `User scale is "${scale.userScale}" with "${scale.growthExpectation}" growth, which sets the headroom the design must leave.`,
  );

  // Availability — from uptimeTargetPercent.
  push(
    'availability',
    `Meet an uptime target of ${scale.uptimeTargetPercent}% (allowing for maintenance windows).`,
    `The stated uptime target is ${scale.uptimeTargetPercent}%, which drives redundancy and health-check requirements.`,
  );

  // Security — from auth.
  push(
    'security',
    auth.authRequired
      ? 'Encrypt data in transit (TLS) and at rest; store no plaintext credentials; scope every request to its authenticated principal.'
      : 'Encrypt data in transit (TLS); apply rate limiting and input validation on all public endpoints.',
    auth.authRequired
      ? `Authentication is required (${(auth.authMethods.length ? auth.authMethods : ['email-password']).join(', ')}), so session and credential handling must be hardened.`
      : 'No authentication is required, so public endpoints must be defended against abuse.',
  );

  // Cost — from monthlyBudgetBand, mentioning budgetIsHardLimit.
  push(
    'cost',
    budget.budgetIsHardLimit
      ? `Stay within the "${budget.monthlyBudgetBand}" budget as a hard cap; provision no resource that would breach it.`
      : `Target the "${budget.monthlyBudgetBand}" budget band; flag any choice that materially exceeds it.`,
    `Monthly budget band is "${budget.monthlyBudgetBand}"${budget.budgetIsHardLimit ? ' and was marked a hard limit' : ' (soft target)'}, which constrains infrastructure choices.`,
  );

  // One compliance NFR per active flag.
  for (const c of auth.compliance) {
    if (c === 'none') continue;
    const label = COMPLIANCE_LABEL[c] ?? c;
    push(
      'compliance',
      `Meet ${label} requirements for data handling, retention, and access control.`,
      `${label} was selected as a compliance requirement, which imposes specific controls on the system.`,
    );
  }

  return nfrs;
}

/* -------------------------------------------------------------------------- */
/* Overview, goals, non-goals, metrics, risks, open questions                 */
/* -------------------------------------------------------------------------- */

function buildValueProposition(answers: QuestionnaireAnswers): string[] {
  const { basics, integrations } = answers;
  const vp = [
    `Directly addresses: ${basics.problemStatement}`,
    `Purpose-built for ${basics.targetAudience}.`,
  ];
  if (integrations.integrations.length > 0) {
    vp.push(
      `Integrates ${integrations.integrations.map((i) => INTEGRATION_LABEL[i] ?? i).join(', ')} so users stay in one product.`,
    );
  }
  return vp;
}

function buildGoals(answers: QuestionnaireAnswers): string[] {
  const { basics, scale, budget, dataModel } = answers;
  return [
    `Ship a ${basics.productType.replace('-', ' ')} that delivers on "${basics.oneLiner}".`,
    `Support the ${scale.userScale} user-scale bucket with ${scale.growthExpectation} growth headroom.`,
    `Deliver the core data model (${dataModel.entities.map((e) => e.name).join(', ')}) end to end.`,
    `Ship within the ${budget.timelineWeeks}-week target timeline${budget.budgetIsHardLimit ? ` and the ${budget.monthlyBudgetBand} budget cap` : ''}.`,
  ];
}

function buildNonGoals(answers: QuestionnaireAnswers): string[] {
  const { stack, auth, integrations, scale } = answers;
  const nonGoals: string[] = [];
  if (stack.mustAvoid.length > 0) {
    nonGoals.push(`Not using ${stack.mustAvoid.join(', ')} (explicitly on the must-avoid list).`);
  }
  if (!auth.authRequired) {
    nonGoals.push('No user accounts or authentication in this version.');
  }
  if (!auth.multiTenant && auth.authRequired) {
    nonGoals.push('No multi-tenant / organisation model in this version.');
  }
  const possible = ['payments', 'search', 'llm-api', 'analytics', 'sms', 'maps'] as const;
  const missing = possible.filter((p) => !integrations.integrations.includes(p));
  if (missing.length > 0) {
    nonGoals.push(`Out of scope for v1: ${missing.map((m) => INTEGRATION_LABEL[m]).join(', ')}.`);
  }
  if (SCALE_RANK[scale.userScale] <= 1) {
    nonGoals.push('No premature optimisation for scale beyond the stated prototype/small bucket.');
  }
  // Guarantee ≥ 2.
  if (nonGoals.length < 2) nonGoals.push('No native mobile apps in this version (web first).');
  if (nonGoals.length < 2) nonGoals.push('No offline mode in this version.');
  return nonGoals;
}

function buildSuccessMetrics(answers: QuestionnaireAnswers): string[] {
  const { scale, dataModel } = answers;
  return [
    `Reach ${SCALE_METRIC_TARGET[scale.userScale]}.`,
    `Sustain the ${scale.uptimeTargetPercent}% uptime target over any rolling 30-day window.`,
    `Median time to complete the primary ${dataModel.entities[0].name} workflow under 60 seconds.`,
    'Activation: ≥ 40% of new users complete the core workflow in their first session.',
  ];
}

function buildRisks(answers: QuestionnaireAnswers): PrdSection['risks'] {
  const { budget, dataModel, scale, integrations, auth } = answers;
  const risks: PrdSection['risks'] = [];

  // Budget risk when the budget is a hard limit.
  if (budget.budgetIsHardLimit) {
    risks.push({
      risk: `Infrastructure cost could exceed the hard "${budget.monthlyBudgetBand}" budget cap as usage grows.`,
      impact: 'p0',
      mitigation: 'Choose managed free/low tiers first, set billing alerts, and load-test before scaling up paid resources.',
    });
  }

  // Timeline risk when the timeline is short relative to entity count.
  // Heuristic: fewer than ~1.5 weeks of runway per entity is tight.
  const entityCount = dataModel.entities.length;
  if (budget.timelineWeeks < entityCount * 1.5 + 2) {
    risks.push({
      risk: `The ${budget.timelineWeeks}-week timeline is tight for ${entityCount} core entit${entityCount === 1 ? 'y' : 'ies'} plus auth and integrations.`,
      impact: 'p1',
      mitigation: 'Sequence entities by priority, ship a thin vertical slice first, and defer non-p0 stories to a follow-up.',
    });
  }

  // Scale risk.
  if (SCALE_RANK[scale.userScale] >= 3 || scale.growthExpectation === 'aggressive') {
    risks.push({
      risk: 'Traffic could outgrow the initial architecture faster than planned.',
      impact: 'p1',
      mitigation: 'Design for horizontal scale and caching from day one; monitor p95 latency and add capacity ahead of demand.',
    });
  }

  // Integration risk.
  if (integrations.integrations.length > 0) {
    risks.push({
      risk: `Dependence on external providers (${integrations.integrations.map((i) => INTEGRATION_LABEL[i] ?? i).join(', ')}) introduces third-party failure and rate-limit exposure.`,
      impact: 'p1',
      mitigation: 'Wrap each integration behind a service boundary with retries, timeouts, and graceful degradation.',
    });
  }

  // Compliance risk.
  const activeCompliance = auth.compliance.filter((c) => c !== 'none');
  if (activeCompliance.length > 0) {
    risks.push({
      risk: `Meeting ${activeCompliance.map((c) => COMPLIANCE_LABEL[c] ?? c).join(', ')} adds process and audit overhead that can slow delivery.`,
      impact: 'p1',
      mitigation: 'Bake compliance controls into the data model and CI early rather than retrofitting before launch.',
    });
  }

  // Guarantee ≥ 3 with a generic-but-real delivery risk.
  if (risks.length < 3) {
    risks.push({
      risk: 'Scope creep could push the core workflow past the target timeline.',
      impact: 'p2',
      mitigation: 'Freeze v1 scope to the p0 stories; route new ideas to a backlog.',
    });
  }
  if (risks.length < 3) {
    risks.push({
      risk: 'Unclear requirements in under-specified areas could cause rework.',
      impact: 'p2',
      mitigation: 'Resolve the open questions below before starting the affected work.',
    });
  }

  return risks;
}

function buildOpenQuestions(answers: QuestionnaireAnswers): string[] {
  const { scale, dataModel, auth, integrations, budget } = answers;
  const q: string[] = [];

  if (scale.peakRequestsPerSecond === 0) {
    q.push('Peak requests/second was left at 0 — what is the realistic expected peak load, so performance targets can be firmed up?');
  }
  if (!dataModel.relationshipNotes || dataModel.relationshipNotes.trim() === '') {
    q.push('No relationship notes were provided — how do the core entities relate (one-to-many, many-to-many)?');
  }
  if (auth.authRequired && auth.roles.length === 0) {
    q.push('Authentication is required but no roles were listed — is a single role sufficient, or are permission tiers needed?');
  }
  if (integrations.integrations.includes('payments')) {
    q.push('Which payment provider and pricing model (subscriptions, one-off, usage-based) should the payments integration support?');
  }
  if (scale.dataVolumeGb === 0) {
    q.push('Expected stored data volume was left at 0 GB — is data retention minimal, or was this not yet estimated?');
  }
  if (budget.monthlyBudgetBand === 'free-tier') {
    q.push('The budget is free-tier only — is there any headroom for paid managed services if a free tier proves limiting?');
  }

  // Guarantee ≥ 2 genuinely-useful questions even for a fully-specified input.
  if (q.length < 2) {
    q.push('Which region should be primary for launch, and is multi-region needed on day one?');
  }
  if (q.length < 2) {
    q.push('What is the rollback/backup strategy expected for the data store?');
  }

  return q;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build the `prd` section of a PrdDocument from a completed questionnaire.
 * Pure and deterministic.
 */
export function generatePrdSection(answers: QuestionnaireAnswers): PrdSection {
  const { basics } = answers;

  const solutionKind = basics.productType.replace('-', ' ');

  return {
    overview: {
      problem: basics.problemStatement,
      solution: `${basics.oneLiner} — delivered as a ${solutionKind} for ${basics.targetAudience}.`,
      targetUsers: basics.targetAudience,
      valueProposition: buildValueProposition(answers),
    },
    goals: buildGoals(answers),
    nonGoals: buildNonGoals(answers),
    userStories: buildUserStories(answers),
    functionalRequirements: buildFunctionalRequirements(answers),
    nonFunctionalRequirements: buildNonFunctionalRequirements(answers),
    successMetrics: buildSuccessMetrics(answers),
    risks: buildRisks(answers),
    openQuestions: buildOpenQuestions(answers),
  };
}
