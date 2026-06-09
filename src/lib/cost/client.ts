/**
 * InfraGenie — pure, DOM-free client logic for Feature 2 (the `/cost` route).
 *
 * This module owns everything about the cost explorer's data loading that is
 * *logic* rather than *rendering*, the way `src/lib/prd/generate-flow.ts`
 * separates the generate-submit logic from its JSX:
 *
 *   - calling `GET /api/cost/catalog`, `GET /api/cost/prices` and
 *     `POST /api/cost/recommend`, each with NO short client timeout (a cold
 *     price cache means real vendor fetches — Feature 1 learned the hard way
 *     that a 30s client timeout aborts a healthy call),
 *   - classifying every result into a discriminated outcome,
 *   - mapping each contract error `code` to a distinct, honest, non-technical
 *     message + a retryability flag (the F1-cost error table),
 *   - the recommendation-failure **fallback**: a failed recommendation must not
 *     block the page, so we synthesise catalog-default selections and let the
 *     user pick manually — a cost explorer with no AI seed is still useful,
 *   - the honest-caveat helpers the UI is required to surface: the priced
 *     region per provider, a staleness affordance keyed off `PRICE_MAX_AGE_DAYS`,
 *     and the `PriceBook.gaps` (unpriced ≠ free — never render `$0.00`).
 *
 * ## Why this is a separate, pure module
 *
 * 1. The vitest `node` environment can test the branching offline with a mocked
 *    `fetch`, no DOM and no network — exactly the four cases the task requires.
 * 2. 🔴 **No key ever reaches the browser.** This module imports ONLY from
 *    `@/types/cost` and the *pure, client-safe* layers `@/lib/cost/catalog`
 *    (structure, no prices) and `@/lib/cost/estimate` (`mapComponentsToRoles` /
 *    `deriveUsageProfile`). It does NOT import `src/lib/cost/pricing/**`,
 *    `pricing-seam.ts`, or `src/lib/prd/llm/**`, all of which read
 *    `TAVILY_API_KEY` / `ANTHROPIC_API_KEY`. The UI talks to the server only
 *    through the three `/api/cost/*` endpoints.
 */

import {
  catalogResponseSchema,
  pricesResponseSchema,
  recommendResponseSchema,
  costRecommendationSchema,
  usageProfileSchema,
  CLOUD_PROVIDERS,
  INFRA_ROLE_ORDER,
  PRICE_MAX_AGE_DAYS,
  PRICED_REGION,
  type CloudProvider,
  type CostContext,
  type CostRecommendation,
  type CostSelection,
  type InfraRole,
  type PriceBook,
  type RoleChoice,
  type ServiceCatalog,
  type CatalogService,
} from '@/types/cost';
import type { PrdDocument } from '@/types/prd';
import { apiErrorSchema } from '@/types/prd';
import { serviceCatalog } from '@/lib/cost/catalog';
import { mapComponentsToRoles, deriveUsageProfile } from '@/lib/cost/estimate';

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

export const CATALOG_ENDPOINT = '/api/cost/catalog';
export const PRICES_ENDPOINT = '/api/cost/prices';
export const RECOMMEND_ENDPOINT = '/api/cost/recommend';

/* -------------------------------------------------------------------------- */
/* Error-code → message + retryability (the cost error table)                 */
/* -------------------------------------------------------------------------- */

/** The contract error codes the cost endpoints can return, plus a transport
 *  `'network'` pseudo-code for a request that never completed. */
export type CostErrorCode =
  | 'pricing_unavailable'
  | 'llm_unavailable'
  | 'llm_not_configured'
  | 'generation_failed'
  | 'validation_error'
  | 'bad_request'
  | 'internal_error'
  | 'not_found'
  | 'network';

/**
 * How a failed cost call should be presented. `retryable` drives whether the
 * UI offers a one-click Retry. `configFault` marks a server misconfiguration
 * that is explicitly *not the user's fault* (`llm_not_configured`) so the copy
 * can say so rather than blaming the user or inviting a pointless retry.
 */
export interface CostErrorPresentation {
  code: CostErrorCode;
  /** Honest, user-facing message. Never contains upstream/LLM/key text. */
  message: string;
  retryable: boolean;
  configFault: boolean;
}

