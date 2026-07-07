/**
 * InfraGenie — Feature 3, the GitHub `RepoSource` (task B2, docs §5).
 *
 * SERVER-ONLY by construction: it talks to the network. It holds NO token and
 * sends NO `Authorization` header — every call is anonymous (docs §5 / the seam
 * contract in `../repo-seam`). Never import this from a client component; the
 * client calls `POST /api/deploy/analyze`.
 *
 * ## Request plan (measured 2026-07-28, do not re-guess)
 *
 * Anonymous `api.github.com` gives 60 core requests/hour/IP (`x-ratelimit-limit`),
 * so every request must earn its place. One analysis costs `2 + N` core requests
 * (metadata + tree, +1 more only on the branch-retry) plus up to
 * `MAX_PROBE_FILES` (16) content reads against `raw.githubusercontent.com`,
 * which is NOT part of the 60/hr core budget.
 *
 *   1. `GET /repos/{owner}/{repo}`            → defaultBranch + RepoMeta.
 *   2. `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`
 *                                             → entries + `entriesTruncated`.
 *   3. `GET raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}` for each
 *      probe file the tree PROVES exists, in priority order, capped at 16 files
 *      and 64 KB each (`Range: bytes=0-65535`, head-first).
 *
 * ## Honesty rules baked in
 *
 *   - **404 conflates absent and private** — anonymous GitHub returns 404 for
 *     both. We throw `RepoError('not_found')`; the message names both.
 *   - **A file we could not read is ABSENT from `snapshot.files`** — never
 *     present-and-empty. An empty string would be a fabricated signal.
 *   - **We never probe a file the tree did not list.** Blind probing is
 *     unaffordable and would fabricate a "file exists" signal on a 404 body.
 *   - **Lockfiles are NOT probed for content** — their mere presence in the tree
 *     is the package-manager signal, so reading their bytes wastes a request.
 *   - The returned snapshot is parsed against `repoSnapshotSchema` before it
 *     leaves this module (the seam contract).
 */

import {
  MAX_PROBE_FILES,
  MAX_PROBE_FILE_BYTES,
  repoSnapshotSchema,
  type RepoEntry,
  type RepoMeta,
  type RepoRef,
  type RepoSnapshot,
} from '@/types/deploy';

import { RepoError, type RepoSource, type RepoSourceOptions } from '../repo-seam';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';

/** GitHub asks unauthenticated callers to send a UA; a missing UA is a 403. */
const USER_AGENT = 'InfraGenie-deploy-analyzer';

/** Sent on every API call. Note: NO `Authorization` — anonymous by design. */
const API_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': USER_AGENT,
};

/**
 * Files whose CONTENTS we read, in priority order. We intersect this with what
 * the tree proves exists and stop at `MAX_PROBE_FILES`. Lockfiles are
 * deliberately absent — their presence (from the tree) is the package-manager
 * signal, so reading their bytes would waste a probe.
 */
export const PROBE_FILES: readonly string[] = [
  'package.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'nuxt.config.ts',
  'svelte.config.js',
  'remix.config.js',
  'astro.config.mjs',
  'vite.config.js',
  'vite.config.ts',
  'angular.json',
  'gatsby-config.js',
  'netlify.toml',
  'vercel.json',
  'render.yaml',
  'Dockerfile',
  'docker-compose.yml',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'manage.py',
  'Gemfile',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'mix.exs',
  'pom.xml',
  'build.gradle',
  'config.toml',
  'hugo.toml',
  '_config.yml',
  '.tool-versions',
  '.nvmrc',
  'Procfile',
] as const;

/* -------------------------------------------------------------------------- */
/* Wire shapes (only the fields we read)                                      */
/* -------------------------------------------------------------------------- */

interface GhRepo {
  default_branch?: unknown;
  description?: unknown;
  language?: unknown;
  topics?: unknown;
  pushed_at?: unknown;
  fork?: unknown;
  archived?: unknown;
  size?: unknown;
}

interface GhTreeEntry {
  path?: unknown;
  type?: unknown; // 'blob' | 'tree' | 'commit'
  size?: unknown;
}

