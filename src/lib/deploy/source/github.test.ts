/**
 * Tests for the GitHub `RepoSource` (task B2, docs §5).
 *
 * OFFLINE: `fetch` is fully stubbed via the constructor's `fetchImpl` option, so
 * these run with no network and burn no GitHub budget. We cover the happy path,
 * every error mapping (404 → not_found, 403 rate-limit → rate_limited +
 * retryAfterSeconds, 500 → unavailable), a truncated tree, subdir scoping, the
 * single branch/subdir retry, and that the 16-file / 64 KB caps are actually
 * enforced.
 *
 * NO auth: a dedicated test asserts no request ever carries an Authorization
 * header (the anonymous-only contract, docs §5).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GitHubRepoSource,
  PROBE_FILES,
  scopeEntries,
} from '@/lib/deploy/source/github';
import { RepoError } from '@/lib/deploy/repo-seam';
import { MAX_PROBE_FILE_BYTES, MAX_PROBE_FILES, type RepoRef } from '@/types/deploy';

const FIXED_NOW = Date.parse('2026-07-28T12:00:00.000Z');

function ref(overrides: Partial<RepoRef> = {}): RepoRef {
  return {
    host: 'github',
    owner: 'acme',
    repo: 'store',
    branch: null,
    subdir: null,
    canonicalUrl: 'https://github.com/acme/store',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* A tiny fetch router: map a URL predicate → a Response factory.             */
/* -------------------------------------------------------------------------- */

