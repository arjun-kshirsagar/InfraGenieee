/**
 * Test-only `StackDetection` + `RepoRef` fixtures for `<DetectedStackCard>`.
 *
 * These are NOT wired into any runtime path — they exist so the component test
 * (and any future story) can render the card across every meaningful shape:
 * Next.js (high), Vite static (high), Express+Postgres (needs badges), a
 * monorepo (note visible), and `confidence: 'unknown'`.
 *
 * Each fixture is validated against `stackDetectionSchema` in the test, so a
 * fixture that drifts out of contract fails loudly rather than silently lying.
 */

import type { RepoRef, StackDetection } from '@/types/deploy';

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

/* -------------------------------------------------------------------------- */
/* 1. Next.js — high confidence                                               */
/* -------------------------------------------------------------------------- */

export const NEXTJS_REPO: RepoRef = repo('acme', 'storefront');

export const NEXTJS_DETECTION: StackDetection = {
  framework: 'nextjs',
  frameworkVersion: '^15.2.0',
  runtime: 'node',
  appShape: 'ssr',
  packageManager: 'pnpm',
  needs: [],
  build: {
    installCommand: 'pnpm install',
    buildCommand: 'next build',
    outputDir: null,
    startCommand: 'next start',
    nodeVersion: '20.x',
  },
  existing: { vercel: false, netlify: false, render: false, dockerfile: false },
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
    {
      id: 'script:build',
      kind: 'script',
      path: 'package.json',
      excerpt: '"build": "next build",',
      implies: 'A `next build` script confirms a Next.js app.',
      weight: 'weak',
    },
    {
      id: 'file:next.config',
      kind: 'file-present',
      path: 'next.config.mjs',
      excerpt: 'next.config.mjs',
      implies: 'A Next.js config file is present.',
      weight: 'weak',
    },
    {
      id: 'lockfile:pnpm',
      kind: 'file-present',
      path: 'pnpm-lock.yaml',
      excerpt: 'pnpm-lock.yaml',
      implies: 'A pnpm lockfile → package manager is pnpm.',
      weight: 'strong',
    },
  ],
  notes: [],
};

/* -------------------------------------------------------------------------- */
/* 2. Vite static site — high confidence, no needs                            */
/* -------------------------------------------------------------------------- */

export const VITE_REPO: RepoRef = repo('jane', 'portfolio', { branch: 'main' });

export const VITE_DETECTION: StackDetection = {
  framework: 'vite',
  frameworkVersion: '^5.4.0',
  runtime: 'static',
  appShape: 'static',
  packageManager: 'npm',
  needs: [],
  build: {
    installCommand: 'npm install',
    buildCommand: 'vite build',
    outputDir: 'dist',
    startCommand: null,
    nodeVersion: null,
  },
  existing: { vercel: false, netlify: false, render: false, dockerfile: false },
  monorepo: false,
  confidence: 'high',
  signals: [
    {
      id: 'dev:vite',
      kind: 'dependency',
      path: 'package.json',
      excerpt: '"vite": "^5.4.0",',
      implies: '`vite` in devDependencies → a Vite build.',
      weight: 'strong',
    },
    {
      id: 'script:build:vite',
      kind: 'script',
      path: 'package.json',
      excerpt: '"build": "vite build",',
      implies: 'A `vite build` script that emits static files.',
      weight: 'weak',
    },
  ],
  notes: [],
};

/* -------------------------------------------------------------------------- */
/* 3. Express + Postgres — full-stack with service needs                      */
/* -------------------------------------------------------------------------- */

export const EXPRESS_REPO: RepoRef = repo('team', 'api-server');

