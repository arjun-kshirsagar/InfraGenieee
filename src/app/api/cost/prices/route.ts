/**
 * GET /api/cost/prices
 *
 * The price books the client needs to run the pure cost engine locally. Each
 * book is per-provider and self-contained, so one failing vendor can never
 * invalidate the others.
 *
 * The handler contains NO business logic (docs/api-contracts.md §Conventions):
 * parse the ?providers= query → delegate to the pricing seam per provider →
 * respond. All the fetch/extract/evidence-gate work lives behind
 * `buildPriceBook`; the route only orchestrates and maps to HTTP.
 *
 * Contract (docs/api-contracts.md §GET /api/cost/prices):
 *   200 { books }              — success, possibly WITH gaps[] (a partial book
 *                                is a success: four priced providers plus one
 *                                gap beats an error page).
 *   400 validation_error       — an unknown provider in ?providers=.
 *   503 pricing_unavailable    — NOT ONE book could be produced (retryable).
 *   500 internal_error         — unexpected.
 *
 * SECURITY: an API key (TAVILY_API_KEY / ANTHROPIC_API_KEY) or a raw upstream
 * body must NEVER appear in a response. Upstream detail is logged server-side
 * only; the client sees a fixed, safe message.
 *
 * A cold cache makes the first call slow (real fetches). We deliberately impose
 * NO short internal timeout here — one that guarantees failure on a cold cache
 * would be worse than a slow-but-correct first response. The client shows a
 * loading state (contract guarantee 5).
 */

import { NextResponse } from 'next/server';

import {
  cloudProviderSchema,
  pricesResponseSchema,
  CLOUD_PROVIDERS,
  type CloudProvider,
  type PriceBook,
} from '@/types/cost';
import { apiError, ERROR_STATUS } from '@/lib/prd/api';
import { buildPriceBook } from '@/lib/cost/pricing/build';

// Real fetches on a cold cache — never statically cache this response.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A cold cache fetches + extracts several vendor pages. 300s is the ceiling for
// the worst case (all five providers cold), not the norm.
export const maxDuration = 300;

/**
 * Parse the optional `?providers=aws,gcp` query into a validated provider list.
 * Returns the requested providers on success, or the list of invalid tokens so
 * the route can render a 400 with a useful message. Omitting the param (or an
 * empty value) means "all five".
 */
function parseProviders(
  url: string,
): { ok: true; providers: CloudProvider[] } | { ok: false; invalid: string[] } {
  const raw = new URL(url).searchParams.get('providers');
  if (raw === null || raw.trim() === '') {
    return { ok: true, providers: [...CLOUD_PROVIDERS] };
  }

  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const providers: CloudProvider[] = [];
  const invalid: string[] = [];
  const seen = new Set<CloudProvider>();
  for (const token of tokens) {
    const parsed = cloudProviderSchema.safeParse(token);
    if (!parsed.success) {
      invalid.push(token);
      continue;
    }
    if (!seen.has(parsed.data)) {
      seen.add(parsed.data);
      providers.push(parsed.data);
    }
  }

  if (invalid.length > 0) return { ok: false, invalid };
  // A query of only commas/whitespace collapses to nothing meaningful → all.
  if (providers.length === 0) return { ok: true, providers: [...CLOUD_PROVIDERS] };
  return { ok: true, providers };
}

export async function GET(request: Request): Promise<NextResponse> {
  // 1. Parse + validate the query. An unknown provider is a 400.
  const parsed = parseProviders(request.url);
  if (!parsed.ok) {
    return NextResponse.json(
      apiError('validation_error', 'Unknown provider in ?providers= query.', [
        {
          path: 'providers',
          message: `Unknown provider(s): ${parsed.invalid.join(', ')}. Allowed: ${CLOUD_PROVIDERS.join(', ')}.`,
        },
      ]),
      { status: ERROR_STATUS.validation_error },
    );
  }

  // 2. Delegate to the pricing seam per provider, in parallel. A single provider
  //    failing (thrown PricingError, or any error) becomes a skipped book, NOT a
  //    whole-request failure — that is what makes a partial result a 200.
  const settled = await Promise.allSettled(
    parsed.providers.map((provider) => buildPriceBook(provider, { signal: request.signal })),
  );

  const books: PriceBook[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      books.push(outcome.value);
    } else {
      // Log the upstream detail server-side ONLY — it may carry request ids or
      // key-adjacent text. The client never sees it.
      console.error(
        `[api/cost/prices] price book failed for provider "${parsed.providers[i]}"`,
        outcome.reason,
      );
    }
  }

  // 3. 🔴 503 ONLY when NOT ONE book could be produced. A single surviving book
  //    (even one that is all gaps) is a 200 — the frontend can still show what
  //    it has and mark the rest unpriced.
  if (books.length === 0) {
    return NextResponse.json(
      apiError('pricing_unavailable', 'No price data is available right now. Please try again.'),
      { status: ERROR_STATUS.pricing_unavailable },
    );
  }

  // 4. Validate the response envelope before sending — the contract. (Each book
  //    was already parsed by priceBookSchema in the seam; this guards the shape
  //    of the outer { books } object.)
  const response = pricesResponseSchema.safeParse({ books });
  if (!response.success) {
    console.error('[api/cost/prices] response failed self-validation', response.error);
    return NextResponse.json(apiError('internal_error', 'Price data is unavailable.'), {
      status: ERROR_STATUS.internal_error,
    });
  }

  return NextResponse.json(response.data, { status: 200 });
}
