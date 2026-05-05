/**
 * InfraGenie — pure, DOM-free logic for the clarifier step (Feature 1, F2).
 *
 * This module owns everything about the clarifier flow that is *logic* rather
 * than *rendering*: calling `POST /api/prd/clarify`, classifying the result
 * (questions / no-questions / failed), turning question-answers into contract
 * `Clarification[]`, and assembling + validating the final `ProjectBrief`.
 *
 * Keeping it here (a) lets the vitest `node` environment test the behaviour
 * without a DOM, and (b) keeps the client component focused on wiring.
 *
 * ## The two behaviours that matter most
 *
 * 1. **Zero questions is the common case.** `classifyClarify` returns a
 *    discriminated result so the UI can branch on `kind` and skip straight to
 *    the notes step — never rendering an empty "clarifying questions" screen.
 *
 * 2. **The clarifier is best-effort.** Any failure (503/500/network/timeout)
 *    resolves to `{ kind: 'failed' }` rather than throwing, so the UI can show
 *    an unobtrusive note and let the user proceed to generation. A PRD without
 *    clarifiers is still a good PRD. `fetchClarify` NEVER rejects.
 */

import {
  clarifyResponseSchema,
  projectBriefSchema,
  type BriefContext,
  type Clarification,
  type ClarifyQuestion,
  type ProjectBrief,
} from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* The idea + context slice handed in from F1                                 */
/* -------------------------------------------------------------------------- */

/** Exactly the F1 output: the idea + context slice of the contract's brief. */
export type ClarifyInput = Pick<ProjectBrief, 'idea' | 'context'>;

/* -------------------------------------------------------------------------- */
/* Calling the clarifier — best-effort, never throws                          */
/* -------------------------------------------------------------------------- */

/**
 * Result of the clarify call, as a discriminated union so the UI branches
 * cleanly:
 *
 *   - `questions`  — 1–3 real questions to show.
 *   - `none`       — a valid empty response; skip straight to notes.
 *   - `failed`     — the call failed OR returned something off-contract; the
 *                    UI shows an unobtrusive note and proceeds anyway.
 *
 * There is deliberately no way to express "block the user". The clarifier is
 * best-effort by contract.
 */
export type ClarifyOutcome =
  | { kind: 'questions'; questions: ClarifyQuestion[] }
  | { kind: 'none' }
  | { kind: 'failed' };

export const CLARIFY_ENDPOINT = '/api/prd/clarify';

/** Options for {@link fetchClarify}, so callers can pass an AbortSignal. */
export interface FetchClarifyOptions {
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Call `POST /api/prd/clarify` and classify the result. This function is the
 * single most important piece of the task's "best-effort" guarantee: it
 * **never rejects**. Every failure mode — non-2xx status, network error,
 * abort, malformed JSON, off-contract body — collapses to
 * `{ kind: 'failed' }`, and a valid empty `questions` array collapses to
 * `{ kind: 'none' }`.
 *
 * Note: an aborted request also resolves to `failed`. The caller decides
 * whether an abort should advance the flow (component-unmount) or was a
 * deliberate cancel; from a pure-logic standpoint the outcome is the same —
 * we have no questions, so we do not block.
 */
export async function fetchClarify(
  input: ClarifyInput,
  options: FetchClarifyOptions = {},
): Promise<ClarifyOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(CLARIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: input.idea, context: input.context }),
      signal: options.signal,
    });
  } catch {
    // Network error, DNS failure, timeout, or abort — all best-effort failures.
    return { kind: 'failed' };
  }

  if (!response.ok) {
    // 400/500/503 — the route logged the real reason server-side. We do not
    // surface it; the clarifier is optional so we just proceed.
    return { kind: 'failed' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'failed' };
  }

  const parsed = clarifyResponseSchema.safeParse(body);
  if (!parsed.success) {
    // A 200 with an off-contract body (e.g. >3 questions) is still a failure
    // for our purposes — we can't trust it, so proceed without clarifiers.
    return { kind: 'failed' };
  }

  if (parsed.data.questions.length === 0) {
    return { kind: 'none' };
  }
  return { kind: 'questions', questions: parsed.data.questions };
}

/* -------------------------------------------------------------------------- */
/* Answers → clarifications                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Answers keyed by question id. An absent key or an empty/whitespace string
 * both mean "skipped" — the user asked the AI to infer it. We keep skipped
 * questions with `answer: ''` (contract-valid, `clarificationSchema` allows
 * an empty answer) so the generator sees the question the AI itself asked and
 * knows it was left to infer. This is the "keep with answer:''" choice from
 * the task; we apply it consistently.
 */
export type ClarifyAnswers = Record<string, string>;

