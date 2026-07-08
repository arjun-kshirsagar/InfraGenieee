import type { Metadata } from 'next';
import { Suspense } from 'react';

import { DeployClient } from './deploy-client';

export const metadata: Metadata = {
  title: 'One-click deploy — InfraGenie',
  description:
    'Paste your repository URL. InfraGenie reads it, detects your stack, and tells you which of Vercel, Netlify and Render fits best — with a one-click button into each provider’s own deploy flow.',
};

/**
 * `/deploy` — the one-click deploy route (Feature 3). The optional PRD context
 * lives in `localStorage`, so all work happens in the client `DeployClient`
 * after mount; this server component only provides the frame and the `Suspense`
 * boundary that `useSearchParams()` (for the `?prd=` deep-link) requires.
 */
export const dynamic = 'force-dynamic';

export default function DeployPage() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-12">
      <Suspense
        fallback={
          <div className="mx-auto flex min-h-[40vh] w-full max-w-2xl items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        }
      >
        <DeployClient />
      </Suspense>
    </main>
  );
}
