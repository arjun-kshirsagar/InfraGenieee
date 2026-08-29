import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in — InfraGenie',
  description: 'Sign in to save InfraGenie PRDs to your account.',
};

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="flex min-h-[70vh] w-full items-center justify-center px-4 py-10">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
