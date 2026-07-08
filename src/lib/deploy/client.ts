/**
 * InfraGenie — pure, DOM-free client logic for Feature 3 (the `/deploy` route).
 *
 * This module owns everything about the deploy analysis that is *logic* rather
 * than *rendering*, mirroring `src/lib/cost/client.ts`:
 *
 *   - calling `POST /api/deploy/analyze` (no LLM, so a few seconds — but we
 *     still impose NO short client timeout; the caller's `AbortSignal` is the
 *     only cancellation, per the F1/F2 lesson that a 30s client timeout aborts
 *     an otherwise-healthy call),
 *   - classifying every result into a discriminated outcome (`ok` | `error`),
 *   - mapping each contract error `code` to distinct, honest, non-technical
 *     copy + flags (`retryable`, `changeUrl`), so ALL error-code→copy lives here
 *     and is unit-tested, never inside JSX,
 *   - `buildDeployPrdContext(doc)`, the pure Feature-1-document → `DeployPrdContext`
 *     slice (the same posture as `buildCostContext`), and
 *   - the staged-progress heuristic the loading view renders (pure functions of
 *     elapsed ms).
 *
 * ## Why this is a separate, pure module
 *
 * 1. The vitest `node` environment tests the branching offline with a mocked
 *    `fetch`, no DOM and no network.
 * 2. 🔴 **No server-only code ever reaches the browser.** This module imports
 *    ONLY from `@/types/*` and `@/lib/deploy/repo-url` (pure). It does NOT import
 *    `@/lib/deploy/repo-seam`, `@/lib/deploy/source/**`, or any detector /
 *    recommender — the UI talks to the server only through `/api/deploy/analyze`
 *    (docs/architecture.md §3 rule 4).
 */

import {
  analyzeResponseSchema,
  deployPrdContextSchema,
  type DeployPlan,
  type DeployPrdContext,
} from '@/types/deploy';
import type { PrdDocument } from '@/types/prd';
import { apiErrorSchema } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Endpoint                                                                    */
/* -------------------------------------------------------------------------- */

export const ANALYZE_ENDPOINT = '/api/deploy/analyze';

/* -------------------------------------------------------------------------- */
/* Error-code → message + flags (the deploy error table)                      */
/* -------------------------------------------------------------------------- */

/**
 * The Feature 3 contract error codes `POST /api/deploy/analyze` can return
 * (subset of `apiErrorSchema`), plus a transport `'network'` pseudo-code for a
 * request that never completed.
 */
export type DeployErrorCode =
  | 'repo_not_found'
  | 'repo_unavailable'
  | 'unsupported_host'
  | 'validation_error'
  | 'bad_request'
  | 'generation_failed'
  | 'internal_error'
  | 'not_found'
  | 'network';

/**
 * How a failed analysis should be presented. `retryable` drives whether the UI
 * offers a one-click Retry of the *same* URL. `changeUrl` drives whether the
 * primary affordance is "try another URL" (the URL itself is the problem, so
 * retrying it unchanged is pointless). `issues` carries the flattened
 * validation issues for `validation_error`.
 */
export interface DeployErrorPresentation {
  code: DeployErrorCode;
  /** Short heading for the error card. */
  title: string;
  /** Honest, user-facing body. Never contains upstream/token/env text. */
  message: string;
  retryable: boolean;
  /** The URL is the fault → surface "try another URL", not a bare retry. */
  changeUrl: boolean;
  /** Flattened `path: message` issues for `validation_error`. */
  issues?: { path: string; message: string }[];
}

/**
 * Map a contract error `code` (or transport `'network'`) to distinct copy +
 * flags. Unit-tested exhaustively.
 *
 * | code             | retry | changeUrl | gist                                        |
 * |------------------|-------|-----------|---------------------------------------------|
 * | repo_not_found   |  no   |   yes     | doesn't exist OR is private; v1 reads public |
 * | repo_unavailable |  yes  |   no      | GitHub rate-limiting us; try in a minute     |
 * | unsupported_host |  no   |   yes     | we support GitHub, GitLab and Bitbucket URLs |
 * | validation_error |  no   |   yes     | the URL we sent didn't fit — show issues     |
 * | bad_request      |  no   |   yes     | malformed request (shouldn't happen)         |
 * | generation_failed|  yes  |   no      | assembled plan failed self-check — retry     |
 * | internal_error   |  yes  |   no      | unexpected — retry is reasonable             |
 * | not_found        |  yes  |   no      | endpoint unreachable — retry                 |
 * | network          |  yes  |   no      | request never completed — try again          |
 */
