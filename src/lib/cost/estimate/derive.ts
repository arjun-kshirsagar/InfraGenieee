/**
 * InfraGenie — Feature 2, the two PURE functions that turn a PRD into cost
 * inputs.
 *
 *   mapComponentsToRoles(costContext) → { roles, assumptions }
 *   deriveUsageProfile(costContext)   → UsageProfile
 *
 * Same discipline as `src/lib/prd/derive/`: no I/O, no LLM, no clock, no
 * `process.env`, no `Math.random()`. Same input → identical output, always.
 * That purity is what lets the engine (which consumes these) run unchanged in
 * the browser for live totals.
 *
 * The role-mapping table is `docs/feature-2-cost-predictor.md` §3 — implemented
 * here verbatim, not improvised. The usage ratios each carry a code comment so
 * a reviewer can challenge the number; a bare magic constant is a defect.
 *
 * Owned by: backend. Consumes the Feature 1 contract (`CostContext`) and the
 * Feature 2 contract (`InfraRole`, `UsageProfile`) — both from `@/types/cost`.
 */

import type { ArchitectureComponent, BudgetBand, TrafficPattern, UserScale } from '@/types/prd';
import {
  HOURS_PER_MONTH,
  INFRA_ROLE_ORDER,
  usageProfileSchema,
  type CostContext,
  type InfraRole,
  type UsageProfile,
} from '@/types/cost';

/* -------------------------------------------------------------------------- */
/* 1. PRD → InfraRole mapping                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Lower-cased haystack for keyword matching: `technology` + `name`. §3 matches
 * on the component's `kind` AND signals in these two free-text fields, because
 * `kind` alone is too coarse (one `datastore` value covers Postgres *and*
 * DynamoDB).
 */
function haystack(component: ArchitectureComponent): string {
  return `${component.technology} ${component.name}`.toLowerCase();
}

/** True when any keyword appears as a substring of the haystack. */
function matchesAny(hay: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => hay.includes(k));
}

/*
 * §3 keyword sets. Kept as named constants so the mapping table and the tests
 * read against the same source of truth. Order of evaluation within a `kind`
 * matters where sets could overlap — the more specific set is tested first.
 */

// client
const CLIENT_SSR = ['next', 'react', 'ssr', 'server-side'] as const;
const CLIENT_MOBILE = ['mobile', 'ios', 'android', 'react native', 'flutter', 'swift', 'kotlin'] as const;
// (static/spa/vite fall through to plain static-hosting)

// service
const SERVICE_SERVERLESS = ['lambda', 'serverless', 'function', 'edge'] as const;
const SERVICE_WORKER = ['worker', 'cron', 'job', 'queue consumer', 'batch', 'scheduler'] as const;

// datastore
const DS_RELATIONAL = ['postgres', 'mysql', 'sql', 'rds', 'aurora', 'prisma', 'cockroach', 'planetscale'] as const;
const DS_NOSQL = ['dynamo', 'firestore', 'mongo', 'cosmos', 'nosql', 'document', 'cassandra'] as const;
const DS_OBJECT = ['s3', 'blob', 'bucket', 'object', 'file storage', 'upload'] as const;
const DS_SEARCH = ['elastic', 'opensearch', 'algolia', 'search', 'typesense', 'meilisearch'] as const;

// queue
const QUEUE_KAFKA = ['kafka', 'msk', 'confluent', 'event stream', 'kinesis'] as const;

/**
 * Signals in the PRD that imply file/image/upload handling even without an
 * explicit `object` datastore component. §3: an app that stores user uploads
 * always pays for storage, so `object-storage` is added defensively. We scan
 * component names, responsibilities, technologies AND the optional summary —
 * an "avatar upload" story often lives only in the summary, not a component.
 */
const OBJECT_STORAGE_SIGNALS = [
  'upload',
  'image',
  'photo',
  'avatar',
  'attachment',
  'file storage',
  'document storage',
  'media',
  'video',
  'asset',
] as const;

/**
 * Map ONE component to zero or more roles. Returns `null` for `external`
 * (§3: third-party SaaS the customer already pays for — we must not invent a
 * price for someone else's Stripe bill) so the caller can tell "no role" from
 * "empty by accident".
 *
 * The unclear-`datastore` default is signalled by returning `db-relational`
 * plus `defaulted: true`, so the caller can record the assumption (§3 rule 2 /
 * task rule 5: anything decided on the user's behalf is stated out loud).
 */
