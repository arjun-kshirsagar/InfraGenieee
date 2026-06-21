/**
 * InfraGenie — shared contract for Feature 2 (deployment cost predictor).
 *
 * SINGLE SOURCE OF TRUTH. Zod schemas are authoritative; TypeScript types are
 * inferred from them. Never hand-write a parallel interface — infer it here.
 *
 * Owned by: architect. Consumed by: backend (catalog, pricing layer, cost
 * engine, routes), frontend (selectors, live totals, comparison, citations).
 * Changes require an architect sign-off comment on the kanban board.
 *
 * Design rationale, the role↔service matrix, and the caching + anti-fabrication
 * strategy live in `docs/feature-2-cost-predictor.md`. Read that first.
 *
 * ## The shape of this feature
 *
 * A PRD from Feature 1 carries `architecture.components` (each with a `kind`)
 * plus `brief.context` (userScale, trafficPattern, budgetBand, timelineWeeks).
 * Feature 2 turns that into a live, editable cost model:
 *
 *   PrdDocument
 *      │  mapComponentsToRoles()        ← pure
 *      ▼
 *   InfraRole[]                         provider-agnostic needs ("we need a
 *      │                                 relational DB, a cache, a queue")
 *      │  deriveUsageProfile()          ← pure, from context; user-adjustable
 *      ▼
 *   UsageProfile                        the traffic/storage drivers
 *      │
 *      │  CATALOG: for each (provider, role) → CatalogService[] → CatalogSku[]
 *      │  PRICE BOOK: each SKU dimension → a fetched, cited PriceRecord
 *      ▼
 *   CostSelection (one per provider)  ──estimate()──▶  ProviderEstimate
 *                                        ← pure          │
 *                                                        ▼
 *                                                  CostComparison
 *
 * ## Three layers, and why they are separate
 *
 * 1. **Catalog** (`src/lib/cost/catalog/`) — *structure only*: which services
 *    each provider offers per role, which sizes, which price dimensions must be
 *    fetched, and the public pricing URL to fetch them from. THE CATALOG
 *    CONTAINS NO PRICES. That separation is what makes "never fabricate a
 *    price" mechanically enforceable rather than a promise.
 *
 * 2. **Price book** (`src/lib/cost/pricing/`) — *numbers only*, fetched from the
 *    provider's public pricing page via Tavily and validated by the evidence
 *    gate below. Every record carries `source.url`, `source.fetchedAt` and
 *    `source.evidence`.
 *
 * 3. **Engine** (`src/lib/cost/estimate/`) — *pure maths*. Same inputs → same
 *    outputs, no clock, no I/O, no `process.env`. It therefore runs UNCHANGED
 *    in the browser, which is what makes the totals update live as the user
 *    toggles choices without a round-trip per keystroke.
 *
 * ## The evidence gate (the anti-fabrication rule)
 *
 * An LLM reads the fetched page markdown and emits candidate price records. It
 * MUST also emit `evidence`: a verbatim substring of that page containing the
 * number. A pure TypeScript validator then asserts that
 *
 *   a) `evidence` really is a substring of the fetched page text, and
 *   b) the emitted `unitPriceUsd` literally appears inside `evidence`.
 *
 * Records failing either check are DISCARDED, not repaired. A model cannot
 * invent a price that survives a substring check against the real page. This is
 * the single most important invariant in Feature 2 — see
 * `assertEvidenceSupportsPrice` in the pricing layer.
 */

import { z } from 'zod';

import { briefContextSchema, architectureComponentSchema, infrastructureSchema } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Providers and regions                                                      */
/* -------------------------------------------------------------------------- */

export const cloudProviderSchema = z.enum(['aws', 'gcp', 'azure', 'vercel', 'digitalocean']);

export type CloudProvider = z.infer<typeof cloudProviderSchema>;

export const CLOUD_PROVIDERS = cloudProviderSchema.options;

export const PROVIDER_LABEL: Record<CloudProvider, string> = {
  aws: 'AWS',
  gcp: 'Google Cloud',
  azure: 'Microsoft Azure',
  vercel: 'Vercel',
  digitalocean: 'DigitalOcean',
};

/**
 * v1 prices exactly ONE region per provider — the provider's cheapest common
 * US region, which is also the one every pricing page defaults to.
 *
 * Multi-region is deliberately out of scope: it multiplies the fetch surface by
 * ~20x for a comparison the user does not need to make on day one. The UI MUST
 * surface the priced region so the number is never mistaken for a global truth.
 */
