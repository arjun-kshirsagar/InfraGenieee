'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, Mail } from 'lucide-react';

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'sent'; email: string }
  | { status: 'error'; message: string };

function authErrorMessage(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case 'over_email_send_rate_limit':
      return 'Supabase has rate-limited magic-link emails for now. Wait a few minutes, then try again.';
    case 'otp_disabled':
      return 'Magic-link sign-in is disabled in Supabase. Enable Email OTP/Magic Link in Authentication settings.';
    case 'validation_failed':
    case 'email_address_invalid':
      return 'Enter a valid email address without quotes, commas, or extra text.';
    default:
      return error.message
        ? `Could not send the sign-in email: ${error.message}`
        : 'Could not send the sign-in email. Try again.';
  }
}

function redirectErrorMessage(code: string | null): string | null {
  switch (code) {
    case 'otp_expired':
      return 'That magic link has expired or was already used. Request a fresh link and open the newest email in this same browser.';
    case 'access_denied':
      return 'Supabase denied that sign-in link. Request a fresh link and try again.';
    case 'flow_state_not_found':
    case 'bad_code_verifier':
      return 'This magic link was opened in a different browser or after the login session expired. Request a fresh link from this browser and open it here.';
    case 'callback_missing_code':
      return 'The sign-in callback did not include a login code. Request a fresh magic link and open the newest email.';
    case 'callback_failed':
      return 'The sign-in callback failed. Request a fresh magic link and try again.';
    default:
      return null;
  }
}

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/prd';
  const gateError = searchParams.get('error');
  const [redirectError, setRedirectError] = React.useState<string | null>(
    redirectErrorMessage(gateError),
  );
  const [state, setState] = React.useState<State>({ status: 'idle' });

  React.useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const message =
      redirectErrorMessage(hash.get('error_code')) ?? redirectErrorMessage(hash.get('error'));
    if (message) queueMicrotask(() => setRedirectError(message));
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    if (!email) return;

    setState({ status: 'loading' });

    const supabase = createSupabaseBrowserClient();
    const redirectTo = new URL('/auth/callback', window.location.origin);
    redirectTo.searchParams.set('next', next.startsWith('/') ? next : '/prd');

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo.toString() },
    });

    if (error) {
      setState({ status: 'error', message: authErrorMessage(error) });
      return;
    }

    setState({ status: 'sent', email });
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Sign in to InfraGenie</CardTitle>
        <CardDescription>Use a magic link to save PRDs to your account.</CardDescription>
      </CardHeader>
      <CardContent>
        {redirectError ? (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {redirectError}
          </div>
        ) : null}
        {gateError === 'not_allowed' ? (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            This account isn&apos;t authorized for InfraGenie yet. Sign in with an approved email,
            or contact the owner to request access.
          </div>
        ) : null}
        {state.status === 'sent' ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">Check your email</p>
            <p className="text-muted-foreground">
              We sent a sign-in link to <span className="font-medium">{state.email}</span>.
            </p>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
              />
            </div>
            {state.status === 'error' ? (
              <p className="text-sm text-destructive">{state.message}</p>
            ) : null}
            <Button type="submit" disabled={state.status === 'loading'}>
              {state.status === 'loading' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Mail className="size-4" aria-hidden />
              )}
              Send magic link
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
