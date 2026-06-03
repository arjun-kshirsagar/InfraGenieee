/**
 * Tests for the pure quantity-derivation step of the cost engine.
 *
 * Runs OFFLINE and FREE — `deriveQuantities` is pure (no I/O, no clock, no env,
 * no randomness). Covers the 730-hour month, the 🔴 `units` exemption rule, and
 * the gb-seconds / vCPU-second derivations on a worked example.
 */

import { describe, expect, it } from 'vitest';

import { deriveQuantities, UNIT_EXEMPT_KEYS } from '@/lib/cost/estimate/quantities';
import {
  HOURS_PER_MONTH,
  QUANTITY_KEYS,
  usageProfileSchema,
  catalogSkuSchema,
  type CatalogSku,
  type UsageProfile,
} from '@/types/cost';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A fully-populated, schema-valid usage profile with round numbers chosen so
 *  the worked-example arithmetic is easy to check by hand. */
function usage(overrides: Partial<UsageProfile> = {}): UsageProfile {
  return usageProfileSchema.parse({
    monthlyActiveUsers: 10_000,
    monthlyRequests: 1_000_000,
    avgResponseKb: 60,
    computeNodes: 2,
    computeHoursPerNode: HOURS_PER_MONTH,
    computeVcpuPerNode: 2,
    computeMemoryGbPerNode: 4,
    serverlessInvocations: 5_000_000,
    avgServerlessDurationMs: 200,
    serverlessMemoryMb: 512,
    dbStorageGb: 20,
    dbBackupGb: 20,
    nosqlReadsPerMonth: 6_000_000,
    nosqlWritesPerMonth: 600_000,
    nosqlStorageGb: 10,
    cacheGb: 1,
    queueMessagesPerMonth: 80_000,
    objectStorageGb: 50,
    objectWriteOpsPerMonth: 100_000,
    objectReadOpsPerMonth: 1_000_000,
    cdnEgressGb: 5_000,
    cdnRequestsPerMonth: 2_400_000,
    originEgressGb: 57,
    searchIndexGb: 6,
    buildMinutesPerMonth: 300,
    seats: 3,
    ...overrides,
  });
}

/** A SKU with no specs — deriveQuantities then falls back to the profile's
 *  per-node vcpu/memory. */
function skuNoSpecs(): CatalogSku {
  return catalogSkuSchema.parse({
    id: 'aws:ec2:small',
    displayName: 'EC2 small',
    tier: 'small',
    dimensions: [
      {
        id: 'instance-hour',
        label: 'Instance hour',
        quantityKey: 'instanceHours',
        unit: 'USD / hour',
        extractionHint: 'on-demand price for the t3.small instance in us-east-1',
      },
    ],
  });
}

