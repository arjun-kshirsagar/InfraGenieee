/**
 * Tests for the 15-minute repo-snapshot cache (`RepoSnapshotCache`, task B2, docs §5).
 *
 * OFFLINE: these exercise the real `node:fs` cache against a temp directory,
 * injected via the constructor's `rootDir` option. We deliberately do NOT
 * `process.chdir` — mutating the global cwd corrupts other test files running
 * concurrently in the same vitest worker. We prove the fresh hit and every miss
 * condition, and that a corrupt or schema-mismatched file NEVER throws (same
 * posture as `src/lib/cost/pricing/cache.ts`).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RepoSnapshotCache, _internal } from '@/lib/deploy/source/cache';
import { SNAPSHOT_MAX_AGE_MINUTES } from '@/lib/deploy/repo-seam';
import type { RepoRef, RepoSnapshot } from '@/types/deploy';

let rootDir: string;

const FIXED_NOW = Date.parse('2026-07-28T12:00:00.000Z');

function newCache(now: number = FIXED_NOW): RepoSnapshotCache {
  return new RepoSnapshotCache({ rootDir, now: () => now });
}

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

function snapshot(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    ref: ref(),
    defaultBranch: 'main',
    resolvedBranch: 'main',
    meta: { primaryLanguage: 'TypeScript' },
    entries: [{ path: 'package.json', type: 'file', size: 42 }],
    files: { 'package.json': '{"name":"store"}' },
    entriesTruncated: false,
    fetchedAt: new Date(FIXED_NOW).toISOString(),
    ...overrides,
  };
}

/** Mirror of the cache's own key → filename mapping, so a test can plant a file
 *  under the exact name a real paste would read. Uses the cache's own `keyOf`
 *  so the two can never drift. `branch`/`subdir` here are the RAW values (pinned
 *  branch or null; subdir or null) exactly as they'd appear on a parsed ref. */
function cacheFilePath(r: RepoRef): string {
  const key = _internal.keyOf(r);
  const name = `${_internal.slug(r.host)}-${_internal.slug(r.owner)}-${_internal.slug(
    r.repo,
  )}-${key.branch}-${key.subdir}.json`;
  return path.join(rootDir, name);
}

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'infragenie-repo-cache-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('RepoSnapshotCache — fresh hit', () => {
  it('round-trips a branchless write and hits on a branchless read (MAJOR-2)', async () => {
    const cache = newCache();
    const snap = snapshot();
    await cache.set(snap);
    // The user did not pin a branch. Under the @default key a branchless paste
    // reads back its own write — the fix for MAJOR-2 (the old code returned null
    // before touching the disk whenever no branch was pinned).
    const read = await cache.get(ref());
    expect(read).not.toBeNull();
    expect(read?.ref.owner).toBe('acme');
    expect(read?.files['package.json']).toBe('{"name":"store"}');
  });

  it('hits on the pinned branch without an explicit branch option', async () => {
    const cache = newCache();
    const snap = snapshot({
      ref: ref({ branch: 'dev' }),
      resolvedBranch: 'dev',
    });
    await cache.set(snap);
    const read = await cache.get(ref({ branch: 'dev' }));
    expect(read?.resolvedBranch).toBe('dev');
  });
});

describe('RepoSnapshotCache — miss conditions', () => {
  it('is a MISS when the file is absent (pinned)', async () => {
    const cache = newCache();
    expect(await cache.get(ref(), { branch: 'main' })).toBeNull();
  });

  it('is a MISS when a branchless read finds nothing written', async () => {
    const cache = newCache();
    // No pinned branch and no file under the @default key → miss (never guesses).
    expect(await cache.get(ref())).toBeNull();
  });

  it('is a MISS when the snapshot is stale (older than the TTL)', async () => {
    // Write with an old fetchedAt, read with a now past the 15-min window.
    const staleAt = new Date(FIXED_NOW).toISOString();
    await newCache(FIXED_NOW).set(snapshot({ fetchedAt: staleAt }));

    const laterNow = FIXED_NOW + (SNAPSHOT_MAX_AGE_MINUTES + 1) * 60 * 1000;
    const read = await newCache(laterNow).get(ref());
    expect(read).toBeNull();
  });

  it('is still a HIT just inside the TTL window', async () => {
    await newCache(FIXED_NOW).set(snapshot());
    const justInside = FIXED_NOW + (SNAPSHOT_MAX_AGE_MINUTES - 1) * 60 * 1000;
    const read = await newCache(justInside).get(ref());
    expect(read).not.toBeNull();
  });

  it('is a MISS on corrupt JSON — never throws', async () => {
    writeFileSync(cacheFilePath(ref()), '{ this is not json', 'utf-8');
    const cache = newCache();
    await expect(cache.get(ref())).resolves.toBeNull();
  });

  it('is a MISS on a schema-mismatched file — never throws', async () => {
    writeFileSync(
      cacheFilePath(ref()),
      JSON.stringify({ ref: { host: 'github' }, notASnapshot: true }),
      'utf-8',
    );
    const cache = newCache();
    await expect(cache.get(ref())).resolves.toBeNull();
  });

  it('is a MISS when the file holds a snapshot for a different repo (mis-filed)', async () => {
    // Valid snapshot for a DIFFERENT repo written under this key's filename.
    const other = snapshot({ ref: ref({ owner: 'other', repo: 'thing' }) });
    writeFileSync(cacheFilePath(ref()), JSON.stringify(other), 'utf-8');
    const cache = newCache();
    expect(await cache.get(ref())).toBeNull();
  });

  it('is a MISS when resolvedBranch does not match the pinned branch', async () => {
    // A pinned 'main' read must reject a file whose resolvedBranch is 'canary'.
    const pinned = ref({ branch: 'main' });
    const snap = snapshot({ ref: pinned, resolvedBranch: 'canary' });
    writeFileSync(cacheFilePath(pinned), JSON.stringify(snap), 'utf-8');
    const cache = newCache();
    expect(await cache.get(pinned)).toBeNull();
  });
});

describe('RepoSnapshotCache — write posture', () => {
  it('refuses to persist an invalid snapshot and does not throw', async () => {
    const cache = newCache();
    // Missing required fields → schema-invalid; set() must no-op silently.
    await expect(
      cache.set({ ref: ref() } as unknown as RepoSnapshot),
    ).resolves.toBeUndefined();
    expect(await cache.get(ref(), { branch: 'main' })).toBeNull();
  });

  it('never throws when the cache dir is unwritable (best-effort)', async () => {
    // rootDir points at a path whose parent is a FILE, so mkdir fails.
    const filePath = path.join(rootDir, 'blocker');
    writeFileSync(filePath, 'x', 'utf-8');
    const blocked = new RepoSnapshotCache({
      rootDir: path.join(filePath, 'nested'),
      now: () => FIXED_NOW,
    });
    await expect(blocked.set(snapshot())).resolves.toBeUndefined();
  });
});
