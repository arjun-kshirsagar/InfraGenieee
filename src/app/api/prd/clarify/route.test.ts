/**
 * Tests for POST /api/prd/clarify.
 *
 * OFFLINE and FREE: the generation seam (`generateClarifyingQuestions`) is
 * mocked, so no real Anthropic call is made and the suite bills nothing. We
 * cover the full contract from docs/api-contracts.md §POST /api/prd/clarify:
 *   - returns questions on success (200)
 *   - an empty array is a valid, common 200 (never a 204, never an error)
 *   - a non-JSON body → 400 bad_request
 *   - a body that fails the request schema → 400 validation_error
 *   - GenerationError('unavailable') → 503 llm_unavailable (retryable)
 *   - GenerationError('not_configured') → 500 llm_not_configured
 * and assert every 200 body parses against `clarifyResponseSchema`, and that
 * upstream error text never leaks into a response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clarifyResponseSchema, type BriefContext } from '@/types/prd';
import { GenerationError } from '@/lib/prd/generation';

// Mock the generation seam before importing the route so the route picks up the
// mock. The route contains no business logic; this isolates the handler.
vi.mock('@/lib/prd/generation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/prd/generation')>(
    '@/lib/prd/generation',
  );
  return {
    ...actual,
    generateClarifyingQuestions: vi.fn(),
  };
});

import { generateClarifyingQuestions } from '@/lib/prd/generation';
import { POST } from './route';

const mockGenerate = vi.mocked(generateClarifyingQuestions);

const context: BriefContext = {
  userScale: 'medium',
  trafficPattern: 'business-hours',
  budgetBand: 'startup',
  timelineWeeks: 12,
  constraints: 'Must launch in the EU and be GDPR compliant.',
};

const IDEA =
  'A marketplace where local bakeries list same-day surplus bread at a discount for pickup.';

/** Build a POST Request with a JSON body. */
function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/prd/clarify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Build a POST Request whose body is not valid JSON. */
function rawRequest(raw: string): Request {
  return new Request('http://localhost/api/prd/clarify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}

beforeEach(() => {
  mockGenerate.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/prd/clarify', () => {
  it('returns 200 with the questions on success', async () => {
    const questions = [
      {
        id: 'q1',
        question: 'Do bakeries manage their own listings, or does your staff?',
        why: 'Determines whether we need a separate bakery-facing dashboard.',
        suggestions: ['Bakeries self-serve', 'Our staff do it'],
      },
    ];
    mockGenerate.mockResolvedValue(questions);

    const res = await POST(jsonRequest({ idea: IDEA, context }));
    expect(res.status).toBe(200);

    const body = await res.json();
    // Every 200 body parses against the response schema — the contract.
    expect(clarifyResponseSchema.safeParse(body).success).toBe(true);
    expect(body.questions).toEqual(questions);

    // Delegated with the parsed idea + context (no business logic in the route).
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0][0]).toBe(IDEA);
    expect(mockGenerate.mock.calls[0][1]).toEqual(context);
  });

  it('treats an empty array as a valid 200 (not a 204, not an error)', async () => {
    mockGenerate.mockResolvedValue([]);

    const res = await POST(jsonRequest({ idea: IDEA, context }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(clarifyResponseSchema.safeParse(body).success).toBe(true);
    expect(body.questions).toEqual([]);
  });

  it('returns 400 bad_request when the body is not valid JSON', async () => {
    const res = await POST(rawRequest('{ not json'));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when the body fails the request schema', async () => {
    // idea is below the 30-char minimum.
    const res = await POST(jsonRequest({ idea: 'too short', context }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when context is missing', async () => {
    const res = await POST(jsonRequest({ idea: IDEA }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('maps GenerationError("unavailable") → 503 llm_unavailable and never leaks upstream text', async () => {
    mockGenerate.mockRejectedValue(
      new GenerationError('unavailable', 'anthropic org_id=leak-me-123 rate limited', {
        stage: 'clarify',
      }),
    );

    const res = await POST(jsonRequest({ idea: IDEA, context }));
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.error.code).toBe('llm_unavailable');
    // The upstream message (which can carry org/request ids) must not surface.
    expect(JSON.stringify(body)).not.toContain('leak-me-123');
  });

  it('maps GenerationError("not_configured") → 500 llm_not_configured', async () => {
    mockGenerate.mockRejectedValue(
      new GenerationError('not_configured', 'ANTHROPIC_API_KEY missing', { stage: 'clarify' }),
    );

    const res = await POST(jsonRequest({ idea: IDEA, context }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('llm_not_configured');
  });

  it('maps GenerationError("invalid_output") → 500 generation_failed', async () => {
    mockGenerate.mockRejectedValue(
      new GenerationError('invalid_output', 'schema failed', { stage: 'clarify' }),
    );

    const res = await POST(jsonRequest({ idea: IDEA, context }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('generation_failed');
  });

  it('maps an unexpected non-GenerationError → 500 generation_failed', async () => {
    mockGenerate.mockRejectedValue(new Error('boom'));

    const res = await POST(jsonRequest({ idea: IDEA, context }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('generation_failed');
    expect(JSON.stringify(body)).not.toContain('boom');
  });

  it('returns 500 generation_failed if the seam returns an over-cap list (self-validation)', async () => {
    // Four questions — one past the schema cap of 3. The route self-validates
    // its own output, so this must not escape as a 200.
    const overCap = Array.from({ length: 4 }, (_, i) => ({
      id: `q${i + 1}`,
      question: `Question ${i + 1}?`,
      why: 'because',
      suggestions: [],
    }));
    mockGenerate.mockResolvedValue(overCap);

    const res = await POST(jsonRequest({ idea: IDEA, context }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('generation_failed');
  });
});
