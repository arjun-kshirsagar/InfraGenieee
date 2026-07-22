/**
 * Tests for POST /api/deploy/analyze (task B7).
 *
 * OFFLINE and FREE: the pipeline (`buildDeployPlan`) is mocked, so no network
 * call is made and the suite bills nothing. The handler contains no business
 * logic; these tests pin the contract from docs §8 / docs/api-contracts.md:
 *   - 200 happy path, body parses `analyzeResponseSchema`
 *   - 400 bad_request on non-JSON body
 *   - 400 validation_error on a body that fails the request schema
 *   - 400 unsupported_host on RepoError('unsupported_host')
 *   - 404 repo_not_found on RepoError('not_found'), message names PRIVATE repos
 *   - 503 repo_unavailable on RepoError('unavailable'/'rate_limited') + Retry-After
 *   - 500 internal_error when the assembled plan fails self-validation
 *   - no upstream body / URL ever leaks into a response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { analyzeResponseSchema, type DeployPlan } from '@/types/deploy';

// Mock the pipeline before importing the route so the route picks up the mock.
vi.mock('@/lib/deploy/plan', () => ({
  buildDeployPlan: vi.fn(),
}));

import { buildDeployPlan } from '@/lib/deploy/plan';
import { RepoError } from '@/lib/deploy/repo-seam';
import { parseRepoUrl } from '@/lib/deploy/repo-url';
import { detectStack } from '@/lib/deploy/detect';
import { recommendProviders } from '@/lib/deploy/recommend';
import { generateConfigs } from '@/lib/deploy/generate';
import type { RepoSnapshot } from '@/types/deploy';
import { POST } from './route';

const mockBuild = vi.mocked(buildDeployPlan);

/* -------------------------------------------------------------------------- */
/* A real, schema-valid DeployPlan built from the actual pure pipeline         */
/* -------------------------------------------------------------------------- */

/** Assemble a genuine DeployPlan the way `buildDeployPlan` does, so the happy
 *  path returns something that truly parses `deployPlanSchema` (no handcrafted
 *  fixture that could drift from the contract). */