export const PRICED_REGION: Record<CloudProvider, string> = {
  aws: 'us-east-1',
  gcp: 'us-central1',
  azure: 'eastus',
  vercel: 'iad1',
  digitalocean: 'nyc3',
};

export const PRICED_REGION_LABEL: Record<CloudProvider, string> = {
  aws: 'US East (N. Virginia)',
  gcp: 'Iowa (us-central1)',
  azure: 'East US',
  vercel: 'Washington, D.C. (iad1)',
  digitalocean: 'New York 3 (NYC3)',
};

/* -------------------------------------------------------------------------- */
/* Infra roles — the provider-agnostic middle layer                           */
/* -------------------------------------------------------------------------- */

/**
 * A capability the app needs, independent of who sells it. Roles are the join
 * key between a PRD's architecture components and every provider's catalog:
 * that is what makes a side-by-side comparison meaningful (we compare Cloud SQL
 * against RDS because both fill `db-relational`, not because their names
 * rhyme).
 *
 * Derived from `architecture.components[].kind` (client | service | datastore |
 * cache | queue | external | cdn) plus the component's `technology` string —
 * see `mapComponentsToRoles`. `external` components are third-party SaaS the
 * customer already pays for and map to NO role (we must not invent a price for
 * someone else's Stripe bill).
 */
export const infraRoleSchema = z.enum([
  /** Always-on HTTP application server (SSR, API server, monolith). */
  'compute-web',
  /** Background workers / cron / job processors. */
  'compute-worker',
  /** Per-request functions billed on invocation + duration. */
  'compute-serverless',
  /** Static assets / SPA / prerendered pages. */
  'static-hosting',
  /** Managed SQL (Postgres/MySQL). */
  'db-relational',
  /** Managed document / key-value store at scale. */
  'db-nosql',
  /** Managed Redis-compatible cache. */
  'cache-redis',
  /** Simple managed queue (SQS / Pub/Sub / Service Bus / …). */
  'queue-basic',
  /** Kafka specifically — a genuinely different price class from a plain
   *  queue, so it is its own role rather than a SKU of `queue-basic`. */
  'queue-kafka',
  /** Blob / object storage. */
  'object-storage',
  /** CDN / edge cache in front of the app. */
  'cdn',
  /** Full-text search cluster. */
  'search',
  /** Data transfer out to the internet, priced on its own because on AWS/GCP/
   *  Azure it is frequently a top-three line item and is invisible otherwise. */
  'egress',
]);

export type InfraRole = z.infer<typeof infraRoleSchema>;

export const INFRA_ROLES = infraRoleSchema.options;

export const INFRA_ROLE_LABEL: Record<InfraRole, string> = {
  'compute-web': 'Web / API compute',
  'compute-worker': 'Background workers',
  'compute-serverless': 'Serverless functions',
  'static-hosting': 'Static hosting',
  'db-relational': 'Relational database',
  'db-nosql': 'NoSQL database',
  'cache-redis': 'Cache (Redis)',
  'queue-basic': 'Queue',
  'queue-kafka': 'Kafka / event streaming',
  'object-storage': 'Object storage',
  cdn: 'CDN',
  search: 'Search',
  egress: 'Data transfer (egress)',
};

/** Display order for the UI. Roles a user thinks about first come first. */
export const INFRA_ROLE_ORDER: readonly InfraRole[] = [
  'compute-web',
  'compute-serverless',
  'static-hosting',
  'compute-worker',
  'db-relational',
  'db-nosql',
  'cache-redis',
  'queue-basic',
  'queue-kafka',
  'object-storage',
  'cdn',
  'search',
  'egress',
];

/* -------------------------------------------------------------------------- */
/* Billable quantities — the only vocabulary the engine does maths in         */
/* -------------------------------------------------------------------------- */

/**
 * Every price dimension in the catalog declares ONE `quantityKey`. A pure
 * function (`deriveQuantities`) turns a `UsageProfile` + a chosen SKU into a
 * `Record<QuantityKey, number>`, and the engine then does exactly:
 *
 *     billable = max(0, quantity * multiplier - includedQuantity)
 *     cost     = billable * unitPriceUsd
 *
 * Keeping this list closed is what stops the engine from growing per-provider
 * special cases. If a provider bills on something not in this list, ADD A KEY
 * (with an architect sign-off) rather than smuggling maths into the catalog.
 */
