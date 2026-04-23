'use client';

/**
 * InfraGenie — Feature 1 questionnaire wizard shell.
 *
 * Responsibilities:
 *   - Iterate the data-driven `QUESTIONNAIRE` definition (never hardcode steps).
 *   - Own the single source of draft state and pass it down.
 *   - Step navigation with per-step schema validation gating (F3).
 *   - Debounced draft autosave to localStorage, and a resume banner on mount.
 *   - Review-before-generate, submit to POST /api/prd/generate, and full error
 *     mapping (400 validation → jump to step; 500 / network → toast). (F3)
 *
 * The tricky, non-visual logic (step schema selection, server `issues[].path`
 * → step mapping) lives in `wizard-validation.ts` as pure, unit-tested
 * functions. This component is the React shell around them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { QUESTIONNAIRE } from '@/lib/prd/questionnaire';
import {
  generateResponseSchema,
  apiErrorSchema,
  type QuestionDef,
  type QuestionnaireDraft,
} from '@/types/prd';
import { getAnswer, setAnswer } from '@/lib/prd/draft';
import { loadDraft, saveDraft, clearDraft, saveDocument } from '@/lib/prd/store';
import {
  validateStep,
  mapServerIssues,
  type FieldErrors,
} from '@/components/prd/wizard-validation';
import { QuestionField } from '@/components/prd/question-field';
import { ReviewSummary } from '@/components/prd/review-summary';
import { StepIndicator } from '@/components/prd/step-indicator';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const AUTOSAVE_DEBOUNCE_MS = 500;
const GENERATE_ENDPOINT = '/api/prd/generate';

/** Evaluate a question's `visibleWhen` guard against the current draft. */
function isVisible(question: QuestionDef, draft: QuestionnaireDraft): boolean {
  if (!question.visibleWhen) return true;
  return getAnswer(draft, question.visibleWhen.path) === question.visibleWhen.equals;
}

/** DOM id the QuestionField assigns to a question's control (for focus). */
function fieldElementId(path: string): string {
  return `q-${path.replace(/\./g, '-')}`;
}

type SubmitState = 'idle' | 'submitting';