/**
 * Map a contract error `code` (or transport `'network'`) to a distinct message
 * + retryability. Unit-tested exhaustively.
 *
 * | code                | retry | configFault | gist                                 |
 * |---------------------|-------|-------------|--------------------------------------|
 * | pricing_unavailable |  yes  |   no        | live prices couldn't be fetched      |
 * | llm_unavailable     |  yes  |   no        | AI recommender busy — try again      |
 * | llm_not_configured  |  no   |   yes       | server not configured — not you      |
 * | generation_failed   |  yes  |   no        | AI didn't produce a usable seed      |
 * | validation_error    |  no   |   no        | the PRD we sent didn't fit           |
 * | bad_request         |  no   |   no        | malformed request (shouldn't happen) |
 * | internal_error      |  yes  |   no        | unexpected — retry is reasonable     |
 * | not_found           |  yes  |   no        | endpoint unreachable — retry         |
 * | network             |  yes  |   no        | request never completed — try again  |
 */
export function mapCostError(code: CostErrorCode): CostErrorPresentation {
  switch (code) {
    case 'pricing_unavailable':
      return {
        code,
        message:
          "We couldn't fetch live prices from the cloud providers just now. This is usually " +
          'temporary — try again in a moment.',
        retryable: true,
        configFault: false,
      };
    case 'llm_unavailable':
      return {
        code,
        message:
          'The AI recommender is busy right now. You can retry, or skip it and pick services ' +
          'yourself — the cost explorer works either way.',
        retryable: true,
        configFault: false,
      };
    case 'llm_not_configured':
      return {
        code,
        message:
          "The AI recommender isn't configured on this server. That's a setup problem on our " +
          "end, not something you did — you can still explore costs by choosing services " +
          'manually.',
        retryable: false,
        configFault: true,
      };
    case 'generation_failed':
      return {
        code,
        message:
          "The AI didn't produce a usable recommendation. You can retry, or start from the " +
          'defaults and adjust from there.',
        retryable: true,
        configFault: false,
      };
    case 'validation_error':
      return {
        code,
        message:
          "This PRD didn't have enough architecture detail for a cost recommendation. You can " +
          'still explore costs by picking services manually.',
        retryable: false,
        configFault: false,
      };
    case 'bad_request':
      return {
        code,
        message:
          'Something about the request was malformed. Start from the defaults and pick services ' +
          'manually.',
        retryable: false,
        configFault: false,
      };
    case 'internal_error':
      return {
        code,
        message: 'Something went wrong on our end. Please try again in a moment.',
        retryable: true,
        configFault: false,
      };
    case 'not_found':
      return {
        code,
        message: 'The cost service could not be reached. Please try again.',
        retryable: true,
        configFault: false,
      };
    case 'network':
    default:
      return {
        code: 'network',
        message:
          "The request didn't complete — this is usually a connection hiccup. Please try again.",
        retryable: true,
        configFault: false,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Shared fetch plumbing                                                      */
/* -------------------------------------------------------------------------- */

export interface FetchOptions {
  /** Forwarded to `fetch`. The ONLY way a call is cancelled — we impose no
   *  timeout of our own (a cold price cache legitimately takes many seconds). */
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Was this thrown value an abort (caller cancelled / navigated away)? */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

/** Best-effort mapping from an HTTP status to a cost error code, used only when
 *  the error body is missing or off-contract. */
function statusToCode(status: number): CostErrorCode {
  if (status === 503) return 'pricing_unavailable';
  if (status === 400) return 'validation_error';
  if (status === 404) return 'not_found';
  if (status === 500) return 'internal_error';
  return 'internal_error';
}

/**
 * Read a non-2xx response and turn it into a `CostErrorCode`. Prefers the
 * contract error envelope (so we get the exact code); falls back to the HTTP
 * status if the body is missing or off-contract.
 */
async function classifyErrorResponse(response: Response): Promise<CostErrorCode> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) return parsed.data.error.code as CostErrorCode;
  return statusToCode(response.status);
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

export type CatalogOutcome =
  | { kind: 'ok'; catalog: ServiceCatalog }
  | { kind: 'error'; presentation: CostErrorPresentation };

/**
 * `GET /api/cost/catalog`. Deterministic and cannot 503; still classified so a
 * transport failure surfaces a retryable message rather than a crash. Rejects
 * only on abort.
 */
export async function fetchCatalog(options: FetchOptions = {}): Promise<CatalogOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(CATALOG_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    return { kind: 'error', presentation: mapCostError('network') };
  }

  if (!response.ok) {
    return { kind: 'error', presentation: mapCostError(await classifyErrorResponse(response)) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'error', presentation: mapCostError('internal_error') };
  }

  const parsed = catalogResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: 'error', presentation: mapCostError('internal_error') };
  }
  return { kind: 'ok', catalog: parsed.data.catalog };
}

