'use client';

/**
 * `/cost` blocking-error view. Reached only when the data the explorer NEEDS —
 * the catalog or the price books — could not be loaded (a recommendation
 * failure does NOT land here; it degrades to a fallback seed inside the
 * explorer). Each contract error code maps to distinct, non-technical copy via
 * `mapCostError`; retryable codes get a one-click Retry, and a config fault
 * says plainly it isn't the user's fault.
 */

import { AlertTriangle, RefreshCw, ArrowLeft } from 'lucide-react';

import type { CostErrorPresentation } from '@/lib/cost/client';
import { Button } from '@/components/ui/button';

export interface CostErrorViewProps {
  title: string;
  presentation: CostErrorPresentation;
  onRetry?: () => void;
  onChangePrd: () => void;
}

export function CostErrorView({ title, presentation, onRetry, onChangePrd }: CostErrorViewProps) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <AlertTriangle className="size-8 text-destructive" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">
          {presentation.configFault ? "Cost data isn\u2019t available" : "We couldn\u2019t load the cost data"}
        </h1>
        <p className="text-sm text-muted-foreground text-balance" role="alert">
          Costing out <span className="font-medium text-foreground">{title}</span> —{' '}
          {presentation.message}
        </p>
      </div>

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:justify-center">
        <Button type="button" variant="outline" onClick={onChangePrd} className="gap-2">
          <ArrowLeft className="size-4" />
          Choose a different PRD
        </Button>
        {onRetry ? (
          <Button type="button" onClick={onRetry} className="gap-2">
            <RefreshCw className="size-4" />
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
