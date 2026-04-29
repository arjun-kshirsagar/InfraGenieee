/**
 * Tests for the pure idea + context form helpers.
 *
 * The vitest environment is `node` (see vitest.config.mts), so these stay
 * DOM-free — they exercise logic (defaults, the draft round-trip, the idea
 * guidance copy, clamping), not React rendering.
 */

import { describe, expect, it } from 'vitest';
import {
  IDEA_MIN,
  IDEA_MAX,
  TIMELINE_HARD_MAX,
  TIMELINE_HARD_MIN,
  clampTimeline,
  defaultContext,
  defaultFormValues,
  draftHasContent,
  draftToFormValues,
  formValuesToDraft,
  ideaContextFormSchema,
  ideaGuidance,
  toStepOneResult,
  type IdeaContextFormValues,
} from '@/lib/prd/brief-form';
import { briefContextSchema, projectBriefDraftSchema } from '@/types/prd';
import type { ProjectBriefDraft } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

describe('defaults', () => {
  it('uses the documented sensible defaults, not empty dropdowns', () => {
    expect(defaultContext()).toEqual({
      userScale: 'small',
      trafficPattern: 'unknown',
      budgetBand: 'hobby',
      timelineWeeks: 8,
    });
  });

  it('default context is itself valid against the contract', () => {
    expect(briefContextSchema.safeParse(defaultContext()).success).toBe(true);
  });

  it('default form values have an empty idea and default context', () => {
    const v = defaultFormValues();
    expect(v.idea).toBe('');
    expect(v.context).toEqual(defaultContext());
  });
});

/* -------------------------------------------------------------------------- */
/* Idea guidance copy                                                         */
/* -------------------------------------------------------------------------- */

describe('ideaGuidance', () => {
  it('nudges gently at zero length (hint, not error)', () => {
    const g = ideaGuidance(0);
    expect(g.tone).toBe('hint');
    expect(g.message).toMatch(/Tell us a bit more/);
    // Never surfaces the raw zod phrasing.
    expect(g.message).not.toMatch(/at least 30 character\(s\)/);
  });

  it('counts down remaining characters below the minimum', () => {
    const g = ideaGuidance(IDEA_MIN - 5);
    expect(g.tone).toBe('error');
    expect(g.message).toMatch(/5 more characters/);
  });

  it('uses the singular when one character remains', () => {
    const g = ideaGuidance(IDEA_MIN - 1);
    expect(g.message).toMatch(/1 more character\b/);
    expect(g.message).not.toMatch(/1 more characters/);
  });

  it('reports ok once the minimum is met', () => {
    expect(ideaGuidance(IDEA_MIN).tone).toBe('ok');
    expect(ideaGuidance(IDEA_MIN + 100).tone).toBe('ok');
  });

  it('flags going over the maximum', () => {
    expect(ideaGuidance(IDEA_MAX + 1).tone).toBe('error');
  });
});

/* -------------------------------------------------------------------------- */
/* Step-1 schema                                                              */
/* -------------------------------------------------------------------------- */

