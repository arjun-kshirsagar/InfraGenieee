/**
 * Descriptor ↔ catalog consistency guards (MAJOR-2).
 *
 * OFFLINE and FREE — pure data. These lock the two invariants that keep the AWS
 * feed path honest without a live call:
 *
 *   1. FULL COVERAGE — every AWS catalog dimension has a wired feed descriptor,
 *      so AWS is no longer a wall of `not_found` floors (was 4/53 = 8%). A new
 *      AWS dimension with no descriptor fails this test loudly.
 *
 *   2. ONE SCALE REPRESENTATION — a Price List descriptor's `priceScale` MUST
 *      equal its catalog dimension's `pricePerUnits`. The Price List quotes per
 *      single unit; the engine bills per `pricePerUnits`; the adapter multiplies
 *      the raw price by `priceScale`. If those two numbers drift, the total is
 *      silently wrong by that ratio (the SQS $0.0000004-vs-$0.40 bug). This test
 *      makes the drift impossible to merge.
 */

import { describe, expect, it } from 'vitest';

import { serviceCatalog } from '@/lib/cost/catalog';
import { feedDescriptorFor, FEED_PROVIDERS } from '@/lib/cost/pricing/feeds/descriptors';

const awsDims = serviceCatalog.services
  .filter((s) => s.provider === 'aws')
  .flatMap((s) => s.skus.flatMap((sku) => sku.dimensions.map((dim) => ({ sku, dim }))));

describe('AWS feed descriptors — full coverage (MAJOR-2)', () => {
  it('aws is a feed provider', () => {
    expect(FEED_PROVIDERS.has('aws')).toBe(true);
  });

  it('every AWS catalog dimension has a wired feed descriptor (no unwired floors)', () => {
    const unwired = awsDims
      .filter(({ sku, dim }) => feedDescriptorFor(sku.id, dim.id) === null)
      .map(({ sku, dim }) => `${sku.id} · ${dim.id}`);
    expect(unwired, 'these AWS dimensions have no descriptor and would render as $0.00 floors').toEqual(
      [],
    );
  });
});

describe('AWS feed descriptors — 🔴 priceScale === catalog pricePerUnits (ONE representation)', () => {
  it('every price-list descriptor scale matches its dimension pricePerUnits', () => {
    const mismatches: string[] = [];
    for (const { sku, dim } of awsDims) {
      const desc = feedDescriptorFor(sku.id, dim.id);
      if (!desc || desc.feed !== 'aws-price-list') continue;
      const scale = (desc.query as { priceScale?: number }).priceScale ?? 1;
      const ppu = dim.pricePerUnits ?? 1;
      if (scale !== ppu) {
        mismatches.push(`${sku.id} · ${dim.id}: priceScale=${scale} but pricePerUnits=${ppu}`);
      }
    }
    expect(
      mismatches,
      'a descriptor priceScale must equal the dimension pricePerUnits or totals ship wrong by that ratio',
    ).toEqual([]);
  });

  it('every BULK AWS dimension (pricePerUnits > 1) carries a matching non-default priceScale', () => {
    const offenders: string[] = [];
    for (const { sku, dim } of awsDims) {
      const ppu = dim.pricePerUnits ?? 1;
      if (ppu <= 1) continue; // only bulk dims need scaling
      const desc = feedDescriptorFor(sku.id, dim.id);
      // Bulk AWS dims are all fed via the Price List (per-single-unit source).
      if (!desc || desc.feed !== 'aws-price-list') {
        offenders.push(`${sku.id} · ${dim.id}: bulk dim not on the price-list feed`);
        continue;
      }
      const scale = (desc.query as { priceScale?: number }).priceScale ?? 1;
      if (scale !== ppu) {
        offenders.push(`${sku.id} · ${dim.id}: priceScale=${scale} ≠ pricePerUnits=${ppu}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