function rolesForComponent(
  component: ArchitectureComponent,
): { roles: InfraRole[]; defaultedDatastore?: string } | null {
  const hay = haystack(component);

  switch (component.kind) {
    case 'external':
      // 🔴 Maps to NO role. Not [] — null — so it is unmistakably deliberate.
      return null;

    case 'client': {
      // Mobile hosts nothing (the app runs on the device); it is not an empty
      // set by accident, so return an explicit empty role list.
      if (matchesAny(hay, CLIENT_MOBILE)) return { roles: [] };
      // SSR frameworks need both a static/edge surface AND a running server.
      if (matchesAny(hay, CLIENT_SSR)) return { roles: ['static-hosting', 'compute-web'] };
      // Pure SPA / static / vite: only static hosting.
      return { roles: ['static-hosting'] };
    }

    case 'service': {
      if (matchesAny(hay, SERVICE_SERVERLESS)) return { roles: ['compute-serverless'] };
      if (matchesAny(hay, SERVICE_WORKER)) return { roles: ['compute-worker'] };
      // anything else (API, monolith, gateway) is a web server.
      return { roles: ['compute-web'] };
    }

    case 'datastore': {
      if (matchesAny(hay, DS_RELATIONAL)) return { roles: ['db-relational'] };
      if (matchesAny(hay, DS_NOSQL)) return { roles: ['db-nosql'] };
      if (matchesAny(hay, DS_OBJECT)) return { roles: ['object-storage'] };
      if (matchesAny(hay, DS_SEARCH)) return { roles: ['search'] };
      // Unclear datastore → the safe default, recorded as an assumption.
      return { roles: ['db-relational'], defaultedDatastore: component.name };
    }

    case 'cache':
      return { roles: ['cache-redis'] };

    case 'queue': {
      if (matchesAny(hay, QUEUE_KAFKA)) return { roles: ['queue-kafka'] };
      return { roles: ['queue-basic'] };
    }

    case 'cdn':
      return { roles: ['cdn'] };

    default: {
      // Exhaustiveness guard: a new `kind` in the PRD enum must be handled here
      // rather than silently dropped. Never reached for the current 7 values.
      const _exhaustive: never = component.kind;
      return _exhaustive;
    }
  }
}

/**
 * True when the PRD implies file/image/upload handling, so `object-storage`
 * should be added even without an explicit `object` datastore (§3).
 */
function impliesObjectStorage(costContext: CostContext): boolean {
  const surfaces: string[] = [
    costContext.summary ?? '',
    ...costContext.components.map((c) => `${c.name} ${c.responsibility} ${c.technology}`),
  ];
  const hay = surfaces.join(' ').toLowerCase();
  return matchesAny(hay, OBJECT_STORAGE_SIGNALS);
}

/**
 * Map a PRD's architecture into the provider-agnostic set of `InfraRole`s the
 * app needs, plus the assumptions made along the way.
 *
 * Guarantees (all enforced by tests):
 *   - `external` components contribute NO role.
 *   - roles are DEDUPLICATED — three `compute-web` services collapse to one
 *     role; multiplicity lives in `UsageProfile.computeNodes`.
 *   - `egress` is ALWAYS present.
 *   - `object-storage` is added when the PRD implies uploads even with no
 *     explicit component.
 *   - an unclear `datastore` defaults to `db-relational` and the default is
 *     recorded in `assumptions`.
 *   - the returned `roles` array is in a stable, deterministic display order.
 */
export function mapComponentsToRoles(costContext: CostContext): {
  roles: InfraRole[];
  assumptions: string[];
} {
  const roleSet = new Set<InfraRole>();
  const assumptions: string[] = [];

  for (const component of costContext.components) {
    const result = rolesForComponent(component);
    if (result === null) continue; // external → no role
    for (const role of result.roles) roleSet.add(role);
    if (result.defaultedDatastore !== undefined) {
      assumptions.push(
        `Datastore "${result.defaultedDatastore}" did not name an engine, so a relational database (Postgres/MySQL) was assumed for cost estimation.`,
      );
    }
  }

  // §3: object-storage is added when the PRD implies file/image/upload handling
  // even without an explicit component.
  if (impliesObjectStorage(costContext) && !roleSet.has('object-storage')) {
    roleSet.add('object-storage');
    assumptions.push(
      'The product involves file/image/upload handling, so object storage was added even though no storage component was named.',
    );
  }

  // §3: egress is ALWAYS added. Data transfer out is routinely a top-three line
  // item on AWS/GCP/Azure and is invisible if you only price the boxes.
  roleSet.add('egress');

  // Return in the contract's display order so output is stable and comparable.
  const roles = INFRA_ROLE_ORDER.filter((r) => roleSet.has(r));

  return { roles, assumptions };
}

