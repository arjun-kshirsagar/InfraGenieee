'use client';

/**
 * Feature 1, step 2 — the adaptive clarifier + "anything else?" notes.
 *
 * This component sits AFTER F1's idea+context form. It:
 *
 *   1. Calls `POST /api/prd/clarify` on mount (real call, ~2–5s) and shows a
 *      short, non-blocking loading state.
 *   2. If the response has **0 questions** — the common case — it skips the
 *      questions entirely and lands on the notes step. It NEVER renders an
 *      empty "clarifying questions" screen.
 *   3. If the response has **1–3 questions**, it renders each with its `why`,
 *      one-tap suggestion chips, and a skip affordance. Every question is
 *      optional: an empty answer is contract-valid and means "AI, infer it".
 *   4. If the call **fails** (503/500/network/timeout/off-contract) it shows an
 *      unobtrusive note and lets the user proceed straight to the notes step.
 *      This is the single most important behaviour: a failing clarifier must
 *      never block generation.
 *   5. Collects the optional "Anything else to add?" free text, assembles the
 *      final `ProjectBrief`, validates it against `projectBriefSchema`, and
 *      hands it to `onComplete`. `onBack` returns to F1 without data loss.
 *
 * All logic lives in `@/lib/prd/clarify-flow` (pure, unit-tested). This file is
 * wiring + rendering only.
 */

import * as React from 'react';
import { ArrowLeft, ArrowRight, Loader2, Sparkles, TriangleAlert } from 'lucide-react';

import {
  fetchClarify,
  finalizeBrief,
  buildClarifications,
  clarifyDraftPatch,
  seedAnswersFromClarifications,
  type ClarifyInput,
  type ClarifyAnswers,
} from '@/lib/prd/clarify-flow';
import type { Clarification, ClarifyQuestion, ProjectBrief } from '@/types/prd';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/** How the clarify call resolved — drives what the body renders. */
type Phase =
  | { status: 'loading' }
  | { status: 'questions'; questions: ClarifyQuestion[] }
  | { status: 'notes' } // 0-question fast path
  | { status: 'failed' }; // best-effort failure — proceed anyway

const NOTES_MAX = 2000;

export interface ClarifierStepProps {
  /** The validated idea + context from F1. */
  input: ClarifyInput;
  /** Previously-saved clarifications, for resuming a draft mid-flow. */
  savedClarifications?: Clarification[];
  /** Previously-saved notes, for resuming a draft mid-flow. */
  savedNotes?: string;
  /** Called with the complete, validated ProjectBrief when the user proceeds. */
  onComplete: (brief: ProjectBrief) => void;
  /** Return to F1 to edit idea/context. F1 restores from the draft. */
  onBack: () => void;
  /**
   * Persist clarifier progress into the draft (clarifications + notes). Called
   * as the user edits so a reload doesn't lose answers. Optional.
   */
  onAutosave?: (patch: { clarifications?: Clarification[]; additionalNotes?: string }) => void;
}

