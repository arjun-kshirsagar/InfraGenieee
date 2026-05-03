/**
 * Tests for the adaptive clarifier stage (`runClarifyStage`).
 *
 * OFFLINE and FREE: `callStructured` is fully mocked, so no real Anthropic call
 * is made and the suite bills nothing. We assert model resolution precedence,
 * the prompt's restraint framing, that the stage forwards options and returns
 * whatever `callStructured` (which validates against `clarifyResponseSchema`)
 * hands back — including the empty-array case — and that it does not swallow
 * `GenerationError`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationError } from '@/lib/prd/generation';
import type { BriefContext } from '@/types/prd';

// Mock the client module before importing the stage, so the stage picks up the mock.
vi.mock('@/lib/prd/llm/client', () => ({
  callStructured: vi.fn(),
}));

import { callStructured } from '@/lib/prd/llm/client';
import {
  buildClarifyUserMessage,
  CLARIFY_TOOL_JSON_SCHEMA,
  resolveClarifyModel,
  runClarifyStage,
} from '@/lib/prd/llm/stages/clarify';
import { DEFAULT_CLARIFY_MODEL } from '@/lib/prd/generation';

const mockCall = vi.mocked(callStructured);

const context: BriefContext = {
  userScale: 'medium',
  trafficPattern: 'business-hours',
  budgetBand: 'startup',
  timelineWeeks: 12,
  constraints: 'Must launch in the EU and be GDPR compliant.',
};

const IDEA = 'A marketplace where local bakeries list same-day surplus bread at a discount.';

beforeEach(() => {
  mockCall.mockReset();
  delete process.env.ANTHROPIC_CLARIFY_MODEL;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */
/* Model resolution                                                           */
/* -------------------------------------------------------------------------- */

describe('resolveClarifyModel', () => {
  it('prefers an explicit override over everything', () => {
    process.env.ANTHROPIC_CLARIFY_MODEL = 'env-model';
    expect(resolveClarifyModel('override-model')).toBe('override-model');
  });

  it('falls back to ANTHROPIC_CLARIFY_MODEL when no override', () => {
    process.env.ANTHROPIC_CLARIFY_MODEL = 'env-model';
    expect(resolveClarifyModel()).toBe('env-model');
  });

  it('falls back to the fast default when neither is set', () => {
    expect(resolveClarifyModel()).toBe(DEFAULT_CLARIFY_MODEL);
  });
});

/* -------------------------------------------------------------------------- */
/* Prompt composition                                                         */
/* -------------------------------------------------------------------------- */

describe('buildClarifyUserMessage', () => {
  it('spells out every supplied context field so the model will not re-ask it', () => {
    const msg = buildClarifyUserMessage(IDEA, context);
    expect(msg).toContain(IDEA);
    // Scale/traffic/budget/timeline/constraints must all appear as "already answered".
    expect(msg).toMatch(/1k–50k MAU/); // medium scale, labelled
    expect(msg).toMatch(/business-hours/);
    expect(msg).toMatch(/\$25–\$250/); // startup budget, labelled
    expect(msg).toContain('12 week(s)');
    expect(msg).toContain('GDPR');
  });

  it('renders "(none stated)" when constraints are absent', () => {
    const msg = buildClarifyUserMessage(IDEA, { ...context, constraints: undefined });
    expect(msg).toContain('Constraints: (none stated)');
  });

  it('renders "(none stated)" for whitespace-only constraints', () => {
    const msg = buildClarifyUserMessage(IDEA, { ...context, constraints: '   ' });
    expect(msg).toContain('Constraints: (none stated)');
  });
});

/* -------------------------------------------------------------------------- */
/* JSON schema — the wire-level guardrail                                      */
/* -------------------------------------------------------------------------- */

describe('CLARIFY_TOOL_JSON_SCHEMA', () => {
  it('caps questions at 3 at the wire level', () => {
    const q = (CLARIFY_TOOL_JSON_SCHEMA.properties as Record<string, { maxItems?: number }>)
      .questions;
    expect(q.maxItems).toBe(3);
  });

  it('requires id/question/why on each question', () => {
    const items = (
      (CLARIFY_TOOL_JSON_SCHEMA.properties as Record<string, { items?: { required?: string[] } }>)
        .questions.items
    );
    expect(items?.required).toEqual(expect.arrayContaining(['id', 'question', 'why']));
  });
});

/* -------------------------------------------------------------------------- */
/* runClarifyStage                                                            */
/* -------------------------------------------------------------------------- */

describe('runClarifyStage', () => {
  it('returns the questions from callStructured', async () => {
    const questions = [
      {
        id: 'q1',
        question: 'Do bakeries manage their own listings, or does your staff?',
        why: 'Determines whether we need a bakery-facing dashboard.',
        suggestions: ['Bakeries self-serve', 'Our staff do it'],
      },
    ];
    mockCall.mockResolvedValue({ questions });

    const result = await runClarifyStage(IDEA, context);
    expect(result).toEqual(questions);
  });

  it('handles an empty array cleanly (a common, valid outcome)', async () => {
    mockCall.mockResolvedValue({ questions: [] });
    const result = await runClarifyStage(IDEA, context);
    expect(result).toEqual([]);
  });

  it('calls the client with the forced tool, clarify stage, and resolved model', async () => {
    mockCall.mockResolvedValue({ questions: [] });
    await runClarifyStage(IDEA, context, { model: 'my-model' });

    expect(mockCall).toHaveBeenCalledTimes(1);
    const opts = mockCall.mock.calls[0][0];
    expect(opts.model).toBe('my-model');
    expect(opts.toolName).toBe('emit_clarifying_questions');
    expect(opts.stage).toBe('clarify');
    expect(opts.jsonSchema).toBe(CLARIFY_TOOL_JSON_SCHEMA);
    // The system prompt must carry the restraint framing.
    expect(opts.system).toMatch(/ZERO QUESTIONS/i);
    expect(opts.system).toMatch(/enumerate entities/i);
  });

  it('forwards the abort signal', async () => {
    mockCall.mockResolvedValue({ questions: [] });
    const controller = new AbortController();
    await runClarifyStage(IDEA, context, { signal: controller.signal });
    expect(mockCall.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it('does not swallow GenerationError from the client', async () => {
    mockCall.mockRejectedValue(new GenerationError('unavailable', 'boom', { stage: 'clarify' }));
    await expect(runClarifyStage(IDEA, context)).rejects.toMatchObject({
      name: 'GenerationError',
      code: 'unavailable',
    });
  });
});
