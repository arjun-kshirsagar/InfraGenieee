/**
 * Unit tests for the pure `/deploy` client module (`@/lib/deploy/client`) —
 * `fetch` mocked, no network, no DOM. Covers what the F3-F1 task mandates:
 *
 *   1. error-code → copy mapping for EVERY DeployErrorCode (distinct copy +
 *      correct retryable / changeUrl flags; validation_error carries issues),
 *   2. `analyzeRepo` success (a valid plan parses to `{ kind: 'ok' }`),
 *   3. `analyzeRepo` error paths (contract envelope, off-contract body → status
 *      fallback, non-2xx, transport failure → network),
 *   4. abort handling (an aborted fetch REJECTS, it does not resolve to error),
 *   5. `buildDeployPrdContext` (maps a PrdDocument → the context slice, validates).
 *
 * Nothing here imports a server-only / key-bearing module.
 */

import { describe, it, expect, vi } from 'vitest';

import type { DeployPlan } from '@/types/deploy';
import { deployPrdContextSchema } from '@/types/deploy';
import { makePrdDocument } from '@/lib/prd/fixtures.test-support';
import {
  analyzeRepo,
  mapDeployError,
  buildDeployPrdContext,
  ANALYZE_ENDPOINT,
  type DeployErrorCode,
} from '@/lib/deploy/client';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CANONICAL = 'https://github.com/vercel/next-learn';

function makeDeployPlan(): DeployPlan {
  return {
    repo: {
      host: 'github',
      owner: 'vercel',
      repo: 'next-learn',
      branch: null,
      subdir: null,
      canonicalUrl: CANONICAL,
    },
    detection: {
      framework: 'nextjs',
      frameworkVersion: '^15.0.0',
      runtime: 'node',
      appShape: 'ssr',
      packageManager: 'npm',
      needs: [],
      build: {
        installCommand: 'npm install',
        buildCommand: 'next build',
        outputDir: null,
        startCommand: null,
        nodeVersion: null,
      },
      existing: { vercel: false, netlify: false, render: false, dockerfile: false },
      monorepo: false,
      signals: [
        {
          id: 'dep:next',
          kind: 'dependency',
          path: 'package.json',
          excerpt: '"next": "^15.0.0"',
          implies: 'next in dependencies → Next.js',
          weight: 'strong',
        },
      ],
      confidence: 'high',
      notes: [],
    },
    fits: [
      {
        provider: 'vercel',
        verdict: 'recommended',
        score: 95,
        reasons: ['Next.js is a first-class Vercel target.'],
        caveats: [],
        deployUrl: 'https://vercel.com/new/clone?repository-url=' + encodeURIComponent(CANONICAL),
        requiresConfig: false,
      },
      {
        provider: 'netlify',
        verdict: 'possible',
        score: 70,
        reasons: ['Netlify runs Next.js via its adapter.'],
        caveats: [],
        deployUrl: 'https://app.netlify.com/start/deploy?repository=' + encodeURIComponent(CANONICAL),
        requiresConfig: false,
      },
      {
        provider: 'render',
        verdict: 'possible',
        score: 55,
        reasons: ['Render can host a Next.js web service.'],
        caveats: [],
        deployUrl: 'https://render.com/deploy?repo=' + encodeURIComponent(CANONICAL),
        requiresConfig: true,
      },
    ],
    primary: 'vercel',
    assumptions: [],
    configs: [],
    usedPrdContext: false,
    generatedAt: '2026-07-28T00:00:00.000Z',
  };
}

/** A minimal `fetch` mock returning a given status + JSON body. */
function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

/* -------------------------------------------------------------------------- */
/* 1. Error-code → copy mapping                                               */
/* -------------------------------------------------------------------------- */

