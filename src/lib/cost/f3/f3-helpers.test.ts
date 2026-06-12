/**
 * Tests for Feature 3 pure helpers — comparison row shaping, chart data
 * mapping, and markdown export. OFFLINE + FREE: every input is a hand-built
 * `ProviderEstimate` / `CostComparison` fixture, so the shaping and the honesty
 * rules are asserted deterministically.
 *
 * Covers the 🔴 invariants the task calls out:
 *   - badges come FROM the comparison, are absent when null, and shape a row's
 *     `badges[]` — never recomputed;
 *   - an unsupported provider is `runnable: false` and sorts to the bottom;
 *   - an incomplete estimate is flagged (floor) and never sorts as the cheap top;
 *   - a bar carries a `state` so unpriced/unsupported are distinct from a $0 bar;
 *   - the markdown export cites every priced dimension (URL + fetchedAt) and
 *     labels an unpriced line as "unpriced", never $0.00.
 */

import { describe, expect, it } from 'vitest';

import type {
  CostComparison,
  CostDimensionResult,
  CostLineItem,
  ProviderEstimate,
  PriceSource,
} from '@/types/cost';

import {
  buildComparisonRows,
  resolveBadges,
  toComparisonRow,
  badgeMeta,
} from './comparison';
import {
  toProviderBars,
  toComposition,
  barsNeedCaveatLegend,
  paletteColor,
  CHART_PALETTE,
} from './chart-data';
import { buildComparisonMarkdown, comparisonFileStem, type ProviderTradeoff } from './export-md';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const FETCHED_AT = '2026-07-26T10:00:00.000Z';
const GENERATED_AT = '2026-07-26T12:00:00.000Z';
const NOW = Date.parse('2026-07-26T13:00:00.000Z');

function src(url = 'https://aws.amazon.com/ec2/pricing/'): PriceSource {
  return {
    url,
    fetchedAt: FETCHED_AT,
    evidence: 'On-Demand $0.02 per hour',
    extractorModel: 'test-extractor',
  };
}

function pricedDim(monthlyUsd: number): CostDimensionResult {
  return {
    dimensionId: 'instance-hour',
    label: 'Instance hours',
    unit: 'USD / hour',
    quantityKey: 'instanceHours',
    quantity: 730,
    includedQuantity: 0,
    billableQuantity: 730,
    unitPriceUsd: monthlyUsd / 730,
    monthlyUsd,
    source: src(),
    unpriced: false,
  };
}

function unpricedDim(): CostDimensionResult {
  return {
    dimensionId: 'storage-gb-month',
    label: 'Storage',
    unit: 'USD / GB-month',
    quantityKey: 'dbStorageGbMonth',
    quantity: 20,
    includedQuantity: 0,
    billableQuantity: 20,
    unitPriceUsd: 0,
    monthlyUsd: 0,
    source: null,
    unpriced: true,
  };
}

function line(
  overrides: Partial<CostLineItem> & { role: CostLineItem['role'] },
): CostLineItem {
  return {
    serviceId: 'aws:ec2',
    serviceName: 'EC2',
    skuId: 'aws:ec2:small',
    skuName: 'Small',
    units: 1,
    dimensions: [pricedDim(50)],
    monthlyUsd: 50,
    incomplete: false,
    ...overrides,
  };
}

function estimate(overrides: Partial<ProviderEstimate> & { provider: ProviderEstimate['provider'] }): ProviderEstimate {
  return {
    region: 'us-east-1',
    items: [line({ role: 'compute-web' })],
    monthlyUsd: 50,
    unsupportedRoles: [],
    incomplete: false,
    oldestPriceAt: FETCHED_AT,
    warnings: [],
    ...overrides,
  };
}

