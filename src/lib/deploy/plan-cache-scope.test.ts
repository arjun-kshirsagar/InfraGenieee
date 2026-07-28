/**
 * Regression tests for F3 BLOCKER-1 / MAJOR-1 / MAJOR-2 (fix task t_9833d2aa).
 *
 * These wire the REAL `RepoSnapshotCache` (a `node:fs` cache in a temp dir) to
 * the REAL `buildDeployPlan`, with only the network `RepoSource` stubbed. That
 * is the layer the pure-function tests never covered and where the adversarial
 * LIVE QA found three confidently-wrong bugs:
 *
 *   BLOCKER-1  the cache key omitted `subdir`, and the plan trusted
 *              `snapshot.ref`, so a user pasting the repo ROOT was served the
 *              cached SUBDIR scope — deploy URLs into a `/prisma` directory they
 *              never asked for.
 *   MAJOR-1    a branchless paste resolved to `main` and its cache file (with
 *              `ref.branch = null`) was then served to a later `/tree/<branch>`
 *              paste, dropping the pin from every deploy URL.
 *   MAJOR-2    `get()` returned null before touching the disk whenever no branch
 *              was pinned, while `set()` filed under the resolved branch — so the
 *              ordinary (branchless) paste NEVER hit the cache and every
 *              re-analysis burned a fresh anonymous GitHub budget.
 *
 * The assertions are deliberately on `plan.repo` and on the emitted `deployUrl`s
 * — the things a user actually acts on — not merely on the snapshot, and on the
 * exact number of `fetchSnapshot` calls the cache lets through.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RepoRef, RepoSnapshot } from '@/types/deploy';

import { buildDeployPlan, type BuildDeployPlanDeps } from './plan';
import { RepoSnapshotCache } from './source/cache';
import type { RepoSource } from './repo-seam';

const FIXED_NOW = '2026-07-29T00:00:00.000Z';

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'infragenie-plan-scope-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

/**
 * A stub source that behaves like the real GitHub source in the one way that
 * matters here: it echoes the REQUESTED ref back as `snapshot.ref` and resolves
 * a null branch to `defaultBranch`. It records every ref it is asked to fetch so
 * a test can assert the cache prevented a redundant fetch. A single root-level
 * `package.json` makes detection deterministic (a plain Node app).
 */
function countingSource(defaultBranch = 'master'): {
  source: RepoSource;
  fetched: string[];
} {
  const fetched: string[] = [];
  return {
    fetched,
    source: {
      async fetchSnapshot(ref: RepoRef): Promise<RepoSnapshot> {
        fetched.push(`${ref.owner}/${ref.repo}@${ref.branch ?? '(default)'}/${ref.subdir ?? '(root)'}`);
        return {
          ref, // the real source sets snapshot.ref = the parsed ref, verbatim
          defaultBranch,
          resolvedBranch: ref.branch ?? defaultBranch,
          meta: { primaryLanguage: 'TypeScript' },
          entries: [{ path: 'package.json', type: 'file', size: 40 }],
          files: { 'package.json': '{"name":"app","dependencies":{}}' },
          entriesTruncated: false,
          fetchedAt: FIXED_NOW,
        };
      },
    },
  };
}

function deps(source: RepoSource): BuildDeployPlanDeps {
  return {
    source,
    cache: new RepoSnapshotCache({ rootDir, now: () => Date.parse(FIXED_NOW) }),
    now: () => FIXED_NOW,
  };
}

function vercelUrl(plan: Awaited<ReturnType<typeof buildDeployPlan>>): string {
  return plan.fits.find((f) => f.provider === 'vercel')!.deployUrl;
}
function netlifyUrl(plan: Awaited<ReturnType<typeof buildDeployPlan>>): string {
  return plan.fits.find((f) => f.provider === 'netlify')!.deployUrl;
}

/* -------------------------------------------------------------------------- */
/* BLOCKER-1 — root vs. subdir must never see each other's snapshot            */
/* -------------------------------------------------------------------------- */

