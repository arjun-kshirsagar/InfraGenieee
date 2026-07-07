/**
 * InfraGenie — Feature 3, the 15-minute repo-snapshot cache (task B2, docs §5).
 *
 * SERVER-ONLY (uses `node:fs`). Implements `RepoSnapshotCache` from
 * `../repo-seam`. Never import this from a client component.
 *
 * ## Why a file, not a Map
 *
 * Anonymous GitHub allows only 60 core requests/hour/IP (measured 2026-07-28 via
 * `x-ratelimit-limit`). Analysing one repo costs ~3 core requests, so a user who
 * re-analyses the same URL — or a reviewer running the live smoke test — must
 * not burn a second budget. A file survives dev-server restarts where an
 * in-process `Map` does not, which is exactly what protects the budget across a
 * hot reload. No database, nothing to provision, no cost-safety question.
 *
 * Snapshots are stored PER (host, owner, repo, branch) at
 * `.cache/repos/<host>-<owner>-<repo>-<branch>.json` (gitignored under `.cache/`)
 * so a different branch of the same repo cannot serve a stale snapshot.
 *
 * ## Miss conditions (a MISS returns null; the caller then re-fetches)
 *
 *   1. the file is absent;
 *   2. it is older than `SNAPSHOT_MAX_AGE_MINUTES` (by `fetchedAt`) — the user
 *      is actively pushing, so a long TTL would lie;
 *   3. it is not valid JSON, or fails `repoSnapshotSchema`;
 *   4. its ref/branch does not match what was asked for (a mis-filed snapshot).
 *
 * Reads NEVER throw: a corrupt or schema-mismatched file is treated as a miss,
 * so a schema change can never crash the app on a stale file — the same posture
 * as `src/lib/cost/pricing/cache.ts` and Feature 1's `store.ts`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { repoSnapshotSchema, type RepoRef, type RepoSnapshot } from '@/types/deploy';

import { SNAPSHOT_MAX_AGE_MINUTES, type RepoSnapshotCache as RepoSnapshotCacheContract } from '../repo-seam';

/** Default cache root, relative to the process cwd (the repo root at dev/build
 *  time). Computed per-call (not cached at module load). A test injects its own
 *  `rootDir` via the constructor instead of changing the global cwd — mutating
 *  `process.cwd()` would corrupt other test files running in the same worker. */
function defaultCacheDir(): string {
  return path.join(process.cwd(), '.cache', 'repos');
}

const MS_PER_MINUTE = 60 * 1000;

/** True when `fetchedAt` is older than the max age (or unparseable). */
function isStale(fetchedAt: string, now: number): boolean {
  const ts = Date.parse(fetchedAt);
  if (!Number.isFinite(ts)) return true; // unparseable → treat as stale
  return now - ts > SNAPSHOT_MAX_AGE_MINUTES * MS_PER_MINUTE;
}

/** Sanitise a ref component into a safe, collision-resistant filename fragment.
 *  Branch names legally contain `/` (e.g. `feat/x`) which is a path separator,
 *  so every component is flattened: anything outside `[A-Za-z0-9._-]` becomes
 *  `_`. Two different branches can only collide if they differ solely by an
 *  illegal char, which the branch/host match guard below then rejects anyway. */
function slug(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Filesystem cache for repo snapshots. Instantiate once and reuse; it holds no
 * state itself (each call hits the disk), so it is safe to share.
 */
export class RepoSnapshotCache implements RepoSnapshotCacheContract {
  /** Injectable clock for tests. Defaults to `Date.now`. */
  private readonly now: () => number;
  /** Injectable cache root for tests. Defaults to `<cwd>/.cache/repos`. */
  private readonly rootDir: string;

  constructor(options?: { now?: () => number; rootDir?: string }) {
    this.now = options?.now ?? Date.now;
    this.rootDir = options?.rootDir ?? defaultCacheDir();
  }

  private filePath(ref: RepoRef, branch: string): string {
    const name = `${slug(ref.host)}-${slug(ref.owner)}-${slug(ref.repo)}-${slug(branch)}.json`;
    // Join defensively via basename: even though every component is already
    // slugged, a future caller cannot path-traverse out of the cache dir.
    return path.join(this.rootDir, path.basename(name));
  }

  /**
   * Read the cached snapshot for a ref+branch, or `null` on any miss. Never
   * throws. `branch` defaults to `ref.branch` (the branch the user pinned via
   * `/tree/...`); when neither is known the caller has no key to hit on, so
   * this returns null rather than guessing `main`.
   */
  async get(ref: RepoRef, options?: { branch?: string }): Promise<RepoSnapshot | null> {
    const branch = options?.branch ?? ref.branch ?? null;
    if (branch === null) return null; // no key → nothing to hit

    let raw: string;
    try {
      raw = await readFile(this.filePath(ref, branch), 'utf-8');
    } catch {
      return null; // absent / unreadable → miss
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // corrupt JSON → miss (no crash)
    }

    const result = repoSnapshotSchema.safeParse(parsed);
    if (!result.success) return null; // schema mismatch → miss

    const snapshot = result.data;

    // Guard against a mis-filed snapshot (wrong repo/branch in this key's file).
    if (
      snapshot.ref.host !== ref.host ||
      snapshot.ref.owner !== ref.owner ||
      snapshot.ref.repo !== ref.repo
    ) {
      return null;
    }
    if (snapshot.resolvedBranch !== branch) return null;
    // Age gate — the user is actively pushing, so a stale snapshot lies.
    if (isStale(snapshot.fetchedAt, this.now())) return null;

    return snapshot;
  }

  /**
   * Write a snapshot to its per-(host,owner,repo,branch) file, creating the
   * cache dir if needed. The snapshot is re-validated before writing so a
   * malformed one can never be persisted. Write failures are swallowed
   * (best-effort cache) — a caller must still get its freshly-built snapshot
   * even if the disk is read-only.
   */
  async set(snapshot: RepoSnapshot): Promise<void> {
    const validated = repoSnapshotSchema.safeParse(snapshot);
    if (!validated.success) {
      console.warn(
        '[deploy.cache] refusing to write an invalid snapshot for %s/%s: %s',
        (snapshot as { ref?: { owner?: string; repo?: string } }).ref?.owner ?? '?',
        (snapshot as { ref?: { owner?: string; repo?: string } }).ref?.repo ?? '?',
        validated.error.issues.map((i) => i.message).join('; '),
      );
      return;
    }

    const snap = validated.data;
    try {
      await mkdir(this.rootDir, { recursive: true });
      await writeFile(
        this.filePath(snap.ref, snap.resolvedBranch),
        JSON.stringify(snap, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.warn(
        '[deploy.cache] failed to write snapshot for %s/%s: %s',
        snap.ref.owner,
        snap.ref.repo,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** Shared instance for the analyze route. */
export const repoSnapshotCache = new RepoSnapshotCache();

export const _internal = { defaultCacheDir, isStale, slug };
