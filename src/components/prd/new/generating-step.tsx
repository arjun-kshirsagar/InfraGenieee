'use client';

/**
 * Feature 1, F3 — the generate submit + long-wait step.
 *
 * This is the terminal stage of `/prd/new`: it takes the assembled, validated
 * `ProjectBrief` and turns it into a saved `PrdDocument`, surviving the 30–60s
 * generation gracefully.
 *
 * Design decisions (see docs/api-contracts.md §generate and the F3 task):
 *
 *  - **No client timeout.** We hand the fetch our own `AbortController` only so
 *    we can cancel on unmount / explicit navigation — never on a timer. The
 *    route's `maxDuration` is 300s.
 *  - **Staged progress, not a dead spinner.** The route exposes no progress
 *    stream, so we drive the stages (`PROGRESS_STAGES`) on a timed heuristic
 *    and show a smooth, asymptotic bar that never hits 100% until the fetch
 *    actually resolves.
 *  - **Expectations up front.** Before the user starts we tell them it takes
 *    about a minute and why.
 *  - **Double-submit is impossible.** A `useRef` in-flight guard plus a
 *    disabled button means a second click / re-entrant call is a no-op. Each
 *    submit is a real paid LLM call, so this is a cost guard, not just UX.
 *  - **beforeunload warning** while a generation is in flight.
 *  - **Never lose the brief.** All logic that could fail lives in
 *    `fetchGenerate`, which never touches storage. On any error we keep the
 *    brief in memory AND it is still in the draft, so Retry is one click.
 *  - **Distinct message per error code**, via `mapGenerateError`. `validation_error`
 *    sends the user back to the form; `llm_not_configured` shows an honest,
 *    no-retry dead-end; everything else offers Retry.
 *
 * All the branching *logic* is in `@/lib/prd/generate-flow` (pure, unit-tested
 * offline). This component is wiring + presentation.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Pencil,
  ArrowRight,
  CheckCircle2,
} from 'lucide-react';

import type { ProjectBrief } from '@/types/prd';
import {
  USER_SCALE_LABEL,
  TRAFFIC_PATTERN_LABEL,
  BUDGET_BAND_LABEL,
} from '@/types/prd';
import {
  fetchGenerate,
  mapGenerateError,
  saveAndRoute,
  PROGRESS_STAGES,
  progressStageIndexAt,
  progressFractionAt,
  type GenerateErrorPresentation,
} from '@/lib/prd/generate-flow';
import { saveDocument, clearDraft } from '@/lib/prd/store';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from '@/components/ui/progress';

export interface GeneratingStepProps {
  brief: ProjectBrief;
  /** Back to the form to edit the brief (used on validation_error + a manual edit). */
  onEditBrief: () => void;
  /**
   * Server issues[] to surface when we bounce back to the form on a
   * validation_error. The parent decides how to display them; we just hand them
   * up. Optional.
   */
  onValidationError?: (issues: { path: string; message: string }[]) => void;
}

type Phase =
  | { name: 'idle' }
  | { name: 'generating' }
  | { name: 'error'; presentation: GenerateErrorPresentation; issues?: { path: string; message: string }[] }
  | { name: 'done' };

/** Tick interval for the progress heuristic. */
const PROGRESS_TICK_MS = 250;

