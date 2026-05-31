/**
 * DigitalOcean half of the Feature 2 service catalog — STRUCTURE ONLY, NO PRICES.
 *
 * As with the other providers, this file declares only *what* to fetch and
 * *where*. No price lives here (there is no field for one), not even in a
 * comment. Numbers arrive only as fetched, cited `PriceRecord`s through the
 * evidence gate — see `docs/feature-2-cost-predictor.md` §5.
 *
 * Priced region: nyc3 / "New York 3 (NYC3)" (see `PRICED_REGION`). DigitalOcean
 * publishes one flat price list that applies across its regions, so the hints
 * pin the plan/size + nyc3 rather than a per-region rate.
 *
 * ## Sourcing notes (why these URLs)
 *
 * Per §4 of the design doc, DigitalOcean extracts cleanly via Tavily and returns
 * tidy markdown price tables (per-plan hourly and monthly rate columns). Each
 * URL below was fetched on 2026-07-26 and verified to carry per-plan numbers.
 *
 * ## Bandwidth is POOLED — modelled as a single egress service (rule 7)
 *
 * DigitalOcean does NOT bill bandwidth per resource. Every Droplet, App Platform
 * container and managed database ships with a transfer allowance, and those
 * allowances are **pooled across the whole account**; only aggregate overage is
 * charged, at a flat per-GiB rate. We therefore model egress as ONE `egress`
 * service whose pooled monthly allowance is carried as `includedQuantity` in the
 * price book (fetched, never assumed) — see the `do:egress` `notes`. We do not
 * attach a per-GiB transfer dimension to the compute/DB SKUs, because that would
 * double-count the pooled allowance.
 *
 * ## Coverage — DigitalOcean's gaps are intentional (§9)
 *
 * DigitalOcean has no managed `db-nosql`, `queue-basic`, `queue-kafka` (it sells
 * a Kafka *cluster* product, but §9 marks the queue-kafka role `—` for DO) or
 * `search` offering in scope. Those roles are OMITTED here on purpose so a PRD
 * needing them surfaces an honest gap rather than a faked service.
 */

import type { CatalogServiceInput } from './types';

