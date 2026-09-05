'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, LogIn } from 'lucide-react';

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string };

function authErrorMessage(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'The email or password is incorrect.';
    case 'email_not_confirmed':
      return 'Confirm this email in Supabase before signing in.';
    case 'validation_failed':
    case 'email_address_invalid':
      return 'Enter a valid email address without quotes, commas, or extra text.';
    default:
      return error.message
        ? `Could not sign in: ${error.message}`
        : 'Could not sign in. Try again.';
  }
}

function gateErrorMessage(code: string | null): string | null {
  switch (code) {
    case 'sign_in':
      return 'Sign in with an authorized account to continue.';
    case 'access_denied':
      return 'Supabase denied that sign-in attempt. Try again.';
    default:
      return null;
  }
}

function safeNextPath(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/prd';
}

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get('next') ?? '/prd');
  const gateError = searchParams.get('error');
  const gateMessage = gateErrorMessage(gateError);
  const [state, setState] = React.useState<State>({ status: 'idle' });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!email || !password) return;

    setState({ status: 'loading' });

    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setState({ status: 'error', message: authErrorMessage(error) });
      return;
    }

    window.location.assign(next);
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Sign in to InfraGenie</CardTitle>
        <CardDescription>Use your email and password to save PRDs to your account.</CardDescription>
      </CardHeader>
      <CardContent>
        {gateMessage ? (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {gateMessage}
          </div>
        ) : null}
        {gateError === 'not_allowed' ? (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            This account isn&apos;t authorized for InfraGenie yet. Sign in with an approved email,
            or contact the owner to request access.
          </div>
        ) : null}
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
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
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
              <LogIn className="size-4" aria-hidden />
            )}
            Sign in
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
