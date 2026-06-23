/**
 * Tests for POST /api/cost/estimate.
 *
 * OFFLINE and FREE: the pricing seam (`buildPriceBook`) is mocked, so no upstream
 * fetch happens and the suite bills nothing. The cost engine is real and pure —
 * we want to exercise it end-to-end through the route. We cover the contract from
 * docs/api-contracts.md §POST /api/cost/estimate:
 *   - 200 on a valid body, with a `comparison` that parses `estimateResponseSchema`
 *   - 400 bad_request on malformed JSON
 *   - 400 validation_error on a body that fails the schema
 *   - 400 validation_error on an unknown SKU id (well-formed but not in catalog)
 *   - 503 pricing_unavailable when NO price book at all could be produced
 *   - 🔴 no response body ever contains either API key
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  estimateResponseSchema,
  PRICING_PIPELINE_VERSION,
  PRICED_REGION,
  type CloudProvider,
  type PriceBook,
} from '@/types/cost';

// Mock the seam before importing the route so the route picks up the mock. The
// route delegates the arithmetic to the (real) pure engine and the fetch to this
// mocked seam.
vi.mock('@/lib/cost/pricing/build', () => ({
  buildPriceBook: vi.fn(),
}));

import { buildPriceBook } from '@/lib/cost/pricing/build';
import { PricingError } from '@/lib/cost/pricing-seam';
import { POST } from './route';

const mockBuild = vi.mocked(buildPriceBook);

const FAKE_TAVILY_KEY = 'tvly-SECRETKEY1234567890';
const FAKE_ANTHROPIC_KEY = 'sk-ant-SECRETKEY1234567890';

// A real catalog triple (see scripts/probe-cost-routes.ts): AWS EC2 t3.small
// fills the compute-web role and prices on the `instance-hour` dimension.
const AWS_SERVICE_ID = 'aws:ec2';
const AWS_SKU_ID = 'aws:ec2:t3-small';
const AWS_ROLE = 'compute-web';

/** A full, schema-valid usage profile (all mins satisfied). */
const usage = {
  monthlyActiveUsers: 10000,
  monthlyRequests: 5_000_000,
  avgResponseKb: 20,
  computeNodes: 1,
  computeHoursPerNode: 730,
  computeVcpuPerNode: 2,
  computeMemoryGbPerNode: 2,
  serverlessInvocations: 0,
  avgServerlessDurationMs: 1,
  serverlessMemoryMb: 128,
  dbStorageGb: 0,
  dbBackupGb: 0,
  nosqlReadsPerMonth: 0,
  nosqlWritesPerMonth: 0,
  nosqlStorageGb: 0,
  cacheGb: 0,
  queueMessagesPerMonth: 0,
  objectStorageGb: 0,
  objectWriteOpsPerMonth: 0,
  objectReadOpsPerMonth: 0,
  cdnEgressGb: 0,
  cdnRequestsPerMonth: 0,
  originEgressGb: 0,
  searchIndexGb: 0,
  buildMinutesPerMonth: 0,
  seats: 1,
};

const validBody = {
  usage,
  selections: [
    {
      provider: 'aws',
      choices: [{ role: AWS_ROLE, serviceId: AWS_SERVICE_ID, skuId: AWS_SKU_ID, units: 1, enabled: true }],
    },
  ],
  requiredRoles: [AWS_ROLE],
};