export const digitalOceanServices: CatalogServiceInput[] = [
  /* ------------------------------------------------------------------ */
  /* compute-web  (Droplets + App Platform)                            */
  /* ------------------------------------------------------------------ */
  {
    id: 'digitalocean:droplet',
    provider: 'digitalocean',
    role: 'compute-web',
    name: 'DigitalOcean Droplet',
    kind: 'iaas',
    description:
      'Simple Linux virtual machines with flat, predictable monthly pricing. You operate the OS, autoscaling and load balancer; billed per Droplet by size (a flat monthly cap or per-hour).',
    pricingUrl: 'https://www.digitalocean.com/pricing/droplets',
    docsUrl: 'https://docs.digitalocean.com/products/droplets/',
    scalingScore: 3,
    simplicityScore: 3,
    tradeoff:
      'You own patching, autoscaling and the load balancer — choose App Platform if you want the platform to manage the app lifecycle for you.',
    skus: [
      {
        id: 'digitalocean:droplet:basic-1gb',
        displayName: 'Basic 1 GiB / 1 vCPU',
        tier: 'starter',
        specs: { vcpu: 1, memoryGb: 1, summary: '1 vCPU · 1 GiB · Basic (shared) Droplet' },
        dimensions: [
          {
            id: 'droplet-hour',
            label: 'Droplet runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Basic Droplet with 1 GiB memory / 1 vCPU / 25 GiB SSD hourly price ($/hr column) from the DigitalOcean Droplets pricing Basic Droplets table (flat across regions incl. nyc3).',
          },
        ],
      },
      {
        id: 'digitalocean:droplet:basic-2gb',
        displayName: 'Basic 2 GiB / 1 vCPU',
        tier: 'small',
        specs: { vcpu: 1, memoryGb: 2, summary: '1 vCPU · 2 GiB · Basic (shared) Droplet' },
        dimensions: [
          {
            id: 'droplet-hour',
            label: 'Droplet runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Basic Droplet with 2 GiB memory / 1 vCPU / 50 GiB SSD hourly price ($/hr column) from the DigitalOcean Droplets pricing Basic Droplets table (flat across regions incl. nyc3).',
          },
        ],
      },
      {
        id: 'digitalocean:droplet:basic-4gb',
        displayName: 'Basic 4 GiB / 2 vCPU',
        tier: 'medium',
        specs: { vcpu: 2, memoryGb: 4, summary: '2 vCPU · 4 GiB · Basic (shared) Droplet' },
        dimensions: [
          {
            id: 'droplet-hour',
            label: 'Droplet runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Basic Droplet with 4 GiB memory / 2 vCPUs / 80 GiB SSD hourly price ($/hr column) from the DigitalOcean Droplets pricing Basic Droplets table (flat across regions incl. nyc3).',
          },
        ],
      },
    ],
  },
  {
    id: 'digitalocean:app-platform',
    provider: 'digitalocean',
    role: 'compute-web',
    name: 'DigitalOcean App Platform',
    kind: 'platform',
    description:
      'A fully managed PaaS that builds and runs your app from git. You pick a container instance size; billed a flat monthly fee per container. The platform handles the OS, TLS and scaling.',
    pricingUrl: 'https://www.digitalocean.com/pricing/app-platform',
    docsUrl: 'https://docs.digitalocean.com/products/app-platform/',
    scalingScore: 4,
    simplicityScore: 5,
    tradeoff:
      'A flat per-container fee is simple but less granular than per-second Droplet billing — a highly bursty workload may waste headroom.',
    freeTierNote: 'The Free tier hosts 3 static sites with a 1 GiB/app transfer allowance and automatic HTTPS.',
    skus: [
      {
        id: 'digitalocean:app-platform:basic-512mb',
        displayName: 'Basic container 512 MiB',
        tier: 'starter',
        specs: { vcpu: 1, memoryGb: 0.5, summary: '1 vCPU · 512 MiB · shared (fixed) container' },
        dimensions: [
          {
            id: 'container-month',
            label: 'Container monthly fee',
            quantityKey: 'months',
            unit: 'USD / container-month',
            extractionHint:
              'App Platform Shared (Fixed) container with 1 vCPU / 512 MiB monthly price ($/mo column) from the DigitalOcean App Platform Container Pricing table (flat across regions incl. nyc3).',
          },
        ],
      },
      {
        id: 'digitalocean:app-platform:basic-1gb',
        displayName: 'Basic container 1 GiB',
        tier: 'small',
        specs: { vcpu: 1, memoryGb: 1, summary: '1 vCPU · 1 GiB · shared (fixed) container' },
        dimensions: [
          {
            id: 'container-month',
            label: 'Container monthly fee',
            quantityKey: 'months',
            unit: 'USD / container-month',
            extractionHint:
              'App Platform Shared (Fixed) container with 1 vCPU / 1 GiB monthly price ($/mo column) from the DigitalOcean App Platform Container Pricing table (flat across regions incl. nyc3).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* compute-worker  (Droplet / App Platform worker component)         */
  /* ------------------------------------------------------------------ */
  {
    id: 'digitalocean:app-platform-worker',
    provider: 'digitalocean',
    role: 'compute-worker',
    name: 'DigitalOcean App Platform (worker)',
    kind: 'platform',
    description:
      'A background worker component on App Platform (no public ingress) for queue consumers, cron and job processors. Billed a flat monthly fee per container by size, like a web service.',
    pricingUrl: 'https://www.digitalocean.com/pricing/app-platform',
    docsUrl: 'https://docs.digitalocean.com/products/app-platform/how-to/manage-workers/',
    scalingScore: 4,
    simplicityScore: 5,
    tradeoff:
      'A resident worker billed 24/7 at a flat container fee — for a worker pinned at high CPU a right-sized Droplet may be cheaper.',
    skus: [
      {
        id: 'digitalocean:app-platform-worker:basic-512mb',
        displayName: 'Worker container 512 MiB',
        tier: 'starter',
        specs: { vcpu: 1, memoryGb: 0.5, summary: '1 vCPU · 512 MiB · worker container' },
        dimensions: [
          {
            id: 'container-month',
            label: 'Container monthly fee',
            quantityKey: 'months',
            unit: 'USD / container-month',
            extractionHint:
              'App Platform Shared (Fixed) container with 1 vCPU / 512 MiB monthly price ($/mo column) from the DigitalOcean App Platform Container Pricing table (flat across regions incl. nyc3).',
          },
        ],
      },
      {
        id: 'digitalocean:app-platform-worker:basic-1gb',
        displayName: 'Worker container 1 GiB',
        tier: 'small',
        specs: { vcpu: 1, memoryGb: 1, summary: '1 vCPU · 1 GiB · worker container' },
        dimensions: [
          {
            id: 'container-month',
            label: 'Container monthly fee',
            quantityKey: 'months',
            unit: 'USD / container-month',
            extractionHint:
              'App Platform Shared (Fixed) container with 1 vCPU / 1 GiB monthly price ($/mo column) from the DigitalOcean App Platform Container Pricing table (flat across regions incl. nyc3).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* compute-serverless  (DO Functions)                                */
  /* ------------------------------------------------------------------ */
  {
    id: 'digitalocean:functions',
    provider: 'digitalocean',
    role: 'compute-serverless',
    name: 'DigitalOcean Functions',
    kind: 'serverless',
    description:
      'Serverless functions that run on demand and scale to zero. Billed purely on GiB-seconds of compute (invocations × memory × runtime) after a monthly free grant.',
    pricingUrl: 'https://www.digitalocean.com/pricing/functions',
    docsUrl: 'https://docs.digitalocean.com/products/functions/',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'A single GiB-second metric with a 100 ms minimum billing per invocation — very short, very frequent calls pay the floor; steady load is cheaper on a container.',
    freeTierNote: '90,000 GiB-seconds of compute free per month per account.',
    skus: [
      {
        id: 'digitalocean:functions:standard',
        displayName: 'DO Functions',
        tier: 'small',
        specs: { summary: 'Per GiB-second · 100 ms minimum billing · scale-to-zero' },
        dimensions: [
          {
            id: 'gib-second',
            label: 'Compute',
            quantityKey: 'gbSeconds',
            unit: 'USD / GiB-second',
            extractionHint:
              'DigitalOcean Functions price per GiB-second for additional memory and runtime, after the 90,000 GiB-seconds free monthly grant (flat across regions incl. nyc3).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* static-hosting  (App Platform static sites)                       */
  /* ------------------------------------------------------------------ */
  {
    id: 'digitalocean:app-platform-static',
    provider: 'digitalocean',
    role: 'static-hosting',
    name: 'DigitalOcean App Platform (static sites)',
    kind: 'platform',
    description:
      'Static site / SPA hosting on App Platform, built from git and served through DigitalOcean’s global CDN with automatic HTTPS. The Starter static tier is free; paid static sites add transfer.',
    pricingUrl: 'https://www.digitalocean.com/pricing/app-platform',
    docsUrl: 'https://docs.digitalocean.com/products/app-platform/how-to/manage-static-sites/',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'Serves static assets only — a server-rendered backend still needs a compute-web service (Droplet or App Platform container) alongside it.',
    freeTierNote: 'The Free tier hosts up to 3 static sites with a 1 GiB/app monthly transfer allowance and a global CDN.',
    skus: [
      {
        id: 'digitalocean:app-platform-static:starter',
        displayName: 'Static site (Starter)',
        tier: 'free',
        specs: { summary: 'Free static hosting · global CDN · 1 GiB/app transfer allowance' },
        dimensions: [
          {
            id: 'site-month',
            label: 'Static site monthly fee',
            quantityKey: 'months',
            unit: 'USD / site-month',
            extractionHint:
              'App Platform Free tier static site price per month (the free/no-cost starting tier for static sites) from the DigitalOcean App Platform pricing Free Tier section (flat across regions incl. nyc3).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* db-relational  (Managed PostgreSQL)                               */
  /* ------------------------------------------------------------------ */
  {
    id: 'digitalocean:managed-postgres',
    provider: 'digitalocean',
    role: 'db-relational',
    name: 'DigitalOcean Managed PostgreSQL',
    kind: 'managed',
    description:
      'Fully managed PostgreSQL with automated backups, failover and patching. Billed a flat monthly fee per node size (memory / vCPU / included storage range); additional storage is per GiB.',
    pricingUrl: 'https://www.digitalocean.com/pricing/managed-databases',
    docsUrl: 'https://docs.digitalocean.com/products/databases/postgresql/',
    scalingScore: 3,
    simplicityScore: 5,
    tradeoff:
      'A node runs 24/7 at a flat fee regardless of traffic — for intermittent load a scale-to-zero database elsewhere idles cheaper.',
    skus: [
      {
        id: 'digitalocean:managed-postgres:1gb',
        displayName: 'Postgres 1 GiB / 1 vCPU',
        tier: 'starter',
        specs: { vcpu: 1, memoryGb: 1, summary: '1 vCPU · 1 GiB · single node · ~10 GiB storage' },
        dimensions: [
          {
            id: 'node-hour',
            label: 'DB node runtime',
            quantityKey: 'dbInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Managed PostgreSQL single-node cluster with 1 GiB memory / 1 vCPU hourly price ($/hr column) from the DigitalOcean Managed Databases PostgreSQL table (flat across regions incl. nyc3).',
          },
        ],
      },
      {
        id: 'digitalocean:managed-postgres:2gb',
        displayName: 'Postgres 2 GiB / 1 vCPU',
        tier: 'small',
        specs: { vcpu: 1, memoryGb: 2, summary: '1 vCPU · 2 GiB · single node · ~30 GiB storage' },
        dimensions: [
          {
            id: 'node-hour',
            label: 'DB node runtime',
            quantityKey: 'dbInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Managed PostgreSQL single-node cluster with 2 GiB memory / 1 vCPU hourly price ($/hr column) from the DigitalOcean Managed Databases PostgreSQL table (flat across regions incl. nyc3).',
          },
        ],
      },
      {
        id: 'digitalocean:managed-postgres:4gb',
        displayName: 'Postgres 4 GiB / 2 vCPU',
        tier: 'medium',
        specs: { vcpu: 2, memoryGb: 4, summary: '2 vCPU · 4 GiB · single node · ~60 GiB storage' },
        dimensions: [
          {
            id: 'node-hour',
            label: 'DB node runtime',
            quantityKey: 'dbInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Managed PostgreSQL single-node cluster with 4 GiB memory / 2 vCPUs hourly price ($/hr column) from the DigitalOcean Managed Databases PostgreSQL table (flat across regions incl. nyc3).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* cache-redis  (Managed Valkey / Redis-compatible)                  */
  /* ------------------------------------------------------------------ */
  {
    id: 'digitalocean:managed-valkey',
    provider: 'digitalocean',
    role: 'cache-redis',
    name: 'DigitalOcean Managed Caching (Valkey)',
    kind: 'managed',
    description:
      'Managed Valkey, a Redis-compatible in-memory cache. Billed a flat monthly fee per node size (memory / vCPU). DigitalOcean handles the engine, failover and patching.',
    pricingUrl: 'https://www.digitalocean.com/pricing/managed-databases',
    docsUrl: 'https://docs.digitalocean.com/products/databases/valkey/',
    scalingScore: 3,
    simplicityScore: 5,
    tradeoff:
      'A node runs 24/7 at a flat fee regardless of hit rate — a tiny or bursty cache may be cheaper colocated on an app node.',
    skus: [
      {
        id: 'digitalocean:managed-valkey:1gb',
        displayName: 'Valkey 1 GiB / 1 vCPU',
        tier: 'starter',
        specs: { memoryGb: 1, vcpu: 1, nodes: 1, summary: '1 GiB · 1 vCPU · single node' },
        dimensions: [
          {
            id: 'node-hour',
            label: 'Cache node runtime',
            quantityKey: 'cacheInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Managed Caching Valkey single-node cluster with 1 GiB memory / 1 vCPU hourly price ($/hr column) from the DigitalOcean Managed Databases Valkey table (flat across regions incl. nyc3).',
          },
        ],
      },
      {
        id: 'digitalocean:managed-valkey:2gb',
        displayName: 'Valkey 2 GiB / 1 vCPU',
        tier: 'small',
        specs: { memoryGb: 2, vcpu: 1, nodes: 1, summary: '2 GiB · 1 vCPU · single node' },
        dimensions: [
          {
            id: 'node-hour',
            label: 'Cache node runtime',
            quantityKey: 'cacheInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Managed Caching Valkey single-node cluster with 2 GiB memory / 1 vCPU hourly price ($/hr column) from the DigitalOcean Managed Databases Valkey table (flat across regions incl. nyc3).',
          },
        ],
      },
      {
        id: 'digitalocean:managed-valkey:4gb',
        displayName: 'Valkey 4 GiB / 2 vCPU',
        tier: 'medium',
        specs: { memoryGb: 4, vcpu: 2, nodes: 1, summary: '4 GiB · 2 vCPU · single node' },
        dimensions: [
          {
            id: 'node-hour',
            label: 'Cache node runtime',
            quantityKey: 'cacheInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Managed Caching Valkey single-node cluster with 4 GiB memory / 2 vCPUs hourly price ($/hr column) from the DigitalOcean Managed Databases Valkey table (flat across regions incl. nyc3).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* object-storage  (Spaces)                                          */
  /* ------------------------------------------------------------------ */
  {
    id: 'digitalocean:spaces',
    provider: 'digitalocean',
    role: 'object-storage',
    name: 'DigitalOcean Spaces',
    kind: 'managed',
    description:
      'S3-compatible object storage with a built-in CDN. A flat monthly base fee includes a storage and outbound-transfer allowance; usage beyond the allowance is billed per GiB.',
    pricingUrl: 'https://www.digitalocean.com/pricing/spaces-object-storage',
    docsUrl: 'https://docs.digitalocean.com/products/spaces/',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'The flat base fee makes tiny buckets less efficient per-GiB than pure pay-as-you-go object storage elsewhere.',
    skus: [
      {
        id: 'digitalocean:spaces:standard',
        displayName: 'Spaces',
        tier: 'small',
        specs: { summary: 'Base fee + included storage/transfer allowance, then per-GiB overage' },
        dimensions: [
          {
            id: 'base-month',
            label: 'Base monthly fee',
            quantityKey: 'months',
            unit: 'USD / month',
            extractionHint:
              'DigitalOcean Spaces Object Storage base subscription price per month (the flat "$X per month" plan that includes the storage + outbound transfer allowance) from the Spaces pricing page (flat across regions incl. nyc3).',
          },
          {
            id: 'storage-gib-month',
            label: 'Additional storage',
            quantityKey: 'objectStorageGbMonth',
            unit: 'USD / GiB-month',
            extractionHint:
              'DigitalOcean Spaces additional storage price per GiB (the "additional storage" per-GiB overage rate beyond the included allowance) from the Spaces pricing page (flat across regions incl. nyc3).',
            required: false,
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* cdn  (Spaces built-in CDN)                                        */
  /*                                                                    */
  /* DigitalOcean's CDN is the CDN built into Spaces; there is no        */
  /* separate DO CDN product/price list. It is billed as Spaces         */
  /* outbound (CDN) transfer, so we cite the Spaces pricing page.        */
  /* ------------------------------------------------------------------ */
  {
    id: 'digitalocean:cdn',
    provider: 'digitalocean',
    role: 'cdn',
    name: 'DigitalOcean CDN (Spaces)',
    kind: 'managed',
    description:
      'DigitalOcean’s CDN is the content delivery network built into Spaces. Outbound (CDN) transfer is included up to the Spaces allowance, then billed per GiB of additional transfer.',
    pricingUrl: 'https://www.digitalocean.com/pricing/spaces-object-storage',
    docsUrl: 'https://docs.digitalocean.com/products/spaces/how-to/enable-cdn/',
    scalingScore: 4,
    simplicityScore: 5,
    tradeoff:
      'Tied to Spaces rather than a standalone edge product — for pulling from an arbitrary origin, a dedicated CDN elsewhere is more flexible.',
    skus: [
      {
        id: 'digitalocean:cdn:standard',
        displayName: 'Spaces CDN transfer',
        tier: 'small',
        specs: { summary: 'CDN outbound transfer · included allowance then per-GiB' },
        dimensions: [
          {
            id: 'egress-gib',
            label: 'CDN data transfer out',
            quantityKey: 'cdnEgressGb',
            unit: 'USD / GiB',
            extractionHint:
              'DigitalOcean Spaces additional (outbound) transfer price per GiB (the "additional transfer" per-GiB overage rate beyond the included allowance) from the Spaces pricing page (flat across regions incl. nyc3).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* egress  (POOLED bandwidth — see file header, rule 7)              */
  /* ------------------------------------------------------------------ */
  {
    id: 'digitalocean:egress',
    provider: 'digitalocean',
    role: 'egress',
    name: 'DigitalOcean Bandwidth (pooled)',
    kind: 'managed',
    description:
      'Internet data transfer out from DigitalOcean resources, billed per GiB on aggregate overage only. Every Droplet, container and database contributes a transfer allowance to one account-wide pool.',
    pricingUrl: 'https://www.digitalocean.com/pricing/droplets',
    docsUrl: 'https://docs.digitalocean.com/products/billing/bandwidth/',
    scalingScore: 4,
    simplicityScore: 5,
    tradeoff:
      'The pooled free allowance is generous, so egress is often free at small scale — but the flat overage rate has no volume discount at very high scale.',
    freeTierNote:
      'Bandwidth allowances from all Droplets/containers/databases are pooled account-wide; only aggregate transfer beyond the pool is charged.',
    skus: [
      {
        id: 'digitalocean:egress:pooled',
        displayName: 'Pooled data transfer out',
        tier: 'small',
        specs: { summary: 'Account-wide pooled allowance · per-GiB on aggregate overage only' },
        dimensions: [
          {
            id: 'egress-gib',
            label: 'Data transfer out (overage)',
            quantityKey: 'egressGb',
            unit: 'USD / GiB',
            extractionHint:
              'DigitalOcean outbound data transfer overage price per GiB charged on aggregate transfer beyond the pooled allowance (the excess-transfer per-GiB rate), from the DigitalOcean pricing pages (flat across regions incl. nyc3).',
          },
        ],
        notes:
          'Bandwidth is pooled across the account; the pooled monthly allowance is carried as includedQuantity in the price book (fetched, not assumed), so only aggregate overage is billed here.',
      },
    ],
  },
];