export function mapDeployError(
  code: DeployErrorCode,
  issues?: { path: string; message: string }[],
): DeployErrorPresentation {
  switch (code) {
    case 'repo_not_found':
      return {
        code,
        title: "We couldn\u2019t find that repository",
        message:
          "The URL is well-formed, but we couldn\u2019t read the repo. It may not exist, or it " +
          "may be private \u2014 InfraGenie only reads public repositories in v1, and it can\u2019t " +
          "tell the two apart. Double-check the URL, or make the repo public and try again.",
        retryable: false,
        changeUrl: true,
      };
    case 'repo_unavailable':
      return {
        code,
        title: "GitHub is rate-limiting us",
        message:
          "We read repositories anonymously, and GitHub is throttling requests from us right " +
          "now. This clears quickly \u2014 give it a minute and try again.",
        retryable: true,
        changeUrl: false,
      };
    case 'unsupported_host':
      return {
        code,
        title: "That doesn\u2019t look like a repository we support",
        message:
          "We support GitHub, GitLab and Bitbucket repository URLs \u2014 for example " +
          "https://github.com/owner/repo. Paste one of those and we\u2019ll take it from there.",
        retryable: false,
        changeUrl: true,
      };
    case 'validation_error':
      return {
        code,
        title: "That URL didn\u2019t look right",
        message:
          "The repository URL didn\u2019t pass validation. Check it for typos or extra characters " +
          "and try again.",
        retryable: false,
        changeUrl: true,
        issues: issues && issues.length > 0 ? issues : undefined,
      };
    case 'bad_request':
      return {
        code,
        title: "Something about the request was off",
        message:
          "The request was malformed \u2014 this usually clears if you re-paste the URL. Try again " +
          "with a fresh copy of the repository link.",
        retryable: false,
        changeUrl: true,
      };
    case 'generation_failed':
      return {
        code,
        title: "We couldn\u2019t assemble a plan",
        message:
          "We read the repo but couldn\u2019t put together a usable deployment plan for it. This is " +
          "usually temporary \u2014 please try again.",
        retryable: true,
        changeUrl: false,
      };
    case 'internal_error':
      return {
        code,
        title: "Something went wrong on our end",
        message: "That\u2019s on us, not you. Please try again in a moment.",
        retryable: true,
        changeUrl: false,
      };
    case 'not_found':
      return {
        code,
        title: "The deploy service couldn\u2019t be reached",
        message: "We couldn\u2019t reach the analysis service. Please try again.",
        retryable: true,
        changeUrl: false,
      };
    case 'network':
    default:
      return {
        code: 'network',
        title: "The request didn\u2019t complete",
        message:
          "The analysis didn\u2019t finish \u2014 this is usually a connection hiccup. Please try again.",
        retryable: true,
        changeUrl: false,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Fetch plumbing                                                             */
/* -------------------------------------------------------------------------- */

export interface FetchOptions {
  /** Forwarded to `fetch`. The ONLY cancellation — we impose no timeout of our
   *  own (the analysis is short, but a hung socket must still be cancellable). */
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

/** Best-effort mapping from an HTTP status to a deploy error code, used only
 *  when the error body is missing or off-contract. */
function statusToCode(status: number): DeployErrorCode {
  if (status === 404) return 'repo_not_found';
  if (status === 503) return 'repo_unavailable';
  if (status === 400) return 'validation_error';
  if (status === 500) return 'internal_error';
  return 'internal_error';
}

/**
 * Read a non-2xx response and turn it into a `DeployErrorPresentation`. Prefers
 * the contract error envelope (so we get the exact code and any `issues`);
 * falls back to the HTTP status if the body is missing or off-contract.
 */
async function classifyErrorResponse(response: Response): Promise<DeployErrorPresentation> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    return mapDeployError(parsed.data.error.code as DeployErrorCode, parsed.data.error.issues);
  }
  return mapDeployError(statusToCode(response.status));
}

/* -------------------------------------------------------------------------- */
/* analyzeRepo                                                                 */
/* -------------------------------------------------------------------------- */

export type AnalyzeOutcome =
  | { kind: 'ok'; plan: DeployPlan }
  | { kind: 'error'; presentation: DeployErrorPresentation };

/**
 * `POST /api/deploy/analyze`.
 *
 * `repoUrl` is whatever the user pasted, **unnormalised** — the server owns the
 * one authoritative parser + error messages (docs §8), so the client must NOT
 * canonicalise first.
 *
 * Rejects ONLY on abort (caller cancelled / navigated away); every other
 * failure resolves to `{ kind: 'error' }` with presentation copy.
 */
export async function analyzeRepo(
  repoUrl: string,
  prdContext?: DeployPrdContext,
  options: FetchOptions = {},
): Promise<AnalyzeOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(ANALYZE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl, ...(prdContext ? { prdContext } : {}) }),
      signal: options.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    return { kind: 'error', presentation: mapDeployError('network') };
  }

  if (!response.ok) {
    return { kind: 'error', presentation: await classifyErrorResponse(response) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'error', presentation: mapDeployError('internal_error') };
  }

  const parsed = analyzeResponseSchema.safeParse(body);
  if (!parsed.success) {
    // A 200 that doesn't satisfy the contract is a server bug, not user error;
    // surface it as retryable rather than crashing the page.
    return { kind: 'error', presentation: mapDeployError('generation_failed') };
  }
  return { kind: 'ok', plan: parsed.data.plan };
}