/** A price book for aws that prices the EC2 instance-hour dimension. */
function awsBook(): PriceBook {
  return {
    provider: 'aws',
    region: PRICED_REGION.aws,
    pipelineVersion: PRICING_PIPELINE_VERSION,
    generatedAt: '2026-07-26T10:00:00.000Z',
    records: [
      {
        skuId: AWS_SKU_ID,
        dimensionId: 'instance-hour',
        unitPriceUsd: 0.0208,
        includedQuantity: 0,
        currency: 'USD',
        source: {
          url: 'https://aws.amazon.com/ec2/pricing/on-demand/',
          fetchedAt: '2026-07-26T09:59:00.000Z',
          evidence: '| t3.small | $0.0208 |',
          extractorModel: 'feed:ec2-metered',
        },
      },
    ],
    gaps: [],
  };
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/cost/estimate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rawRequest(raw: string): Request {
  return new Request('http://localhost/api/cost/estimate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}

beforeEach(() => {
  mockBuild.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/cost/estimate', () => {
  it('returns 200 with a schema-valid comparison on a valid body', async () => {
    mockBuild.mockImplementation(async (provider: CloudProvider) => {
      if (provider === 'aws') return awsBook();
      throw new PricingError('unavailable', 'not requested', { provider });
    });

    const res = await POST(jsonRequest(validBody));
    expect(res.status).toBe(200);

    const body = await res.json();
    // Every 200 body parses against the response schema — the contract.
    expect(estimateResponseSchema.safeParse(body).success).toBe(true);

    const est = body.comparison.estimates[0];
    expect(est.provider).toBe('aws');
    expect(est.incomplete).toBe(false);
    // 730 hours * $0.0208 = $15.184 for the one priced dimension.
    expect(est.monthlyUsd).toBeCloseTo(730 * 0.0208, 6);
    // The route injects generatedAt (the engine never reads the clock).
    expect(typeof body.comparison.generatedAt).toBe('string');
  });

  it('returns 400 bad_request when the body is not valid JSON', async () => {
    const res = await POST(rawRequest('{ not json'));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when the body fails the schema', async () => {
    // Missing usage + selections entirely.
    const res = await POST(jsonRequest({ requiredRoles: [] }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error on a well-formed but unknown SKU id', async () => {
    // `aws:ec2:nope` passes the selection schema's prefix checks but is not in
    // the catalog — the route must reject it with a useful issues[] entry.
    const badBody = {
      usage,
      selections: [
        {
          provider: 'aws',
          choices: [{ role: AWS_ROLE, serviceId: AWS_SERVICE_ID, skuId: 'aws:ec2:nope', units: 1, enabled: true }],
        },
      ],
      requiredRoles: [AWS_ROLE],
    };

    const res = await POST(jsonRequest(badBody));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(JSON.stringify(body.error.issues)).toContain('aws:ec2:nope');
    // Never even attempted a price fetch for an invalid selection.
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error on a role/provider mismatch', async () => {
    // A valid AWS SKU claimed under a WRONG role — resolves in the catalog but
    // fills a different role than the choice claims.
    const badBody = {
      usage,
      selections: [
        {
          provider: 'aws',
          choices: [{ role: 'db-relational', serviceId: AWS_SERVICE_ID, skuId: AWS_SKU_ID, units: 1, enabled: true }],
        },
      ],
      requiredRoles: [],
    };

    const res = await POST(jsonRequest(badBody));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('returns 503 pricing_unavailable when no price book at all could be produced', async () => {
    mockBuild.mockRejectedValue(new PricingError('unavailable', 'everything down', {}));

    const res = await POST(jsonRequest(validBody));
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.error.code).toBe('pricing_unavailable');
  });

  it('🔴 never leaks either API key, even when the seam error carries one', async () => {
    mockBuild.mockRejectedValue(
      new PricingError(
        'unavailable',
        `upstream rejected TAVILY_API_KEY=${FAKE_TAVILY_KEY} ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY}`,
        {},
      ),
    );

    const res = await POST(jsonRequest(validBody));
    const raw = await res.text();
    expect(raw).not.toContain(FAKE_TAVILY_KEY);
    expect(raw).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(raw).not.toContain('TAVILY_API_KEY');
    expect(raw).not.toContain('ANTHROPIC_API_KEY');
  });
});

/* -------------------------------------------------------------------------- */
/* 🔴 BLOCKER-1/2 acceptance — the four hand-computed cases via the route      */
/* -------------------------------------------------------------------------- */

/**
 * These are the task's four acceptance cases, exercised end-to-end through
 * POST /api/cost/estimate against the REAL catalog and REAL pure engine (only
 * the price fetch is mocked, so the suite bills nothing). They assert the exact
 * dollar totals the task requires: $4.00, $10.00, $3.75, $143.08.
 *
 * Each prices ONLY the target dimension and zeroes the usage that would drive
 * the SKU's other dimensions, so the provider total IS the target line — the
 * cleanest possible assertion that `pricePerUnits` reached the response.
 */
describe('POST /api/cost/estimate — 🔴 BLOCKER-1/2 acceptance cases', () => {
  /** A usage profile with every metered driver at 0 except the overrides. */
  function zeroUsage(overrides: Record<string, number>) {
    return { ...usage, computeHoursPerNode: 0, monthlyRequests: 0, ...overrides };
  }

  function bookFor(
    provider: CloudProvider,
    region: string,
    skuId: string,
    dimensionId: string,
    unitPriceUsd: number,
    url: string,
  ): PriceBook {
    return {
      provider,
      region,
      pipelineVersion: PRICING_PIPELINE_VERSION,
      generatedAt: '2026-07-26T10:00:00.000Z',
      records: [
        {
          skuId,
          dimensionId,
          unitPriceUsd,
          includedQuantity: 0,
          currency: 'USD',
          source: {
            url,
            fetchedAt: '2026-07-26T09:59:00.000Z',
            evidence: `${dimensionId} ${unitPriceUsd}`,
            extractorModel: 'test',
          },
        },
      ],
      gaps: [],
    };
  }

  async function estimateTotal(body: unknown, book: PriceBook, provider: CloudProvider) {
    mockBuild.mockImplementation(async (p: CloudProvider) => {
      if (p === provider) return book;
      throw new PricingError('unavailable', 'not requested', { provider: p });
    });
    const res = await POST(jsonRequest(body));
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(estimateResponseSchema.safeParse(parsed).success).toBe(true);
    return parsed.comparison.estimates[0].monthlyUsd as number;
  }

  it('BLOCKER-1 · GCP Cloud Run 10M requests → $4.00 (bulk 10⁶, not $4,000,000)', async () => {
    const body = {
      usage: zeroUsage({ monthlyRequests: 10_000_000 }),
      selections: [
        {
          provider: 'gcp',
          choices: [
            { role: 'compute-web', serviceId: 'gcp:cloud-run', skuId: 'gcp:cloud-run:1vcpu-1gib', units: 1, enabled: true },
          ],
        },
      ],
      requiredRoles: ['compute-web'],
    };
    const book = bookFor('gcp', PRICED_REGION.gcp, 'gcp:cloud-run:1vcpu-1gib', 'requests', 0.4, 'https://cloud.google.com/run/pricing');
    expect(await estimateTotal(body, book, 'gcp')).toBeCloseTo(4.0, 6);
  });

  it('BLOCKER-1 · Vercel edge 5M requests → $10.00 (bulk 10⁶, not $10,000,000)', async () => {
    const body = {
      usage: zeroUsage({ cdnRequestsPerMonth: 5_000_000, cdnEgressGb: 0 }),
      selections: [
        {
          provider: 'vercel',
          choices: [
            { role: 'cdn', serviceId: 'vercel:edge-network', skuId: 'vercel:edge-network:standard', units: 1, enabled: true },
          ],
        },
      ],
      requiredRoles: ['cdn'],
    };
    const book = bookFor('vercel', PRICED_REGION.vercel, 'vercel:edge-network:standard', 'edge-requests', 2.0, 'https://vercel.com/pricing');
    expect(await estimateTotal(body, book, 'vercel')).toBeCloseTo(10.0, 6);
  });

  it('BLOCKER-1 · GCP Cloud CDN 100,000 lookups @ $0.375/10,000 → $3.75 (bulk 10⁴, not $37,500)', async () => {
    const body = {
      usage: zeroUsage({ cdnRequestsPerMonth: 100_000, cdnEgressGb: 0 }),
      selections: [
        {
          provider: 'gcp',
          choices: [
            { role: 'cdn', serviceId: 'gcp:cloud-cdn', skuId: 'gcp:cloud-cdn:standard', units: 1, enabled: true },
          ],
        },
      ],
      requiredRoles: ['cdn'],
    };
    const book = bookFor('gcp', PRICED_REGION.gcp, 'gcp:cloud-cdn:standard', 'cache-lookups', 0.375, 'https://cloud.google.com/cdn/pricing');
    expect(await estimateTotal(body, book, 'gcp')).toBeCloseTo(3.75, 6);
  });

  it('BLOCKER-2 · GCP Memorystore 4 GiB @ $0.049/GiB-hour → $143.08 (hour→month, not $0.20)', async () => {
    const body = {
      usage: zeroUsage({ cacheGb: 4 }),
      selections: [
        {
          provider: 'gcp',
          choices: [
            { role: 'cache-redis', serviceId: 'gcp:memorystore', skuId: 'gcp:memorystore:basic-m1', units: 1, enabled: true },
          ],
        },
      ],
      requiredRoles: ['cache-redis'],
    };
    const book = bookFor('gcp', PRICED_REGION.gcp, 'gcp:memorystore:basic-m1', 'capacity-gib-hour', 0.049, 'https://cloud.google.com/memorystore/docs/redis/pricing');
    // 4 GiB × 730h × $0.049 = $143.08
    expect(await estimateTotal(body, book, 'gcp')).toBeCloseTo(143.08, 2);
  });
});
