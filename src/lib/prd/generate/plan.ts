/**
 * InfraGenie — deterministic plan-section generator (Feature 1, backend).
 *
 * Pure function: same `QuestionnaireAnswers` in → same `PlanSection` out.
 * No `Date.now()`, no `Math.random()`, no network, no I/O. Determinism is a
 * contract guarantee (docs/api-contracts.md) and is unit-tested.
 *
 * This module builds the *build plan*: milestones grouping concrete tasks, each
 * task deriving from a specific answer (an entity, an auth method, an
 * integration, a `needs*` flag, a compliance flag, or B1's infra
 * recommendation). Task volume scales with the size of the answer set — a bare
 * prototype yields far fewer tasks than an enterprise SaaS.
 *
 * Two invariants are enforced *before returning*, both by construction and by a
 * verification pass that throws on violation:
 *   1. Every `dependsOn` id exists in the document; no self-references.
 *   2. The dependency graph is a DAG (schema → API → UI, etc.) — a topological
 *      sort must succeed. `topoSort` throws on a cycle.
 * `criticalPath` is the genuine longest weighted path through `dependsOn`.
 *
 * Owned by: backend. Consumes the architect-owned contract in `@/types/prd`.
 * Reuses B1's `recommendInfrastructure` so infra tasks match the recommendation.
 */

import type {
  Milestone,
  PlanSection,
  PlanTask,
  QuestionnaireAnswers,
  WorkArea,
} from '@/types/prd';
import { recommendInfrastructure } from './infra';

/* -------------------------------------------------------------------------- */
/* Assumptions & constants                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Productive engineering hours per person per week. Deliberately below a raw
 * 40h week: meetings, review, context-switching and slack mean ~25 focused
 * hours is a realistic planning figure. Used only to derive
 * `estimatedCalendarWeeks` from `totalEstimateHours` and `budget.teamSize`.
 */
const PRODUCTIVE_HOURS_PER_PERSON_WEEK = 25;

/** Human labels reused from the same enums the PRD generator labels. */
const AUTH_METHOD_LABEL: Record<string, string> = {
  'email-password': 'email & password',
  'magic-link': 'magic link',
  'oauth-google': 'Google OAuth',
  'oauth-github': 'GitHub OAuth',
  'sso-saml': 'SAML SSO',
  'api-keys': 'API keys',
};

const INTEGRATION_LABEL: Record<string, string> = {
  payments: 'payments',
  'transactional-email': 'transactional email',
  'file-storage': 'file storage',
  search: 'full-text search',
  analytics: 'product analytics',
  'llm-api': 'LLM / AI API',
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

/* -------------------------------------------------------------------------- */
/* Graph helpers — topological sort + longest weighted path                   */
/* -------------------------------------------------------------------------- */

/** Flatten every task across milestones into one ordered list. */
function allTasks(milestones: Milestone[]): PlanTask[] {
  return milestones.flatMap((m) => m.tasks);
}

/**
 * Kahn's algorithm topological sort over the `dependsOn` edges. Returns the
 * task ids in a valid build order. THROWS if the graph is not a DAG (a cycle
 * leaves nodes with a non-zero in-degree that can never be dequeued) or if any
 * `dependsOn` id references a task that does not exist.
 *
 * Determinism: candidates with in-degree 0 are dequeued in the tasks' original
 * declaration order, so the returned order is stable for a given input.
 */
export function topoSort(tasks: PlanTask[]): string[] {
  const ids = new Set(tasks.map((t) => t.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep -> tasks that depend on it

  for (const t of tasks) {
    indegree.set(t.id, 0);
    dependents.set(t.id, []);
  }

  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) {
        throw new Error(`Task "${t.id}" depends on itself.`);
      }
      if (!ids.has(dep)) {
        throw new Error(`Task "${t.id}" depends on unknown task "${dep}".`);
      }
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.get(dep)!.push(t.id);
    }
  }

  // Seed the queue in declaration order for determinism.
  const queue: string[] = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (order.length !== tasks.length) {
    const stuck = tasks.filter((t) => !order.includes(t.id)).map((t) => t.id);
    throw new Error(`Dependency cycle detected among tasks: ${stuck.join(', ')}.`);
  }
  return order;
}

