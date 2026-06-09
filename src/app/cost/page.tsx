import type { Metadata } from 'next';
import { Suspense } from 'react';

import { CostClient } from './cost-client';

export const metadata: Metadata = {
  title: 'Deployment cost predictor — InfraGenie',
  description:
    'Estimate what your app costs to run across AWS, Google Cloud, Azure, Vercel and DigitalOcean, seeded from your PRD with real, cited vendor prices.',
};

/**
 * `/cost` — the deployment cost predictor (Feature 2). PRDs live in
 * `localStorage`, so all work happens in the client `CostClient` after mount;
 * this server component only provides the frame and the `Suspense` boundary
 * that `useSearchParams()` (for the `?prd=` deep-link) requires.
 */
export const dynamic = 'force-dynamic';

export default function CostPage() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-12">
      <Suspense
        fallback={
          <div className="mx-auto flex min-h-[40vh] w-full max-w-5xl items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        }
      >
        <CostClient />
      </Suspense>
    </main>
  );
}