export const quantityKeySchema = z.enum([
  /** Flat monthly charge; always 1. Plan fees, minimum commitments. */
  'months',
  /** Paid seats on a plan (Vercel Pro et al). */
  'seats',
  /** Instance-hours for one always-on node (730 = a full month). */
  'instanceHours',
  /** vCPU-hours, for CPU/memory-metered container platforms. */
  'vcpuHours',
  /** GiB-of-RAM-hours, same platforms. */
  'gbRamHours',
  /** vCPU-seconds — Cloud Run and friends quote per-second. */
  'vcpuSeconds',
  /** GiB-of-RAM-seconds. */
  'gbRamSeconds',
  /** Total HTTP requests served in the month. */
  'requests',
  /** Function invocations in the month. */
  'invocations',
  /** GB-seconds of function execution (invocations × duration × memory). */
  'gbSeconds',
  /** Active CPU hours (Vercel's fluid-compute metric). */
  'activeCpuHours',
  /** Database node-hours. */
  'dbInstanceHours',
  /** Provisioned DB storage, GB-month. */
  'dbStorageGbMonth',
  /** Backup storage beyond the free allowance, GB-month. */
  'dbBackupGbMonth',
  /** NoSQL read units / reads per month. */
  'nosqlReads',
  /** NoSQL write units / writes per month. */
  'nosqlWrites',
  /** NoSQL stored data, GB-month. */
  'nosqlStorageGbMonth',
  /** Cache node-hours. */
  'cacheInstanceHours',
  /** Cache memory, GB-month (for GB-priced caches). */
  'cacheGbMonth',
  /** Queue messages / operations per month. */
  'queueMessages',
  /** Kafka broker-hours. */
  'kafkaBrokerHours',
  /** Kafka storage, GB-month. */
  'kafkaStorageGbMonth',
  /** Object storage, GB-month. */
  'objectStorageGbMonth',
  /** Class-A / PUT-style operations per month. */
  'objectWriteOps',
  /** Class-B / GET-style operations per month. */
  'objectReadOps',
  /** CDN data transfer to the internet, GB. */
  'cdnEgressGb',
  /** CDN requests. */
  'cdnRequests',
  /** Origin/compute data transfer to the internet, GB. */
  'egressGb',
  /** Search node-hours. */
  'searchInstanceHours',
  /** Search index storage, GB-month. */
  'searchStorageGbMonth',
  /** CI/CD build minutes. */
  'buildMinutes',
]);

export type QuantityKey = z.infer<typeof quantityKeySchema>;

export const QUANTITY_KEYS = quantityKeySchema.options;

/** Hours in the billing month we model. 730 = 365×24/12, the number every
 *  provider's own pricing calculator uses. Fixed so estimates are comparable. */
export const HOURS_PER_MONTH = 730;

/* -------------------------------------------------------------------------- */
/* Catalog — structure only, NO PRICES                                        */
/* -------------------------------------------------------------------------- */

/**
 * One thing to fetch a number for. `extractionHint` is passed verbatim to the
 * price extractor and must pin the exact row on the page — instance type, DB
 * engine, AZ mode, region — or the extractor will pick a plausible neighbour.
 * Vague hints are the main source of wrong-but-real prices.
 */
export const priceDimensionSchema = z.object({
  /** Stable within a SKU, e.g. `instance-hour`, `storage-gb-month`. */
  id: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'dimension id must be kebab-case'),
  /** Shown in the per-service cost breakdown. */
  label: z.string().min(1).max(80),
  quantityKey: quantityKeySchema,
  /** Display-only, e.g. `USD / hour`, `USD / GB-month`. */
  unit: z.string().min(1).max(40),
  /**
   * When true, a missing price makes the whole SKU unpriceable and the UI must
   * say so rather than silently under-reporting. Optional dimensions (a request
   * charge on top of an hourly node, say) may be absent.
   */
  required: z.boolean().default(true),
  /** Instruction for the extractor. Be surgical — see the note above. */
  extractionHint: z.string().min(10).max(400),
});

export type PriceDimension = z.infer<typeof priceDimensionSchema>;

export const skuTierSchema = z.enum(['free', 'starter', 'small', 'medium', 'large', 'xlarge']);
export type SkuTier = z.infer<typeof skuTierSchema>;

/** Machine specs, for the size picker. All optional — a queue has no vCPU. */
export const skuSpecsSchema = z.object({
  vcpu: z.number().positive().max(512).optional(),
  memoryGb: z.number().positive().max(4096).optional(),
  storageGb: z.number().positive().max(65536).optional(),
  nodes: z.number().int().positive().max(100).optional(),
  /** One line the user can compare on, e.g. "2 vCPU · 4 GB · Multi-AZ off". */
  summary: z.string().max(120).optional(),
});