function comparison(overrides: Partial<CostComparison> = {}): CostComparison {
  return {
    generatedAt: GENERATED_AT,
    estimates: [],
    cheapest: null,
    bestScaling: null,
    simplest: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* comparison.ts — row shaping                                                */
/* -------------------------------------------------------------------------- */

describe('toComparisonRow', () => {
  it('attaches only the badges the comparison awarded to this provider', () => {
    const e = estimate({ provider: 'aws' });
    const cmp = comparison({ estimates: [e], cheapest: 'aws', bestScaling: 'gcp', simplest: 'aws' });
    const row = toComparisonRow(e, cmp);
    expect(row.badges).toEqual(['cheapest', 'simplest']);
  });

  it('marks a provider with unsupportedRoles as not runnable', () => {
    const e = estimate({ provider: 'vercel', unsupportedRoles: ['db-relational', 'queue-kafka'] });
    const row = toComparisonRow(e, comparison({ estimates: [e] }));
    expect(row.runnable).toBe(false);
    expect(row.unsupportedRoleLabels).toEqual(['Relational database', 'Kafka / event streaming']);
  });

  it('carries the incomplete/floor flag through', () => {
    const e = estimate({ provider: 'aws', incomplete: true });
    expect(toComparisonRow(e, comparison({ estimates: [e] })).incomplete).toBe(true);
  });

  it('summarises each line with its role label', () => {
    const e = estimate({
      provider: 'aws',
      items: [line({ role: 'db-relational', serviceName: 'RDS', monthlyUsd: 30, units: 2 })],
    });
    const row = toComparisonRow(e, comparison({ estimates: [e] }));
    expect(row.lines[0]).toMatchObject({
      role: 'db-relational',
      roleLabel: 'Relational database',
      serviceName: 'RDS',
      units: 2,
      monthlyUsd: 30,
    });
  });
});

describe('buildComparisonRows', () => {
  it('sorts runnable providers before unrunnable ones', () => {
    const aws = estimate({ provider: 'aws', monthlyUsd: 100 });
    const vercel = estimate({ provider: 'vercel', monthlyUsd: 5, unsupportedRoles: ['db-relational'] });
    const rows = buildComparisonRows([vercel, aws], comparison({ estimates: [vercel, aws] }));
    // Vercel is cheaper by number but cannot run the app → must NOT be first.
    expect(rows.map((r) => r.provider)).toEqual(['aws', 'vercel']);
  });

  it('sorts complete estimates before incomplete floors within runnable', () => {
    const cheapFloor = estimate({ provider: 'gcp', monthlyUsd: 10, incomplete: true });
    const dearComplete = estimate({ provider: 'aws', monthlyUsd: 40 });
    const rows = buildComparisonRows(
      [cheapFloor, dearComplete],
      comparison({ estimates: [cheapFloor, dearComplete] }),
    );
    // The cheap number is a floor → the complete (more expensive) provider is first.
    expect(rows.map((r) => r.provider)).toEqual(['aws', 'gcp']);
  });

  it('sorts by cost ascending among complete runnable providers', () => {
    const a = estimate({ provider: 'aws', monthlyUsd: 90 });
    const b = estimate({ provider: 'gcp', monthlyUsd: 30 });
    const c = estimate({ provider: 'digitalocean', monthlyUsd: 60 });
    const rows = buildComparisonRows([a, b, c], comparison({ estimates: [a, b, c] }));
    expect(rows.map((r) => r.provider)).toEqual(['gcp', 'digitalocean', 'aws']);
  });
});

/* -------------------------------------------------------------------------- */
/* comparison.ts — badges                                                     */
/* -------------------------------------------------------------------------- */

describe('resolveBadges', () => {
  it('returns nothing when every award is null (no honest winner)', () => {
    expect(resolveBadges(comparison())).toEqual([]);
  });

  it('emits one entry per non-null award, in stable order', () => {
    const badges = resolveBadges(
      comparison({ cheapest: 'aws', bestScaling: 'gcp', simplest: 'vercel' }),
    );
    expect(badges.map((b) => b.kind)).toEqual(['cheapest', 'bestScaling', 'simplest']);
    expect(badges.map((b) => b.provider)).toEqual(['aws', 'gcp', 'vercel']);
  });

  it('omits a badge whose award is null but keeps the others', () => {
    const badges = resolveBadges(comparison({ cheapest: null, bestScaling: 'gcp', simplest: null }));
    expect(badges.map((b) => b.kind)).toEqual(['bestScaling']);
  });

  it('bestScaling and simplest explanations disclaim being a price claim', () => {
    const badges = resolveBadges(comparison({ bestScaling: 'gcp', simplest: 'aws' }));
    for (const b of badges) {
      expect(b.explanation.toLowerCase()).toContain('not a price');
    }
  });

  it('cheapest explanation says gaps/floors are excluded', () => {
    const [cheap] = resolveBadges(comparison({ cheapest: 'aws' }));
    expect(cheap.explanation.toLowerCase()).toContain('excluded');
  });
});

describe('badgeMeta', () => {
  it('exposes a label + explanation without a winner', () => {
    expect(badgeMeta('cheapest').label).toBe('Cheapest');
    expect(badgeMeta('bestScaling').explanation.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* chart-data.ts                                                              */
/* -------------------------------------------------------------------------- */

describe('toProviderBars', () => {
  it('flags a runnable complete provider as priced', () => {
    const bars = toProviderBars([estimate({ provider: 'aws' })]);
    expect(bars[0]).toMatchObject({ provider: 'aws', monthlyUsd: 50, state: 'priced' });
  });

  it('flags an incomplete estimate as a floor (state incomplete), NOT zero', () => {
    const bars = toProviderBars([estimate({ provider: 'gcp', monthlyUsd: 12, incomplete: true })]);
    expect(bars[0].state).toBe('incomplete');
    expect(bars[0].monthlyUsd).toBe(12); // the floor, never fabricated to 0
  });

  it('flags an unsupported provider distinctly (state unsupported)', () => {
    const bars = toProviderBars([
      estimate({ provider: 'vercel', monthlyUsd: 5, unsupportedRoles: ['db-relational'] }),
    ]);
    expect(bars[0].state).toBe('unsupported');
  });

  it('a genuine $0 total is still priced (it earned the zero)', () => {
    const bars = toProviderBars([estimate({ provider: 'aws', monthlyUsd: 0, items: [] })]);
    expect(bars[0].state).toBe('priced');
    expect(bars[0].monthlyUsd).toBe(0);
  });
});

describe('barsNeedCaveatLegend', () => {
  it('is false when every bar is priced', () => {
    expect(barsNeedCaveatLegend(toProviderBars([estimate({ provider: 'aws' })]))).toBe(false);
  });
  it('is true when any bar is a floor or unsupported', () => {
    const bars = toProviderBars([
      estimate({ provider: 'aws' }),
      estimate({ provider: 'vercel', unsupportedRoles: ['db-relational'] }),
    ]);
    expect(barsNeedCaveatLegend(bars)).toBe(true);
  });
});

describe('toComposition', () => {
  it('returns role shares summing to ~1 for a complete estimate, largest first', () => {
    const e = estimate({
      provider: 'aws',
      items: [
        line({ role: 'compute-web', monthlyUsd: 30 }),
        line({ role: 'db-relational', serviceName: 'RDS', monthlyUsd: 70 }),
      ],
      monthlyUsd: 100,
    });
    const comp = toComposition(e);
    expect(comp.map((c) => c.role)).toEqual(['db-relational', 'compute-web']);
    expect(comp[0].share).toBeCloseTo(0.7, 5);
    expect(comp.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 5);
  });

  it('drops genuine zero-cost lines but KEEPS an incomplete (unpriced) line', () => {
    const e = estimate({
      provider: 'aws',
      items: [
        line({ role: 'compute-web', monthlyUsd: 50 }),
        line({ role: 'object-storage', monthlyUsd: 0 }), // genuine zero → dropped
        line({ role: 'db-relational', monthlyUsd: 0, incomplete: true, dimensions: [unpricedDim()] }),
      ],
      monthlyUsd: 50,
    });
    const comp = toComposition(e);
    const roles = comp.map((c) => c.role);
    expect(roles).toContain('compute-web');
    expect(roles).toContain('db-relational'); // unpriced kept
    expect(roles).not.toContain('object-storage'); // genuine zero dropped
  });
});

describe('palette', () => {
  it('wraps around and is stable per index', () => {
    expect(paletteColor(0)).toBe(CHART_PALETTE[0]);
    expect(paletteColor(CHART_PALETTE.length)).toBe(CHART_PALETTE[0]);
  });
});

/* -------------------------------------------------------------------------- */
/* export-md.ts                                                               */
/* -------------------------------------------------------------------------- */

const TRADEOFFS: ProviderTradeoff[] = [
  { provider: 'aws', pros: ['Broadest service catalog'], cons: ['Egress is pricey'] },
  { provider: 'vercel', pros: ['Zero-config deploys'], cons: ['No managed Postgres'] },
];

describe('buildComparisonMarkdown', () => {
  it('cites the source URL and fetch date for every priced dimension', () => {
    const e = estimate({ provider: 'aws' });
    const md = buildComparisonMarkdown({
      title: 'My App',
      comparison: comparison({ estimates: [e], cheapest: 'aws' }),
      tradeoffs: TRADEOFFS,
      now: NOW,
    });
    expect(md).toContain('https://aws.amazon.com/ec2/pricing/');
    expect(md).toContain('Jul 26, 2026'); // fetchedAt formatted
    expect(md).toContain('# Deployment cost comparison — My App');
    expect(md).toContain('**Cheapest:** AWS');
  });

  it('labels an unpriced line as unpriced, never $0.00', () => {
    const e = estimate({
      provider: 'aws',
      items: [line({ role: 'db-relational', monthlyUsd: 0, incomplete: true, dimensions: [unpricedDim()] })],
      monthlyUsd: 0,
      incomplete: true,
    });
    const md = buildComparisonMarkdown({
      title: 'X',
      comparison: comparison({ estimates: [e] }),
      tradeoffs: [],
      now: NOW,
    });
    expect(md).toContain('unpriced');
    expect(md).toContain('floor');
    // The unpriced dimension line itself must not print "$0.00".
    const storageLine = md.split('\n').find((l) => l.includes('Storage:'));
    expect(storageLine).toBeDefined();
    expect(storageLine).not.toContain('$0.00');
  });

  it('states an unsupported provider cannot run the app and does not call it cheap', () => {
    const e = estimate({ provider: 'vercel', monthlyUsd: 5, unsupportedRoles: ['db-relational'] });
    const md = buildComparisonMarkdown({
      title: 'X',
      comparison: comparison({ estimates: [e] }),
      tradeoffs: TRADEOFFS,
      now: NOW,
    });
    expect(md.toLowerCase()).toContain('cannot run this app');
    expect(md).toContain('Relational database');
  });

  it('renders no-winner copy when all badge awards are null', () => {
    const e = estimate({ provider: 'aws' });
    const md = buildComparisonMarkdown({
      title: 'X',
      comparison: comparison({ estimates: [e] }),
      tradeoffs: [],
      now: NOW,
    });
    expect(md.toLowerCase()).toContain('no single winner');
  });

  it('includes pros and cons per provider', () => {
    const e = estimate({ provider: 'aws' });
    const md = buildComparisonMarkdown({
      title: 'X',
      comparison: comparison({ estimates: [e] }),
      tradeoffs: TRADEOFFS,
      now: NOW,
    });
    expect(md).toContain('Broadest service catalog');
    expect(md).toContain('Egress is pricey');
  });
});

describe('comparisonFileStem', () => {
  it('slugifies the title with a cost-comparison suffix', () => {
    expect(comparisonFileStem('My Great App!')).toBe('my-great-app-cost-comparison');
  });
  it('falls back when the title has no usable characters', () => {
    expect(comparisonFileStem('!!!')).toBe('cost-comparison');
  });
});
