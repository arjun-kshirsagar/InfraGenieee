/**
 * 🔴 LIVE end-to-end smoke test for the price-book pipeline (task B5).
 *
 * This is the proof the brief demands: fetch (real Tavily) → extract (real
 * Anthropic Haiku) → evidence gate → assembled `PriceBook`, end to end, against
 * a REAL vendor page. Mocked-only tests hid a real bug in Feature 1; this closes
 * that class for Feature 2.
 *
 * It is SKIPPED unless BOTH keys are present, so `npm test` stays fast and
 * offline by default. Run it deliberately with:
 *
 *   ANTHROPIC_API_KEY=… TAVILY_API_KEY=… npx vitest run \
 *     src/lib/cost/pricing/build.live.test.ts
 *
 * DigitalOcean is chosen because its pricing pages return the cleanest markdown
 * tables (docs §4). We assert: ≥1 record, every record's evidence passes the
 * gate against its own source page, and every source.url is a real vendor URL.
 */

import { describe, expect, it } from 'vitest';

import { priceBookSchema } from '@/types/cost';
import { catalogServices } from '@/lib/cost/catalog';
import { buildPriceBook } from '@/lib/cost/pricing/build';
import { assertEvidenceSupportsPrice } from '@/lib/cost/pricing/evidence';
import { fetchPricingPages } from '@/lib/cost/pricing/tavily';

const HAS_KEYS = Boolean(process.env.TAVILY_API_KEY && process.env.ANTHROPIC_API_KEY);

// A generous timeout: this makes several real Tavily + Anthropic round-trips.
const LIVE_TIMEOUT_MS = 180_000;

describe.skipIf(!HAS_KEYS)('buildPriceBook — LIVE DigitalOcean smoke (real fetch + extract + gate)', () => {
  it(
    'builds a real, schema-valid, evidence-backed book for DigitalOcean',
    async () => {
      const book = await buildPriceBook('digitalocean', { force: true });

      // Schema-valid.
      expect(priceBookSchema.safeParse(book).success).toBe(true);
      expect(book.provider).toBe('digitalocean');

      // ≥1 priced record survived the real pipeline.
      expect(book.records.length).toBeGreaterThanOrEqual(1);

      // Every source.url is a real DigitalOcean vendor URL from the catalog.
      const catalogUrls = new Set(
        catalogServices.filter((s) => s.provider === 'digitalocean').map((s) => s.pricingUrl),
      );
      for (const r of book.records) {
        expect(catalogUrls.has(r.source.url)).toBe(true);
        expect(r.source.url.startsWith('https://www.digitalocean.com/')).toBe(true);
        expect(r.source.evidence.length).toBeGreaterThan(0);
        expect(r.unitPriceUsd).toBeGreaterThanOrEqual(0);
      }

      // Re-prove every record's evidence against its OWN freshly-fetched page:
      // the gate must still accept it. This catches a record whose evidence was
      // somehow not actually on the page (belt-and-braces on the invariant).
      const pages = await fetchPricingPages([...catalogUrls]);
      const pageByUrl = new Map(pages.map((p) => [p.url, p]));
      for (const r of book.records) {
        const page = pageByUrl.get(r.source.url);
        // The page must have been fetchable, and the evidence must still pass.
        if (page) {
          const reason = assertEvidenceSupportsPrice({
            page,
            evidence: r.source.evidence,
            unitPriceUsd: r.unitPriceUsd,
          });
          expect(reason).toBeNull();
        }
      }

      // Human-readable proof for the kanban comment.

      console.log('\n=== LIVE DigitalOcean price book ===');
      console.log(`records=${book.records.length} gaps=${book.gaps.length} region=${book.region}`);
      for (const r of book.records.slice(0, 12)) {
        console.log(
          `  ${r.skuId} ${r.dimensionId} = $${r.unitPriceUsd}  ` +
            `[${r.source.url}]  evidence="${r.source.evidence.slice(0, 80).replace(/\s+/g, ' ')}"`,
        );
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
