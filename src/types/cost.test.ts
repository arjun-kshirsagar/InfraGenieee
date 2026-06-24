/**
 * Contract tests for the Feature 2 cost schemas.
 *
 * These assert the INTEGRITY RULES, not the happy path — every one of them is a
 * guard against a specific way the three layers (catalog / price book /
 * selection) can silently drift apart and produce a wrong-looking estimate.
 */

import { describe, expect, it } from 'vitest';

import {
  CLOUD_PROVIDERS,
  HOURS_PER_MONTH,
  INFRA_ROLES,
  INFRA_ROLE_LABEL,
  INFRA_ROLE_ORDER,
  PRICED_REGION,
  PRICED_REGION_LABEL,
  PROVIDER_LABEL,
  catalogServiceSchema,
  catalogSkuSchema,
  costSelectionSchema,
  priceBookSchema,
  priceRecordSchema,
  serviceCatalogSchema,
  usageProfileSchema,
  type CatalogService,
} from '@/types/cost';
import { apiErrorSchema } from '@/types/prd';

const sku = {
  id: 'aws:rds-postgres:small',
  displayName: 'db.t4g.small',
  tier: 'small' as const,
  specs: { vcpu: 2, memoryGb: 2 },
  dimensions: [
    {
      id: 'instance-hour',
      label: 'Instance hour',
      quantityKey: 'dbInstanceHours' as const,
      unit: 'USD / hour',
      extractionHint: 'Single-AZ db.t4g.small On-Demand price in US East (N. Virginia)',
    },
  ],
};

const service: CatalogService = catalogServiceSchema.parse({
  id: 'aws:rds-postgres',
  provider: 'aws',
  role: 'db-relational',
  name: 'Amazon RDS for PostgreSQL',
  kind: 'managed',
  description: 'Managed PostgreSQL with automated backups and point-in-time restore.',
  pricingUrl: 'https://aws.amazon.com/rds/postgresql/pricing/',
  scalingScore: 5,
  simplicityScore: 3,
  tradeoff: 'More knobs than a hobby project needs; you pay for the instance around the clock.',
  skus: [sku],
});

describe('enum tables are exhaustive', () => {
  it('labels every provider and names a priced region for each', () => {
    for (const p of CLOUD_PROVIDERS) {
      expect(PROVIDER_LABEL[p]).toBeTruthy();
      expect(PRICED_REGION[p]).toBeTruthy();
      expect(PRICED_REGION_LABEL[p]).toBeTruthy();
    }
  });

  it('labels and orders every infra role exactly once', () => {
    for (const r of INFRA_ROLES) expect(INFRA_ROLE_LABEL[r]).toBeTruthy();
    expect([...INFRA_ROLE_ORDER].sort()).toEqual([...INFRA_ROLES].sort());
    expect(new Set(INFRA_ROLE_ORDER).size).toBe(INFRA_ROLE_ORDER.length);
  });

  it('uses the 730-hour month every vendor calculator uses', () => {
    expect(HOURS_PER_MONTH).toBe(730);
  });
});