/* -------------------------------------------------------------------------- */
/* 2. Usage-profile derivation                                                */
/* -------------------------------------------------------------------------- */

/**
 * Representative MAU for each `userScale` bucket. The PRD enum defines the
 * buckets as ranges (`prototype` < 100 … `very-large` > 500k); we pick a single
 * representative point INSIDE each range to seed the sliders. Chosen near the
 * upper-middle of each band so the seed errs slightly high (a cost seed that is
 * a little conservative is the honest direction to miss — see docs §7). The
 * open-ended `very-large` band uses 1.5M, a defensible "well past 500k" point.
 */
const REPRESENTATIVE_MAU: Record<UserScale, number> = {
  prototype: 50, // < 100 band
  small: 500, // 100–1k band
  medium: 20_000, // 1k–50k band
  large: 200_000, // 50k–500k band
  'very-large': 1_500_000, // > 500k band
};

/*
 * Per-user monthly ratios. Each is a defensible average for a typical B2C-ish
 * web app; the UI lets the user override every one, so these are a STARTING
 * POINT, not a claim.
 */

/** Requests per MAU per month. An engaged user hits the app on the order of a
 *  few sessions a week, each firing tens of API/page requests → ~150/month.
 *  (≈ 4 sessions/week × ~9 requests/session × 4.3 weeks.) */
const REQUESTS_PER_MAU = 150;

/** Average response payload in KB. Mixed HTML/JSON/asset responses average
 *  around 60 KB once static assets are CDN-offloaded; drives origin egress. */
const AVG_RESPONSE_KB = 60;

/** Origin egress (bypassing the CDN — API/JSON responses, webhooks) in GB.
 *  = requests × avgResponseKb / 1,048,576 (KB per GB). Computed, not guessed. */
function originEgressGb(requests: number): number {
  return (requests * AVG_RESPONSE_KB) / 1_048_576;
}

/** CDN egress in GB per MAU. Static assets (JS/CSS/images/fonts) dominate real
 *  bandwidth: ~0.5 GB/user/month for an asset-rich app once the browser cache
 *  warms. Priced separately because CDN egress and origin egress bill
 *  differently on every provider. */
const CDN_EGRESS_GB_PER_MAU = 0.5;

/** CDN requests per MAU: asset fetches per user, ~40× page loads once you count
 *  every JS chunk, image and font on a modern SPA. */
const CDN_REQUESTS_PER_MAU = 40 * 6; // ~6 page loads/user/month × 40 assets each

/** Relational/document storage in GB per MAU. User rows, their content and
 *  indexes: ~2 MB/user/month accumulated is a defensible mid-point for a
 *  content app (0.002 GB). Floored below so a prototype still provisions a
 *  real, non-zero database. */
const DB_STORAGE_GB_PER_MAU = 0.002;
const DB_STORAGE_FLOOR_GB = 1; // smallest managed DB volume anyone provisions

/** Object storage in GB per MAU when the app stores uploads: ~5 MB/user of
 *  accumulated images/attachments (0.005 GB). Only used when the object-storage
 *  role is present; otherwise zero. */
const OBJECT_STORAGE_GB_PER_MAU = 0.005;

/** NoSQL reads:writes ratio and per-MAU volumes, when a NoSQL store is present.
 *  Read-heavy is the norm (~10:1). Writes scale with the request volume. */
const NOSQL_WRITES_PER_MAU = 60; // roughly 40% of requests are writes in a doc store
const NOSQL_READ_WRITE_RATIO = 10;

/** Queue messages per MAU per month, when a queue is present. Background events
 *  (emails, webhooks, async jobs) fire on the order of a handful per user. */
const QUEUE_MESSAGES_PER_MAU = 8;

/** Cache memory in GB. A cache holds hot rows, not all of them; it grows far
 *  slower than the DB. ~1 GB per 50k MAU, floored at the smallest real node. */
const CACHE_GB_PER_MAU = 1 / 50_000;
const CACHE_FLOOR_GB = 0.25;

/** Search index storage in GB, when a search role is present: ~30% of DB
 *  storage (only searchable fields are indexed). */
const SEARCH_INDEX_FRACTION_OF_DB = 0.3;

/** Serverless: invocations track requests (each request may be one function
 *  invocation on a serverless stack). Duration/memory are conservative
 *  mid-points for a typical handler. */
