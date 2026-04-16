'use client';

/**
 * InfraGenie — questionnaire field renderer (F2).
 *
 * The single seam the wizard shell (F1) delegates every question to. It switches
 * on `question.kind` and renders the matching shadcn control, fully driven by the
 * `QuestionDef` — there is deliberately ZERO question-specific branching, so
 * adding a question to `questionnaire.ts` needs no change here.
 *
 * Props contract (unchanged from F1): `{ question, value, onChange }`, plus an
 * OPTIONAL `read` so the field can self-evaluate `visibleWhen` and an optional
 * `showError` gate. `onChange(newValue)` reports the value for `question.path`;
 * the shell still owns state, autosave, and step gating.
 *
 * The tricky logic (visibility predicate, number coercion, validation) lives in
 * `field-logic.ts` as pure functions so it is unit-testable without a DOM.
 */

import { useState } from 'react';
import { XIcon } from 'lucide-react';
import type { QuestionDef } from '@/types/prd';
import {
  type AnswerReader,
  isQuestionVisible,
  coerceNumberInput,
  validateAnswer,
  addTag,
  removeTagAt,
} from '@/components/prd/field-logic';
import { EntityBuilder } from '@/components/prd/entity-builder';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface QuestionFieldProps {
  question: QuestionDef;
  /** Current value for this question's path (may be undefined while unanswered). */
  value: unknown;
  /** Report a new value for this question's path back to the shell. */
  onChange: (value: unknown) => void;
  /**
   * Optional reader over sibling answers, used to evaluate `visibleWhen`. When
   * provided and the guard fails, the field renders nothing. When omitted the
   * shell is assumed to have already filtered invisible questions.
   */
  read?: AnswerReader;
  /** When true, render the validation error (shell may gate this until submit). */
  showError?: boolean;
}

