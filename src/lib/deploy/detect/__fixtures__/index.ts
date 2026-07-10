/**
 * Fixture-driven test corpus for `detectStack` (task B3).
 *
 * Each fixture is a REAL, self-consistent `RepoSnapshot`: the file contents in
 * `files` are genuine enough that every excerpt the detector cites is a real
 * substring of the corresponding file. `index.test.ts` proves that
 * programmatically (the anti-fabrication gate), so a fixture whose package.json
 * claims `next` must actually contain `"next"` in its body.
 *
 * `expect` records the assertions each fixture must satisfy. `null` on a field
 * means "don't assert this one" (e.g. we don't pin every note).
 */

import type { RepoSnapshot } from '@/types/deploy';
import type { AppShape, Framework, PackageManager, Runtime, ServiceNeed } from '@/types/deploy';

const FETCHED_AT = '2026-07-28T12:00:00.000Z';

export interface DetectExpectation {
  framework: Framework;
  runtime: Runtime;
  appShape: AppShape;
  packageManager?: PackageManager;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  monorepo?: boolean;
  needsIncludes?: ServiceNeed[];
  /** A substring that must appear in at least one note. */
  noteIncludes?: string;
}

export interface DetectFixture {
  name: string;
  snapshot: RepoSnapshot;
  expect: DetectExpectation;
}

/** Build a snapshot from a flat file map + optional extra dir entries. */
function snap(opts: {
  host?: 'github' | 'gitlab' | 'bitbucket';
  files: Record<string, string>;
  /** Extra paths present in the tree but NOT content-probed (lockfiles, dirs). */
  extraEntries?: Array<{ path: string; type: 'file' | 'dir' }>;
  entriesTruncated?: boolean;
  subdir?: string | null;
}): RepoSnapshot {
  const host = opts.host ?? 'github';
  const fileEntries = Object.keys(opts.files).map((path) => ({ path, type: 'file' as const }));
  const entries = [...fileEntries, ...(opts.extraEntries ?? [])];
  return {
    ref: {
      host,
      owner: 'acme',
      repo: 'app',
      branch: null,
      subdir: opts.subdir ?? null,
      canonicalUrl: `https://${host === 'github' ? 'github.com' : host === 'gitlab' ? 'gitlab.com' : 'bitbucket.org'}/acme/app`,
    },
    defaultBranch: 'main',
    resolvedBranch: 'main',
    meta: {},
    entries,
    files: opts.files,
    entriesTruncated: opts.entriesTruncated ?? false,
    fetchedAt: FETCHED_AT,
  };
}

/* -------------------------------------------------------------------------- */
/* The fixtures (≥15 shapes)                                                  */
/* -------------------------------------------------------------------------- */

