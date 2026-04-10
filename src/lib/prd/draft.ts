/**
 * InfraGenie — dot-path helpers for questionnaire draft state.
 *
 * The questionnaire is data-driven: each `QuestionDef.path` is a dot-path into
 * `QuestionnaireAnswers` (e.g. `basics.projectName`). The wizard stores answers
 * in a single `QuestionnaireDraft` object and reads/writes individual questions
 * by their path. These helpers are pure and immutable so React state updates
 * stay predictable, and are shared by the shell (F1) and the field components
 * (F2).
 *
 * Scope: two-segment paths (`<step>.<field>`), which is all the questionnaire
 * definition uses. That is asserted by the contract test
 * ("prefixes every question path with its step key").
 */

import type { QuestionnaireDraft } from '@/types/prd';

type Draft = QuestionnaireDraft;
type StepKey = keyof Draft;

/** Read the value at a dot-path, or `undefined` if any segment is missing. */
export function getAnswer(draft: Draft, path: string): unknown {
  const [step, field] = path.split('.') as [StepKey, string];
  const group = draft[step] as Record<string, unknown> | undefined;
  if (!group) return undefined;
  return group[field];
}

/**
 * Return a new draft with the value at `path` set. Immutable — the input draft
 * is never mutated. Only the touched step group is cloned.
 */
export function setAnswer(draft: Draft, path: string, value: unknown): Draft {
  const [step, field] = path.split('.') as [StepKey, string];
  const group = { ...(draft[step] as Record<string, unknown> | undefined) };
  group[field] = value;
  return { ...draft, [step]: group } as Draft;
}