/* -------------------------------------------------------------------------- */
/* Prices                                                                     */
/* -------------------------------------------------------------------------- */

export type PricesOutcome =
  | { kind: 'ok'; books: PriceBook[] }
  | { kind: 'error'; presentation: CostErrorPresentation };

/**
 * `GET /api/cost/prices`. 🔴 Can be **slow on a cold cache** (real vendor
 * fetches) — we pass the caller's signal straight through and set NO timeout of
 * our own. A partial book is a 200 (with `gaps[]`); `pricing_unavailable` (503)
 * is only the total failure and is retryable. Rejects only on abort.
 *
 * @param providers optional subset — omit for all five.
 */
export async function fetchPrices(
  providers?: readonly CloudProvider[],
  options: FetchOptions = {},
): Promise<PricesOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url =
    providers && providers.length > 0
      ? `${PRICES_ENDPOINT}?providers=${providers.join(',')}`
      : PRICES_ENDPOINT;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    return { kind: 'error', presentation: mapCostError('network') };
  }

  if (!response.ok) {
    return { kind: 'error', presentation: mapCostError(await classifyErrorResponse(response)) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'error', presentation: mapCostError('pricing_unavailable') };
  }

  const parsed = pricesResponseSchema.safeParse(body);
  if (!parsed.success) {
    // A 200 that doesn't satisfy the contract is treated as a retryable pricing
    // failure rather than a crash.
    return { kind: 'error', presentation: mapCostError('pricing_unavailable') };
  }
  return { kind: 'ok', books: parsed.data.books };
}

/* -------------------------------------------------------------------------- */
/* Recommendation (with graceful fallback)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the minimum PRD slice the recommender needs (`costContextSchema`) from
 * a loaded `PrdDocument`. Pure — no I/O. The user stories and plan are
 * irrelevant to cost and are deliberately not sent.
 */
export function buildCostContext(doc: PrdDocument): CostContext {
  return {
    title: doc.title,
    context: doc.brief.context,
    components: doc.architecture.components,
    infrastructure: doc.architecture.infrastructure,
    summary: doc.prd.overview.solution.slice(0, 1000),
  };
}

/**
 * The recommendation outcome. There is NO bare `error` variant that blocks the
 * page: a failed recommendation degrades to `fallback`, which carries the
 * catalog-default seed the UI mounts instead. The `presentation` is still
 * carried so the UI can show a dismissible "we couldn't get an AI seed" notice
 * with an optional Retry.
 */
export type RecommendOutcome =
  | { kind: 'ok'; recommendation: CostRecommendation }
  | {
      kind: 'fallback';
      recommendation: CostRecommendation;
      presentation: CostErrorPresentation;
    };

/**
 * `POST /api/cost/recommend`. One Anthropic call, 5–15s; no client timeout.
 *
 * 🔴 **Never blocks the page.** On ANY failure (network, 503, misconfig, bad
 * output) we resolve to `{ kind: 'fallback' }` carrying a deterministic
 * catalog-default recommendation built by `buildFallbackRecommendation`, so the
 * explorer always has something to mount. Rejects only on abort.
 */
export async function fetchRecommendation(
  costContext: CostContext,
  catalog: ServiceCatalog = serviceCatalog,
  options: FetchOptions = {},
): Promise<RecommendOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const asFallback = (code: CostErrorCode): RecommendOutcome => ({
    kind: 'fallback',
    recommendation: buildFallbackRecommendation(costContext, catalog),
    presentation: mapCostError(code),
  });

  let response: Response;
  try {
    response = await fetchImpl(RECOMMEND_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ costContext }),
      signal: options.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    return asFallback('network');
  }

  if (!response.ok) {
    return asFallback(await classifyErrorResponse(response));
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return asFallback('generation_failed');
  }

  const parsed = recommendResponseSchema.safeParse(body);
  if (!parsed.success) {
    return asFallback('generation_failed');
  }
  return { kind: 'ok', recommendation: parsed.data.recommendation };
}

/* -------------------------------------------------------------------------- */
/* Catalog-default fallback                                                   */
/* -------------------------------------------------------------------------- */

/** Services a provider offers for a role, in catalog order (first = default). */
function servicesForProviderRole(
  catalog: ServiceCatalog,
  provider: CloudProvider,
  role: InfraRole,
): CatalogService[] {
  return catalog.services.filter((s) => s.provider === provider && s.role === role);
}

