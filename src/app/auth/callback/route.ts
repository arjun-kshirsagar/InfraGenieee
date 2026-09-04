import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const next = requestUrl.searchParams.get('next') ?? '/prd';
  const loginUrl = new URL('/auth/login', requestUrl.origin);
  loginUrl.searchParams.set('next', next.startsWith('/') ? next : '/prd');

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      loginUrl.searchParams.set('error', error.code ?? 'callback_failed');
      return NextResponse.redirect(loginUrl);
    }
  } else {
    loginUrl.searchParams.set('error', requestUrl.searchParams.get('error_code') ?? 'callback_missing_code');
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.redirect(new URL(next.startsWith('/') ? next : '/prd', requestUrl.origin));
}