export function WizardShell() {
  const router = useRouter();
  const steps = QUESTIONNAIRE.steps;

  const [draft, setDraft] = useState<QuestionnaireDraft>({});
  const [stepIndex, setStepIndex] = useState(0);
  // Show inline validation for a step only after the user tries to advance past
  // it (or the server rejects it) — don't nag on first sight.
  const [validatedSteps, setValidatedSteps] = useState<Record<string, boolean>>({});
  // Server-reported field errors per step key, from a 400 validation_error.
  const [serverErrors, setServerErrors] = useState<Partial<Record<string, FieldErrors>>>({});
  const [reviewing, setReviewing] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');

  const [pendingDraft, setPendingDraft] = useState<QuestionnaireDraft | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Synchronous double-submit guard. A ref (not state) so the check is atomic
  // within one click handler — state updaters are async and can't gate a
  // rapid double click reliably.
  const inFlightRef = useRef(false);

  /* --- Mount: try to recover a draft and offer to resume ----------------- */
  useEffect(() => {
    const saved = loadDraft();
    if (saved && Object.keys(saved).length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingDraft(saved);
    } else {
      setHydrated(true);
    }
  }, []);

  /* --- Debounced autosave ------------------------------------------------- */
  useEffect(() => {
    if (!hydrated) return;
    if (Object.keys(draft).length === 0) return;

    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      saveDraft(draft);
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [draft, hydrated]);

  const handleResume = useCallback(() => {
    if (pendingDraft) setDraft(pendingDraft);
    setPendingDraft(null);
    setHydrated(true);
  }, [pendingDraft]);

  const handleStartFresh = useCallback(() => {
    clearDraft();
    setDraft({});
    setPendingDraft(null);
    setHydrated(true);
  }, []);

  const step = steps[stepIndex];
  const stepKey = step.key;
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;

  const showErrorsForStep = validatedSteps[stepKey] === true;
  const stepServerErrors = serverErrors[stepKey];

  /**
   * Focus the control for a field within the current step (by DOM id) so a
   * blocked Next / server 400 lands the cursor on the offending input.
   */
  const focusField = useCallback((path: string) => {
    // Defer to the next frame so the step has rendered.
    requestAnimationFrame(() => {
      // Preferred: the control carries the canonical id (text/textarea/number/
      // select-trigger). For kinds without a single focusable id (multi-select,
      // boolean, tag/entity), fall back to the first focusable control inside
      // the question's wrapper so focus never silently no-ops.
      const byId = document.getElementById(fieldElementId(path));
      if (byId) {
        (byId as HTMLElement).focus();
        return;
      }
      const wrapper = document.querySelector(`[data-field="${path}"]`);
      const focusable = wrapper?.querySelector<HTMLElement>(
        'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    });
  }, []);

  const renderQuestion = useCallback(
    (question: QuestionDef) => (
      <QuestionField
        key={question.path}
        question={question}
        value={getAnswer(draft, question.path)}
        read={(path) => getAnswer(draft, path)}
        showError={showErrorsForStep}
        onChange={(value) => {
          setDraft((prev) => setAnswer(prev, question.path, value));
          // Editing a field clears its stale server error.
          setServerErrors((prev) => {
            const forStep = prev[stepKey];
            const [, field] = question.path.split('.');
            if (!forStep || !(field in forStep)) return prev;
            const nextForStep = { ...forStep };
            delete nextForStep[field];
            return { ...prev, [stepKey]: nextForStep };
          });
        }}
      />
    ),
    [draft, showErrorsForStep, stepKey],
  );

  const visibleQuestions = useMemo(
    () => step.questions.filter((q) => isVisible(q, draft)),
    [step, draft],
  );

  /** Validate the current step's slice and gate advancement. */
  const validateCurrentStep = useCallback((): boolean => {
    const slice = (draft as Record<string, unknown>)[stepKey];
    const result = validateStep(stepKey, slice);
    setValidatedSteps((prev) => ({ ...prev, [stepKey]: true }));
    if (!result.ok && result.firstInvalidField) {
      focusField(`${stepKey}.${result.firstInvalidField}`);
    }
    return result.ok;
  }, [draft, stepKey, focusField]);

  const goBack = () => {
    if (reviewing) {
      setReviewing(false);
      return;
    }
    setStepIndex((i) => Math.max(0, i - 1));
  };

  const goNext = () => {
    if (!validateCurrentStep()) return;
    if (isLast) {
      setReviewing(true);
      return;
    }
    setStepIndex((i) => Math.min(steps.length - 1, i + 1));
  };

  /** Jump back to a step from the review screen's Edit links. */
  const editStep = useCallback((index: number) => {
    setReviewing(false);
    setStepIndex(index);
  }, []);

  /* --- Submit ------------------------------------------------------------- */
  // Stable retry handle so toast action closures don't reference the callback
  // before it's declared (and so React Compiler is happy with a stable fn).
  const handleGenerateRef = useRef<() => void>(() => {});
  const retry = useCallback(() => handleGenerateRef.current(), []);

  const handleGenerate = useCallback(async () => {
    // Hard, synchronous guard against double submission (double click / Enter).
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitState('submitting');
    setServerErrors({});

    const done = () => {
      inFlightRef.current = false;
      setSubmitState('idle');
    };

    let res: Response;
    try {
      res = await fetch(GENERATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: draft }),
      });
    } catch {
      done();
      toast.error('Could not reach the server', {
        description: 'Check your connection and try again.',
        action: { label: 'Retry', onClick: retry },
      });
      return;
    }

    // Parse the body once; tolerate non-JSON.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      done();
      toast.error('Unexpected response from the server', {
        description: 'The server returned something we could not read. Please retry.',
        action: { label: 'Retry', onClick: retry },
      });
      return;
    }

    if (res.ok) {
      const parsed = generateResponseSchema.safeParse(body);
      if (!parsed.success) {
        // A malformed 200 is treated as an error, never rendered.
        done();
        toast.error('The generated document was invalid', {
          description: 'InfraGenie returned an unexpected shape. Please retry.',
          action: { label: 'Retry', onClick: retry },
        });
        return;
      }
      const { document } = parsed.data;
      saveDocument(document);
      clearDraft();
      // Leave submitState 'submitting' (button disabled) through navigation so
      // it can't refire while the route transitions.
      router.push(`/prd/${document.id}`);
      return;
    }

    // Non-2xx: try to read the standard error envelope.
    done();
    const errorParsed = apiErrorSchema.safeParse(body);
    const code = errorParsed.success ? errorParsed.data.error.code : undefined;

    if (res.status === 400 && code === 'validation_error') {
      const issues = errorParsed.success ? errorParsed.data.error.issues ?? [] : [];
      const mapped = mapServerIssues(issues);
      setServerErrors(mapped.byStep);
      // Also surface each offending step's inline field errors.
      setValidatedSteps((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(mapped.byStep)) next[key] = true;
        return next;
      });
      if (mapped.firstStepIndex >= 0) {
        setReviewing(false);
        setStepIndex(mapped.firstStepIndex);
        const stepK = steps[mapped.firstStepIndex].key;
        const fieldErrors = mapped.byStep[stepK];
        const firstField = fieldErrors ? Object.keys(fieldErrors)[0] : undefined;
        if (firstField) focusField(`${stepK}.${firstField}`);
        toast.error('Some answers need fixing', {
          description: 'We jumped you to the first field that needs attention.',
        });
      } else {
        // Couldn't map any issue to a step — show a generic toast.
        toast.error('Some answers were rejected', {
          description: errorParsed.success
            ? errorParsed.data.error.message
            : 'Please review your answers and try again.',
        });
      }
      return;
    }

    // 500 generation_failed, or any other non-validation error.
    toast.error('Generation failed', {
      description:
        errorParsed.success && errorParsed.data.error.message
          ? errorParsed.data.error.message
          : 'Something went wrong generating your PRD. Your answers are safe — please retry.',
      action: { label: 'Retry', onClick: retry },
    });
  }, [draft, router, steps, focusField, retry]);

  // Keep the retry handle pointing at the latest handler.
  useEffect(() => {
    handleGenerateRef.current = () => void handleGenerate();
  }, [handleGenerate]);

  const submitting = submitState === 'submitting';

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 px-6 py-10 md:grid-cols-[260px_1fr]">
      {/* Left rail: progress + step list */}
      <aside className="md:sticky md:top-10 md:self-start">
        <StepIndicator steps={steps} current={reviewing ? steps.length - 1 : stepIndex} />
      </aside>

      {/* Right: the active step or review */}
      <section className="flex flex-col gap-6">
        {pendingDraft ? (
          <div
            role="region"
            aria-label="Resume draft"
            className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-sm">
              You have a saved draft in progress. Resume where you left off?
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={handleResume}>
                Resume
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={handleStartFresh}>
                Start fresh
              </Button>
            </div>
          </div>
        ) : null}

        {reviewing ? (
          <ReviewSummary draft={draft} onEditStep={editStep} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">{step.title}</CardTitle>
              <CardDescription>{step.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {stepServerErrors && Object.keys(stepServerErrors).length > 0 ? (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                >
                  <p className="font-medium">Please fix the following:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {Object.entries(stepServerErrors).map(([field, message]) => (
                      <li key={field}>{message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {visibleQuestions.map((q) => renderQuestion(q))}
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={goBack}
            disabled={(isFirst && !reviewing) || submitting}
            aria-label={reviewing ? 'Back to the last step' : 'Go to previous step'}
          >
            Back
          </Button>

          {reviewing ? (
            <Button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={submitting}
              aria-busy={submitting || undefined}
              aria-label="Generate PRD"
            >
              {submitting ? 'Generating…' : 'Generate'}
            </Button>
          ) : (
            <Button type="button" onClick={goNext} aria-label="Go to next step">
              {isLast ? 'Review' : 'Next'}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
