/**
 * InfraGenie — Feature 3, step 1: the pure repo-URL parser (B1).
 *
 * Owned by: **backend**. PURE: same input → same output, no network, no clock,
 * no `Date`, no randomness. This is the first box in the pipeline
 * (docs/feature-3-one-click-deploy.md §1): the user pastes whatever they have in
 * their address bar / clone dialog, and `parseRepoUrl` turns it into the one
 * normalised `RepoRef` (defined in `src/types/deploy.ts`) the rest of the
 * feature builds on. The type is imported, never redefined (architecture §3
 * rule 1); every value we return is asserted against `repoRefSchema` in the
 * test.
 *
 * ## Shapes we accept (the ones people actually paste)
 *
 *   https://github.com/o/r              https://github.com/o/r/
 *   https://github.com/o/r.git          http://github.com/o/r
 *   github.com/o/r                      www.github.com/o/r
 *   git@github.com:o/r.git              ssh://git@github.com/o/r.git
 *   https://github.com/o/r/tree/main               → branch 'main'
 *   https://github.com/o/r/tree/feat/x             → branch 'feat/x'
 *   https://github.com/o/r/tree/main/apps/web      → branch 'main' + subdir 'apps/web'
 *   https://gitlab.com/o/r              https://bitbucket.org/o/r
 *
 * Plus surrounding whitespace, and a trailing `#fragment` / `?query` (e.g.
 * `#readme`, `?tab=readme-ov-file`), which are stripped before parsing.
 *
 * ## The branch / subdirectory ambiguity — handled honestly
 *
 * `/tree/a/b` is genuinely ambiguous to a *pure* parser: it could be branch `a`
 * with subdir `b`, or the single branch `a/b` (slashes are legal in git branch
 * names — GitHub renders `feat/x` exactly as `/tree/feat/x`). No amount of
 * string parsing resolves this without the repo's real branch list.
 *
 * Decision (documented so B2 can correct it): we take the **first** segment
 * after `/tree/` as the branch and everything after it as `subdir`. So
 * `/tree/main/apps/web` → `{ branch: 'main', subdir: 'apps/web' }`, and
 * `/tree/feat/x` → `{ branch: 'feat', subdir: 'x' }` — which may be WRONG if
 * `feat/x` was actually one branch. B2 (the GitHub `RepoSource`) is expected to
 * fix this cheaply against the repo's real default/branch list when it reads the
 * snapshot; if it cannot, the single-segment reading is the safe default because
 * a subdir that doesn't exist is a softer failure than a branch that 404s. We do
 * NOT silently pick one reading and pretend it's certain — the ambiguity is
 * called out here and left correctable downstream.
 *
 * ## Rejections
 *
 *   - `javascript:` / `data:` (and any other non-git scheme) → `invalid_url`.
 *   - no owner/repo, or an owner/repo with a path separator or a character
 *     outside `[A-Za-z0-9._-]` → `invalid_url`.
 *   - a well-formed git URL on a host that isn't github/gitlab/bitbucket
 *     (e.g. `https://git.example.com/o/r`) → `unsupported_host`.
 */

import { repoHostSchema, repoRefSchema, type RepoHost, type RepoRef } from '@/types/deploy';

import { RepoError } from './repo-seam';

/* -------------------------------------------------------------------------- */
/* Host table                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The three hosts we recognise, keyed by their canonical registrable domain.
 * `canonicalUrl` is always built from `domain`, so `www.github.com` and a bare
 * `github.com` both canonicalise to `https://github.com/...`.
 */
const HOST_TABLE: Record<RepoHost, { domain: string; aliases: readonly string[] }> = {
  github: { domain: 'github.com', aliases: ['github.com', 'www.github.com'] },
  gitlab: { domain: 'gitlab.com', aliases: ['gitlab.com', 'www.gitlab.com'] },
  bitbucket: { domain: 'bitbucket.org', aliases: ['bitbucket.org', 'www.bitbucket.org'] },
};

