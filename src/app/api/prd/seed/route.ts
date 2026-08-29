import { NextResponse } from 'next/server';

import { saveUserPrdDocuments } from '@/lib/prd/mongo-store';
import { seedPrdDocuments } from '@/lib/prd/seed';
import { getAuthenticatedUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: 'auth_required', message: 'Sign in to seed PRD documents.' } },
      { status: 401 },
    );
  }

  const documents = await saveUserPrdDocuments(user.id, seedPrdDocuments());
  return NextResponse.json({ documents }, { status: 200 });
}
