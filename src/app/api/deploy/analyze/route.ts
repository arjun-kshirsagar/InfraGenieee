/**
 * POST /api/deploy/analyze
 *
 * Turns a pasted repository URL (plus an optional PRD slice) into a `DeployPlan`:
 * the detected stack, three provider fits with reasoning, generated config
 * artifacts, and a `primary` (or `null` when the repo couldn't be read
 * confidently). See docs/feature-3-one-click-deploy.md §8.
 *
 * SERVER-ONLY. Delegates to `buildDeployPlan`, which owns the whole pipeline
 * (parse → read repo → detect → recommend → generate). The handler contains NO
 * business logic (docs/api-contracts.md §Conventions): parse JSON → validate the
 * request → delegate → self-validate the output → respond. All mapping to HTTP
 * status codes goes through `RepoError.code`; an upstream body or URL is NEVER
 * returned to the client (it can carry the analysed repo path / a rate-limit
 * header) — it is logged server-side only.
 *
 * There is NO LLM call here: provider fit is a deterministic rule set (docs §6),
 * so there are no `llm_*` codes and no 60s `maxDuration`. The whole analysis is
 * a handful of anonymous GitHub reads plus pure functions; if it takes 60s
 * something is wrong.
 */

import { NextResponse } from 'next/server';

import { analyzeRequestSchema, analyzeResponseSchema } from '@/types/deploy';
import { apiError, ERROR_STATUS, zodIssues } from '@/lib/prd/api';
import type { ApiError } from '@/types/prd';
import { buildDeployPlan } from '@/lib/deploy/plan';
import { RepoError, type RepoErrorCode } from '@/lib/deploy/repo-seam';
import { gitHubRepoSource } from '@/lib/deploy/source/github';
import { repoSnapshotCache } from '@/lib/deploy/source/cache';

// A few GitHub reads plus pure functions — never statically cached, no LLM, so
// no long `maxDuration`.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Map a `RepoError.code` onto the public API error code, per the contract table
 * for `POST /api/deploy/analyze`:
 *   invalid_url      → 400 validation_error
 *   unsupported_host → 400 unsupported_host
 *   not_found        → 404 repo_not_found   (absent OR private — message names both)
 *   rate_limited     → 503 repo_unavailable (retryable; Retry-After passed through)
 *   unavailable      → 503 repo_unavailable (retryable)
 *   too_large        → 400 validation_error
 */
const REPO_ERROR_CODE: Record<RepoErrorCode, ApiError['error']['code']> = {
  invalid_url: 'validation_error',
  unsupported_host: 'unsupported_host',
  not_found: 'repo_not_found',
  rate_limited: 'repo_unavailable',
  unavailable: 'repo_unavailable',
  too_large: 'validation_error',
};

/** User-facing message per public code. Deliberately generic — never echoes the
 *  upstream body or URL. `repo_not_found` names BOTH possibilities because
 *  anonymous GitHub returns 404 for a missing repo and a private one alike. */
function messageFor(code: ApiError['error']['code'], repoErrorCode: RepoErrorCode): string {
  switch (code) {
    case 'repo_not_found':
      return "We couldn't find that repository. It either doesn't exist or is private — InfraGenie reads public repositories anonymously, so a private repo looks the same as a missing one from here. Check the URL, or make the repository public to analyse it.";
    case 'repo_unavailable':
      return 'We could not reach the git host right now (it may be rate-limiting us or temporarily down). Please try again in a moment.';
    case 'unsupported_host':
      return 'That is not a repository URL on a host we support. InfraGenie supports GitHub, GitLab and Bitbucket.';
    case 'validation_error':
      return repoErrorCode === 'too_large'
        ? 'That repository is too large for us to analyse.'
        : 'That does not look like a valid repository URL.';
    default:
      return 'We could not analyse that repository.';
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Body must be valid JSON.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(apiError('bad_request', 'Request body is not valid JSON.'), {
      status: ERROR_STATUS.bad_request,
    });
  }

  // 2. Body must satisfy the request contract.
  const parsed = analyzeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      apiError('validation_error', 'Request body failed validation.', zodIssues(parsed.error)),
      { status: ERROR_STATUS.validation_error },
    );
  }

  // 3. Delegate to the pipeline, then self-validate the output — never return a
  //    plan that doesn't parse against the response contract.
  try {
    const plan = await buildDeployPlan(
      parsed.data.repoUrl,
      {
        source: gitHubRepoSource,
        cache: repoSnapshotCache,
        now: () => new Date().toISOString(),
      },
      { prdContext: parsed.data.prdContext, signal: request.signal },
    );

    const check = analyzeResponseSchema.safeParse({ plan });
    if (!check.success) {
      // The assembled plan failed self-validation — an internal bug, not the
      // user's fault. Log the detail server-side; return a generic 500.
      console.error(
        '[api/deploy/analyze] plan failed self-validation',
        check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
      return NextResponse.json(
        apiError('internal_error', 'Generated deploy plan failed self-validation.'),
        { status: ERROR_STATUS.internal_error },
      );
    }

    return NextResponse.json(check.data, { status: 200 });
  } catch (error) {
    // Log server-side (the cause may carry the upstream URL / rate-limit
    // header / request ids) but never leak it to the client.
    console.error('[api/deploy/analyze] analysis failed', error);

    if (error instanceof RepoError) {
      const code = REPO_ERROR_CODE[error.code] ?? 'internal_error';
      const status = ERROR_STATUS[code];
      const headers: Record<string, string> = {};
      // Pass a retry hint through on a retryable error when the host gave one.
      if (code === 'repo_unavailable' && error.retryAfterSeconds !== undefined) {
        headers['Retry-After'] = String(error.retryAfterSeconds);
      }
      return NextResponse.json(apiError(code, messageFor(code, error.code)), { status, headers });
    }

    // Anything unexpected → a generic 500. The real error is in the server log.
    return NextResponse.json(apiError('internal_error', 'Failed to analyse the repository.'), {
      status: ERROR_STATUS.internal_error,
    });
  }
}
