/**
 * InfraGenie — the Tavily `/extract` fetch layer for Feature 2's price book.
 *
 * SERVER-ONLY. This module reads `TAVILY_API_KEY` and must NEVER be imported by
 * a client component or reach anything that ships to the browser. It is the
 * ONLY place in Feature 2 that talks to Tavily. It implements
 * `FetchPricingPages` from `../pricing-seam`.
 *
 * VERIFIED wire format (measured 2026-07-26 — trusted, not re-probed):
 *
 *     POST https://api.tavily.com/extract
 *     Authorization: Bearer $TAVILY_API_KEY
 *     { "urls": [...≤5], "extract_depth": "advanced" }
 *   → { results: [{ url, title, raw_content }],
 *       failed_results: [{ url, error }], response_time, request_id }
 *
 * `raw_content` is markdown with vendor pricing TABLES preserved as pipe
 * tables. We map it to `FetchedPage.markdown` VERBATIM — no trim, no reflow, no
 * normalisation — because the evidence gate compares `source.evidence` against
 * this exact string. Touching it here would silently break the anti-fabrication
 * invariant downstream.
 *
 * Contract (see the seam):
 *   - Batches ≤5 URLs per upstream call; more than 5 URLs is split across calls.
 *   - A URL in `failed_results` (or simply absent from `results`) is OMITTED
 *     from the return value, NEVER faked. The caller turns absence into
 *     `PriceGap{reason:'fetch_failed'}`.
 *   - `fetchedAt` is ISO-8601 captured the moment the HTTP call returned.
 *   - Throws `PricingError('not_configured')` when `TAVILY_API_KEY` is absent;
 *     `PricingError('unavailable')` on 429/5xx/timeout/network.
 *   - Bounded retries only (mirrors `src/lib/prd/llm/client.ts`): at most 2
 *     retries, exponential backoff, honouring `retry-after`. No unbounded loop.
 *   - Never logs or returns the key, or a raw upstream body, to a client.
 */

import { PricingError, type FetchPricingPages, type FetchedPage } from '../pricing-seam';

const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';

/** Tavily's documented cap per `/extract` call, and our batch size. */
const MAX_URLS_PER_CALL = 5;

/** Only `unavailable` is retried, and only this many times. Hard cap — no loop. */
const MAX_RETRIES = 2;
/** Base backoff in ms; attempt N (0-indexed) waits BASE * 2**N → ~1s, ~2s. */
const BACKOFF_BASE_MS = 1000;
/** A hostile `retry-after` is clamped so it can't hang the request. */
const MAX_RETRY_AFTER_MS = 10_000;

/** The subset of the Tavily response we read. Extra fields are ignored. */
interface TavilyExtractResponse {
  results?: Array<{ url?: string; title?: string; raw_content?: string }>;
  failed_results?: Array<{ url?: string; error?: string }>;
  response_time?: number;
  request_id?: string;
}

const isAbortError = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Parse a `retry-after` header (seconds or an HTTP-date). Returns a clamped
 * delay in ms, or null if unparseable.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(asSeconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(asDate - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return null;
}

/** Split a list into chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * A retryable failure carrying an optional suggested backoff. Kept internal so
 * the public surface only ever throws `PricingError`.
 */
class RetryableUpstream extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null, cause?: unknown) {
    super(message, { cause });
    this.name = 'RetryableUpstream';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * One HTTP attempt for a single batch (≤5 URLs). Returns the parsed body and
 * the ISO timestamp captured when the response returned. Throws
 * `RetryableUpstream` on a transient fault (retried by the caller) and
 * `PricingError` on a terminal one (not retried).
 */
async function attemptBatch(
  apiKey: string,
  urls: string[],
  signal?: AbortSignal,
): Promise<{ body: TavilyExtractResponse; fetchedAt: string }> {
  let res: Response;
  try {
    res = await fetch(TAVILY_EXTRACT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ urls, extract_depth: 'advanced' }),
      signal,
    });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      // Caller cancelled — surface as unavailable, but do NOT retry.
      throw new PricingError('unavailable', 'Tavily request was aborted.', { cause: err });
    }
    // Network/DNS/connection error — retryable.
    throw new RetryableUpstream('Network error contacting Tavily.', null, err);
  }

  // Capture the timestamp the moment the HTTP call returned, per the contract.
  const fetchedAt = new Date().toISOString();

  if (!res.ok) {
    // Drain the body for server logs only; NEVER return it to a client — it can
    // carry request ids and is not ours to expose.
    const errText = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new PricingError('not_configured', `Tavily rejected the API key (HTTP ${res.status}).`, {
        cause: errText || undefined,
      });
    }
    if (res.status === 429 || res.status >= 500) {
      throw new RetryableUpstream(
        `Tavily returned HTTP ${res.status}.`,
        parseRetryAfter(res.headers.get('retry-after')),
        errText || undefined,
      );
    }
    // Any other 4xx is a bug in our request, not a transient fault. Surface it
    // as unavailable (the caller degrades to gaps) but do not retry.
    throw new PricingError('unavailable', `Tavily returned an unexpected HTTP ${res.status}.`, {
      cause: errText || undefined,
    });
  }

  let body: TavilyExtractResponse;
  try {
    body = (await res.json()) as TavilyExtractResponse;
  } catch (err) {
    // A 200 with an unreadable body is treated as transient.
    throw new RetryableUpstream('Could not parse the Tavily response body.', null, err);
  }

  return { body, fetchedAt };
}

