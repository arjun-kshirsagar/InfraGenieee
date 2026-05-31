/**
 * Azure half of the Feature 2 service catalog — STRUCTURE ONLY, NO PRICES.
 *
 * As with `aws.ts` / `gcp.ts`, this file declares only *what* to fetch and
 * *where*. There is no field for a price here and there must never be one in a
 * comment or a `notes` string. Numbers arrive only as fetched, cited
 * `PriceRecord`s through the evidence gate — see
 * `docs/feature-2-cost-predictor.md` §5.
 *
 * Priced region: eastus / "East US" (see `PRICED_REGION`).
 *
 * ## Sourcing notes (why the hints look the way they do) — READ THIS
 *
 * Per §4 of the design doc, **Azure's human pricing pages are useless to a
 * scraper**: `azure.microsoft.com/en-us/pricing/details/**` renders every price
 * cell as literally `$-` (values are JS-injected after load). A 213-row Postgres
 * table comes back with every price `$-`. So an extractor pointed at those pages
 * can only fail or hallucinate.
 *
 * Azure numbers therefore come from the **free, public, unauthenticated Azure
 * Retail Prices API** (`https://prices.azure.com/api/retail/prices`, wired up in
 * task B4), NOT from the HTML page. The Retail API filters on structured
 * identity fields — `armRegionName`, `serviceName`, `productName`, `meterName`,
 * `type` (`Consumption`) — so every `extractionHint` below is written to name
 * that Retail-API-visible identity verbatim (service + product/meter + region +
 * `Consumption`), which is exactly what B4's `$filter` pins on. A vague hint
 * ("the redis price") would let B4 pick a plausible neighbour (reserved, wrong
 * region, wrong meter) and be confidently wrong.
 *
 * `pricingUrl` here is still the **human** `azure.microsoft.com/.../pricing/
 * details/**` page, per rule 2 — that is the URL a user clicks to verify us and
 * what `PriceSource.url` cites. It is deliberately citation-only; we never treat
 * it as extractable. (That is why the Azure details glob appears in the design
 * doc's known-bad *extraction* table but is intentionally allowed as a
 * `pricingUrl` here — see the catalog test for the matching carve-out.)
 */

import type { CatalogServiceInput } from './types';

