/**
 * Tests for the pure cost engine — estimateProvider + compare (badges).
 *
 * Runs OFFLINE and FREE. Everything is a hand-built fixture (mini catalog + mini
 * price records) so the arithmetic is asserted to the cent. Because the engine
 * is deterministic and pure, byte-equality assertions ARE appropriate here.
 *
 * Covers the 🔴 invariants the task calls out:
 *   - a missing price → unpriced/incomplete, NOT counted as free
 *   - an incomplete estimate is excluded from `cheapest`
 *   - a provider with unsupportedRoles never wins `cheapest`
 *   - includedQuantity zeroes below the allowance and charges only the excess
 *   - all three badges are null with a single provider
 *   - enabled:false contributes 0
 *   - a worked end-to-end example asserted to the cent
 *   - purity: same inputs → identical output across two calls
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { compare, estimateProvider } from '@/lib/cost/estimate/engine';
import {
  HOURS_PER_MONTH,
  catalogServiceSchema,
  costSelectionSchema,
  priceRecordSchema,
  usageProfileSchema,
  type CatalogService,
  type CostSelection,
  type InfraRole,
  type PriceRecord,
  type PriceSource,
  type UsageProfile,
} from '@/types/cost';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const FETCHED_AT = '2026-07-26T10:00:00.000Z';
const OLDER_FETCHED_AT = '2026-07-20T10:00:00.000Z';
const GENERATED_AT = '2026-07-26T12:00:00.000Z';

function source(fetchedAt = FETCHED_AT, url = 'https://aws.amazon.com/ec2/pricing/'): PriceSource {
  return {
    url,
    fetchedAt,
    evidence: 'On-Demand $0.02 per hour',
    extractorModel: 'test-extractor',
  };
}

/** Worked-example usage profile with round numbers. */
function usage(overrides: Partial<UsageProfile> = {}): UsageProfile {
  return usageProfileSchema.parse({
    monthlyActiveUsers: 10_000,
    monthlyRequests: 1_000_000,
    avgResponseKb: 60,
    computeNodes: 1,
    computeHoursPerNode: HOURS_PER_MONTH,
    computeVcpuPerNode: 2,
    computeMemoryGbPerNode: 4,
    serverlessInvocations: 0,
    avgServerlessDurationMs: 200,
    serverlessMemoryMb: 512,
    dbStorageGb: 20,
    dbBackupGb: 20,
    nosqlReadsPerMonth: 0,
    nosqlWritesPerMonth: 0,
    nosqlStorageGb: 0,
    cacheGb: 0,
    queueMessagesPerMonth: 0,
    objectStorageGb: 0,
    objectWriteOpsPerMonth: 0,
    objectReadOpsPerMonth: 0,
    cdnEgressGb: 5_000,
    cdnRequestsPerMonth: 0,
    originEgressGb: 57,
    searchIndexGb: 0,
    buildMinutesPerMonth: 0,
    seats: 3,
    ...overrides,
  });
}

/* ---- Catalog: AWS (ec2 web, rds db, egress) + Vercel (plan, cdn egress) --- */

const awsEc2: CatalogService = catalogServiceSchema.parse({
  id: 'aws:ec2',
  provider: 'aws',
  role: 'compute-web',
  name: 'Amazon EC2',
  kind: 'iaas',
  description: 'Resizable virtual machines in the cloud.',
  pricingUrl: 'https://aws.amazon.com/ec2/pricing/',
  scalingScore: 4,
  simplicityScore: 2,
  tradeoff: 'You operate the box; more control, more ops burden.',
  skus: [
    {
      id: 'aws:ec2:small',
      displayName: 'EC2 t3.small',
      tier: 'small',
      specs: { vcpu: 2, memoryGb: 2 },
      dimensions: [
        {
          id: 'instance-hour',
          label: 'Instance hour',
          quantityKey: 'instanceHours',
          unit: 'USD / hour',
          extractionHint: 'on-demand hourly price for t3.small in us-east-1',
        },
      ],
    },
  ],
});

