import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

import { isAllowedEmail } from '@/lib/auth/allowlist';

// Auth routes must stay reachable while signed out, or gating would loop.
const PUBLIC_PATHS = ['/auth/login', '/auth/callback', '/auth/logout'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If auth isn't configured, don't hard-block (keeps local/dev usable).
  if (!url || !anonKey) return NextResponse.next({ request });

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // Refresh session + read the current user.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const allowed = isAllowedEmail(user?.email);

  // Public auth routes always pass so login/callback/logout can work.
  if (isPublicPath(pathname)) return response;

  if (!allowed) {
    // API routes: hard 401, never a redirect (keeps fetch() callers sane).
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        {
          error: {
            code: 'auth_required',
            message: 'Sign in with an authorized account to use InfraGenie.',
          },
        },
        { status: 401 },
      );
    }
    // Pages: redirect to login. `not_allowed` = signed in but not on the
    // allowlist; `sign_in` = not signed in at all.
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/auth/login';
    redirectUrl.search = '';
    redirectUrl.searchParams.set('error', user ? 'not_allowed' : 'sign_in');
    redirectUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
