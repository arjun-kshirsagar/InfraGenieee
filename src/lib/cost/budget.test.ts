import { describe, expect, it } from 'vitest';

import type { ProviderEstimate } from '@/types/cost';
import { assessBudget } from './budget';

function estimate(monthlyUsd: number, incomplete = false): ProviderEstimate {
  return {
    provider: 'digitalocean',
    region: 'nyc3',
    items: [],
    monthlyUsd,
    unsupportedRoles: [],
    incomplete,
    oldestPriceAt: null,
    warnings: [],
  };
}

describe('assessBudget', () => {
  it('flags a hobby recommendation at or above the exclusive $25 cap', () => {
    expect(assessBudget('hobby', estimate(26.45, true))).toEqual({
      kind: 'over',
      maxUsd: 25,
      overByUsd: 1.45,
    });
    expect(assessBudget('hobby', estimate(25))).toMatchObject({ kind: 'over' });
  });

  it('does not claim a floor below the cap is within budget', () => {
    expect(assessBudget('hobby', estimate(12, true))).toEqual({
      kind: 'unknown',
      maxUsd: 25,
    });
  });

  it('accepts a complete estimate below the cap', () => {
    expect(assessBudget('startup', estimate(249.99))).toEqual({
      kind: 'within',
      maxUsd: 250,
    });
  });

  it('treats enterprise as having no upper cap', () => {
    expect(assessBudget('enterprise', estimate(50_000))).toEqual({ kind: 'unbounded' });
  });
});
