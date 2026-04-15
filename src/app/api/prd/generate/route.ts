/**
 * POST /api/prd/generate
 *
 * Turns a completed questionnaire into a PrdDocument. Pure and synchronous —
 * no external calls, no persistence, no secrets (contract guarantee #6).
 *
 * The handler contains NO business logic (docs/api-contracts.md §Conventions):
 * parse → validate → delegate → self-validate output → respond. All mapping to
 * HTTP status codes goes through `ERROR_STATUS`.
 */

import { NextResponse } from 'next/server';
import {
  generateRequestSchema,
  prdDocumentSchema,
} from '@/types/prd';
import { apiError, ERROR_STATUS, newPrdId, zodIssues } from '@/lib/prd/api';
import { generatePrdDocument } from '@/lib/prd/generate';

// PRD generation is CPU-only and must never be statically cached: every
// request builds a fresh document (new id + timestamp).
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
  const parsed = generateRequestSchema.safeParse(body);
  if (!parsed.success) {
    const err = apiError(
      'validation_error',
      'Request body failed validation.',
      zodIssues(parsed.error),
    );
    return NextResponse.json(err, { status: ERROR_STATUS.validation_error });
  }

  // 3. Delegate to the pure rules engine, then self-validate the output
  //    (contract guarantee #3) — never return a document that doesn't parse.
  try {
    const document = generatePrdDocument(
      parsed.data.answers,
      newPrdId(),
      new Date().toISOString(),
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
  } catch {
    // Never leak a stack trace to the client.
    const err = apiError('generation_failed', 'PRD generation failed.');
    return NextResponse.json(err, { status: ERROR_STATUS.generation_failed });
  }
}
