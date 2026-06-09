'use client';

/**
 * The AI recommendation summary shown above the (future F2) selectors. It
 * renders the seed's `rationale` and `assumptions`, and — crucially — is honest
 * about provenance: when the recommendation came from the catalog-default
 * FALLBACK (the AI recommender was unavailable), it shows a dismissible notice
 * and, when the failure was retryable, a Retry. A cost explorer with no AI seed
 * is still useful, so this never blocks anything.
 */

import * as React from 'react';
import { Sparkles, Info, RefreshCw, Lightbulb } from 'lucide-react';

import type { RecommendOutcome } from '@/lib/cost/client';
import { PROVIDER_LABEL } from '@/types/cost';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface CostRecommendationSummaryProps {
  recommendation: RecommendOutcome;
  onRetry?: () => void;
}

export function CostRecommendationSummary({
  recommendation,
  onRetry,
}: CostRecommendationSummaryProps) {
  const isFallback = recommendation.kind === 'fallback';
  const rec = recommendation.recommendation;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="size-5 text-primary" aria-hidden />
          <CardTitle className="text-lg">
            {isFallback ? 'Starting point' : 'AI recommendation'}
          </CardTitle>
          <Badge variant="outline">
            {isFallback ? 'Catalog defaults' : 'Suggested'}: {PROVIDER_LABEL[rec.recommendedProvider]}
          </Badge>
        </div>
        <CardDescription>
          A seed you can change — pick any service, size or provider and the totals update live.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isFallback ? (
          <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              <span className="text-balance">{recommendation.presentation.message}</span>
            </div>
            {onRetry && recommendation.presentation.retryable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetry}
                className="shrink-0 gap-1.5"
              >
                <RefreshCw className="size-3.5" />
                Retry AI seed
              </Button>
            ) : null}
          </div>
        ) : null}

        <p className="text-sm text-balance">{rec.rationale}</p>

        {rec.assumptions.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Lightbulb className="size-3.5" aria-hidden />
              Assumptions we made
            </div>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
              {rec.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
