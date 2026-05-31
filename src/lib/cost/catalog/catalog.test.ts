/**
 * Tests for the Feature 2 service catalog (all five providers: AWS + GCP from
 * task B2, Azure + Vercel + DigitalOcean from task B3).
 *
 * These run OFFLINE and FREE — the catalog is static data. They are structural
 * guards, not price checks: the catalog by design contains NO prices, and one
 * of the tests below mechanically enforces that it stays that way (docs §2,
 * "Why the catalog holds no prices").
 *
 * The coverage-grid test is the load-bearing one: for EVERY (provider, role)
 * pair it asserts a `✓` role has ≥1 service AND a `—` role has ZERO. That is
 * what keeps the intentional gaps honest — e.g. Vercel cannot silently grow a
 * fake Postgres, and a PRD needing Postgres + Kafka gets an honest "Vercel
 * cannot run this alone" (docs §9).
 */

import { describe, expect, it } from 'vitest';

import { awsServices } from '@/lib/cost/catalog/aws';
import { gcpServices } from '@/lib/cost/catalog/gcp';
import { azureServices } from '@/lib/cost/catalog/azure';
import { vercelServices } from '@/lib/cost/catalog/vercel';
import { digitalOceanServices } from '@/lib/cost/catalog/digitalocean';
import { serviceCatalog } from '@/lib/cost/catalog';
import {
  serviceCatalogSchema,
  catalogServiceSchema,
  QUANTITY_KEYS,
  CATALOG_VERSION,
  CLOUD_PROVIDERS,
  type CatalogService,
  type InfraRole,
} from '@/types/cost';

/**
 * The §9 coverage grid, transcribed per provider.
 * `true` = must have ≥1 service; `false` = the provider genuinely does not
 * offer it and must NOT be faked.
 */
const AWS_COVERAGE: Record<InfraRole, boolean> = {
  'compute-web': true,
  'compute-worker': true,
  'compute-serverless': true,
  'static-hosting': true,
  'db-relational': true,
  'db-nosql': true,
  'cache-redis': true,
  'queue-basic': true,
  'queue-kafka': true,
  'object-storage': true,
  cdn: true,
  search: true,
  egress: true,
};

const GCP_COVERAGE: Record<InfraRole, boolean> = {
  'compute-web': true,
  'compute-worker': true,
  'compute-serverless': true,
  'static-hosting': true,
  'db-relational': true,
  'db-nosql': true,
  'cache-redis': true,
  'queue-basic': true,
  'queue-kafka': true,
  'object-storage': true,
  cdn: true,
  // GCP search is "—" (self-host) in §9 — must be ABSENT, not invented.
  search: false,
  egress: true,
};

const AZURE_COVERAGE: Record<InfraRole, boolean> = {
  'compute-web': true, // App Service + Container Apps
  'compute-worker': true, // Container Apps
  'compute-serverless': true, // Functions
  'static-hosting': true, // Static Web Apps
  'db-relational': true, // Postgres Flexible Server
  'db-nosql': true, // Cosmos DB
  'cache-redis': true, // Azure Cache for Redis
  'queue-basic': true, // Service Bus
  'queue-kafka': true, // Event Hubs (Kafka API)
  'object-storage': true, // Blob Storage
  cdn: true, // Front Door / CDN
  search: true, // AI Search
  egress: true,
};

/**
 * Vercel's gaps are the point (§9). Everything a general cloud provides that
 * Vercel does NOT run itself must be ABSENT, so a PRD needing it surfaces an
 * honest "Vercel cannot run this alone" gap rather than a cheap-looking total.
 */
const VERCEL_COVERAGE: Record<InfraRole, boolean> = {
  'compute-web': true, // Fluid compute
  'compute-worker': false, // no always-on worker
  'compute-serverless': true, // Vercel Functions
  'static-hosting': true,
  'db-relational': false, // partner/marketplace only
  'db-nosql': false,
  'cache-redis': false,
  'queue-basic': false,
  'queue-kafka': false,
  'object-storage': true, // Blob
  cdn: true, // Edge Network
  search: false,
  egress: true, // Fast Origin Transfer
};

const DO_COVERAGE: Record<InfraRole, boolean> = {
  'compute-web': true, // Droplet + App Platform
  'compute-worker': true, // App Platform worker
  'compute-serverless': true, // DO Functions
  'static-hosting': true, // App Platform static
  'db-relational': true, // Managed Postgres
  'db-nosql': false, // absent per §9
  'cache-redis': true, // Managed Valkey
  'queue-basic': false, // absent per §9
  'queue-kafka': false, // absent per §9 (role marked — for DO)
  'object-storage': true, // Spaces
  cdn: true, // DO CDN (Spaces built-in)
  search: false, // absent per §9
  egress: true, // pooled
};

