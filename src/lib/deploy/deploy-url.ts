/**
 * InfraGenie — the one-click deploy URL builder (Feature 3).
 *
 * Owned by: **architect**. PURE: same input → same output, no I/O, no clock.
 * This is the ONLY place a provider deploy URL is constructed. It is
 * table-driven off `DEPLOY_PROVIDER_META` so adding a fourth provider later is
 * a table row, not a branch.
 *
 * ## What a deploy URL is (and is not)
 *
 * It is a link into the PROVIDER'S OWN hosted project-creation flow, with the
 * user's repo pre-filled. Clicking it opens their flow in a new tab. InfraGenie
 * does not deploy, does not authenticate, and holds no provider token. That is
 * both the product design and the cost-safety guarantee (docs/architecture.md §6).
 *
 * ## Sources (verified 2026-07-28 — re-read before changing any of this)
 *
 *   Vercel   https://vercel.com/docs/deploy-button/source
 *   Netlify  https://docs.netlify.com/deploy/create-deploys  ("Deploy to Netlify button")
 *   Render   https://render.com/docs/deploy-to-render
 *
 * The per-provider parameter names, branch conventions and subdirectory
 * conventions live in `DEPLOY_PROVIDER_META` in `src/types/deploy.ts`, each with
 * its docs URL. Do not hardcode a query parameter here.
 */

import {
  DEPLOY_PROVIDER_META,
  DEPLOY_PROVIDERS,
  type DeployProvider,
  type RepoRef,
} from '@/types/deploy';

/* -------------------------------------------------------------------------- */
/* Repo value                                                                 */
/* -------------------------------------------------------------------------- */

/** Strip leading/trailing slashes so path joins can't produce `//`. */
function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

/**
 * The repo URL VALUE to hand a provider, before URL-encoding.
 *
 * Vercel and Render express a branch (and, for Vercel, a subdirectory) INSIDE
 * this value as GitHub's own `/tree/<branch>[/<subdir>]` path — that is how both
 * vendors document it. Netlify instead uses separate query parameters, so its
 * value stays the bare canonical URL.
 *
 * A subdirectory without a branch still needs one in the path, because
 * `/tree/<subdir>` would be read as a branch name. We fall back to the resolved
 * default branch, which the caller must pass — we never guess `main`, because a
 * wrong branch produces a button that 404s at the provider.
 */
export function buildRepoValue(
  ref: RepoRef,
  provider: DeployProvider,
  options?: { defaultBranch?: string },
): string {
  const meta = DEPLOY_PROVIDER_META[provider];
  const base = ref.canonicalUrl.replace(/\/+$/, '');

  const subdir = ref.subdir ? trimSlashes(ref.subdir) : null;
  const wantsSubdirInPath = subdir !== null && meta.subdirMode === 'path-suffix';

  // A branch belongs in the path when the provider says so, OR when we need one
  // as the anchor for a path-suffixed subdirectory.
  const needsBranchInPath =
    (meta.branchMode === 'path-suffix' && ref.branch !== null) || wantsSubdirInPath;

  if (!needsBranchInPath) return base;

  const branch = ref.branch ?? options?.defaultBranch;
  if (!branch) {
    // No branch known and none supplied: emit the bare repo rather than a
    // `/tree/<subdir>` URL that the provider would misread as a branch.
    return base;
  }

  const suffix = wantsSubdirInPath ? `/tree/${branch}/${subdir}` : `/tree/${branch}`;
  return `${base}${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* Deploy URL                                                                 */
/* -------------------------------------------------------------------------- */

export interface BuildDeployUrlOptions {
  /** The repo's default branch, used when `ref.branch` is null but a branch is
   *  structurally required (subdirectory in a path-suffix provider). */
  defaultBranch?: string;
  /** Suggested project name, when the provider supports pre-filling one.
   *  Only Vercel documents `project-name`; ignored elsewhere. */
  projectName?: string;
}

/**
 * Build the one-click deploy URL for one provider.
 *
 * Every value is passed through `URLSearchParams`, so a repo name containing
 * `&`, `?` or a space cannot break out of its parameter — the encoding is the
 * injection defence, not a sanitiser.
 */
export function buildDeployUrl(
  ref: RepoRef,
  provider: DeployProvider,
  options?: BuildDeployUrlOptions,
): string {
  const meta = DEPLOY_PROVIDER_META[provider];
  const url = new URL(meta.deployBase);
  const params = url.searchParams;

  params.set(meta.repoParam, buildRepoValue(ref, provider, options));

  if (meta.branchMode === 'query' && meta.branchParam && ref.branch) {
    params.set(meta.branchParam, ref.branch);
  }

  if (ref.subdir && meta.subdirMode === 'query' && meta.subdirParam) {
    params.set(meta.subdirParam, trimSlashes(ref.subdir));
  }

  // Vercel is the only one of the three that documents a project-name param.
  if (options?.projectName && provider === 'vercel') {
    params.set('project-name', options.projectName);
  }

  return url.toString();
}

/** Build all three URLs at once, in the canonical provider order. */
export function buildAllDeployUrls(
  ref: RepoRef,
  options?: BuildDeployUrlOptions,
): Record<DeployProvider, string> {
  const out = {} as Record<DeployProvider, string>;
  for (const provider of DEPLOY_PROVIDERS) {
    out[provider] = buildDeployUrl(ref, provider, options);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Markdown / HTML snippets                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A ready-to-paste README badge. The image URLs are the providers' own hosted
 * button assets — hotlinking them is the documented usage in all three docs, so
 * we do not vendor copies.
 */
export function buildButtonMarkdown(
  ref: RepoRef,
  provider: DeployProvider,
  options?: BuildDeployUrlOptions,
): string {
  const meta = DEPLOY_PROVIDER_META[provider];
  const href = buildDeployUrl(ref, provider, options);
  return `[![Deploy to ${meta.label}](${meta.buttonImageUrl})](${href})`;
}

/** Escape the five XML-significant characters for an HTML attribute/text slot. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildButtonHtml(
  ref: RepoRef,
  provider: DeployProvider,
  options?: BuildDeployUrlOptions,
): string {
  const meta = DEPLOY_PROVIDER_META[provider];
  const href = escapeHtml(buildDeployUrl(ref, provider, options));
  const alt = `Deploy to ${meta.label}`;
  return `<a href="${href}"><img src="${escapeHtml(meta.buttonImageUrl)}" alt="${escapeHtml(alt)}" /></a>`;
}
