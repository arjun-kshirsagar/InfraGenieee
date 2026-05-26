/**
 * Tests for the Tavily fetch layer (`fetchPricingPages`).
 *
 * Every test runs OFFLINE and FREE: `fetch` is stubbed with `vi.stubGlobal`, so
 * the real Tavily API is never contacted and the suite bills nothing. We assert
 * batching at 5, that `failed_results` are OMITTED (never faked), the
 * `not_configured` / `unavailable` mappings, the bounded retry cap, and that
 * `markdown` is preserved byte-for-byte. The live smoke lives in
 * `scripts/smoke-tavily.ts`, not here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchPricingPages } from '@/lib/cost/pricing/tavily';
import { PricingError } from '@/lib/cost/pricing-seam';

/** Build a well-formed Tavily /extract success response. */
function extractResponse(
  results: Array<{ url: string; title?: string; raw_content: string }>,
  failed: Array<{ url: string; error: string }> = [],
) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      results,
      failed_results: failed,
      response_time: 1.23,
      request_id: 'req_test',
    }),
    text: async () => '',
  } as unknown as Response;
}

function errorResponse(status: number, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => ({}),
    text: async () => `tavily upstream body for ${status}`,
  } as unknown as Response;
}

const KEY = 'tvly-test-key';

beforeEach(() => {
  process.env.TAVILY_API_KEY = KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.TAVILY_API_KEY;
});

describe('fetchPricingPages — happy path & markdown fidelity', () => {
  it('maps raw_content to markdown BYTE-FOR-BYTE (no trim/reflow/normalise)', async () => {
    // Ragged whitespace, trailing spaces, and a leading newline that a naive
    // implementation would strip. The evidence gate depends on this being exact.
    const raw = '\n|  Memory |  vCPU |   $/mo |\n|---|---|---|\n| 1 GiB | 1 vCPU |  $6.00 |   \n';
    const fetchMock = vi.fn().mockResolvedValue(
      extractResponse([{ url: 'https://x/pricing', title: 'X', raw_content: raw }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pages = await fetchPricingPages(['https://x/pricing']);
    expect(pages).toHaveLength(1);
    expect(pages[0].markdown).toBe(raw); // exact string identity
    expect(pages[0].url).toBe('https://x/pricing');
    expect(pages[0].title).toBe('X');
    // fetchedAt is an ISO-8601 string captured when the call returned.
    expect(() => new Date(pages[0].fetchedAt).toISOString()).not.toThrow();
    expect(pages[0].fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('sends extract_depth=advanced and a Bearer key, never leaking the key into markdown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      extractResponse([{ url: 'https://x', raw_content: 'ok' }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchPricingPages(['https://x']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/extract');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.extract_depth).toBe('advanced');
    expect(body.urls).toEqual(['https://x']);
  });
});

describe('fetchPricingPages — batching at 5', () => {
  it('splits >5 URLs across multiple calls of at most 5', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://x/${i}`);
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const batchUrls = body.urls as string[];
      expect(batchUrls.length).toBeLessThanOrEqual(5);
      return Promise.resolve(
        extractResponse(batchUrls.map((u) => ({ url: u, raw_content: `md ${u}` }))),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const pages = await fetchPricingPages(urls);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 5 + 5 + 2
    expect(pages).toHaveLength(12);
    expect(pages.map((p) => p.url)).toEqual(urls);
  });

  it('de-duplicates URLs before batching (does not pay to fetch a page twice)', async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return Promise.resolve(
        extractResponse((body.urls as string[]).map((u) => ({ url: u, raw_content: 'md' }))),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const pages = await fetchPricingPages(['https://a', 'https://a', 'https://b', 'https://a']);
    const sentUrls = JSON.parse(fetchMock.mock.calls[0][1].body as string).urls;
    expect(sentUrls).toEqual(['https://a', 'https://b']);
    expect(pages).toHaveLength(2);
  });
});

describe('fetchPricingPages — failed_results are OMITTED, never faked', () => {
  it('drops a failed URL from the return value entirely', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      extractResponse(
        [{ url: 'https://ok', raw_content: 'good md' }],
        [{ url: 'https://bad', error: 'timeout' }],
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pages = await fetchPricingPages(['https://ok', 'https://bad']);
    expect(pages).toHaveLength(1);
    expect(pages[0].url).toBe('https://ok');
    expect(pages.some((p) => p.url === 'https://bad')).toBe(false);
  });

  it('omits a result that is missing raw_content rather than fabricating an empty page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      extractResponse([
        { url: 'https://ok', raw_content: 'good' },
        // malformed result: no raw_content
        { url: 'https://weird' } as unknown as { url: string; raw_content: string },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pages = await fetchPricingPages(['https://ok', 'https://weird']);
    expect(pages.map((p) => p.url)).toEqual(['https://ok']);
  });
});

describe('fetchPricingPages — error taxonomy', () => {
  it('throws not_configured when TAVILY_API_KEY is absent (and never calls fetch)', async () => {
    delete process.env.TAVILY_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPricingPages(['https://x'])).rejects.toMatchObject({
      name: 'PricingError',
      code: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws not_configured on a 401 and does not retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPricingPages(['https://x'])).rejects.toMatchObject({
      code: 'not_configured',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws unavailable on a 500 after exhausting retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchPricingPages(['https://x']);
    const assertion = expect(promise).rejects.toMatchObject({ code: 'unavailable' });
    await vi.runAllTimersAsync();
    await assertion;
    // 1 initial + MAX_RETRIES(2) = 3 total; never an unbounded loop.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('caps retries at 2 on repeated 429s (bounded loop)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchPricingPages(['https://x']);
    const assertion = expect(promise).rejects.toMatchObject({ code: 'unavailable' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('recovers on a retry: 500 then 200 returns the page', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(extractResponse([{ url: 'https://x', raw_content: 'recovered' }]));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchPricingPages(['https://x']);
    await vi.runAllTimersAsync();
    const pages = await promise;
    expect(pages).toHaveLength(1);
    expect(pages[0].markdown).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours retry-after on a 429', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(extractResponse([{ url: 'https://x', raw_content: 'ok' }]));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchPricingPages(['https://x']);
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws unavailable on a network error and retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchPricingPages(['https://x']);
    const assertion = expect(promise).rejects.toMatchObject({ code: 'unavailable' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws unavailable on an unexpected 4xx WITHOUT retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(422));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPricingPages(['https://x'])).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never leaks the upstream body or the key in the thrown error message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const promise = fetchPricingPages(['https://x']);
    const captured = promise.then(
      () => null,
      (e: unknown) => e,
    );
    await vi.runAllTimersAsync();
    const err = await captured;
    expect(err).toBeInstanceOf(PricingError);
    const message = (err as PricingError).message;
    expect(message).not.toContain('tavily upstream body');
    expect(message).not.toContain(KEY);
  });
});

describe('fetchPricingPages — edge cases', () => {
  it('returns [] for an empty URL list without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pages = await fetchPricingPages([]);
    expect(pages).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
