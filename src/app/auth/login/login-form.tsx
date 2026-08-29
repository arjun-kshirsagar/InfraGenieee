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

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/prd';
  const gateError = searchParams.get('error');
  const [state, setState] = React.useState<State>({ status: 'idle' });

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
      setState({ status: 'error', message: 'Could not send the sign-in email. Try again.' });
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
