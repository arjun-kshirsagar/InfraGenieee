/**
 * InfraGenie — Feature 3 seam: the one impure boundary in one-click deploy.
 *
 * Owned by: **architect**. Backend implements `RepoSource` in
 * `src/lib/deploy/source/`; everything downstream of it is pure.
 *
 * ## Why a seam
 *
 * Exactly one step of this feature touches the network: reading the user's
 * public repository. Detection, provider fit, URL building and config
 * generation are all pure functions of a `RepoSnapshot`. Putting the network
 * behind an interface means:
 *
 *   1. the whole detection matrix is unit-tested from fixtures, deterministically;
 *   2. the LIVE smoke test swaps in the real GitHub source and asserts the same
 *      pure functions against real repos (mocks alone hid real bugs in
 *      Features 1 and 2 — this is the lesson, encoded);
 *   3. no UI component can accidentally import a fetcher.
 *
 * ## SERVER-ONLY
 *
 * Implementations of `RepoSource` must never be imported from a client
 * component (docs/architecture.md §3 rule 4). The client calls
 * `POST /api/deploy/analyze`.
 *
 * ## Cost safety
 *
 * This seam READS public repositories anonymously. It holds no provider token,
 * calls no deploy API, and creates nothing. If an implementation ever needs a
 * credential, that is a scope change requiring the owner's approval first
 * (docs/architecture.md §6) — do not add one silently.
 */

import type { RepoRef, RepoSnapshot } from '@/types/deploy';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Why reading a repo failed. Maps onto the public API error codes in
 * `src/lib/prd/api.ts` (`ERROR_STATUS`) via `REPO_ERROR_CODE` below.
 *
 * `not_found` deliberately conflates "typo" and "private": anonymous GitHub
 * returns 404 for both (verified 2026-07-28), so claiming to know which one it
 * is would be a fabrication. The user-facing message names both possibilities.
 */
export type RepoErrorCode =
  | 'invalid_url' // not parseable as a repo URL at all
  | 'unsupported_host' // parseable, but not a git host we support
  | 'not_found' // 404 — absent or private
  | 'rate_limited' // 403/429 — anonymous budget exhausted (retryable)
  | 'unavailable' // 5xx / network / timeout (retryable)
  | 'too_large'; // the tree is so big we refuse to analyse it

export class RepoError extends Error {
  readonly code: RepoErrorCode;
  /** Seconds until a retry could succeed, when the host told us. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: RepoErrorCode,
    message: string,
    options?: { cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RepoError';
    this.code = code;
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

/** True when retrying the exact same request could plausibly succeed. */
export function isRetryable(code: RepoErrorCode): boolean {
  return code === 'rate_limited' || code === 'unavailable';
}

/* -------------------------------------------------------------------------- */
/* The seam                                                                   */
/* -------------------------------------------------------------------------- */

export interface RepoSourceOptions {
  /** Propagated from the route handler so a client abort cancels the fetches. */
  signal?: AbortSignal;
}

/**
 * Reads a public repository into a `RepoSnapshot`.
 *
 * Contract implementations MUST honour:
 *
 *   - **Anonymous only.** No token, no auth header. If a repo needs auth, throw
 *     `RepoError('not_found')`.
 *   - **Bounded.** At most `MAX_PROBE_FILES` content reads per call, each capped
 *     at `MAX_PROBE_FILE_BYTES`. Probe only files the root listing proves exist.
 *   - **Throws `RepoError`, never a raw fetch error.** The route maps
 *     `RepoError.code` → HTTP status; an unmapped error becomes a 500.
 *   - **Returns schema-valid data.** The snapshot must parse against
 *     `repoSnapshotSchema` before it leaves the implementation.
 *   - **Never partially invents.** A file that could not be read is ABSENT from
 *     `files`, never present-but-empty — detection distinguishes "no such file"
 *     from "empty file" and an empty string would be a fabricated signal.
 */
export interface RepoSource {
  fetchSnapshot(ref: RepoRef, options?: RepoSourceOptions): Promise<RepoSnapshot>;
}

/* -------------------------------------------------------------------------- */
/* Caching (optional, same posture as Feature 2's price-book cache)           */
/* -------------------------------------------------------------------------- */

/**
 * Optional snapshot cache. Anonymous GitHub allows 60 core requests/hour/IP
 * (measured 2026-07-28 from `x-ratelimit-limit`), so a user who re-analyses the
 * same repo — or a reviewer running the live smoke test — must not burn the
 * budget twice.
 *
 * A MISS returns `null` and the caller rebuilds. Reads must NEVER throw: a
 * corrupt or schema-mismatched entry is a miss, not a crash (the posture
 * `src/lib/prd/store.ts` and `src/lib/cost/pricing/cache.ts` already take).
 */
export interface RepoSnapshotCache {
  get(ref: RepoRef, options?: { branch?: string }): Promise<RepoSnapshot | null>;
  set(snapshot: RepoSnapshot): Promise<void>;
}

/** Snapshots go stale fast — the user is actively pushing to this repo. */
export const SNAPSHOT_MAX_AGE_MINUTES = 15;