export const EXPRESS_DETECTION: StackDetection = {
  framework: 'express',
  frameworkVersion: '^4.19.2',
  runtime: 'node',
  appShape: 'fullstack',
  packageManager: 'npm',
  needs: ['database', 'cache', 'background-worker'],
  build: {
    installCommand: 'npm install',
    buildCommand: 'npm run build',
    outputDir: null,
    startCommand: 'node dist/server.js',
    nodeVersion: '20.x',
  },
  existing: { vercel: false, netlify: false, render: false, dockerfile: true },
  monorepo: false,
  confidence: 'high',
  signals: [
    {
      id: 'dep:express',
      kind: 'dependency',
      path: 'package.json',
      excerpt: '"express": "^4.19.2",',
      implies: '`express` in dependencies → an Express server.',
      weight: 'strong',
    },
    {
      id: 'dep:pg',
      kind: 'dependency',
      path: 'package.json',
      excerpt: '"pg": "^8.11.0",',
      implies: 'The `pg` driver → the app talks to PostgreSQL.',
      weight: 'strong',
    },
    {
      id: 'dep:ioredis',
      kind: 'dependency',
      path: 'package.json',
      excerpt: '"ioredis": "^5.3.2",',
      implies: '`ioredis` → the app uses a Redis cache.',
      weight: 'weak',
    },
    {
      id: 'content:bullmq',
      kind: 'file-content',
      path: 'src/queue.ts',
      excerpt: "import { Worker } from 'bullmq';",
      implies: 'A BullMQ worker → a background-worker process is needed.',
      weight: 'weak',
    },
    {
      id: 'file:dockerfile',
      kind: 'file-present',
      path: 'Dockerfile',
      excerpt: 'Dockerfile',
      implies: 'A Dockerfile is committed — the repo ships its own runtime.',
      weight: 'weak',
    },
  ],
  notes: ['A Dockerfile is present — some providers will build from it directly.'],
};

/* -------------------------------------------------------------------------- */
/* 4. Monorepo — note must be visible                                         */
/* -------------------------------------------------------------------------- */

export const MONOREPO_REPO: RepoRef = repo('bigco', 'platform', {
  branch: 'main',
  subdir: 'apps/web',
});

export const MONOREPO_DETECTION: StackDetection = {
  framework: 'nextjs',
  frameworkVersion: '^14.2.0',
  runtime: 'node',
  appShape: 'ssr',
  packageManager: 'pnpm',
  needs: [],
  build: {
    installCommand: 'pnpm install',
    buildCommand: 'pnpm --filter web build',
    outputDir: null,
    startCommand: 'pnpm --filter web start',
    nodeVersion: '20.x',
  },
  existing: { vercel: false, netlify: false, render: false, dockerfile: false },
  monorepo: true,
  confidence: 'medium',
  signals: [
    {
      id: 'file:pnpm-workspace',
      kind: 'file-present',
      path: 'pnpm-workspace.yaml',
      excerpt: 'pnpm-workspace.yaml',
      implies: 'A pnpm workspace file → this is a monorepo.',
      weight: 'weak',
    },
    {
      id: 'dep:next:mono',
      kind: 'dependency',
      path: 'apps/web/package.json',
      excerpt: '"next": "^14.2.0",',
      implies: '`next` in the web app package → a Next.js app in this subdir.',
      weight: 'strong',
    },
  ],
  notes: [
    'This looks like a monorepo — pick the app directory you want to deploy (we analysed apps/web).',
    'We read only the app subdirectory, so a root-level config may not be reflected.',
  ],
};

/* -------------------------------------------------------------------------- */
/* 5. Unknown confidence — a designed state, not an error                     */
/* -------------------------------------------------------------------------- */

export const UNKNOWN_REPO: RepoRef = repo('someone', 'private-thing', {
  host: 'gitlab',
  canonicalUrl: 'https://gitlab.com/someone/private-thing',
});

export const UNKNOWN_DETECTION: StackDetection = {
  framework: 'unknown',
  frameworkVersion: null,
  runtime: 'unknown',
  appShape: 'unknown',
  packageManager: 'unknown',
  needs: [],
  build: {
    installCommand: null,
    buildCommand: null,
    outputDir: null,
    startCommand: null,
    nodeVersion: null,
  },
  existing: { vercel: false, netlify: false, render: false, dockerfile: false },
  monorepo: false,
  confidence: 'unknown',
  signals: [],
  notes: [
    'We can only read GitHub repositories right now — this one is on GitLab.',
    'The repository may also be private; we only read public repos.',
  ],
};

/** All fixtures, for schema-validation sweeps. */
export const ALL_DETECTION_FIXTURES: ReadonlyArray<{
  name: string;
  repo: RepoRef;
  detection: StackDetection;
}> = [
  { name: 'nextjs', repo: NEXTJS_REPO, detection: NEXTJS_DETECTION },
  { name: 'vite', repo: VITE_REPO, detection: VITE_DETECTION },
  { name: 'express', repo: EXPRESS_REPO, detection: EXPRESS_DETECTION },
  { name: 'monorepo', repo: MONOREPO_REPO, detection: MONOREPO_DETECTION },
  { name: 'unknown', repo: UNKNOWN_REPO, detection: UNKNOWN_DETECTION },
];