/**
 * A default `RoleChoice` for one (provider, role): the first catalog service
 * and its first SKU, at that SKU's `defaultUnits`. Returns `null` when the
 * provider genuinely cannot fill the role — that is an honest gap, not a
 * fabricated choice (the engine surfaces it as `unsupportedRoles`).
 */
function defaultChoice(
  catalog: ServiceCatalog,
  provider: CloudProvider,
  role: InfraRole,
): RoleChoice | null {
  const service = servicesForProviderRole(catalog, provider, role)[0];
  const sku = service?.skus[0];
  if (!service || !sku) return null;
  return {
    role,
    serviceId: service.id,
    skuId: sku.id,
    units: sku.defaultUnits,
    enabled: true,
  };
}

/**
 * A default `CostSelection` for one provider across the required roles, in
 * display order — the catalog defaults, no AI. Roles the provider cannot fill
 * are simply omitted (surfaced later as `unsupportedRoles`).
 */
export function buildDefaultSelection(
  catalog: ServiceCatalog,
  provider: CloudProvider,
  requiredRoles: readonly InfraRole[],
): CostSelection {
  const ordered = INFRA_ROLE_ORDER.filter((r) => requiredRoles.includes(r));
  const choices = ordered
    .map((role) => defaultChoice(catalog, provider, role))
    .filter((c): c is RoleChoice => c !== null);
  return { provider, choices };
}

/**
 * Which provider to spotlight when there's no AI verdict: the one that can fill
 * the most required roles (ties broken by `CLOUD_PROVIDERS` order). A provider
 * that cannot run the app should not be crowned, so coverage — not price, which
 * we may not have yet — is the honest tiebreaker here.
 */
export function pickDefaultProvider(
  catalog: ServiceCatalog,
  requiredRoles: readonly InfraRole[],
): CloudProvider {
  let best: CloudProvider = CLOUD_PROVIDERS[0];
  let bestCoverage = -1;
  for (const provider of CLOUD_PROVIDERS) {
    const coverage = requiredRoles.filter(
      (role) => servicesForProviderRole(catalog, provider, role).length > 0,
    ).length;
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      best = provider;
    }
  }
  return best;
}

/**
 * Deterministic catalog-default recommendation, used when the AI recommender is
 * unavailable. It reuses the SAME pure derivations the server would
 * (`mapComponentsToRoles` for roles + assumptions, `deriveUsageProfile` for
 * sizing), then seeds one default selection per provider. It is explicitly
 * labelled a non-AI seed via `assumptions[0]` so the UI can be honest about it.
 *
 * PURE: no I/O, no clock, no env. Same context → identical seed.
 */
export function buildFallbackRecommendation(
  costContext: CostContext,
  catalog: ServiceCatalog = serviceCatalog,
): CostRecommendation {
  const { roles, assumptions } = mapComponentsToRoles(costContext);
  const usageProfile = usageProfileSchema.parse(deriveUsageProfile(costContext));
  const recommendedProvider = pickDefaultProvider(catalog, roles);

  const selections: CostSelection[] = CLOUD_PROVIDERS.map((provider) =>
    buildDefaultSelection(catalog, provider, roles),
  );

  // Editorial-free, honest tradeoff copy: with no AI we don't invent per-app
  // pros/cons, but the schema requires ≥1 of each, so we state the situation.
  const tradeoffs = CLOUD_PROVIDERS.map((provider) => {
    const coverage = roles.filter(
      (role) => servicesForProviderRole(catalog, provider, role).length > 0,
    ).length;
    const gaps = roles.length - coverage;
    return {
      provider,
      pros: ['Seeded from catalog defaults — adjust the sizes and services to fit your app.'],
      cons:
        gaps > 0
          ? [`Can't fill ${gaps} of the ${roles.length} roles this app needs on its own.`]
          : ['Editorial trade-offs need the AI recommender, which is unavailable right now.'],
    };
  });

  const recommendation = {
    recommendedProvider,
    rationale:
      'The AI recommender is unavailable, so this is a neutral starting point built from the ' +
      "catalog's default service and size for each capability your PRD needs. Nothing here is " +
      'a judgement about your app — change any service, size or provider and the totals update ' +
      'live.',
    usageProfile,
    assumptions: [
      'This is a catalog-default seed, not an AI recommendation — every choice is editable.',
      ...assumptions,
    ].slice(0, 10),
    selections,
    tradeoffs,
  };

  // Parse so a fallback can never be off-contract (mirrors the route's
  // self-validation). Throws only on a genuine catalog/derivation bug.
  return costRecommendationSchema.parse(recommendation);
}