export function ClarifierStep({
  input,
  savedClarifications,
  savedNotes,
  onComplete,
  onBack,
  onAutosave,
}: ClarifierStepProps) {
  const [phase, setPhase] = React.useState<Phase>({ status: 'loading' });
  const [answers, setAnswers] = React.useState<ClarifyAnswers>({});
  const [notes, setNotes] = React.useState<string>(savedNotes ?? '');
  const [assembleError, setAssembleError] = React.useState<string | null>(null);

  // ---- Kick off the clarify call once, on mount --------------------------
  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    // Phase already starts as 'loading' (initial state), so we don't set it
    // here — doing so synchronously in the effect body triggers a cascading
    // render. The async resolution below moves us off 'loading'.
    void fetchClarify(input, { signal: controller.signal }).then((outcome) => {
      if (!active) return;
      if (outcome.kind === 'questions') {
        setAnswers(seedAnswersFromClarifications(outcome.questions, savedClarifications));
        setPhase({ status: 'questions', questions: outcome.questions });
      } else if (outcome.kind === 'none') {
        setPhase({ status: 'notes' });
      } else {
        setPhase({ status: 'failed' });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
    // input is stable for the life of this step (F1 handed it in); we only
    // want to fire the clarify call once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Autosave clarifier progress (debounced) ---------------------------
  const questionsForSave =
    phase.status === 'questions' ? phase.questions : undefined;
  React.useEffect(() => {
    if (!onAutosave) return;
    const handle = window.setTimeout(() => {
      const clarifications = questionsForSave
        ? buildClarifications(questionsForSave, answers)
        : [];
      onAutosave(clarifyDraftPatch({ clarifications, additionalNotes: notes }));
    }, 500);
    return () => window.clearTimeout(handle);
  }, [answers, notes, questionsForSave, onAutosave]);

  function setAnswer(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  function proceed(questions: ClarifyQuestion[] | null) {
    const result = questions
      ? finalizeBrief({ input, questions, answers, additionalNotes: notes })
      : finalizeBrief({ input, questions: [], answers: {}, additionalNotes: notes });
    if (result.ok) {
      setAssembleError(null);
      onComplete(result.brief);
    } else {
      // Extremely unlikely — F1 already validated idea+context — but never
      // hand off an invalid brief. Surface it rather than failing silently.
      setAssembleError(result.issues[0] ?? 'Could not assemble your brief.');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Loading                                                                */
  /* ---------------------------------------------------------------------- */
  if (phase.status === 'loading') {
    return (
      <StepShell>
        <div
          className="flex flex-col items-center gap-4 py-16 text-center"
          role="status"
          aria-live="polite"
        >
          <div className="relative">
            <Sparkles className="size-8 text-primary" />
            <Loader2 className="absolute -right-3 -top-1 size-4 animate-spin text-muted-foreground" />
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-medium">Reading your idea…</p>
            <p className="text-muted-foreground text-sm">
              InfraGenie is checking whether it needs to ask anything before generating.
            </p>
          </div>
        </div>
      </StepShell>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Questions (1–3)                                                        */
  /* ---------------------------------------------------------------------- */
  if (phase.status === 'questions') {
    return (
      <StepShell>
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              A couple of quick questions
            </h1>
          </div>
          <p className="text-muted-foreground text-sm">
            InfraGenie wants to nail a few things before it designs your product. Every question is
            optional — <span className="font-medium">skip anything</span>{' '}
            and it&apos;ll make a sensible assumption and tell you what it decided.
          </p>
        </header>

        <div className="flex flex-col gap-4">
          {phase.questions.map((q, i) => (
            <QuestionCard
              key={q.id}
              index={i + 1}
              question={q}
              value={answers[q.id] ?? ''}
              onChange={(v) => setAnswer(q.id, v)}
            />
          ))}
        </div>

        <NotesField value={notes} onChange={setNotes} />

        {assembleError ? <AssembleError message={assembleError} /> : null}

        <StepFooter
          onBack={onBack}
          onContinue={() => proceed(phase.questions)}
          continueLabel="Generate"
        />
      </StepShell>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Notes-only (0 questions) and Failed (best-effort) share the notes step */
  /* ---------------------------------------------------------------------- */
  const failed = phase.status === 'failed';
  return (
    <StepShell>
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" />
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {failed ? 'Ready to generate' : 'Looks clear — ready to generate'}
          </h1>
        </div>
        <p className="text-muted-foreground text-sm">
          {failed
            ? 'InfraGenie will design your product from what you told us.'
            : 'InfraGenie has everything it needs and will infer the rest. Add anything else below, or go straight to generation.'}
        </p>
      </header>

      {failed ? (
        <div
          className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/40 p-3 text-sm"
          role="note"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            We couldn&apos;t fetch clarifying questions just now — no problem. Your PRD will still be
            generated from your idea and context.
          </p>
        </div>
      ) : null}

      <NotesField value={notes} onChange={setNotes} />

      {assembleError ? <AssembleError message={assembleError} /> : null}

      <StepFooter onBack={onBack} onContinue={() => proceed(null)} continueLabel="Generate" />
    </StepShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Sub-components                                                             */
/* -------------------------------------------------------------------------- */

function StepShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">{children}</div>;
}

function QuestionCard({
  index,
  question,
  value,
  onChange,
}: {
  index: number;
  question: ClarifyQuestion;
  value: string;
  onChange: (v: string) => void;
}) {
  const inputId = `clarify-${question.id}`;
  const whyId = `${inputId}-why`;
  const answered = value.trim().length > 0;

  return (
    <Card>
      <CardHeader className="gap-1.5">
        <CardTitle className="flex items-start gap-2 text-base font-medium">
          <span
            className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums text-muted-foreground"
            aria-hidden
          >
            {index}
          </span>
          <span>{question.question}</span>
        </CardTitle>
        <CardDescription id={whyId} className="pl-7">
          {question.why}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 pl-7">
        {question.suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested answers">
            {question.suggestions.map((s) => {
              const selected = value.trim() === s.trim();
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onChange(selected ? '' : s)}
                  className={
                    selected
                      ? 'rounded-full border border-primary bg-primary/10 px-3 py-1 text-sm font-medium text-primary transition-colors'
                      : 'rounded-full border border-border bg-background px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted'
                  }
                >
                  {s}
                </button>
              );
            })}
          </div>
        ) : null}

        <Label htmlFor={inputId} className="sr-only">
          Your answer to: {question.question}
        </Label>
        <Textarea
          id={inputId}
          rows={2}
          placeholder="Type your answer, tap a suggestion, or skip…"
          aria-describedby={whyId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-16 resize-y"
        />

        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-xs">
            {answered ? 'Answered' : 'Optional — skip to let the AI infer it'}
          </span>
          {answered ? (
            <button
              type="button"
              onClick={() => onChange('')}
              className="text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
            >
              Skip this
            </button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function NotesField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const over = value.length > NOTES_MAX;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Anything else to add?</CardTitle>
        <CardDescription>
          Optional. Anything that didn&apos;t fit above — a must-have feature, something to leave out
          of v1, a preference.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Label htmlFor="additional-notes" className="sr-only">
          Anything else to add
        </Label>
        <Textarea
          id="additional-notes"
          rows={3}
          placeholder="e.g. Pickup only for v1 — no delivery. Prefer Postgres over a NoSQL store."
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={over ? true : undefined}
          className="min-h-20 resize-y"
        />
        <div className="flex justify-end">
          <span
            className={
              over
                ? 'text-xs tabular-nums text-destructive'
                : 'text-muted-foreground text-xs tabular-nums'
            }
            aria-hidden
          >
            {value.length.toLocaleString()}/{NOTES_MAX.toLocaleString()}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function AssembleError({ message }: { message: string }) {
  return (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  );
}

function StepFooter({
  onBack,
  onContinue,
  continueLabel,
}: {
  onBack: () => void;
  onContinue: () => void;
  continueLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Button type="button" variant="ghost" onClick={onBack} className="gap-2">
        <ArrowLeft className="size-4" />
        Back
      </Button>
      <Button type="button" size="lg" onClick={onContinue} className="gap-2">
        {continueLabel}
        <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}

export default ClarifierStep;