export function GeneratingStep({ brief, onEditBrief, onValidationError }: GeneratingStepProps) {
  const router = useRouter();
  const [phase, setPhase] = React.useState<Phase>({ name: 'idle' });
  const [elapsedMs, setElapsedMs] = React.useState(0);

  // Double-submit guard: a synchronous ref, checked before any state update, so
  // even two clicks in the same tick cannot both start a generation.
  const inFlightRef = React.useRef(false);
  // The AbortController for the current generation — cancelled on unmount.
  const abortRef = React.useRef<AbortController | null>(null);

  // ---- beforeunload warning while generating -----------------------------
  React.useEffect(() => {
    if (phase.name !== 'generating') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set to trigger the prompt.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [phase.name]);

  // ---- progress heuristic ticker while generating ------------------------
  React.useEffect(() => {
    if (phase.name !== 'generating') return;
    // `elapsedMs` is reset to 0 in `generate()` right before we enter this
    // phase, so we don't set state synchronously here (which would trigger a
    // cascading render). We just start ticking from the recorded start.
    const start = Date.now();
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, PROGRESS_TICK_MS);
    return () => window.clearInterval(id);
  }, [phase.name]);

  // ---- cancel any in-flight request on unmount ---------------------------
  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const generate = React.useCallback(async () => {
    // Re-entry guard — the cost bug we must prevent.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    abortRef.current = new AbortController();
    setElapsedMs(0);
    setPhase({ name: 'generating' });

    try {
      const outcome = await fetchGenerate(brief, { signal: abortRef.current.signal });

      if (outcome.kind === 'ok') {
        // Success sequence: save → clearDraft → navigate. Mark done first so the
        // UI shows a settled state during the (near-instant) route transition,
        // and so the beforeunload handler is torn down before we navigate.
        setPhase({ name: 'done' });
        saveAndRoute(outcome.document, {
          save: saveDocument,
          clearDraft,
          navigate: (path) => router.push(path),
        });
        return;
      }

      // Error: keep the brief (it's in memory here and in the draft). If the
      // brief itself is the problem, bounce back to the form.
      if (outcome.presentation.backToForm) {
        onValidationError?.(outcome.issues ?? []);
        onEditBrief();
        return;
      }
      setPhase({ name: 'error', presentation: outcome.presentation, issues: outcome.issues });
    } catch (err) {
      // The only rejection path is an abort (unmount / navigation). If we're
      // still mounted, treat it as a retryable network-ish failure; otherwise
      // the component is gone and this state update is a no-op.
      if ((err as { name?: string })?.name === 'AbortError') {
        // Aborted by unmount — nothing to show.
        return;
      }
      setPhase({ name: 'error', presentation: mapGenerateError('network') });
    } finally {
      inFlightRef.current = false;
    }
  }, [brief, router, onEditBrief, onValidationError]);

  if (phase.name === 'generating') {
    return <GeneratingView elapsedMs={elapsedMs} />;
  }

  if (phase.name === 'done') {
    return <DoneView />;
  }

  if (phase.name === 'error') {
    return (
      <ErrorView
        presentation={phase.presentation}
        issues={phase.issues}
        onRetry={phase.presentation.retryable ? generate : undefined}
        onEditBrief={onEditBrief}
      />
    );
  }

  // idle
  return <IdleView brief={brief} onGenerate={generate} onEditBrief={onEditBrief} />;
}

/* -------------------------------------------------------------------------- */
/* Idle — brief echo + expectations + the (single-fire) Generate button       */
/* -------------------------------------------------------------------------- */