/* -------------------------------------------------------------------------- */
/* PRD context slice                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build the optional `DeployPrdContext` slice from a loaded `PrdDocument`,
 * shaped exactly like Feature 2's `buildCostContext`. Pure — no I/O.
 *
 * The feature works from a bare URL; this only *sharpens* provider fit (budget
 * → free-tier bias, a datastore component → Render's managed DB, etc.). We send
 * only the architecture-relevant slice, never the whole document.
 *
 * `deployPrdContextSchema.components` requires ≥ 1; a generated PRD always has
 * ≥ 2 components, and we validate at the boundary so a stale document can never
 * hand a malformed context to the server.
 */
export function buildDeployPrdContext(doc: PrdDocument): DeployPrdContext {
  const context: DeployPrdContext = {
    title: doc.title,
    context: doc.brief.context,
    components: doc.architecture.components,
    infrastructure: doc.architecture.infrastructure,
    summary: doc.prd.overview.solution.slice(0, 1000),
  };
  // Validate at the boundary: a stale/foreign document must never send a
  // malformed context. Parse strips unknown keys and enforces the caps.
  return deployPrdContextSchema.parse(context);
}

/* -------------------------------------------------------------------------- */
/* Loading progress narrative (pure)                                          */
/* -------------------------------------------------------------------------- */

/**
 * The staged narrative the loading view renders. The whole analysis is a few
 * seconds (a handful of GitHub reads + pure functions — NO LLM), so the stages
 * are short and we deliberately DO NOT fake a long progress bar. The bar never
 * completes on a timer; only the resolved analysis unmounts the view.
 */
export interface DeployProgressStage {
  label: string;
  detail: string;
  /** Elapsed-ms threshold at which this stage becomes active. */
  atMs: number;
}

export const DEPLOY_PROGRESS_STAGES: readonly DeployProgressStage[] = [
  {
    label: 'Reading your repository\u2026',
    detail: 'Fetching the public file listing and a few key manifests.',
    atMs: 0,
  },
  {
    label: 'Detecting the stack\u2026',
    detail: 'Working out the framework, runtime and app shape \u2014 every claim cites a file.',
    atMs: 1500,
  },
  {
    label: 'Matching providers\u2026',
    detail: 'Scoring Vercel, Netlify and Render against what we found.',
    atMs: 3000,
  },
] as const;

/** Which stage is active at `elapsedMs`. Clamped to the last stage — the bar
 *  holds on "matching providers" until the real result arrives. */
export function deployProgressStageIndexAt(elapsedMs: number): number {
  let index = 0;
  for (let i = 0; i < DEPLOY_PROGRESS_STAGES.length; i += 1) {
    if (elapsedMs >= DEPLOY_PROGRESS_STAGES[i].atMs) index = i;
  }
  return index;
}

/**
 * A capped progress fraction (0–0.9) for the bar. Never reaches 1 on a timer —
 * only the resolved load completes it — and approaches the cap asymptotically
 * so a slow call never looks stuck at a hard stop. Pure function of elapsed ms.
 */
export function deployProgressFractionAt(elapsedMs: number): number {
  // ~4s to reach the 0.9 cap, then asymptotic. Honest: we don't know the exact
  // duration, so we approach but never assert completion.
  const CAP = 0.9;
  const K = 4000;
  const frac = CAP * (1 - Math.exp(-elapsedMs / K));
  return Math.max(0, Math.min(CAP, frac));
}