/**
 * Longest path by summed `estimateHours` through the `dependsOn` DAG, returned
 * as an ordered array of task ids. Each consecutive pair (a, b) in the result
 * satisfies "b dependsOn a", so it is a genuine chain, not a hand-picked list.
 *
 * We use the topo order (which throws on cycles) so this is only ever called on
 * a valid DAG. `best[id]` = max summed hours of any chain ending at `id`.
 */
export function criticalPath(tasks: PlanTask[]): string[] {
  const order = topoSort(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const best = new Map<string, number>(); // total hours of best chain ending here
  const prev = new Map<string, string | null>(); // predecessor on that chain

  for (const id of order) {
    const task = byId.get(id)!;
    let bestPrevTotal = 0;
    let bestPrevId: string | null = null;
    for (const dep of task.dependsOn) {
      const total = best.get(dep) ?? 0;
      // Choose the predecessor whose best chain is longest. Tie-break on the
      // lexicographically-earlier dependency id so the chosen path is stable.
      const better =
        bestPrevId === null ||
        total > bestPrevTotal ||
        (total === bestPrevTotal && dep < bestPrevId);
      if (better) {
        bestPrevTotal = total;
        bestPrevId = dep;
      }
    }
    best.set(id, bestPrevTotal + task.estimateHours);
    prev.set(id, bestPrevId);
  }

  // Find the endpoint with the greatest total; tie-break on earlier id.
  let endId: string | null = null;
  let endTotal = -1;
  for (const id of order) {
    const total = best.get(id) ?? 0;
    if (total > endTotal || (total === endTotal && endId !== null && id < endId)) {
      endTotal = total;
      endId = id;
    }
  }

  const path: string[] = [];
  let cur = endId;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur) ?? null;
  }
  return path;
}

/* -------------------------------------------------------------------------- */
/* Task builder                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Accumulates tasks with sequential `T-<n>` ids and provides small helpers so
 * every call site reads as "this answer → this task".
 */
class TaskBuilder {
  private n = 0;
  readonly tasks: PlanTask[] = [];

  add(input: {
    title: string;
    description: string;
    area: WorkArea;
    estimateHours: number;
    dependsOn?: string[];
    acceptanceCriteria: string[];
  }): string {
    const id = `T-${++this.n}`;
    this.tasks.push({
      id,
      title: input.title,
      description: input.description,
      area: input.area,
      estimateHours: input.estimateHours,
      dependsOn: input.dependsOn ?? [],
      acceptanceCriteria: input.acceptanceCriteria,
    });
    return id;
  }
}

/* -------------------------------------------------------------------------- */
/* Milestone assembly                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Turn a completed questionnaire into a build plan.
 *
 * Every task below is documented with the answer that produces it. Milestones
 * group tasks by build phase; the actual dependency order is carried on each
 * task's `dependsOn`, not implied by milestone order.
 */
