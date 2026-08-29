/**
 * InfraGenie — API auth guard.
 *
 * Defense-in-depth for the paid / data routes. Middleware is the primary gate,
 * but each expensive route ALSO calls this so that a middleware bypass (matcher
 * change, edge case, direct invocation) can never leak paid LLM calls or user
 * data. Returns a 401 NextResponse to short-circuit, or null when the caller
 * may proceed.
 *
 * Usage inside a route handler:
 *
 *   const denied = await requireAllowedUser();
 *   if (denied) return denied;
 */

import { NextResponse } from 'next/server';

import { getAuthenticatedUser } from '@/lib/supabase/server';
import { isAllowedEmail } from '@/lib/auth/allowlist';

export async function requireAllowedUser(): Promise<NextResponse | null> {
  const user = await getAuthenticatedUser();
  if (!user || !isAllowedEmail(user.email)) {
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
  return null;
}
