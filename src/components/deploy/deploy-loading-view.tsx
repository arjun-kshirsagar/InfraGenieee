'use client';

/**
 * `/deploy` loading view. The whole analysis is a FEW SECONDS (a handful of
 * anonymous GitHub reads + pure functions, NO LLM) — deliberately NOT Feature
 * 1's 30–60s — so the stages are short and the bar never fakes a long crawl.
 *
 * The bar approaches a 0.9 cap asymptotically and holds; only the resolved
 * analysis completes it (the parent unmounts this view). The staged heuristic +
 * fraction are pure functions from `@/lib/deploy/client`.
 */

import * as React from 'react';
import { Loader2, CheckCircle2, Rocket } from 'lucide-react';

import {
  DEPLOY_PROGRESS_STAGES,
  deployProgressStageIndexAt,
  deployProgressFractionAt,
} from '@/lib/deploy/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';

const TICK_MS = 200;

export interface DeployLoadingViewProps {
  /** A human label for the repo under analysis (e.g. `owner/repo`). */
  label: string;
  onCancel: () => void;
}

export function DeployLoadingView({ label, onCancel }: DeployLoadingViewProps) {
  const [elapsedMs, setElapsedMs] = React.useState(0);

  React.useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setElapsedMs(Date.now() - start), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const activeIndex = deployProgressStageIndexAt(elapsedMs);
  const active = DEPLOY_PROGRESS_STAGES[activeIndex];
  const pct = Math.round(deployProgressFractionAt(elapsedMs) * 100);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Rocket className="size-8 text-primary" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight" aria-live="polite">
          {active.label}
        </h1>
        <p className="text-sm text-muted-foreground text-balance" aria-live="polite">
          Analyzing <span className="font-mono font-medium text-foreground">{label}</span>.{' '}
          {active.detail}
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-5 py-5">
          <Progress value={pct} aria-label="Analyzing repository">
            <ProgressLabel>Analyzing</ProgressLabel>
            <ProgressValue />
          </Progress>

          <ol className="flex flex-col gap-2.5">
            {DEPLOY_PROGRESS_STAGES.map((stage, i) => {
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

      <div className="flex justify-center">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
