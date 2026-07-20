/**
 * Test-only `DeployPlan` fixtures for the F3-F3 result components
 * (`<ProviderFitList>`, `<ConfigSnippet>`, `<DeployResult>`).
 *
 * They cover the shapes the acceptance criteria name:
 *   1. Next.js  — Vercel primary, no config needed
 *   2. Django + Postgres — Render primary, `requiresConfig`, `render.yaml` snippet
 *   3. Hugo static — two `recommended` (Vercel + Netlify)
 *   4. Dockerfile-only — two `not-recommended` with reasons, Render primary
 *   5. `primary: null` — uncertain detection, all three `possible`
 *
 * `deployUrl` is produced by the real `buildDeployUrl`, so the fixtures carry the
 * exact URLs the app would emit and the "href === fit.deployUrl" test is honest.
 * Each plan is validated against `deployPlanSchema` in the test — a fixture that
 * drifts out of contract fails loudly.
 */

import type {
  ConfigArtifact,
  DeployPlan,
  DeployProvider,
  ProviderFit,
  RepoRef,
  StackDetection,
} from '@/types/deploy';
import { buildDeployUrl } from '@/lib/deploy/deploy-url';

const NOW = '2026-07-28T12:00:00.000Z';

function repo(owner: string, name: string, extra?: Partial<RepoRef>): RepoRef {
  return {
    host: 'github',
    owner,
    repo: name,
    branch: null,
    subdir: null,
    canonicalUrl: `https://github.com/${owner}/${name}`,
    ...extra,
  };
}

function fit(
  ref: RepoRef,
  provider: DeployProvider,
  partial: Omit<ProviderFit, 'provider' | 'deployUrl'>,
): ProviderFit {
  return {
    provider,
    deployUrl: buildDeployUrl(ref, provider),
    ...partial,
  };
}

const emptyExisting = { vercel: false, netlify: false, render: false, dockerfile: false };
const emptyBuild = {
  installCommand: null,
  buildCommand: null,
  outputDir: null,
  startCommand: null,
  nodeVersion: null,
};

/* -------------------------------------------------------------------------- */
/* 1. Next.js — Vercel primary                                                */
/* -------------------------------------------------------------------------- */

export const NEXTJS_REPO = repo('acme', 'storefront');

const NEXTJS_DETECTION: StackDetection = {
  framework: 'nextjs',
  frameworkVersion: '^15.2.0',
  runtime: 'node',
  appShape: 'ssr',
  packageManager: 'pnpm',
  needs: [],
  build: { ...emptyBuild, buildCommand: 'next build' },
  existing: emptyExisting,
  monorepo: false,
  confidence: 'high',
  signals: [
    {
      id: 'dep:next',
      kind: 'dependency',
      path: 'package.json',
      excerpt: '"next": "^15.2.0",',
      implies: '`next` in dependencies → Next.js.',
      weight: 'strong',
    },
  ],
  notes: [],
};

export const NEXTJS_PLAN: DeployPlan = {
  repo: NEXTJS_REPO,
  detection: NEXTJS_DETECTION,
  primary: 'vercel',
  usedPrdContext: false,
  assumptions: ['No environment variables were detected, so none were pre-filled.'],
  configs: [],
  generatedAt: NOW,
  fits: [
    fit(NEXTJS_REPO, 'vercel', {
      verdict: 'recommended',
      score: 95,
      reasons: [
        'Next.js is a first-party Vercel framework — zero-config SSR and edge routing.',
        'No managed services detected, so the serverless model fits cleanly.',
      ],
      caveats: [],
      requiresConfig: false,
    }),
    fit(NEXTJS_REPO, 'netlify', {
      verdict: 'possible',
      score: 60,
      reasons: ['Netlify runs Next.js via its adapter.'],
      caveats: ['Some Next.js features need the Netlify Next runtime plugin.'],
      requiresConfig: false,
    }),
    fit(NEXTJS_REPO, 'render', {
      verdict: 'possible',
      score: 40,
      reasons: ['Render can run Next.js as a Node web service.'],
      caveats: ['You pay for an always-on instance rather than per-request.'],
      requiresConfig: false,
    }),
  ],
};

/* -------------------------------------------------------------------------- */
/* 2. Django + Postgres — Render primary, requiresConfig + render.yaml        */
/* -------------------------------------------------------------------------- */

export const DJANGO_REPO = repo('team', 'saas-backend');