describe('catalog id integrity', () => {
  it('rejects a SKU id that is not namespaced under its service', () => {
    const bad = serviceCatalogSchema.safeParse({
      version: '1.0.0',
      services: [{ ...service, skus: [{ ...sku, id: 'aws:elsewhere:small' }] }],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('must be prefixed with service id');
  });

  it('rejects a service id that disagrees with its provider', () => {
    const bad = serviceCatalogSchema.safeParse({
      version: '1.0.0',
      services: [{ ...service, provider: 'gcp' }],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('must be prefixed with provider');
  });

  it('rejects duplicate service ids', () => {
    const bad = serviceCatalogSchema.safeParse({
      version: '1.0.0',
      services: [service, service],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('Duplicate service id');
  });

  it('rejects duplicate dimension ids inside one SKU', () => {
    const bad = serviceCatalogSchema.safeParse({
      version: '1.0.0',
      services: [{ ...service, skus: [{ ...sku, dimensions: [...sku.dimensions, ...sku.dimensions] }] }],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('Duplicate dimension id');
  });

  it('rejects a vague extraction hint (too short to pin a row)', () => {
    const bad = catalogSkuSchema.safeParse({
      ...sku,
      dimensions: [{ ...sku.dimensions[0], extractionHint: 'price' }],
    });
    expect(bad.success).toBe(false);
  });

  it('requires the pricing URL to be a real URL', () => {
    expect(catalogServiceSchema.safeParse({ ...service, pricingUrl: 'rds pricing page' }).success).toBe(
      false,
    );
  });

  it('defaults dimensions to required and units to 1', () => {
    const parsed = catalogSkuSchema.parse(sku);
    expect(parsed.dimensions[0].required).toBe(true);
    expect(parsed.defaultUnits).toBe(1);
  });
});

describe('price records are always cited', () => {
  const source = {
    url: 'https://aws.amazon.com/rds/postgresql/pricing/',
    fetchedAt: '2026-07-26T10:00:00.000Z',
    evidence: '| db.t4g.small | $0.032 |',
    extractorModel: 'claude-haiku-4-5-20251001',
  };

  it('accepts a fully sourced record and defaults the free allowance to zero', () => {
    const parsed = priceRecordSchema.parse({
      skuId: 'aws:rds-postgres:small',
      dimensionId: 'instance-hour',
      unitPriceUsd: 0.032,
      source,
    });
    expect(parsed.includedQuantity).toBe(0);
    expect(parsed.currency).toBe('USD');
  });

  it('rejects a record with no source — an uncited price is a fabricated price', () => {
    expect(
      priceRecordSchema.safeParse({
        skuId: 'aws:rds-postgres:small',
        dimensionId: 'instance-hour',
        unitPriceUsd: 0.032,
      }).success,
    ).toBe(false);
  });

  it('rejects a record whose source carries no evidence excerpt', () => {
    expect(
      priceRecordSchema.safeParse({
        skuId: 'aws:rds-postgres:small',
        dimensionId: 'instance-hour',
        unitPriceUsd: 0.032,
        source: { ...source, evidence: '' },
      }).success,
    ).toBe(false);
  });

  it('allows a genuinely zero price (GCP ingress, pooled DO bandwidth)', () => {
    expect(
      priceRecordSchema.safeParse({
        skuId: 'gcp:cloud-cdn:standard',
        dimensionId: 'ingress-gb',
        unitPriceUsd: 0,
        source,
      }).success,
    ).toBe(true);
  });

  it('accepts a serialised feed record as evidence (a real Azure Retail item is ~750-900 chars) — BLOCKER-3', () => {
    // The evidence cap must be at least as large as a serialised price-feed
    // record; docs §5 defines feed evidence AS the serialised matched record.
    // A 600-char cap silently voided Azure's whole book (BLOCKER-3).
    const feedEvidence = `{ "retailPrice" : 8 , ${'x'.repeat(850)} }`;
    expect(feedEvidence.length).toBeGreaterThan(600);
    expect(feedEvidence.length).toBeLessThanOrEqual(2000);
    expect(
      priceRecordSchema.safeParse({
        skuId: 'azure:postgres-flex:memory-64',
        dimensionId: 'vcore-hour',
        unitPriceUsd: 8,
        source: { ...source, evidence: feedEvidence },
      }).success,
    ).toBe(true);
  });

  it('still rejects an evidence string beyond the (2000) cap — the field stays bounded', () => {
    expect(
      priceRecordSchema.safeParse({
        skuId: 'azure:postgres-flex:memory-64',
        dimensionId: 'vcore-hour',
        unitPriceUsd: 8,
        source: { ...source, evidence: 'x'.repeat(2001) },
      }).success,
    ).toBe(false);
  });

  it('accepts the new invalid_record gap reason', () => {
    const parsed = priceBookSchema.parse({
      provider: 'azure',
      region: 'eastus',
      pipelineVersion: '1.0.0',
      generatedAt: '2026-07-26T10:00:00.000Z',
      records: [],
      gaps: [{ skuId: 'azure:postgres-flex:memory-64', dimensionId: 'vcore-hour', reason: 'invalid_record' }],
    });
    expect(parsed.gaps[0].reason).toBe('invalid_record');
  });

  it('rejects two prices for the same SKU dimension', () => {
    const record = {
      skuId: 'aws:rds-postgres:small',
      dimensionId: 'instance-hour',
      unitPriceUsd: 0.032,
      source,
    };
    const bad = priceBookSchema.safeParse({
      provider: 'aws',
      region: 'us-east-1',
      pipelineVersion: '1.0.0',
      generatedAt: '2026-07-26T10:00:00.000Z',
      records: [record, record],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('Duplicate price');
  });

  it('treats a book with only gaps as valid — a partial book is a success', () => {
    const parsed = priceBookSchema.parse({
      provider: 'vercel',
      region: 'iad1',
      pipelineVersion: '1.0.0',
      generatedAt: '2026-07-26T10:00:00.000Z',
      records: [],
      gaps: [{ skuId: 'vercel:functions:pro', dimensionId: 'gb-seconds', reason: 'not_found_on_page' }],
    });
    expect(parsed.gaps).toHaveLength(1);
  });
});

describe('selection integrity', () => {
  const choice = {
    role: 'db-relational' as const,
    serviceId: 'aws:rds-postgres',
    skuId: 'aws:rds-postgres:small',
  };

  it('accepts a coherent selection and defaults units/enabled', () => {
    const parsed = costSelectionSchema.parse({ provider: 'aws', choices: [choice] });
    expect(parsed.choices[0].units).toBe(1);
    expect(parsed.choices[0].enabled).toBe(true);
  });

  it('rejects two choices for the same role', () => {
    const bad = costSelectionSchema.safeParse({ provider: 'aws', choices: [choice, choice] });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('Duplicate choice for role');
  });

  it('rejects a SKU that does not belong to the chosen service', () => {
    const bad = costSelectionSchema.safeParse({
      provider: 'aws',
      choices: [{ ...choice, skuId: 'aws:aurora-postgres:small' }],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('does not belong to service');
  });

  it("rejects another provider's service inside a provider selection", () => {
    const bad = costSelectionSchema.safeParse({
      provider: 'gcp',
      choices: [choice],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('is not a gcp service');
  });
});

describe('usage profile bounds', () => {
  const valid = {
    monthlyActiveUsers: 10_000,
    monthlyRequests: 5_000_000,
    avgResponseKb: 40,
    computeNodes: 2,
    computeHoursPerNode: HOURS_PER_MONTH,
    computeVcpuPerNode: 1,
    computeMemoryGbPerNode: 2,
    serverlessInvocations: 0,
    avgServerlessDurationMs: 200,
    serverlessMemoryMb: 512,
    dbStorageGb: 20,
    dbBackupGb: 20,
    nosqlReadsPerMonth: 0,
    nosqlWritesPerMonth: 0,
    nosqlStorageGb: 0,
    cacheGb: 1,
    queueMessagesPerMonth: 0,
    objectStorageGb: 50,
    objectWriteOpsPerMonth: 10_000,
    objectReadOpsPerMonth: 500_000,
    cdnEgressGb: 200,
    cdnRequestsPerMonth: 5_000_000,
    originEgressGb: 20,
    searchIndexGb: 0,
    buildMinutesPerMonth: 300,
    seats: 3,
  };

  it('accepts a realistic profile', () => {
    expect(usageProfileSchema.parse(valid).monthlyRequests).toBe(5_000_000);
  });

  it('rejects a negative driver', () => {
    expect(usageProfileSchema.safeParse({ ...valid, dbStorageGb: -1 }).success).toBe(false);
  });

  it('rejects an absurd driver so a fat finger cannot render a $40bn estimate', () => {
    expect(usageProfileSchema.safeParse({ ...valid, monthlyRequests: 1e15 }).success).toBe(false);
  });

  it('caps compute hours at the modelled month', () => {
    expect(
      usageProfileSchema.safeParse({ ...valid, computeHoursPerNode: HOURS_PER_MONTH + 1 }).success,
    ).toBe(false);
  });

  it('requires every driver — a partially filled profile cannot be totalled', () => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing.cacheGb;
    expect(usageProfileSchema.safeParse(missing).success).toBe(false);
  });
});

describe('error envelope', () => {
  it('carries the Feature 2 pricing_unavailable code', () => {
    expect(
      apiErrorSchema.safeParse({
        error: { code: 'pricing_unavailable', message: 'No price book could be produced.' },
      }).success,
    ).toBe(true);
  });
});