type Route = { match: (url: string) => boolean; respond: (url: string) => Response };

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeFetch(routes: Route[]): { fetchImpl: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(new Request(url, init));
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`unrouted fetch: ${url}`);
    return route.respond(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const isMetaUrl = (u: string) => /api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(u);
const isTreeUrl = (u: string) => /\/git\/trees\//.test(u);
const isRawUrl = (u: string) => u.startsWith('https://raw.githubusercontent.com/');

function metaRoute(body: Record<string, unknown> = {}): Route {
  return {
    match: isMetaUrl,
    respond: () => json({ default_branch: 'main', language: 'TypeScript', ...body }),
  };
}

function treeRoute(paths: Array<{ path: string; type?: string; size?: number }>, truncated = false): Route {
  return {
    match: isTreeUrl,
    respond: () =>
      json({
        tree: paths.map((p) => ({ path: p.path, type: p.type ?? 'blob', size: p.size })),
        truncated,
      }),
  };
}

function rawRoute(bodyFor: (path: string) => string | null): Route {
  return {
    match: isRawUrl,
    respond: (url) => {
      // The path after /owner/repo/branch/ is the file path.
      const m = /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/.exec(url);
      const filePath = m ? decodeURIComponent(m[1].split('/').map(decodeURIComponent).join('/')) : '';
      const body = bodyFor(filePath);
      if (body === null) return new Response('Not Found', { status: 404 });
      return new Response(body, { status: 206 });
    },
  };
}

function source(fetchImpl: typeof fetch): GitHubRepoSource {
  return new GitHubRepoSource({ fetchImpl, now: () => FIXED_NOW });
}

/* -------------------------------------------------------------------------- */
/* Happy path                                                                 */
/* -------------------------------------------------------------------------- */

describe('GitHubRepoSource — happy path', () => {
  it('builds a schema-valid snapshot: meta + tree + probed contents', async () => {
    const { fetchImpl } = makeFetch([
      metaRoute({ description: 'a store', topics: ['ecommerce'], fork: false, archived: false, size: 1024 }),
      treeRoute([
        { path: 'package.json', type: 'blob', size: 120 },
        { path: 'next.config.js', type: 'blob' },
        { path: 'src', type: 'tree' },
        { path: 'pnpm-lock.yaml', type: 'blob' }, // present but NOT probed for content
      ]),
      rawRoute((p) =>
        p === 'package.json'
          ? '{"dependencies":{"next":"^15.0.0"}}'
          : p === 'next.config.js'
            ? 'module.exports = {}'
            : null,
      ),
    ]);

    const snap = await source(fetchImpl).fetchSnapshot(ref());

    expect(snap.defaultBranch).toBe('main');
    expect(snap.resolvedBranch).toBe('main');
    expect(snap.meta.description).toBe('a store');
    expect(snap.meta.topics).toEqual(['ecommerce']);
    expect(snap.entries.map((e) => e.path).sort()).toEqual(
      ['next.config.js', 'package.json', 'pnpm-lock.yaml', 'src'].sort(),
    );
    // Both probe files present; the lockfile is NOT read for content.
    expect(Object.keys(snap.files).sort()).toEqual(['next.config.js', 'package.json']);
    expect(snap.files['package.json']).toContain('next');
    expect(snap.files['pnpm-lock.yaml']).toBeUndefined();
    expect(snap.fetchedAt).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('probes files in PROBE_FILES priority order and only those the tree lists', async () => {
    const { fetchImpl, calls } = makeFetch([
      metaRoute(),
      treeRoute([{ path: 'requirements.txt' }, { path: 'README.md' }]),
      rawRoute((p) => (p === 'requirements.txt' ? 'flask==3.0' : null)),
    ]);

    const snap = await source(fetchImpl).fetchSnapshot(ref());
    expect(snap.files).toEqual({ 'requirements.txt': 'flask==3.0' });
    // README.md is not in PROBE_FILES → no raw request for it.
    const rawCalls = calls.filter((c) => isRawUrl(c.url));
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0].url).toContain('requirements.txt');
  });
});

/* -------------------------------------------------------------------------- */
/* A file that could not be read is ABSENT, never present-and-empty           */
/* -------------------------------------------------------------------------- */

describe('GitHubRepoSource — unreadable probe file', () => {
  it('omits a probe file whose raw fetch 404s (absent, not empty string)', async () => {
    const { fetchImpl } = makeFetch([
      metaRoute(),
      treeRoute([{ path: 'package.json' }, { path: 'vercel.json' }]),
      rawRoute((p) => (p === 'package.json' ? '{}' : null)), // vercel.json 404s
    ]);
    const snap = await source(fetchImpl).fetchSnapshot(ref());
    expect(snap.files).toHaveProperty('package.json');
    expect(snap.files).not.toHaveProperty('vercel.json');
  });

  it('omits a probe file whose raw fetch throws (network error → absent)', async () => {
    const { fetchImpl } = makeFetch([
      metaRoute(),
      treeRoute([{ path: 'package.json' }]),
      {
        match: isRawUrl,
        respond: () => {
          throw new Error('boom');
        },
      },
    ]);
    const snap = await source(fetchImpl).fetchSnapshot(ref());
    expect(snap.files).not.toHaveProperty('package.json');
  });
});

/* -------------------------------------------------------------------------- */
/* Error mapping                                                              */
/* -------------------------------------------------------------------------- */

describe('GitHubRepoSource — error mapping', () => {
  it('maps a 404 on metadata to RepoError not_found', async () => {
    const { fetchImpl } = makeFetch([
      { match: isMetaUrl, respond: () => new Response('Not Found', { status: 404 }) },
    ]);
    await expect(source(fetchImpl).fetchSnapshot(ref())).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('maps a 403 rate-limit to RepoError rate_limited with retryAfterSeconds', async () => {
    const reset = Math.floor(FIXED_NOW / 1000) + 900; // 15 min from now
    const { fetchImpl } = makeFetch([
      {
        match: isMetaUrl,
        respond: () =>
          new Response('rate limited', {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(reset),
            },
          }),
      },
    ]);
    let caught: unknown;
    try {
      await source(fetchImpl).fetchSnapshot(ref());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RepoError);
    expect((caught as RepoError).code).toBe('rate_limited');
    expect((caught as RepoError).retryAfterSeconds).toBe(900);
  });

  it('honours a Retry-After header (seconds) on a 429', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: isMetaUrl,
        respond: () => new Response('slow down', { status: 429, headers: { 'retry-after': '42' } }),
      },
    ]);
    let caught: RepoError | undefined;
    try {
      await source(fetchImpl).fetchSnapshot(ref());
    } catch (e) {
      caught = e as RepoError;
    }
    expect(caught?.code).toBe('rate_limited');
    expect(caught?.retryAfterSeconds).toBe(42);
  });

  it('maps a 500 on metadata to RepoError unavailable', async () => {
    const { fetchImpl } = makeFetch([
      { match: isMetaUrl, respond: () => new Response('boom', { status: 500 }) },
    ]);
    await expect(source(fetchImpl).fetchSnapshot(ref())).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('maps a network throw on metadata to RepoError unavailable', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: isMetaUrl,
        respond: () => {
          throw new Error('ECONNRESET');
        },
      },
    ]);
    await expect(source(fetchImpl).fetchSnapshot(ref())).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('maps a 500 on the TREE request to unavailable (not a 404 retry)', async () => {
    const { fetchImpl } = makeFetch([
      metaRoute(),
      { match: isTreeUrl, respond: () => new Response('boom', { status: 500 }) },
    ]);
    await expect(source(fetchImpl).fetchSnapshot(ref())).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('rejects a non-GitHub ref as unsupported_host', async () => {
    const { fetchImpl } = makeFetch([]);
    await expect(
      source(fetchImpl).fetchSnapshot(ref({ host: 'gitlab', canonicalUrl: 'https://gitlab.com/acme/store' })),
    ).rejects.toMatchObject({ code: 'unsupported_host' });
  });
});

