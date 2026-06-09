'use client';

/**
 * `/cost` loading view. The slow call is `GET /api/cost/prices` — a cold cache
 * does real vendor fetches — so we show real staged progress rather than a bare
 * spinner, and impose NO client timeout (the parent's `AbortController` is the
 * only cancellation). The bar never hits 100% on a timer; only the resolved
 * load completes it (the parent unmounts this view).
 *
 * The staged heuristic + fraction are pure functions from `@/lib/cost/client`.
 */

import * as React from 'react';
import { Loader2, CheckCircle2, Wallet } from 'lucide-react';

import {
  COST_PROGRESS_STAGES,
  costProgressStageIndexAt,
  costProgressFractionAt,
} from '@/lib/cost/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';

const TICK_MS = 250;

export interface CostLoadingViewProps {
  title: string;
  onCancel: () => void;
}

export function CostLoadingView({ title, onCancel }: CostLoadingViewProps) {
  const [elapsedMs, setElapsedMs] = React.useState(0);

  React.useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setElapsedMs(Date.now() - start), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const activeIndex = costProgressStageIndexAt(elapsedMs);
  const active = COST_PROGRESS_STAGES[activeIndex];
  const pct = Math.round(costProgressFractionAt(elapsedMs) * 100);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Wallet className="size-8 text-primary" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight" aria-live="polite">
          {active.label}
        </h1>
        <p className="text-sm text-muted-foreground text-balance" aria-live="polite">
          Costing out <span className="font-medium text-foreground">{title}</span>. {active.detail}
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-5 py-5">
          <Progress value={pct} aria-label="Loading cost data">
            <ProgressLabel>Loading</ProgressLabel>
            <ProgressValue />
          </Progress>

          <ol className="flex flex-col gap-2.5">
            {COST_PROGRESS_STAGES.map((stage, i) => {
              const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending';
              return (
                <li key={stage.label} className="flex items-center gap-2.5 text-sm">
                  {state === 'done' ? (
                    <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />
                  ) : state === 'active' ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
                  ) : (
                    <span
                      className="size-4 shrink-0 rounded-full border border-muted-foreground/30"
                      aria-hidden
                    />
                  )}
                  <span
                    className={
                      state === 'pending'
                        ? 'text-muted-foreground'
                        : state === 'active'
                          ? 'font-medium'
                          : 'text-muted-foreground line-through decoration-muted-foreground/40'
                    }
                  >
                    {stage.label.replace(/…$/, '')}
                  </span>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      <div className="flex flex-col items-center gap-2">
        <p className="text-center text-xs text-muted-foreground text-balance">
          Live prices can take a moment on a cold cache — we don&apos;t time out early. Hang tight.
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Choose a different PRD
        </Button>
      </div>
    </div>
  );
}