function realNextjsPlan(): DeployPlan {
  const ref = parseRepoUrl('https://github.com/acme/app');
  const snapshot: RepoSnapshot = {
    ref,
    defaultBranch: 'main',
    resolvedBranch: 'main',
    meta: {},
    entries: [
      { path: 'package.json', type: 'file' },
      { path: 'next.config.mjs', type: 'file' },
      { path: 'package-lock.json', type: 'file' },
      { path: 'app', type: 'dir' },
    ],
    files: {
      'package.json': JSON.stringify({
        name: 'next-app',
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: { next: '^15.2.0', react: '^19.0.0' },
      }),
      'next.config.mjs': 'export default {};\n',
    },
    entriesTruncated: false,
    fetchedAt: '2026-07-28T12:00:00.000Z',
  };
  const detection = detectStack(snapshot);
  const { fits, primary, assumptions, usedPrdContext } = recommendProviders(detection, ref, {
    defaultBranch: 'main',
  });
  return {
    repo: ref,
    detection,
    fits,
    primary,
    assumptions,
    configs: generateConfigs(detection, ref),
    usedPrdContext,
    generatedAt: '2026-07-28T18:30:00.000Z',
  };
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/deploy/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rawRequest(raw: string): Request {
  return new Request('http://localhost/api/deploy/analyze', {
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

describe('POST /api/deploy/analyze', () => {
  it('returns 200 with the plan on success; body parses the response schema', async () => {
    const plan = realNextjsPlan();
    mockBuild.mockResolvedValue(plan);

    const res = await POST(jsonRequest({ repoUrl: 'https://github.com/acme/app' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(analyzeResponseSchema.safeParse(body).success).toBe(true);
    expect(body.plan.detection.framework).toBe('nextjs');
    expect(body.plan.primary).toBe('vercel');
    expect(body.plan.fits).toHaveLength(3);

    // Delegated with the raw, unnormalised repoUrl (arg 1).
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(mockBuild.mock.calls[0][0]).toBe('https://github.com/acme/app');
  });

  it('returns 400 bad_request when the body is not valid JSON', async () => {
    const res = await POST(rawRequest('{ not json'));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when repoUrl is missing', async () => {
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when repoUrl is too short', async () => {
    const res = await POST(jsonRequest({ repoUrl: 'x' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('maps RepoError("invalid_url") → 400 validation_error', async () => {
    mockBuild.mockRejectedValueOnce(new RepoError('invalid_url', 'nope'));
    const res = await POST(jsonRequest({ repoUrl: 'https://github.com/acme/app' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
  });

  it('maps RepoError("unsupported_host") → 400 unsupported_host', async () => {
    mockBuild.mockRejectedValueOnce(
      new RepoError('unsupported_host', 'https://git.internal.example.com/o/r not supported'),
    );
    const res = await POST(jsonRequest({ repoUrl: 'https://git.internal.example.com/o/r' }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error.code).toBe('unsupported_host');
    // The upstream URL must not leak.
    expect(JSON.stringify(body)).not.toContain('git.internal.example.com');
  });

  it('maps RepoError("not_found") → 404 repo_not_found; message names PRIVATE repos', async () => {
    mockBuild.mockRejectedValueOnce(
      new RepoError('not_found', 'GET api.github.com/repos/secret/thing 404'),
    );
    const res = await POST(jsonRequest({ repoUrl: 'https://github.com/secret/thing' }));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error.code).toBe('repo_not_found');
    // Anonymous GitHub can't distinguish absent from private — the message must
    // name BOTH possibilities so the user knows a private repo looks the same.
    expect(body.error.message.toLowerCase()).toContain("doesn't exist");
    expect(body.error.message.toLowerCase()).toContain('private');
    // The upstream URL must not leak.
    expect(JSON.stringify(body)).not.toContain('api.github.com');
  });

  it('maps RepoError("unavailable") → 503 repo_unavailable', async () => {
    mockBuild.mockRejectedValueOnce(new RepoError('unavailable', 'github 502 request-id=leak-me'));
    const res = await POST(jsonRequest({ repoUrl: 'https://github.com/acme/app' }));
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.error.code).toBe('repo_unavailable');
    expect(JSON.stringify(body)).not.toContain('leak-me');
  });

  it('maps RepoError("rate_limited") → 503 repo_unavailable and passes Retry-After through', async () => {
    mockBuild.mockRejectedValueOnce(
      new RepoError('rate_limited', 'anonymous budget exhausted', { retryAfterSeconds: 900 }),
    );
    const res = await POST(jsonRequest({ repoUrl: 'https://github.com/acme/app' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('900');

    const body = await res.json();
    expect(body.error.code).toBe('repo_unavailable');
  });

  it('maps RepoError("too_large") → 400 validation_error', async () => {
    mockBuild.mockRejectedValueOnce(new RepoError('too_large', 'tree too big'));
    const res = await POST(jsonRequest({ repoUrl: 'https://github.com/acme/huge' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
  });

  it('maps an unexpected non-RepoError → 500 internal_error (no detail leak)', async () => {
    mockBuild.mockRejectedValueOnce(new Error('boom secret-token=abc'));
    const res = await POST(jsonRequest({ repoUrl: 'https://github.com/acme/app' }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('secret-token');
  });

  it('returns 500 internal_error if the pipeline returns a plan that fails self-validation', async () => {
    // primary set to a provider under unknown confidence is rejected by the
    // schema's superRefine — the route self-validates its output.
    const bad = realNextjsPlan();
    mockBuild.mockResolvedValueOnce({
      ...bad,
      generatedAt: 'too-short', // below the min(20) → fails analyzeResponseSchema
    } as DeployPlan);

    const res = await POST(jsonRequest({ repoUrl: 'https://github.com/acme/app' }));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe('internal_error');
  });
});
