'use client';

/**
 * InfraGenie — questionnaire field renderer.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  F2 INSERTION POINT                                                        │
 * │                                                                            │
 * │  This is the single seam where the questionnaire's field UI lives. The     │
 * │  wizard shell (F1) is intentionally agnostic about how a question renders  │
 * │  — it hands each `QuestionDef` here with its current value and an onChange, │
 * │  and this component decides the widget.                                     │
 * │                                                                            │
 * │  F2 should replace the body of `QuestionField` with real, typed widgets    │
 * │  per `question.kind` (text / textarea / number / select / multi-select /   │
 * │  boolean / tag-list / entity-builder), wired to the shadcn primitives in   │
 * │  `src/components/ui`. Keep the SAME props contract so the shell does not    │
 * │  change:                                                                    │
 * │                                                                            │
 * │      { question, value, onChange }                                          │
 * │                                                                            │
 * │  `onChange(newValue)` gives the shell the new value for `question.path`;    │
 * │  the shell owns state, autosave, and validation gating.                     │
 * │                                                                            │
 * │  For now this is a PLACEHOLDER: a labelled raw <Input> for every question, │
 * │  so the shell is browser-testable end to end before F2 lands.              │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import type { QuestionDef } from '@/types/prd';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface QuestionFieldProps {
  question: QuestionDef;
  /** Current value for this question's path (may be undefined while unanswered). */
  value: unknown;
  /** Report a new value for this question's path back to the shell. */
  onChange: (value: unknown) => void;
}

/** Placeholder field. F2 replaces the widget selection; the props contract stays. */
export function QuestionField({ question, value, onChange }: QuestionFieldProps) {
  const inputId = `q-${question.path.replace(/\./g, '-')}`;
  // Placeholder coerces everything to a string input. F2 will branch on kind.
  const stringValue =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>
        {question.label}
        {question.required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <Input
        id={inputId}
        value={stringValue}
        placeholder={question.placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={question.help ? `${inputId}-help` : undefined}
      />
      {question.help ? (
        <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
          {question.help}
        </p>
      ) : null}
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
        placeholder · {question.kind}
      </p>
    </div>
  );
}
