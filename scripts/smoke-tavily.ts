/**
 * MANUAL LIVE SMOKE — not part of the automated suite. Makes ONE real Tavily
 * `/extract` call to prove `fetchPricingPages` works end-to-end against the live
 * API and that the fetched markdown actually carries a `$`-bearing price table.
 *
 * COST SAFETY: Tavily `/extract` on a public vendor pricing page is a free,
 * public, unauthenticated read (docs §4/§10 — "no account, no billing"). This
 * uses our configured TAVILY_API_KEY only, ONE call, ONE page. Do NOT loop or
 * sweep. The unit suite (`src/lib/cost/pricing/tavily.test.ts`) is fully mocked
 * and free; use that for iteration.
 *
 * Usage (loads .env.local automatically, does NOT pollute your shell env):
 *   npx tsx --env-file=.env.local scripts/smoke-tavily.ts
 * or, if tsx isn't installed:
 *   node --env-file=.env.local --experimental-strip-types scripts/smoke-tavily.ts
 */

import { fetchPricingPages } from '../src/lib/cost/pricing/tavily';
import { assertEvidenceSupportsPrice } from '../src/lib/cost/pricing/evidence';
import { PricingError } from '../src/lib/cost/pricing-seam';

const TARGET_URL = 'https://www.digitalocean.com/pricing/droplets';

async function main() {
  if (!process.env.TAVILY_API_KEY) {
    console.error('[smoke] TAVILY_API_KEY is not set. Run with --env-file=.env.local.');
    process.exit(1);
  }

  console.log(`[smoke] one real Tavily /extract call → ${TARGET_URL}`);
  const pages = await fetchPricingPages([TARGET_URL]);

  if (pages.length === 0) {
    console.error('[smoke] FAIL — Tavily returned no page (failed_results omitted). Try again.');
    process.exit(1);
  }

  const [page] = pages;
  console.log(`[smoke] fetched: "${page.title}"`);
  console.log(`[smoke] fetchedAt: ${page.fetchedAt}`);
  console.log(`[smoke] markdown length: ${page.markdown.length} chars`);

  // Find a real table row that carries a `$` price.
  const dollarRow = page.markdown
    .split('\n')
    .find((line) => line.includes('|') && /\$\s?\d/.test(line));

  if (!dollarRow) {
    console.error('[smoke] FAIL — no `$`-bearing table row found in the fetched markdown.');
    // Show a slice so a human can see what came back.
    console.error('[smoke] first 800 chars:\n' + page.markdown.slice(0, 800));
    process.exit(1);
  }

  console.log('[smoke] found a $-bearing table row:');
  console.log('   ' + dollarRow.trim());

  // Bonus: prove the evidence gate accepts a real number pulled from that row,
  // and rejects a fabricated one — the anti-fabrication invariant, live.
  const priceMatch = dollarRow.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
  if (priceMatch) {
    const realPrice = Number(priceMatch[1].replace(/,/g, ''));
    const acceptReason = assertEvidenceSupportsPrice({
      page,
      evidence: dollarRow,
      unitPriceUsd: realPrice,
    });
    const fabricated = realPrice + 0.137; // a number not on the row
    const rejectReason = assertEvidenceSupportsPrice({
      page,
      evidence: dollarRow,
      unitPriceUsd: fabricated,
    });
    console.log(
      `[smoke] evidence gate: real price ${realPrice} → ${
        acceptReason === null ? 'ACCEPTED ✅' : `REJECTED (unexpected: ${acceptReason})`
      }`,
    );
    console.log(
      `[smoke] evidence gate: fabricated ${fabricated} → ${
        rejectReason === null ? 'ACCEPTED (unexpected!) ❌' : 'REJECTED ✅'
      }`,
    );
    if (acceptReason !== null || rejectReason === null) {
      console.error('[smoke] FAIL — evidence gate behaved unexpectedly on live data.');
      process.exit(1);
    }
  }

  console.log('[smoke] OK — live Tavily fetch carries priced markdown and the gate works.');
}

main().catch((err) => {
  if (err instanceof PricingError) {
    console.error(`[smoke] PricingError(${err.code}): ${err.message}`);
  } else {
    console.error('[smoke] unexpected error:', err);
  }
  process.exit(1);
});