describe('F3 BLOCKER-1 — a subdir cache entry must not be served to a root paste', () => {
  it('a root paste analyses the ROOT even after a subdir paste of the same repo+branch', async () => {
    const { source, fetched } = countingSource('master');
    const d = deps(source);

    // user1 — a SUBDIR paste primes the cache for scope apps/../prisma@master.
    const subdirPlan = await buildDeployPlan(
      'https://github.com/gothinkster/node-express-realworld-example-app/tree/master/prisma',
      d,
    );
    expect(subdirPlan.repo.subdir).toBe('prisma');
    expect(subdirPlan.repo.branch).toBe('master');

    // user2 — the plain REPO ROOT on the SAME branch. Must NOT inherit `prisma`.
    const rootPlan = await buildDeployPlan(
      'https://github.com/gothinkster/node-express-realworld-example-app/tree/master',
      d,
    );

    // Identity: the root paste is the root, period.
    expect(rootPlan.repo.subdir).toBeNull();
    expect(rootPlan.repo.branch).toBe('master');

    // The emitted deploy URLs are what the user clicks — assert on them.
    expect(vercelUrl(rootPlan)).not.toContain('prisma');
    expect(vercelUrl(rootPlan)).not.toContain(encodeURIComponent('/prisma'));
    expect(netlifyUrl(rootPlan)).not.toContain('base=prisma');
    // The subdir plan, by contrast, DID carry prisma into its Vercel path.
    expect(vercelUrl(subdirPlan)).toContain(encodeURIComponent('/tree/master/prisma'));

    // And because the scopes differ, the root paste genuinely re-fetched.
    expect(fetched).toEqual([
      'gothinkster/node-express-realworld-example-app@master/prisma',
      'gothinkster/node-express-realworld-example-app@master/(root)',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* MAJOR-1 — a branchless entry must not be served to a later pinned paste     */
/* -------------------------------------------------------------------------- */

describe('F3 MAJOR-1 — a pinned paste keeps its branch even after a branchless one', () => {
  it('does not drop /tree/<branch> from the deploy URLs when a branchless entry exists', async () => {
    const { source, fetched } = countingSource('main');
    const d = deps(source);

    // user1 — branchless paste; resolves to `main`, files under the @default key.
    const branchless = await buildDeployPlan('https://github.com/acme/app', d);
    expect(branchless.repo.branch).toBeNull();
    // Branchless + a path-suffix provider → bare repo (no /tree anchor).
    expect(vercelUrl(branchless)).toContain(encodeURIComponent('https://github.com/acme/app'));
    expect(vercelUrl(branchless)).not.toContain(encodeURIComponent('/tree/'));

    // user2 — pins the SAME branch explicitly. Must keep the pin in its URL.
    const pinned = await buildDeployPlan('https://github.com/acme/app/tree/main', d);
    expect(pinned.repo.branch).toBe('main');
    expect(vercelUrl(pinned)).toContain(encodeURIComponent('/tree/main'));

    // Two distinct scopes → two fetches (the branchless entry was NOT reused).
    expect(fetched).toEqual(['acme/app@(default)/(root)', 'acme/app@main/(root)']);
  });

  it('a NON-default pinned branch deploys that branch, not the cached default', async () => {
    const { source } = countingSource('main');
    const d = deps(source);

    await buildDeployPlan('https://github.com/acme/app', d); // primes @default (main)
    const feature = await buildDeployPlan('https://github.com/acme/app/tree/feature-x', d);

    expect(feature.repo.branch).toBe('feature-x');
    expect(vercelUrl(feature)).toContain(encodeURIComponent('/tree/feature-x'));
    expect(vercelUrl(feature)).not.toContain(encodeURIComponent('/tree/main'));
  });
});

/* -------------------------------------------------------------------------- */
/* MAJOR-2 — the ordinary branchless paste must hit the cache                  */
/* -------------------------------------------------------------------------- */

describe('F3 MAJOR-2 — 3 analyses of a branchless URL make exactly 1 fetch', () => {
  it('re-analysing the ordinary (branchless) paste does not burn a second budget', async () => {
    const { source, fetched } = countingSource('main');
    const d = deps(source);

    const url = 'https://github.com/acme/store';
    const a = await buildDeployPlan(url, d);
    const b = await buildDeployPlan(url, d);
    const c = await buildDeployPlan(url, d);

    // Exactly one network fetch across three analyses — the docs §5 promise.
    expect(fetched).toHaveLength(1);

    // And the three plans are identical (same clock, same input).
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('a pinned URL also hits after the first fetch (regression guard)', async () => {
    const { source, fetched } = countingSource('main');
    const d = deps(source);

    const url = 'https://github.com/acme/store/tree/main';
    await buildDeployPlan(url, d);
    await buildDeployPlan(url, d);
    await buildDeployPlan(url, d);

    expect(fetched).toHaveLength(1);
  });
});
