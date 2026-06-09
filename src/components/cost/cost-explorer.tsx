'use client';

/**
 * `/cost` explorer — the loaded frame that F2 (interactive selectors + live
 * totals) and F3 (comparison + charts) mount into. This F1 task builds the
 * FRAME only:
 *
 *   header (PRD title + change PRD)
 *   ├─ recommendation summary (rationale + assumptions, honest fallback notice)
 *   ├─ 🔜 F2 SEAM: <CostSelectors …/> mounts here (the placeholder region)
 *   └─ caveats (priced region, staleness, gaps — unpriced ≠ free)
 *
 * Everything the downstream features need is already in `data`: the loaded
 * `PrdDocument`, the `ServiceCatalog`, the `PriceBook[]`, the derived
 * `requiredRoles`, and the recommendation seed (AI or catalog-default). F2/F3
 * read from these props — no new fetching, and the pure engine (imported by F2)
 * recomputes totals locally on every toggle.
 */

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, Wallet, Wrench } from 'lucide-react';

import type { CostData } from '@/app/cost/cost-client';
import { INFRA_ROLE_LABEL } from '@/types/cost';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

import { CostRecommendationSummary } from './cost-recommendation-summary';
import { CostCaveats } from './cost-caveats';

export interface CostExplorerProps {
  data: CostData;
  onChangePrd: () => void;
  onRetryRecommendation: () => void;
}

export function CostExplorer({ data, onChangePrd, onRetryRecommendation }: CostExplorerProps) {
  const { doc, books, requiredRoles, recommendation } = data;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      {/* Header */}
      <header className="flex flex-col gap-4">
        <button
          type="button"
          onClick={onChangePrd}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Change PRD
        </button>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Wallet className="size-6 text-primary" aria-hidden />
              <h1 className="text-2xl font-semibold tracking-tight text-balance">
                Deployment cost — {doc.title}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {requiredRoles.map((role) => (
                <Badge key={role} variant="secondary">
                  {INFRA_ROLE_LABEL[role]}
                </Badge>
              ))}
            </div>
          </div>
          <Link
            href={`/prd/${doc.id}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            View PRD
          </Link>
        </div>
      </header>

      {/* AI recommendation summary (or honest catalog-default fallback) */}
      <CostRecommendationSummary
        recommendation={recommendation}
        onRetry={onRetryRecommendation}
      />

      {/* 🔜 F2 seam — the interactive selectors + live totals mount here. */}
      <CostSelectorsPlaceholder providerCount={books.length} />

      {/* Honest caveats — non-negotiable (docs §5). */}
      <CostCaveats books={books} />
    </div>
  );
}

/**
 * Placeholder for the F2 interactive selectors + live per-provider totals. It
 * marks the seam clearly (so F2 knows exactly where to mount and what props are
 * available) and keeps the frame from looking broken in the meantime. F2
 * replaces this component with the real selector grid + comparison, reading
 * `catalog`, `books`, `requiredRoles` and `recommendation.recommendation.selections`
 * from the explorer's `data`.
 */
function CostSelectorsPlaceholder({ providerCount }: { providerCount: number }) {
  return (
    <Card className="border-dashed">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Wrench className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle className="text-base">Interactive cost comparison</CardTitle>
        </div>
        <CardDescription>
          Coming next: adjust services, sizes and usage per provider and watch the monthly totals
          update live across {providerCount} {providerCount === 1 ? 'provider' : 'providers'} — with
          a side-by-side comparison and charts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="rounded-md bg-muted/40 p-4 text-center text-sm text-muted-foreground">
          Your PRD is loaded and prices are ready. The selectors and comparison view slot in here.
        </p>
      </CardContent>
    </Card>
  );
}