/**
 * A purchasable configuration. SKU ids are `provider:service:size` and are the
 * primary key of the whole feature — the price book, the selection, the LLM
 * recommendation and the estimate all reference them.
 */
export const catalogSkuSchema = z.object({
  id: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9]+:[a-z0-9-]+:[a-z0-9._-]+$/, 'sku id must be provider:service:size'),
  displayName: z.string().min(1).max(80),
  tier: skuTierSchema,
  specs: skuSpecsSchema.default({}),
  dimensions: z.array(priceDimensionSchema).min(1).max(12),
  /**
   * How many of this SKU the default sizing assumes (e.g. 2 web nodes). The
   * user can change it; it multiplies every per-unit quantity, never a flat
   * plan fee (`months`/`seats` are multiplier-exempt — see the engine).
   */
  defaultUnits: z.number().int().min(1).max(50).default(1),
  notes: z.string().max(300).optional(),
});

export type CatalogSku = z.infer<typeof catalogSkuSchema>;

/**
 * Editorial scores, 1–5. These are judgements, not prices, and are the input to
 * the "best scaling" / "simplest" badges — the reason the UI can offer a
 * recommendation that is not merely "cheapest".
 *
 * They must be justified in the service's `tradeoff` line. They are NOT allowed
 * to stand in for a missing price.
 */
export const serviceScoreSchema = z.number().int().min(1).max(5);

export const serviceKindSchema = z.enum([
  /** Provider runs the software; you pick a size. RDS, Cloud SQL. */
  'managed',
  /** Scale-to-zero, billed per use. Lambda, Cloud Run, Vercel functions. */
  'serverless',
  /** Raw VMs you operate. EC2, Droplets, GCE. */
  'iaas',
  /** Opinionated app platform. App Platform, App Service, Vercel. */
  'platform',
]);

export const catalogServiceSchema = z.object({
  /** `provider:service`, e.g. `aws:rds-postgres`. */
  id: z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9]+:[a-z0-9-]+$/, 'service id must be provider:service'),
  provider: cloudProviderSchema,
  role: infraRoleSchema,
  /** The vendor's real product name, spelled the vendor's way. */
  name: z.string().min(1).max(80),
  kind: serviceKindSchema,
  description: z.string().min(10).max(300),
  /** The page prices were fetched FROM. Must be the vendor's own public page. */
  pricingUrl: z.string().url(),
  docsUrl: z.string().url().optional(),
  scalingScore: serviceScoreSchema,
  simplicityScore: serviceScoreSchema,
  /** One honest sentence on when NOT to pick this. */
  tradeoff: z.string().min(10).max(240),
  /** What the vendor gives away, if anything. Free-tier text is a real,
   *  citable fact and belongs here; it is not a price. */
  freeTierNote: z.string().max(240).optional(),
  skus: z.array(catalogSkuSchema).min(1).max(12),
});

export type CatalogService = z.infer<typeof catalogServiceSchema>;

/**
 * The whole catalog, with the integrity rules that keep the three layers
 * joinable. These are parse errors on purpose: a typo'd SKU id would otherwise
 * surface as a mysteriously unpriced line item in the UI.
 */
export const serviceCatalogSchema = z
  .object({
    version: z.string().min(1),
    services: z.array(catalogServiceSchema).min(1),
  })
  .superRefine((cat, ctx) => {
    const serviceIds = new Set<string>();
    const skuIds = new Set<string>();

    cat.services.forEach((svc, i) => {
      if (serviceIds.has(svc.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', i, 'id'],
          message: `Duplicate service id "${svc.id}".`,
        });
      }
      serviceIds.add(svc.id);

      // A service id must agree with its provider, or the per-provider slice
      // that the UI builds will silently drop it.
      if (!svc.id.startsWith(`${svc.provider}:`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', i, 'id'],
          message: `Service id "${svc.id}" must be prefixed with provider "${svc.provider}:".`,
        });
      }

      svc.skus.forEach((sku, si) => {
        if (skuIds.has(sku.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['services', i, 'skus', si, 'id'],
            message: `Duplicate SKU id "${sku.id}".`,
          });
        }
        skuIds.add(sku.id);

        if (!sku.id.startsWith(`${svc.id}:`)) {
          ctx.addIssue({
            code: 'custom',
            path: ['services', i, 'skus', si, 'id'],
            message: `SKU id "${sku.id}" must be prefixed with service id "${svc.id}:".`,
          });
        }

        const dimIds = new Set<string>();
        sku.dimensions.forEach((d, di) => {
          if (dimIds.has(d.id)) {
            ctx.addIssue({
              code: 'custom',
              path: ['services', i, 'skus', si, 'dimensions', di, 'id'],
              message: `Duplicate dimension id "${d.id}" on SKU "${sku.id}".`,
            });
          }
          dimIds.add(d.id);
        });
      });
    });
  });