const DJANGO_DETECTION: StackDetection = {
  framework: 'django',
  frameworkVersion: '5.0',
  runtime: 'python',
  appShape: 'fullstack',
  packageManager: 'none',
  needs: ['database'],
  build: {
    ...emptyBuild,
    installCommand: 'pip install -r requirements.txt',
    startCommand: 'gunicorn app.wsgi',
  },
  existing: emptyExisting,
  monorepo: false,
  confidence: 'high',
  signals: [
    {
      id: 'dep:django',
      kind: 'dependency',
      path: 'requirements.txt',
      excerpt: 'Django==5.0',
      implies: '`Django` pinned in requirements → a Django app.',
      weight: 'strong',
    },
    {
      id: 'dep:psycopg',
      kind: 'dependency',
      path: 'requirements.txt',
      excerpt: 'psycopg2-binary==2.9.9',
      implies: 'The Postgres driver → the app needs a database.',
      weight: 'strong',
    },
  ],
  notes: [],
};

export const RENDER_YAML: ConfigArtifact = {
  provider: 'render',
  filename: 'render.yaml',
  language: 'yaml',
  required: true,
  why: 'Render deploys this repo from a blueprint. Without render.yaml the deploy button has nothing to build.',
  content: `services:
  - type: web
    name: saas-backend
    runtime: python
    plan: starter
    autoDeploy: false
    buildCommand: pip install -r requirements.txt
    startCommand: gunicorn app.wsgi
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: saas-backend-db
          property: connectionString
      - key: SECRET_KEY
        sync: false

databases:
  - name: saas-backend-db
    plan: free
`,
};

export const DJANGO_PLAN: DeployPlan = {
  repo: DJANGO_REPO,
  detection: DJANGO_DETECTION,
  primary: 'render',
  usedPrdContext: true,
  assumptions: [
    'Assumed a single web service plus one Postgres database from the detected `psycopg2` driver.',
    'Set `autoDeploy: false` per Render’s recommendation for button-deployed blueprints.',
  ],
  configs: [RENDER_YAML],
  generatedAt: NOW,
  fits: [
    fit(DJANGO_REPO, 'render', {
      verdict: 'recommended',
      score: 92,
      reasons: [
        'Render runs long-lived Python servers and offers managed Postgres — a natural fit for Django.',
        'The database need is covered by a managed database in the generated blueprint.',
      ],
      caveats: ['The blueprint uses free-tier plans; bump them before real traffic.'],
      requiresConfig: true,
    }),
    fit(DJANGO_REPO, 'vercel', {
      verdict: 'not-recommended',
      score: 15,
      reasons: ['Vercel can host Python serverless functions.'],
      caveats: [
        'A long-lived Django server and a managed database do not fit Vercel’s serverless model — you would need an external database add-on.',
      ],
      requiresConfig: false,
    }),
    fit(DJANGO_REPO, 'netlify', {
      verdict: 'not-recommended',
      score: 10,
      reasons: ['Netlify Functions can run some Python.'],
      caveats: ['No managed database and no long-lived server — wrong shape for this app.'],
      requiresConfig: false,
    }),
  ],
};

/* -------------------------------------------------------------------------- */
/* 3. Hugo static — two recommended (Vercel + Netlify)                        */
/* -------------------------------------------------------------------------- */

export const HUGO_REPO = repo('jane', 'blog', { branch: 'main' });

const HUGO_DETECTION: StackDetection = {
  framework: 'hugo',
  frameworkVersion: null,
  runtime: 'static',
  appShape: 'static',
  packageManager: 'none',
  needs: [],
  build: { ...emptyBuild, buildCommand: 'hugo', outputDir: 'public' },
  existing: emptyExisting,
  monorepo: false,
  confidence: 'high',
  signals: [
    {
      id: 'file:hugo-config',
      kind: 'file-present',
      path: 'hugo.toml',
      excerpt: 'hugo.toml',
      implies: 'A Hugo config file → a Hugo static site.',
      weight: 'strong',
    },
  ],
  notes: [],
};

export const HUGO_PLAN: DeployPlan = {
  repo: HUGO_REPO,
  detection: HUGO_DETECTION,
  primary: 'vercel',
  usedPrdContext: false,
  assumptions: [],
  configs: [],
  generatedAt: NOW,
  fits: [
    fit(HUGO_REPO, 'vercel', {
      verdict: 'recommended',
      score: 88,
      reasons: ['Static output deploys to Vercel’s global CDN with no server cost.'],
      caveats: [],
      requiresConfig: false,
    }),
    fit(HUGO_REPO, 'netlify', {
      verdict: 'recommended',
      score: 87,
      reasons: ['Netlify has first-class Hugo support and a generous free tier for static sites.'],
      caveats: [],
      requiresConfig: false,
    }),
    fit(HUGO_REPO, 'render', {
      verdict: 'possible',
      score: 55,
      reasons: ['Render can serve a static site.'],
      caveats: ['Vercel and Netlify are more purpose-built for static hosting.'],
      requiresConfig: false,
    }),
  ],
};