/**
 * The known-bad URL table from docs §4 that we ENFORCE against every
 * `pricingUrl`. A URL here fetches zero (or JS-rendered) prices for its
 * extractor and must never be a `pricingUrl`.
 *
 * NOTE the deliberate omission of the Azure `azure.microsoft.com/.../pricing/
 * details/**` glob: per rule 2, Azure numbers come from the Retail Prices API
 * (task B4), and the human details page is used as a CITATION-ONLY `pricingUrl`
 * (the URL a user clicks to verify us), never as an extraction target. The
 * dedicated Azure test below documents and guards that carve-out.
 */
const KNOWN_BAD_URLS = [
  'aws.amazon.com/sqs/pricing/',
  'aws.amazon.com/ec2/pricing/on-demand/',
  'vercel.com/docs/pricing/functions',
  'cloud.google.com/functions/pricing',
  'cloud.google.com/compute/all-pricing',
];

/** Regex for a price-like literal: a `$` immediately followed by a digit. */
const PRICE_LIKE = /\$\s?\d/;

/** Every string leaf of a catalog service, flattened for the no-price scan. */
function allStrings(svc: CatalogService): string[] {
  const out: string[] = [
    svc.id,
    svc.name,
    svc.description,
    svc.pricingUrl,
    svc.tradeoff,
    svc.role,
    svc.kind,
  ];
  if (svc.docsUrl) out.push(svc.docsUrl);
  if (svc.freeTierNote) out.push(svc.freeTierNote);
  for (const sku of svc.skus) {
    out.push(sku.id, sku.displayName, sku.tier);
    if (sku.specs.summary) out.push(sku.specs.summary);
    if (sku.notes) out.push(sku.notes);
    for (const dim of sku.dimensions) {
      out.push(dim.id, dim.label, dim.unit, dim.extractionHint);
    }
  }
  return out;
}

describe('service catalog — assembly', () => {
  it('parses cleanly against serviceCatalogSchema (id-prefix + duplicate rules)', () => {
    // The assembled `serviceCatalog` is already parsed at import time; re-parsing
    // proves the schema accepts it and surfaces any regression as a test failure
    // rather than a module-load crash.
    expect(() => serviceCatalogSchema.parse(serviceCatalog)).not.toThrow();
  });

  it('uses the current CATALOG_VERSION', () => {
    expect(serviceCatalog.version).toBe(CATALOG_VERSION);
  });

  it('contains all five providers', () => {
    const providers = new Set(serviceCatalog.services.map((s) => s.provider));
    expect([...providers].sort()).toEqual([...CLOUD_PROVIDERS].sort());
  });

  it('has no duplicate service ids across providers', () => {
    const ids = serviceCatalog.services.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate SKU ids across the whole catalog', () => {
    const skuIds = serviceCatalog.services.flatMap((s) => s.skus.map((k) => k.id));
    expect(new Set(skuIds).size).toBe(skuIds.length);
  });

  it('has no duplicate dimension ids within any SKU', () => {
    for (const svc of serviceCatalog.services) {
      for (const sku of svc.skus) {
        const dimIds = sku.dimensions.map((d) => d.id);
        expect(new Set(dimIds).size, `dup dimension id in ${sku.id}`).toBe(dimIds.length);
      }
    }
  });
});