/** owner / repo segment charset, mirrored from `repoRefSchema` so a paste that
 *  would fail the schema fails here first with a precise message. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Schemes that are never a repo URL and must be refused outright. */
const DANGEROUS_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file']);

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function fail(message: string): never {
  throw new RepoError('invalid_url', message);
}

/** Map a raw hostname to one of our `RepoHost`s, or `null` if we don't host it. */
function resolveHost(hostname: string): RepoHost | null {
  const lower = hostname.toLowerCase();
  for (const host of repoHostSchema.options) {
    if (HOST_TABLE[host].aliases.includes(lower)) return host;
  }
  return null;
}

/** Strip a single trailing `.git` (case-insensitive) from a repo segment. */
function stripDotGit(repo: string): string {
  return repo.replace(/\.git$/i, '');
}

/**
 * Split the path portion of a URL (already free of scheme/host/query/fragment)
 * into `{ owner, repo, branch, subdir }`. The path may or may not start with a
 * slash; empty segments (from `//` or a trailing `/`) are dropped.
 */
function parsePathSegments(path: string): {
  owner: string;
  repo: string;
  branch: string | null;
  subdir: string | null;
} {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) {
    fail('URL is missing an owner and repository (expected <host>/<owner>/<repo>).');
  }

  const owner = segments[0];
  const repo = stripDotGit(segments[1]);

  if (!SEGMENT_RE.test(owner)) {
    fail(`Invalid repository owner "${owner}" — must match [A-Za-z0-9._-].`);
  }
  if (!SEGMENT_RE.test(repo)) {
    fail(`Invalid repository name "${repo}" — must match [A-Za-z0-9._-].`);
  }

  let branch: string | null = null;
  let subdir: string | null = null;

  // Anything after `<owner>/<repo>` is only meaningful when it's `/tree/...`.
  // We deliberately ignore other trailing paths (`/blob/...`, `/pull/1`, …):
  // they carry no ref info a pure parser can trust, and guessing would be a
  // fabrication. `/tree/<branch>[/<subdir>]` is the one shape GitHub renders
  // for "look at this ref", so it's the only one we lift.
  if (segments.length >= 4 && segments[2].toLowerCase() === 'tree') {
    const rest = segments.slice(3);
    // First segment after /tree/ is the branch (see module header on the
    // branch/subdir ambiguity); the remainder, if any, is the subdirectory.
    branch = rest[0];
    if (rest.length > 1) {
      subdir = rest.slice(1).join('/');
    }
  }

  return { owner, repo, branch, subdir };
}

/**
 * Turn whatever the user pasted into a `{ hostname, path }` pair, normalising
 * away the four scheme families we accept:
 *
 *   1. `git@host:owner/repo.git`      (SCP-like syntax — no `//`, uses `:`)
 *   2. `ssh://git@host/owner/repo.git`
 *   3. `http(s)://host/owner/repo`
 *   4. bare `host/owner/repo` / `www.host/owner/repo` (no scheme)
 *
 * A dangerous scheme (`javascript:`, `data:`, …) throws here before any host
 * resolution — those are never a repo URL.
 */
