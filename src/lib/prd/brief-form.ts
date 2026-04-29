/**
 * InfraGenie — pure, DOM-free helpers for the idea + context input step
 * (Feature 1, `/prd/new`).
 *
 * This module holds everything about the form that is *logic* rather than
 * *rendering*: the validation schema for the first step, the sensible default
 * values, the draft <-> form round-trip, and the copy that turns raw zod
 * messages into human guidance. Keeping it here (a) lets the vitest `node`
 * environment test the behaviour without a DOM, and (b) keeps the client
 * component focused on wiring, not rules.
 *
 * The form only owns the FIRST step of the flow: `idea` + the five `context`
 * answers. The clarifier step, `additionalNotes`, and the network submit are
 * downstream tasks (F3/F4). We deliberately validate a `Pick` of the contract
 * so we never hand-write a parallel rule set — the source of truth stays in
 * `src/types/prd.ts`.
 */

import { z } from 'zod';
import {
  briefContextSchema,
  projectBriefSchema,
  type BriefContext,
  type ProjectBrief,
  type ProjectBriefDraft,
} from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Step-1 schema — derived from the contract, never re-authored               */
/* -------------------------------------------------------------------------- */

/**
 * The idea rule, lifted verbatim from `projectBriefSchema` so the 30/4000
 * bounds can never drift from the contract, but with human-friendly messages.
 *
 * `projectBriefSchema.shape.idea` is the exact `z.string().min(30).max(4000)`
 * the backend validates against; we only re-skin its error text.
 */
export const IDEA_MIN = 30;
export const IDEA_MAX = 4000;

/**
 * Guidance shown under the idea textarea. The 30-char floor is a real
 * constraint (the model needs something to reason from), but "String must
 * contain at least 30 character(s)" reads like a database error. This turns it
 * into an encouragement.
 */
export function ideaGuidance(length: number): {
  message: string;
  tone: 'hint' | 'error' | 'ok';
} {
  if (length === 0) {
    return {
      message: `Tell us a bit more — a sentence or two works (${IDEA_MIN}+ characters).`,
      tone: 'hint',
    };
  }
  if (length < IDEA_MIN) {
    const remaining = IDEA_MIN - length;
    return {
      message: `Tell us a bit more — a sentence or two works (${remaining} more character${
        remaining === 1 ? '' : 's'
      }).`,
      tone: 'error',
    };
  }
  if (length > IDEA_MAX) {
    return {
      message: `That's a lot — trim it down to ${IDEA_MAX.toLocaleString()} characters or fewer.`,
      tone: 'error',
    };
  }
  return { message: 'Looks good.', tone: 'ok' };
}

/**
 * The step-1 validation schema for react-hook-form. It reuses the contract's
 * `idea` rule and the whole `briefContextSchema`, only overriding the idea's
 * error copy. No bounds are duplicated here.
 */
const TOO_SHORT_MESSAGE = `Tell us a bit more — a sentence or two works (at least ${IDEA_MIN} characters).`;
const TOO_LONG_MESSAGE = `That's a lot — trim it down to ${IDEA_MAX.toLocaleString()} characters or fewer.`;

export const ideaContextFormSchema = z.object({
  /**
   * The idea's bounds come from the contract (`projectBriefSchema.shape.idea`)
   * — we run its parse first so the 30/4000 floors can never drift — but we
   * re-skin its raw "Too small…" message into human guidance, and add a trim
   * check so leading whitespace can't fake the minimum.
   */
  idea: z.string().superRefine((value, ctx) => {
    const parsed = projectBriefSchema.shape.idea.safeParse(value.trim());
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      const tooShort =
        issue.code === 'too_small' || /at least|greater than or equal/i.test(issue.message);
      ctx.addIssue({
        code: 'custom',
        message: tooShort ? TOO_SHORT_MESSAGE : TOO_LONG_MESSAGE,
      });
    }
  }),
  context: briefContextSchema,
});

export type IdeaContextFormValues = z.infer<typeof ideaContextFormSchema>;

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Sensible starting context so the form isn't five empty dropdowns. Every one
 * is a legitimate, common answer the user can change; none forces a decision
 * before they can proceed.
 *
 *   scale   → small       (100–1k users: the modal "I'm building a thing")
 *   traffic → unknown      (an honest default; the AI assumes and says so)
 *   budget  → hobby        (< $25/mo: matches "small")
 *   timeline→ 8 weeks       (a quarter-ish; the slider spans 1–52 here)
 */
export const DEFAULT_TIMELINE_WEEKS = 8;

