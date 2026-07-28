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
 * Snapshots are stored PER ANALYSED SCOPE — (host, owner, repo, branch, subdir) —
 * at `.cache/repos/<host>-<owner>-<repo>-<branch>-<subdir>.json` (gitignored
 * under `.cache/`) so a different branch OR a different subdirectory of the same
 * repo cannot serve each other's snapshot. The `subdir` component was added in
 * fix task t_9833d2aa (F3 BLOCKER-1): a root paste and a `/prisma` subdir paste
 * of the same repo+branch previously shared one file, so one user's repo scope
 * was served to another user's request over real HTTP.
 *
 * ## Branch component: pinned vs. default (fixes MAJOR-1 and MAJOR-2)
 *
 * The key's branch component is the branch the user PINNED (`ref.branch`), or the
 * sentinel `@default` when they pasted a branchless URL. It is deliberately NOT
 * the `resolvedBranch`, because:
 *
 *   - A branchless paste (`github.com/o/r`) and a pinned paste of the same branch
 *     (`github.com/o/r/tree/main`) are DIFFERENT requests that must not collide:
 *     the pinned one has to keep its `/tree/main` in every deploy URL even when
 *     `main` happens to be the default (MAJOR-1). Two keys → two files → no bleed.
 *   - A branchless paste must be able to HIT its own earlier write. If we keyed on
 *     `resolvedBranch` we would write under `main` but read under "no key",
 *     so the ordinary paste never hit and every re-analysis burned a fresh
 *     anonymous GitHub budget (MAJOR-2). Keying both read and write under
 *     `@default` makes the ordinary paste hit.
 *
 * ## Miss conditions (a MISS returns null; the caller then re-fetches)
 *
 *   1. the file is absent;
 *   2. it is older than `SNAPSHOT_MAX_AGE_MINUTES` (by `fetchedAt`) — the user
 *      is actively pushing, so a long TTL would lie;
 *   3. it is not valid JSON, or fails `repoSnapshotSchema`;
 *   4. its scope (host/owner/repo/subdir, and branch when pinned) does not match
 *      what was asked for (a mis-filed snapshot).
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

/** Sentinel branch component for a branchless paste. `@` is illegal in the
 *  slug alphabet, so it can never collide with a real (slugged) branch name —
 *  a user cannot craft a `/tree/@default` paste that lands on this key. */
const DEFAULT_BRANCH_KEY = '@default';

/** Subdir component of the key when the paste has no subdir (the repo root).
 *  A literal empty string would produce a `...--` filename that is easy to
 *  mis-read; `_root` is unambiguous and — being slug-safe — cannot collide with
 *  a real subdir (a real one is slugged, and `_root` is not a legal repo path a
 *  user could paste because scopeEntries strips leading/trailing slashes). */
const ROOT_SUBDIR_KEY = '_root';

/**
 * The cache key components for a ref, derived from the PARSED ref (never the
 * resolved snapshot). `branch` is the pinned branch or `@default`; `subdir` is
 * the pasted subdir or `_root`. Both are already slug-safe.
 */
function keyOf(ref: RepoRef, branch?: string): { branch: string; subdir: string } {
  const pinned = branch ?? ref.branch ?? null;
  return {
    branch: pinned === null ? DEFAULT_BRANCH_KEY : slug(pinned),
    subdir: ref.subdir ? slug(ref.subdir) : ROOT_SUBDIR_KEY,
  };
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

  private filePath(ref: RepoRef, key: { branch: string; subdir: string }): string {
    // `key.branch`/`key.subdir` are already slug-safe (see keyOf); host/owner/repo
    // are slugged here. The subdir component is what fixes BLOCKER-1: root and
    // subdir pastes of the same repo+branch now resolve to DIFFERENT files.
    const name =
      `${slug(ref.host)}-${slug(ref.owner)}-${slug(ref.repo)}` +
      `-${key.branch}-${key.subdir}.json`;
    // Join defensively via basename: even though every component is already
    // slugged, a future caller cannot path-traverse out of the cache dir.
    return path.join(this.rootDir, path.basename(name));
  }

  /**
   * Read the cached snapshot for a ref's analysed scope, or `null` on any miss.
   * Never throws.
   *
   * The scope is `(host, owner, repo, branch, subdir)`. `branch` defaults to the
   * pinned branch (`ref.branch`); when the paste was branchless we read under the
   * `@default` sentinel — the same key `set()` wrote to — so an ordinary paste
   * hits its own earlier write (this is the MAJOR-2 fix; the old code returned
   * null before ever touching the disk when no branch was pinned).
   */
  async get(ref: RepoRef, options?: { branch?: string }): Promise<RepoSnapshot | null> {
    const key = keyOf(ref, options?.branch);
    const pinnedBranch = options?.branch ?? ref.branch ?? null;

    let raw: string;
    try {
      raw = await readFile(this.filePath(ref, key), 'utf-8');
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

    // Guard against a mis-filed snapshot: the file's scope must match what was
    // asked for. This is defence in depth — the key already separates scopes —
    // but a hand-tampered or stale-schema file must never be served as another
    // scope's answer. We compare on the SCOPE-defining fields, including subdir
    // (BLOCKER-1) and, when the user pinned a branch, the resolvedBranch.
    if (
      snapshot.ref.host !== ref.host ||
      snapshot.ref.owner !== ref.owner ||
      snapshot.ref.repo !== ref.repo ||
      (snapshot.ref.subdir ?? null) !== (ref.subdir ?? null)
    ) {
      return null;
    }
    // A pinned paste must have read the branch it pinned. A branchless paste
    // (pinnedBranch === null) accepts whatever default the `@default` file
    // resolved to — by construction that file holds the default-branch read.
    if (pinnedBranch !== null && snapshot.resolvedBranch !== pinnedBranch) {
      return null;
    }
    // Age gate — the user is actively pushing, so a stale snapshot lies.
    if (isStale(snapshot.fetchedAt, this.now())) return null;

    return snapshot;
  }

  /**
   * Write a snapshot to its per-scope file, creating the cache dir if needed.
   * The key comes from the snapshot's OWN parsed ref, so a branchless read
   * (`@default`) and a pinned read (`main`) each hit the file that a matching
   * paste wrote. The snapshot is re-validated before writing so a malformed one
   * can never be persisted. Write failures are swallowed (best-effort cache) — a
   * caller must still get its freshly-built snapshot even if the disk is
   * read-only.
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
    // Key from the snapshot's own parsed ref (pinned branch or @default, plus
    // subdir) — this is the same key a matching paste will read under.
    const key = keyOf(snap.ref);
    try {
      await mkdir(this.rootDir, { recursive: true });
      await writeFile(this.filePath(snap.ref, key), JSON.stringify(snap, null, 2), 'utf-8');
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

export const _internal = { defaultCacheDir, isStale, slug, keyOf, DEFAULT_BRANCH_KEY, ROOT_SUBDIR_KEY };
