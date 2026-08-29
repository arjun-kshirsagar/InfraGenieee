import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getAuthenticatedUser } from '@/lib/supabase/server';
import {
  listUserPrdDocuments,
  saveUserPrdDocument,
} from '@/lib/prd/mongo-store';
import { prdDocumentSchema } from '@/types/prd';

const saveDocumentRequestSchema = z.object({
  document: prdDocumentSchema,
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authRequired(): NextResponse {
  return NextResponse.json(
    { error: { code: 'auth_required', message: 'Sign in to use account PRD storage.' } },
    { status: 401 },
  );
}

export async function GET(): Promise<NextResponse> {
  const user = await getAuthenticatedUser();
  if (!user) return authRequired();

  const documents = await listUserPrdDocuments(user.id);
  return NextResponse.json({ documents }, { status: 200 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getAuthenticatedUser();
  if (!user) return authRequired();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Request body is not valid JSON.' } },
      { status: 400 },
    );
  }

  const parsed = saveDocumentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'validation_error',
          message: 'Request body failed validation.',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  const document = await saveUserPrdDocument(user.id, parsed.data.document);
  return NextResponse.json({ document }, { status: 200 });
}