export const azureServices: CatalogServiceInput[] = [
  /* ------------------------------------------------------------------ */
  /* compute-web                                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:app-service',
    provider: 'azure',
    role: 'compute-web',
    name: 'Azure App Service',
    kind: 'platform',
    description:
      'Fully managed platform for web apps and APIs on Linux. You pick an App Service Plan (a dedicated VM tier); billed per plan instance-hour with the platform handling OS, scaling and TLS.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/app-service/linux/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/app-service/overview',
    scalingScore: 4,
    simplicityScore: 5,
    tradeoff:
      'A dedicated App Service Plan instance runs 24/7 whether or not it gets traffic — for spiky load Container Apps or Functions scale to zero instead.',
    freeTierNote: 'The F1 Free tier offers 60 CPU-minutes/day and 1 GB storage for dev/test, with no SLA.',
    skus: [
      {
        id: 'azure:app-service:b1',
        displayName: 'Basic B1',
        tier: 'starter',
        specs: { vcpu: 1, memoryGb: 1.75, summary: '1 vCPU · 1.75 GB · Basic plan · Linux' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Plan instance runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Azure App Service Linux Basic plan B1 instance (1 core, 1.75 GB) price per hour, serviceName "Azure App Service", region eastus, type Consumption.',
          },
        ],
      },
      {
        id: 'azure:app-service:p0v3',
        displayName: 'Premium P0v3',
        tier: 'small',
        specs: { vcpu: 1, memoryGb: 4, summary: '1 vCPU · 4 GB · Premium v3 · Linux' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Plan instance runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Azure App Service Linux Premium v3 plan P0v3 instance (1 vCPU, 4 GB) price per hour, serviceName "Azure App Service", region eastus, type Consumption.',
          },
        ],
      },
      {
        id: 'azure:app-service:p1v3',
        displayName: 'Premium P1v3',
        tier: 'medium',
        specs: { vcpu: 2, memoryGb: 8, summary: '2 vCPU · 8 GB · Premium v3 · Linux' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Plan instance runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Azure App Service Linux Premium v3 plan P1v3 instance (2 vCPU, 8 GB) price per hour, serviceName "Azure App Service", region eastus, type Consumption.',
          },
        ],
      },
    ],
  },
  {
    id: 'azure:container-apps',
    provider: 'azure',
    role: 'compute-web',
    name: 'Azure Container Apps',
    kind: 'serverless',
    description:
      'Serverless containers that scale to zero and back. Consumption plan bills per vCPU-second and GiB-second of active time plus per-request. No cluster to manage.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/container-apps/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/container-apps/overview',
    scalingScore: 5,
    simplicityScore: 4,
    tradeoff:
      'Per-second Consumption pricing costs more than a fixed App Service Plan at steady 24/7 load — Container Apps wins on spiky traffic and scale-to-zero.',
    freeTierNote:
      'Consumption plan includes a monthly free grant of 180,000 vCPU-seconds, 360,000 GiB-seconds and 2M requests per subscription.',
    skus: [
      {
        id: 'azure:container-apps:consumption',
        displayName: 'Container Apps (Consumption)',
        tier: 'small',
        specs: { summary: 'Consumption plan · scale-to-zero · per vCPU-s + GiB-s + requests' },
        dimensions: [
          {
            id: 'vcpu-second',
            label: 'vCPU active time',
            quantityKey: 'vcpuSeconds',
            unit: 'USD / vCPU-second',
            extractionHint:
              'Azure Container Apps Consumption plan active vCPU price per second, serviceName "Azure Container Apps", region eastus, type Consumption (active usage, not idle).',
          },
          {
            id: 'gib-second',
            label: 'Memory active time',
            quantityKey: 'gbRamSeconds',
            unit: 'USD / GiB-second',
            extractionHint:
              'Azure Container Apps Consumption plan active memory price per GiB-second, serviceName "Azure Container Apps", region eastus, type Consumption (active usage, not idle).',
          },
          {
            id: 'requests',
            label: 'Requests',
            quantityKey: 'requests',
            unit: 'USD / million requests',
            extractionHint:
              'Azure Container Apps Consumption plan requests price per million requests, serviceName "Azure Container Apps", region eastus, type Consumption.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* compute-worker  (Container Apps run as a background consumer)      */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:container-apps-worker',
    provider: 'azure',
    role: 'compute-worker',
    name: 'Azure Container Apps (worker)',
    kind: 'serverless',
    description:
      'The same Container Apps platform run as a background worker / queue consumer (a scale rule instead of an ingress). Consumption plan bills per vCPU-second and GiB-second of active time.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/container-apps/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/container-apps/background-processing',
    scalingScore: 4,
    simplicityScore: 4,
    tradeoff:
      'For a worker pinned at 100% CPU around the clock, a dedicated App Service Plan or VM is cheaper than per-second Consumption billing.',
    skus: [
      {
        id: 'azure:container-apps-worker:consumption',
        displayName: 'Worker (Consumption)',
        tier: 'small',
        specs: { summary: 'Consumption plan · KEDA-scaled worker · per vCPU-s + GiB-s' },
        dimensions: [
          {
            id: 'vcpu-second',
            label: 'vCPU active time',
            quantityKey: 'vcpuSeconds',
            unit: 'USD / vCPU-second',
            extractionHint:
              'Azure Container Apps Consumption plan active vCPU price per second, serviceName "Azure Container Apps", region eastus, type Consumption (active usage, not idle).',
          },
          {
            id: 'gib-second',
            label: 'Memory active time',
            quantityKey: 'gbRamSeconds',
            unit: 'USD / GiB-second',
            extractionHint:
              'Azure Container Apps Consumption plan active memory price per GiB-second, serviceName "Azure Container Apps", region eastus, type Consumption (active usage, not idle).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* compute-serverless  (Azure Functions)                             */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:functions',
    provider: 'azure',
    role: 'compute-serverless',
    name: 'Azure Functions',
    kind: 'serverless',
    description:
      'Per-request functions on the Consumption plan that scale to zero. Billed on execution count and GB-seconds of execution (memory × duration). Ideal for spiky, event-driven work.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/functions/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/azure-functions/functions-overview',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'At sustained high throughput the per-GB-second rate overtakes an always-on plan — Functions win on spiky, not steady, load.',
    freeTierNote: 'Consumption plan includes 1M free executions and 400,000 GB-seconds per month.',
    skus: [
      {
        id: 'azure:functions:consumption',
        displayName: 'Functions (Consumption)',
        tier: 'small',
        specs: { summary: 'Consumption plan · scale-to-zero · per execution + GB-second' },
        dimensions: [
          {
            id: 'executions',
            label: 'Executions',
            quantityKey: 'invocations',
            unit: 'USD / million executions',
            extractionHint:
              'Azure Functions Consumption plan total executions price per million executions, serviceName "Functions", region eastus, type Consumption (the flat execution charge, not the GB-s charge).',
          },
          {
            id: 'gb-second',
            label: 'Execution duration',
            quantityKey: 'gbSeconds',
            unit: 'USD / GB-second',
            extractionHint:
              'Azure Functions Consumption plan execution time price per GB-second (resource consumption), serviceName "Functions", region eastus, type Consumption.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* static-hosting  (Static Web Apps)                                 */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:static-web-apps',
    provider: 'azure',
    role: 'static-hosting',
    name: 'Azure Static Web Apps',
    kind: 'platform',
    description:
      'Static site / SPA hosting with a global CDN and integrated APIs. The Standard plan is a flat monthly app fee; the Free plan hosts hobby sites at no cost with lower limits.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/app-service/static/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/static-web-apps/overview',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'Serves static assets plus lightweight managed APIs — a heavy server-rendered backend still needs a compute-web service alongside it.',
    freeTierNote:
      'The Free plan hosts static apps with 100 GB/month bandwidth and free managed certificates; suitable for personal and hobby sites.',
    skus: [
      {
        id: 'azure:static-web-apps:standard',
        displayName: 'Static Web Apps Standard',
        tier: 'small',
        specs: { summary: 'Standard plan · flat monthly app fee · global CDN + managed APIs' },
        dimensions: [
          {
            id: 'app-month',
            label: 'App monthly fee',
            quantityKey: 'months',
            unit: 'USD / app-month',
            extractionHint:
              'Azure Static Web Apps Standard plan flat monthly price per app, serviceName "Azure App Service" Static Web Apps Standard, region eastus, type Consumption.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* db-relational  (Postgres Flexible Server)                         */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:postgres-flexible',
    provider: 'azure',
    role: 'db-relational',
    name: 'Azure Database for PostgreSQL Flexible Server',
    kind: 'managed',
    description:
      'Fully managed PostgreSQL: Azure handles backups, patching and HA. You choose a vCore compute tier and provisioned storage; billed per vCore-hour plus storage GB-month.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/overview',
    scalingScore: 3,
    simplicityScore: 4,
    tradeoff:
      'A provisioned Flexible Server instance runs 24/7 regardless of traffic — for intermittent load a scale-to-zero database idles cheaper.',
    freeTierNote:
      'The 12-month free tier includes 750 hours/month of a Burstable B1ms instance and 32 GB storage for new accounts.',
    skus: [
      {
        id: 'azure:postgres-flexible:b1ms',
        displayName: 'Burstable B1ms',
        tier: 'starter',
        specs: { vcpu: 1, memoryGb: 2, summary: '1 vCore · 2 GB · Burstable · single zone' },
        dimensions: [
          {
            id: 'vcore-hour',
            label: 'Compute runtime',
            quantityKey: 'dbInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Azure Database for PostgreSQL Flexible Server Burstable B1ms vCore price per hour, region eastus, type Consumption (the single-instance compute charge).',
          },
          {
            id: 'storage-gb-month',
            label: 'Provisioned storage',
            quantityKey: 'dbStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'Azure Database for PostgreSQL Flexible Server storage price per GB-month, region eastus, type Consumption.',
          },
        ],
      },
      {
        id: 'azure:postgres-flexible:d2ds-v5',
        displayName: 'General Purpose D2ds v5',
        tier: 'small',
        specs: { vcpu: 2, memoryGb: 8, summary: '2 vCore · 8 GB · General Purpose · single zone' },
        dimensions: [
          {
            id: 'vcore-hour',
            label: 'Compute runtime',
            quantityKey: 'dbInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Azure Database for PostgreSQL Flexible Server General Purpose D2ds v5 (2 vCore) price per hour, region eastus, type Consumption (the single-instance compute charge).',
          },
          {
            id: 'storage-gb-month',
            label: 'Provisioned storage',
            quantityKey: 'dbStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'Azure Database for PostgreSQL Flexible Server storage price per GB-month, region eastus, type Consumption.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* db-nosql  (Cosmos DB)                                             */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:cosmos-db',
    provider: 'azure',
    role: 'db-nosql',
    name: 'Azure Cosmos DB',
    kind: 'serverless',
    description:
      'Globally distributed multi-model NoSQL database. Serverless mode bills per request unit (RU) consumed plus stored GB, with no throughput to provision — scales to near-zero at rest.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/cosmos-db/autoscale-provisioned/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/cosmos-db/introduction',
    scalingScore: 5,
    simplicityScore: 4,
    tradeoff:
      'A request-unit access model — for ad-hoc joins and rich relational queries a PostgreSQL database fits better.',
    freeTierNote:
      'The free tier gives the first 1,000 RU/s provisioned throughput and 25 GB storage free per account, indefinitely.',
    skus: [
      {
        id: 'azure:cosmos-db:serverless',
        displayName: 'Cosmos DB Serverless',
        tier: 'small',
        specs: { summary: 'Serverless · pay per request unit + stored GB' },
        dimensions: [
          {
            id: 'request-units',
            label: 'Request units',
            quantityKey: 'nosqlWrites',
            unit: 'USD / million RUs',
            extractionHint:
              'Azure Cosmos DB Serverless price per million request units (RUs) consumed, serviceName "Azure Cosmos DB", region eastus, type Consumption.',
          },
          {
            id: 'storage-gb-month',
            label: 'Stored data',
            quantityKey: 'nosqlStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'Azure Cosmos DB transactional storage price per GB-month, serviceName "Azure Cosmos DB", region eastus, type Consumption.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* cache-redis  (Azure Cache for Redis)                             */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:cache-redis',
    provider: 'azure',
    role: 'cache-redis',
    name: 'Azure Cache for Redis',
    kind: 'managed',
    description:
      'Managed Redis-compatible in-memory cache. You choose a tier and cache size; billed per cache instance-hour. Azure handles the engine, patching and failover.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/cache/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/azure-cache-for-redis/cache-overview',
    scalingScore: 3,
    simplicityScore: 4,
    tradeoff:
      'A provisioned cache instance runs 24/7 regardless of hit rate — for very small or bursty caches a lower tier or a colocated cache may cost less.',
    skus: [
      {
        id: 'azure:cache-redis:basic-c0',
        displayName: 'Basic C0 (250 MB)',
        tier: 'starter',
        specs: { memoryGb: 0.25, nodes: 1, summary: '250 MB · Basic tier · single node' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Cache runtime',
            quantityKey: 'cacheInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Azure Cache for Redis Basic tier C0 (250 MB) price per hour, serviceName "Redis Cache", region eastus, type Consumption.',
          },
        ],
      },
      {
        id: 'azure:cache-redis:standard-c1',
        displayName: 'Standard C1 (1 GB)',
        tier: 'small',
        specs: { memoryGb: 1, nodes: 2, summary: '1 GB · Standard tier · replicated' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Cache runtime',
            quantityKey: 'cacheInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Azure Cache for Redis Standard tier C1 (1 GB) price per hour, serviceName "Redis Cache", region eastus, type Consumption.',
          },
        ],
      },
      {
        id: 'azure:cache-redis:standard-c3',
        displayName: 'Standard C3 (6 GB)',
        tier: 'medium',
        specs: { memoryGb: 6, nodes: 2, summary: '6 GB · Standard tier · replicated' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Cache runtime',
            quantityKey: 'cacheInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Azure Cache for Redis Standard tier C3 (6 GB) price per hour, serviceName "Redis Cache", region eastus, type Consumption.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* queue-basic  (Service Bus)                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:service-bus',
    provider: 'azure',
    role: 'queue-basic',
    name: 'Azure Service Bus',
    kind: 'managed',
    description:
      'Enterprise message broker with queues and topics. The Standard tier is a flat monthly base fee plus a per-operation (million-operations) charge; no brokers to run.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/service-bus/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-messaging-overview',
    scalingScore: 4,
    simplicityScore: 4,
    tradeoff:
      'A queue/topic broker with at-least-once delivery — for durable, replayable event streams choose Event Hubs (Kafka) instead.',
    freeTierNote: 'The Standard tier includes a monthly allowance of 12.5M operations in the base charge.',
    skus: [
      {
        id: 'azure:service-bus:standard',
        displayName: 'Service Bus Standard',
        tier: 'small',
        specs: { summary: 'Standard tier · base monthly fee + per-operation overage' },
        dimensions: [
          {
            id: 'base-month',
            label: 'Base monthly fee',
            quantityKey: 'months',
            unit: 'USD / month',
            extractionHint:
              'Azure Service Bus Standard tier base unit price per month, serviceName "Service Bus", region eastus, type Consumption (the flat base charge, not the per-operation overage).',
          },
          {
            id: 'operations',
            label: 'Messaging operations',
            quantityKey: 'queueMessages',
            unit: 'USD / million operations',
            extractionHint:
              'Azure Service Bus Standard tier messaging operations price per million operations beyond the included allowance, serviceName "Service Bus", region eastus, type Consumption.',
            required: false,
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* queue-kafka  (Event Hubs with the Kafka API)                     */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:event-hubs',
    provider: 'azure',
    role: 'queue-kafka',
    name: 'Azure Event Hubs (Kafka API)',
    kind: 'managed',
    description:
      'Managed event streaming that speaks the Apache Kafka protocol. The Standard tier bills a per-Throughput-Unit-hour charge plus a per-million-events ingress charge. Durable, replayable streams.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/event-hubs/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/event-hubs/event-hubs-for-kafka-ecosystem-overview',
    scalingScore: 4,
    simplicityScore: 3,
    tradeoff:
      'Throughput Units run continuously and add up for a low-volume queue — reach for Service Bus unless you genuinely need Kafka-style replayable streams.',
    skus: [
      {
        id: 'azure:event-hubs:standard',
        displayName: 'Event Hubs Standard',
        tier: 'small',
        specs: { summary: 'Standard tier · Kafka endpoint · per Throughput-Unit-hour + ingress' },
        dimensions: [
          {
            id: 'tu-hour',
            label: 'Throughput Unit runtime',
            quantityKey: 'kafkaBrokerHours',
            unit: 'USD / TU-hour',
            extractionHint:
              'Azure Event Hubs Standard tier Throughput Unit price per hour, serviceName "Event Hubs", region eastus, type Consumption.',
          },
          {
            id: 'ingress-events',
            label: 'Ingress events',
            quantityKey: 'queueMessages',
            unit: 'USD / million events',
            extractionHint:
              'Azure Event Hubs Standard tier ingress events price per million events, serviceName "Event Hubs", region eastus, type Consumption.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* object-storage  (Blob Storage)                                   */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:blob-storage',
    provider: 'azure',
    role: 'object-storage',
    name: 'Azure Blob Storage',
    kind: 'managed',
    description:
      'Durable object storage for uploads, backups and blobs. Billed on stored GB-month plus write (PUT) and read (GET) operation charges. The default access tier is Hot.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/storage/blobs/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-introduction',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'Object storage, not a filesystem — apps needing POSIX file semantics want Azure Files instead.',
    skus: [
      {
        id: 'azure:blob-storage:hot-lrs',
        displayName: 'Blob Hot (LRS)',
        tier: 'small',
        specs: { summary: 'Hot access tier · locally-redundant (LRS) · single region' },
        dimensions: [
          {
            id: 'storage-gb-month',
            label: 'Stored data',
            quantityKey: 'objectStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'Azure Blob Storage Hot tier data stored price per GB-month for locally-redundant storage (LRS), serviceName "Storage", region eastus, type Consumption, meter containing "Data Stored".',
          },
          {
            id: 'write-ops',
            label: 'Write operations',
            quantityKey: 'objectWriteOps',
            unit: 'USD / 10,000 operations',
            extractionHint:
              'Azure Blob Storage Hot tier write operations (PUT, Create Container, List) price per 10,000 operations for LRS, serviceName "Storage", region eastus, type Consumption.',
          },
          {
            id: 'read-ops',
            label: 'Read operations',
            quantityKey: 'objectReadOps',
            unit: 'USD / 10,000 operations',
            extractionHint:
              'Azure Blob Storage Hot tier read operations (GET and all other) price per 10,000 operations for LRS, serviceName "Storage", region eastus, type Consumption.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* cdn  (Azure Front Door)                                          */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:front-door',
    provider: 'azure',
    role: 'cdn',
    name: 'Azure Front Door',
    kind: 'managed',
    description:
      'Global CDN and edge cache in front of your app. The Standard tier bills a flat base fee plus per-GB egress and per-request charges. Includes caching, WAF and routing.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/frontdoor/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/frontdoor/front-door-overview',
    scalingScore: 5,
    simplicityScore: 4,
    tradeoff:
      'The flat base fee makes Front Door pricey for a tiny site — a bandwidth-pooled provider can be cheaper at low volume.',
    skus: [
      {
        id: 'azure:front-door:standard',
        displayName: 'Front Door Standard',
        tier: 'small',
        specs: { summary: 'Standard tier · base fee + per-GB egress + requests · North America' },
        dimensions: [
          {
            id: 'base-month',
            label: 'Base monthly fee',
            quantityKey: 'months',
            unit: 'USD / month',
            extractionHint:
              'Azure Front Door Standard tier base fee price per month, serviceName "Azure Front Door Service", region eastus / Global, type Consumption (the flat base charge).',
          },
          {
            id: 'egress-gb',
            label: 'Data transfer out',
            quantityKey: 'cdnEgressGb',
            unit: 'USD / GB',
            extractionHint:
              'Azure Front Door Standard tier egress data transfer from edge to client price per GB for North America and Europe zone, serviceName "Azure Front Door Service", type Consumption.',
          },
          {
            id: 'requests',
            label: 'Requests',
            quantityKey: 'cdnRequests',
            unit: 'USD / 10,000 requests',
            extractionHint:
              'Azure Front Door Standard tier requests price per 10,000 requests for North America and Europe zone, serviceName "Azure Front Door Service", type Consumption.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* search  (Azure AI Search)                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:ai-search',
    provider: 'azure',
    role: 'search',
    name: 'Azure AI Search',
    kind: 'managed',
    description:
      'Managed full-text and vector search service. You provision a search unit (a tier with fixed storage and replicas); billed per search-unit-hour. Azure runs the cluster.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/search/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/search/search-what-is-azure-search',
    scalingScore: 3,
    simplicityScore: 4,
    tradeoff:
      'A provisioned search unit runs 24/7 with a per-tier storage ceiling — for occasional search a hosted SaaS may cost less.',
    freeTierNote: 'The Free tier offers a shared search service with 50 MB storage and 3 indexes for evaluation.',
    skus: [
      {
        id: 'azure:ai-search:basic',
        displayName: 'AI Search Basic',
        tier: 'starter',
        specs: { storageGb: 2, nodes: 1, summary: 'Basic tier · ~2 GB · 1 replica/partition' },
        dimensions: [
          {
            id: 'unit-hour',
            label: 'Search unit runtime',
            quantityKey: 'searchInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Azure AI Search Basic tier search unit price per hour, serviceName "Azure Cognitive Search", region eastus, type Consumption.',
          },
        ],
      },
      {
        id: 'azure:ai-search:standard-s1',
        displayName: 'AI Search Standard S1',
        tier: 'medium',
        specs: { storageGb: 25, nodes: 1, summary: 'Standard S1 tier · ~25 GB/partition · 1 search unit' },
        dimensions: [
          {
            id: 'unit-hour',
            label: 'Search unit runtime',
            quantityKey: 'searchInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'Azure AI Search Standard S1 tier search unit price per hour, serviceName "Azure Cognitive Search", region eastus, type Consumption.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* egress                                                            */
  /* ------------------------------------------------------------------ */
  {
    id: 'azure:egress',
    provider: 'azure',
    role: 'egress',
    name: 'Azure Bandwidth (Data Transfer Out)',
    kind: 'managed',
    description:
      'Internet data transfer out from Azure compute to the public internet, billed per GB. Frequently a top-three line item that is invisible if you only price the compute and storage.',
    pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/bandwidth/',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/networking/fundamentals/networking-overview',
    scalingScore: 3,
    simplicityScore: 3,
    tradeoff:
      'Origin egress bypasses the CDN — routing user-facing traffic through Front Door usually lands a lower per-GB rate.',
    freeTierNote: 'The first 100 GB/month of internet data transfer out is free across the account.',
    skus: [
      {
        id: 'azure:egress:internet',
        displayName: 'Internet data transfer out',
        tier: 'small',
        specs: { summary: 'Azure → internet · first paid tier · after 100 GB free' },
        dimensions: [
          {
            id: 'egress-gb',
            label: 'Data transfer out',
            quantityKey: 'egressGb',
            unit: 'USD / GB',
            extractionHint:
              'Azure internet egress data transfer out price per GB for the first paid tier (up to 10 TB/month) after the 100 GB free allowance, serviceName "Bandwidth", region eastus / zone 1, type Consumption.',
          },
        ],
      },
    ],
  },
];