const awsRds: CatalogService = catalogServiceSchema.parse({
  id: 'aws:rds-postgres',
  provider: 'aws',
  role: 'db-relational',
  name: 'Amazon RDS for PostgreSQL',
  kind: 'managed',
  description: 'Managed PostgreSQL database service.',
  pricingUrl: 'https://aws.amazon.com/rds/postgresql/pricing/',
  scalingScore: 4,
  simplicityScore: 3,
  tradeoff: 'Managed, but you still size the instance yourself.',
  skus: [
    {
      id: 'aws:rds-postgres:small',
      displayName: 'db.t3.small Single-AZ',
      tier: 'small',
      dimensions: [
        {
          id: 'instance-hour',
          label: 'DB instance hour',
          quantityKey: 'dbInstanceHours',
          unit: 'USD / hour',
          extractionHint: 'on-demand hourly price for db.t3.small Single-AZ Postgres in us-east-1',
        },
        {
          id: 'storage-gb-month',
          label: 'Storage',
          quantityKey: 'dbStorageGbMonth',
          unit: 'USD / GB-month',
          extractionHint: 'gp3 storage price per GB-month for RDS in us-east-1',
        },
      ],
    },
  ],
});

const awsEgress: CatalogService = catalogServiceSchema.parse({
  id: 'aws:egress',
  provider: 'aws',
  role: 'egress',
  name: 'AWS Data Transfer',
  kind: 'managed',
  description: 'Data transfer out to the internet.',
  pricingUrl: 'https://aws.amazon.com/ec2/pricing/on-demand/',
  scalingScore: 3,
  simplicityScore: 3,
  tradeoff: 'Egress is metered and easy to under-budget for.',
  skus: [
    {
      id: 'aws:egress:standard',
      displayName: 'Data transfer out',
      tier: 'starter',
      dimensions: [
        {
          id: 'egress-gb',
          label: 'Egress',
          quantityKey: 'egressGb',
          unit: 'USD / GB',
          extractionHint: 'first-tier per-GB data transfer out price for us-east-1',
        },
      ],
    },
  ],
});

const vercelPlan: CatalogService = catalogServiceSchema.parse({
  id: 'vercel:plan-pro',
  provider: 'vercel',
  role: 'compute-web',
  name: 'Vercel Pro',
  kind: 'platform',
  description: 'Vercel Pro plan: flat monthly fee plus paid seats.',
  pricingUrl: 'https://vercel.com/pricing',
  scalingScore: 5,
  simplicityScore: 5,
  tradeoff: 'Simplest to ship; least control over the runtime.',
  skus: [
    {
      id: 'vercel:plan-pro:pro',
      displayName: 'Pro team',
      tier: 'starter',
      dimensions: [
        {
          id: 'plan-fee',
          label: 'Plan fee',
          quantityKey: 'months',
          unit: 'USD / month',
          extractionHint: 'Vercel Pro flat monthly team fee',
        },
        {
          id: 'seat',
          label: 'Seat',
          quantityKey: 'seats',
          unit: 'USD / seat / month',
          extractionHint: 'Vercel Pro additional seat monthly price',
        },
      ],
    },
  ],
});

const vercelEgress: CatalogService = catalogServiceSchema.parse({
  id: 'vercel:edge',
  provider: 'vercel',
  role: 'egress',
  name: 'Vercel Edge Network',
  kind: 'platform',
  description: 'Fast data transfer via the Vercel Edge Network.',
  pricingUrl: 'https://vercel.com/docs/pricing/networking',
  scalingScore: 5,
  simplicityScore: 5,
  tradeoff: 'Included allowance then metered; overage adds up at scale.',
  skus: [
    {
      id: 'vercel:edge:transfer',
      displayName: 'Fast data transfer',
      tier: 'starter',
      dimensions: [
        {
          id: 'egress-gb',
          label: 'Fast data transfer',
          quantityKey: 'cdnEgressGb',
          unit: 'USD / GB',
          extractionHint: 'Vercel fast data transfer per-GB overage price, North America',
        },
      ],
    },
  ],
});

