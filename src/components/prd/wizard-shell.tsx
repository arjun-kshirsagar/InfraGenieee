'use client';

/**
 * InfraGenie — Feature 1 questionnaire wizard shell.
 *
 * Responsibilities (F1):
 *   - Iterate the data-driven `QUESTIONNAIRE` definition (never hardcode steps).
 *   - Own the single source of draft state and pass it down.
 *   - Step navigation (Back / Next / Generate), progress indicator.
 *   - Debounced draft autosave to localStorage, and a resume banner on mount.
 *
 * NOT F1's job (later tasks):
 *   - Real per-kind field widgets → F2 (see src/components/prd/question-field.tsx,
 *     the documented `renderQuestion` seam below).
 *   - Wiring the Generate button to POST /api/prd/generate → F3 (the endpoint
 *     does not exist yet; the button is intentionally inert here).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QUESTIONNAIRE } from '@/lib/prd/questionnaire';
import type { QuestionDef, QuestionnaireDraft } from '@/types/prd';
import { getAnswer, setAnswer } from '@/lib/prd/draft';
import { loadDraft, saveDraft, clearDraft } from '@/lib/prd/store';
import { QuestionField } from '@/components/prd/question-field';
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

/** Evaluate a question's `visibleWhen` guard against the current draft. */
function isVisible(question: QuestionDef, draft: QuestionnaireDraft): boolean {
  if (!question.visibleWhen) return true;
  return getAnswer(draft, question.visibleWhen.path) === question.visibleWhen.equals;
}

export function WizardShell() {
  const steps = QUESTIONNAIRE.steps;

  const [draft, setDraft] = useState<QuestionnaireDraft>({});
  const [stepIndex, setStepIndex] = useState(0);
  // A recovered draft awaiting the user's Resume / Start fresh decision.
  const [pendingDraft, setPendingDraft] = useState<QuestionnaireDraft | null>(null);
  // Have we finished the mount-time load? Gates autosave so we don't overwrite
  // a recovered draft before the user decides.
  const [hydrated, setHydrated] = useState(false);

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* --- Mount: try to recover a draft and offer to resume ----------------- */
  useEffect(() => {
    // localStorage is browser-only, so this recovery must happen post-mount
    // (not during render/SSR). Setting state synchronously here is intentional.
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
    // Don't autosave until the resume decision is made, and don't persist an
    // empty draft (nothing to resume from).
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

  /**
   * The `renderQuestion` seam. The shell delegates every question to this slot;
   * F2 swaps the widget by replacing <QuestionField> (same props contract).
   */
  const renderQuestion = useCallback(
    (question: QuestionDef) => (
      <QuestionField
        key={question.path}
        question={question}
        value={getAnswer(draft, question.path)}
        onChange={(value) => setDraft((prev) => setAnswer(prev, question.path, value))}
      />
    ),
    [draft],
  );

  const step = steps[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;

  const visibleQuestions = useMemo(
    () => step.questions.filter((q) => isVisible(q, draft)),
    [step, draft],
  );

  const goBack = () => setStepIndex((i) => Math.max(0, i - 1));
  const goNext = () => setStepIndex((i) => Math.min(steps.length - 1, i + 1));

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 px-6 py-10 md:grid-cols-[260px_1fr]">
      {/* Left rail: progress + step list */}
      <aside className="md:sticky md:top-10 md:self-start">
        <StepIndicator steps={steps} current={stepIndex} />
      </aside>

      {/* Right: the active step */}
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

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{step.title}</CardTitle>
            <CardDescription>{step.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {visibleQuestions.map((q) => renderQuestion(q))}
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={goBack}
            disabled={isFirst}
            aria-label="Go to previous step"
          >
            Back
          </Button>

          {isLast ? (
            <Button
              type="button"
              // Wired to POST /api/prd/generate in F3; inert for now.
              disabled
              aria-label="Generate PRD (available once generation lands)"
              title="Generation is wired up in a later task"
            >
              Generate
            </Button>
          ) : (
            <Button type="button" onClick={goNext} aria-label="Go to next step">
              Next
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
