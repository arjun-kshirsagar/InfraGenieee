/**
 * Tests for the stage helpers (`src/lib/prd/llm/shared.ts`).
 *
 * OFFLINE and FREE: the Anthropic client (`callStructured`) is mocked, so no
 * network call is ever made. We cover the two behaviours that matter for
 * correctness:
 *
 *   - the ONE targeted under-volume retry (and that it's exactly one, no loop)
 *   - the pure helpers: brief formatting, under-volume detection, retry text.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/* Mock the client BEFORE importing the module under test. */
const callStructured = vi.fn<(opts: unknown) => Promise<unknown>>();
vi.mock('@/lib/prd/llm/client', () => ({
  callStructured: (opts: unknown) => callStructured(opts),
}));

import {
  buildRetryInstruction,
  describeVolumeShortfalls,
  formatBrief,
  isPurelyUnderVolume,
  runStage,
} from '@/lib/prd/llm/shared';
import { GenerationError } from '@/lib/prd/generation';
import { VALID_BRIEF } from '@/lib/prd/fixtures.test-support';

afterEach(() => vi.clearAllMocks());

/* -------------------------------------------------------------------------- */
/* formatBrief                                                                */
/* -------------------------------------------------------------------------- */

describe('formatBrief', () => {
  it('includes idea, context, answered clarifiers, and skips blank answers', () => {
    const text = formatBrief(VALID_BRIEF);
    expect(text).toContain(VALID_BRIEF.idea);
    expect(text).toContain('GDPR'); // from constraints
    // The answered clarifier appears...
    expect(text).toContain('Do bakeries need their own dashboard?');
    expect(text).toContain('Yes, a simple one.');
    // ...and the SKIPPED one is surfaced as an infer-it-yourself item, not as a
    // Q&A with a blank answer.
    expect(text).toContain('Are payments taken up front?');
    expect(text).not.toContain('A: \n'); // no blank-answer rendering
    // additionalNotes present.
    expect(text).toContain('Pickup only for v1');
  });
});

/* -------------------------------------------------------------------------- */
/* Under-volume detection                                                     */
/* -------------------------------------------------------------------------- */

describe('under-volume detection', () => {
  const s = z.object({ items: z.array(z.string()).min(8) });

  it('classifies an array-min miss as pure under-volume with the right counts', () => {
    const r = s.safeParse({ items: ['a', 'b', 'c'] });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(isPurelyUnderVolume(r.error)).toBe(true);
    const sf = describeVolumeShortfalls(r.error, { items: ['a', 'b', 'c'] });
    expect(sf).toEqual([{ path: 'items', have: 3, need: 8, label: 'items', note: undefined }]);
  });

  it('does NOT treat a structural error (bad enum) as under-volume', () => {
    const e = z.object({ x: z.enum(['a', 'b']) });
    const r = e.safeParse({ x: 'zzz' });
    if (r.success) return;
    expect(isPurelyUnderVolume(r.error)).toBe(false);
  });

  it('builds a targeted retry instruction naming the shortfall', () => {
    const msg = buildRetryInstruction([
      { path: 'functionalRequirements', have: 6, need: 8, label: 'functional requirements' },
    ]);
    expect(msg).toContain('6 functional requirements');
    expect(msg).toContain('minimum is 8');
    expect(msg).toContain('at least 8');
  });
});

/* -------------------------------------------------------------------------- */
/* runStage — exactly one under-volume retry, then stop                        */
/* -------------------------------------------------------------------------- */

const stageSchema = z.object({ items: z.array(z.string()).min(3) });

const baseStageOpts = {
  model: 'claude-sonnet-5',
  stage: 'prd' as const,
  toolName: 'emit',
  toolDescription: 'emit',
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'go' }],
  schema: stageSchema,
  maxTokens: 1000,
};

describe('runStage', () => {
  it('returns immediately when the first attempt validates', async () => {
    callStructured.mockResolvedValueOnce({ items: ['a', 'b', 'c'] });
    const out = await runStage(baseStageOpts);
    expect(out).toEqual({ items: ['a', 'b', 'c'] });
    expect(callStructured).toHaveBeenCalledOnce();
  });

  it('issues EXACTLY ONE extend-retry on under-volume, then succeeds', async () => {
    callStructured
      .mockResolvedValueOnce({ items: ['a'] }) // under-volume (need 3)
      .mockResolvedValueOnce({ items: ['a', 'b', 'c', 'd'] }); // fixed
    const out = await runStage(baseStageOpts);
    expect(out).toEqual({ items: ['a', 'b', 'c', 'd'] });
    expect(callStructured).toHaveBeenCalledTimes(2);

    // The retry call carried the previous output as an assistant turn + the
    // targeted follow-up — proof it extends rather than regenerates blind.
    const retryOpts = callStructured.mock.calls[1][0] as {
      messages: { role: string; content: string }[];
    };
    const roles = retryOpts.messages.map((m) => m.role);
    expect(roles).toContain('assistant');
    expect(retryOpts.messages.at(-1)?.content).toContain('minimum');
  });

  it('throws invalid_output after ONE failed retry — never loops', async () => {
    callStructured
      .mockResolvedValueOnce({ items: ['a'] }) // under-volume
      .mockResolvedValueOnce({ items: ['a', 'b'] }); // STILL under-volume
    await expect(runStage(baseStageOpts)).rejects.toMatchObject({
      name: 'GenerationError',
      code: 'invalid_output',
    });
    // Exactly two calls: initial + one retry. No third.
    expect(callStructured).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a structural failure — one call, invalid_output', async () => {
    const structuralSchema = z.object({ kind: z.enum(['x', 'y']) });
    callStructured.mockResolvedValueOnce({ kind: 'nope' });
    await expect(
      runStage({ ...baseStageOpts, schema: structuralSchema }),
    ).rejects.toMatchObject({ code: 'invalid_output' });
    expect(callStructured).toHaveBeenCalledOnce();
  });

  it('propagates a transport GenerationError from the client unchanged', async () => {
    callStructured.mockRejectedValueOnce(
      new GenerationError('unavailable', 'upstream 503', { stage: 'prd' }),
    );
    await expect(runStage(baseStageOpts)).rejects.toMatchObject({ code: 'unavailable' });
    expect(callStructured).toHaveBeenCalledOnce();
  });
});
