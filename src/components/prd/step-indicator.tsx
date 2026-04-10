'use client';

/**
 * InfraGenie — wizard step indicator.
 *
 * Renders a shadcn `Progress` bar plus a per-step list showing which steps are
 * completed / current / upcoming, with each step's `title` and `description`.
 * Purely presentational; the shell owns the current index and step definitions.
 */

import type { QuestionnaireStep } from '@/types/prd';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

export interface StepIndicatorProps {
  steps: QuestionnaireStep[];
  /** Zero-based index of the active step. */
  current: number;
}

export function StepIndicator({ steps, current }: StepIndicatorProps) {
  const total = steps.length;
  // Progress reflects the current step position through the flow.
  const percent = total > 1 ? Math.round((current / (total - 1)) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">
          Step {current + 1} of {total}
        </span>
        <span className="text-muted-foreground tabular-nums">{percent}%</span>
      </div>

      <Progress value={percent} aria-label={`Progress: step ${current + 1} of ${total}`} />

      <ol className="mt-2 flex flex-col gap-1" aria-label="Questionnaire steps">
        {steps.map((step, i) => {
          const state = i < current ? 'completed' : i === current ? 'current' : 'upcoming';
          return (
            <li
              key={step.key}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'flex items-start gap-3 rounded-lg px-3 py-2 transition-colors',
                state === 'current' && 'bg-muted',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                  state === 'completed' && 'border-primary bg-primary text-primary-foreground',
                  state === 'current' && 'border-primary text-primary',
                  state === 'upcoming' && 'border-border text-muted-foreground',
                )}
              >
                {state === 'completed' ? '✓' : i + 1}
              </span>
              <span className="flex flex-col">
                <span
                  className={cn(
                    'text-sm font-medium leading-tight',
                    state === 'upcoming' && 'text-muted-foreground',
                  )}
                >
                  {step.title}
                </span>
                <span className="text-xs text-muted-foreground">{step.description}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
