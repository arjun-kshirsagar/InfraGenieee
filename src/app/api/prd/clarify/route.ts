/**
 * POST /api/prd/clarify
 *
 * The adaptive step: given the user's idea + fixed context, ask back ONLY what
 * the AI genuinely cannot infer (0–3 questions). Zero questions is a valid,
 * common 200 — the frontend skips the step, it is never a 204 or an error.
 *
 * The handler contains NO business logic (docs/api-contracts.md §Conventions):
 * parse → validate request → delegate → self-validate output → respond. All
 * mapping to HTTP status codes goes through `ERROR_STATUS` / `GENERATION_ERROR_CODE`,
 * identical to `/api/prd/generate` so both routes report failures identically.
 */

import { NextResponse } from 'next/server';
import { clarifyRequestSchema, clarifyResponseSchema } from '@/types/prd';
import {
  apiError,
  ERROR_STATUS,
  GENERATION_ERROR_CODE,
  zodIssues,
} from '@/lib/prd/api';
import { generateClarifyingQuestions, GenerationError } from '@/lib/prd/generation';

// Hits an external model; never statically cache and never prerender.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Body must be valid JSON.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    const err = apiError('bad_request', 'Request body is not valid JSON.');
    return NextResponse.json(err, { status: ERROR_STATUS.bad_request });
  }

  // 2. Body must satisfy the request contract.
  const parsed = clarifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    const err = apiError(
      'validation_error',
      'Request body failed validation.',
      zodIssues(parsed.error),
    );
    return NextResponse.json(err, { status: ERROR_STATUS.validation_error });
  }

  // 3. Delegate to the clarifier stage, then self-validate the output — never
  //    return questions that don't parse (the ≤3 cap lives in the schema, so
  //    this check genuinely enforces it). An empty array is a valid 200.
  try {
    const questions = await generateClarifyingQuestions(parsed.data.idea, parsed.data.context, {
      signal: request.signal,
    });

    const check = clarifyResponseSchema.safeParse({ questions });
    if (!check.success) {
      // The model produced something outside the contract (e.g. >3). Log the
      // shape server-side; report a generic generation failure to the client.
      console.error('[api/prd/clarify] clarifier output failed self-validation', check.error.issues);
      const err = apiError('generation_failed', 'Clarifier output failed self-validation.');
      return NextResponse.json(err, { status: ERROR_STATUS.generation_failed });
    }

    return NextResponse.json(check.data, { status: 200 });
  } catch (error) {
    // Log server-side (the cause may carry upstream request ids) but never
    // leak it to the client.
    console.error('[api/prd/clarify] clarify failed', error);

    if (error instanceof GenerationError) {
      const code = GENERATION_ERROR_CODE[error.code] ?? 'generation_failed';
      const message =
        code === 'llm_not_configured'
          ? 'The PRD generator is not configured on this server.'
          : code === 'llm_unavailable'
            ? 'The AI service is temporarily unavailable. Please try again.'
            : 'Generating clarifying questions failed.';
      return NextResponse.json(apiError(code, message), { status: ERROR_STATUS[code] });
    }

    const err = apiError('generation_failed', 'Generating clarifying questions failed.');
    return NextResponse.json(err, { status: ERROR_STATUS.generation_failed });
  }
}
