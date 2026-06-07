/**
 * Tests for GET /api/cost/prices.
 *
 * OFFLINE and FREE: the pricing seam (`buildPriceBook`) is mocked, so no Tavily
 * fetch or Anthropic call happens and the suite bills nothing. We cover the full
 * contract from docs/api-contracts.md §GET /api/cost/prices:
 *   - 200 with `?providers=aws` returns just that book
 *   - 400 validation_error on `?providers=nope`
 *   - 🔴 200 WITH GAPS when one provider fails but another succeeds (partial
 *     success is a success)
 *   - 🔴 503 pricing_unavailable only when EVERY provider fails
 *   - every 200 body parses against `pricesResponseSchema`
 *   - 🔴 no response body ever contains either API key (careless-passthrough
 *     guard)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  pricesResponseSchema,
  PRICING_PIPELINE_VERSION,
  PRICED_REGION,
  type CloudProvider,
  type PriceBook,
} from '@/types/cost';

// Mock the seam before importing the route so the route picks up the mock. The
// route contains no pricing logic; this isolates the handler.
vi.mock('@/lib/cost/pricing/build', () => ({
  buildPriceBook: vi.fn(),
}));

import { buildPriceBook } from '@/lib/cost/pricing/build';
import { PricingError } from '@/lib/cost/pricing-seam';
import { GET } from './route';

const mockBuild = vi.mocked(buildPriceBook);

const FAKE_TAVILY_KEY = 'tvly-SECRETKEY1234567890';
const FAKE_ANTHROPIC_KEY = 'sk-ant-SECRETKEY1234567890';

/** A minimal, schema-valid price book for a provider (one cited record). */
function fakeBook(provider: CloudProvider): PriceBook {
  return {
    provider,
    region: PRICED_REGION[provider],
    pipelineVersion: PRICING_PIPELINE_VERSION,
    generatedAt: '2026-07-26T10:00:00.000Z',
    records: [
      {
        skuId: `${provider}:svc:small`,
        dimensionId: 'instance-hour',
        unitPriceUsd: 0.032,
        includedQuantity: 0,
        currency: 'USD',
        source: {
          url: 'https://example.com/pricing',
          fetchedAt: '2026-07-26T09:59:00.000Z',
          evidence: '| small | $0.032 |',
          extractorModel: 'claude-haiku-4-5-20251001',
        },
      },
    ],
    gaps: [],
  };
}

/** A schema-valid book that is all gaps (a legitimate partial result). */
function gappyBook(provider: CloudProvider): PriceBook {
  return {
    provider,
    region: PRICED_REGION[provider],
    pipelineVersion: PRICING_PIPELINE_VERSION,
    generatedAt: '2026-07-26T10:00:00.000Z',
    records: [],
    gaps: [{ skuId: `${provider}:svc:small`, dimensionId: 'instance-hour', reason: 'not_found_on_page' }],
  };
}

function request(query = ''): Request {
  return new Request(`http://localhost/api/cost/prices${query}`);
}

beforeEach(() => {
  mockBuild.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/cost/prices', () => {
  it('returns 200 with just the requested provider on ?providers=aws', async () => {
    mockBuild.mockImplementation(async (provider) => fakeBook(provider));

    const res = await GET(request('?providers=aws'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(pricesResponseSchema.safeParse(body).success).toBe(true);
    expect(body.books).toHaveLength(1);
    expect(body.books[0].provider).toBe('aws');

    // Delegated once, for aws only (no business logic in the route).
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(mockBuild.mock.calls[0][0]).toBe('aws');
  });

  it('defaults to all five providers when ?providers= is omitted', async () => {
    mockBuild.mockImplementation(async (provider) => fakeBook(provider));

    const res = await GET(request());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(pricesResponseSchema.safeParse(body).success).toBe(true);
    expect(body.books).toHaveLength(5);
    expect(mockBuild).toHaveBeenCalledTimes(5);
  });

  it('returns 400 validation_error on an unknown provider (?providers=nope)', async () => {
    const res = await GET(request('?providers=nope'));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.issues)).toBe(true);
    // Never even attempted a build for an invalid query.
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('returns 400 when one of several providers is unknown', async () => {
    const res = await GET(request('?providers=aws,nope'));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('🔴 returns 200 WITH GAPS when one provider fails but another succeeds', async () => {
    // aws succeeds, gcp throws. The contract says a partial result is a 200.
    mockBuild.mockImplementation(async (provider) => {
      if (provider === 'gcp') {
        throw new PricingError('unavailable', 'tavily 429 request_id=xyz', { provider });
      }
      return fakeBook(provider);
    });

    const res = await GET(request('?providers=aws,gcp'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(pricesResponseSchema.safeParse(body).success).toBe(true);
    // Only the surviving book comes back — the failed provider is simply absent.
    expect(body.books.map((b: PriceBook) => b.provider)).toEqual(['aws']);
  });

  it('🔴 treats an all-gaps book as a valid 200 (a gap is not a failure)', async () => {
    mockBuild.mockImplementation(async (provider) => gappyBook(provider));

    const res = await GET(request('?providers=aws'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(pricesResponseSchema.safeParse(body).success).toBe(true);
    expect(body.books[0].records).toHaveLength(0);
    expect(body.books[0].gaps.length).toBeGreaterThan(0);
  });

  it('🔴 returns 503 pricing_unavailable ONLY when every provider fails', async () => {
    mockBuild.mockRejectedValue(new PricingError('unavailable', 'everything down', {}));

    const res = await GET(request('?providers=aws,gcp'));
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.error.code).toBe('pricing_unavailable');
  });

  it('🔴 never leaks either API key, even when the seam error carries one', async () => {
    // A careless error passthrough would surface the key. The route must not.
    mockBuild.mockRejectedValue(
      new PricingError(
        'unavailable',
        `upstream rejected TAVILY_API_KEY=${FAKE_TAVILY_KEY} ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}`,
        {},
      ),
    );

    const res = await GET(request('?providers=aws'));
    expect(res.status).toBe(503);

    const raw = await res.text();
    expect(raw).not.toContain(FAKE_TAVILY_KEY);
    expect(raw).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(raw).not.toContain('TAVILY_API_KEY');
    expect(raw).not.toContain('ANTHROPIC_API_KEY');
  });
});
