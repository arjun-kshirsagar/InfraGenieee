import { describe, it, expect } from 'vitest';

import { usageProfileSchema } from '@/types/cost';
import {
  usageFieldMeta,
  HEADLINE_USAGE_META,
  ADVANCED_USAGE_META,
  clampUsageValue,
  type UsageKey,
} from './usage';

describe('usage field metadata', () => {
  it('reads min/max straight off the contract schema (no drift)', () => {
    // These bounds are asserted against the contract in src/types/cost.ts.
    expect(usageFieldMeta('monthlyActiveUsers')).toMatchObject({ min: 0, max: 50_000_000 });
    expect(usageFieldMeta('monthlyRequests')).toMatchObject({ min: 0, max: 50_000_000_000 });
    expect(usageFieldMeta('avgResponseKb')).toMatchObject({ min: 0.1, max: 10_000 });
    expect(usageFieldMeta('computeNodes')).toMatchObject({ min: 0, max: 200, integer: true });
    expect(usageFieldMeta('seats')).toMatchObject({ min: 1, max: 500, integer: true });
    expect(usageFieldMeta('serverlessMemoryMb')).toMatchObject({ min: 64, max: 10_240 });
  });

  it('covers every numeric usage field exactly once across headline + advanced', () => {
    const covered = new Set<UsageKey>([
      ...HEADLINE_USAGE_META.map((m) => m.key),
      ...ADVANCED_USAGE_META.map((m) => m.key),
    ]);
    const schemaKeys = Object.keys(usageProfileSchema.shape) as UsageKey[];
    for (const key of schemaKeys) {
      expect(covered.has(key)).toBe(true);
    }
    expect(covered.size).toBe(schemaKeys.length);
  });

  it('headline and advanced sets are disjoint', () => {
    const headline = new Set(HEADLINE_USAGE_META.map((m) => m.key));
    for (const m of ADVANCED_USAGE_META) expect(headline.has(m.key)).toBe(false);
  });
});

describe('clampUsageValue — the fat-finger guard', () => {
  it('clamps a huge value down to the schema max (no $40bn estimate)', () => {
    expect(clampUsageValue('monthlyActiveUsers', 1e12)).toBe(50_000_000);
    expect(clampUsageValue('monthlyRequests', Number.MAX_SAFE_INTEGER)).toBe(50_000_000_000);
  });

  it('clamps a below-min value up to the schema min', () => {
    expect(clampUsageValue('avgResponseKb', 0)).toBe(0.1);
    expect(clampUsageValue('seats', 0)).toBe(1);
  });

  it('rounds integer fields', () => {
    expect(clampUsageValue('computeNodes', 3.7)).toBe(4);
    expect(clampUsageValue('seats', 2.4)).toBe(2);
  });

  it('passes an in-range value through unchanged', () => {
    expect(clampUsageValue('dbStorageGb', 20)).toBe(20);
  });

  it('returns the min for a non-finite input rather than NaN', () => {
    // Non-finite input (NaN / Infinity) falls back to the safe minimum rather
    // than producing NaN or a runaway max — the guard errs toward $0, not $40bn.
    expect(clampUsageValue('monthlyRequests', NaN)).toBe(0);
    expect(clampUsageValue('monthlyRequests', Infinity)).toBe(0);
  });

  it('every clamped value satisfies the contract schema', () => {
    // Build a profile from clamped extremes and parse it — the ultimate proof
    // that the slider bounds keep us inside the contract.
    const keys = Object.keys(usageProfileSchema.shape) as UsageKey[];
    const profile: Record<string, number> = {};
    for (const k of keys) profile[k] = clampUsageValue(k, 1e15);
    expect(() => usageProfileSchema.parse(profile)).not.toThrow();
  });
});
