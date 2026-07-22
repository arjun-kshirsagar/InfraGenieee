/**
 * Tests for the PURE-ish plan builder `buildDeployPlan` (task B7).
 *
 * OFFLINE and FREE. The one impure dependency — the `RepoSource` — is a STUB
 * that returns a fixture snapshot (or throws a `RepoError`); the clock is an
 * injected constant. So every branch of the pipeline is exercised with no
 * network and no real `Date`, and the output is fully deterministic.
 *
 * Coverage (docs §1, §5, §8 + acceptance criteria):
 *   - happy path: a Next.js app → nextjs/ssr, Vercel primary, 3 fits, schema-valid
 *   - full-stack + DB: Render primary, a render.yaml config artifact present
 *   - non-GitHub host: fetch SKIPPED, confidence 'unknown', primary null, 3 URLs
 *   - each RepoError from parse or source propagates unchanged
 *   - the injected clock supplies generatedAt (never new Date() inline)
 *   - a cache HIT is used and the source is never called
 *   - a cache MISS falls through to the source, then populates the cache
 */

import { describe, expect, it, vi } from 'vitest';

import {
  deployPlanSchema,
  type RepoRef,
  type RepoSnapshot,
} from '@/types/deploy';

import { buildDeployPlan, type BuildDeployPlanDeps } from './plan';
import { RepoError } from './repo-seam';
import type { RepoSource, RepoSnapshotCache } from './repo-seam';
import { FIXTURES } from './detect/__fixtures__';

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

const FIXED_NOW = '2026-07-28T18:30:00.000Z';

/** Look up a detect fixture snapshot by name (they are self-consistent repos). */
function fixture(name: string): RepoSnapshot {
  const fx = FIXTURES.find((f) => f.name === name);
  if (!fx) throw new Error(`fixture not found: ${name}`);
  return fx.snapshot;
}

/** A stub source that returns a fixed snapshot; records its calls. */
function stubSource(snapshot: RepoSnapshot): { source: RepoSource; calls: RepoRef[] } {
  const calls: RepoRef[] = [];
  return {
    calls,
    source: {
      async fetchSnapshot(ref) {
        calls.push(ref);
        return snapshot;
      },
    },
  };
}

/** A stub source that always throws the given RepoError. */
function throwingSource(error: RepoError): RepoSource {
  return {
    async fetchSnapshot() {
      throw error;
    },
  };
}

function deps(source: RepoSource, cache?: RepoSnapshotCache): BuildDeployPlanDeps {
  return { source, cache, now: () => FIXED_NOW };
}

/* -------------------------------------------------------------------------- */
/* Happy path — Next.js                                                       */
/* -------------------------------------------------------------------------- */