export function generatePlanSection(answers: QuestionnaireAnswers): PlanSection {
  const { scale, budget, stack, dataModel, auth, integrations } = answers;
  const infra = recommendInfrastructure(answers);
  const b = new TaskBuilder();

  const hasFrontend = stack.frontend !== 'none';
  const activeCompliance = auth.compliance.filter((c) => c !== 'none');

  /* ---- M1 Foundations ---------------------------------------------------- */
  // Every project needs a repo/toolchain, a CI pipeline, and a deploy skeleton.
  const mFoundations: string[] = [];

  const tRepo = b.add({
    title: 'Project scaffolding & toolchain',
    description:
      'Initialise the repository, TypeScript config, linting/formatting, and the base app skeleton so every later task has a place to land.',
    area: 'infra',
    estimateHours: 6,
    acceptanceCriteria: [
      'Repository builds and lints from a clean clone with a single documented command.',
      'A hello-world route/page renders locally.',
    ],
  });
  mFoundations.push(tRepo);

  const tCicd = b.add({
    title: 'CI/CD pipeline',
    description: `Wire up ${infra.cicd} so every push is built, linted, tested, and (on the default branch) deployed.`,
    area: 'infra',
    estimateHours: 8,
    dependsOn: [tRepo],
    acceptanceCriteria: [
      'A pull request triggers build + lint + test automatically and blocks merge on failure.',
      'A merge to the default branch produces a deployable artifact/preview.',
    ],
  });
  mFoundations.push(tCicd);

  const tEnvs = b.add({
    title: 'Environments & configuration',
    description: `Provision the ${infra.environments.join(', ')} environments and load all configuration/secrets from environment variables (never hardcoded).`,
    area: 'infra',
    estimateHours: 6,
    dependsOn: [tCicd],
    acceptanceCriteria: [
      `Each of the ${infra.environments.length} environments (${infra.environments.join(', ')}) deploys independently.`,
      'No secret is committed to the repo; all config is read from env vars.',
    ],
  });
  mFoundations.push(tEnvs);

  // Datastore provisioning, unless the recommendation is explicitly "None".
  let tDbProvision: string | null = null;
  if (infra.database !== 'None') {
    tDbProvision = b.add({
      title: 'Provision database & migration tooling',
      description: `Stand up ${infra.database} and a migration workflow so schema changes are versioned and repeatable.`,
      area: 'database',
      estimateHours: 6,
      dependsOn: [tEnvs],
      acceptanceCriteria: [
        `${infra.database} is reachable from every environment via env-var config.`,
        'A no-op migration can be applied and rolled back.',
      ],
    });
    mFoundations.push(tDbProvision);
  }

  // Cache provisioning when B1 recommended one.
  if (infra.cache) {
    const tCache = b.add({
      title: 'Provision cache layer',
      description: `Stand up ${infra.cache} for hot-path caching, as recommended for this scale/load profile.`,
      area: 'infra',
      estimateHours: 5,
      dependsOn: [tEnvs],
      acceptanceCriteria: [
        `${infra.cache} is reachable from the API and used behind a documented caching interface.`,
      ],
    });
    mFoundations.push(tCache);
  }

  // Object storage when B1 recommended one.
  if (infra.storage) {
    const tStorage = b.add({
      title: 'Provision object storage',
      description: `Configure ${infra.storage} for durable blob storage (uploads/attachments).`,
      area: 'infra',
      estimateHours: 4,
      dependsOn: [tEnvs],
      acceptanceCriteria: [
        `A file can be written to and read back from ${infra.storage} using env-var credentials.`,
      ],
    });
    mFoundations.push(tStorage);
  }

  /* ---- M2 Core data + API ------------------------------------------------ */
  // Per entity: a schema/migration task → an API task → (optionally) a UI task.
  // schema before API before UI is the backbone dependency chain. Membership in
  // M2 is derived later by exclusion (see `coreTasks`), so we don't track ids
  // here — we only need the correct per-entity dependency wiring below.
  const mCore: string[] = [];
  const schemaDep = tDbProvision ? [tDbProvision] : [tEnvs];
  // Write-path API ids per entity: downstream auth/RBAC/integration tasks hang
  // off these rather than off a title string, so the wiring is refactor-safe.
  const entityWriteApiIds: string[] = [];

  for (const entity of dataModel.entities) {
    const name = entity.name;
    const requiredFields = entity.fields.filter((f) => f.required).map((f) => f.name);

    const tSchema = b.add({
      title: `${name}: schema & migration`,
      description: `Model the ${name} entity${entity.fields.length ? ` (${entity.fields.map((f) => f.name).join(', ')})` : ''} and ship its migration.`,
      area: 'database',
      estimateHours: 4,
      dependsOn: schemaDep,
      acceptanceCriteria: [
        `The ${name} table/collection exists with the specified fields and correct types.`,
        ...(requiredFields.length ? [`Required fields (${requiredFields.join(', ')}) are NOT NULL / enforced at the storage layer.`] : []),
      ],
    });
    mCore.push(tSchema);

    // Read and write paths are split: they have different validation, caching,
    // and authorisation concerns and are genuinely separable units of work.
    const tReadApi = b.add({
      title: `${name}: read API`,
      description: `Implement list and get-by-id endpoints for ${name}, with pagination and filtering on the list path.`,
      area: 'backend',
      estimateHours: 4,
      dependsOn: [tSchema],
      acceptanceCriteria: [
        `Listing ${name} supports pagination and returns a stable, documented shape.`,
        `Fetching a non-existent ${name} returns a 404, not a 500.`,
      ],
    });
    mCore.push(tReadApi);

    const tWriteApi = b.add({
      title: `${name}: write API`,
      description: `Implement create/update/delete endpoints for ${name} with input validation and structured errors.`,
      area: 'backend',
      estimateHours: 5,
      dependsOn: [tReadApi],
      acceptanceCriteria: [
        `Create, update and delete for ${name} are covered by passing integration tests.`,
        ...(requiredFields.length ? [`Creating a ${name} without required fields (${requiredFields.join(', ')}) returns a validation error.`] : ['Malformed input returns a structured validation error, not a 500.']),
      ],
    });
    mCore.push(tWriteApi);
    entityWriteApiIds.push(tWriteApi);

    if (hasFrontend) {
      const tUi = b.add({
        title: `${name}: UI`,
        description: `Build the list/detail/edit UI for ${name} against the ${name} read and write APIs.`,
        area: 'frontend',
        estimateHours: 8,
        dependsOn: [tReadApi, tWriteApi],
        acceptanceCriteria: [
          `A user can list, view, create, edit and delete ${name} records from the UI.`,
          'Validation errors from the API are surfaced inline on the form.',
        ],
      });
      mCore.push(tUi);
    }
  }

  /* ---- M3 Auth & access control (or a non-auth M3) ----------------------- */
  const mAuth: string[] = [];
  const apiTaskIds = entityWriteApiIds;

  if (auth.authRequired) {
    const methods = auth.authMethods.length > 0 ? auth.authMethods : ['email-password'];
    let firstAuthTask: string | null = null;
    for (const method of methods) {
      const label = AUTH_METHOD_LABEL[method] ?? method;
      const id = b.add({
        title: `Auth: ${label}`,
        description: `Implement sign-up/sign-in via ${label}, issuing a server-validated session.`,
        area: 'backend',
        estimateHours: 8,
        dependsOn: firstAuthTask ? [firstAuthTask] : schemaDep,
        acceptanceCriteria: [
          `A user can authenticate with ${label} and receives a valid session.`,
          'Invalid credentials are rejected with a clear error and no session is issued.',
        ],
      });
      if (!firstAuthTask) firstAuthTask = id;
      mAuth.push(id);
    }

    if (auth.roles.length > 1) {
      const id = b.add({
        title: 'Roles & permissions (RBAC)',
        description: `Enforce authorisation for the roles ${auth.roles.join(', ')} on every protected action.`,
        area: 'backend',
        estimateHours: 10,
        dependsOn: [firstAuthTask!, ...apiTaskIds.slice(0, 1)],
        acceptanceCriteria: [
          `Each of the ${auth.roles.length} roles (${auth.roles.join(', ')}) is enforced on protected endpoints.`,
          'A caller without the required role receives a 403.',
        ],
      });
      mAuth.push(id);
    }

    if (auth.multiTenant) {
      const id = b.add({
        title: 'Tenant isolation',
        description: 'Scope every data query to the active organisation so cross-tenant access is impossible by construction.',
        area: 'backend',
        estimateHours: 12,
        dependsOn: [firstAuthTask!, ...apiTaskIds.slice(0, 1)],
        acceptanceCriteria: [
          'A member of one organisation can never read or write another organisation\u2019s data.',
          'A regression test asserts cross-tenant isolation on every entity API.',
        ],
      });
      mAuth.push(id);
    }
  }

  /* ---- M4 Integrations & workloads --------------------------------------- */
  const mIntegrations: string[] = [];
  const apiChainDep = apiTaskIds.length > 0 ? [apiTaskIds[0]] : schemaDep;

  for (const integ of integrations.integrations) {
    const label = INTEGRATION_LABEL[integ] ?? integ;
    const id = b.add({
      title: `Integrate ${label}`,
      description: `Integrate ${label} server-side, with credentials in environment variables and graceful handling of upstream failures.`,
      area: 'backend',
      estimateHours: 6,
      dependsOn: apiChainDep,
      acceptanceCriteria: [
        `${label.charAt(0).toUpperCase() + label.slice(1)} works end-to-end against its sandbox/test mode.`,
        `A failure from ${label} is handled without crashing the calling flow.`,
      ],
    });
    mIntegrations.push(id);
  }

  if (integrations.needsRealtime) {
    const id = b.add({
      title: 'Realtime updates',
      description: 'Push live updates to connected clients (websockets or server-sent events).',
      area: 'backend',
      estimateHours: 10,
      dependsOn: apiChainDep,
      acceptanceCriteria: ['A change to underlying data propagates to a subscribed client without a manual refresh.'],
    });
    mIntegrations.push(id);
  }

  if (integrations.needsBackgroundJobs) {
    const id = b.add({
      title: 'Background job worker & queue',
      description: 'Run asynchronous/scheduled work off the request path via a job queue or scheduler.',
      area: 'backend',
      estimateHours: 10,
      dependsOn: apiChainDep,
      acceptanceCriteria: [
        'A job can be enqueued from the API and processed by a separate worker.',
        'Failed jobs are retried with backoff and surfaced when they exhaust retries.',
      ],
    });
    mIntegrations.push(id);
  }

  if (integrations.needsFileUploads) {
    const id = b.add({
      title: 'File upload & storage flow',
      description: 'Accept user file uploads, store them in object storage, and enforce type/size limits.',
      area: 'backend',
      estimateHours: 8,
      dependsOn: apiChainDep,
      acceptanceCriteria: [
        'A user can upload a file that is stored durably in object storage.',
        'Unsupported types or oversized files are rejected with a clear message.',
      ],
    });
    mIntegrations.push(id);
  }

  /* ---- M5 Hardening & launch --------------------------------------------- */
  const mHardening: string[] = [];
  // Depend on the bulk of feature work: all API tasks + integrations.
  const featureDeps = [...apiTaskIds, ...mIntegrations, ...mAuth];
  const dedupedFeatureDeps = Array.from(new Set(featureDeps));

  const tObservability = b.add({
    title: 'Observability: logging, metrics & health checks',
    description: 'Emit structured logs and metrics for key actions and expose a health/readiness endpoint for hosting and CI.',
    area: 'infra',
    estimateHours: 8,
    dependsOn: dedupedFeatureDeps.length ? dedupedFeatureDeps.slice(0, 1) : [tEnvs],
    acceptanceCriteria: [
      'A health endpoint returns readiness and is used by the deploy pipeline.',
      'Key actions emit structured logs with correlation ids.',
    ],
  });
  mHardening.push(tObservability);

  // Load test scaled to peakRequestsPerSecond.
  const rps = scale.peakRequestsPerSecond;
  const tLoadTest = b.add({
    title: 'Load & performance testing',
    description:
      rps > 0
        ? `Load-test the hot paths to sustain the stated ${rps} req/s peak with p95 latency under 300ms; fix regressions found.`
        : 'Characterise baseline performance and set a p95 latency budget under 300ms for read paths.',
    area: 'qa',
    estimateHours: rps > 1000 ? 16 : rps > 100 ? 10 : 6,
    dependsOn: [tObservability, ...dedupedFeatureDeps.slice(0, 2)].filter((v, i, a) => a.indexOf(v) === i),
    acceptanceCriteria: [
      rps > 0
        ? `A repeatable load test demonstrates ${rps} req/s at p95 < 300ms on read paths.`
        : 'A repeatable load test establishes the baseline latency budget.',
    ],
  });
  mHardening.push(tLoadTest);

  // One compliance task per active flag.
  for (const c of activeCompliance) {
    const label = COMPLIANCE_LABEL[c] ?? c;
    const id = b.add({
      title: `${label} compliance work`,
      description: `Implement the controls required for ${label}: data handling, retention, access logging, and data-subject/export controls as applicable.`,
      area: 'backend',
      estimateHours: 16,
      dependsOn: dedupedFeatureDeps.length ? dedupedFeatureDeps.slice(0, 1) : [tEnvs],
      acceptanceCriteria: [
        `A ${label} controls checklist is documented and each control has a verifying test or audit note.`,
      ],
    });
    mHardening.push(id);
  }

  const tLaunch = b.add({
    title: 'Launch readiness & runbook',
    description: 'Final QA pass, production smoke tests, rollback runbook, and go-live checklist.',
    area: 'qa',
    estimateHours: 8,
    dependsOn: [tLoadTest, tObservability],
    acceptanceCriteria: [
      'A production smoke test passes against a real deploy.',
      'A rollback runbook exists and has been dry-run once.',
    ],
  });
  mHardening.push(tLaunch);

  /* ---- M3 content (auth, or a genuine non-auth milestone) ---------------- */
  // Decide M3's tasks BEFORE building the lookup map so every b.add() has run.
  let mThree: string[];
  let mThreeName: string;
  let mThreeGoal: string;
  if (auth.authRequired) {
    mThree = mAuth;
    mThreeName = 'Auth & access control';
    mThreeGoal = 'Authentication, role-based access, and tenant isolation as configured.';
  } else {
    // Fold a genuine non-auth milestone in: navigation/search/empty-states —
    // real work every no-auth product still needs (not filler).
    const tPolish = b.add({
      title: 'Navigation, search & empty states',
      description: 'Cross-entity navigation, list search/filter, and first-run/empty states so the product is usable end to end.',
      area: hasFrontend ? 'frontend' : 'backend',
      estimateHours: 8,
      dependsOn: apiTaskIds.length ? [apiTaskIds[0]] : schemaDep,
      acceptanceCriteria: [
        'A user can navigate between entities and search/filter list views.',
        'Empty and first-run states are handled with clear guidance.',
      ],
    });
    mThree = [tPolish];
    mThreeName = 'Core UX & discoverability';
    mThreeGoal = 'Navigation, search, and empty/first-run states (this build needs no authentication).';
  }

  /* ---- Group tasks into milestones by explicit membership ---------------- */
  // Every task is tracked in exactly one milestone id-list as it is created
  // (mFoundations, mCore, mThree, mIntegrations, mHardening). All b.add() calls
  // have completed, so the lookup map below is complete.
  const byId = new Map(b.tasks.map((t) => [t.id, t]));
  const pick = (ids: string[]): PlanTask[] => ids.map((id) => byId.get(id)!);

  const milestones: Milestone[] = [];
  milestones.push({
    id: 'M1',
    name: 'Foundations',
    goal: 'Repository, CI/CD, environments, and datastore/cache/storage provisioning — the skeleton every feature builds on.',
    tasks: pick(mFoundations),
  });
  milestones.push({
    id: 'M2',
    name: 'Core data & API',
    goal: `Per-entity schema, read/write API${hasFrontend ? ', and UI' : ''} for ${dataModel.entities.map((e) => e.name).join(', ')}.`,
    tasks: pick(mCore),
  });
  milestones.push({
    id: 'M3',
    name: mThreeName,
    goal: mThreeGoal,
    tasks: pick(mThree),
  });

  // M4 only when there is integration/workload work to group.
  if (mIntegrations.length > 0) {
    milestones.push({
      id: 'M4',
      name: 'Integrations & workloads',
      goal: 'Third-party integrations, realtime, background jobs, and file handling as configured.',
      tasks: pick(mIntegrations),
    });
  }

  milestones.push({
    id: `M${milestones.length + 1}`,
    name: 'Hardening & launch',
    goal: 'Observability, load testing scaled to peak traffic, compliance work, and launch readiness.',
    tasks: pick(mHardening),
  });

  /* ---- Verify invariants BEFORE returning -------------------------------- */
  const flat = allTasks(milestones);

  // Sanity: every builder task landed in exactly one milestone.
  if (flat.length !== b.tasks.length) {
    throw new Error(`Task grouping mismatch: built ${b.tasks.length} tasks but grouped ${flat.length}.`);
  }

  // Throws on missing dependency, self-reference, or cycle.
  topoSort(flat);

  const path = criticalPath(flat);
  const totalEstimateHours = flat.reduce((sum, t) => sum + t.estimateHours, 0);

  // Calendar weeks: total hours / (team size * productive hours per week),
  // rounded up to a sensible one-decimal figure. We do NOT clamp this to
  // budget.timelineWeeks — the tension (if any) belongs in B1's risks, and
  // silently fudging the estimate to fit would hide it.
  const capacityPerWeek = budget.teamSize * PRODUCTIVE_HOURS_PER_PERSON_WEEK;
  const estimatedCalendarWeeks = Math.round((totalEstimateHours / capacityPerWeek) * 10) / 10;

  return {
    milestones,
    criticalPath: path,
    totalEstimateHours,
    estimatedCalendarWeeks,
  };
}