const AVG_SERVERLESS_DURATION_MS = 200; // a DB-backed handler, warm
const SERVERLESS_MEMORY_MB = 512; // a common default function size

/** Build minutes per month: CI runs on merges/deploys. A small team ships a
 *  few times a day; ~300 min/month is a defensible flat seed independent of
 *  user scale (build cost tracks commit cadence, not traffic). */
const BUILD_MINUTES_PER_MONTH = 300;

/**
 * `computeHoursPerNode` by traffic pattern. 730 = always on. A `spiky` or
 * serverless-leaning app genuinely does not run a full month of node-hours, so
 * seeding 730 everywhere would over-state always-on cost for bursty apps (docs
 * §7). These are the fraction of the month a representative node is up:
 *   - steady / seasonal / business-hours: effectively always-on managed nodes.
 *   - spiky: scale-to-zero-ish, ~55% duty cycle.
 *   - unknown: assume always-on (the safe, non-under-billing default) and the
 *     recommendation layer states the assumption.
 */
const COMPUTE_HOURS_BY_PATTERN: Record<TrafficPattern, number> = {
  steady: HOURS_PER_MONTH,
  seasonal: HOURS_PER_MONTH,
  'business-hours': HOURS_PER_MONTH, // still provisioned 24/7; managed nodes don't scale to zero nightly
  spiky: Math.round(HOURS_PER_MONTH * 0.55),
  unknown: HOURS_PER_MONTH,
};

/**
 * Peak sizing multiplier by traffic pattern — how much bigger the peak is than
 * the average. Drives default node COUNT: a spiky launch needs headroom a
 * steady app does not. Applied on top of the scale-based baseline node count.
 */
const PEAK_MULTIPLIER_BY_PATTERN: Record<TrafficPattern, number> = {
  steady: 1,
  'business-hours': 1.5, // weekday daytime peak over a 24h average
  seasonal: 2,
  spiky: 3, // launch/virality bursts
  unknown: 1.5,
};

/**
 * Baseline always-on node count by scale, before the peak multiplier. Bigger
 * scale runs more nodes; a prototype runs one. These are integers a human would
 * recognise as "how many boxes".
 */
const BASE_NODES_BY_SCALE: Record<UserScale, number> = {
  prototype: 1,
  small: 1,
  medium: 2,
  large: 4,
  'very-large': 10,
};

/**
 * `budgetBand` nudges default tier/node count. A `free-tier`/`hobby` user wants
 * the smallest thing that runs (clamp nodes down and shrink per-node specs); an
 * `enterprise` user expects headroom. Expressed as a multiplier on node count
 * and on per-node vCPU/RAM.
 */
const BUDGET_NODE_FACTOR: Record<BudgetBand, number> = {
  'free-tier': 0.5, // will be floored to 1 node
  hobby: 0.5,
  startup: 1,
  growth: 1.25,
  enterprise: 1.5,
};

const BUDGET_SPEC_FACTOR: Record<BudgetBand, { vcpu: number; memoryGb: number }> = {
  'free-tier': { vcpu: 0.5, memoryGb: 0.5 }, // shared-CPU micro nodes
  hobby: { vcpu: 0.5, memoryGb: 0.5 },
  startup: { vcpu: 1, memoryGb: 2 }, // 1 vCPU · 2 GB — a common small node
  growth: { vcpu: 2, memoryGb: 4 },
  enterprise: { vcpu: 4, memoryGb: 8 },
};

/** Round to `dp` decimal places deterministically (no floating-point surprises
 *  leaking into a schema-bound field). */