const ALL_SERVICES: CatalogService[] = [
  awsEc2,
  awsRds,
  awsEgress,
  vercelPlan,
  vercelEgress,
];

/* ---- Price records --------------------------------------------------------*/

function rec(
  skuId: string,
  dimensionId: string,
  unitPriceUsd: number,
  includedQuantity = 0,
  src = source(),
): PriceRecord {
  return priceRecordSchema.parse({
    skuId,
    dimensionId,
    unitPriceUsd,
    includedQuantity,
    source: src,
  });
}

const AWS_PRICES: PriceRecord[] = [
  rec('aws:ec2:small', 'instance-hour', 0.02),
  rec('aws:rds-postgres:small', 'instance-hour', 0.1),
  rec('aws:rds-postgres:small', 'storage-gb-month', 0.115),
  // 100 GB free egress allowance; 57 GB used → nothing billable.
  rec('aws:egress:standard', 'egress-gb', 0.09, 100),
];

const VERCEL_PRICES: PriceRecord[] = [
  rec('vercel:plan-pro:pro', 'plan-fee', 20, 0, source(OLDER_FETCHED_AT, 'https://vercel.com/pricing')),
  // 1 seat included in the plan fee → only the excess is charged.
  rec('vercel:plan-pro:pro', 'seat', 20, 1, source(FETCHED_AT, 'https://vercel.com/pricing')),
  // 1000 GB included fast transfer, 5000 used → 4000 billable.
  rec('vercel:edge:transfer', 'egress-gb', 0.15, 1000),
];

/* ---- Selections -----------------------------------------------------------*/

function awsSelection(): CostSelection {
  return costSelectionSchema.parse({
    provider: 'aws',
    choices: [
      { role: 'compute-web', serviceId: 'aws:ec2', skuId: 'aws:ec2:small', units: 1 },
      {
        role: 'db-relational',
        serviceId: 'aws:rds-postgres',
        skuId: 'aws:rds-postgres:small',
        units: 1,
      },
      { role: 'egress', serviceId: 'aws:egress', skuId: 'aws:egress:standard', units: 1 },
    ],
  });
}

