/**
 * Tests for POST /api/cost/recommend.
 *
 * OFFLINE and FREE: the recommendation seam (`recommendDeployment`) is mocked,
 * so no real Anthropic call is made and the suite bills nothing. We cover the
 * full contract from docs/api-contracts.md §POST /api/cost/recommend:
 *   - 200 happy path, body parses `recommendResponseSchema`
 *   - 400 bad_request on non-JSON body
 *   - 400 validation_error on a body that fails the request schema
 *   - 503 llm_unavailable on PricingError('unavailable')  (retryable)
 *   - 500 llm_not_configured on PricingError('not_configured')
 *   - 500 generation_failed on PricingError('invalid_output')
 *   - no API key / upstream text ever leaks into a response body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  recommendResponseSchema,
  type CostContext,
  type CostRecommendation,
} from '@/types/cost';

// Mock the recommendation seam before importing the route so the route picks up
// the mock. The route contains no business logic; this isolates the handler.
vi.mock('@/lib/cost/llm/recommend', () => ({
  recommendDeployment: vi.fn(),
}));

import { recommendDeployment } from '@/lib/cost/llm/recommend';
import { PricingError } from '@/lib/cost/pricing-seam';
import { deriveUsageProfile } from '@/lib/cost/estimate/derive';
import { POST } from './route';

const mockRecommend = vi.mocked(recommendDeployment);

const costContext: CostContext = {
  title: 'Bakery surplus marketplace',
  context: {
    userScale: 'medium',
    trafficPattern: 'business-hours',
    budgetBand: 'startup',
    timelineWeeks: 12,
  },
  components: [
    { name: 'Web app', kind: 'client', responsibility: 'Customer UI', technology: 'Next.js' },
    { name: 'API', kind: 'service', responsibility: 'Business logic', technology: 'Node.js' },
    { name: 'Primary DB', kind: 'datastore', responsibility: 'Orders', technology: 'PostgreSQL' },
  ],
  summary: 'Marketplace for same-day surplus bread.',
};

/** A schema-valid recommendation the mocked seam returns on the happy path. */
const recommendation: CostRecommendation = {
  recommendedProvider: 'aws',
  rationale:
    'At medium scale on a startup budget with business-hours traffic, AWS offers predictable RDS pricing and a broad managed catalog for this marketplace.',
  usageProfile: deriveUsageProfile(costContext),
  assumptions: ['No cache component was specified, so no cache is priced.'],
  selections: [
    {
      provider: 'aws',
      choices: [
        {
          role: 'compute-web',
          serviceId: 'aws:ec2',
          skuId: 'aws:ec2:t3-medium',
          units: 1,
          enabled: true,
        },
      ],
    },
  ],
  tradeoffs: [
    { provider: 'aws', pros: ['Broadest managed catalog'], cons: ['Steeper learning curve'] },
  ],
};

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/cost/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rawRequest(raw: string): Request {
  return new Request('http://localhost/api/cost/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}

beforeEach(() => {
  mockRecommend.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/cost/recommend', () => {
  it('returns 200 with the recommendation on success', async () => {
    mockRecommend.mockResolvedValue(recommendation);

    const res = await POST(jsonRequest({ costContext }));
    expect(res.status).toBe(200);

    const body = await res.json();
    // Every 200 body parses against the response schema — the contract.
    expect(recommendResponseSchema.safeParse(body).success).toBe(true);
    expect(body.recommendation.recommendedProvider).toBe('aws');

    // Delegated with the parsed costContext + the real catalog (arg 2).
    expect(mockRecommend).toHaveBeenCalledTimes(1);
    expect(mockRecommend.mock.calls[0][0]).toEqual(costContext);
    expect(mockRecommend.mock.calls[0][1]).toBeDefined(); // serviceCatalog
  });

  it('returns 400 bad_request when the body is not valid JSON', async () => {
    const res = await POST(rawRequest('{ not json'));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(mockRecommend).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when costContext is missing', async () => {
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(mockRecommend).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when costContext is malformed (no components)', async () => {
    const res = await POST(
      jsonRequest({ costContext: { ...costContext, components: [] } }),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(mockRecommend).not.toHaveBeenCalled();
  });

  it('maps PricingError("unavailable") → 503 llm_unavailable and never leaks upstream text', async () => {
    mockRecommend.mockRejectedValueOnce(
      new PricingError('unavailable', 'anthropic org_id=leak-me-123 rate limited'),
    );

    const res = await POST(jsonRequest({ costContext }));
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.error.code).toBe('llm_unavailable');
    // The upstream message (which can carry org/request ids) must not surface.
    expect(JSON.stringify(body)).not.toContain('leak-me-123');
  });

  it('maps PricingError("not_configured") → 500 llm_not_configured (no key in body)', async () => {
    mockRecommend.mockRejectedValueOnce(
      new PricingError('not_configured', 'ANTHROPIC_API_KEY sk-ant-secret missing'),
    );

    const res = await POST(jsonRequest({ costContext }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('llm_not_configured');
    // The key material must never appear in the response body.
    expect(JSON.stringify(body)).not.toContain('sk-ant-secret');
  });

  it('maps PricingError("invalid_output") → 500 generation_failed', async () => {
    mockRecommend.mockRejectedValueOnce(new PricingError('invalid_output', 'schema failed'));

    const res = await POST(jsonRequest({ costContext }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('generation_failed');
  });

  it('maps an unexpected non-PricingError → 500 generation_failed', async () => {
    mockRecommend.mockRejectedValueOnce(new Error('boom'));

    const res = await POST(jsonRequest({ costContext }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('generation_failed');
    expect(JSON.stringify(body)).not.toContain('boom');
  });

  it('returns 500 generation_failed if the seam returns an output that fails self-validation', async () => {
    // rationale below the 40-char minimum — the route self-validates its output.
    mockRecommend.mockResolvedValueOnce({
      ...recommendation,
      rationale: 'too short',
    } as CostRecommendation);

    const res = await POST(jsonRequest({ costContext }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('generation_failed');
  });
});