describe('ideaContextFormSchema', () => {
  const goodIdea = 'A marketplace where local bakeries can sell surplus bread at day-end discounts.';

  it('accepts a well-formed idea + default context', () => {
    const result = ideaContextFormSchema.safeParse({
      idea: goodIdea,
      context: defaultContext(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an idea below the 30-char floor with kind copy', () => {
    const result = ideaContextFormSchema.safeParse({ idea: 'an app', context: defaultContext() });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? '';
      expect(msg).toMatch(/Tell us a bit more/);
    }
  });

  it('does not let leading whitespace fake the minimum', () => {
    const padded = ' '.repeat(40) + 'app';
    expect(ideaContextFormSchema.safeParse({ idea: padded, context: defaultContext() }).success).toBe(
      false,
    );
  });

  it('inherits the contract enum + timeline bounds (no duplicated rules)', () => {
    const bad = ideaContextFormSchema.safeParse({
      idea: goodIdea,
      context: { ...defaultContext(), timelineWeeks: 999 },
    });
    expect(bad.success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* clampTimeline                                                              */
/* -------------------------------------------------------------------------- */

describe('clampTimeline', () => {
  it('clamps to the contract hard bounds', () => {
    expect(clampTimeline(0)).toBe(TIMELINE_HARD_MIN);
    expect(clampTimeline(9999)).toBe(TIMELINE_HARD_MAX);
    expect(clampTimeline(12)).toBe(12);
  });
  it('rounds fractional input', () => {
    expect(clampTimeline(8.6)).toBe(9);
  });
  it('falls back to the default on non-finite input', () => {
    expect(clampTimeline(Number.NaN)).toBe(8);
  });
});

/* -------------------------------------------------------------------------- */
/* Draft round-trip                                                           */
/* -------------------------------------------------------------------------- */

describe('draft round-trip', () => {
  const values: IdeaContextFormValues = {
    idea: 'Rent camera gear between local photographers with deposits and insurance.',
    context: {
      userScale: 'medium',
      trafficPattern: 'spiky',
      budgetBand: 'startup',
      timelineWeeks: 16,
      constraints: 'Must be GDPR compliant',
    },
  };

  it('formValuesToDraft -> draftToFormValues preserves everything', () => {
    const draft = formValuesToDraft(values);
    // The persisted draft must itself satisfy the strict draft schema.
    expect(projectBriefDraftSchema.safeParse(draft).success).toBe(true);
    expect(draftToFormValues(draft)).toEqual(values);
  });

  it('drops an empty/whitespace constraints string when persisting', () => {
    const draft = formValuesToDraft({
      ...values,
      context: { ...values.context, constraints: '   ' },
    });
    expect(draft.context && 'constraints' in draft.context).toBe(false);
  });

  it('draftToFormValues fills missing fields from defaults', () => {
    const partial: ProjectBriefDraft = { idea: 'just an idea so far, nothing else chosen yet here' };
    const restored = draftToFormValues(partial);
    expect(restored.context).toEqual(defaultContext());
    expect(restored.idea).toBe(partial.idea);
  });

  it('draftToFormValues(null) returns defaults', () => {
    expect(draftToFormValues(null)).toEqual(defaultFormValues());
  });
});

/* -------------------------------------------------------------------------- */
/* draftHasContent                                                            */
/* -------------------------------------------------------------------------- */

describe('draftHasContent', () => {
  it('is false for null / empty / defaults-only drafts', () => {
    expect(draftHasContent(null)).toBe(false);
    expect(draftHasContent({})).toBe(false);
    expect(draftHasContent({ idea: '   ' })).toBe(false);
    expect(draftHasContent(formValuesToDraft(defaultFormValues()))).toBe(false);
  });

  it('is true once the idea has real content', () => {
    expect(draftHasContent({ idea: 'a genuine idea worth resuming later on' })).toBe(true);
  });

  it('is true when context diverges from the defaults', () => {
    expect(draftHasContent({ context: { budgetBand: 'growth' } })).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* toStepOneResult                                                            */
/* -------------------------------------------------------------------------- */

describe('toStepOneResult', () => {
  it('trims the idea and produces a valid brief context', () => {
    const result = toStepOneResult({
      idea: '  A marketplace for surplus bakery goods sold at a discount.  ',
      context: defaultContext(),
    });
    expect(result.idea.startsWith(' ')).toBe(false);
    expect(result.idea.endsWith(' ')).toBe(false);
    expect(briefContextSchema.safeParse(result.context).success).toBe(true);
  });

  it('omits an empty constraints field', () => {
    const result = toStepOneResult({
      idea: 'A well-formed idea about something specific and worthwhile here.',
      context: { ...defaultContext(), constraints: '' },
    });
    expect('constraints' in result.context).toBe(false);
  });
});
