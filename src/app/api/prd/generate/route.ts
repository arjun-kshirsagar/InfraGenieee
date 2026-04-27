/**
 * POST /api/prd/generate
 *
 * Turns a short ProjectBrief into a full PrdDocument via the LLM pipeline.
 *
 * The handler contains NO business logic (docs/api-contracts.md §Conventions):
 * parse → validate → delegate → self-validate output → respond. All mapping to
 * HTTP status codes goes through `ERROR_STATUS`.
 */

import { NextResponse } from 'next/server';
import { generateRequestSchema, prdDocumentSchema } from '@/types/prd';
import {
  apiError,
  ERROR_STATUS,
  GENERATION_ERROR_CODE,
  newPrdId,
  zodIssues,
} from '@/lib/prd/api';
import { generatePrdDocument, GenerationError } from '@/lib/prd/generation';

// Generation calls an external model and must never be statically cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Three sequential LLM calls at ~140 tok/s. 300s is the ceiling, not the norm.
export const maxDuration = 300;

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
  const parsed = generateRequestSchema.safeParse(body);
  if (!parsed.success) {
    const err = apiError(
      'validation_error',
      'Request body failed validation.',
      zodIssues(parsed.error),
    );
    return NextResponse.json(err, { status: ERROR_STATUS.validation_error });
  }

  // 3. Delegate to the generation pipeline, then self-validate the output —
  //    never return a document that doesn't parse. The min-volume floors live
  //    in the schema, so this check genuinely enforces them.
  try {
    const document = await generatePrdDocument(
      parsed.data.brief,
      newPrdId(),
      new Date().toISOString(),
      { signal: request.signal },
    );

    const check = prdDocumentSchema.safeParse(document);
    if (!check.success) {
      const err = apiError(
        'generation_failed',
        'Generated document failed self-validation.',
      );
      return NextResponse.json(err, { status: ERROR_STATUS.generation_failed });
    }

    return NextResponse.json({ document: check.data }, { status: 200 });
  } catch (error) {
    // Log server-side (the cause may carry upstream request ids) but never
    // leak it to the client.
    console.error('[api/prd/generate] generation failed', error);

    if (error instanceof GenerationError) {
      const code = GENERATION_ERROR_CODE[error.code] ?? 'generation_failed';
      const message =
        code === 'llm_not_configured'
          ? 'The PRD generator is not configured on this server.'
          : code === 'llm_unavailable'
            ? 'The AI service is temporarily unavailable. Please try again.'
            : 'PRD generation failed.';
      return NextResponse.json(apiError(code, message), { status: ERROR_STATUS[code] });
    }

    const err = apiError('generation_failed', 'PRD generation failed.');
    return NextResponse.json(err, { status: ERROR_STATUS.generation_failed });
  }
}
