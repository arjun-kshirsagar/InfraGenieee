/**
 * Tests for the Feature 3 deploy-URL builder and the Feature 3 contract's
 * integrity rules.
 *
 * These lock two things:
 *   1. the exact URL shapes the three providers document (a silent change here
 *      ships a button that 404s at the vendor);
 *   2. the schema refinements that stop a fabricated plan from parsing.
 */

import { describe, it, expect } from 'vitest';

import {
  buildAllDeployUrls,
  buildButtonHtml,
  buildButtonMarkdown,
  buildDeployUrl,
  buildRepoValue,
} from './deploy-url';
import {
  DEPLOY_PROVIDERS,
  deployPlanSchema,
  repoRefSchema,
  stackDetectionSchema,
  type DeployPlan,
  type ProviderFit,
  type RepoRef,
  type StackDetection,
} from '@/types/deploy';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const plain: RepoRef = {
  host: 'github',
  owner: 'acme',
  repo: 'storefront',
  branch: null,
  subdir: null,
  canonicalUrl: 'https://github.com/acme/storefront',
};

const branched: RepoRef = { ...plain, branch: 'release-2' };

const monorepo: RepoRef = { ...plain, branch: 'main', subdir: 'apps/web' };

/* -------------------------------------------------------------------------- */
/* RepoRef schema                                                             */
/* -------------------------------------------------------------------------- */

