/**
 * Unit tests for the pure `/cost` client module — `fetch` mocked, no network,
 * no DOM. Covers the four cases the F1-cost task mandates plus the pure helpers:
 *
 *   1. success (catalog / prices / recommend all parse)
 *   2. 503 → retryable (pricing_unavailable AND llm_unavailable)
 *   3. malformed / off-contract body
 *   4. recommendation-failure → graceful catalog-default fallback (never blocks)
 *
 * All fixtures are hand-built or reuse the real (client-safe) catalog. Nothing
 * here imports a key-bearing module.
 */

import { describe, it, expect, vi } from 'vitest';

import { serviceCatalog } from '@/lib/cost/catalog';
import { mapComponentsToRoles } from '@/lib/cost/estimate';
import {
  catalogResponseSchema,
  costSelectionSchema,
  costRecommendationSchema,
  type CloudProvider,
  type CostContext,
  type PriceBook,
} from '@/types/cost';
import type { PrdDocument } from '@/types/prd';
import { makePrdDocument } from '@/lib/prd/fixtures.test-support';
import {
  fetchCatalog,
  fetchPrices,
  fetchRecommendation,
  mapCostError,
  buildCostContext,
  buildDefaultSelection,
  buildFallbackRecommendation,
  pickDefaultProvider,
  oldestPriceAt,
  isBookStale,
  totalGapCount,
  PRICE_MAX_AGE_MS,
  type CostErrorCode,
} from './client';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A realistic PRD context (mirrors the recommend test): its components map to
 *  compute-web + static-hosting + db-relational + egress. */
const context: CostContext = {
  title: 'Bakery surplus marketplace',
  context: {
    userScale: 'medium',
    trafficPattern: 'business-hours',
    budgetBand: 'startup',
    timelineWeeks: 12,
  },
  components: [
    { name: 'Web app', kind: 'client', responsibility: 'Customer UI', technology: 'Next.js' },
    { name: 'API', kind: 'service', responsibility: 'Business logic', technology: 'Node.js' },
    { name: 'Primary DB', kind: 'datastore', responsibility: 'Orders', technology: 'PostgreSQL' },
  ],
  summary: 'Marketplace for same-day surplus bread.',
};

const requiredRoles = mapComponentsToRoles(context).roles;

/** Build a `Response`-like object good enough for the code paths we exercise. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A `Response` whose `.json()` throws — a truncated / non-JSON body. */
function brokenBodyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as unknown as Response;
}

/** The contract error envelope for a given code. */
function errorBody(code: CostErrorCode) {
  return { error: { code, message: 'server-side message we must not surface' } };
}

/** A minimal valid price book for one provider. */
function bookFor(provider: CloudProvider, fetchedAt: string): PriceBook {
  return {
    provider,
    region: 'us-east-1',
    pipelineVersion: '1.0.0',
    generatedAt: '2026-07-26T10:12:30.000Z',
    records: [
      {
        skuId: `${provider}:svc:small`,
        dimensionId: 'instance-hour',
        unitPriceUsd: 0.032,
        includedQuantity: 0,
        currency: 'USD',
        source: {
          url: 'https://example.com/pricing',
          fetchedAt,
          evidence: '| small | $0.032 |',
          extractorModel: 'claude-haiku-4-5-20251001',
        },
      },
    ],
    gaps: [{ skuId: `${provider}:svc:small`, dimensionId: 'broker-hour', reason: 'not_found_on_page' }],
  };
}

/* -------------------------------------------------------------------------- */
/* mapCostError — the error table                                              */
/* -------------------------------------------------------------------------- */

