/**
 * GCP half of the Feature 2 service catalog — STRUCTURE ONLY, NO PRICES.
 *
 * As with `aws.ts`, this file declares only what to fetch and where. No price
 * lives here (there is no field for one), not even in a comment. Numbers arrive
 * only as fetched, cited `PriceRecord`s through the evidence gate — see
 * `docs/feature-2-cost-predictor.md` §5.
 *
 * Priced region: us-central1 / "Iowa (us-central1)" (see `PRICED_REGION`).
 *
 * ## Sourcing notes (why these URLs)
 *
 * Per §4 of the design doc, GCP pricing pages extract cleanly via Tavily and
 * carry real per-unit rows. Each URL below was fetched on 2026-07-26 and
 * verified to contain numbers for us-central1 (e.g. Cloud Run CPU per
 * vCPU-second, Cloud SQL vCPU/hour, Memorystore per GiB-hour). The known-bad
 * URLs from the design doc are deliberately avoided: `cloud.google.com/
 * compute/all-pricing` (index only → use the general-purpose page) and
 * `cloud.google.com/functions/pricing` (nav-only; Cloud Run is the current
 * product → use `cloud.google.com/run/pricing`).
 *
 * ## Coverage
 *
 * GCP `search` is `—` in §9 of the design doc (self-host only). It is
 * intentionally absent here — we do not invent a managed search service GCP
 * does not sell.
 */

import { HOURS_PER_MONTH } from '@/types/cost';

import type { CatalogServiceInput } from './types';