/** A SKU that DECLARES specs — those override the profile's per-node figures. */
function skuWithSpecs(): CatalogSku {
  return catalogSkuSchema.parse({
    id: 'aws:ec2:medium',
    displayName: 'EC2 medium',
    tier: 'medium',
    specs: { vcpu: 4, memoryGb: 8 },
    dimensions: [
      {
        id: 'vcpu-hour',
        label: 'vCPU hour',
        quantityKey: 'vcpuHours',
        unit: 'USD / vCPU-hour',
        extractionHint: 'vCPU-hour price for Fargate in us-east-1',
      },
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* The 730-hour month                                                         */
/* -------------------------------------------------------------------------- */

describe('deriveQuantities — HOURS_PER_MONTH', () => {
  it('uses 730 as the always-on month', () => {
    expect(HOURS_PER_MONTH).toBe(730);
    const q = deriveQuantities(usage({ computeHoursPerNode: HOURS_PER_MONTH }), skuNoSpecs(), 1);
    expect(q.instanceHours).toBe(730);
    expect(q.dbInstanceHours).toBe(730);
    expect(q.cacheInstanceHours).toBe(730);
    expect(q.searchInstanceHours).toBe(730);
    expect(q.kafkaBrokerHours).toBe(730);
  });

  it('730 = 365 × 24 / 12', () => {
    expect((365 * 24) / 12).toBe(730);
  });
});

/* -------------------------------------------------------------------------- */
/* 🔴 the units exemption                                                     */
/* -------------------------------------------------------------------------- */

describe('deriveQuantities — 🔴 units multiplies per-unit quantities but NOT months/seats', () => {
  it('months stays 1 and seats stays constant regardless of units', () => {
    const u = usage({ seats: 5 });
    const q1 = deriveQuantities(u, skuNoSpecs(), 1);
    const q3 = deriveQuantities(u, skuNoSpecs(), 3);

    // exempt: unchanged by units
    expect(q1.months).toBe(1);
    expect(q3.months).toBe(1);
    expect(q1.seats).toBe(5);
    expect(q3.seats).toBe(5);
  });

  it('per-unit quantities scale linearly with units', () => {
    const u = usage();
    const q1 = deriveQuantities(u, skuNoSpecs(), 1);
    const q4 = deriveQuantities(u, skuNoSpecs(), 4);

    expect(q4.instanceHours).toBe(q1.instanceHours * 4);
    expect(q4.requests).toBe(q1.requests * 4);
    expect(q4.invocations).toBe(q1.invocations * 4);
    expect(q4.gbSeconds).toBeCloseTo(q1.gbSeconds * 4, 6);
    expect(q4.dbStorageGbMonth).toBe(q1.dbStorageGbMonth * 4);
    expect(q4.objectStorageGbMonth).toBe(q1.objectStorageGbMonth * 4);
    expect(q4.egressGb).toBe(q1.egressGb * 4);
  });

  it('the exempt set is exactly {months, seats}', () => {
    expect([...UNIT_EXEMPT_KEYS].sort()).toEqual(['months', 'seats']);
  });

  it('every non-exempt key is multiplied and every exempt key is not', () => {
    const u = usage();
    const q1 = deriveQuantities(u, skuNoSpecs(), 1);
    const q7 = deriveQuantities(u, skuNoSpecs(), 7);
    for (const key of QUANTITY_KEYS) {
      if (UNIT_EXEMPT_KEYS.includes(key)) {
        expect(q7[key]).toBe(q1[key]);
      } else {
        expect(q7[key]).toBeCloseTo(q1[key] * 7, 6);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* gb-seconds and vCPU-second derivations                                     */
/* -------------------------------------------------------------------------- */

describe('deriveQuantities — worked derivations', () => {
  it('gbSeconds = invocations × (durationMs/1000) × (memoryMb/1024)', () => {
    // 5,000,000 × (200/1000) × (512/1024) = 5e6 × 0.2 × 0.5 = 500,000
    const q = deriveQuantities(
      usage({ serverlessInvocations: 5_000_000, avgServerlessDurationMs: 200, serverlessMemoryMb: 512 }),
      skuNoSpecs(),
      1,
    );
    expect(q.gbSeconds).toBe(500_000);
  });

  it('vcpuHours = vcpuPerNode × hours, vcpuSeconds = that × 3600 (SKU specs win)', () => {
    // SKU declares 4 vCPU; hours = 730 → 2920 vCPU-hours; × 3600 = 10,512,000 s
    const q = deriveQuantities(usage({ computeHoursPerNode: HOURS_PER_MONTH }), skuWithSpecs(), 1);
    expect(q.vcpuHours).toBe(4 * 730);
    expect(q.vcpuSeconds).toBe(4 * 730 * 3600);
    expect(q.gbRamHours).toBe(8 * 730);
    expect(q.gbRamSeconds).toBe(8 * 730 * 3600);
    // activeCpuHours mirrors vcpuHours (Vercel's fluid-compute metric).
    expect(q.activeCpuHours).toBe(4 * 730);
  });

  it('falls back to the profile per-node figures when the SKU declares no specs', () => {
    // profile: 2 vCPU / 4 GB, 730 h
    const q = deriveQuantities(usage(), skuNoSpecs(), 1);
    expect(q.vcpuHours).toBe(2 * 730);
    expect(q.gbRamHours).toBe(4 * 730);
  });

  it('a partial-month (spiky) node reduces the hour-based quantities', () => {
    const hours = Math.round(HOURS_PER_MONTH * 0.55); // 402
    const q = deriveQuantities(usage({ computeHoursPerNode: hours }), skuNoSpecs(), 1);
    expect(q.instanceHours).toBe(hours);
    expect(q.vcpuHours).toBe(2 * hours);
  });
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                     */
/* -------------------------------------------------------------------------- */

describe('deriveQuantities — determinism (purity)', () => {
  it('same inputs → byte-identical output across two calls', () => {
    const u = usage();
    const s = skuWithSpecs();
    expect(deriveQuantities(u, s, 3)).toEqual(deriveQuantities(u, s, 3));
  });

  it('produces a value for every QuantityKey (no key left undefined)', () => {
    const q = deriveQuantities(usage(), skuNoSpecs(), 1);
    for (const key of QUANTITY_KEYS) {
      expect(typeof q[key]).toBe('number');
      expect(Number.isFinite(q[key])).toBe(true);
    }
  });
});