function vercelSelection(): CostSelection {
  return costSelectionSchema.parse({
    provider: 'vercel',
    choices: [
      { role: 'compute-web', serviceId: 'vercel:plan-pro', skuId: 'vercel:plan-pro:pro', units: 1 },
      { role: 'egress', serviceId: 'vercel:edge', skuId: 'vercel:edge:transfer', units: 1 },
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* Worked end-to-end example (asserted to the cent)                           */
/* -------------------------------------------------------------------------- */

describe('estimateProvider — worked AWS example to the cent', () => {
  const est = estimateProvider({
    usage: usage(),
    selection: awsSelection(),
    services: ALL_SERVICES,
    priceRecords: AWS_PRICES,
    region: 'us-east-1',
    requiredRoles: ['compute-web', 'db-relational', 'egress'],
  });

  it('per-dimension breakdown is exact', () => {
    const ec2 = est.items.find((i) => i.role === 'compute-web')!;
    expect(ec2.monthlyUsd).toBeCloseTo(14.6, 10); // 730h × $0.02

    const rds = est.items.find((i) => i.role === 'db-relational')!;
    const node = rds.dimensions.find((d) => d.dimensionId === 'instance-hour')!;
    const stor = rds.dimensions.find((d) => d.dimensionId === 'storage-gb-month')!;
    expect(node.monthlyUsd).toBeCloseTo(73.0, 10); // 730h × $0.10
    expect(stor.billableQuantity).toBe(20);
    expect(stor.monthlyUsd).toBeCloseTo(2.3, 10); // 20GB × $0.115

    const egress = est.items.find((i) => i.role === 'egress')!;
    const eg = egress.dimensions[0];
    // 57 GB used, 100 GB free → 0 billable, $0 — but NOT unpriced.
    expect(eg.billableQuantity).toBe(0);
    expect(eg.monthlyUsd).toBe(0);
    expect(eg.unpriced).toBe(false);
  });

  it('provider total is $89.90', () => {
    expect(est.monthlyUsd).toBeCloseTo(89.9, 2);
  });

  it('is complete, supports every required role, and records the oldest price', () => {
    expect(est.incomplete).toBe(false);
    expect(est.unsupportedRoles).toEqual([]);
    expect(est.oldestPriceAt).toBe(FETCHED_AT);
  });
});

/* -------------------------------------------------------------------------- */
/* 🔴 includedQuantity: below the allowance vs above it                       */
/* -------------------------------------------------------------------------- */

describe('estimateProvider — includedQuantity', () => {
  it('zeroes a cost entirely below the free allowance', () => {
    const est = estimateProvider({
      usage: usage({ originEgressGb: 57 }), // < 100 GB free
      selection: costSelectionSchema.parse({
        provider: 'aws',
        choices: [{ role: 'egress', serviceId: 'aws:egress', skuId: 'aws:egress:standard', units: 1 }],
      }),
      services: ALL_SERVICES,
      priceRecords: AWS_PRICES,
      region: 'us-east-1',
    });
    expect(est.monthlyUsd).toBe(0);
    expect(est.items[0].dimensions[0].unpriced).toBe(false);
    expect(est.incomplete).toBe(false);
  });

  it('charges only the excess above the allowance', () => {
    const est = estimateProvider({
      usage: usage({ originEgressGb: 300 }), // 300 − 100 = 200 billable
      selection: costSelectionSchema.parse({
        provider: 'aws',
        choices: [{ role: 'egress', serviceId: 'aws:egress', skuId: 'aws:egress:standard', units: 1 }],
      }),
      services: ALL_SERVICES,
      priceRecords: AWS_PRICES,
      region: 'us-east-1',
    });
    // 200 GB × $0.09 = $18.00
    expect(est.items[0].dimensions[0].billableQuantity).toBe(200);
    expect(est.monthlyUsd).toBeCloseTo(18, 10);
  });
});

/* -------------------------------------------------------------------------- */
/* 🔴 units exemption reaches the total                                       */
/* -------------------------------------------------------------------------- */

describe('estimateProvider — units multiplies metered lines but not plan/seats', () => {
  it('two web nodes double the instance-hours line', () => {
    const sel = costSelectionSchema.parse({
      provider: 'aws',
      choices: [{ role: 'compute-web', serviceId: 'aws:ec2', skuId: 'aws:ec2:small', units: 2 }],
    });
    const est = estimateProvider({
      usage: usage(),
      selection: sel,
      services: ALL_SERVICES,
      priceRecords: AWS_PRICES,
      region: 'us-east-1',
    });
    expect(est.monthlyUsd).toBeCloseTo(29.2, 10); // 2 × 730h × $0.02
  });

  it('units does NOT multiply the Vercel plan fee or seats', () => {
    const sel = costSelectionSchema.parse({
      provider: 'vercel',
      choices: [
        { role: 'compute-web', serviceId: 'vercel:plan-pro', skuId: 'vercel:plan-pro:pro', units: 5 },
      ],
    });
    const est = estimateProvider({
      usage: usage({ seats: 3 }),
      selection: sel,
      services: ALL_SERVICES,
      priceRecords: VERCEL_PRICES,
      region: 'iad1',
    });
    // plan: 1 × $20 (NOT ×5). seats: (3−1) × $20 = $40 (NOT ×5). Total $60.
    expect(est.monthlyUsd).toBeCloseTo(60, 10);
  });
});

/* -------------------------------------------------------------------------- */
/* 🔴 missing price → unpriced, incomplete, NOT free                         */
/* -------------------------------------------------------------------------- */

describe('estimateProvider — 🔴 a missing price is unpriced, not free', () => {
  const est = estimateProvider({
    usage: usage(),
    selection: awsSelection(),
    services: ALL_SERVICES,
    // RDS storage price is MISSING (fetch failed). Everything else priced.
    priceRecords: AWS_PRICES.filter(
      (r) => !(r.skuId === 'aws:rds-postgres:small' && r.dimensionId === 'storage-gb-month'),
    ),
    region: 'us-east-1',
    requiredRoles: ['compute-web', 'db-relational', 'egress'],
  });

  it('marks the dimension unpriced with $0 and null source', () => {
    const rds = est.items.find((i) => i.role === 'db-relational')!;
    const stor = rds.dimensions.find((d) => d.dimensionId === 'storage-gb-month')!;
    expect(stor.unpriced).toBe(true);
    expect(stor.monthlyUsd).toBe(0);
    expect(stor.source).toBeNull();
  });

  it('marks the line AND the estimate incomplete', () => {
    const rds = est.items.find((i) => i.role === 'db-relational')!;
    expect(rds.incomplete).toBe(true);
    expect(est.incomplete).toBe(true);
  });

  it('does NOT count the unpriced dimension as free (total is a floor below the complete estimate)', () => {
    const complete = estimateProvider({
      usage: usage(),
      selection: awsSelection(),
      services: ALL_SERVICES,
      priceRecords: AWS_PRICES,
      region: 'us-east-1',
      requiredRoles: ['compute-web', 'db-relational', 'egress'],
    });
    // The incomplete total omits the $2.30 storage line — it is a FLOOR, and the
    // estimate is flagged incomplete so the UI never reads the gap as "free".
    expect(est.monthlyUsd).toBeLessThan(complete.monthlyUsd);
    expect(est.incomplete).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 🔴 enabled:false contributes 0                                            */
/* -------------------------------------------------------------------------- */

describe('estimateProvider — enabled:false contributes 0', () => {
  it('a disabled choice adds nothing to the total', () => {
    const sel = costSelectionSchema.parse({
      provider: 'aws',
      choices: [
        { role: 'compute-web', serviceId: 'aws:ec2', skuId: 'aws:ec2:small', units: 1, enabled: true },
        {
          role: 'db-relational',
          serviceId: 'aws:rds-postgres',
          skuId: 'aws:rds-postgres:small',
          units: 1,
          enabled: false, // turned off
        },
      ],
    });
    const est = estimateProvider({
      usage: usage(),
      selection: sel,
      services: ALL_SERVICES,
      priceRecords: AWS_PRICES,
      region: 'us-east-1',
    });
    // only the EC2 line: 730h × $0.02 = $14.60
    expect(est.monthlyUsd).toBeCloseTo(14.6, 10);
    expect(est.items).toHaveLength(1);
    expect(est.items[0].role).toBe('compute-web');
  });

  it('a disabled choice does NOT satisfy a required role (estimate becomes incomplete)', () => {
    const sel = costSelectionSchema.parse({
      provider: 'aws',
      choices: [
        {
          role: 'db-relational',
          serviceId: 'aws:rds-postgres',
          skuId: 'aws:rds-postgres:small',
          units: 1,
          enabled: false,
        },
      ],
    });
    const est = estimateProvider({
      usage: usage(),
      selection: sel,
      services: ALL_SERVICES,
      priceRecords: AWS_PRICES,
      region: 'us-east-1',
      requiredRoles: ['db-relational'],
    });
    expect(est.incomplete).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 🔴 unsupportedRoles                                                        */
/* -------------------------------------------------------------------------- */

describe('estimateProvider — unsupportedRoles', () => {
  it('flags a required role the provider offers no service for', () => {
    const est = estimateProvider({
      usage: usage(),
      selection: vercelSelection(),
      services: ALL_SERVICES,
      priceRecords: VERCEL_PRICES,
      region: 'iad1',
      // Vercel has no db-relational or queue-kafka service in this catalog.
      requiredRoles: ['compute-web', 'db-relational', 'queue-kafka', 'egress'],
    });
    expect(est.unsupportedRoles).toEqual(['db-relational', 'queue-kafka']);
  });
});

/* -------------------------------------------------------------------------- */
/* compare — badges                                                           */
/* -------------------------------------------------------------------------- */

function awsEstimate(
  requiredRoles: InfraRole[] = ['compute-web', 'db-relational', 'egress'],
) {
  return estimateProvider({
    usage: usage(),
    selection: awsSelection(),
    services: ALL_SERVICES,
    priceRecords: AWS_PRICES,
    region: 'us-east-1',
    requiredRoles,
  });
}

function vercelEstimate(requiredRoles: InfraRole[] = ['compute-web', 'egress']) {
  return estimateProvider({
    usage: usage(),
    selection: vercelSelection(),
    services: ALL_SERVICES,
    priceRecords: VERCEL_PRICES,
    region: 'iad1',
    requiredRoles,
  });
}

describe('compare — badges', () => {
  it('🔴 all three badges are null with a single provider', () => {
    const cmp = compare({
      estimates: [awsEstimate()],
      services: ALL_SERVICES,
      generatedAt: GENERATED_AT,
    });
    expect(cmp.cheapest).toBeNull();
    expect(cmp.bestScaling).toBeNull();
    expect(cmp.simplest).toBeNull();
    expect(cmp.generatedAt).toBe(GENERATED_AT);
  });

  it('cheapest is the lowest complete total (AWS $89.90 < Vercel $660)', () => {
    const cmp = compare({
      estimates: [awsEstimate(), vercelEstimate()],
      services: ALL_SERVICES,
      generatedAt: GENERATED_AT,
    });
    expect(cmp.cheapest).toBe('aws');
  });

  it('🔴 an incomplete estimate is excluded from cheapest', () => {
    // AWS with a missing REQUIRED price → incomplete → not eligible, even though
    // its (floor) total is lower than Vercel's.
    const incompleteAws = estimateProvider({
      usage: usage(),
      selection: awsSelection(),
      services: ALL_SERVICES,
      priceRecords: AWS_PRICES.filter((r) => r.dimensionId !== 'instance-hour'),
      region: 'us-east-1',
      requiredRoles: ['compute-web', 'db-relational', 'egress'],
    });
    expect(incompleteAws.incomplete).toBe(true);
    const cmp = compare({
      estimates: [incompleteAws, vercelEstimate()],
      services: ALL_SERVICES,
      generatedAt: GENERATED_AT,
    });
    // Vercel is the only COMPLETE estimate, so it wins by elimination.
    expect(cmp.cheapest).toBe('vercel');
  });

  it('🔴 a provider with unsupportedRoles never wins cheapest', () => {
    // Vercel is cheaper here (make AWS pricey via huge egress), but Vercel is
    // missing a required db-relational role → excluded from cheapest.
    const pricyAws = estimateProvider({
      usage: usage({ originEgressGb: 100_000 }),
      selection: awsSelection(),
      services: ALL_SERVICES,
      priceRecords: AWS_PRICES,
      region: 'us-east-1',
      requiredRoles: ['compute-web', 'db-relational', 'egress'],
    });
    const vercelMissingDb = estimateProvider({
      usage: usage(),
      selection: vercelSelection(),
      services: ALL_SERVICES,
      priceRecords: VERCEL_PRICES,
      region: 'iad1',
      requiredRoles: ['compute-web', 'db-relational', 'egress'],
    });
    expect(vercelMissingDb.unsupportedRoles).toEqual(['db-relational']);
    expect(vercelMissingDb.monthlyUsd).toBeLessThan(pricyAws.monthlyUsd);

    const cmp = compare({
      estimates: [pricyAws, vercelMissingDb],
      services: ALL_SERVICES,
      generatedAt: GENERATED_AT,
    });
    // Vercel is cheaper but can't run the app; AWS is the only honest winner.
    expect(cmp.cheapest).toBe('aws');
  });

  it('bestScaling / simplest pick the highest summed editorial score', () => {
    const cmp = compare({
      estimates: [awsEstimate(), vercelEstimate()],
      services: ALL_SERVICES,
      generatedAt: GENERATED_AT,
    });
    // scalingScore sums: AWS ec2(4)+rds(4)+egress(3)=11 > Vercel plan(5)+edge(5)=10.
    expect(cmp.bestScaling).toBe('aws');
    // simplicityScore sums: AWS ec2(2)+rds(3)+egress(3)=8 < Vercel plan(5)+edge(5)=10.
    expect(cmp.simplest).toBe('vercel');
  });

  it('cheapest is null when EVERY estimate is incomplete', () => {
    const incompleteAws = estimateProvider({
      usage: usage(),
      selection: awsSelection(),
      services: ALL_SERVICES,
      priceRecords: AWS_PRICES.filter((r) => r.dimensionId !== 'instance-hour'),
      region: 'us-east-1',
      requiredRoles: ['compute-web', 'db-relational', 'egress'],
    });
    const incompleteVercel = estimateProvider({
      usage: usage(),
      selection: vercelSelection(),
      services: ALL_SERVICES,
      priceRecords: VERCEL_PRICES.filter((r) => r.dimensionId !== 'plan-fee'),
      region: 'iad1',
      requiredRoles: ['compute-web', 'egress'],
    });
    const cmp = compare({
      estimates: [incompleteAws, incompleteVercel],
      services: ALL_SERVICES,
      generatedAt: GENERATED_AT,
    });
    expect(cmp.cheapest).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                     */
/* -------------------------------------------------------------------------- */

describe('cost engine — purity / determinism', () => {
  it('estimateProvider returns identical output across two calls', () => {
    const input = {
      usage: usage(),
      selection: awsSelection(),
      services: ALL_SERVICES,
      priceRecords: AWS_PRICES,
      region: 'us-east-1',
      requiredRoles: ['compute-web', 'db-relational', 'egress'] as never,
    };
    expect(estimateProvider(input)).toEqual(estimateProvider(input));
  });

  it('compare returns identical output across two calls', () => {
    const estimates = [awsEstimate(), vercelEstimate()];
    const a = compare({ estimates, services: ALL_SERVICES, generatedAt: GENERATED_AT });
    const b = compare({ estimates, services: ALL_SERVICES, generatedAt: GENERATED_AT });
    expect(a).toEqual(b);
  });

  it('generatedAt is taken from the argument, never the clock', () => {
    const cmp = compare({
      estimates: [awsEstimate(), vercelEstimate()],
      services: ALL_SERVICES,
      generatedAt: '2000-01-01T00:00:00.000Z',
    });
    expect(cmp.generatedAt).toBe('2000-01-01T00:00:00.000Z');
  });
});

/* -------------------------------------------------------------------------- */
/* Purity by static analysis — no clock / random / env / I/O in the source    */
/* -------------------------------------------------------------------------- */

describe('cost engine — source contains no impure primitives', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sourceFiles = ['quantities.ts', 'engine.ts', 'derive.ts', 'index.ts'];

  // Patterns that would break browser-safe purity. `Date.now`, `Math.random`,
  // `process.env`, `new Date(` (clock read) and any Node fs/require import.
  const FORBIDDEN: Array<[RegExp, string]> = [
    [/Date\.now\s*\(/, 'Date.now()'],
    [/Math\.random\s*\(/, 'Math.random()'],
    [/process\.env/, 'process.env'],
    [/new\s+Date\s*\(\s*\)/, 'new Date() (clock read)'],
    [/\brequire\s*\(/, 'require()'],
    [/from\s+['"](fs|node:fs|path|node:path)['"]/, 'fs/path import'],
  ];

  for (const file of sourceFiles) {
    it(`${file} is free of clock/random/env/I-O`, () => {
      const raw = readFileSync(path.join(dir, file), 'utf8');
      // Strip comments so a doc-comment that MENTIONS these primitives (e.g.
      // "no Math.random() here") doesn't trip the scan — we care about code.
      const src = raw
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/\/\/[^\n]*/g, ''); // line comments
      for (const [pattern, label] of FORBIDDEN) {
        expect(pattern.test(src), `${file} must not use ${label}`).toBe(false);
      }
    });
  }
});
