/**
 * InfraGenie — pure, testable logic for the questionnaire field renderer (F2).
 *
 * The renderer (`question-field.tsx`) is a thin React shell around these
 * functions. Keeping the decision logic here — with zero React / DOM imports —
 * means the tricky bits (visibility predicate, number coercion, per-field
 * validation) are unit-testable in vitest's `node` environment without a DOM.
 *
 * Nothing here is question-specific: everything is driven by the `QuestionDef`
 * and the zod schema. Adding a question to `questionnaire.ts` requires no change.
 */

import { z } from 'zod';
import {
  questionnaireAnswersSchema,
  entitySchema,
  type QuestionDef,
  type Entity,
} from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Visibility                                                                 */
/* -------------------------------------------------------------------------- */

/** Minimal reader so this module stays free of the `draft.ts` React coupling. */
export type AnswerReader = (path: string) => unknown;

/**
 * Evaluate a question's `visibleWhen` guard. A question with no guard is always
 * visible; otherwise it is visible only when the referenced sibling path's
 * current value strictly equals the guard's `equals`.
 */
export function isQuestionVisible(question: QuestionDef, read: AnswerReader): boolean {
  if (!question.visibleWhen) return true;
  return read(question.visibleWhen.path) === question.visibleWhen.equals;
}

/* -------------------------------------------------------------------------- */
/* Number coercion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Coerce a raw `<input type="number">` value into what belongs in state.
 *
 * Critical: `number` questions must hold a real `number` in the draft, never a
 * string — otherwise `POST /api/prd/generate` 400s on `z.number()`. An empty
 * field yields `undefined` (unanswered) rather than `0` or `NaN`, and
 * unparseable text also yields `undefined` so validation reports "required"
 * instead of silently storing garbage.
 */
export function coerceNumberInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/* -------------------------------------------------------------------------- */
/* Per-field validation (drive from the schema, don't re-declare rules)       */
/* -------------------------------------------------------------------------- */

/** Split a two-segment answers path into its step + field parts. */
export function splitPath(path: string): { step: string; field: string } {
  const [step, field] = path.split('.');
  return { step, field };
}

/**
 * Resolve the zod schema for a single answer path by walking the authoritative
 * `questionnaireAnswersSchema`. Returns `undefined` if the path doesn't resolve
 * (e.g. a typo in the questionnaire) so the caller can fail loudly in dev.
 */
export function fieldSchemaFor(path: string): z.ZodTypeAny | undefined {
  const { step, field } = splitPath(path);
  const root = questionnaireAnswersSchema.shape as Record<string, z.ZodTypeAny>;
  const group = root[step];
  if (!group || !(group instanceof z.ZodObject)) return undefined;
  const shape = group.shape as Record<string, z.ZodTypeAny>;
  return shape[field];
}

/**
 * Validate a single question's value against its slice of the contract schema.
 * Returns the first human-readable error message, or `null` when valid.
 *
 * - Optional (`required === false`) empty values are treated as valid so the
 *   user isn't nagged about fields they may legitimately skip.
 * - Required empty values report a "required" message without leaning on zod's
 *   less friendly default text.
 * - Everything else is delegated to the schema, so min/max/enum rules live in
 *   one place (`@/types/prd`) and are never duplicated here.
 */
export function validateAnswer(question: QuestionDef, value: unknown): string | null {
  const empty = isEmptyValue(value);

  if (empty) {
    return question.required ? `${question.label} is required.` : null;
  }

  const schema = fieldSchemaFor(question.path);
  if (!schema) return null; // unknown path — nothing to validate against

  const result = schema.safeParse(value);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? 'Invalid value.';
}

/** Treat "", null, undefined and empty arrays as unanswered. */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Tag-list helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Append a tag to a tag-list value, trimming and de-duplicating (case-sensitive
 * match on the exact trimmed string). Returns the same array reference when the
 * tag is empty or already present, so callers can skip a re-render.
 */
export function addTag(current: readonly string[], raw: string): string[] {
  const tag = raw.trim();
  if (tag === '') return [...current];
  if (current.includes(tag)) return [...current];
  return [...current, tag];
}

export function removeTagAt(current: readonly string[], index: number): string[] {
  return current.filter((_, i) => i !== index);
}

/* -------------------------------------------------------------------------- */
/* Entity-builder helpers                                                     */
/* -------------------------------------------------------------------------- */

export const MAX_ENTITIES = 25;
export const MAX_FIELDS_PER_ENTITY = 30;

/** A draft entity: same shape as the contract `Entity` but every part is
 *  editable/partial while the user is filling it in. */
export type DraftEntity = {
  name: string;
  description?: string;
  fields: Array<{
    name: string;
    type: Entity['fields'][number]['type'];
    required: boolean;
    notes?: string;
  }>;
};

export function emptyEntity(): DraftEntity {
  return { name: '', description: '', fields: [] };
}

export function emptyField(): DraftEntity['fields'][number] {
  return { name: '', type: 'string', required: false };
}

/**
 * Find case-insensitive duplicate entity names. Returns the set of names (lower
 * cased) that appear more than once. B2's relationship inference keys off names,
 * so duplicates must surface as an error.
 */
export function duplicateEntityNames(entities: readonly { name: string }[]): Set<string> {
  const seen = new Map<string, number>();
  for (const e of entities) {
    const key = e.name.trim().toLowerCase();
    if (key === '') continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dups = new Set<string>();
  for (const [key, count] of seen) if (count > 1) dups.add(key);
  return dups;
}

/**
 * Validate the whole entities array against the contract schema
 * (`dataModelAnswersSchema.entities`) plus the case-insensitive duplicate-name
 * rule which zod can't express. Returns the first error message or `null`.
 */
export function validateEntities(entities: readonly DraftEntity[]): string | null {
  const dups = duplicateEntityNames(entities);
  if (dups.size > 0) {
    return `Duplicate entity name: "${[...dups][0]}". Entity names must be unique.`;
  }
  const schema = z.array(entitySchema).min(1).max(MAX_ENTITIES);
  const result = schema.safeParse(entities);
  if (result.success) return null;
  const issue = result.error.issues[0];
  return issue?.message ?? 'Invalid data model.';
}
