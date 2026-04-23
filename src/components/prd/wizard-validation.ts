/**
 * InfraGenie — pure wizard validation + server-issue mapping (F3).
 *
 * The wizard shell (`wizard-shell.tsx`) is a thin React shell around these
 * functions. Keeping the decision logic here — with zero React / DOM imports —
 * means step gating and the crucial `issues[].path → step` mapper are
 * unit-testable in vitest's `node` environment.
 *
 * Everything is generic: step → schema and path → step are derived from
 * `STEP_ORDER` / `questionnaireAnswersSchema`, never a hand-written lookup.
 */

import { z } from 'zod';
import {
  questionnaireAnswersSchema,
  STEP_ORDER,
  type QuestionnaireStep,
  type QuestionnaireDraft,
} from '@/types/prd';

/** Canonical step key type (`basics` | `scale` | …). */
export type StepKey = QuestionnaireStep['key'];

/**
 * The zod schema for a single step's answer group, resolved from the
 * authoritative `questionnaireAnswersSchema`. Returns `undefined` for an unknown
 * key so callers can fail loudly in dev rather than silently pass.
 */
export function stepSchemaFor(key: string): z.ZodTypeAny | undefined {
  const shape = questionnaireAnswersSchema.shape as Record<string, z.ZodTypeAny>;
  return shape[key];
}

/** Field-level error messages keyed by field name within a step (e.g. `regions`). */
export type FieldErrors = Record<string, string>;

export interface StepValidation {
  ok: boolean;
  /** First error message per field in this step's slice. */
  fieldErrors: FieldErrors;
  /** Field name (within the step) of the first invalid field, for focus. */
  firstInvalidField: string | null;
}

/**
 * Validate one step's slice against its group schema. Drives entirely off the
 * contract schema — no per-step rules. The slice is the draft group for `key`
 * (e.g. `draft.scale`); `undefined`/empty is treated as an empty object so a
 * wholly-unanswered required step reports its missing fields.
 */
export function validateStep(key: string, slice: unknown): StepValidation {
  const schema = stepSchemaFor(key);
  if (!schema) {
    // Unknown step key — nothing to validate against; treat as valid so a
    // questionnaire typo doesn't hard-block the user (dev will notice missing UI).
    return { ok: true, fieldErrors: {}, firstInvalidField: null };
  }

  const result = schema.safeParse(slice ?? {});
  if (result.success) {
    return { ok: true, fieldErrors: {}, firstInvalidField: null };
  }

  const fieldErrors: FieldErrors = {};
  let firstInvalidField: string | null = null;
  for (const issue of result.error.issues) {
    // The first path segment inside a group schema is the field name.
    const field = typeof issue.path[0] === 'string' ? issue.path[0] : String(issue.path[0] ?? '');
    if (!field) continue;
    if (!(field in fieldErrors)) fieldErrors[field] = issue.message;
    if (firstInvalidField === null) firstInvalidField = field;
  }

  return { ok: false, fieldErrors, firstInvalidField };
}

/**
 * Validate every step of a draft in canonical order. Returns per-step results
 * plus the index of the first invalid step (or -1 when all valid). Used to stop
 * the step indicator from letting the user jump past an incomplete earlier step.
 */
export function firstInvalidStepIndex(draft: QuestionnaireDraft): number {
  for (let i = 0; i < STEP_ORDER.length; i += 1) {
    const key = STEP_ORDER[i];
    const slice = (draft as Record<string, unknown>)[key];
    if (!validateStep(key, slice).ok) return i;
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Server issue → step mapping                                                */
/* -------------------------------------------------------------------------- */

/** One flattened issue from a 400 `validation_error` response. */
export interface ServerIssue {
  path: string;
  message: string;
}

/**
 * Map a server issue path back to the step it belongs to.
 *
 * The generate endpoint validates `generateRequestSchema`, so issue paths are
 * rooted at `answers` — e.g. `answers.scale.regions`, `answers.basics.oneLiner`,
 * or `answers.dataModel.entities.0.name`. We drop a leading `answers` segment,
 * then the next segment is the step key. Returns the step's index via
 * `STEP_ORDER`, or -1 if the step key isn't recognised.
 */
export function issuePathToStepIndex(path: string): number {
  const key = stepKeyFromIssuePath(path);
  if (key === null) return -1;
  return STEP_ORDER.indexOf(key as StepKey);
}

/** Extract just the owning step key from an issue path, or `null`. */
export function stepKeyFromIssuePath(path: string): StepKey | null {
  const segments = path.split('.').filter((s) => s.length > 0);
  let idx = 0;
  if (segments[idx] === 'answers') idx += 1;
  const candidate = segments[idx];
  if (candidate && (STEP_ORDER as readonly string[]).includes(candidate)) {
    return candidate as StepKey;
  }
  return null;
}

/**
 * Extract the field name (within its step) from an issue path, or `null`.
 * `answers.scale.regions` → `regions`; `answers.dataModel.entities.0.name`
 * → `entities` (the top-level field the message attaches to in the UI).
 */
export function fieldFromIssuePath(path: string): string | null {
  const segments = path.split('.').filter((s) => s.length > 0);
  let idx = 0;
  if (segments[idx] === 'answers') idx += 1;
  // segments[idx] is the step key; the field is the next segment.
  const field = segments[idx + 1];
  return field ?? null;
}

export interface MappedServerIssues {
  /** Per-step field errors: stepKey → { field → message }. */
  byStep: Partial<Record<StepKey, FieldErrors>>;
  /** Index of the earliest step (in canonical order) that has an issue, or -1. */
  firstStepIndex: number;
  /** Issues whose path couldn't be mapped to a step (kept so nothing is silently dropped). */
  unmapped: ServerIssue[];
}

/**
 * Map a full `issues[]` array from a 400 response into per-step field errors and
 * the earliest offending step index (so the shell can jump the user there).
 */
export function mapServerIssues(issues: readonly ServerIssue[]): MappedServerIssues {
  const byStep: Partial<Record<StepKey, FieldErrors>> = {};
  const unmapped: ServerIssue[] = [];
  const touchedIndexes: number[] = [];

  for (const issue of issues) {
    const key = stepKeyFromIssuePath(issue.path);
    const field = fieldFromIssuePath(issue.path);
    if (key === null || field === null) {
      unmapped.push(issue);
      continue;
    }
    const bucket = (byStep[key] ??= {});
    // First message wins per field, matching validateStep's behaviour.
    if (!(field in bucket)) bucket[field] = issue.message;
    touchedIndexes.push(STEP_ORDER.indexOf(key));
  }

  const firstStepIndex = touchedIndexes.length > 0 ? Math.min(...touchedIndexes) : -1;
  return { byStep, firstStepIndex, unmapped };
}