/**
 * Run one batch with bounded retries. Returns the successful pages for that
 * batch. On terminal failure it throws `PricingError`; failed_results are
 * simply omitted from the returned array (never faked).
 */
async function fetchBatch(
  apiKey: string,
  urls: string[],
  signal?: AbortSignal,
): Promise<FetchedPage[]> {
  let lastError: unknown;
  // attempt 0 = first try; attempts 1..MAX_RETRIES = retries. Hard-bounded loop.
  for (let attemptNo = 0; attemptNo <= MAX_RETRIES; attemptNo++) {
    if (signal?.aborted) {
      throw new PricingError('unavailable', 'Tavily request was aborted before sending.');
    }

    try {
      const { body, fetchedAt } = await attemptBatch(apiKey, urls, signal);

      // A failed_result URL is OMITTED — we never invent a page for it. Log the
      // fact for observability (URL + error only, never the key or full body).
      if (body.failed_results && body.failed_results.length > 0) {
        for (const fr of body.failed_results) {
          console.info('[cost.tavily] extract failed url=%s error=%s', fr.url ?? '?', fr.error ?? '?');
        }
      }

      const pages: FetchedPage[] = [];
      for (const r of body.results ?? []) {
        // A result missing its url or content is unusable — omit it too rather
        // than fabricate an empty page the evidence gate would just reject.
        if (typeof r.url !== 'string' || typeof r.raw_content !== 'string') continue;
        pages.push({
          url: r.url,
          title: typeof r.title === 'string' ? r.title : '',
          // VERBATIM — the evidence gate compares against this exact string.
          markdown: r.raw_content,
          fetchedAt,
        });
      }
      return pages;
    } catch (err) {
      const retryable = err instanceof RetryableUpstream && !signal?.aborted;
      if (!retryable || attemptNo === MAX_RETRIES) {
        if (err instanceof RetryableUpstream) {
          // Exhausted retries on a transient fault → surface as unavailable.
          throw new PricingError('unavailable', err.message, { cause: err.cause });
        }
        throw err; // already a PricingError (terminal)
      }

      lastError = err;
      const suggested = err.retryAfterMs;
      const backoff =
        typeof suggested === 'number' && suggested >= 0
          ? suggested
          : BACKOFF_BASE_MS * 2 ** attemptNo;

      console.info(
        '[cost.tavily] retrying attempt=%d after_ms=%d reason=unavailable',
        attemptNo + 1,
        backoff,
      );

      try {
        await sleep(backoff, signal);
      } catch {
        throw new PricingError('unavailable', 'Tavily request was aborted during backoff.', {
          cause: lastError,
        });
      }
    }
  }

  // Unreachable — the loop either returns or throws. Kept for exhaustiveness.
  throw new PricingError('unavailable', 'Tavily call failed after retries.', { cause: lastError });
}

/**
 * Fetch public pricing pages via Tavily `/extract`.
 *
 * @throws {PricingError} `not_configured` (no key) or `unavailable` (upstream).
 */
export const fetchPricingPages: FetchPricingPages = async (urls, options) => {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new PricingError('not_configured', 'TAVILY_API_KEY is not set in the server environment.');
  }

  // De-duplicate while preserving order — a caller may pass the same page for
  // several SKUs, and there is no point paying to fetch it twice.
  const unique = Array.from(new Set(urls.filter((u) => typeof u === 'string' && u.length > 0)));
  if (unique.length === 0) return [];

  const batches = chunk(unique, MAX_URLS_PER_CALL);
  const pages: FetchedPage[] = [];
  for (const batch of batches) {
    const batchPages = await fetchBatch(apiKey, batch, options?.signal);
    pages.push(...batchPages);
  }
  return pages;
};

export default fetchPricingPages;