/**
 * Turn the questions the AI asked plus the user's answers into the contract's
 * `Clarification[]`. Order follows the questions as asked. Every answer is
 * trimmed; a skipped question becomes `{ question, answer: '' }`.
 *
 * Questions are truncated defensively to the contract bounds (question ≤300,
 * answer ≤1000) so a pathological upstream value can never make the final
 * brief fail to validate — though the route already caps these.
 */
export function buildClarifications(
  questions: ClarifyQuestion[],
  answers: ClarifyAnswers,
): Clarification[] {
  return questions.map((q) => {
    const raw = answers[q.id] ?? '';
    const answer = raw.trim().slice(0, 1000);
    return {
      question: q.question.slice(0, 300),
      answer,
    };
  });
}

/** Has the user answered at least one clarifier (non-empty)? Used only for
 *  UI affordance copy — the flow never requires it. */
export function hasAnyAnswer(answers: ClarifyAnswers): boolean {
  return Object.values(answers).some((a) => a.trim().length > 0);
}

/* -------------------------------------------------------------------------- */
/* Assemble + validate the final ProjectBrief                                 */
/* -------------------------------------------------------------------------- */

/** Everything needed to assemble the final brief handed to generation. */
export interface AssembleBriefParts {
  input: ClarifyInput;
  clarifications: Clarification[];
  /** The "anything else?" free text. Optional; empty/whitespace is dropped. */
  additionalNotes?: string;
}

/**
 * Assemble the final `ProjectBrief` from its parts and validate it against the
 * contract's `projectBriefSchema`. Returns a discriminated result rather than
 * throwing so the caller can decide what to do on the (unexpected) invalid
 * case — in practice, if F1 produced a valid idea+context and clarifications
 * came from `buildClarifications`, this always succeeds.
 *
 * `additionalNotes` is trimmed; an empty string is dropped so we match the
 * optional contract field rather than persisting `''`.
 */
export function assembleBrief(
  parts: AssembleBriefParts,
): { ok: true; brief: ProjectBrief } | { ok: false; issues: string[] } {
  const notes = parts.additionalNotes?.trim();

  const candidate = {
    idea: parts.input.idea.trim(),
    context: parts.input.context,
    clarifications: parts.clarifications,
    ...(notes ? { additionalNotes: notes } : {}),
  };

  const result = projectBriefSchema.safeParse(candidate);
  if (result.success) {
    return { ok: true, brief: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    ),
  };
}

/**
 * Convenience: build clarifications from questions+answers and assemble the
 * brief in one call. This is the exact path the UI takes when the user
 * finishes the flow with questions shown.
 */
export function finalizeBrief(args: {
  input: ClarifyInput;
  questions: ClarifyQuestion[];
  answers: ClarifyAnswers;
  additionalNotes?: string;
}): { ok: true; brief: ProjectBrief } | { ok: false; issues: string[] } {
  return assembleBrief({
    input: args.input,
    clarifications: buildClarifications(args.questions, args.answers),
    additionalNotes: args.additionalNotes,
  });
}

/**
 * The finalize path when there were no questions (empty-response or
 * clarify-failed): no clarifications, just idea+context and optional notes.
 */
export function finalizeBriefWithoutQuestions(args: {
  input: ClarifyInput;
  additionalNotes?: string;
}): { ok: true; brief: ProjectBrief } | { ok: false; issues: string[] } {
  return assembleBrief({
    input: args.input,
    clarifications: [],
    additionalNotes: args.additionalNotes,
  });
}

/* -------------------------------------------------------------------------- */
/* Draft autosave helpers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Merge clarifications + notes into a draft's persisted shape. The F1 form
 * already persists idea+context; this augments it so a reload mid-clarifier
 * doesn't lose the answers. Empty notes are dropped; empty clarifications are
 * dropped so the draft blob stays tidy and matches the optional draft schema.
 */
export function clarifyDraftPatch(args: {
  clarifications: Clarification[];
  additionalNotes?: string;
}): { clarifications?: Clarification[]; additionalNotes?: string } {
  const notes = args.additionalNotes?.trim();
  const patch: { clarifications?: Clarification[]; additionalNotes?: string } = {};
  if (args.clarifications.length > 0) patch.clarifications = args.clarifications;
  if (notes) patch.additionalNotes = notes;
  return patch;
}

/**
 * Seed an answers map from previously-saved clarifications (draft resume). We
 * match by question text since draft clarifications store the question, not the
 * id. Only questions still being asked get seeded.
 */
export function seedAnswersFromClarifications(
  questions: ClarifyQuestion[],
  saved: Clarification[] | undefined,
): ClarifyAnswers {
  if (!saved || saved.length === 0) return {};
  const byQuestion = new Map(saved.map((c) => [c.question, c.answer]));
  const answers: ClarifyAnswers = {};
  for (const q of questions) {
    const prior = byQuestion.get(q.question);
    if (prior && prior.length > 0) answers[q.id] = prior;
  }
  return answers;
}

export type { BriefContext };
