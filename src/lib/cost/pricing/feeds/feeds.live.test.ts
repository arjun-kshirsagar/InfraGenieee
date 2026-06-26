/**
 * 🔴 LIVE smoke test for the STRUCTURED PRICE FEEDS (AWS Price List / EC2
 * metered, Azure Retail Prices).
 *
 * ## Why this file exists (BLOCKER-3 post-mortem)
 *
 * The AWS and Azure price books are assembled from provider feeds, not the
 * Tavily+LLM path. Those adapters were covered ONLY by offline fixture tests —
 * and a 100% real-world failure slipped through anyway: a serialised Azure
 * Retail record is ~750-900 chars, which blew past the 600-char `evidence` cap
 * and voided Azure's ENTIRE book at runtime, so Azure rendered "≥ $0.00", sorted
 * first, and won badges it had not earned. A green fixture suite never caught it
 * because the recorded fixtures happened to be short.
 *
 * This test closes that class of bug: it drives the REAL feed endpoints through
 * the REAL `buildPriceBook` pipeline and asserts the assembled records actually
 * survive `priceRecordSchema` — the exact gate BLOCKER-3 failed. If the schema
 * cap is ever lowered below a real record again, THIS test goes red.
 *
 * ## Cost safety
 *
 * The feeds are FREE, public, unauthenticated HTTPS GETs against the vendors'
 * own price catalogs (prices.azure.com, pricing.us-east-1.amazonaws.com,
 * b0.p.awsstatic.com). No API key, no account, no billable call, no deployment.
 *
 * ## Running it
 *
 * SKIPPED by default so `npm test` stays fast + offline. Opt in with:
 *
 *   LIVE_FEED_SMOKE=1 npx vitest run src/lib/cost/pricing/feeds/feeds.live.test.ts
 */

import { describe, expect, it } from 'vitest';

import { priceBookSchema, priceRecordSchema } from '@/types/cost';
import { catalogServices } from '@/lib/cost/catalog';
import { buildPriceBook } from '@/lib/cost/pricing/build';

const RUN_LIVE = process.env.LIVE_FEED_SMOKE === '1';

// A single real GET per feed; generous ceiling for a cold network.
const LIVE_TIMEOUT_MS = 120_000;

/** Assert a freshly-built feed book is real, schema-valid, and — crucially —
 *  that every assembled record ALSO passes `priceRecordSchema` on its own. That
 *  per-record check is the one BLOCKER-3 failed (the over-long evidence cap). */
function assertHealthyFeedBook(
  book: Awaited<ReturnType<typeof buildPriceBook>>,
  provider: 'aws' | 'azure',
  urlPrefix: string,
) {
  // The outer book parses.
  expect(priceBookSchema.safeParse(book).success).toBe(true);
  expect(book.provider).toBe(provider);

  // 🔴 The feed produced REAL records — not "all gaps" (which is what BLOCKER-3
  // silently degraded Azure to). If this is 0, the feed or the pipeline is
  // broken for this provider.
  expect(book.records.length).toBeGreaterThanOrEqual(1);

  const catalogUrls = new Set(
    catalogServices.filter((s) => s.provider === provider).map((s) => s.pricingUrl),
  );

  for (const r of book.records) {
    // 🔴 Every record independently survives priceRecordSchema. Before the cap
    // was raised, real feed records (evidence = the serialised matched item)
    // failed HERE, and the whole book was thrown away. This assertion is the
    // regression guard for BLOCKER-3.
    const parsed = priceRecordSchema.safeParse(r);
    expect(
      parsed.success,
      `record ${r.skuId}|${r.dimensionId} must pass priceRecordSchema ` +
        `(evidence length=${r.source.evidence.length}); ` +
        (parsed.success ? '' : JSON.stringify(parsed.error?.issues)),
    ).toBe(true);

    // Provenance is real: a cited vendor URL, a non-empty evidence excerpt, a
    // finite non-negative price.
    expect(catalogUrls.has(r.source.url)).toBe(true);
    expect(r.source.url.startsWith(urlPrefix)).toBe(true);
    expect(r.source.evidence.length).toBeGreaterThan(0);
    expect(Number.isFinite(r.unitPriceUsd)).toBe(true);
    expect(r.unitPriceUsd).toBeGreaterThanOrEqual(0);
  }

  // Human-readable proof for the kanban comment / CI log.
  console.log(`\n=== LIVE ${provider} feed price book ===`);
  console.log(`records=${book.records.length} gaps=${book.gaps.length} region=${book.region}`);
  const maxEvidence = Math.max(0, ...book.records.map((r) => r.source.evidence.length));
  console.log(`longest evidence=${maxEvidence} chars (schema cap is 2000)`);
  for (const r of book.records.slice(0, 12)) {
    console.log(
      `  ${r.skuId} ${r.dimensionId} = $${r.unitPriceUsd}  ` +
        `evidenceLen=${r.source.evidence.length}  [${r.source.url}]`,
    );
  }
}

describe.skipIf(!RUN_LIVE)('price feeds — LIVE smoke (real free feeds, no key)', () => {
  it(
    '🔴 Azure Retail feed builds real, schema-valid records (the BLOCKER-3 regression guard)',
    async () => {
      const book = await buildPriceBook('azure', { force: true });
      assertHealthyFeedBook(book, 'azure', 'https://');
      // Azure's real records are the ones that broke the 600-char cap; assert at
      // least one genuinely exceeds 600 chars so this test actually exercises
      // the raised cap (if a future fixture/feed shrinks them, we want to know).
      const anyOver600 = book.records.some((r) => r.source.evidence.length > 600);
      expect(anyOver600).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'AWS Price List / EC2 metered feeds build real, schema-valid records',
    async () => {
      const book = await buildPriceBook('aws', { force: true });
      assertHealthyFeedBook(book, 'aws', 'https://');
    },
    LIVE_TIMEOUT_MS,
  );
});