export function defaultContext(): BriefContext {
  return {
    userScale: 'small',
    trafficPattern: 'unknown',
    budgetBand: 'hobby',
    timelineWeeks: DEFAULT_TIMELINE_WEEKS,
  };
}

export function defaultFormValues(): IdeaContextFormValues {
  return {
    idea: '',
    context: defaultContext(),
  };
}

/**
 * Slider bounds for the timeline. The contract allows 1–104 weeks, but a slider
 * spanning two years has unusably fine granularity for the common case, so the
 * slider covers 1–52 and the numeric input accepts the full contract range.
 */
export const TIMELINE_SLIDER_MIN = 1;
export const TIMELINE_SLIDER_MAX = 52;
export const TIMELINE_HARD_MIN = 1;
export const TIMELINE_HARD_MAX = 104;

/** Clamp a raw timeline number to the contract's hard bounds. */
export function clampTimeline(weeks: number): number {
  if (!Number.isFinite(weeks)) return DEFAULT_TIMELINE_WEEKS;
  const rounded = Math.round(weeks);
  return Math.min(TIMELINE_HARD_MAX, Math.max(TIMELINE_HARD_MIN, rounded));
}

/* -------------------------------------------------------------------------- */
/* Draft <-> form round-trip                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Merge a persisted `ProjectBriefDraft` (every field optional) onto the
 * defaults to produce fully-populated form values. Any field the draft is
 * missing falls back to the default, so a half-typed draft never yields an
 * invalid or empty control.
 */
export function draftToFormValues(draft: ProjectBriefDraft | null): IdeaContextFormValues {
  const base = defaultFormValues();
  if (!draft) return base;

  const context = draft.context ?? {};
  return {
    idea: draft.idea ?? base.idea,
    context: {
      userScale: context.userScale ?? base.context.userScale,
      trafficPattern: context.trafficPattern ?? base.context.trafficPattern,
      budgetBand: context.budgetBand ?? base.context.budgetBand,
      timelineWeeks: context.timelineWeeks ?? base.context.timelineWeeks,
      constraints: context.constraints ?? base.context.constraints,
    },
  };
}

/**
 * Serialise current form values into a draft for autosave. We persist whatever
 * the user has entered (even a two-word idea) so a mid-typing reload can be
 * resumed; the draft schema is fully optional by design.
 *
 * An empty `constraints` string is dropped rather than persisted, keeping the
 * blob tidy and matching the optional contract field.
 */
export function formValuesToDraft(values: IdeaContextFormValues): ProjectBriefDraft {
  const constraints = values.context.constraints?.trim();
  return {
    idea: values.idea,
    context: {
      userScale: values.context.userScale,
      trafficPattern: values.context.trafficPattern,
      budgetBand: values.context.budgetBand,
      timelineWeeks: values.context.timelineWeeks,
      ...(constraints ? { constraints } : {}),
    },
  };
}

/**
 * Does a persisted draft contain anything worth offering to resume? A draft
 * that is only the untouched defaults (or an empty idea) isn't worth a
 * Resume/Start-fresh prompt — treat it as absent.
 */
export function draftHasContent(draft: ProjectBriefDraft | null): boolean {
  if (!draft) return false;
  if (draft.idea && draft.idea.trim().length > 0) return true;
  const c = draft.context;
  if (!c) return false;
  const defaults = defaultContext();
  return (
    (c.userScale !== undefined && c.userScale !== defaults.userScale) ||
    (c.trafficPattern !== undefined && c.trafficPattern !== defaults.trafficPattern) ||
    (c.budgetBand !== undefined && c.budgetBand !== defaults.budgetBand) ||
    (c.timelineWeeks !== undefined && c.timelineWeeks !== defaults.timelineWeeks) ||
    (typeof c.constraints === 'string' && c.constraints.trim().length > 0)
  );
}

/**
 * The shape handed to the next step when the user clicks Continue. This is the
 * clean seam: F3/F4 take this and layer on clarifications + submit. It is
 * exactly the `idea` + `context` slice of the contract's `ProjectBrief`.
 */
export type BriefStepOneResult = Pick<ProjectBrief, 'idea' | 'context'>;

/** Normalise validated form values into the result passed to `onComplete`. */
export function toStepOneResult(values: IdeaContextFormValues): BriefStepOneResult {
  const constraints = values.context.constraints?.trim();
  return {
    idea: values.idea.trim(),
    context: {
      userScale: values.context.userScale,
      trafficPattern: values.context.trafficPattern,
      budgetBand: values.context.budgetBand,
      timelineWeeks: values.context.timelineWeeks,
      ...(constraints ? { constraints } : {}),
    },
  };
}