function extractHostAndPath(raw: string): { hostname: string; path: string } {
  // Guard against dangerous / non-git schemes FIRST. `javascript:`/`data:`
  // payloads can masquerade as SCP syntax (`javascript:alert(1)//…` parses as
  // host `javascript`), so this must run before the SCP branch below.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (schemeMatch && DANGEROUS_SCHEMES.has(schemeMatch[1].toLowerCase())) {
    fail(`Refusing scheme "${schemeMatch[1]}:" — that is not a repository URL.`);
  }

  // 1. SCP-like `git@github.com:owner/repo.git`. It has a `:` that is NOT part
  //    of a `scheme://`, so detect it before the URL parser (which would choke).
  const scpMatch = /^(?:[^@/\s]+@)?([^/@:\s]+):(?!\/\/)(.+)$/.exec(raw);
  if (scpMatch && !raw.includes('://')) {
    return { hostname: scpMatch[1], path: scpMatch[2] };
  }

  // 2 + 3. Anything with an explicit scheme goes through the URL parser.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      fail('Could not parse the URL.');
    }
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ssh' && scheme !== 'git') {
      fail(`Unsupported URL scheme "${scheme}:".`);
    }
    // `URL` already strips `?query` and `#fragment` from `pathname`.
    return { hostname: url.hostname, path: url.pathname };
  }

  // 4. Bare `host/owner/repo` with no scheme. Prepend `https://` and let the URL
  //    parser normalise it (this also strips any `?`/`#` cleanly).
  try {
    const url = new URL(`https://${raw}`);
    return { hostname: url.hostname, path: url.pathname };
  } catch {
    fail('Could not parse the URL.');
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parse a pasted repository URL into a normalised {@link RepoRef}.
 *
 * @throws {RepoError} `invalid_url` when the input is not a parseable repo URL
 *   (missing owner/repo, illegal characters, or a dangerous scheme).
 * @throws {RepoError} `unsupported_host` when it parses as a git URL but the
 *   host is not github/gitlab/bitbucket.
 *
 * The returned `canonicalUrl` is always `https://<domain>/<owner>/<repo>` — no
 * `.git`, no trailing slash, no branch, no subdir — even when the input was a
 * `git@` SCP URL or plain `http`. `branch`/`subdir` are `null` unless the URL
 * carried a `/tree/...` ref.
 */
export function parseRepoUrl(raw: string): RepoRef {
  if (typeof raw !== 'string') {
    fail('Expected a repository URL string.');
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    fail('Repository URL is empty.');
  }

  // Reject path-traversal segments in the RAW input. The URL parser silently
  // collapses `o/../etc` to `etc`, which would turn a traversal paste into a
  // plausible-looking `owner/repo` — so we must catch `..` / `.` segments
  // before normalisation, not after.
  if (/(^|[/:])\.\.?([/]|$)/.test(trimmed)) {
    fail('Repository URL contains a path-traversal segment.');
  }

  const { hostname, path } = extractHostAndPath(trimmed);

  const host = resolveHost(hostname);
  if (host === null) {
    // It looks like a git URL, but it's not a host we support. This is a
    // distinct, actionable failure from "unparseable garbage".
    throw new RepoError(
      'unsupported_host',
      `Unsupported git host "${hostname}". InfraGenie supports GitHub, GitLab and Bitbucket.`,
    );
  }

  const { owner, repo, branch, subdir } = parsePathSegments(path);

  const domain = HOST_TABLE[host].domain;
  const ref: RepoRef = {
    host,
    owner,
    repo,
    branch,
    subdir,
    canonicalUrl: `https://${domain}/${owner}/${repo}`,
  };

  // Belt and braces: the value we hand downstream MUST satisfy the contract.
  // A mismatch is a bug in this parser, not user error, so surface it loudly.
  const parsed = repoRefSchema.safeParse(ref);
  if (!parsed.success) {
    fail(`Parsed a malformed RepoRef: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data;
}

/**
 * A compact human label for the UI: `owner/repo`, plus ` · <branch>` and/or
 * ` · /<subdir>` when those are present. Pure and total — never throws.
 *
 *   { owner:'acme', repo:'store' }                         → "acme/store"
 *   { …, branch:'main' }                                   → "acme/store · main"
 *   { …, branch:'main', subdir:'apps/web' }                → "acme/store · main · /apps/web"
 *   { …, subdir:'apps/web' }                               → "acme/store · /apps/web"
 */
export function formatRepoLabel(ref: RepoRef): string {
  let label = `${ref.owner}/${ref.repo}`;
  if (ref.branch) label += ` · ${ref.branch}`;
  if (ref.subdir) label += ` · /${ref.subdir}`;
  return label;
}
