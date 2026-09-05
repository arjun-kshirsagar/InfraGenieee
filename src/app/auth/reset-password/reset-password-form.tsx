'use client';

import * as React from 'react';
import Link from 'next/link';
import { KeyRound, Loader2 } from 'lucide-react';

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

function updateErrorMessage(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case 'same_password':
      return 'Choose a password you have not used before.';
    case 'weak_password':
      return 'Choose a stronger password.';
    default:
      return error.message
        ? `Could not reset password: ${error.message}`
        : 'Could not reset password. Open the newest reset email and try again.';
  }
}

export function ResetPasswordForm() {
  const [state, setState] = React.useState<State>({ status: 'idle' });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (!password) return;

    setState({ status: 'loading' });

    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setState({ status: 'error', message: updateErrorMessage(error) });
      return;
    }

    setState({ status: 'success', message: 'Password updated. You can sign in with it now.' });
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Set a new password</CardTitle>
        <CardDescription>Use the reset link from your email, then enter a new password.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
            />
          </div>
          {state.status === 'success' ? (
            <p className="rounded-md border border-green-600/30 bg-green-600/5 px-3 py-2 text-sm text-green-700">
              {state.message}
            </p>
          ) : null}
          {state.status === 'error' ? (
            <p className="text-sm text-destructive">{state.message}</p>
          ) : null}
          <Button type="submit" disabled={state.status === 'loading' || state.status === 'success'}>
            {state.status === 'loading' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <KeyRound className="size-4" aria-hidden />
            )}
            Update password
          </Button>
          {state.status === 'success' ? (
            <Link href="/auth/login" className={buttonVariants({ variant: 'outline' })}>
              Back to sign in
            </Link>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