describe('buildDeployPlan — happy path (Next.js)', () => {
  it('detects nextjs/ssr, crowns Vercel, returns three fits, schema-valid', async () => {
    const { source } = stubSource(fixture('nextjs-app-router'));
    const plan = await buildDeployPlan(
      'https://github.com/acme/app',
      deps(source),
    );

    // Every 200-worthy plan parses against the contract.
    expect(deployPlanSchema.safeParse(plan).success).toBe(true);

    expect(plan.detection.framework).toBe('nextjs');
    expect(plan.detection.appShape).toBe('ssr');
    expect(plan.primary).toBe('vercel');

    // Always exactly three fits, one per provider.
    expect(plan.fits).toHaveLength(3);
    expect(new Set(plan.fits.map((f) => f.provider))).toEqual(
      new Set(['vercel', 'netlify', 'render']),
    );
    // Every fit carries a real deploy URL and ≥1 reason.
    for (const fit of plan.fits) {
      expect(fit.deployUrl).toMatch(/^https:\/\//);
      expect(fit.reasons.length).toBeGreaterThanOrEqual(1);
    }
    // The Vercel URL points at the user's repo.
    const vercel = plan.fits.find((f) => f.provider === 'vercel')!;
    expect(vercel.deployUrl).toContain(encodeURIComponent('https://github.com/acme/app'));
  });

  it('stamps generatedAt from the INJECTED clock, never new Date()', async () => {
    const { source } = stubSource(fixture('nextjs-app-router'));
    const plan = await buildDeployPlan('https://github.com/acme/app', deps(source));
    expect(plan.generatedAt).toBe(FIXED_NOW);
  });

  it('is deterministic for the same input + clock', async () => {
    const a = await buildDeployPlan(
      'https://github.com/acme/app',
      deps(stubSource(fixture('nextjs-app-router')).source),
    );
    const b = await buildDeployPlan(
      'https://github.com/acme/app',
      deps(stubSource(fixture('nextjs-app-router')).source),
    );
    expect(a).toEqual(b);
  });
});

/* -------------------------------------------------------------------------- */
/* Full-stack + database → Render primary, render.yaml generated              */
/* -------------------------------------------------------------------------- */

describe('buildDeployPlan — full-stack + DB', () => {
  it('crowns Render and emits a render.yaml config artifact', async () => {
    const { source } = stubSource(fixture('express-prisma-postgres'));
    const plan = await buildDeployPlan('https://github.com/acme/app', deps(source));

    expect(deployPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.detection.appShape).toBe('fullstack');
    expect(plan.detection.needs).toContain('database');
    expect(plan.primary).toBe('render');

    const renderConfig = plan.configs.find((c) => c.provider === 'render');
    expect(renderConfig).toBeDefined();
    expect(renderConfig!.filename).toBe('render.yaml');
    expect(renderConfig!.content.length).toBeGreaterThan(0);

    // The Render fit must flag that the blueprint has to be committed first.
    const render = plan.fits.find((f) => f.provider === 'render')!;
    expect(render.requiresConfig).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Non-GitHub host — fetch skipped, unknown, primary null, 3 URLs still there */
/* -------------------------------------------------------------------------- */

describe('buildDeployPlan — non-GitHub host', () => {
  it('skips the fetch, returns unknown confidence, null primary, three URLs', async () => {
    // A source that would blow up if called — proving the fetch is skipped.
    const source: RepoSource = {
      async fetchSnapshot() {
        throw new Error('fetchSnapshot must NOT be called for a non-GitHub host');
      },
    };

    const plan = await buildDeployPlan('https://gitlab.com/acme/app', deps(source));

    expect(deployPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.repo.host).toBe('gitlab');
    expect(plan.detection.confidence).toBe('unknown');
    expect(plan.detection.framework).toBe('unknown');
    expect(plan.primary).toBeNull();

    // A note must explain what we couldn't read.
    expect(plan.detection.notes.join(' ').toLowerCase()).toContain('github only');

    // All three buttons still work — only detection is missing.
    expect(plan.fits).toHaveLength(3);
    for (const fit of plan.fits) {
      expect(fit.deployUrl).toMatch(/^https:\/\//);
      expect(fit.deployUrl).toContain(encodeURIComponent('https://gitlab.com/acme/app'));
    }
    // No configs are generated for a stack we couldn't read.
    expect(plan.configs).toHaveLength(0);
  });

  it('does the same for a Bitbucket host', async () => {
    const source: RepoSource = {
      async fetchSnapshot() {
        throw new Error('must not fetch');
      },
    };
    const plan = await buildDeployPlan('https://bitbucket.org/acme/app', deps(source));
    expect(plan.repo.host).toBe('bitbucket');
    expect(plan.detection.confidence).toBe('unknown');
    expect(plan.primary).toBeNull();
    expect(plan.fits).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/* RepoError propagation                                                      */
/* -------------------------------------------------------------------------- */

describe('buildDeployPlan — RepoError propagation', () => {
  it('propagates invalid_url from parseRepoUrl (no source call)', async () => {
    const source: RepoSource = {
      async fetchSnapshot() {
        throw new Error('must not fetch');
      },
    };
    await expect(buildDeployPlan('not a url', deps(source))).rejects.toMatchObject({
      name: 'RepoError',
      code: 'invalid_url',
    });
  });

  it('propagates unsupported_host from parseRepoUrl (no source call)', async () => {
    const source: RepoSource = {
      async fetchSnapshot() {
        throw new Error('must not fetch');
      },
    };
    await expect(
      buildDeployPlan('https://git.example.com/acme/app', deps(source)),
    ).rejects.toMatchObject({ name: 'RepoError', code: 'unsupported_host' });
  });

  it.each(['not_found', 'rate_limited', 'unavailable', 'too_large'] as const)(
    'propagates RepoError("%s") from the source unchanged',
    async (code) => {
      const err = new RepoError(code, `stub ${code}`, { retryAfterSeconds: 42 });
      const plan = buildDeployPlan(
        'https://github.com/acme/app',
        deps(throwingSource(err)),
      );
      await expect(plan).rejects.toBe(err);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Cache behaviour                                                            */
/* -------------------------------------------------------------------------- */

describe('buildDeployPlan — snapshot cache', () => {
  it('uses a cache HIT and never calls the source', async () => {
    const snapshot = fixture('nextjs-app-router');
    const { source, calls } = stubSource(snapshot);
    const cache: RepoSnapshotCache = {
      get: vi.fn().mockResolvedValue(snapshot),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const plan = await buildDeployPlan(
      'https://github.com/acme/app',
      deps(source, cache),
    );

    expect(plan.detection.framework).toBe('nextjs');
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0); // source untouched
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('on a cache MISS fetches from the source and populates the cache', async () => {
    const snapshot = fixture('nextjs-app-router');
    const { source, calls } = stubSource(snapshot);
    const cache: RepoSnapshotCache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };

    await buildDeployPlan('https://github.com/acme/app', deps(source, cache));

    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1); // source hit once
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(snapshot);
  });
});