/* -------------------------------------------------------------------------- */
/* Honest-caveat helpers (region, staleness, gaps)                            */
/* -------------------------------------------------------------------------- */

/** Milliseconds in `PRICE_MAX_AGE_DAYS`. */
export const PRICE_MAX_AGE_MS = PRICE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * The oldest `source.fetchedAt` across a book's records, or `null` when the
 * book has no priced records. Drives the staleness affordance. Pure.
 */
export function oldestPriceAt(book: PriceBook): string | null {
  let oldest: string | null = null;
  for (const record of book.records) {
    const at = record.source.fetchedAt;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest;
}

/**
 * Is a book's oldest price older than `PRICE_MAX_AGE_DAYS` relative to `now`?
 * A book with no priced records is NOT stale (there's nothing to be stale). We
 * take `now` as an argument so this stays pure and testable — the caller passes
 * `Date.now()`.
 */
export function isBookStale(book: PriceBook, now: number): boolean {
  const oldest = oldestPriceAt(book);
  if (oldest === null) return false;
  const oldestMs = new Date(oldest).getTime();
  if (Number.isNaN(oldestMs)) return false;
  return now - oldestMs > PRICE_MAX_AGE_MS;
}

/** Total number of price gaps across all books — the "we couldn't price N
 *  things" figure the UI surfaces so unpriced is never mistaken for free. */
export function totalGapCount(books: readonly PriceBook[]): number {
  return books.reduce((sum, b) => sum + b.gaps.length, 0);
}

/** Human label for the single region we price per provider (§region caveat). */
export { PRICED_REGION_LABEL } from '@/types/cost';

/** The provider a price book is for, plus its priced region — a number must
 *  never be mistaken for a global truth. Re-exported for the UI. */
export { PRICED_REGION };

/* -------------------------------------------------------------------------- */
/* Staged progress for the slow prices call (timed heuristic, no stream)      */
/* -------------------------------------------------------------------------- */

/**
 * One stage of the loading display. `atMs` is the elapsed time at which the
 * stage becomes current. `GET /api/cost/prices` exposes no progress stream and
 * a cold cache does real vendor fetches (many seconds), so — exactly like
 * Feature 1's generate step — we drive a staged heuristic so the wait never
 * looks like a dead spinner. These are cues, not promises: the real completion
 * is the fetch resolving, never a timer.
 */
export interface CostProgressStage {
  atMs: number;
  label: string;
  detail: string;
}

export const COST_PROGRESS_STAGES: readonly CostProgressStage[] = [
  {
    atMs: 0,
    label: 'Loading the service catalog…',
    detail: 'Which services each provider offers for the roles your app needs.',
  },
  {
    atMs: 2_500,
    label: 'Fetching live vendor prices…',
    detail: 'Reading each provider\u2019s public pricing pages — this can take a bit on a cold cache.',
  },
  {
    atMs: 12_000,
    label: 'Verifying every price against its source…',
    detail: 'Each number must be a verbatim match on the vendor\u2019s page, or it\u2019s dropped, not guessed.',
  },
  {
    atMs: 20_000,
    label: 'Asking the AI for a starting recommendation…',
    detail: 'Seeding a provider and sizes from your PRD — you can change all of it.',
  },
] as const;

/** The index of the active progress stage for a given elapsed time. */
export function costProgressStageIndexAt(
  elapsedMs: number,
  stages: readonly CostProgressStage[] = COST_PROGRESS_STAGES,
): number {
  let index = 0;
  for (let i = 0; i < stages.length; i += 1) {
    if (elapsedMs >= stages[i].atMs) index = i;
    else break;
  }
  return index;
}

/**
 * A smooth 0–95% progress value for the given elapsed time. Never reaches 100%
 * on a timer — only a resolved load completes the bar — so the UI cannot imply
 * "done" while fetches are still running. `expectedMs` is the point the bar
 * approaches (but never hits) 95%.
 */
export function costProgressFractionAt(elapsedMs: number, expectedMs = 22_000): number {
  if (elapsedMs <= 0) return 0.02;
  const raw = 0.95 * (1 - Math.exp(-elapsedMs / (expectedMs / 2)));
  return Math.min(0.95, Math.max(0.02, raw));
}
