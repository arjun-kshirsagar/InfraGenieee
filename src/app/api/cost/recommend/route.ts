/**
 * POST /api/cost/recommend
 *
 * Turns PRD context (`CostContext`) into a seeded, editable `CostRecommendation`.
 * The recommendation is a STARTING POINT the user can freely override, not a
 * verdict — the interactive selector lets them change everything.
 *
 * SERVER-ONLY. Delegates to `recommendDeployment` (which reasons via one
 * Anthropic call, then verifies every id against the catalog). The handler
 * contains NO business logic (docs/api-contracts.md §Conventions): parse →
 * validate → delegate → self-validate output → respond. All mapping to HTTP
 * status codes goes through the contract's error table; an upstream body or an
 * API key is NEVER returned.
 */

import { NextResponse } from 'next/server';

import { recommendRequestSchema, recommendResponseSchema } from '@/types/cost';
import { apiError, ERROR_STATUS, zodIssues } from '@/lib/prd/api';
import type { ApiError } from '@/types/prd';
import { recommendDeployment } from '@/lib/cost/llm/recommend';
import { PricingError, type PricingErrorCode } from '@/lib/cost/pricing-seam';
import { serviceCatalog } from '@/lib/cost/catalog';

// Recommendation calls an external model and must never be statically cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One Anthropic call at ~5–15s; 60s is the ceiling, not the norm.
export const maxDuration = 60;

/**
 * Map a `PricingError.code` onto the public API error code, per the contract
 * table for `POST /api/cost/recommend`:
 *   not_configured  → 500 llm_not_configured
 *   unavailable     → 503 llm_unavailable   (retryable)
 *   invalid_output  → 500 generation_failed (model output failed validation)
 *   not_implemented → 500 generation_failed
 */
const PRICING_ERROR_CODE: Record<PricingErrorCode, ApiError['error']['code']> = {
  not_configured: 'llm_not_configured',
  unavailable: 'llm_unavailable',
  invalid_output: 'generation_failed',
  not_implemented: 'generation_failed',
};

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
  const parsed = recommendRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      apiError('validation_error', 'Request body failed validation.', zodIssues(parsed.error)),
      { status: ERROR_STATUS.validation_error },
    );
  }

  // 3. Delegate, then self-validate the output — never return a recommendation
  //    that doesn't parse against the response contract.
  try {
    const recommendation = await recommendDeployment(parsed.data.costContext, serviceCatalog, {
      signal: request.signal,
    });

    const check = recommendResponseSchema.safeParse({ recommendation });
    if (!check.success) {
      return NextResponse.json(
        apiError('generation_failed', 'Generated recommendation failed self-validation.'),
        { status: ERROR_STATUS.generation_failed },
      );
    }

    return NextResponse.json(check.data, { status: 200 });
  } catch (error) {
    // Log server-side (the cause may carry upstream request ids) but never leak
    // it to the client.
    console.error('[api/cost/recommend] recommendation failed', error);

    if (error instanceof PricingError) {
      const code = PRICING_ERROR_CODE[error.code] ?? 'generation_failed';
      const message =
        code === 'llm_not_configured'
          ? 'The cost recommender is not configured on this server.'
          : code === 'llm_unavailable'
            ? 'The AI service is temporarily unavailable. Please try again.'
            : 'Cost recommendation failed.';
      return NextResponse.json(apiError(code, message), { status: ERROR_STATUS[code] });
    }

    return NextResponse.json(apiError('generation_failed', 'Cost recommendation failed.'), {
      status: ERROR_STATUS.generation_failed,
    });
  }
}