function IdleView({
  brief,
  onGenerate,
  onEditBrief,
}: {
  brief: ProjectBrief;
  onGenerate: () => void;
  onEditBrief: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Sparkles className="size-9 text-primary" />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Ready to generate</h1>
        <p className="text-muted-foreground text-sm text-balance">
          This takes about a minute — the AI is reasoning through your whole product: the
          requirements, the architecture and a task-by-task plan. Hang tight and don&apos;t close
          the tab.
        </p>
      </div>

      <BriefEcho brief={brief} />

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="outline" onClick={onEditBrief} className="gap-2">
          <Pencil className="size-4" />
          Edit brief
        </Button>
        <Button type="button" size="lg" onClick={onGenerate} className="gap-2">
          Generate my PRD &amp; plan
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Generating — staged progress, never a dead spinner                         */
/* -------------------------------------------------------------------------- */

function GeneratingView({ elapsedMs }: { elapsedMs: number }) {
  const activeIndex = progressStageIndexAt(elapsedMs);
  const active = PROGRESS_STAGES[activeIndex];
  const pct = Math.round(progressFractionAt(elapsedMs) * 100);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="size-9 animate-spin text-primary" aria-hidden />
        <h1 className="font-heading text-2xl font-semibold tracking-tight" aria-live="polite">
          {active.label}
        </h1>
        <p className="text-muted-foreground text-sm text-balance" aria-live="polite">
          {active.detail}
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-5 py-5">
          <Progress value={pct} aria-label="Generation progress">
            <ProgressLabel>Generating</ProgressLabel>
            <ProgressValue />
          </Progress>

          {/* Stage checklist — makes the multi-step nature legible. */}
          <ol className="flex flex-col gap-2.5">
            {PROGRESS_STAGES.map((stage, i) => {
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

      <p className="text-muted-foreground text-center text-xs text-balance">
        Keep this tab open. If you leave, the generation is lost and you&apos;ll need to start it
        again — your brief is saved, so you won&apos;t have to retype anything.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Done — brief hand-off state during the route transition                    */
/* -------------------------------------------------------------------------- */

function DoneView() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 py-16 text-center">
      <CheckCircle2 className="size-9 text-primary" aria-hidden />
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Document ready</h1>
      <p className="text-muted-foreground text-sm">Taking you to your PRD…</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Error — one distinct, honest state per code                                */
/* -------------------------------------------------------------------------- */

function ErrorView({
  presentation,
  issues,
  onRetry,
  onEditBrief,
}: {
  presentation: GenerateErrorPresentation;
  issues?: { path: string; message: string }[];
  onRetry?: () => void;
  onEditBrief: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <AlertTriangle className="size-9 text-destructive" aria-hidden />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          {presentation.code === 'llm_not_configured'
            ? "Generation isn\u2019t available"
            : "Generation didn\u2019t finish"}
        </h1>
        <p className="text-muted-foreground text-sm text-balance" role="alert">
          {presentation.message}
        </p>
      </div>

      {issues && issues.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What needs fixing</CardTitle>
            <CardDescription>Fix these on the form, then generate again.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5 text-sm">
              {issues.map((iss, i) => (
                <li key={i} className="flex flex-col">
                  <code className="text-muted-foreground text-xs">{iss.path}</code>
                  <span>{iss.message}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:justify-center">
        <Button type="button" variant="outline" onClick={onEditBrief} className="gap-2">
          <Pencil className="size-4" />
          Edit brief
        </Button>
        {onRetry ? (
          <Button type="button" onClick={onRetry} className="gap-2">
            <RefreshCw className="size-4" />
            Try again
          </Button>
        ) : null}
      </div>

      <p className="text-muted-foreground text-center text-xs">
        Your brief is safe — nothing you typed was lost.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Brief echo — shared read-only summary (the "answers echo" from the wizard)  */
/* -------------------------------------------------------------------------- */

function BriefEcho({ brief }: { brief: ProjectBrief }) {
  const answered = brief.clarifications.filter((c) => c.answer.trim().length > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>What InfraGenie will build from</CardTitle>
        <CardDescription>Review before generation.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <div>
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Idea</p>
          <p className="mt-1 whitespace-pre-wrap">{brief.idea}</p>
        </div>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Scale
            </dt>
            <dd className="mt-0.5">{USER_SCALE_LABEL[brief.context.userScale]}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Traffic
            </dt>
            <dd className="mt-0.5">{TRAFFIC_PATTERN_LABEL[brief.context.trafficPattern]}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Budget
            </dt>
            <dd className="mt-0.5">{BUDGET_BAND_LABEL[brief.context.budgetBand]}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Timeline
            </dt>
            <dd className="mt-0.5">
              {brief.context.timelineWeeks} week{brief.context.timelineWeeks === 1 ? '' : 's'}
            </dd>
          </div>
          {brief.context.constraints ? (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Constraints
              </dt>
              <dd className="mt-0.5">{brief.context.constraints}</dd>
            </div>
          ) : null}
        </dl>

        {answered.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Clarifications
            </p>
            <ul className="flex flex-col gap-2">
              {answered.map((c, i) => (
                <li key={i} className="rounded-md bg-muted/40 p-2.5">
                  <p className="font-medium">{c.question}</p>
                  <p className="text-muted-foreground mt-0.5">{c.answer}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {brief.additionalNotes ? (
          <div>
            <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Additional notes
            </p>
            <p className="mt-1 whitespace-pre-wrap">{brief.additionalNotes}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default GeneratingStep;
