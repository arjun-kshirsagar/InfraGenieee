/**
 * Vercel half of the Feature 2 service catalog — STRUCTURE ONLY, NO PRICES.
 *
 * As with the other providers, this file declares only *what* to fetch and
 * *where*. No price lives here (there is no field for one), not even in a
 * comment. Numbers arrive only as fetched, cited `PriceRecord`s through the
 * evidence gate — see `docs/feature-2-cost-predictor.md` §5.
 *
 * Priced region: iad1 / "Washington, D.C. (iad1)" (see `PRICED_REGION`).
 * Vercel prices data transfer *regionally*; iad1 sits in the North America
 * pricing zone, so the egress/CDN hints pin that zone.
 *
 * ## Sourcing notes (why these URLs)
 *
 * Per §4 of the design doc, Vercel extracts cleanly via Tavily and carries real
 * plan + overage numbers. The verified-good pages (fetched 2026-07-26) are
 * `vercel.com/pricing`, `vercel.com/docs/pricing` and
 * `vercel.com/docs/pricing/networking`. **`vercel.com/docs/pricing/functions`
 * is in the known-bad table (0 prices)** and is never referenced here.
 *
 * ## Billing model — plan fee + seats, then metered usage
 *
 * Vercel is not a per-box cloud. It bills a **flat plan fee** (Pro is a
 * monthly-per-team charge) plus **paid seats**, and then meters compute
 * (Fluid active-CPU + invocations), CDN transfer and Blob on top with a chunk
 * of included usage. Per rule 6, the plan fee uses `months` and seats use
 * `seats` — and the engine never multiplies those by `units` (you do not pay
 * for Pro twice because you deployed two functions). The metered dimensions use
 * their natural usage keys and DO scale with usage.
 *
 * ## Coverage — Vercel's gaps are intentional (§9)
 *
 * Vercel genuinely does NOT offer `compute-worker` (no always-on worker),
 * `db-relational` (partner/marketplace only), `db-nosql`, `cache-redis`,
 * `queue-basic`, `queue-kafka` or `search`. Those roles are OMITTED here on
 * purpose: a PRD needing Postgres + Kafka must surface an honest "Vercel cannot
 * run this alone" gap rather than a misleadingly cheap total. Do not invent a
 * Vercel service to fill them.
 */

import type { CatalogServiceInput } from './types';