export type ServiceCatalog = z.infer<typeof serviceCatalogSchema>;

/* -------------------------------------------------------------------------- */
/* Price book — fetched numbers, always cited                                 */
/* -------------------------------------------------------------------------- */

/**
 * Provenance for one number. `evidence` is the load-bearing field: the pricing
 * layer proves it is a verbatim substring of the fetched page AND that it
 * contains the price. Without that proof the record is dropped.
 */
export const priceSourceSchema = z.object({
  url: z.string().url(),
  /** ISO-8601, when the page was fetched (not when it was parsed). */
  fetchedAt: z.string().min(20),
  /**
   * Verbatim excerpt from the page containing the number. Never paraphrased.
   *
   * The cap must be at least as large as a serialised price-feed record, because
   * docs §5 defines feed `evidence` AS "the serialised matched record" (the whole
   * Azure Retail / AWS Price List item, whitespace-padded so its numbers are
   * clean tokens). A real Azure Retail item serialises to ~750–900 chars; a cap
   * below that silently voids an entire provider's book (BLOCKER-3). 2000 keeps
   * a comfortable margin for the largest real feed records while still bounding
   * the field so a runaway blob cannot bloat the response. The substring/number
   * gate (`assertEvidenceSupportsPrice`) is unchanged — this only widens storage.
   */
  evidence: z.string().min(3).max(2000),
  /** Which model performed the extraction, for provenance across model swaps. */
  extractorModel: z.string().min(1).max(80),
});

export type PriceSource = z.infer<typeof priceSourceSchema>;

export const priceRecordSchema = z.object({
  skuId: z.string().min(3),
  dimensionId: z.string().min(1),
  /** USD. Zero is legal and meaningful — several dimensions are genuinely
   *  free (GCP ingress, DO bandwidth within the pooled allowance). */
  unitPriceUsd: z.number().min(0).max(1_000_000),
  /**
   * Free allowance in the SAME unit as the price, subtracted before charging.
   * Fetched from the page like everything else — an assumed free tier is a
   * fabricated discount.
   */
  includedQuantity: z.number().min(0).default(0),
  currency: z.literal('USD').default('USD'),
  source: priceSourceSchema,
});

export type PriceRecord = z.infer<typeof priceRecordSchema>;

/** Why a dimension has no price. Surfaced in the UI — never silently zeroed. */
export const priceGapSchema = z.object({
  skuId: z.string().min(3),
  dimensionId: z.string().min(1),
  reason: z.enum([
    'fetch_failed', // the page could not be retrieved
    'not_found_on_page', // extractor found nothing matching the hint
    'evidence_rejected', // failed the substring/number gate — treated as absent
    'ambiguous', // multiple conflicting candidates
    'invalid_record', // a candidate that passed the gate but failed schema validation
  ]),
  detail: z.string().max(300).optional(),
});

export type PriceGap = z.infer<typeof priceGapSchema>;

/**
 * All prices for one provider. Stored per-provider so a single failing vendor
 * page cannot invalidate the other four.
 */