describe('mapDeployError', () => {
  const ALL_CODES: DeployErrorCode[] = [
    'repo_not_found',
    'repo_unavailable',
    'unsupported_host',
    'validation_error',
    'bad_request',
    'generation_failed',
    'internal_error',
    'not_found',
    'network',
  ];

  it('returns distinct, non-empty title + message for every code', () => {
    const titles = new Set<string>();
    const messages = new Set<string>();
    for (const code of ALL_CODES) {
      const p = mapDeployError(code);
      expect(p.code).toBe(code);
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.message.length).toBeGreaterThan(0);
      titles.add(p.title);
      messages.add(p.message);
    }
    // No two codes share the same title or message — each is distinct copy.
    expect(titles.size).toBe(ALL_CODES.length);
    expect(messages.size).toBe(ALL_CODES.length);
  });

  it('sets the retryable flag correctly per code', () => {
    // URL-fault + malformed codes are NOT retryable (retrying unchanged is pointless).
    expect(mapDeployError('repo_not_found').retryable).toBe(false);
    expect(mapDeployError('unsupported_host').retryable).toBe(false);
    expect(mapDeployError('validation_error').retryable).toBe(false);
    expect(mapDeployError('bad_request').retryable).toBe(false);
    // Transient / server codes ARE retryable.
    expect(mapDeployError('repo_unavailable').retryable).toBe(true);
    expect(mapDeployError('generation_failed').retryable).toBe(true);
    expect(mapDeployError('internal_error').retryable).toBe(true);
    expect(mapDeployError('not_found').retryable).toBe(true);
    expect(mapDeployError('network').retryable).toBe(true);
  });

  it('sets changeUrl for the URL-fault codes only', () => {
    expect(mapDeployError('repo_not_found').changeUrl).toBe(true);
    expect(mapDeployError('unsupported_host').changeUrl).toBe(true);
    expect(mapDeployError('validation_error').changeUrl).toBe(true);
    expect(mapDeployError('bad_request').changeUrl).toBe(true);
    // Transient codes keep the same URL → no "change URL" push.
    expect(mapDeployError('repo_unavailable').changeUrl).toBe(false);
    expect(mapDeployError('network').changeUrl).toBe(false);
  });

  it('never mislabels: repo_not_found is not retryable and pushes changeUrl', () => {
    const p = mapDeployError('repo_not_found');
    expect(p.retryable).toBe(false);
    expect(p.changeUrl).toBe(true);
    expect(p.message.toLowerCase()).toContain('public');
  });

  it('unsupported_host names the three supported hosts', () => {
    const msg = mapDeployError('unsupported_host').message.toLowerCase();
    expect(msg).toContain('github');
    expect(msg).toContain('gitlab');
    expect(msg).toContain('bitbucket');
  });

  it('carries flattened issues for validation_error when provided', () => {
    const issues = [{ path: 'repoUrl', message: 'Too short.' }];
    const p = mapDeployError('validation_error', issues);
    expect(p.issues).toEqual(issues);
  });

  it('omits issues for validation_error when none are given', () => {
    expect(mapDeployError('validation_error').issues).toBeUndefined();
    // Non-validation codes never carry issues even if passed.
    expect(mapDeployError('internal_error', [{ path: 'x', message: 'y' }]).issues).toBeUndefined();
  });

  it('an unknown code falls through to the network presentation', () => {
    const p = mapDeployError('totally_unknown' as DeployErrorCode);
    expect(p.code).toBe('network');
    expect(p.retryable).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 2 + 3. analyzeRepo                                                          */
/* -------------------------------------------------------------------------- */

describe('analyzeRepo', () => {
  it('parses a valid 200 into { kind: "ok", plan }', async () => {
    const plan = makeDeployPlan();
    const out = await analyzeRepo(CANONICAL, undefined, { fetchImpl: mockFetch(200, { plan }) });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.plan.repo.canonicalUrl).toBe(CANONICAL);
  });

  it('POSTs to the analyze endpoint with the raw URL, unnormalised', async () => {
    const fetchImpl = mockFetch(200, { plan: makeDeployPlan() });
    await analyzeRepo('  github.com/vercel/next-learn ', undefined, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      ANALYZE_ENDPOINT,
      expect.objectContaining({ method: 'POST' }),
    );
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse((call[1] as RequestInit).body as string);
    // The client must NOT canonicalise — the server owns the one parser.
    expect(sentBody.repoUrl).toBe('  github.com/vercel/next-learn ');
    expect(sentBody.prdContext).toBeUndefined();
  });

  it('includes prdContext in the body when supplied', async () => {
    const fetchImpl = mockFetch(200, { plan: makeDeployPlan() });
    const ctx = buildDeployPrdContext(makePrdDocument());
    await analyzeRepo(CANONICAL, ctx, { fetchImpl });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse((call[1] as RequestInit).body as string);
    expect(sentBody.prdContext).toBeDefined();
    expect(sentBody.prdContext.title).toBe(ctx.title);
  });

  it('maps a contract error envelope to its exact code + issues', async () => {
    const fetchImpl = mockFetch(400, {
      error: {
        code: 'validation_error',
        message: 'bad',
        issues: [{ path: 'repoUrl', message: 'Too short.' }],
      },
    });
    const out = await analyzeRepo('x', undefined, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.presentation.code).toBe('validation_error');
      expect(out.presentation.issues).toEqual([{ path: 'repoUrl', message: 'Too short.' }]);
    }
  });

  it('maps repo_not_found from the envelope (not retryable, changeUrl)', async () => {
    const fetchImpl = mockFetch(404, { error: { code: 'repo_not_found', message: 'nope' } });
    const out = await analyzeRepo(CANONICAL, undefined, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.presentation.code).toBe('repo_not_found');
      expect(out.presentation.retryable).toBe(false);
      expect(out.presentation.changeUrl).toBe(true);
    }
  });

  it('falls back to the HTTP status when the error body is off-contract', async () => {
    // 503 with a body that is NOT the apiError envelope → statusToCode → repo_unavailable.
    const fetchImpl = mockFetch(503, { oops: true });
    const out = await analyzeRepo(CANONICAL, undefined, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.presentation.code).toBe('repo_unavailable');
  });

  it('treats a 200 that does not satisfy the contract as generation_failed', async () => {
    const fetchImpl = mockFetch(200, { plan: { repo: { owner: 'x' } } });
    const out = await analyzeRepo(CANONICAL, undefined, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.presentation.code).toBe('generation_failed');
  });

  it('a transport failure resolves to a network error (does not throw)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const out = await analyzeRepo(CANONICAL, undefined, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.presentation.code).toBe('network');
  });

  it('REJECTS (does not resolve to error) when the fetch is aborted', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    const fetchImpl = vi.fn(async () => {
      throw abortErr;
    }) as unknown as typeof fetch;
    await expect(analyzeRepo(CANONICAL, undefined, { fetchImpl })).rejects.toBe(abortErr);
  });

  it('honours an already-aborted signal by rejecting', async () => {
    const controller = new AbortController();
    controller.abort();
    // Real fetch throws an AbortError synchronously for an aborted signal; the
    // mock replicates that so the abort path is exercised.
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      analyzeRepo(CANONICAL, undefined, { fetchImpl, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/* -------------------------------------------------------------------------- */
/* 5. buildDeployPrdContext                                                    */
/* -------------------------------------------------------------------------- */

describe('buildDeployPrdContext', () => {
  it('maps a PrdDocument to a valid DeployPrdContext slice', () => {
    const doc = makePrdDocument();
    const ctx = buildDeployPrdContext(doc);
    expect(ctx.title).toBe(doc.title);
    expect(ctx.context).toEqual(doc.brief.context);
    expect(ctx.components).toEqual(doc.architecture.components);
    // The result must itself satisfy the contract schema.
    expect(() => deployPrdContextSchema.parse(ctx)).not.toThrow();
  });

  it('caps the summary at 1000 chars', () => {
    const doc = makePrdDocument();
    doc.prd.overview.solution = 'x'.repeat(5000);
    const ctx = buildDeployPrdContext(doc);
    expect((ctx.summary ?? '').length).toBeLessThanOrEqual(1000);
  });

  it('sends only the architecture-relevant slice, not the whole document', () => {
    const ctx = buildDeployPrdContext(makePrdDocument());
    const keys = Object.keys(ctx).sort();
    expect(keys).toEqual(['components', 'context', 'infrastructure', 'summary', 'title']);
  });
});
