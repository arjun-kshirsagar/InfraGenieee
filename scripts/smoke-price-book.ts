/**
 * Dev-only LIVE smoke runner for the DigitalOcean price book (task B5).
 * Uses the REAL Tavily + Anthropic pipeline. Run with the keys from .env.local:
 *
 *   npx tsx --env-file=.env.local scripts/smoke-price-book.ts
 *
 * (Per the task note: do NOT `source .env.local` — that un-skips Feature 1's
 * live PRD tests. `--env-file` scopes the keys to this one process. tsx→CJS, so
 * the body is wrapped in main().)
 *
 * This mirrors src/lib/cost/pricing/build.live.test.ts exactly; it exists so the
 * live proof can be produced and pasted into the kanban comment without running
 * vitest with exported keys.
 */
import { catalogServices } from '../src/lib/cost/catalog';
import { buildPriceBook } from '../src/lib/cost/pricing/build';
import { assertEvidenceSupportsPrice } from '../src/lib/cost/pricing/evidence';
import { fetchPricingPages } from '../src/lib/cost/pricing/tavily';
import { priceBookSchema } from '../src/types/cost';

async function main() {
  if (!process.env.TAVILY_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    console.error('Missing TAVILY_API_KEY or ANTHROPIC_API_KEY — run with --env-file=.env.local');
    process.exit(1);
  }

  const book = await buildPriceBook('digitalocean', { force: true });

  const parsed = priceBookSchema.safeParse(book);
  console.log('schema-valid:', parsed.success);
  console.log(`records=${book.records.length} gaps=${book.gaps.length} region=${book.region}`);

  const catalogUrls = new Set(
    catalogServices.filter((s) => s.provider === 'digitalocean').map((s) => s.pricingUrl),
  );

  // Re-prove every record's evidence against its own freshly-fetched page.
  const pages = await fetchPricingPages([...catalogUrls]);
  const pageByUrl = new Map(pages.map((p) => [p.url, p]));
  let reproven = 0;
  for (const r of book.records) {
    const page = pageByUrl.get(r.source.url);
    if (!page) continue;
    const reason = assertEvidenceSupportsPrice({
      page,
      evidence: r.source.evidence,
      unitPriceUsd: r.unitPriceUsd,
    });
    if (reason === null) reproven++;
    else console.log(`  !! re-prove FAILED for ${r.skuId} ${r.dimensionId}: ${reason}`);
  }
  console.log(`re-proven records: ${reproven}/${book.records.length}`);

  console.log('\n=== records ===');
  for (const r of book.records) {
    console.log(
      `  ${r.skuId} ${r.dimensionId} = $${r.unitPriceUsd}\n     url=${r.source.url}\n     evidence="${r.source.evidence.slice(0, 120).replace(/\s+/g, ' ')}"`,
    );
  }
  console.log('\n=== gaps (first 15) ===');
  for (const g of book.gaps.slice(0, 15)) {
    console.log(`  ${g.skuId} ${g.dimensionId} — ${g.reason}${g.detail ? ` (${g.detail.slice(0, 60)})` : ''}`);
  }
}

void main();