export const priceBookSchema = z
  .object({
    provider: cloudProviderSchema,
    region: z.string().min(1),
    /** Bumped when the extraction pipeline changes shape. */
    pipelineVersion: z.string().min(1),
    /** ISO-8601 — when this book was assembled. */
    generatedAt: z.string().min(20),
    records: z.array(priceRecordSchema),
    gaps: z.array(priceGapSchema).default([]),
  })
  .superRefine((book, ctx) => {
    const seen = new Set<string>();
    book.records.forEach((r, i) => {
      const key = `${r.skuId}|${r.dimensionId}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['records', i],
          message: `Duplicate price for ${key} — the extractor must resolve conflicts, not emit both.`,
        });
      }
      seen.add(key);
    });
  });

export type PriceBook = z.infer<typeof priceBookSchema>;

/** How old a price may be before the UI must flag it. Provider pricing moves on
 *  a scale of months, so a week is generous for accuracy and kind to the API
 *  quota. Past this the UI shows a "prices may be stale" affordance; it does
 *  NOT hide the number, because a stale real price beats no price. */
export const PRICE_MAX_AGE_DAYS = 7;

/* -------------------------------------------------------------------------- */
/* Usage profile — the drivers the user can turn                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything the cost of a deployment depends on, in units a product person can
 * reason about. Seeded deterministically from `brief.context` by
 * `deriveUsageProfile` and then freely adjustable in the UI — the seed is a
 * starting point, not a claim.
 *
 * Bounds exist so a fat-fingered "1000000000" cannot render a $40bn estimate
 * that destroys trust in the whole tool.
 */
export const usageProfileSchema = z.object({
  monthlyActiveUsers: z.number().min(0).max(50_000_000),
  monthlyRequests: z.number().min(0).max(50_000_000_000),
  /** Average response payload, drives egress. */
  avgResponseKb: z.number().min(0.1).max(10_000),
  /** Always-on nodes the app runs (per always-on compute SKU). */
  computeNodes: z.number().int().min(0).max(200),
  /** Hours each node runs. 730 = always on; lower models scale-to-zero-ish. */
  computeHoursPerNode: z.number().min(0).max(HOURS_PER_MONTH),
  /** Average vCPU actually consumed per node, for metered platforms. */
  computeVcpuPerNode: z.number().min(0.05).max(128),
  /** Average GiB RAM per node, for metered platforms. */
  computeMemoryGbPerNode: z.number().min(0.06).max(1024),
  serverlessInvocations: z.number().min(0).max(50_000_000_000),
  avgServerlessDurationMs: z.number().min(1).max(900_000),
  serverlessMemoryMb: z.number().min(64).max(10_240),
  dbStorageGb: z.number().min(0).max(65_536),
  dbBackupGb: z.number().min(0).max(65_536),
  nosqlReadsPerMonth: z.number().min(0).max(50_000_000_000),
  nosqlWritesPerMonth: z.number().min(0).max(50_000_000_000),
  nosqlStorageGb: z.number().min(0).max(65_536),
  cacheGb: z.number().min(0).max(1024),
  queueMessagesPerMonth: z.number().min(0).max(50_000_000_000),
  objectStorageGb: z.number().min(0).max(1_000_000),
  objectWriteOpsPerMonth: z.number().min(0).max(10_000_000_000),
  objectReadOpsPerMonth: z.number().min(0).max(10_000_000_000),
  cdnEgressGb: z.number().min(0).max(10_000_000),
  cdnRequestsPerMonth: z.number().min(0).max(500_000_000_000),
  /** Egress that bypasses the CDN (API responses, webhooks). */
  originEgressGb: z.number().min(0).max(10_000_000),
  searchIndexGb: z.number().min(0).max(10_000),
  buildMinutesPerMonth: z.number().min(0).max(100_000),
  /** Paid seats — the developer team, not end users. */
  seats: z.number().int().min(1).max(500),
});

export type UsageProfile = z.infer<typeof usageProfileSchema>;

/** Which usage fields the UI exposes as first-class sliders, in order. The
 *  rest live behind an "advanced" disclosure. Chosen because these five move
 *  the total most across all five providers. */
export const HEADLINE_USAGE_KEYS: readonly (keyof UsageProfile)[] = [
  'monthlyActiveUsers',
  'monthlyRequests',
  'dbStorageGb',
  'cdnEgressGb',
  'computeNodes',
];

/* -------------------------------------------------------------------------- */
/* Selection — what the user has chosen for one provider                      */
/* -------------------------------------------------------------------------- */

export const roleChoiceSchema = z.object({
  role: infraRoleSchema,
  serviceId: z.string().min(3),
  skuId: z.string().min(3),
  /** How many of this SKU. Multiplies per-unit quantities only. */
  units: z.number().int().min(1).max(200).default(1),
  /** Unchecked roles stay visible (so the user sees what they turned off) but
   *  contribute nothing. */
  enabled: z.boolean().default(true),
});

export type RoleChoice = z.infer<typeof roleChoiceSchema>;

export const costSelectionSchema = z
  .object({
    provider: cloudProviderSchema,
    choices: z.array(roleChoiceSchema).max(INFRA_ROLES.length),
  })
  .superRefine((sel, ctx) => {
    // One choice per role: two answers for "which database" is not a state the
    // comparison UI can render or the engine can total.
    const seen = new Set<InfraRole>();
    sel.choices.forEach((c, i) => {
      if (seen.has(c.role)) {
        ctx.addIssue({
          code: 'custom',
          path: ['choices', i, 'role'],
          message: `Duplicate choice for role "${c.role}".`,
        });
      }
      seen.add(c.role);

      if (!c.skuId.startsWith(`${c.serviceId}:`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['choices', i, 'skuId'],
          message: `SKU "${c.skuId}" does not belong to service "${c.serviceId}".`,
        });
      }
      if (!c.serviceId.startsWith(`${sel.provider}:`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['choices', i, 'serviceId'],
          message: `Service "${c.serviceId}" is not a ${sel.provider} service.`,
        });
      }
    });
  });

export type CostSelection = z.infer<typeof costSelectionSchema>;

/* -------------------------------------------------------------------------- */
/* Estimate — the engine's output                                             */
/* -------------------------------------------------------------------------- */

/** One priced dimension of one line item. Carries its own citation so the UI
 *  can show "where does this number come from?" at the row level. */
export const costDimensionResultSchema = z.object({
  dimensionId: z.string(),
  label: z.string(),
  unit: z.string(),
  quantityKey: quantityKeySchema,
  /** Quantity before the free allowance. */
  quantity: z.number().min(0),
  includedQuantity: z.number().min(0),
  /** `max(0, quantity - includedQuantity)`. */
  billableQuantity: z.number().min(0),
  unitPriceUsd: z.number().min(0),
  monthlyUsd: z.number().min(0),
  source: priceSourceSchema.nullable(),
  /** True when no price survived the evidence gate; `monthlyUsd` is 0 and the
   *  UI MUST render this as "unpriced", never as free. */
  unpriced: z.boolean().default(false),
});

export type CostDimensionResult = z.infer<typeof costDimensionResultSchema>;

export const costLineItemSchema = z.object({
  role: infraRoleSchema,
  serviceId: z.string(),
  serviceName: z.string(),
  skuId: z.string(),
  skuName: z.string(),
  units: z.number().int().min(1),
  dimensions: z.array(costDimensionResultSchema),
  monthlyUsd: z.number().min(0),
  /** True when a `required` dimension is unpriced — the line total is a floor,
   *  not an estimate. */
  incomplete: z.boolean().default(false),
});

export type CostLineItem = z.infer<typeof costLineItemSchema>;

export const providerEstimateSchema = z.object({
  provider: cloudProviderSchema,
  region: z.string(),
  items: z.array(costLineItemSchema),
  monthlyUsd: z.number().min(0),
  /** Roles the PRD needs that this provider cannot fill (e.g. Kafka on Vercel).
   *  Shown as an explicit gap — a provider is not "cheaper" because it is
   *  missing a component the app requires. */
  unsupportedRoles: z.array(infraRoleSchema).default([]),
  /** Any required dimension anywhere in `items` is unpriced. */
  incomplete: z.boolean().default(false),
  /** ISO-8601 of the oldest price used, for the staleness affordance. */
  oldestPriceAt: z.string().nullable(),
  warnings: z.array(z.string().max(300)).default([]),
});

export type ProviderEstimate = z.infer<typeof providerEstimateSchema>;

/**
 * The comparison. Badge winners are nullable because with one provider selected
 * (or with every estimate incomplete) there is no honest winner to name.
 *
 * `cheapest` considers only COMPLETE estimates: crowning a provider whose
 * database price failed to fetch would be actively misleading.
 */
export const costComparisonSchema = z.object({
  generatedAt: z.string().min(20),
  estimates: z.array(providerEstimateSchema).min(1),
  cheapest: cloudProviderSchema.nullable(),
  bestScaling: cloudProviderSchema.nullable(),
  simplest: cloudProviderSchema.nullable(),
});

export type CostComparison = z.infer<typeof costComparisonSchema>;

/* -------------------------------------------------------------------------- */
/* AI recommendation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The PRD slice Feature 2 needs. PRDs live in localStorage (Feature 1 has no
 * server persistence), so the client POSTs this slice rather than an id.
 *
 * It is deliberately the minimum: context drives sizing, components drive
 * roles, infrastructure gives the AI the reasoning Feature 1 already did. The
 * user stories and plan are irrelevant to cost and are not sent.
 */
export const costContextSchema = z.object({
  title: z.string().min(1).max(120),
  /** Verbatim from `PrdDocument.brief.context`. */
  context: briefContextSchema,
  /** Verbatim from `PrdDocument.architecture.components`. */
  components: z.array(architectureComponentSchema).min(1).max(40),
  /** Verbatim from `PrdDocument.architecture.infrastructure`. */
  infrastructure: infrastructureSchema.optional(),
  /** Optional one-liner so the AI knows what the product is. */
  summary: z.string().max(1000).optional(),
});

export type CostContext = z.infer<typeof costContextSchema>;

export const providerTradeoffSchema = z.object({
  provider: cloudProviderSchema,
  /** Why this provider suits THIS app — must reference scale/traffic/budget. */
  pros: z.array(z.string().max(240)).min(1).max(5),
  cons: z.array(z.string().max(240)).min(1).max(5),
});

/**
 * Model output for the recommendation stage.
 *
 * Validated twice: by this schema, then by a deterministic catalog check that
 * every `serviceId`/`skuId` exists and fills the role it claims. An id the
 * model invented is dropped and the role falls back to the catalog default —
 * the same "don't trust, verify" posture as the evidence gate. See
 * `docs/feature-2-cost-predictor.md`.
 */
export const costRecommendationSchema = z.object({
  recommendedProvider: cloudProviderSchema,
  /** 2–4 sentences, referencing the brief. Shown above the selector. */
  rationale: z.string().min(40).max(1200),
  /** Sizing the AI chose, which seeds the sliders. */
  usageProfile: usageProfileSchema,
  /** What it assumed where the PRD was silent — same first-class treatment as
   *  `prd.assumptions` in Feature 1. */
  assumptions: z.array(z.string().max(300)).min(1).max(10),
  /** One seeded selection per provider the app can run on. */
  selections: z.array(costSelectionSchema).min(1).max(CLOUD_PROVIDERS.length),
  tradeoffs: z.array(providerTradeoffSchema).min(1).max(CLOUD_PROVIDERS.length),
});

export type CostRecommendation = z.infer<typeof costRecommendationSchema>;

/** Stage output for the LLM call — everything except the sizing, which we
 *  derive deterministically and then let the model nudge. Keeping the model out
 *  of raw arithmetic is the same split Feature 1 uses for Mermaid/graph maths. */
export const costRecommendationDraftSchema = z.object({
  recommendedProvider: cloudProviderSchema,
  rationale: z.string().min(40).max(1200),
  assumptions: z.array(z.string().max(300)).min(1).max(10),
  selections: z.array(costSelectionSchema).min(1).max(CLOUD_PROVIDERS.length),
  tradeoffs: z.array(providerTradeoffSchema).min(1).max(CLOUD_PROVIDERS.length),
});

export type CostRecommendationDraft = z.infer<typeof costRecommendationDraftSchema>;

/* -------------------------------------------------------------------------- */
/* API envelopes                                                              */
/* -------------------------------------------------------------------------- */

/** `GET /api/cost/catalog` — static structure for the selectors. */
export const catalogResponseSchema = z.object({
  catalog: serviceCatalogSchema,
});

/** `GET /api/cost/prices` — the price books the client needs to do live maths. */
export const pricesResponseSchema = z.object({
  books: z.array(priceBookSchema),
});

/** `POST /api/cost/recommend` */
export const recommendRequestSchema = z.object({
  costContext: costContextSchema,
});

export const recommendResponseSchema = z.object({
  recommendation: costRecommendationSchema,
});

/**
 * `POST /api/cost/estimate` — server-side evaluation of the same pure engine
 * the client runs. It exists for tests, for shareable links, and as the
 * authority if the two ever disagree; the interactive UI does NOT call it on
 * every toggle.
 */
export const estimateRequestSchema = z.object({
  usage: usageProfileSchema,
  selections: z.array(costSelectionSchema).min(1).max(CLOUD_PROVIDERS.length),
  /** Roles the PRD requires, so `unsupportedRoles` can be computed. */
  requiredRoles: z.array(infraRoleSchema).default([]),
});

export const estimateResponseSchema = z.object({
  comparison: costComparisonSchema,
});

export type CatalogResponse = z.infer<typeof catalogResponseSchema>;
export type PricesResponse = z.infer<typeof pricesResponseSchema>;
export type RecommendRequest = z.infer<typeof recommendRequestSchema>;
export type RecommendResponse = z.infer<typeof recommendResponseSchema>;
export type EstimateRequest = z.infer<typeof estimateRequestSchema>;
export type EstimateResponse = z.infer<typeof estimateResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Versioning                                                                 */
/* -------------------------------------------------------------------------- */

/** Bumped when the catalog's shape or contents change materially. */
export const CATALOG_VERSION = '1.0.0';

/** Bumped when the fetch/extract/validate pipeline changes. A price book whose
 *  `pipelineVersion` is older than this is refetched rather than trusted. */
export const PRICING_PIPELINE_VERSION = '1.0.0';