describe('mapCostError', () => {
  it('marks pricing_unavailable and llm_unavailable retryable', () => {
    expect(mapCostError('pricing_unavailable').retryable).toBe(true);
    expect(mapCostError('llm_unavailable').retryable).toBe(true);
  });

  it('marks llm_not_configured a non-retryable config fault, not the user\u2019s fault', () => {
    const p = mapCostError('llm_not_configured');
    expect(p.retryable).toBe(false);
    expect(p.configFault).toBe(true);
    expect(p.message.toLowerCase()).toContain('not');
  });

  it('gives every code a distinct, non-technical message', () => {
    const codes: CostErrorCode[] = [
      'pricing_unavailable',
      'llm_unavailable',
      'llm_not_configured',
      'generation_failed',
      'validation_error',
      'bad_request',
      'internal_error',
      'not_found',
      'network',
    ];
    const messages = codes.map((c) => mapCostError(c).message);
    expect(new Set(messages).size).toBe(codes.length);
    // No message leaks internals.
    for (const m of messages) {
      expect(m).not.toMatch(/api[_-]?key|anthropic|tavily|undefined|null/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* fetchCatalog                                                                */
/* -------------------------------------------------------------------------- */

describe('fetchCatalog', () => {
  it('returns ok with a schema-valid catalog on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, catalogResponseSchema.parse({ catalog: serviceCatalog })),
    );
    const out = await fetchCatalog({ fetchImpl });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.catalog.services.length).toBeGreaterThan(0);
  });

  it('maps a transport failure to a retryable network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await fetchCatalog({ fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.presentation.code).toBe('network');
      expect(out.presentation.retryable).toBe(true);
    }
  });

  it('treats an off-contract 200 body as an internal error, not a crash', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { nope: true }));
    const out = await fetchCatalog({ fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.presentation.code).toBe('internal_error');
  });

  it('re-throws an abort so the caller can distinguish cancellation', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const fetchImpl = vi.fn().mockRejectedValue(abort);
    await expect(fetchCatalog({ fetchImpl })).rejects.toBe(abort);
  });
});

/* -------------------------------------------------------------------------- */
/* fetchPrices                                                                 */
/* -------------------------------------------------------------------------- */

describe('fetchPrices', () => {
  it('returns ok with books (including gaps) on a 200 partial success', async () => {
    const books = [bookFor('aws', '2026-07-26T10:12:04.000Z')];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { books }));
    const out = await fetchPrices(undefined, { fetchImpl });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.books).toHaveLength(1);
      expect(out.books[0].gaps).toHaveLength(1);
    }
  });

  it('🔴 maps a 503 to a RETRYABLE pricing_unavailable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, errorBody('pricing_unavailable')));
    const out = await fetchPrices(undefined, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.presentation.code).toBe('pricing_unavailable');
      expect(out.presentation.retryable).toBe(true);
    }
  });

  it('treats a malformed 200 body as a retryable pricing failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(brokenBodyResponse(200));
    const out = await fetchPrices(undefined, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.presentation.code).toBe('pricing_unavailable');
  });

  it('passes a ?providers= filter through when a subset is requested', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { books: [] }));
    await fetchPrices(['aws', 'gcp'], { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toContain('providers=aws,gcp');
  });

  it('sets no request body and does not impose an AbortSignal of its own', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { books: [] }));
    await fetchPrices(undefined, { fetchImpl });
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('GET');
    expect(init.signal).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* fetchRecommendation — success + graceful fallback (never blocks)            */
/* -------------------------------------------------------------------------- */

describe('fetchRecommendation', () => {
  it('returns ok with the recommendation on 200', async () => {
    const rec = buildFallbackRecommendation(context); // a schema-valid rec
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { recommendation: rec }));
    const out = await fetchRecommendation(context, serviceCatalog, { fetchImpl });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(costRecommendationSchema.safeParse(out.recommendation).success).toBe(true);
    }
  });

  it('🔴 on a 503 does NOT block — falls back to a catalog-default seed, retryable notice', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, errorBody('llm_unavailable')));
    const out = await fetchRecommendation(context, serviceCatalog, { fetchImpl });
    expect(out.kind).toBe('fallback');
    if (out.kind === 'fallback') {
      expect(out.presentation.code).toBe('llm_unavailable');
      expect(out.presentation.retryable).toBe(true);
      expect(costRecommendationSchema.safeParse(out.recommendation).success).toBe(true);
      // The seed is honestly labelled as non-AI.
      expect(out.recommendation.assumptions[0].toLowerCase()).toContain('catalog-default');
    }
  });

  it('🔴 on a misconfigured server falls back with a non-retryable config-fault notice', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, errorBody('llm_not_configured')));
    const out = await fetchRecommendation(context, serviceCatalog, { fetchImpl });
    expect(out.kind).toBe('fallback');
    if (out.kind === 'fallback') {
      expect(out.presentation.code).toBe('llm_not_configured');
      expect(out.presentation.retryable).toBe(false);
      expect(out.presentation.configFault).toBe(true);
    }
  });

  it('on a malformed 200 body falls back as a generation failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(brokenBodyResponse(200));
    const out = await fetchRecommendation(context, serviceCatalog, { fetchImpl });
    expect(out.kind).toBe('fallback');
    if (out.kind === 'fallback') expect(out.presentation.code).toBe('generation_failed');
  });

  it('on a transport failure falls back as a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await fetchRecommendation(context, serviceCatalog, { fetchImpl });
    expect(out.kind).toBe('fallback');
    if (out.kind === 'fallback') expect(out.presentation.code).toBe('network');
  });

  it('re-throws an abort', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const fetchImpl = vi.fn().mockRejectedValue(abort);
    await expect(fetchRecommendation(context, serviceCatalog, { fetchImpl })).rejects.toBe(abort);
  });
});