function round(value: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/**
 * Deterministically size a `UsageProfile` from `brief.context`. This seeds the
 * UI sliders — a starting point, not a claim. Every field is populated (a
 * partial profile cannot be totalled) and every value satisfies
 * `usageProfileSchema` bounds (asserted by `.parse` before returning).
 *
 * Which roles the PRD actually needs shapes a few fields (NoSQL/cache/search/
 * object volumes are only meaningful when that role is present), so we derive
 * the role set first and gate those quantities on it. Roles the app does not
 * use are seeded to zero rather than fabricated.
 *
 * PURE: no clock, no randomness, no env. Same context → identical profile.
 */
export function deriveUsageProfile(costContext: CostContext): UsageProfile {
  const { context } = costContext;
  const { roles } = mapComponentsToRoles(costContext);
  const has = (role: InfraRole): boolean => roles.includes(role);

  const mau = REPRESENTATIVE_MAU[context.userScale];
  const requests = mau * REQUESTS_PER_MAU;

  // Node count: scale baseline × budget factor × peak multiplier, floored at 1
  // so a running app always has at least one node.
  const baseNodes = BASE_NODES_BY_SCALE[context.userScale];
  const budgetNodeFactor = BUDGET_NODE_FACTOR[context.budgetBand];
  const peak = PEAK_MULTIPLIER_BY_PATTERN[context.trafficPattern];
  const computeNodes = has('compute-web')
    ? Math.max(1, Math.round(baseNodes * budgetNodeFactor * peak))
    : 0;

  const specFactor = BUDGET_SPEC_FACTOR[context.budgetBand];

  const dbStorageGb = has('db-relational')
    ? Math.max(DB_STORAGE_FLOOR_GB, round(mau * DB_STORAGE_GB_PER_MAU))
    : 0;

  const nosqlWrites = has('db-nosql') ? Math.round(mau * NOSQL_WRITES_PER_MAU) : 0;
  const objectStorageGb = has('object-storage') ? round(mau * OBJECT_STORAGE_GB_PER_MAU) : 0;

  const cacheGb = has('cache-redis')
    ? Math.max(CACHE_FLOOR_GB, round(mau * CACHE_GB_PER_MAU))
    : 0;

  const profile: UsageProfile = {
    monthlyActiveUsers: mau,
    monthlyRequests: Math.round(requests),
    avgResponseKb: AVG_RESPONSE_KB,

    computeNodes,
    // A spiky app runs fewer node-hours (scale-to-zero-ish); an always-on app
    // runs the full month.
    computeHoursPerNode: COMPUTE_HOURS_BY_PATTERN[context.trafficPattern],
    computeVcpuPerNode: specFactor.vcpu,
    computeMemoryGbPerNode: specFactor.memoryGb,

    // Serverless invocations track requests when a serverless compute role is
    // present; otherwise zero (a purely always-on app makes no function calls).
    serverlessInvocations: has('compute-serverless') ? Math.round(requests) : 0,
    avgServerlessDurationMs: AVG_SERVERLESS_DURATION_MS,
    serverlessMemoryMb: SERVERLESS_MEMORY_MB,

    dbStorageGb,
    // Backups default to one full copy of the DB volume (the standard managed
    // default retention).
    dbBackupGb: dbStorageGb,

    nosqlReadsPerMonth: nosqlWrites * NOSQL_READ_WRITE_RATIO,
    nosqlWritesPerMonth: nosqlWrites,
    nosqlStorageGb: has('db-nosql') ? Math.max(DB_STORAGE_FLOOR_GB, round(mau * DB_STORAGE_GB_PER_MAU)) : 0,

    cacheGb,

    queueMessagesPerMonth:
      has('queue-basic') || has('queue-kafka') ? Math.round(mau * QUEUE_MESSAGES_PER_MAU) : 0,

    objectStorageGb,
    // Write ops ≈ uploads (a fraction of requests); read ops ≈ 10× (assets are
    // read far more than written). Only when object storage is in use.
    objectWriteOpsPerMonth: has('object-storage') ? Math.round(requests * 0.1) : 0,
    objectReadOpsPerMonth: has('object-storage') ? Math.round(requests) : 0,

    // CDN volumes track MAU (asset delivery). Always seeded when a CDN role is
    // present; a static/SSR client without an explicit CDN still delivers
    // assets, but egress alone covers that case, so gate on the cdn role.
    cdnEgressGb: has('cdn') ? round(mau * CDN_EGRESS_GB_PER_MAU) : 0,
    cdnRequestsPerMonth: has('cdn') ? Math.round(mau * CDN_REQUESTS_PER_MAU) : 0,

    // Origin egress is ALWAYS non-zero — the egress role is always present.
    originEgressGb: round(originEgressGb(requests)),

    searchIndexGb: has('search') ? round(dbStorageGb * SEARCH_INDEX_FRACTION_OF_DB) : 0,

    buildMinutesPerMonth: BUILD_MINUTES_PER_MONTH,

    // Paid seats = the developer team, not end users. Seed from timeline: a
    // longer project implies a larger team. 1 seat per ~6 weeks of timeline,
    // floored at 1 (the schema minimum) and capped modestly.
    seats: Math.min(20, Math.max(1, Math.ceil(context.timelineWeeks / 6))),
  };

  // Assert every bound before handing the seed on: a profile that violates the
  // schema cannot be totalled, and catching it here beats a mystery downstream.
  return usageProfileSchema.parse(profile);
}
