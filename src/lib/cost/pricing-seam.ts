/**
 * InfraGenie — the Feature 2 pricing seam.
 *
 * SERVER-ONLY. This module's implementations read `TAVILY_API_KEY` and
 * `ANTHROPIC_API_KEY`. It must NEVER be imported by a client component. The UI
 * consumes `/api/cost/*` and then runs the PURE engine locally for live totals.
 *
 * The architect owns this file (it is a contract). The backend owns the
 * implementations under `src/lib/cost/pricing/` and `src/lib/cost/llm/`.
 * Signatures and the error taxonomy do not change without an architect
 * sign-off comment on the board.
 *
 * ## Verified facts about the fetch layer (measured 2026-07-26, not assumed)
 *
 * `POST https://api.tavily.com/extract` with
 * `Authorization: Bearer $TAVILY_API_KEY` and body
 * `{"urls": [...], "extract_depth": "advanced"}` returns
 *
 *     { results: [{ url, title, raw_content, images }],
 *       failed_results: [...], response_time, request_id }
 *
 * `raw_content` is **markdown**, and crucially it preserves vendor pricing
 * TABLES as markdown pipe tables. Confirmed against real pages:
 *
 *   - digitalocean.com/pricing/droplets  → 21.6 KB, full `| Memory | vCPU | … | $/mo |` table
 *   - cloud.google.com/run/pricing       → 23.5 KB, per-vCPU-second rows
 *   - aws.amazon.com/rds/postgresql/pricing/ → 31 KB (prose-heavy; needs a
 *     surgical `extractionHint` to pin the right instance row)
 *   - vercel.com/docs/pricing            → 11 KB, plan + overage tables
 *
 * So the extraction problem is "pick the right row out of real markdown",
 * NOT "render a JS pricing widget". `extract_depth: 'advanced'` is the right
 * default; batch up to 5 URLs per call.
 */

import type {
  CloudProvider,
  CostContext,
  CostRecommendation,
  PriceBook,
  ServiceCatalog,
} from '@/types/cost';

/* -------------------------------------------------------------------------- */
/* Error taxonomy                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The only error type the pricing layer may throw. Routes map `code` onto the
 * HTTP envelope in `docs/api-contracts.md`.
 *
 * `cause` is for server logs ONLY — upstream bodies carry request ids.
 */
export type PricingErrorCode =
  | 'not_configured' // TAVILY_API_KEY (or ANTHROPIC_API_KEY) missing
  | 'unavailable' // upstream 429/5xx/timeout/network — retryable
  | 'invalid_output' // extractor output failed schema or the evidence gate
  | 'not_implemented'; // seam not yet filled in

export class PricingError extends Error {
  readonly code: PricingErrorCode;
  readonly provider?: CloudProvider;

