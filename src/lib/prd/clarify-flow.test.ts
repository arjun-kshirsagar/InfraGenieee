/**
 * Tests for the pure clarifier-flow logic (Feature 1, F2).
 *
 * The vitest environment is `node` (see vitest.config.mts), so these stay
 * DOM-free — they exercise the fetch classification, brief assembly, and the
 * skipped-answer / empty-questions / clarify-failed paths, all with a mocked
 * `fetch`. No real network, so `npm test` stays offline and free.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  assembleBrief,
  buildClarifications,
  clarifyDraftPatch,
  fetchClarify,
  finalizeBrief,
  finalizeBriefWithoutQuestions,
  hasAnyAnswer,
  seedAnswersFromClarifications,
  type ClarifyInput,
} from '@/lib/prd/clarify-flow';
import { projectBriefSchema, type ClarifyQuestion } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const INPUT: ClarifyInput = {
  idea: 'A marketplace where local bakeries list same-day surplus bread at a discount.',
  context: {
    userScale: 'medium',
    trafficPattern: 'business-hours',
    budgetBand: 'startup',
    timelineWeeks: 12,
    constraints: 'Must launch in the EU and be GDPR compliant.',
  },
};

const QUESTIONS: ClarifyQuestion[] = [
  {
    id: 'q1',
    question: 'Do bakeries manage their own listings, or does staff do it?',
    why: 'Determines whether we need a separate bakery-facing dashboard.',
    suggestions: ['Bakeries self-serve', 'Our staff do it'],
  },
  {
    id: 'q2',
    question: 'Is payment handled in-app or on pickup?',
    why: 'Drives whether we integrate a payment provider.',
    suggestions: ['In-app', 'On pickup'],
  },
  {
    id: 'q3',
    question: 'Single city at launch or multi-region?',
    why: 'Affects data partitioning and compliance scope.',
    suggestions: [],
  },
];

/** Build a mock `fetch` returning a given status + JSON body. */
function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

/* -------------------------------------------------------------------------- */
/* fetchClarify — classification + best-effort guarantee                      */
/* -------------------------------------------------------------------------- */