export const FIXTURES: DetectFixture[] = [
  // 1 — Next.js app router
  {
    name: 'nextjs-app-router',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          {
            name: 'next-app',
            scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
            dependencies: { next: '^15.2.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
          },
          null,
          2,
        ),
        'next.config.mjs': 'export default {};\n',
      },
      extraEntries: [
        { path: 'package-lock.json', type: 'file' },
        { path: 'app', type: 'dir' },
      ],
    }),
    expect: {
      framework: 'nextjs',
      runtime: 'node',
      appShape: 'ssr',
      packageManager: 'npm',
      confidence: 'high',
    },
  },

  // 2 — Nuxt
  {
    name: 'nuxt',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          { name: 'nuxt-app', scripts: { build: 'nuxt build' }, dependencies: { nuxt: '^3.11.0' } },
          null,
          2,
        ),
        'nuxt.config.ts': 'export default defineNuxtConfig({});\n',
      },
      extraEntries: [{ path: 'pnpm-lock.yaml', type: 'file' }],
    }),
    expect: { framework: 'nuxt', runtime: 'node', appShape: 'ssr', packageManager: 'pnpm', confidence: 'high' },
  },

  // 3 — SvelteKit
  {
    name: 'sveltekit',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          {
            name: 'sk-app',
            scripts: { build: 'vite build' },
            devDependencies: { '@sveltejs/kit': '^2.5.0', vite: '^5.0.0' },
          },
          null,
          2,
        ),
        'svelte.config.js': 'export default {};\n',
      },
      extraEntries: [{ path: 'yarn.lock', type: 'file' }],
    }),
    expect: { framework: 'sveltekit', runtime: 'node', appShape: 'ssr', packageManager: 'yarn', confidence: 'high' },
  },

  // 4 — Astro static (no adapter)
  {
    name: 'astro-static',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          { name: 'astro-site', scripts: { build: 'astro build' }, dependencies: { astro: '^4.5.0' } },
          null,
          2,
        ),
        'astro.config.mjs': 'import { defineConfig } from "astro/config";\nexport default defineConfig({});\n',
      },
    }),
    expect: { framework: 'astro', runtime: 'node', appShape: 'static', confidence: 'high' },
  },

  // 5 — Astro + node adapter (SSR)
  {
    name: 'astro-node-adapter',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          {
            name: 'astro-ssr',
            scripts: { build: 'astro build' },
            dependencies: { astro: '^4.5.0', '@astrojs/node': '^8.2.0' },
          },
          null,
          2,
        ),
        'astro.config.mjs':
          'import node from "@astrojs/node";\nexport default { output: "server", adapter: node() };\n',
      },
    }),
    expect: { framework: 'astro', runtime: 'node', appShape: 'ssr', confidence: 'high' },
  },

  // 6 — Vite SPA
  {
    name: 'vite-spa',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          {
            name: 'vite-spa',
            scripts: { build: 'vite build' },
            devDependencies: { vite: '^5.2.0', react: '^18.2.0' },
          },
          null,
          2,
        ),
        'vite.config.ts': 'import { defineConfig } from "vite";\nexport default defineConfig({});\n',
      },
    }),
    // vite.config present → file-present strong signal → high.
    expect: { framework: 'vite', runtime: 'static', appShape: 'static', confidence: 'high' },
  },

  // 7 — create-react-app
  {
    name: 'create-react-app',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          {
            name: 'cra-app',
            scripts: { build: 'react-scripts build', start: 'react-scripts start' },
            dependencies: { 'react-scripts': '5.0.1', react: '^18.2.0' },
          },
          null,
          2,
        ),
      },
    }),
    expect: { framework: 'create-react-app', runtime: 'static', appShape: 'static', confidence: 'high' },
  },

  // 8 — Hugo
  {
    name: 'hugo',
    snapshot: snap({
      files: {
        'hugo.toml': 'baseURL = "https://example.org/"\ntitle = "My Hugo Site"\n',
      },
      extraEntries: [
        { path: 'content', type: 'dir' },
        { path: 'themes', type: 'dir' },
      ],
    }),
    expect: { framework: 'hugo', runtime: 'static', appShape: 'static', confidence: 'high' },
  },

  // 9 — Jekyll
  {
    name: 'jekyll',
    snapshot: snap({
      files: {
        'Gemfile': "source 'https://rubygems.org'\ngem 'jekyll', '~> 4.3'\n",
        '_config.yml': 'title: My Jekyll Blog\n',
      },
    }),
    expect: { framework: 'jekyll', runtime: 'ruby', appShape: 'static', confidence: 'high' },
  },

  // 10 — Express + Prisma + Postgres
  {
    name: 'express-prisma-postgres',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          {
            name: 'api',
            scripts: { start: 'node server.js', build: 'tsc' },
            dependencies: { express: '^4.19.0', '@prisma/client': '^5.11.0', pg: '^8.11.0' },
            devDependencies: { prisma: '^5.11.0' },
          },
          null,
          2,
        ),
      },
      extraEntries: [{ path: 'package-lock.json', type: 'file' }],
    }),
    expect: {
      framework: 'express',
      runtime: 'node',
      appShape: 'fullstack',
      confidence: 'high',
      needsIncludes: ['database'],
    },
  },

  // 11 — Django
  {
    name: 'django',
    snapshot: snap({
      files: {
        'manage.py': '#!/usr/bin/env python\nimport os, sys\n',
        'requirements.txt': 'Django==5.0.3\npsycopg2-binary==2.9.9\ngunicorn==21.2.0\n',
      },
    }),
    expect: {
      framework: 'django',
      runtime: 'python',
      appShape: 'fullstack',
      confidence: 'high',
      needsIncludes: ['database'],
    },
  },

  // 12 — Dockerfile-only
  {
    name: 'dockerfile-only',
    snapshot: snap({
      files: {
        'Dockerfile': 'FROM golang:1.22\nWORKDIR /app\nCOPY . .\nRUN go build -o server\nEXPOSE 8080\nCMD ["./server"]\n',
      },
    }),
    expect: { framework: 'other', runtime: 'docker', appShape: 'fullstack', confidence: 'high' },
  },

  // 13 — bare index.html
  {
    name: 'bare-index-html',
    snapshot: snap({
      files: {
        'index.html': '<!doctype html><html><head><title>Hi</title></head><body>Hello</body></html>\n',
      },
      extraEntries: [{ path: 'style.css', type: 'file' }],
    }),
    expect: { framework: 'static-html', runtime: 'static', appShape: 'static', confidence: 'high' },
  },

  // 14 — pnpm monorepo
  {
    name: 'pnpm-monorepo',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          { name: 'monorepo-root', private: true, workspaces: ['packages/*'] },
          null,
          2,
        ),
        'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      },
      extraEntries: [
        { path: 'pnpm-lock.yaml', type: 'file' },
        { path: 'packages', type: 'dir' },
      ],
    }),
    expect: {
      framework: 'other',
      runtime: 'node',
      appShape: 'unknown',
      packageManager: 'pnpm',
      confidence: 'low',
      monorepo: true,
      noteIncludes: 'monorepo',
    },
  },

  // 15 — non-GitHub ref (GitLab) → unknown
  {
    name: 'gitlab-ref-unknown',
    snapshot: snap({
      host: 'gitlab',
      files: {},
    }),
    expect: { framework: 'unknown', runtime: 'unknown', appShape: 'unknown', confidence: 'unknown', noteIncludes: 'GitHub only' },
  },

  // 16 — Remix (bonus, exercises the remix branch)
  {
    name: 'remix',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          {
            name: 'remix-app',
            scripts: { build: 'remix build', start: 'remix-serve build' },
            dependencies: { '@remix-run/node': '^2.8.0', '@remix-run/react': '^2.8.0' },
          },
          null,
          2,
        ),
      },
      extraEntries: [{ path: 'package-lock.json', type: 'file' }],
    }),
    expect: { framework: 'remix', runtime: 'node', appShape: 'ssr', confidence: 'high' },
  },

  // 17 — FastAPI (bonus, api-only python)
  {
    name: 'fastapi',
    snapshot: snap({
      files: {
        'requirements.txt': 'fastapi==0.110.0\nuvicorn==0.29.0\n',
      },
      extraEntries: [{ path: 'main.py', type: 'file' }],
    }),
    expect: { framework: 'fastapi', runtime: 'python', appShape: 'api-only', confidence: 'high' },
  },

  // 18 — existing render.yaml (surfaces the existing-config note)
  {
    name: 'nextjs-with-existing-vercel',
    snapshot: snap({
      files: {
        'package.json': JSON.stringify(
          { name: 'n', scripts: { build: 'next build' }, dependencies: { next: '^14.2.0' } },
          null,
          2,
        ),
        'vercel.json': '{ "framework": "nextjs" }\n',
      },
      extraEntries: [{ path: 'package-lock.json', type: 'file' }],
    }),
    expect: {
      framework: 'nextjs',
      runtime: 'node',
      appShape: 'ssr',
      confidence: 'high',
      noteIncludes: 'vercel',
    },
  },
];
