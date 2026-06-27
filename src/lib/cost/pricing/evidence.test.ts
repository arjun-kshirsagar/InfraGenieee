/**
 * Tests for the evidence gate — the anti-fabrication invariant.
 *
 * These run OFFLINE and FREE (the function is pure). The whole point of this
 * suite is the FABRICATED-PRICE-REJECTED case: a suite that only proves the
 * happy path does not test this function at all (see docs §5, "Mandatory
 * test"). Every real-page snippet below is taken verbatim from the vendor
 * pricing markdown that Tavily returns (see docs §4).
 */

import { describe, expect, it } from 'vitest';

import {
  assertEvidenceSupportsPrice,
  assertAllowanceInDimensionUnit,
} from '@/lib/cost/pricing/evidence';
import type { FetchedPage } from '@/lib/cost/pricing-seam';

/** Build a FetchedPage around a markdown body. */
function page(markdown: string): FetchedPage {
  return {
    url: 'https://www.digitalocean.com/pricing/droplets',
    title: 'Droplet pricing',
    markdown,
    fetchedAt: '2026-07-26T00:00:00.000Z',
  };
}

/**
 * A real DigitalOcean Droplets row as Tavily returns it — the exact shape the
 * task calls out. Note the `1,000` GiB transfer cell sitting next to the `$6.00`
 * monthly price: the value `6` must match `$6.00`, NOT the `000` inside `1,000`.
 */
const DO_ROW = '| 1 GiB | 1 vCPU | 1,000 GiB | 25 GiB | $0.00893 | $6.00 |';

/** A real GCP Cloud Run per-second row — tiny numbers must survive verbatim. */
const GCP_ROW = '| CPU (per vCPU-second) | $0.000018 |';

const DO_TABLE = [
  '| Memory | vCPU | Transfer | SSD | $/hr | $/mo |',
  '|---|---|---|---|---|---|',
  DO_ROW,
  '| 2 GiB | 1 vCPU | 2,000 GiB | 50 GiB | $0.01786 | $12.00 |',
].join('\n');

describe('assertEvidenceSupportsPrice — the mandatory counterexample', () => {
  it('🔴 REJECTS a fabricated price: evidence is real, but the number is not in it', () => {
    // Evidence taken verbatim from the real page; the model claims $7.50/mo,
    // a plausible number that is NOT anywhere in this row. It MUST be rejected.
    const reason = assertEvidenceSupportsPrice({
      page: page(DO_TABLE),
      evidence: DO_ROW,
      unitPriceUsd: 7.5,
    });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/does not appear/i);
  });
});

describe('assertEvidenceSupportsPrice — substring check (requirement 1)', () => {
  it('rejects evidence that is not a substring of the page', () => {
    const reason = assertEvidenceSupportsPrice({
      page: page(DO_TABLE),
      evidence: '| 4 GiB | 2 vCPU | 4,000 GiB | 80 GiB | $0.03571 | $24.00 |', // not on the page
      unitPriceUsd: 24,
    });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/not a verbatim substring/i);
  });

  it('accepts a real table row despite irregular whitespace on both sides', () => {
    // The page uses single-space padding; the evidence the extractor emits uses
    // ragged, multi-space padding. Collapsing runs of whitespace on both sides
    // is the ONLY normalisation allowed, and it must make this pass.
    const raggedEvidence = '|   1 GiB |  1 vCPU  |   1,000 GiB | 25 GiB |  $0.00893 |   $6.00 |';
    const reason = assertEvidenceSupportsPrice({
      page: page(DO_TABLE),
      evidence: raggedEvidence,
      unitPriceUsd: 6,
    });
    expect(reason).toBeNull();
  });

  it('rejects empty evidence', () => {
    const reason = assertEvidenceSupportsPrice({
      page: page(DO_TABLE),
      evidence: '   ',
      unitPriceUsd: 6,
    });
    expect(reason).not.toBeNull();
  });
});

