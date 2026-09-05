import type { Metadata } from 'next';
import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = {
  title: 'Reset password — InfraGenie',
  description: 'Set a new password for your InfraGenie account.',
};

export const dynamic = 'force-dynamic';

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-[70vh] w-full items-center justify-center px-4 py-10">
      <ResetPasswordForm />
    </main>
  );
}