export const vercelServices: CatalogServiceInput[] = [
  /* ------------------------------------------------------------------ */
  /* Plan fee + seats — the flat cost of being on Vercel Pro           */
  /*                                                                    */
  /* Modelled as a compute-web service because a Vercel app is deployed */
  /* as web compute; the plan fee + seats are the baseline every        */
  /* non-Hobby estimate carries. `months`/`seats` are multiplier-exempt */
  /* in the engine (rule 6).                                            */
  /* ------------------------------------------------------------------ */
  {
    id: 'vercel:fluid-compute',
    provider: 'vercel',
    role: 'compute-web',
    name: 'Vercel (Fluid compute)',
    kind: 'platform',
    description:
      'Vercel deploys your app as Fluid compute — serverless that keeps warm instances to avoid cold starts, billed on active CPU time and invocations on top of the plan fee. The Pro plan adds a flat monthly fee plus paid seats.',
    pricingUrl: 'https://vercel.com/pricing',
    docsUrl: 'https://vercel.com/docs/fluid-compute',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'The plan fee plus per-active-CPU metering can beat a raw VM only up to a point — a steady, high-CPU 24/7 workload is cheaper on a reserved instance elsewhere.',
    freeTierNote:
      'The Hobby plan is free for personal, non-commercial projects; the Pro plan includes a monthly usage credit before metered overage applies.',
    skus: [
      {
        id: 'vercel:fluid-compute:pro',
        displayName: 'Vercel Pro',
        tier: 'small',
        specs: { summary: 'Pro plan · flat monthly fee + paid seats + metered Fluid compute' },
        dimensions: [
          {
            id: 'plan-fee',
            label: 'Pro plan fee',
            quantityKey: 'months',
            unit: 'USD / month',
            extractionHint:
              'Vercel Pro plan flat price per month (the Pro plan base monthly fee) from the vercel.com/pricing plan comparison — the per-team monthly charge, applies in all regions.',
          },
          {
            id: 'seat',
            label: 'Additional paid seats',
            quantityKey: 'seats',
            unit: 'USD / seat / month',
            extractionHint:
              'Vercel Pro additional paid seat price per seat per month from vercel.com/pricing (the per-member seat charge on the Pro plan), applies in all regions.',
            required: false,
          },
          {
            id: 'active-cpu-hour',
            label: 'Active CPU',
            quantityKey: 'activeCpuHours',
            unit: 'USD / active CPU-hour',
            extractionHint:
              'Vercel Fluid compute Active CPU price per active CPU-hour from vercel.com/docs/pricing, the on-demand rate after included usage, applies in all regions (North America / iad1).',
          },
          {
            id: 'invocations',
            label: 'Function invocations',
            quantityKey: 'invocations',
            unit: 'USD / million invocations',
            extractionHint:
              'Vercel Function Invocations price per 1M invocations from vercel.com/docs/pricing, the on-demand rate after the included allowance, applies in all regions.',
            required: false,
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* compute-serverless  (Vercel Functions)                            */
  /* ------------------------------------------------------------------ */
  {
    id: 'vercel:functions',
    provider: 'vercel',
    role: 'compute-serverless',
    name: 'Vercel Functions',
    kind: 'serverless',
    description:
      'Per-request functions on Vercel, billed on invocations and active CPU time (via Fluid compute) after the plan allowance. Scale to zero; ideal for API routes and event handlers.',
    pricingUrl: 'https://vercel.com/docs/pricing',
    docsUrl: 'https://vercel.com/docs/functions',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'At sustained high call rates the per-active-CPU rate overtakes an always-on container — Functions win on spiky, event-driven load, not steady traffic.',
    freeTierNote: 'Each plan includes a monthly allowance of invocations and active CPU before metered overage applies.',
    skus: [
      {
        id: 'vercel:functions:on-demand',
        displayName: 'Vercel Functions (on-demand)',
        tier: 'small',
        specs: { summary: 'On-demand · per invocation + active CPU · scale-to-zero' },
        dimensions: [
          {
            id: 'invocations',
            label: 'Invocations',
            quantityKey: 'invocations',
            unit: 'USD / million invocations',
            extractionHint:
              'Vercel Function Invocations price per 1M invocations from vercel.com/docs/pricing, the on-demand rate after the included allowance, applies in all regions.',
          },
          {
            id: 'active-cpu-hour',
            label: 'Active CPU',
            quantityKey: 'activeCpuHours',
            unit: 'USD / active CPU-hour',
            extractionHint:
              'Vercel Fluid compute Active CPU price per active CPU-hour from vercel.com/docs/pricing, the on-demand rate after included usage, applies in all regions (North America / iad1).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* static-hosting                                                    */
  /* ------------------------------------------------------------------ */
  {
    id: 'vercel:static',
    provider: 'vercel',
    role: 'static-hosting',
    name: 'Vercel Static Hosting',
    kind: 'platform',
    description:
      'Static assets and prerendered pages served from Vercel’s global Edge Network. Delivery is billed as Fast Data Transfer and Edge Requests on top of the plan; each plan includes an allowance.',
    pricingUrl: 'https://vercel.com/docs/pricing/networking',
    docsUrl: 'https://vercel.com/docs/edge-network',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'Static delivery is bundled with the app platform — there is no cheaper standalone static plan, so a very high-traffic static-only site can be cheaper on an object-store + CDN elsewhere.',
    freeTierNote: 'Hobby includes 100 GB and Pro 1 TB of Fast Data Transfer per month before overage.',
    skus: [
      {
        id: 'vercel:static:edge',
        displayName: 'Static on Edge Network',
        tier: 'small',
        specs: { summary: 'Global Edge Network · Fast Data Transfer + Edge Requests' },
        dimensions: [
          {
            id: 'data-transfer-gb',
            label: 'Fast Data Transfer',
            quantityKey: 'cdnEgressGb',
            unit: 'USD / GB',
            extractionHint:
              'Vercel Fast Data Transfer on-demand price per 1 GB from vercel.com/docs/pricing/networking, after the included allowance, for the North America / iad1 pricing region.',
          },
          {
            id: 'edge-requests',
            label: 'Edge Requests',
            quantityKey: 'cdnRequests',
            unit: 'USD / million requests',
            extractionHint:
              'Vercel Edge Requests on-demand price per 1M requests from vercel.com/docs/pricing/networking, after the included allowance, applies in all regions.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* object-storage  (Vercel Blob)                                     */
  /* ------------------------------------------------------------------ */
  {
    id: 'vercel:blob',
    provider: 'vercel',
    role: 'object-storage',
    name: 'Vercel Blob',
    kind: 'serverless',
    description:
      'S3-backed object storage integrated with Vercel. Billed on average stored GB-month, simple/advanced operations and blob data transfer, on top of the plan allowance.',
    pricingUrl: 'https://vercel.com/docs/vercel-blob/usage-and-pricing',
    docsUrl: 'https://vercel.com/docs/vercel-blob',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'Convenient inside the Vercel app but priced above raw S3 — a very large or write-heavy blob workload is cheaper on a dedicated object store.',
    freeTierNote: 'Each plan includes a monthly allowance of Blob storage and operations before metered overage.',
    skus: [
      {
        id: 'vercel:blob:standard',
        displayName: 'Vercel Blob',
        tier: 'small',
        specs: { summary: 'Stored GB-month + operations + data transfer' },
        dimensions: [
          {
            id: 'storage-gb-month',
            label: 'Stored data',
            quantityKey: 'objectStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'Vercel Blob storage price per GB-month (monthly average store size) from vercel.com/docs/vercel-blob/usage-and-pricing, the on-demand rate after the included allowance, applies in all regions.',
          },
          {
            id: 'advanced-ops',
            label: 'Advanced operations (writes)',
            quantityKey: 'objectWriteOps',
            unit: 'USD / million operations',
            extractionHint:
              'Vercel Blob Advanced Operations price per million operations (put, copy, list) from vercel.com/docs/vercel-blob/usage-and-pricing, after the included allowance, applies in all regions.',
          },
          {
            id: 'simple-ops',
            label: 'Simple operations (reads)',
            quantityKey: 'objectReadOps',
            unit: 'USD / million operations',
            extractionHint:
              'Vercel Blob Simple Operations price per million operations (cache-miss URL access, head) from vercel.com/docs/vercel-blob/usage-and-pricing, after the included allowance, applies in all regions.',
            required: false,
          },
          {
            id: 'data-transfer-gb',
            label: 'Blob data transfer',
            quantityKey: 'egressGb',
            unit: 'USD / GB',
            extractionHint:
              'Vercel Blob Data Transfer price per 1 GB from vercel.com/docs/vercel-blob/usage-and-pricing, after the included allowance, for the North America / iad1 pricing region.',
            required: false,
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* cdn  (Edge Network)                                               */
  /* ------------------------------------------------------------------ */
  {
    id: 'vercel:edge-network',
    provider: 'vercel',
    role: 'cdn',
    name: 'Vercel Edge Network',
    kind: 'platform',
    description:
      'Vercel’s global CDN in front of every deployment. Billed as Fast Data Transfer (per GB) and Edge Requests (per request) after the plan allowance, priced regionally.',
    pricingUrl: 'https://vercel.com/docs/pricing/networking',
    docsUrl: 'https://vercel.com/docs/edge-network',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'Per-GB transfer is competitive at low-to-mid volume but climbs at very high sustained egress, where a bandwidth-pooled provider can be cheaper.',
    freeTierNote: 'Hobby includes 100 GB and Pro 1 TB of Fast Data Transfer per month before overage.',
    skus: [
      {
        id: 'vercel:edge-network:standard',
        displayName: 'Edge Network',
        tier: 'small',
        specs: { summary: 'Global CDN · Fast Data Transfer + Edge Requests · North America' },
        dimensions: [
          {
            id: 'data-transfer-gb',
            label: 'Fast Data Transfer',
            quantityKey: 'cdnEgressGb',
            unit: 'USD / GB',
            extractionHint:
              'Vercel Fast Data Transfer on-demand price per 1 GB from vercel.com/docs/pricing/networking, after the included allowance, for the North America / iad1 pricing region.',
          },
          {
            id: 'edge-requests',
            label: 'Edge Requests',
            quantityKey: 'cdnRequests',
            unit: 'USD / million requests',
            extractionHint:
              'Vercel Edge Requests on-demand price per 1M requests from vercel.com/docs/pricing/networking, after the included allowance, applies in all regions.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* egress  (Fast Origin Transfer — origin → edge/internet)          */
  /* ------------------------------------------------------------------ */
  {
    id: 'vercel:egress',
    provider: 'vercel',
    role: 'egress',
    name: 'Vercel Fast Origin Transfer',
    kind: 'platform',
    description:
      'Data transferred from your functions/origin out through Vercel’s network, billed per GB (Fast Origin Transfer) after the plan allowance. Distinct from edge-to-user Fast Data Transfer.',
    pricingUrl: 'https://vercel.com/docs/pricing/networking',
    docsUrl: 'https://vercel.com/docs/pricing/networking',
    scalingScore: 3,
    simplicityScore: 4,
    tradeoff:
      'Origin transfer is charged on cache MISS — improving cache hit ratio is the main lever to reduce it before switching providers.',
    freeTierNote: 'Each plan includes a monthly Fast Origin Transfer allowance before metered overage.',
    skus: [
      {
        id: 'vercel:egress:origin',
        displayName: 'Fast Origin Transfer',
        tier: 'small',
        specs: { summary: 'Origin → network · per GB · North America pricing region' },
        dimensions: [
          {
            id: 'origin-transfer-gb',
            label: 'Fast Origin Transfer',
            quantityKey: 'egressGb',
            unit: 'USD / GB',
            extractionHint:
              'Vercel Fast Origin Transfer on-demand price per 1 GB from vercel.com/docs/pricing/networking, after the included allowance, for the North America / iad1 pricing region.',
          },
        ],
      },
    ],
  },
];