export const gcpServices: CatalogServiceInput[] = [
  /* ------------------------------------------------------------------ */
  /* compute-web                                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:compute-engine',
    provider: 'gcp',
    role: 'compute-web',
    name: 'Compute Engine',
    kind: 'iaas',
    description:
      'Raw Linux virtual machines you operate yourself. Cheapest steady-state compute on GCP, in exchange for running your own OS, autoscaler and load balancer.',
    pricingUrl: 'https://cloud.google.com/products/compute/pricing/general-purpose',
    docsUrl: 'https://cloud.google.com/compute/docs',
    scalingScore: 3,
    simplicityScore: 2,
    tradeoff:
      'You own OS patching, autoscaling and the load balancer — choose Cloud Run if you want the platform to manage lifecycle for you.',
    freeTierNote: 'One non-preemptible e2-micro VM per month in us-west1/us-central1/us-east1 (Free Tier).',
    skus: [
      {
        id: 'gcp:compute-engine:e2-small',
        displayName: 'e2-small',
        tier: 'starter',
        specs: { vcpu: 2, memoryGb: 2, summary: '2 vCPU (shared) · 2 GB · cost-optimised' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'VM runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-demand (default) hourly price for an e2-small predefined machine type in Iowa (us-central1).',
          },
        ],
      },
      {
        id: 'gcp:compute-engine:e2-medium',
        displayName: 'e2-medium',
        tier: 'small',
        specs: { vcpu: 2, memoryGb: 4, summary: '2 vCPU (shared) · 4 GB · cost-optimised' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'VM runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-demand (default) hourly price for an e2-medium predefined machine type in Iowa (us-central1).',
          },
        ],
      },
      {
        id: 'gcp:compute-engine:c4-standard-2',
        displayName: 'c4-standard-2',
        tier: 'medium',
        specs: { vcpu: 2, memoryGb: 7, summary: '2 vCPU · 7 GB · general purpose (C4)' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'VM runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Default (on-demand) hourly price for a c4-standard-2 machine type (2 vCPU, 7 GiB) in Iowa (us-central1), from the C4 standard machine types table.',
          },
        ],
      },
    ],
  },
  {
    id: 'gcp:cloud-run',
    provider: 'gcp',
    role: 'compute-web',
    name: 'Cloud Run',
    kind: 'serverless',
    description:
      'Serverless containers that scale to zero and back. Request-based billing charges per vCPU-second and GiB-second of active time plus per-request. No servers to manage.',
    pricingUrl: 'https://cloud.google.com/run/pricing',
    docsUrl: 'https://cloud.google.com/run/docs',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'Per-second metering costs more than a right-sized VM at steady 24/7 load — Cloud Run wins on spiky traffic and scale-to-zero, not constant load.',
    freeTierNote:
      'Monthly free tier includes 180,000 vCPU-seconds, 360,000 GiB-seconds and 2M requests (us-central1).',
    skus: [
      {
        id: 'gcp:cloud-run:1vcpu-512mb',
        displayName: 'Cloud Run 1 vCPU / 512 MB',
        tier: 'starter',
        specs: { vcpu: 1, memoryGb: 0.5, summary: '1 vCPU · 512 MB · request-based · scale-to-zero' },
        dimensions: [
          {
            id: 'vcpu-second',
            label: 'vCPU active time',
            quantityKey: 'vcpuSeconds',
            unit: 'USD / vCPU-second',
            extractionHint:
              'Cloud Run request-based billing CPU price per vCPU-second, Default tier, active time, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'gib-second',
            label: 'Memory active time',
            quantityKey: 'gbRamSeconds',
            unit: 'USD / GiB-second',
            extractionHint:
              'Cloud Run request-based billing Memory price per GiB-second, Default tier, active time, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'requests',
            label: 'Requests',
            quantityKey: 'requests',
            unit: 'USD / million requests',
            pricePerUnits: 1_000_000,
            extractionHint:
              'Cloud Run request-based billing Requests price per 1,000,000 requests, Default tier, based on us-central1 pricing.',
          },
        ],
      },
      {
        id: 'gcp:cloud-run:1vcpu-1gib',
        displayName: 'Cloud Run 1 vCPU / 1 GiB',
        tier: 'small',
        specs: { vcpu: 1, memoryGb: 1, summary: '1 vCPU · 1 GiB · request-based · scale-to-zero' },
        dimensions: [
          {
            id: 'vcpu-second',
            label: 'vCPU active time',
            quantityKey: 'vcpuSeconds',
            unit: 'USD / vCPU-second',
            extractionHint:
              'Cloud Run request-based billing CPU price per vCPU-second, Default tier, active time, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'gib-second',
            label: 'Memory active time',
            quantityKey: 'gbRamSeconds',
            unit: 'USD / GiB-second',
            extractionHint:
              'Cloud Run request-based billing Memory price per GiB-second, Default tier, active time, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'requests',
            label: 'Requests',
            quantityKey: 'requests',
            unit: 'USD / million requests',
            pricePerUnits: 1_000_000,
            extractionHint:
              'Cloud Run request-based billing Requests price per 1,000,000 requests, Default tier, based on us-central1 pricing.',
          },
        ],
      },
      {
        id: 'gcp:cloud-run:2vcpu-2gib',
        displayName: 'Cloud Run 2 vCPU / 2 GiB',
        tier: 'medium',
        specs: { vcpu: 2, memoryGb: 2, summary: '2 vCPU · 2 GiB · request-based · scale-to-zero' },
        dimensions: [
          {
            id: 'vcpu-second',
            label: 'vCPU active time',
            quantityKey: 'vcpuSeconds',
            unit: 'USD / vCPU-second',
            extractionHint:
              'Cloud Run request-based billing CPU price per vCPU-second, Default tier, active time, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'gib-second',
            label: 'Memory active time',
            quantityKey: 'gbRamSeconds',
            unit: 'USD / GiB-second',
            extractionHint:
              'Cloud Run request-based billing Memory price per GiB-second, Default tier, active time, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'requests',
            label: 'Requests',
            quantityKey: 'requests',
            unit: 'USD / million requests',
            pricePerUnits: 1_000_000,
            extractionHint:
              'Cloud Run request-based billing Requests price per 1,000,000 requests, Default tier, based on us-central1 pricing.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* compute-worker  (Cloud Run jobs)                                   */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:cloud-run-jobs',
    provider: 'gcp',
    role: 'compute-worker',
    name: 'Cloud Run jobs',
    kind: 'serverless',
    description:
      'Run-to-completion background jobs on Cloud Run: batch tasks, cron and queue consumers. Billed per vCPU-second and GiB-second while the job executes; no request charge.',
    pricingUrl: 'https://cloud.google.com/run/pricing',
    docsUrl: 'https://cloud.google.com/run/docs/create-jobs',
    scalingScore: 4,
    simplicityScore: 5,
    tradeoff:
      'Suited to finite tasks — a worker that must stay resident and warm 24/7 is cheaper on a fixed Compute Engine VM.',
    skus: [
      {
        id: 'gcp:cloud-run-jobs:1vcpu-512mb',
        displayName: 'Job 1 vCPU / 512 MB',
        tier: 'starter',
        specs: { vcpu: 1, memoryGb: 0.5, summary: '1 vCPU · 512 MB · per-execution' },
        dimensions: [
          {
            id: 'vcpu-second',
            label: 'vCPU runtime',
            quantityKey: 'vcpuSeconds',
            unit: 'USD / vCPU-second',
            extractionHint:
              'Cloud Run Jobs CPU price per vCPU-second, Default tier, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'gib-second',
            label: 'Memory runtime',
            quantityKey: 'gbRamSeconds',
            unit: 'USD / GiB-second',
            extractionHint:
              'Cloud Run Jobs Memory price per GiB-second, Default tier, based on us-central1 (Tier 1) pricing.',
          },
        ],
      },
      {
        id: 'gcp:cloud-run-jobs:2vcpu-2gib',
        displayName: 'Job 2 vCPU / 2 GiB',
        tier: 'small',
        specs: { vcpu: 2, memoryGb: 2, summary: '2 vCPU · 2 GiB · per-execution' },
        dimensions: [
          {
            id: 'vcpu-second',
            label: 'vCPU runtime',
            quantityKey: 'vcpuSeconds',
            unit: 'USD / vCPU-second',
            extractionHint:
              'Cloud Run Jobs CPU price per vCPU-second, Default tier, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'gib-second',
            label: 'Memory runtime',
            quantityKey: 'gbRamSeconds',
            unit: 'USD / GiB-second',
            extractionHint:
              'Cloud Run Jobs Memory price per GiB-second, Default tier, based on us-central1 (Tier 1) pricing.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* compute-serverless  (Cloud Run functions)                          */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:cloud-run-functions',
    provider: 'gcp',
    role: 'compute-serverless',
    name: 'Cloud Run functions',
    kind: 'serverless',
    description:
      'Per-request functions on the Cloud Run platform (formerly Cloud Functions). Scale to zero; billed per vCPU-second and GiB-second of active time plus per request.',
    pricingUrl: 'https://cloud.google.com/run/pricing',
    docsUrl: 'https://cloud.google.com/run/docs/functions',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'At sustained high call rates the per-second rate overtakes an always-on container — use functions for event-driven and spiky, not steady, load.',
    freeTierNote:
      'Shares the Cloud Run monthly free tier: 180,000 vCPU-seconds, 360,000 GiB-seconds and 2M requests (us-central1).',
    skus: [
      {
        id: 'gcp:cloud-run-functions:256mb',
        displayName: 'Function 256 MB',
        tier: 'starter',
        specs: { vcpu: 0.167, memoryGb: 0.25, summary: '~0.17 vCPU · 256 MB · scale-to-zero' },
        dimensions: [
          {
            id: 'vcpu-second',
            label: 'vCPU active time',
            quantityKey: 'vcpuSeconds',
            unit: 'USD / vCPU-second',
            extractionHint:
              'Cloud Run request-based billing CPU price per vCPU-second, Default tier, active time, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'gib-second',
            label: 'Memory active time',
            quantityKey: 'gbRamSeconds',
            unit: 'USD / GiB-second',
            extractionHint:
              'Cloud Run request-based billing Memory price per GiB-second, Default tier, active time, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'requests',
            label: 'Invocations',
            quantityKey: 'invocations',
            unit: 'USD / million requests',
            pricePerUnits: 1_000_000,
            extractionHint:
              'Cloud Run request-based billing Requests price per 1,000,000 requests, Default tier, based on us-central1 pricing.',
          },
        ],
      },
      {
        id: 'gcp:cloud-run-functions:512mb',
        displayName: 'Function 512 MB',
        tier: 'small',
        specs: { vcpu: 0.333, memoryGb: 0.5, summary: '~0.33 vCPU · 512 MB · scale-to-zero' },
        dimensions: [
          {
            id: 'vcpu-second',
            label: 'vCPU active time',
            quantityKey: 'vcpuSeconds',
            unit: 'USD / vCPU-second',
            extractionHint:
              'Cloud Run request-based billing CPU price per vCPU-second, Default tier, active time, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'gib-second',
            label: 'Memory active time',
            quantityKey: 'gbRamSeconds',
            unit: 'USD / GiB-second',
            extractionHint:
              'Cloud Run request-based billing Memory price per GiB-second, Default tier, active time, based on us-central1 (Tier 1) pricing.',
          },
          {
            id: 'requests',
            label: 'Invocations',
            quantityKey: 'invocations',
            unit: 'USD / million requests',
            pricePerUnits: 1_000_000,
            extractionHint:
              'Cloud Run request-based billing Requests price per 1,000,000 requests, Default tier, based on us-central1 pricing.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* static-hosting  (Cloud Storage + Cloud CDN)                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:gcs-cdn',
    provider: 'gcp',
    role: 'static-hosting',
    name: 'Cloud Storage + Cloud CDN',
    kind: 'managed',
    description:
      'Static site / SPA hosting: assets in a Cloud Storage bucket served through Cloud CDN. Billed on stored GiB-month, CDN cache egress GiB and cache-lookup requests.',
    pricingUrl: 'https://cloud.google.com/cdn/pricing',
    docsUrl: 'https://cloud.google.com/storage/docs/hosting-static-website',
    scalingScore: 5,
    simplicityScore: 4,
    tradeoff:
      'Serves static assets only — server-rendered pages still need a compute-web service (Cloud Run or Compute Engine) alongside.',
    skus: [
      {
        id: 'gcp:gcs-cdn:standard',
        displayName: 'GCS Standard + Cloud CDN',
        tier: 'small',
        specs: { summary: 'Standard storage (us-central1) · Cloud CDN · North America pricing' },
        dimensions: [
          {
            id: 'storage-gib-hour',
            label: 'Origin storage',
            quantityKey: 'objectStorageGbMonth',
            unit: 'USD / GiB-hour',
            pricePerUnits: 1 / HOURS_PER_MONTH,
            extractionHint:
              'Cloud Storage Standard storage price per gibibyte-hour for the Iowa (us-central1) region.',
          },
          {
            id: 'cdn-egress-gib',
            label: 'CDN cache data transfer out',
            quantityKey: 'cdnEgressGb',
            unit: 'USD / GiB',
            extractionHint:
              'Cloud CDN cache data transfer out price per gibibyte to North America (including Hawaii) for the 0 byte to 10 tebibyte monthly-usage tier.',
          },
          {
            id: 'cdn-lookups',
            label: 'CDN cache lookup requests',
            quantityKey: 'cdnRequests',
            unit: 'USD / 10,000 requests',
            pricePerUnits: 10_000,
            extractionHint:
              'Cloud CDN HTTP/HTTPS cache lookup requests price per 10,000 requests (count) — the single flat rate that applies in all Google Cloud regions.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* db-relational                                                      */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:cloud-sql',
    provider: 'gcp',
    role: 'db-relational',
    name: 'Cloud SQL for PostgreSQL',
    kind: 'managed',
    description:
      'Fully managed PostgreSQL: Google handles backups, patching and replication. You choose vCPUs and memory; billed per vCPU-hour, per GiB-of-RAM-hour and storage GiB-month.',
    pricingUrl: 'https://cloud.google.com/sql/pricing',
    docsUrl: 'https://cloud.google.com/sql/docs/postgres',
    scalingScore: 3,
    simplicityScore: 4,
    tradeoff:
      'A dedicated-core instance runs 24/7 regardless of traffic — for bursty load a scale-to-zero serverless DB would idle cheaper.',
    freeTierNote: 'New customers get free credits to trial Cloud SQL; there is no perpetual free instance.',
    skus: [
      {
        id: 'gcp:cloud-sql:ent-1vcpu-3.75gb',
        displayName: 'Enterprise 1 vCPU / 3.75 GB',
        tier: 'starter',
        specs: { vcpu: 1, memoryGb: 3.75, summary: '1 vCPU · 3.75 GB · Enterprise · single zone' },
        dimensions: [
          {
            id: 'vcpu-hour',
            label: 'vCPU runtime',
            quantityKey: 'vcpuHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Cloud SQL Enterprise edition General Purpose machine series price for vCPUs per hour (non-HA) in Iowa (us-central1).',
          },
          {
            id: 'memory-gib-hour',
            label: 'Memory runtime',
            quantityKey: 'gbRamHours',
            unit: 'USD / GiB-hour',
            extractionHint:
              'Cloud SQL Enterprise edition General Purpose machine series price for Memory per gibibyte hour (non-HA) in Iowa (us-central1).',
          },
          {
            id: 'storage-gib-month',
            label: 'SSD storage',
            quantityKey: 'dbStorageGbMonth',
            unit: 'USD / GiB-hour',
            pricePerUnits: 1 / HOURS_PER_MONTH,
            extractionHint:
              'Cloud SQL SSD storage capacity price per gibibyte hour for PostgreSQL in Iowa (us-central1) (the page lists storage per gibibyte-hour, not per month).',
          },
        ],
      },
      {
        id: 'gcp:cloud-sql:ent-2vcpu-7.5gb',
        displayName: 'Enterprise 2 vCPU / 7.5 GB',
        tier: 'small',
        specs: { vcpu: 2, memoryGb: 7.5, summary: '2 vCPU · 7.5 GB · Enterprise · single zone' },
        dimensions: [
          {
            id: 'vcpu-hour',
            label: 'vCPU runtime',
            quantityKey: 'vcpuHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Cloud SQL Enterprise edition General Purpose machine series price for vCPUs per hour (non-HA) in Iowa (us-central1).',
          },
          {
            id: 'memory-gib-hour',
            label: 'Memory runtime',
            quantityKey: 'gbRamHours',
            unit: 'USD / GiB-hour',
            extractionHint:
              'Cloud SQL Enterprise edition General Purpose machine series price for Memory per gibibyte hour (non-HA) in Iowa (us-central1).',
          },
          {
            id: 'storage-gib-month',
            label: 'SSD storage',
            quantityKey: 'dbStorageGbMonth',
            unit: 'USD / GiB-hour',
            pricePerUnits: 1 / HOURS_PER_MONTH,
            extractionHint:
              'Cloud SQL SSD storage capacity price per gibibyte hour for PostgreSQL in Iowa (us-central1) (the page lists storage per gibibyte-hour, not per month).',
          },
        ],
      },
      {
        id: 'gcp:cloud-sql:ent-4vcpu-15gb',
        displayName: 'Enterprise 4 vCPU / 15 GB',
        tier: 'medium',
        specs: { vcpu: 4, memoryGb: 15, summary: '4 vCPU · 15 GB · Enterprise · single zone' },
        dimensions: [
          {
            id: 'vcpu-hour',
            label: 'vCPU runtime',
            quantityKey: 'vcpuHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Cloud SQL Enterprise edition General Purpose machine series price for vCPUs per hour (non-HA) in Iowa (us-central1).',
          },
          {
            id: 'memory-gib-hour',
            label: 'Memory runtime',
            quantityKey: 'gbRamHours',
            unit: 'USD / GiB-hour',
            extractionHint:
              'Cloud SQL Enterprise edition General Purpose machine series price for Memory per gibibyte hour (non-HA) in Iowa (us-central1).',
          },
          {
            id: 'storage-gib-month',
            label: 'SSD storage',
            quantityKey: 'dbStorageGbMonth',
            unit: 'USD / GiB-hour',
            pricePerUnits: 1 / HOURS_PER_MONTH,
            extractionHint:
              'Cloud SQL SSD storage capacity price per gibibyte hour for PostgreSQL in Iowa (us-central1) (the page lists storage per gibibyte-hour, not per month).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* db-nosql                                                           */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:firestore',
    provider: 'gcp',
    role: 'db-nosql',
    name: 'Firestore',
    kind: 'serverless',
    description:
      'Serverless document database that scales to zero cost at rest. Billed per document read, write and delete plus stored GiB — no capacity to provision.',
    pricingUrl: 'https://cloud.google.com/firestore/pricing',
    docsUrl: 'https://cloud.google.com/firestore/docs',
    scalingScore: 5,
    simplicityScore: 4,
    tradeoff:
      'A document model with per-operation billing — read-heavy workloads with large fan-out queries can get expensive, and it is not relational.',
    freeTierNote:
      'Free quota per day: 50,000 reads, 20,000 writes, 20,000 deletes and 1 GiB stored (one database per project).',
    skus: [
      {
        id: 'gcp:firestore:native',
        displayName: 'Firestore (Native)',
        tier: 'small',
        specs: { summary: 'Native mode · per-operation billing · us-central1' },
        dimensions: [
          {
            id: 'reads',
            label: 'Document reads',
            quantityKey: 'nosqlReads',
            unit: 'USD / 100,000 documents',
            pricePerUnits: 100_000,
            extractionHint:
              'Firestore Document Reads price per 100,000 documents (Default) for the Iowa (us-central1) location.',
          },
          {
            id: 'writes',
            label: 'Document writes',
            quantityKey: 'nosqlWrites',
            unit: 'USD / 100,000 documents',
            pricePerUnits: 100_000,
            extractionHint:
              'Firestore Document Writes price per 100,000 documents (Default) for the Iowa (us-central1) location.',
          },
          {
            id: 'storage-gib-month',
            label: 'Stored data',
            quantityKey: 'nosqlStorageGbMonth',
            unit: 'USD / GiB-month',
            extractionHint:
              'Firestore Stored Data price per GiB (Default) for the Iowa (us-central1) location.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* cache-redis                                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:memorystore',
    provider: 'gcp',
    role: 'cache-redis',
    name: 'Memorystore for Redis',
    kind: 'managed',
    description:
      'Managed Redis-compatible cache. You provision a capacity in GiB; billed per GiB-hour based on service tier (Basic or Standard) and capacity tier.',
    pricingUrl: 'https://cloud.google.com/memorystore/docs/redis/pricing',
    docsUrl: 'https://cloud.google.com/memorystore/docs/redis',
    scalingScore: 3,
    simplicityScore: 4,
    tradeoff:
      'Provisioned capacity runs 24/7 whether or not the cache is hot — size conservatively, since there is no scale-to-zero.',
    skus: [
      {
        id: 'gcp:memorystore:basic-m1',
        displayName: 'Basic Tier (M1, 1–4 GiB)',
        tier: 'starter',
        specs: { memoryGb: 1, nodes: 1, summary: '1 GiB · Basic tier · no replica' },
        dimensions: [
          {
            id: 'capacity-gib-hour',
            label: 'Provisioned capacity',
            quantityKey: 'cacheGbMonth',
            unit: 'USD / GiB-hour',
            pricePerUnits: 1 / HOURS_PER_MONTH,
            extractionHint:
              'Memorystore for Redis Basic Tier, capacity tier M1 (1 to 4 GiB), price per gibibyte hour (Default) in Iowa (us-central1).',
          },
        ],
      },
      {
        id: 'gcp:memorystore:standard-m1',
        displayName: 'Standard Tier (M1, 1–4 GiB)',
        tier: 'small',
        specs: { memoryGb: 1, nodes: 2, summary: '1 GiB · Standard tier · HA replica' },
        dimensions: [
          {
            id: 'capacity-gib-hour',
            label: 'Provisioned capacity',
            quantityKey: 'cacheGbMonth',
            unit: 'USD / GiB-hour',
            pricePerUnits: 1 / HOURS_PER_MONTH,
            extractionHint:
              'Memorystore for Redis Standard Tier, capacity tier M1 (1 to 4 GiB), price per gibibyte hour (Default) in Iowa (us-central1).',
          },
        ],
      },
      {
        id: 'gcp:memorystore:standard-m2',
        displayName: 'Standard Tier (M2, 5–10 GiB)',
        tier: 'medium',
        specs: { memoryGb: 5, nodes: 2, summary: '5 GiB · Standard tier · HA replica' },
        dimensions: [
          {
            id: 'capacity-gib-hour',
            label: 'Provisioned capacity',
            quantityKey: 'cacheGbMonth',
            unit: 'USD / GiB-hour',
            pricePerUnits: 1 / HOURS_PER_MONTH,
            extractionHint:
              'Memorystore for Redis Standard Tier, capacity tier M2 (5 to 10 GiB), price per gibibyte hour (Default) in Iowa (us-central1).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* queue-basic                                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:pubsub',
    provider: 'gcp',
    role: 'queue-basic',
    name: 'Pub/Sub',
    kind: 'serverless',
    description:
      'Fully managed messaging billed on throughput (bytes published + delivered) with no capacity to provision. Scales to zero cost when idle.',
    pricingUrl: 'https://cloud.google.com/pubsub/pricing',
    docsUrl: 'https://cloud.google.com/pubsub/docs',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'Throughput-priced messaging without replayable log semantics — for durable event streams use Managed Kafka instead.',
    freeTierNote: 'First 10 GiB of throughput per month is free (Message Delivery Basic).',
    skus: [
      {
        id: 'gcp:pubsub:standard',
        displayName: 'Pub/Sub throughput',
        tier: 'small',
        specs: { summary: 'Publish + subscribe throughput · pay per TiB' },
        dimensions: [
          {
            id: 'throughput-tib',
            label: 'Message throughput',
            quantityKey: 'queueMessages',
            unit: 'USD / TiB',
            extractionHint:
              'Pub/Sub throughput price per TiB (Message Delivery Basic SKU) in all Google Cloud regions, after the first 10 GiB free.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* queue-kafka                                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:managed-kafka',
    provider: 'gcp',
    role: 'queue-kafka',
    name: 'Managed Service for Apache Kafka',
    kind: 'managed',
    description:
      'Managed Apache Kafka sized by vCPU and RAM (Data Compute Units). Billed per compute-hour plus local storage GiB-hour. Durable, replayable event streaming.',
    pricingUrl: 'https://cloud.google.com/managed-service-for-apache-kafka/pricing',
    docsUrl: 'https://cloud.google.com/managed-service-for-apache-kafka/docs',
    scalingScore: 4,
    simplicityScore: 2,
    tradeoff:
      'A cluster runs continuously and inter-zone replication dominates cost at scale — overkill for a low-volume queue, where Pub/Sub is far simpler.',
    skus: [
      {
        id: 'gcp:managed-kafka:3dcu',
        displayName: 'Kafka cluster (3 vCPU)',
        tier: 'small',
        specs: { vcpu: 3, memoryGb: 12, summary: '3 vCPU · 12 GB · 3-zone replication' },
        dimensions: [
          {
            id: 'compute-hour',
            label: 'Cluster compute (vCPU+RAM)',
            quantityKey: 'kafkaBrokerHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Managed Service for Apache Kafka Compute (CPU+RAM) price per hour, Default, in Iowa (us-central1) — the base per-vCPU/DCU compute rate.',
          },
          {
            id: 'storage-gib-hour',
            label: 'Local storage',
            quantityKey: 'kafkaStorageGbMonth',
            unit: 'USD / GiB-hour',
            pricePerUnits: 1 / HOURS_PER_MONTH,
            extractionHint:
              'Managed Service for Apache Kafka Local Storage price per gibibyte hour, Default, in Iowa (us-central1).',
          },
        ],
      },
      {
        id: 'gcp:managed-kafka:6dcu',
        displayName: 'Kafka cluster (6 vCPU)',
        tier: 'medium',
        specs: { vcpu: 6, memoryGb: 24, summary: '6 vCPU · 24 GB · 3-zone replication' },
        dimensions: [
          {
            id: 'compute-hour',
            label: 'Cluster compute (vCPU+RAM)',
            quantityKey: 'kafkaBrokerHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Managed Service for Apache Kafka Compute (CPU+RAM) price per hour, Default, in Iowa (us-central1) — the base per-vCPU/DCU compute rate.',
          },
          {
            id: 'storage-gib-hour',
            label: 'Local storage',
            quantityKey: 'kafkaStorageGbMonth',
            unit: 'USD / GiB-hour',
            pricePerUnits: 1 / HOURS_PER_MONTH,
            extractionHint:
              'Managed Service for Apache Kafka Local Storage price per gibibyte hour, Default, in Iowa (us-central1).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* object-storage                                                     */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:cloud-storage',
    provider: 'gcp',
    role: 'object-storage',
    name: 'Cloud Storage',
    kind: 'managed',
    description:
      'Durable object storage for uploads, backups and blobs. Billed on stored GiB-hour plus per-operation (Class A write / Class B read) charges. Default class is Standard.',
    pricingUrl: 'https://cloud.google.com/storage/pricing',
    docsUrl: 'https://cloud.google.com/storage/docs',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'Object storage, not a filesystem — apps needing POSIX semantics want Filestore or a persistent disk instead.',
    freeTierNote: '5 GB-months of Standard storage per month in US regions (Always Free).',
    skus: [
      {
        id: 'gcp:cloud-storage:standard',
        displayName: 'Standard storage',
        tier: 'small',
        specs: { summary: 'Standard class · us-central1 region · single region' },
        dimensions: [
          {
            id: 'storage-gib-hour',
            label: 'Stored data',
            quantityKey: 'objectStorageGbMonth',
            unit: 'USD / GiB-hour',
            pricePerUnits: 1 / HOURS_PER_MONTH,
            extractionHint:
              'Cloud Storage Standard storage price per gibibyte-hour for the Iowa (us-central1) region.',
          },
          {
            id: 'class-a-ops',
            label: 'Class A operations (writes)',
            quantityKey: 'objectWriteOps',
            unit: 'USD / 1,000 operations',
            pricePerUnits: 1_000,
            extractionHint:
              'Cloud Storage Standard storage Class A operations price per 1,000 operations in the Iowa (us-central1) region.',
          },
          {
            id: 'class-b-ops',
            label: 'Class B operations (reads)',
            quantityKey: 'objectReadOps',
            unit: 'USD / 1,000 operations',
            pricePerUnits: 1_000,
            extractionHint:
              'Cloud Storage Standard storage Class B operations price per 1,000 operations in the Iowa (us-central1) region.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* cdn                                                                */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:cloud-cdn',
    provider: 'gcp',
    role: 'cdn',
    name: 'Cloud CDN',
    kind: 'managed',
    description:
      'Global CDN / edge cache in front of your app. Billed per GiB of cache data transfer out plus cache-lookup requests; cache fill is charged separately.',
    pricingUrl: 'https://cloud.google.com/cdn/pricing',
    docsUrl: 'https://cloud.google.com/cdn/docs',
    scalingScore: 5,
    simplicityScore: 4,
    tradeoff:
      'Per-GiB egress climbs at very high volume — negotiate a committed-use discount above ~500 TiB/month rather than staying on list price.',
    skus: [
      {
        id: 'gcp:cloud-cdn:standard',
        displayName: 'Cloud CDN',
        tier: 'small',
        specs: { summary: 'North America egress · cache data transfer out + lookups' },
        dimensions: [
          {
            id: 'egress-gib',
            label: 'Cache data transfer out',
            quantityKey: 'cdnEgressGb',
            unit: 'USD / GiB',
            extractionHint:
              'Cloud CDN cache data transfer out price per gibibyte to North America (including Hawaii) for the 0 byte to 10 tebibyte monthly-usage tier.',
          },
          {
            id: 'cache-lookups',
            label: 'Cache lookup requests',
            quantityKey: 'cdnRequests',
            unit: 'USD / 10,000 requests',
            pricePerUnits: 10_000,
            extractionHint:
              'Cloud CDN HTTP/HTTPS cache lookup requests price per 10,000 requests (count) — the single flat rate that applies in all Google Cloud regions.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* egress                                                             */
  /* ------------------------------------------------------------------ */
  {
    id: 'gcp:egress',
    provider: 'gcp',
    role: 'egress',
    name: 'Google Cloud Data Transfer Out',
    kind: 'managed',
    description:
      'Premium Tier internet data transfer out from GCP compute to the public internet, billed per GiB. Often a top-three line item that is invisible if you only price the boxes.',
    pricingUrl: 'https://cloud.google.com/vpc/network-pricing',
    docsUrl: 'https://cloud.google.com/vpc/docs/about-vpc-network-pricing',
    scalingScore: 3,
    simplicityScore: 3,
    tradeoff:
      'Origin egress bypasses the CDN — routing user traffic through Cloud CDN usually lands a lower per-GiB rate.',
    freeTierNote: 'First 1 GiB of data transfer out to North America per month is free.',
    skus: [
      {
        id: 'gcp:egress:internet',
        displayName: 'Internet data transfer out',
        tier: 'small',
        specs: { summary: 'Premium Tier · GCP → internet (North America) · first paid tier' },
        dimensions: [
          {
            id: 'egress-gib',
            label: 'Data transfer out',
            quantityKey: 'egressGb',
            unit: 'USD / GiB',
            extractionHint:
              'Premium Tier internet data transfer out price per gibibyte TO North America for the 1 gibibyte to 1,024 gibibyte monthly tier (after the first free 1 GiB).',
          },
        ],
      },
    ],
  },
];