/* -------------------------------------------------------------------------- */
/* 4. Dockerfile-only — two not-recommended with reasons                      */
/* -------------------------------------------------------------------------- */

export const DOCKER_REPO = repo('ops', 'grpc-gateway');

const DOCKER_DETECTION: StackDetection = {
  framework: 'other',
  frameworkVersion: null,
  runtime: 'docker',
  appShape: 'api-only',
  packageManager: 'none',
  needs: [],
  build: { ...emptyBuild },
  existing: { ...emptyExisting, dockerfile: true },
  monorepo: false,
  confidence: 'medium',
  signals: [
    {
      id: 'file:dockerfile',
      kind: 'file-present',
      path: 'Dockerfile',
      excerpt: 'Dockerfile',
      implies: 'A Dockerfile → the repo ships its own runtime.',
      weight: 'strong',
    },
  ],
  notes: ['We saw a Dockerfile but could not identify a specific framework.'],
};

export const DOCKER_PLAN: DeployPlan = {
  repo: DOCKER_REPO,
  detection: DOCKER_DETECTION,
  primary: 'render',
  usedPrdContext: false,
  assumptions: ['Assumed the Dockerfile exposes the service port Render expects.'],
  configs: [],
  generatedAt: NOW,
  fits: [
    fit(DOCKER_REPO, 'render', {
      verdict: 'recommended',
      score: 80,
      reasons: ['Render builds and runs Docker images directly — the natural home for a Dockerfile-only service.'],
      caveats: [],
      requiresConfig: false,
    }),
    fit(DOCKER_REPO, 'vercel', {
      verdict: 'not-recommended',
      score: 8,
      reasons: ['Vercel is optimised for frontend and serverless functions.'],
      caveats: ['Vercel does not run arbitrary Docker containers — this service would not deploy.'],
      requiresConfig: false,
    }),
    fit(DOCKER_REPO, 'netlify', {
      verdict: 'not-recommended',
      score: 6,
      reasons: ['Netlify targets static sites and edge functions.'],
      caveats: ['Netlify cannot run a long-lived Docker container — wrong platform for this app.'],
      requiresConfig: false,
    }),
  ],
};

/* -------------------------------------------------------------------------- */
/* 5. Unknown — primary: null, all three possible                             */
/* -------------------------------------------------------------------------- */

export const UNKNOWN_REPO = repo('someone', 'private-thing', {
  host: 'gitlab',
  canonicalUrl: 'https://gitlab.com/someone/private-thing',
});

const UNKNOWN_DETECTION: StackDetection = {
  framework: 'unknown',
  frameworkVersion: null,
  runtime: 'unknown',
  appShape: 'unknown',
  packageManager: 'unknown',
  needs: [],
  build: { ...emptyBuild },
  existing: emptyExisting,
  monorepo: false,
  confidence: 'unknown',
  signals: [],
  notes: [
    'We can only read GitHub repositories right now — this one is on GitLab.',
    'The repository may also be private; we only read public repos.',
  ],
};

export const UNKNOWN_PLAN: DeployPlan = {
  repo: UNKNOWN_REPO,
  detection: UNKNOWN_DETECTION,
  primary: null,
  usedPrdContext: false,
  assumptions: [],
  configs: [],
  generatedAt: NOW,
  fits: [
    fit(UNKNOWN_REPO, 'vercel', {
      verdict: 'possible',
      score: 33,
      reasons: ['If your app is a static site or SSR frontend, Vercel is a strong choice.'],
      caveats: ['We could not read your stack — confirm this matches your app.'],
      requiresConfig: false,
    }),
    fit(UNKNOWN_REPO, 'netlify', {
      verdict: 'possible',
      score: 33,
      reasons: ['Good for static sites and JAMstack apps.'],
      caveats: ['We could not read your stack — confirm this matches your app.'],
      requiresConfig: false,
    }),
    fit(UNKNOWN_REPO, 'render', {
      verdict: 'possible',
      score: 33,
      reasons: ['Best if your app is a long-lived server or needs a managed database.'],
      caveats: ['We could not read your stack — confirm this matches your app.'],
      requiresConfig: false,
    }),
  ],
};

/** All plan fixtures, for schema-validation sweeps and render smoke tests. */
export const ALL_DEPLOY_PLANS: ReadonlyArray<{ name: string; plan: DeployPlan }> = [
  { name: 'nextjs', plan: NEXTJS_PLAN },
  { name: 'django', plan: DJANGO_PLAN },
  { name: 'hugo', plan: HUGO_PLAN },
  { name: 'docker', plan: DOCKER_PLAN },
  { name: 'unknown', plan: UNKNOWN_PLAN },
];