describe('repoRefSchema', () => {
  it('accepts the canonical shapes', () => {
    for (const ref of [plain, branched, monorepo]) {
      expect(repoRefSchema.safeParse(ref).success).toBe(true);
    }
  });

  it('rejects an owner with a path separator (paste artifact / traversal)', () => {
    expect(repoRefSchema.safeParse({ ...plain, owner: 'acme/evil' }).success).toBe(false);
    expect(repoRefSchema.safeParse({ ...plain, repo: '..' }).success).toBe(true); // `..` is dot-only, allowed by git
    expect(repoRefSchema.safeParse({ ...plain, repo: 'a b' }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* buildRepoValue                                                             */
/* -------------------------------------------------------------------------- */

describe('buildRepoValue', () => {
  it('is the bare canonical URL when there is no branch or subdir', () => {
    for (const provider of DEPLOY_PROVIDERS) {
      expect(buildRepoValue(plain, provider)).toBe('https://github.com/acme/storefront');
    }
  });

  it('path-suffixes the branch for Vercel and Render, but not Netlify', () => {
    expect(buildRepoValue(branched, 'vercel')).toBe(
      'https://github.com/acme/storefront/tree/release-2',
    );
    expect(buildRepoValue(branched, 'render')).toBe(
      'https://github.com/acme/storefront/tree/release-2',
    );
    // Netlify carries the branch in `?branch=`, so the value stays bare.
    expect(buildRepoValue(branched, 'netlify')).toBe('https://github.com/acme/storefront');
  });

  it('path-suffixes branch + subdir for Vercel', () => {
    expect(buildRepoValue(monorepo, 'vercel')).toBe(
      'https://github.com/acme/storefront/tree/main/apps/web',
    );
  });

  it('falls back to the supplied default branch when a subdir needs an anchor', () => {
    const noBranch: RepoRef = { ...plain, subdir: 'packages/site' };
    expect(buildRepoValue(noBranch, 'vercel', { defaultBranch: 'canary' })).toBe(
      'https://github.com/acme/storefront/tree/canary/packages/site',
    );
  });

  it('never guesses a branch: with no branch and no default, emits the bare repo', () => {
    const noBranch: RepoRef = { ...plain, subdir: 'packages/site' };
    expect(buildRepoValue(noBranch, 'vercel')).toBe('https://github.com/acme/storefront');
  });

  it('tolerates a subdir written with slashes around it', () => {
    const messy: RepoRef = { ...plain, branch: 'main', subdir: '/apps/web/' };
    expect(buildRepoValue(messy, 'vercel')).toBe(
      'https://github.com/acme/storefront/tree/main/apps/web',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* buildDeployUrl — the documented shapes                                     */
/* -------------------------------------------------------------------------- */

describe('buildDeployUrl', () => {
  it('matches each provider documented base + repo parameter', () => {
    const urls = buildAllDeployUrls(plain);

    const vercel = new URL(urls.vercel);
    expect(vercel.origin + vercel.pathname).toBe('https://vercel.com/new/clone');
    expect(vercel.searchParams.get('repository-url')).toBe('https://github.com/acme/storefront');

    const netlify = new URL(urls.netlify);
    expect(netlify.origin + netlify.pathname).toBe('https://app.netlify.com/start/deploy');
    expect(netlify.searchParams.get('repository')).toBe('https://github.com/acme/storefront');

    const render = new URL(urls.render);
    expect(render.origin + render.pathname).toBe('https://render.com/deploy');
    expect(render.searchParams.get('repo')).toBe('https://github.com/acme/storefront');
  });

  it('URL-encodes the repo value (the injection defence)', () => {
    // Raw `:` and `/` inside a query value get percent-encoded by URLSearchParams.
    expect(buildDeployUrl(plain, 'vercel')).toContain(
      'repository-url=https%3A%2F%2Fgithub.com%2Facme%2Fstorefront',
    );
  });

  it('puts the Netlify branch in ?branch= and the subdir in ?base=', () => {
    const url = new URL(buildDeployUrl(monorepo, 'netlify'));
    expect(url.searchParams.get('repository')).toBe('https://github.com/acme/storefront');
    expect(url.searchParams.get('branch')).toBe('main');
    expect(url.searchParams.get('base')).toBe('apps/web');
  });

  it('does not put a subdir in the Render URL (it belongs in render.yaml rootDir)', () => {
    const url = new URL(buildDeployUrl(monorepo, 'render'));
    expect(url.searchParams.get('repo')).toBe('https://github.com/acme/storefront/tree/main');
    expect(url.search).not.toContain('apps%2Fweb');
    expect(url.search).not.toContain('base=');
  });

  it('only Vercel gets project-name', () => {
    expect(new URL(buildDeployUrl(plain, 'vercel', { projectName: 'shop' })).searchParams.get('project-name')).toBe('shop');
    expect(new URL(buildDeployUrl(plain, 'netlify', { projectName: 'shop' })).search).not.toContain(
      'project-name',
    );
    expect(new URL(buildDeployUrl(plain, 'render', { projectName: 'shop' })).search).not.toContain(
      'project-name',
    );
  });

  it('cannot be broken out of by a hostile repo name', () => {
    // `repoRefSchema` rejects this shape, but the builder must be safe anyway.
    const hostile: RepoRef = {
      ...plain,
      repo: 'x&admin=1',
      canonicalUrl: 'https://github.com/acme/x&admin=1',
    };
    const url = new URL(buildDeployUrl(hostile, 'netlify'));
    expect(url.searchParams.get('admin')).toBeNull();
    expect(url.searchParams.get('repository')).toBe('https://github.com/acme/x&admin=1');
  });

  it('produces URLs that all three providers can parse (valid absolute URLs)', () => {
    for (const provider of DEPLOY_PROVIDERS) {
      const raw = buildDeployUrl(monorepo, provider);
      expect(() => new URL(raw)).not.toThrow();
      expect(raw.startsWith('https://')).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Snippets                                                                   */
/* -------------------------------------------------------------------------- */

describe('button snippets', () => {
  it('emits markdown with the provider own button image', () => {
    expect(buildButtonMarkdown(plain, 'render')).toBe(
      '[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Facme%2Fstorefront)',
    );
  });

  it('escapes the HTML snippet so `&` between params is valid markup', () => {
    const html = buildButtonHtml(monorepo, 'netlify');
    expect(html).toContain('&amp;branch=main');
    expect(html).not.toMatch(/[^&]&(?!amp;|#39;|quot;|lt;|gt;)/);
  });
});

/* -------------------------------------------------------------------------- */
/* Detection integrity rules                                                  */
/* -------------------------------------------------------------------------- */

const baseDetection: StackDetection = {
  framework: 'nextjs',
  frameworkVersion: '^15.2.0',
  runtime: 'node',
  appShape: 'ssr',
  packageManager: 'pnpm',
  needs: ['database'],
  build: {
    installCommand: 'pnpm install',
    buildCommand: 'pnpm build',
    outputDir: null,
    startCommand: 'pnpm start',
    nodeVersion: '20',
  },
  existing: { vercel: false, netlify: false, render: false, dockerfile: false },
  monorepo: false,
  signals: [
    {
      id: 'dep:next',
      kind: 'dependency',
      path: 'package.json',
      excerpt: '"next": "^15.2.0"',
      implies: 'Next.js application',
      weight: 'strong',
    },
  ],
  confidence: 'high',
  notes: [],
};

describe('stackDetectionSchema integrity', () => {
  it('accepts a fully cited detection', () => {
    expect(stackDetectionSchema.safeParse(baseDetection).success).toBe(true);
  });

  it('rejects a named framework with no cited signal (anti-fabrication)', () => {
    const result = stackDetectionSchema.safeParse({ ...baseDetection, signals: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a signal with an empty path or excerpt', () => {
    for (const bad of [{ path: '' }, { excerpt: '' }]) {
      const result = stackDetectionSchema.safeParse({
        ...baseDetection,
        signals: [{ ...baseDetection.signals[0], ...bad }],
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects confidence "high" without a strong signal', () => {
    const result = stackDetectionSchema.safeParse({
      ...baseDetection,
      signals: [{ ...baseDetection.signals[0], weight: 'weak' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects confidence "unknown" that still names a framework or needs', () => {
    expect(
      stackDetectionSchema.safeParse({ ...baseDetection, confidence: 'unknown' }).success,
    ).toBe(false);
    expect(
      stackDetectionSchema.safeParse({
        ...baseDetection,
        framework: 'unknown',
        confidence: 'unknown',
        signals: [],
        needs: ['database'],
      }).success,
    ).toBe(false);
  });

  it('accepts an honest unknown', () => {
    const unknown: StackDetection = {
      ...baseDetection,
      framework: 'unknown',
      frameworkVersion: null,
      runtime: 'unknown',
      appShape: 'unknown',
      packageManager: 'unknown',
      needs: [],
      signals: [],
      confidence: 'unknown',
      notes: ["We can't read repository contents on GitLab yet."],
    };
    expect(stackDetectionSchema.safeParse(unknown).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Plan integrity rules                                                       */
/* -------------------------------------------------------------------------- */

function fit(provider: ProviderFit['provider'], overrides?: Partial<ProviderFit>): ProviderFit {
  return {
    provider,
    verdict: 'possible',
    score: 50,
    reasons: ['Runs Node apps.'],
    caveats: [],
    deployUrl: buildDeployUrl(plain, provider),
    requiresConfig: false,
    ...overrides,
  };
}

const basePlan: DeployPlan = {
  repo: plain,
  detection: baseDetection,
  fits: [
    fit('vercel', { verdict: 'recommended', score: 90 }),
    fit('netlify'),
    fit('render', { verdict: 'possible', score: 70 }),
  ],
  primary: 'vercel',
  assumptions: ['No database URL found, so we assumed an external managed Postgres.'],
  configs: [],
  usedPrdContext: false,
  generatedAt: '2026-07-28T12:00:00.000Z',
};

describe('deployPlanSchema integrity', () => {
  it('accepts a well-formed plan', () => {
    const result = deployPlanSchema.safeParse(basePlan);
    expect(result.success).toBe(true);
  });

  it('requires a fit for every provider — hiding one hides the reasoning', () => {
    const result = deployPlanSchema.safeParse({
      ...basePlan,
      fits: [fit('vercel'), fit('netlify')],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate providers', () => {
    const result = deployPlanSchema.safeParse({
      ...basePlan,
      fits: [fit('vercel'), fit('vercel'), fit('netlify')],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a primary that is marked not-recommended', () => {
    const result = deployPlanSchema.safeParse({
      ...basePlan,
      fits: [
        fit('vercel', { verdict: 'not-recommended', score: 10 }),
        fit('netlify'),
        fit('render'),
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a confident winner when detection confidence is unknown', () => {
    const result = deployPlanSchema.safeParse({
      ...basePlan,
      detection: {
        ...baseDetection,
        framework: 'unknown',
        needs: [],
        signals: [],
        confidence: 'unknown',
      },
      primary: 'vercel',
    });
    expect(result.success).toBe(false);
  });

  it('accepts primary: null with all three offered when detection is unknown', () => {
    const result = deployPlanSchema.safeParse({
      ...basePlan,
      detection: {
        ...baseDetection,
        framework: 'unknown',
        needs: [],
        signals: [],
        confidence: 'unknown',
      },
      primary: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config artifact for a provider not in the plan', () => {
    const result = deployPlanSchema.safeParse({
      ...basePlan,
      configs: [
        {
          provider: 'fly',
          filename: 'fly.toml',
          language: 'toml',
          content: 'app = "x"',
          why: 'nope',
          required: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
