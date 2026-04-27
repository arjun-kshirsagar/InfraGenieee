import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'New PRD — InfraGenie',
  description: 'Describe your idea and let InfraGenie generate the PRD, architecture and plan.',
};

/**
 * PLACEHOLDER — the old "enter every entity yourself" questionnaire was removed
 * in the AI re-scope. The new lightweight idea + context flow is being built
 * (see docs/feature-1-ai-prd.md). This page exists so the route keeps
 * building; the frontend replaces it wholesale.
 */
export default function NewPrdPage() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">The idea input is being rebuilt</h1>
      <p className="text-muted-foreground text-sm">
        InfraGenie now asks for your idea and a little context, then reasons out the entities,
        architecture and plan for you — instead of making you fill in a long form. That new flow is
        under construction.
      </p>
      <Link href="/" className={buttonVariants({ variant: 'outline' })}>
        Back to home
      </Link>
    </main>
  );
}