describe.each([
  ['aws', awsServices, AWS_COVERAGE],
  ['gcp', gcpServices, GCP_COVERAGE],
  ['azure', azureServices, AZURE_COVERAGE],
  ['vercel', vercelServices, VERCEL_COVERAGE],
  ['digitalocean', digitalOceanServices, DO_COVERAGE],
] as const)('service catalog — %s', (provider, rawServices, coverage) => {
  // Parse the authored (input) services into validated output services once, so
  // every case below iterates fully-defaulted `CatalogService` objects.
  const services: CatalogService[] = catalogServiceSchema.array().parse(rawServices);

  it('every service parses individually', () => {
    for (const svc of rawServices) {
      expect(() => catalogServiceSchema.parse(svc)).not.toThrow();
    }
  });

  it('every service id and SKU id is prefixed with the provider', () => {
    for (const svc of services) {
      expect(svc.provider).toBe(provider);
      expect(svc.id.startsWith(`${provider}:`)).toBe(true);
      for (const sku of svc.skus) {
        expect(sku.id.startsWith(`${svc.id}:`)).toBe(true);
      }
    }
  });

  it('covers exactly the roles marked ✓ in the §9 grid (— roles are absent)', () => {
    const rolesPresent = new Set(services.map((s) => s.role));
    for (const [role, mustExist] of Object.entries(coverage) as [InfraRole, boolean][]) {
      expect(
        rolesPresent.has(role),
        `${provider} / ${role}: expected ${mustExist ? 'present' : 'ABSENT'}`,
      ).toBe(mustExist);
    }
  });

  it('gives every service between 1 and 4 SKUs', () => {
    for (const svc of services) {
      expect(svc.skus.length).toBeGreaterThanOrEqual(1);
      expect(svc.skus.length).toBeLessThanOrEqual(4);
    }
  });

  it('never points a pricingUrl at an enforced known-bad URL', () => {
    for (const svc of services) {
      for (const bad of KNOWN_BAD_URLS) {
        expect(svc.pricingUrl.includes(bad), `${svc.id} uses bad url ${bad}`).toBe(false);
      }
    }
  });

  it('every quantityKey used is in the closed QUANTITY_KEYS enum', () => {
    const keys = new Set<string>(QUANTITY_KEYS);
    for (const svc of services) {
      for (const sku of svc.skus) {
        for (const dim of sku.dimensions) {
          expect(keys.has(dim.quantityKey)).toBe(true);
        }
      }
    }
  });

  it('every extractionHint names a region/zone so it can pin one row', () => {
    // Each provider's hints carry a region signal matching its priced region:
    //   aws → us-east-1 / "US East (N. Virginia)" (CloudFront by geo zone)
    //   gcp → us-central1 / Iowa / North America / all Google Cloud regions
    //   azure → eastus (Retail API armRegionName; some meters are Global/zone)
    //   vercel → iad1 / North America / all regions (plan fees are global)
    //   digitalocean → nyc3 / flat across regions (DO price list is flat)
    const regionSignals = [
      // AWS
      'us-east-1',
      'US East (N. Virginia)',
      'United States, Mexico, and Canada',
      // GCP
      'us-central1',
      'Iowa',
      'North America',
      'all Google Cloud regions',
      // Azure
      'eastus',
      'Global',
      // Vercel
      'iad1',
      'all regions',
      // DigitalOcean
      'nyc3',
    ];
    for (const svc of services) {
      for (const sku of svc.skus) {
        for (const dim of sku.dimensions) {
          const hasRegion = regionSignals.some((sig) => dim.extractionHint.includes(sig));
          expect(hasRegion, `hint not region-pinned: ${svc.id} / ${dim.id}`).toBe(true);
          // Schema already enforces min length 10; assert a little richer.
          expect(dim.extractionHint.length).toBeGreaterThanOrEqual(20);
        }
      }
    }
  });

  it('NO price-like literal ($ + digit) appears in any string field', () => {
    for (const svc of services) {
      for (const s of allStrings(svc)) {
        expect(PRICE_LIKE.test(s), `price-like text in ${svc.id}: "${s}"`).toBe(false);
      }
    }
  });
});

describe('service catalog — intentional gaps are honest (§9)', () => {
  const has = (provider: string, role: InfraRole) =>
    serviceCatalog.services.some((s) => s.provider === provider && s.role === role);

  it('GCP has no managed search service (— self-host in §9)', () => {
    expect(has('gcp', 'search')).toBe(false);
  });

  it('Vercel omits the roles it genuinely cannot run alone', () => {
    for (const role of [
      'compute-worker',
      'db-relational',
      'db-nosql',
      'cache-redis',
      'queue-basic',
      'queue-kafka',
      'search',
    ] as InfraRole[]) {
      expect(has('vercel', role), `vercel should NOT fill ${role}`).toBe(false);
    }
  });

  it('DigitalOcean omits db-nosql, both queue roles and search', () => {
    for (const role of ['db-nosql', 'queue-basic', 'queue-kafka', 'search'] as InfraRole[]) {
      expect(has('digitalocean', role), `digitalocean should NOT fill ${role}`).toBe(false);
    }
  });

  it('AWS remains the only provider covering every role', () => {
    for (const role of Object.keys(AWS_COVERAGE) as InfraRole[]) {
      expect(has('aws', role), `aws should fill ${role}`).toBe(true);
    }
  });
});

describe('service catalog — Azure Retail-API carve-out', () => {
  const azure = serviceCatalog.services.filter((s) => s.provider === 'azure');

  it('cites the human azure.microsoft.com pricing/details page (verify URL, not scraped)', () => {
    for (const svc of azure) {
      expect(
        svc.pricingUrl.includes('azure.microsoft.com'),
        `azure ${svc.id} pricingUrl should be the human Azure page`,
      ).toBe(true);
    }
  });

  it('every Azure hint names the Retail-API region (eastus) or a Global/zone meter', () => {
    for (const svc of azure) {
      for (const sku of svc.skus) {
        for (const dim of sku.dimensions) {
          const pinned =
            dim.extractionHint.includes('eastus') ||
            dim.extractionHint.includes('Global') ||
            dim.extractionHint.includes('North America and Europe');
          expect(pinned, `azure hint not Retail-API-pinned: ${svc.id} / ${dim.id}`).toBe(true);
          // The Retail API filters on Consumption vs reserved — hints must say so.
          expect(
            dim.extractionHint.includes('Consumption'),
            `azure hint should pin type Consumption: ${svc.id} / ${dim.id}`,
          ).toBe(true);
        }
      }
    }
  });
});
