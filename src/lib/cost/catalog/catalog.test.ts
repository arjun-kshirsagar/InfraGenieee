/**
 * Tests for the Feature 2 service catalog (AWS + GCP halves, task B2).
 *
 * These run OFFLINE and FREE — the catalog is static data. They are structural
 * guards, not price checks: the catalog by design contains NO prices, and one
 * of the tests below mechanically enforces that it stays that way (docs §2,
 * "Why the catalog holds no prices").
 */

import { describe, expect, it } from 'vitest';

import { awsServices } from '@/lib/cost/catalog/aws';
import { gcpServices } from '@/lib/cost/catalog/gcp';
import { serviceCatalog } from '@/lib/cost/catalog';
import {
  serviceCatalogSchema,
  catalogServiceSchema,
  QUANTITY_KEYS,
  CATALOG_VERSION,
  type CatalogService,
  type InfraRole,
} from '@/types/cost';

/**
 * The §9 coverage grid, transcribed for AWS and GCP only (B3 adds the rest).
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

/**
 * The known-bad URL table from docs §4. A `pricingUrl` pointing at any of these
 * fetches zero (or JS-rendered) prices and must never appear in the catalog.
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

  it('contains only aws and gcp services (B3 adds the rest)', () => {
    const providers = new Set(serviceCatalog.services.map((s) => s.provider));
    expect([...providers].sort()).toEqual(['aws', 'gcp']);
  });

  it('has no duplicate service ids across providers', () => {
    const ids = serviceCatalog.services.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate SKU ids across the whole catalog', () => {
    const skuIds = serviceCatalog.services.flatMap((s) => s.skus.map((k) => k.id));
    expect(new Set(skuIds).size).toBe(skuIds.length);
  });
});

describe.each([
  ['aws', awsServices, AWS_COVERAGE],
  ['gcp', gcpServices, GCP_COVERAGE],
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
      expect(rolesPresent.has(role)).toBe(mustExist);
    }
  });

  it('gives every service between 1 and 4 SKUs', () => {
    for (const svc of services) {
      expect(svc.skus.length).toBeGreaterThanOrEqual(1);
      expect(svc.skus.length).toBeLessThanOrEqual(4);
    }
  });

  it('never points a pricingUrl at a known-bad URL', () => {
    for (const svc of services) {
      for (const bad of KNOWN_BAD_URLS) {
        expect(svc.pricingUrl.includes(bad)).toBe(false);
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

  it('every extractionHint names a region so it can pin one row', () => {
    // us-east-1 hints say "US East (N. Virginia)"/"us-east-1";
    // us-central1 hints say "us-central1"/"Iowa"/"North America".
    const regionSignals = [
      'us-east-1',
      'US East (N. Virginia)',
      'us-central1',
      'Iowa',
      'North America',
      'all Google Cloud regions',
      // CloudFront prices by geographic pricing-region, not AWS region:
      'United States, Mexico, and Canada',
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

describe('service catalog — GCP search is intentionally absent', () => {
  it('has no gcp service filling the search role', () => {
    const gcpSearch = serviceCatalog.services.filter(
      (s) => s.provider === 'gcp' && s.role === 'search',
    );
    expect(gcpSearch).toHaveLength(0);
  });

  it('does have an aws service filling the search role (OpenSearch)', () => {
    const awsSearch = serviceCatalog.services.filter(
      (s) => s.provider === 'aws' && s.role === 'search',
    );
    expect(awsSearch.length).toBeGreaterThanOrEqual(1);
  });
});