interface GhTree {
  tree?: unknown;
  truncated?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Options / dependency injection                                             */
/* -------------------------------------------------------------------------- */

export interface GitHubRepoSourceOptions {
  /** Injectable `fetch` for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for `fetchedAt`. Defaults to `Date.now`. */
  now?: () => number;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Parse a `Retry-After` header (seconds, or an HTTP date) into seconds-from-now. */
function retryAfterSeconds(res: Response, now: number): number | undefined {
  const header = res.headers.get('retry-after');
  if (header) {
    const asNum = Number(header);
    if (Number.isFinite(asNum) && asNum >= 0) return Math.round(asNum);
    const asDate = Date.parse(header);
    if (Number.isFinite(asDate)) return Math.max(0, Math.round((asDate - now) / 1000));
  }
  // GitHub's rate-limit reset is a UNIX epoch (seconds) in this header.
  const reset = res.headers.get('x-ratelimit-reset');
  if (reset) {
    const resetTs = Number(reset);
    if (Number.isFinite(resetTs)) return Math.max(0, Math.round(resetTs - now / 1000));
  }
  return undefined;
}

/** True when a 403/429 is specifically a rate-limit response (not e.g. a UA
 *  block). GitHub sets `x-ratelimit-remaining: 0` when the budget is spent. */
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining === '0') return true;
  // Some secondary limits omit the remaining header but set retry-after.
  return res.headers.has('retry-after');
}

/**
 * Map any non-OK API response to a `RepoError`. Called for the metadata and
 * tree requests (raw-content failures are handled inline as "file absent").
 */
function apiErrorFor(res: Response, now: number, what: string): RepoError {
  if (res.status === 404) {
    return new RepoError(
      'not_found',
      `Repository not found. It may not exist, or it may be private (${what}).`,
    );
  }
  if ((res.status === 403 || res.status === 429) && isRateLimited(res)) {
    const retry = retryAfterSeconds(res, now);
    return new RepoError('rate_limited', `GitHub rate limit reached while reading ${what}.`, {
      ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
    });
  }
  // Any other 4xx or any 5xx → unavailable (retryable-ish; the route decides).
  return new RepoError('unavailable', `GitHub returned ${res.status} while reading ${what}.`);
}

/* -------------------------------------------------------------------------- */
/* The source                                                                 */
/* -------------------------------------------------------------------------- */