export function QuestionField({
  question,
  value,
  onChange,
  read,
  showError = true,
}: QuestionFieldProps) {
  const inputId = `q-${question.path.replace(/\./g, '-')}`;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;

  // Self-guard on visibleWhen when a reader is available.
  if (read && !isQuestionVisible(question, read)) return null;

  const error = showError ? validateAnswer(question, value) : null;
  const describedBy =
    [question.help ? helpId : null, error ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  const control = renderControl({
    question,
    value,
    onChange,
    inputId,
    describedBy,
    invalid: Boolean(error),
    errorId,
  });

  // The entity-builder renders its own error + labels internally.
  const isEntity = question.kind === 'entity-builder';

  return (
    <div className="flex flex-col gap-1.5" data-slot="question-field" data-kind={question.kind}>
      {isEntity ? (
        <span className="text-sm leading-none font-medium">
          {question.label}
          {question.required ? <span className="text-destructive"> *</span> : null}
        </span>
      ) : question.kind === 'boolean' ? (
        <span className="text-sm leading-none font-medium">
          {question.label}
          {question.required ? <span className="text-destructive"> *</span> : null}
        </span>
      ) : (
        <Label htmlFor={inputId}>
          {question.label}
          {question.required ? <span className="text-destructive"> *</span> : null}
        </Label>
      )}

      {question.help ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {question.help}
        </p>
      ) : null}

      {control}

      {!isEntity && error ? (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Per-kind controls                                                          */
/* -------------------------------------------------------------------------- */

interface ControlProps {
  question: QuestionDef;
  value: unknown;
  onChange: (value: unknown) => void;
  inputId: string;
  describedBy?: string;
  invalid: boolean;
  errorId: string;
}

function renderControl(props: ControlProps) {
  const { question } = props;
  switch (question.kind) {
    case 'text':
      return <TextControl {...props} />;
    case 'textarea':
      return <TextareaControl {...props} />;
    case 'number':
      return <NumberControl {...props} />;
    case 'select':
      return <SelectControl {...props} />;
    case 'multi-select':
      return <MultiSelectControl {...props} />;
    case 'boolean':
      return <BooleanControl {...props} />;
    case 'tag-list':
      return <TagListControl {...props} />;
    case 'entity-builder':
      return (
        <EntityBuilder
          value={props.value}
          onChange={props.onChange}
          errorId={props.errorId}
        />
      );
    default: {
      // Exhaustiveness guard: adding a kind to the schema forces a case here.
      const _never: never = question.kind;
      return _never;
    }
  }
}

function TextControl({ question, value, onChange, inputId, describedBy, invalid }: ControlProps) {
  return (
    <Input
      id={inputId}
      value={typeof value === 'string' ? value : ''}
      placeholder={question.placeholder}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function TextareaControl({ question, value, onChange, inputId, describedBy, invalid }: ControlProps) {
  return (
    <Textarea
      id={inputId}
      value={typeof value === 'string' ? value : ''}
      placeholder={question.placeholder}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NumberControl({ question, value, onChange, inputId, describedBy, invalid }: ControlProps) {
  return (
    <Input
      id={inputId}
      type="number"
      inputMode="decimal"
      value={typeof value === 'number' ? String(value) : ''}
      placeholder={question.placeholder}
      min={question.min}
      max={question.max}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      // coerceNumberInput guarantees a real `number` (or undefined) in state.
      onChange={(e) => onChange(coerceNumberInput(e.target.value))}
    />
  );
}

function SelectControl({ question, value, onChange, inputId, describedBy, invalid }: ControlProps) {
  const options = question.options ?? [];
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]));
  return (
    <Select
      value={typeof value === 'string' ? value : null}
      items={items}
      onValueChange={(v) => onChange(v)}
    >
      <SelectTrigger
        id={inputId}
        className="w-full"
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      >
        <SelectValue placeholder={question.placeholder ?? 'Select…'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MultiSelectControl({ question, value, onChange, describedBy, errorId }: ControlProps) {
  const options = question.options ?? [];
  const selected = Array.isArray(value) ? (value as string[]) : [];
  const toggle = (optValue: string, checked: boolean) => {
    const next = checked
      ? [...selected, optValue]
      : selected.filter((v) => v !== optValue);
    onChange(next);
  };
  return (
    <div role="group" className="flex flex-col gap-2" aria-describedby={describedBy}>
      {options.map((o) => {
        const id = `${errorId}-opt-${o.value}`;
        return (
          <label key={o.value} htmlFor={id} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={id}
              checked={selected.includes(o.value)}
              onCheckedChange={(checked) => toggle(o.value, checked)}
              className="mt-0.5"
            />
            <span>
              {o.label}
              {o.hint ? (
                <span className="block text-xs text-muted-foreground">{o.hint}</span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function BooleanControl({ value, onChange, inputId, describedBy, invalid }: ControlProps) {
  const current = value === true ? 'yes' : value === false ? 'no' : undefined;
  return (
    <RadioGroup
      value={current ?? null}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onValueChange={(v) => onChange(v === 'yes')}
      className="flex gap-6"
    >
      <label htmlFor={`${inputId}-yes`} className="flex items-center gap-2 text-sm">
        <RadioGroupItem id={`${inputId}-yes`} value="yes" />
        Yes
      </label>
      <label htmlFor={`${inputId}-no`} className="flex items-center gap-2 text-sm">
        <RadioGroupItem id={`${inputId}-no`} value="no" />
        No
      </label>
    </RadioGroup>
  );
}

function TagListControl({ question, value, onChange, inputId, describedBy, invalid }: ControlProps) {
  const tags = Array.isArray(value) ? (value as string[]) : [];
  const [entry, setEntry] = useState('');

  const commit = () => {
    const next = addTag(tags, entry);
    if (next.length !== tags.length) onChange(next);
    setEntry('');
  };

  return (
    <div className="flex flex-col gap-2">
      <Input
        id={inputId}
        value={entry}
        placeholder={question.placeholder ?? 'Type and press Enter'}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(e) => setEntry(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag, i) => (
            <Badge key={`${tag}-${i}`} variant="secondary" className="gap-1 pr-1">
              {tag}
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                className="rounded-sm text-muted-foreground hover:text-foreground"
                onClick={() => onChange(removeTagAt(tags, i))}
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
