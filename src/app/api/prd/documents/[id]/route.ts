import { NextResponse } from 'next/server';

import { getUserPrdDocument } from '@/lib/prd/mongo-store';
import { getAuthenticatedUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: 'auth_required', message: 'Sign in to read account PRDs.' } },
      { status: 401 },
    );
  }

  const { id } = await params;
  const document = await getUserPrdDocument(user.id, id);
  if (!document) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'PRD document was not found.' } },
      { status: 404 },
    );
  }

  return NextResponse.json({ document }, { status: 200 });
}
