'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { KeyRound, Loader2, LogIn, UserPlus } from 'lucide-react';

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

type Mode = 'sign-in' | 'sign-up' | 'reset';

function authErrorMessage(error: { code?: string; message?: string }, mode: Mode): string {
  const action = mode === 'reset' ? 'request a password reset' : modeLabel(mode).toLowerCase();
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
        ? `Could not ${action}: ${error.message}`
        : `Could not ${action}. Try again.`;
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

function modeLabel(mode: Mode): string {
  switch (mode) {
    case 'sign-up':
      return 'Sign up';
    case 'reset':
      return 'Reset password';
    default:
      return 'Sign in';
  }
}

function modeDescription(mode: Mode): string {
  switch (mode) {
    case 'sign-up':
      return 'Create an account with email and password.';
    case 'reset':
      return 'Enter any email and Supabase will send a password reset link.';
    default:
      return 'Use your email and password to save PRDs to your account.';
  }
}

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get('next') ?? '/prd');
  const gateError = searchParams.get('error');
  const gateMessage = gateErrorMessage(gateError);
  const [mode, setMode] = React.useState<Mode>('sign-in');
  const [state, setState] = React.useState<State>({ status: 'idle' });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!email || (mode !== 'reset' && !password)) return;

    setState({ status: 'loading' });

    const supabase = createSupabaseBrowserClient();

    if (mode === 'reset') {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: new URL('/auth/reset-password', window.location.origin).toString(),
      });

      if (error) {
        setState({ status: 'error', message: authErrorMessage(error, mode) });
        return;
      }

      setState({
        status: 'success',
        message: 'If that email can receive password resets, Supabase will send a reset link.',
      });
      return;
    }

    if (mode === 'sign-up') {
      const { data, error } = await supabase.auth.signUp({ email, password });

      if (error) {
        setState({ status: 'error', message: authErrorMessage(error, mode) });
        return;
      }

      if (data.session) {
        window.location.assign(next);
        return;
      }

      setState({
        status: 'success',
        message: 'Account created. If email confirmation is enabled, confirm your email before signing in.',
      });
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setState({ status: 'error', message: authErrorMessage(error, mode) });
      return;
    }

    window.location.assign(next);
  }

  function switchMode(nextMode: Mode) {
    setMode(nextMode);
    setState({ status: 'idle' });
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{modeLabel(mode)} to InfraGenie</CardTitle>
        <CardDescription>{modeDescription(mode)}</CardDescription>
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
        <div className="mb-4 grid grid-cols-3 rounded-md border bg-muted/30 p-1">
          <Button
            type="button"
            variant={mode === 'sign-in' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => switchMode('sign-in')}
          >
            Sign in
          </Button>
          <Button
            type="button"
            variant={mode === 'sign-up' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => switchMode('sign-up')}
          >
            Sign up
          </Button>
          <Button
            type="button"
            variant={mode === 'reset' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => switchMode('reset')}
          >
            Reset
          </Button>
        </div>

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
          {mode !== 'reset' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
                minLength={6}
                required
              />
            </div>
          ) : null}
          {state.status === 'success' ? (
            <p className="rounded-md border border-green-600/30 bg-green-600/5 px-3 py-2 text-sm text-green-700">
              {state.message}
            </p>
          ) : null}
          {state.status === 'error' ? (
            <p className="text-sm text-destructive">{state.message}</p>
          ) : null}
          <Button type="submit" disabled={state.status === 'loading'}>
            {state.status === 'loading' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : mode === 'sign-up' ? (
              <UserPlus className="size-4" aria-hidden />
            ) : mode === 'reset' ? (
              <KeyRound className="size-4" aria-hidden />
            ) : (
              <LogIn className="size-4" aria-hidden />
            )}
            {modeLabel(mode)}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