export class GitHubRepoSource implements RepoSource {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options?: GitHubRepoSourceOptions) {
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.now = options?.now ?? Date.now;
  }

  async fetchSnapshot(ref: RepoRef, options?: RepoSourceOptions): Promise<RepoSnapshot> {
    if (ref.host !== 'github') {
      // The seam declares GitHub-only content reads in v1. A non-GitHub ref
      // should never reach this implementation — treat it as unsupported
      // rather than silently building an empty snapshot.
      throw new RepoError('unsupported_host', `GitHubRepoSource cannot read ${ref.host} repos.`);
    }
    const signal = options?.signal;

    // 1 — metadata.
    const { defaultBranch, meta } = await this.fetchMeta(ref, signal);

    // 2 — tree for the resolved branch, with the one branch/subdir retry.
    const requestedBranch = ref.branch ?? defaultBranch;
    const { resolvedBranch, treeEntries, entriesTruncated } = await this.fetchTreeWithRetry(
      ref,
      requestedBranch,
      defaultBranch,
      signal,
    );

    // Scope to the subdir (if any) and normalise paths relative to that root.
    const { entries, existingPaths } = scopeEntries(treeEntries, ref.subdir);

    // 3 — probe file contents, capped.
    const files = await this.probeFiles(ref, resolvedBranch, existingPaths, signal);

    const snapshot: RepoSnapshot = {
      ref,
      defaultBranch,
      resolvedBranch,
      meta,
      entries,
      files,
      entriesTruncated,
      fetchedAt: new Date(this.now()).toISOString(),
    };

    // The snapshot MUST satisfy the contract before it leaves this module.
    const parsed = repoSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new RepoError(
        'unavailable',
        `Built a malformed snapshot: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    return parsed.data;
  }

  /* ---- step 1: metadata ---- */

  private async fetchMeta(
    ref: RepoRef,
    signal?: AbortSignal,
  ): Promise<{ defaultBranch: string; meta: RepoMeta }> {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
    const res = await this.doFetch(url, { headers: API_HEADERS, signal }, 'repository metadata');
    if (!res.ok) throw apiErrorFor(res, this.now(), 'repository metadata');

    let body: GhRepo;
    try {
      body = (await res.json()) as GhRepo;
    } catch (err) {
      throw new RepoError('unavailable', 'GitHub returned unparseable repository metadata.', {
        cause: err,
      });
    }

    const defaultBranch = asString(body.default_branch);
    if (!defaultBranch) {
      throw new RepoError('unavailable', 'GitHub metadata omitted the default branch.');
    }

    const meta: RepoMeta = {};
    const description = asString(body.description);
    if (description !== undefined) meta.description = description;
    const language = asString(body.language);
    if (language !== undefined) meta.primaryLanguage = language;
    if (Array.isArray(body.topics)) {
      meta.topics = body.topics.filter((t): t is string => typeof t === 'string').slice(0, 30);
    }
    const pushedAt = asString(body.pushed_at);
    if (pushedAt !== undefined) meta.pushedAt = pushedAt;
    if (typeof body.fork === 'boolean') meta.isFork = body.fork;
    if (typeof body.archived === 'boolean') meta.isArchived = body.archived;
    if (typeof body.size === 'number' && Number.isFinite(body.size) && body.size >= 0) {
      meta.sizeKb = Math.floor(body.size);
    }

    return { defaultBranch, meta };
  }

  /* ---- step 2: tree, with the single branch/subdir retry ---- */

  private async fetchTreeWithRetry(
    ref: RepoRef,
    requestedBranch: string,
    defaultBranch: string,
    signal?: AbortSignal,
  ): Promise<{ resolvedBranch: string; treeEntries: GhTreeEntry[]; entriesTruncated: boolean }> {
    const first = await this.fetchTree(ref, requestedBranch, signal);
    if (first !== 'not_found') {
      return { resolvedBranch: requestedBranch, ...first };
    }

    // B1's `/tree/a/b` guess may have split a single branch `a/b` into
    // branch `a` + subdir `b`. If the guessed branch 404s AND a subdir exists,
    // retry ONCE treating `<branch>/<first-subdir-segment>` as the branch.
    // One retry, not a search.
    if (ref.subdir) {
      const firstSeg = ref.subdir.split('/')[0];
      const retriedBranch = `${requestedBranch}/${firstSeg}`;
      const retry = await this.fetchTree(ref, retriedBranch, signal);
      if (retry !== 'not_found') {
        return { resolvedBranch: retriedBranch, ...retry };
      }
    }

    // Genuinely absent branch (and the retry, if any, also 404'd).
    throw new RepoError(
      'not_found',
      `Branch "${requestedBranch}" not found. The repository may not exist, be private, or use a different default branch.`,
    );
  }

  /** Fetch one tree. Returns `'not_found'` on 404 so the caller can retry; any
   *  other non-OK status throws immediately (no point retrying a rate limit). */
  private async fetchTree(
    ref: RepoRef,
    branch: string,
    signal?: AbortSignal,
  ): Promise<'not_found' | { treeEntries: GhTreeEntry[]; entriesTruncated: boolean }> {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
      ref.repo,
    )}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
    const res = await this.doFetch(url, { headers: API_HEADERS, signal }, `tree for ${branch}`);
    if (res.status === 404) return 'not_found';
    if (!res.ok) throw apiErrorFor(res, this.now(), `tree for ${branch}`);

    let body: GhTree;
    try {
      body = (await res.json()) as GhTree;
    } catch (err) {
      throw new RepoError('unavailable', 'GitHub returned an unparseable tree.', { cause: err });
    }

    const rawTree = Array.isArray(body.tree) ? (body.tree as GhTreeEntry[]) : [];
    return { treeEntries: rawTree, entriesTruncated: body.truncated === true };
  }

  /* ---- step 3: probe file contents ---- */

  private async probeFiles(
    ref: RepoRef,
    branch: string,
    existingPaths: Set<string>,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    let probed = 0;

    for (const probe of PROBE_FILES) {
      if (probed >= MAX_PROBE_FILES) break;
      if (!existingPaths.has(probe)) continue; // only probe what the tree proves exists
      probed += 1;

      const content = await this.fetchRaw(ref, branch, probe, signal);
      // A file we couldn't read stays ABSENT — never present-and-empty.
      if (content !== null) files[probe] = content;
    }

    return files;
  }

  /**
   * Read one file head-first via `raw.githubusercontent.com` (NOT part of the
   * 60/hr core budget), capped at `MAX_PROBE_FILE_BYTES`. Returns `null` on any
   * failure — an unreadable file must be ABSENT from `files`, not empty.
   *
   * The subdir prefix is re-applied here because `raw` paths are repo-root
   * relative, whereas `probe`/`existingPaths` are analysed-root relative.
   */
  private async fetchRaw(
    ref: RepoRef,
    branch: string,
    relPath: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const repoPath = ref.subdir ? `${ref.subdir}/${relPath}` : relPath;
    const url = `${GITHUB_RAW}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(
      ref.repo,
    )}/${encodeURIComponent(branch)}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: {
          'User-Agent': USER_AGENT,
          // Head-first: ask for only the first 64 KB. A server that ignores
          // Range returns the whole body (200), which we truncate below.
          Range: `bytes=0-${MAX_PROBE_FILE_BYTES - 1}`,
        },
        ...(signal ? { signal } : {}),
      });
    } catch {
      return null; // network/timeout on a probe → file absent, not fatal
    }

    // 200 (Range ignored) and 206 (Partial Content) both carry a usable body.
    if (res.status !== 200 && res.status !== 206) return null;

    let text: string;
    try {
      text = await res.text();
    } catch {
      return null;
    }
    // Enforce the byte cap even when the server ignored Range. Slice by bytes,
    // not chars, so a multi-byte tail cannot exceed the cap; detection tolerates
    // a truncated tail (types/deploy.ts §files).
    const bytes = Buffer.from(text, 'utf-8');
    if (bytes.byteLength > MAX_PROBE_FILE_BYTES) {
      return bytes.subarray(0, MAX_PROBE_FILE_BYTES).toString('utf-8');
    }
    return text;
  }

  /* ---- shared fetch wrapper ---- */

  /** Perform an API fetch, converting a thrown network/abort error into a
   *  `RepoError('unavailable')` so callers only ever see `RepoError`. */
  private async doFetch(
    url: string,
    init: RequestInit,
    what: string,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw new RepoError('unavailable', `Network error while reading ${what}.`, { cause: err });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Pure tree → entries scoping (exported for unit tests)                      */
/* -------------------------------------------------------------------------- */

/**
 * Convert a recursive git tree into `RepoEntry[]`, scoped to `subdir` when set,
 * with every path made relative to the analysed root. Also returns the set of
 * FILE paths (relative to the root) so the prober only reads files that exist.
 *
 * - `blob` → `file`, `tree` → `dir`; `commit` (submodule) entries are dropped.
 * - When `subdir` is set, only entries under `<subdir>/` are kept and the
 *   `<subdir>/` prefix is stripped; the subdir directory itself is excluded.
 * - Capped at the schema's 2000-entry limit (docs §5: a truncated tree still
 *   yields a snapshot — detection handles the truncation).
 */
export function scopeEntries(
  tree: GhTreeEntry[],
  subdir: string | null,
): { entries: RepoEntry[]; existingPaths: Set<string> } {
  const prefix = subdir ? `${subdir.replace(/\/+$/, '')}/` : '';
  const entries: RepoEntry[] = [];
  const existingPaths = new Set<string>();

  for (const raw of tree) {
    const p = asString(raw.path);
    if (!p) continue;
    const type = raw.type === 'blob' ? 'file' : raw.type === 'tree' ? 'dir' : null;
    if (type === null) continue; // submodules etc. are not files we can read

    let rel = p;
    if (prefix) {
      if (!p.startsWith(prefix)) continue; // outside the analysed subdir
      rel = p.slice(prefix.length);
      if (rel.length === 0) continue; // the subdir dir itself
    }
    if (rel.length > 400) continue; // schema cap on path length

    const entry: RepoEntry = { path: rel, type };
    if (typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0) {
      entry.size = Math.floor(raw.size);
    }
    entries.push(entry);
    if (type === 'file') existingPaths.add(rel);

    if (entries.length >= 2000) break; // schema cap on entry count
  }

  return { entries, existingPaths };
}

/** Shared instance for the analyze route. */
export const gitHubRepoSource = new GitHubRepoSource();

export const _internal = { retryAfterSeconds, isRateLimited, apiErrorFor, asString };