/* -------------------------------------------------------------------------- */
/* Truncated tree                                                             */
/* -------------------------------------------------------------------------- */

describe('GitHubRepoSource — truncated tree', () => {
  it('still returns a snapshot with entriesTruncated: true', async () => {
    const { fetchImpl } = makeFetch([
      metaRoute(),
      treeRoute([{ path: 'package.json' }], /* truncated */ true),
      rawRoute(() => '{}'),
    ]);
    const snap = await source(fetchImpl).fetchSnapshot(ref());
    expect(snap.entriesTruncated).toBe(true);
    expect(snap.files).toHaveProperty('package.json');
  });
});

/* -------------------------------------------------------------------------- */
/* Subdir scoping                                                             */
/* -------------------------------------------------------------------------- */

describe('GitHubRepoSource — subdir scoping', () => {
  it('scopes entries to the subdir, makes paths relative, and probes the scoped root', async () => {
    const { fetchImpl, calls } = makeFetch([
      metaRoute(),
      treeRoute([
        { path: 'apps/web/package.json' },
        { path: 'apps/web/next.config.js' },
        { path: 'apps/api/package.json' }, // sibling subdir — excluded
        { path: 'README.md' }, // repo root — excluded
      ]),
      rawRoute((p) =>
        // raw paths are repo-root relative → include the subdir prefix.
        p === 'apps/web/package.json' ? '{"scoped":true}' : p === 'apps/web/next.config.js' ? 'x' : null,
      ),
    ]);

    const snap = await source(fetchImpl).fetchSnapshot(ref({ subdir: 'apps/web' }));

    // Entries are relative to apps/web, sibling + root entries excluded.
    expect(snap.entries.map((e) => e.path).sort()).toEqual(['next.config.js', 'package.json']);
    // files keys are also relative to the scoped root.
    expect(snap.files['package.json']).toBe('{"scoped":true}');
    expect(Object.keys(snap.files)).not.toContain('apps/web/package.json');

    // The raw URL requested the repo-root path (with the subdir prefix).
    const rawUrls = calls.filter((c) => isRawUrl(c.url)).map((c) => c.url);
    expect(rawUrls.some((u) => u.includes('apps/web/package.json'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Branch/subdir retry                                                        */
/* -------------------------------------------------------------------------- */

describe('GitHubRepoSource — branch/subdir retry', () => {
  it('retries once treating <branch>/<first-subdir-seg> as the branch when the first tree 404s', async () => {
    // B1 guessed branch='feat', subdir='x/app' from /tree/feat/x/app, but the
    // real branch is 'feat/x'. First tree (feat) 404s; retry (feat/x) succeeds.
    let treeCalls = 0;
    const { fetchImpl } = makeFetch([
      metaRoute(),
      {
        match: isTreeUrl,
        respond: (url) => {
          treeCalls += 1;
          // The branch segment is URL-encoded in the path.
          if (url.includes('/git/trees/feat%2Fx')) {
            return json({ tree: [{ path: 'package.json', type: 'blob' }], truncated: false });
          }
          return new Response('Not Found', { status: 404 });
        },
      },
      rawRoute((p) => (p === 'package.json' ? '{}' : null)),
    ]);

    const snap = await source(fetchImpl).fetchSnapshot(ref({ branch: 'feat', subdir: 'x/app' }));
    expect(treeCalls).toBe(2); // one failed guess + one successful retry
    expect(snap.resolvedBranch).toBe('feat/x');
    // subdir 'x/app' still scopes the retried branch's tree — package.json is at
    // repo root here so it is excluded by the subdir; the point is the branch
    // resolved, which the assertion above proves. Entries may be empty.
    expect(snap.entriesTruncated).toBe(false);
  });

  it('does NOT retry when there is no subdir — a 404 tree is not_found', async () => {
    let treeCalls = 0;
    const { fetchImpl } = makeFetch([
      metaRoute(),
      {
        match: isTreeUrl,
        respond: () => {
          treeCalls += 1;
          return new Response('Not Found', { status: 404 });
        },
      },
    ]);
    await expect(
      source(fetchImpl).fetchSnapshot(ref({ branch: 'nope', subdir: null })),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(treeCalls).toBe(1); // exactly one attempt, no retry
  });
});

/* -------------------------------------------------------------------------- */
/* Caps: 16 files, 64 KB each                                                 */
/* -------------------------------------------------------------------------- */

describe('GitHubRepoSource — caps', () => {
  it('probes at most MAX_PROBE_FILES files even when more exist in the tree', async () => {
    // Put MANY probe files (more than 16) in the tree.
    const many = PROBE_FILES.slice(0, MAX_PROBE_FILES + 5).map((p) => ({ path: p }));
    const { fetchImpl, calls } = makeFetch([
      metaRoute(),
      treeRoute(many),
      rawRoute(() => 'x'),
    ]);
    const snap = await source(fetchImpl).fetchSnapshot(ref());
    const rawCalls = calls.filter((c) => isRawUrl(c.url));
    expect(rawCalls.length).toBe(MAX_PROBE_FILES);
    expect(Object.keys(snap.files).length).toBe(MAX_PROBE_FILES);
  });

  it('truncates a probe file body to MAX_PROBE_FILE_BYTES', async () => {
    const huge = 'A'.repeat(MAX_PROBE_FILE_BYTES + 5000);
    const { fetchImpl } = makeFetch([
      metaRoute(),
      treeRoute([{ path: 'package.json' }]),
      // Simulate a server that IGNORED the Range header and returned 200 + full body.
      {
        match: isRawUrl,
        respond: () => new Response(huge, { status: 200 }),
      },
    ]);
    const snap = await source(fetchImpl).fetchSnapshot(ref());
    expect(Buffer.byteLength(snap.files['package.json'], 'utf-8')).toBe(MAX_PROBE_FILE_BYTES);
  });

  it('sends a Range header on raw requests (head-first)', async () => {
    const { fetchImpl, calls } = makeFetch([
      metaRoute(),
      treeRoute([{ path: 'package.json' }]),
      rawRoute(() => '{}'),
    ]);
    await source(fetchImpl).fetchSnapshot(ref());
    const rawCall = calls.find((c) => isRawUrl(c.url));
    expect(rawCall?.headers.get('range')).toBe(`bytes=0-${MAX_PROBE_FILE_BYTES - 1}`);
  });
});

/* -------------------------------------------------------------------------- */
/* Anonymous-only: NO Authorization header anywhere                           */
/* -------------------------------------------------------------------------- */

describe('GitHubRepoSource — anonymous only', () => {
  it('never sends an Authorization or token header on any request', async () => {
    const { fetchImpl, calls } = makeFetch([
      metaRoute(),
      treeRoute([{ path: 'package.json' }]),
      rawRoute(() => '{}'),
    ]);
    await source(fetchImpl).fetchSnapshot(ref());
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBeNull();
      // No token smuggled into any header name/value.
      for (const [name, value] of call.headers.entries()) {
        expect(name.toLowerCase()).not.toContain('token');
        expect(value.toLowerCase()).not.toContain('bearer');
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Pure scopeEntries unit tests                                               */
/* -------------------------------------------------------------------------- */

describe('scopeEntries', () => {
  it('maps blob→file, tree→dir, and drops submodules', () => {
    const { entries, existingPaths } = scopeEntries(
      [
        { path: 'a.txt', type: 'blob', size: 10 },
        { path: 'dir', type: 'tree' },
        { path: 'sub', type: 'commit' }, // submodule → dropped
      ],
      null,
    );
    expect(entries).toEqual([
      { path: 'a.txt', type: 'file', size: 10 },
      { path: 'dir', type: 'dir' },
    ]);
    expect([...existingPaths]).toEqual(['a.txt']);
  });

  it('scopes to a subdir and strips the prefix', () => {
    const { entries, existingPaths } = scopeEntries(
      [
        { path: 'apps/web/index.ts', type: 'blob' },
        { path: 'apps/api/index.ts', type: 'blob' },
        { path: 'apps/web', type: 'tree' },
      ],
      'apps/web',
    );
    expect(entries.map((e) => e.path)).toEqual(['index.ts']);
    expect([...existingPaths]).toEqual(['index.ts']);
  });

  it('caps at 2000 entries', () => {
    const big = Array.from({ length: 2500 }, (_, i) => ({ path: `f${i}.txt`, type: 'blob' }));
    const { entries } = scopeEntries(big, null);
    expect(entries.length).toBe(2000);
  });
});