describe('assertEvidenceSupportsPrice — numeric-token check (requirement 2)', () => {
  it('rejects 0.032 when the evidence only contains 0.32 (no substring-of-a-number)', () => {
    const reason = assertEvidenceSupportsPrice({
      page: page('the rate is $0.32 per unit'),
      evidence: 'the rate is $0.32 per unit',
      unitPriceUsd: 0.032,
    });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/does not appear/i);
  });

  it('rejects 6 matching the 000 inside 1,000 — token boundaries are respected', () => {
    // Only the transfer cell (1,000) carries a "6"-adjacent run; assert that a
    // price of 6 is matched by $6.00 and NOT smuggled out of 1,000. We prove the
    // boundary directly: a price the row does NOT contain but whose digits live
    // inside 1,000 must be rejected.
    const reason = assertEvidenceSupportsPrice({
      page: page(DO_TABLE),
      evidence: '| 1 GiB | 1 vCPU | 1,000 GiB | 25 GiB | $0.00893 | $6.00 |',
      unitPriceUsd: 100, // "100" is a substring of "1,000" once commas are dropped
    });
    expect(reason).not.toBeNull();
  });

  it('matches $6.00 by 6, 6.0, and 6.00 (trailing-zero tolerance)', () => {
    for (const price of [6, 6.0, 6.0]) {
      const reason = assertEvidenceSupportsPrice({
        page: page(DO_ROW),
        evidence: DO_ROW,
        unitPriceUsd: price,
      });
      expect(reason).toBeNull();
    }
  });

  it('matches a value with more trailing zeros on the page than in the number (0.032 vs $0.0320)', () => {
    const md = '| egress | $0.0320 / GB |';
    const reason = assertEvidenceSupportsPrice({
      page: page(md),
      evidence: md,
      unitPriceUsd: 0.032,
    });
    expect(reason).toBeNull();
  });

  it('accepts thousands separators (1,000)', () => {
    const md = '| plan | includes 1,000 build minutes | $20.00 |';
    const reason = assertEvidenceSupportsPrice({
      page: page(md),
      evidence: md,
      unitPriceUsd: 1000,
    });
    expect(reason).toBeNull();
  });

  it('preserves tiny per-second numbers verbatim ($0.000018, not 1.8e-5)', () => {
    const reason = assertEvidenceSupportsPrice({
      page: page(GCP_ROW),
      evidence: GCP_ROW,
      unitPriceUsd: 0.000018,
    });
    expect(reason).toBeNull();
  });

  it('rejects a tiny number the page does not carry', () => {
    const reason = assertEvidenceSupportsPrice({
      page: page(GCP_ROW),
      evidence: GCP_ROW,
      unitPriceUsd: 0.000019,
    });
    expect(reason).not.toBeNull();
  });

  it('accepts a legitimate 0 price (GCP ingress) when a real 0 is present', () => {
    const md = '| Ingress (per GB) | $0 |';
    const reason = assertEvidenceSupportsPrice({
      page: page(md),
      evidence: md,
      unitPriceUsd: 0,
    });
    expect(reason).toBeNull();
  });

  it('rejects a 0 price when the evidence carries no real 0 for it', () => {
    const md = '| Ingress (per GB) | free of charge |';
    const reason = assertEvidenceSupportsPrice({
      page: page(md),
      evidence: md,
      unitPriceUsd: 0,
    });
    expect(reason).not.toBeNull();
  });

  it('does NOT match 0 inside another number like 0.032 (0 must be a standalone token)', () => {
    const md = '| rate | $0.032 |';
    const reason = assertEvidenceSupportsPrice({
      page: page(md),
      evidence: md,
      unitPriceUsd: 0,
    });
    expect(reason).not.toBeNull();
  });

  it('matches a $-prefixed integer price', () => {
    const md = '| Pro plan | $20 per month |';
    const reason = assertEvidenceSupportsPrice({
      page: page(md),
      evidence: md,
      unitPriceUsd: 20,
    });
    expect(reason).toBeNull();
  });

  it('rejects a non-finite price outright', () => {
    const reason = assertEvidenceSupportsPrice({
      page: page(DO_ROW),
      evidence: DO_ROW,
      unitPriceUsd: Number.NaN,
    });
    expect(reason).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The ALLOWANCE gate (MAJOR-1) — a fetched free tier must be PROVEN to be in  */
/* the dimension's own unit, or it is a fabricated discount laundered through  */
/* a real number. Each snippet below is the verbatim page text the QA report   */
/* (docs/qa-feature-2.md §MAJOR-1) traced each broken allowance to.            */
/* -------------------------------------------------------------------------- */

describe('assertAllowanceInDimensionUnit — the allowance gate', () => {
  const pubsubPage =
    'Pub/Sub throughput pricing. Note: the first 10 GiB of throughput per month is free (Message Delivery Basic).';
  const doStaticPage =
    'App Platform Free tier: 3 apps with static sites, 1 GiB/app monthly transfer, global CDN.';
  const doFuncPage =
    'DigitalOcean Functions: after the 90,000 GiB-seconds free monthly grant, ' +
    '$0.0000185 per GiB-seconds for additional memory and runtime.';
  const gcpEgressPage =
    'Premium Tier internet egress to North America. 0 gibibyte to 1 gibibyte $0.00 (Free). ' +
    '1 gibibyte to 1,024 gibibyte $0.12 / 1 gibibyte.';

  it('🔴 REJECTS "10 GiB free" against a per-TiB dimension (1024× too generous)', () => {
    // gcp:pubsub:standard · throughput-tib, unit "USD / TiB": the free tier is
    // stated in GiB but the dimension bills in TiB — a units mismatch.
    const reason = assertAllowanceInDimensionUnit({
      page: page(pubsubPage),
      allowanceEvidence: 'the first 10 GiB of throughput per month is free',
      includedQuantity: 10,
      dimensionUnit: 'USD / TiB',
    });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/bytes-tera|bytes-giga/);
  });

  it('🔴 REJECTS "3 apps free" against a per-month dimension (free forever)', () => {
    // digitalocean:app-platform-static:starter · site-month, unit "USD / site-month":
    // "3 apps" is a COUNT, not months — cannot be subtracted from a months quantity.
    const reason = assertAllowanceInDimensionUnit({
      page: page(doStaticPage),
      allowanceEvidence: '3 apps with static sites',
      includedQuantity: 3,
      dimensionUnit: 'USD / site-month',
    });
    expect(reason).not.toBeNull();
  });

  it('🔴 REJECTS an allowance whose evidence is the PRICE sentence, not the allowance', () => {
    // digitalocean:functions:standard · gib-second: the QA report found 90,000 was
    // lifted from a different sentence than the cited price excerpt. If the evidence
    // offered is the price sentence, the allowance number is not in it → rejected.
    const reason = assertAllowanceInDimensionUnit({
      page: page(doFuncPage),
      allowanceEvidence: '$0.0000185 per GiB-seconds for additional memory and runtime',
      includedQuantity: 90000,
      dimensionUnit: 'USD / GiB-second',
    });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/does not appear as a numeric token/);
  });

  it('✅ ACCEPTS a genuine same-unit allowance stated with the correct number + unit', () => {
    // If the DO Functions page states the 90,000 GiB-seconds grant verbatim and it
    // is offered as the allowance evidence, it is in the dimension's unit → kept.
    const reason = assertAllowanceInDimensionUnit({
      page: page(doFuncPage),
      allowanceEvidence: 'the 90,000 GiB-seconds free monthly grant',
      includedQuantity: 90000,
      dimensionUnit: 'USD / GiB-second',
    });
    expect(reason).toBeNull();
  });

  it('✅ ACCEPTS "1 gibibyte free" against a per-GiB dimension (the correct case)', () => {
    // gcp:egress:internet · egress-gib, unit "USD / GiB": "gibibyte" and "GiB" are
    // the same family, and the allowance 1 is in that unit → correctly kept.
    const reason = assertAllowanceInDimensionUnit({
      page: page(gcpEgressPage),
      allowanceEvidence: '0 gibibyte to 1 gibibyte $0.00 (Free)',
      includedQuantity: 1,
      dimensionUnit: 'USD / GiB',
    });
    expect(reason).toBeNull();
  });

  it('a zero allowance is a no-op (nothing to prove)', () => {
    expect(
      assertAllowanceInDimensionUnit({
        page: page(gcpEgressPage),
        allowanceEvidence: '',
        includedQuantity: 0,
        dimensionUnit: 'USD / GiB',
      }),
    ).toBeNull();
  });

  it('rejects a positive allowance with empty evidence (fetched, not assumed)', () => {
    const reason = assertAllowanceInDimensionUnit({
      page: page(gcpEgressPage),
      allowanceEvidence: '',
      includedQuantity: 1,
      dimensionUnit: 'USD / GiB',
    });
    expect(reason).not.toBeNull();
  });

  it('rejects an allowance whose evidence is not on the page', () => {
    const reason = assertAllowanceInDimensionUnit({
      page: page(gcpEgressPage),
      allowanceEvidence: 'first 5 gibibytes are free', // not present verbatim
      includedQuantity: 5,
      dimensionUnit: 'USD / GiB',
    });
    expect(reason).not.toBeNull();
  });
});