  constructor(
    code: PricingErrorCode,
    message: string,
    options?: { provider?: CloudProvider; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'PricingError';
    this.code = code;
    this.provider = options?.provider;
  }
}

/* -------------------------------------------------------------------------- */
/* The fetch primitive                                                        */
/* -------------------------------------------------------------------------- */

/** One page as Tavily returned it. `markdown` is `results[].raw_content`. */
export interface FetchedPage {
  url: string;
  title: string;
  /** Markdown, tables preserved. This exact string is what the evidence gate
   *  checks `source.evidence` against — do not normalise it before storing. */
  markdown: string;
  /** ISO-8601, when the HTTP call returned. */
  fetchedAt: string;
}

/**
 * Fetch public pricing pages via Tavily `/extract`.
 *
 * Contract:
 *   - Batches ≤5 URLs per upstream call.
 *   - A URL in `failed_results` is OMITTED from the return value, never faked.
 *     Callers turn a missing page into `PriceGap{reason:'fetch_failed'}`.
 *   - Throws `not_configured` when `TAVILY_API_KEY` is absent, `unavailable` on
 *     429/5xx/network. Bounded retries only — never an unbounded loop.
 *
 * @throws {PricingError}
 */
export type FetchPricingPages = (
  urls: string[],
  options?: { signal?: AbortSignal },
) => Promise<FetchedPage[]>;

/* -------------------------------------------------------------------------- */
/* The evidence gate — the anti-fabrication invariant                         */
/* -------------------------------------------------------------------------- */

/**
 * Proves a claimed price is really on the page. PURE, no I/O, and the single
 * most important function in Feature 2.
 *
 * Returns `null` when the record is acceptable, or a human-readable rejection
 * reason. It MUST assert, at minimum:
 *
 *   1. `evidence` is a verbatim substring of `page.markdown` (whitespace may be
 *      collapsed on BOTH sides before comparing — nothing else).
 *   2. The numeric value of `unitPriceUsd` appears inside `evidence`, tolerating
 *      formatting only: `$`, thousands separators, and trailing zeros.
 *
 * A model cannot invent a number that survives (2) against real page text. Any
 * failure means the record is DISCARDED and recorded as
 * `PriceGap{reason:'evidence_rejected'}` — never repaired, never guessed.
 *
 * Backend: this must be unit-tested with a fabricated-price case that FAILS.
 * A test suite that only proves the happy path does not test this at all.
 */
export type AssertEvidenceSupportsPrice = (args: {
  page: FetchedPage;
  evidence: string;
  unitPriceUsd: number;
}) => string | null;

/* -------------------------------------------------------------------------- */
/* Price book assembly                                                        */
/* -------------------------------------------------------------------------- */

export interface BuildPriceBookOptions {
  /** Ignore the cache and refetch. Used by the live smoke test. */
  force?: boolean;
  /** Overrides the extractor model. */
  model?: string;
  signal?: AbortSignal;
}

/**
 * Produce (or read from cache) the price book for one provider.
 *
 * Implementation contract:
 *   1. Collect the distinct `pricingUrl`s across that provider's catalog
 *      services; fetch each once (a page usually prices several SKUs).
 *   2. For each SKU dimension, ask the extractor for a candidate price using
 *      `extractionHint`, then run the evidence gate.
 *   3. Survivors become `PriceRecord`s with full `source`; casualties become
 *      `PriceGap`s. NEVER substitute a default, an average, or a remembered
 *      number for a rejected record.
 *   4. Parse the result with `priceBookSchema` before returning.
 *
 * A partial book is a SUCCESS: four priced providers plus one gap is far more
 * useful than an error page.
 *
 * @throws {PricingError} only when nothing at all could be produced.
 */
export type BuildPriceBook = (
  provider: CloudProvider,
  options?: BuildPriceBookOptions,
) => Promise<PriceBook>;

/**
 * Cache contract for price books.
 *
 * v1 is a filesystem cache under `.cache/pricing/<provider>.json`, gitignored.
 * Rationale: prices move monthly (see `PRICE_MAX_AGE_DAYS`), the data is small
 * and non-secret, and a file survives dev-server restarts where an in-process
 * Map does not — which is what keeps the Tavily quota from being burned on
 * every hot reload. No database, nothing to provision, no cost-safety question.
 *
 * A book is a MISS when absent, older than `PRICE_MAX_AGE_DAYS`, or written by
 * a different `PRICING_PIPELINE_VERSION`. Reads validate with
 * `priceBookSchema` and treat a mismatch as a miss, so a schema change can
 * never crash the app on a stale file (same posture as Feature 1's store).
 */
export interface PriceBookCache {
  read(provider: CloudProvider): Promise<PriceBook | null>;
  write(book: PriceBook): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* AI recommendation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Recommend a provider + per-provider service selection from the PRD context.
 *
 * Implementation contract:
 *   1. `deriveUsageProfile(costContext)` FIRST, in TypeScript. The model never
 *      does the arithmetic — same split as Feature 1's Mermaid/graph derivation.
 *   2. One `callStructured` call (reuse `src/lib/prd/llm/client.ts`) against
 *      `costRecommendationDraftSchema`, given the catalog's ids for each role.
 *   3. Deterministically VERIFY every returned `serviceId`/`skuId` exists in the
 *      catalog and fills the role it claims. Invented ids are dropped and the
 *      role falls back to the catalog default — never trusted through.
 *   4. Fill any role required by the PRD that the model omitted; drop choices
 *      for roles the PRD does not need.
 *   5. Parse with `costRecommendationSchema` before returning.
 *
 * @throws {PricingError}
 */
export type RecommendDeployment = (
  costContext: CostContext,
  catalog: ServiceCatalog,
  options?: { model?: string; signal?: AbortSignal },
) => Promise<CostRecommendation>;

/* -------------------------------------------------------------------------- */
/* Default models                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Price extraction is high-volume, mechanical, and fully verified downstream by
 * the evidence gate — so the fast model is correct here, and a hallucination is
 * caught by a substring check rather than by trusting a bigger model.
 * Recommendation is a judgement call about someone's infrastructure, so it gets
 * the strong model. Override with `COST_EXTRACTOR_MODEL` /
 * `COST_RECOMMEND_MODEL`.
 */
export const DEFAULT_PRICE_EXTRACTOR_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_RECOMMEND_MODEL = 'claude-sonnet-5';