describe('fetchClarify', () => {
  it('classifies 1-3 questions as { kind: "questions" }', async () => {
    const out = await fetchClarify(INPUT, {
      fetchImpl: mockFetch(200, { questions: QUESTIONS }),
    });
    expect(out.kind).toBe('questions');
    if (out.kind === 'questions') expect(out.questions).toHaveLength(3);
  });

  it('classifies an empty questions array as { kind: "none" } — the common fast path', async () => {
    const out = await fetchClarify(INPUT, {
      fetchImpl: mockFetch(200, { questions: [] }),
    });
    expect(out.kind).toBe('none');
  });

  it('never throws on a 503 — resolves to "failed" so the user can proceed', async () => {
    const out = await fetchClarify(INPUT, {
      fetchImpl: mockFetch(503, {
        error: { code: 'llm_unavailable', message: 'busy' },
      }),
    });
    expect(out.kind).toBe('failed');
  });

  it('never throws on a 500 — resolves to "failed"', async () => {
    const out = await fetchClarify(INPUT, {
      fetchImpl: mockFetch(500, {
        error: { code: 'llm_not_configured', message: 'no key' },
      }),
    });
    expect(out.kind).toBe('failed');
  });

  it('never throws on a network error — resolves to "failed"', async () => {
    const rejecting = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const out = await fetchClarify(INPUT, { fetchImpl: rejecting });
    expect(out.kind).toBe('failed');
  });

  it('resolves to "failed" on an abort rather than rejecting', async () => {
    const aborting = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const out = await fetchClarify(INPUT, { fetchImpl: aborting });
    expect(out.kind).toBe('failed');
  });

  it('treats malformed JSON on a 200 as "failed"', async () => {
    const badJson = vi.fn(
      async () => new Response('not json', { status: 200 }),
    ) as unknown as typeof fetch;
    const out = await fetchClarify(INPUT, { fetchImpl: badJson });
    expect(out.kind).toBe('failed');
  });

  it('treats an off-contract 200 (more than 3 questions) as "failed" — never trusts it', async () => {
    const four = [...QUESTIONS, { ...QUESTIONS[0], id: 'q4' }];
    const out = await fetchClarify(INPUT, {
      fetchImpl: mockFetch(200, { questions: four }),
    });
    expect(out.kind).toBe('failed');
  });

  it('sends idea + context in the request body', async () => {
    const spy: typeof fetch = vi.fn(
      async () => new Response(JSON.stringify({ questions: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    await fetchClarify(INPUT, { fetchImpl: spy });
    expect(spy).toHaveBeenCalledOnce();
    const call = (spy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const init = call[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      idea: INPUT.idea,
      context: INPUT.context,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* buildClarifications — skipped answers, trimming, order                     */
/* -------------------------------------------------------------------------- */

describe('buildClarifications', () => {
  it('keeps a skipped question with answer:"" (contract-valid "infer it")', () => {
    const out = buildClarifications(QUESTIONS, { q1: 'Bakeries self-serve' });
    expect(out).toEqual([
      { question: QUESTIONS[0].question, answer: 'Bakeries self-serve' },
      { question: QUESTIONS[1].question, answer: '' },
      { question: QUESTIONS[2].question, answer: '' },
    ]);
  });

  it('treats a whitespace-only answer as skipped', () => {
    const out = buildClarifications([QUESTIONS[0]], { q1: '   ' });
    expect(out[0].answer).toBe('');
  });

  it('trims answers and preserves question order', () => {
    const out = buildClarifications(QUESTIONS, {
      q2: '  In-app  ',
      q1: 'Staff',
    });
    expect(out.map((c) => c.answer)).toEqual(['Staff', 'In-app', '']);
  });

  it('produces clarifications that all satisfy the contract schema', () => {
    const clarifications = buildClarifications(QUESTIONS, { q1: 'x', q3: 'y' });
    const brief = { ...INPUT, clarifications };
    expect(projectBriefSchema.safeParse(brief).success).toBe(true);
  });
});

describe('hasAnyAnswer', () => {
  it('is false when everything is empty or whitespace', () => {
    expect(hasAnyAnswer({ q1: '', q2: '   ' })).toBe(false);
  });
  it('is true when at least one answer has content', () => {
    expect(hasAnyAnswer({ q1: '', q2: 'yes' })).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* assembleBrief / finalizeBrief — validate against the contract              */
/* -------------------------------------------------------------------------- */

describe('assembleBrief', () => {
  it('assembles a valid brief from parts and drops empty notes', () => {
    const res = assembleBrief({
      input: INPUT,
      clarifications: buildClarifications([QUESTIONS[0]], { q1: 'Staff' }),
      additionalNotes: '   ',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.brief).not.toHaveProperty('additionalNotes');
      expect(res.brief.clarifications).toHaveLength(1);
      expect(projectBriefSchema.safeParse(res.brief).success).toBe(true);
    }
  });

  it('keeps and trims non-empty notes', () => {
    const res = assembleBrief({
      input: INPUT,
      clarifications: [],
      additionalNotes: '  Pickup only for v1 — no delivery.  ',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.brief.additionalNotes).toBe('Pickup only for v1 — no delivery.');
  });

  it('trims the idea', () => {
    const res = assembleBrief({
      input: { ...INPUT, idea: `   ${INPUT.idea}   ` },
      clarifications: [],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.brief.idea).toBe(INPUT.idea);
  });

  it('reports issues (does not throw) when the idea is too short', () => {
    const res = assembleBrief({
      input: { ...INPUT, idea: 'too short' },
      clarifications: [],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.join(' ')).toMatch(/idea/);
  });
});

describe('finalizeBrief (questions path)', () => {
  it('builds clarifications and validates in one call', () => {
    const res = finalizeBrief({
      input: INPUT,
      questions: QUESTIONS,
      answers: { q1: 'Self-serve' },
      additionalNotes: 'v1 is pickup only',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.brief.clarifications).toHaveLength(3);
      expect(res.brief.clarifications[0].answer).toBe('Self-serve');
      expect(res.brief.clarifications[1].answer).toBe('');
      expect(res.brief.additionalNotes).toBe('v1 is pickup only');
    }
  });
});

describe('finalizeBriefWithoutQuestions (empty / failed path)', () => {
  it('produces a valid brief with empty clarifications', () => {
    const res = finalizeBriefWithoutQuestions({
      input: INPUT,
      additionalNotes: 'anything',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.brief.clarifications).toEqual([]);
      expect(projectBriefSchema.safeParse(res.brief).success).toBe(true);
    }
  });

  it('a clarify-failed flow still yields a contract-valid brief (never blocks generation)', () => {
    // Simulates: fetchClarify returned { kind: 'failed' }, user proceeds.
    const res = finalizeBriefWithoutQuestions({ input: INPUT });
    expect(res.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Draft autosave helpers                                                     */
/* -------------------------------------------------------------------------- */

describe('clarifyDraftPatch', () => {
  it('drops empty clarifications and empty notes', () => {
    expect(clarifyDraftPatch({ clarifications: [], additionalNotes: '  ' })).toEqual({});
  });
  it('keeps non-empty clarifications and trimmed notes', () => {
    const clarifications = buildClarifications([QUESTIONS[0]], { q1: 'x' });
    expect(
      clarifyDraftPatch({ clarifications, additionalNotes: '  note ' }),
    ).toEqual({ clarifications, additionalNotes: 'note' });
  });
});

describe('seedAnswersFromClarifications', () => {
  it('seeds answers by matching question text, skipping empties', () => {
    const saved = [
      { question: QUESTIONS[0].question, answer: 'Self-serve' },
      { question: QUESTIONS[1].question, answer: '' },
    ];
    const seeded = seedAnswersFromClarifications(QUESTIONS, saved);
    expect(seeded).toEqual({ q1: 'Self-serve' });
  });
  it('returns {} when there is nothing saved', () => {
    expect(seedAnswersFromClarifications(QUESTIONS, undefined)).toEqual({});
    expect(seedAnswersFromClarifications(QUESTIONS, [])).toEqual({});
  });
});