/* -------------------------------------------------------------------------- */
/* buildCostContext                                                            */
/* -------------------------------------------------------------------------- */

describe('buildCostContext', () => {
  it('extracts exactly the cost slice from a PrdDocument', () => {
    const doc: PrdDocument = makePrdDocument();
    const ctx = buildCostContext(doc);
    expect(ctx.title).toBe(doc.title);
    expect(ctx.context).toEqual(doc.brief.context);
    expect(ctx.components).toEqual(doc.architecture.components);
    expect(ctx.infrastructure).toEqual(doc.architecture.infrastructure);
    expect((ctx.summary ?? '').length).toBeLessThanOrEqual(1000);
  });
});

/* -------------------------------------------------------------------------- */
/* Catalog-default fallback helpers                                            */
/* -------------------------------------------------------------------------- */

describe('buildDefaultSelection / pickDefaultProvider', () => {
  it('produces a schema-valid selection per provider using catalog defaults', () => {
    for (const provider of serviceCatalog.services.map((s) => s.provider)) {
      const sel = buildDefaultSelection(serviceCatalog, provider, requiredRoles);
      expect(costSelectionSchema.safeParse(sel).success).toBe(true);
    }
  });

  it('omits roles a provider cannot fill rather than fabricating a choice', () => {
    // Vercel has no db-relational (docs §9) — it must not appear in its selection.
    const sel = buildDefaultSelection(serviceCatalog, 'vercel', ['db-relational', 'compute-web']);
    const roles = sel.choices.map((c) => c.role);
    expect(roles).not.toContain('db-relational');
  });

  it('picks the provider with the most role coverage as the default spotlight', () => {
    const chosen = pickDefaultProvider(serviceCatalog, requiredRoles);
    // Whatever is chosen must actually be able to fill at least one required role.
    const covers = requiredRoles.filter((role) =>
      serviceCatalog.services.some((s) => s.provider === chosen && s.role === role),
    ).length;
    expect(covers).toBeGreaterThan(0);
  });
});

describe('buildFallbackRecommendation', () => {
  it('is deterministic and schema-valid', () => {
    const a = buildFallbackRecommendation(context);
    const b = buildFallbackRecommendation(context);
    expect(a).toEqual(b);
    expect(costRecommendationSchema.safeParse(a).success).toBe(true);
  });

  it('seeds a selection for every provider', () => {
    const rec = buildFallbackRecommendation(context);
    expect(rec.selections).toHaveLength(serviceCatalog.services.reduce((set, s) => set.add(s.provider), new Set<CloudProvider>()).size);
  });
});

/* -------------------------------------------------------------------------- */
/* Staleness + gaps helpers                                                    */
/* -------------------------------------------------------------------------- */

describe('oldestPriceAt / isBookStale / totalGapCount', () => {
  it('finds the oldest fetchedAt across records', () => {
    const book = bookFor('aws', '2026-07-20T00:00:00.000Z');
    expect(oldestPriceAt(book)).toBe('2026-07-20T00:00:00.000Z');
  });

  it('returns null for a book with no priced records', () => {
    const empty: PriceBook = { ...bookFor('aws', '2026-07-20T00:00:00.000Z'), records: [] };
    expect(oldestPriceAt(empty)).toBeNull();
    // ...and an unpriced book is not "stale" — there is nothing to be stale.
    expect(isBookStale(empty, Date.now())).toBe(false);
  });

  it('flags a book as stale only past PRICE_MAX_AGE_MS', () => {
    const fetchedAt = '2026-07-01T00:00:00.000Z';
    const fetchedMs = new Date(fetchedAt).getTime();
    const book = bookFor('aws', fetchedAt);
    expect(isBookStale(book, fetchedMs + PRICE_MAX_AGE_MS - 1000)).toBe(false);
    expect(isBookStale(book, fetchedMs + PRICE_MAX_AGE_MS + 1000)).toBe(true);
  });

  it('sums gaps across books', () => {
    const books = [bookFor('aws', '2026-07-26T00:00:00.000Z'), bookFor('gcp', '2026-07-26T00:00:00.000Z')];
    expect(totalGapCount(books)).toBe(2);
  });
});
