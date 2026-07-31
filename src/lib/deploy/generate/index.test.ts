/**
 * Tests for the PURE config generators (task B6, docs §7).
 *
 * The contract the reviewer cares about most: **every generated artifact must
 * actually parse.** So these tests do not eyeball strings — they run each
 * artifact through a real parser (`yaml` for render.yaml, `JSON.parse` for
 * vercel.json, `smol-toml` for netlify.toml) and assert success, then assert on
 * the PARSED structure. A snippet that doesn't parse is worse than no snippet.
 *
 * Coverage per the acceptance criteria:
 *   - render.yaml for Express+Postgres (has `databases:`), Django, Dockerfile-
 *     only (`runtime: docker`), a static site, and a monorepo (`rootDir` set);
 *   - `autoDeploy: false` present in EVERY generated blueprint;
 *   - no `databases:` when no database need;
 *   - no literal env values anywhere — every env var is `sync:false` or a
 *     `fromDatabase`/`fromService` reference, never `key: <value>`;
 *   - `generateRenderYaml` returns null when the repo already has a render.yaml;
 *   - vercel.json / netlify.toml return null for a vanilla Next.js/Vite repo and
 *     non-null for a monorepo;
 *   - every artifact parses against `configArtifactSchema`;
 *   - determinism (same input twice → identical output).
 */

import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import {
  generateConfigs,
  generateRenderYaml,
  generateVercelJson,
  generateNetlifyToml,
} from '@/lib/deploy/generate';
import { renderBlueprintHasPlaceholders } from '@/lib/deploy/generate/render-yaml';
import {
  configArtifactSchema,
  type AppShape,
  type BuildHints,
  type ConfigArtifact,
  type DetectionSignal,
  type Framework,
  type Runtime,
  type ServiceNeed,
  type StackDetection,
  type RepoRef,
} from '@/types/deploy';

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

function ref(overrides: Partial<RepoRef> = {}): RepoRef {
  return {
    host: 'github',
    owner: 'acme',
    repo: 'app',
    branch: null,
    subdir: null,
    canonicalUrl: 'https://github.com/acme/app',
    ...overrides,
  };
}

const NO_BUILD: BuildHints = {
  installCommand: null,
  buildCommand: null,
  outputDir: null,
  startCommand: null,
  nodeVersion: null,
};

function strongSignal(id = 'dep:framework'): DetectionSignal {
  return {
    id,
    kind: 'dependency',
    path: 'package.json',
    excerpt: '"framework": "x"',
    implies: 'a framework dependency',
    weight: 'strong',
  };
}

function detection(overrides: Partial<StackDetection> = {}): StackDetection {
  const base: StackDetection = {
    framework: 'nextjs' as Framework,
    frameworkVersion: '^15.0.0',
    runtime: 'node' as Runtime,
    appShape: 'ssr' as AppShape,
    packageManager: 'npm',
    needs: [] as ServiceNeed[],
    build: NO_BUILD,
    existing: { vercel: false, netlify: false, render: false, dockerfile: false },
    monorepo: false,
    signals: [strongSignal()],
    confidence: 'high',
    notes: [],
  };
  return { ...base, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* Shared assertions                                                          */
/* -------------------------------------------------------------------------- */

/** Every artifact must satisfy the contract. */
function assertSchema(artifact: ConfigArtifact | null): asserts artifact is ConfigArtifact {
  expect(artifact).not.toBeNull();
  const parsed = configArtifactSchema.safeParse(artifact);
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
}

/** Parse a render.yaml artifact and return its object. Throws if it doesn't parse. */
function parseRender(artifact: ConfigArtifact): Record<string, unknown> {
  expect(artifact.language).toBe('yaml');
  const doc = parseYaml(artifact.content);
  expect(doc).toBeTypeOf('object');
  return doc as Record<string, unknown>;
}

interface RenderService {
  type?: string;
  runtime?: string;
  name?: string;
  autoDeploy?: unknown;
  rootDir?: string;
  buildCommand?: string;
  startCommand?: string;
  staticPublishPath?: string;
  schedule?: string;
  ipAllowList?: unknown;
  envVars?: Array<Record<string, unknown>>;
}

function services(doc: Record<string, unknown>): RenderService[] {
  const s = doc.services;
  expect(Array.isArray(s)).toBe(true);
  return s as RenderService[];
}

/* -------------------------------------------------------------------------- */
/* render.yaml — the app shapes                                               */
/* -------------------------------------------------------------------------- */

describe('generateRenderYaml — Express + Postgres', () => {
  const d = detection({
    framework: 'express',
    runtime: 'node',
    appShape: 'fullstack',
    needs: ['database'],
    build: {
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      outputDir: null,
      startCommand: 'npm start',
      nodeVersion: '20',
    },
    signals: [strongSignal('dep:express')],
  });

  it('parses, has a web service and a databases entry', () => {
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    const doc = parseRender(artifact);

    const svcs = services(doc);
    const web = svcs.find((s) => s.type === 'web');
    expect(web).toBeDefined();
    expect(web?.runtime).toBe('node');
    expect(web?.buildCommand).toBe('npm run build');
    expect(web?.startCommand).toBe('npm start');

    // databases: present, exactly one Postgres.
    expect(Array.isArray(doc.databases)).toBe(true);
    const dbs = doc.databases as Array<Record<string, unknown>>;
    expect(dbs).toHaveLength(1);
    expect(dbs[0].plan).toBe('free');
  });

  it('wires DATABASE_URL from the managed DB — no literal value', () => {
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    const doc = parseRender(artifact);
    const web = services(doc).find((s) => s.type === 'web')!;
    const env = web.envVars ?? [];
    const dbUrl = env.find((e) => e.key === 'DATABASE_URL');
    expect(dbUrl).toBeDefined();
    // A reference, never a literal value.
    expect(dbUrl).toHaveProperty('fromDatabase');
    expect(dbUrl).not.toHaveProperty('value');
  });
});

describe('generateRenderYaml — Django (python)', () => {
  const d = detection({
    framework: 'django',
    runtime: 'python',
    appShape: 'fullstack',
    needs: [],
    build: {
      installCommand: 'pip install -r requirements.txt',
      buildCommand: 'pip install -r requirements.txt',
      outputDir: null,
      startCommand: 'gunicorn project.wsgi',
      nodeVersion: null,
    },
    signals: [strongSignal('file:manage.py')],
  });

  it('parses with runtime python and the detected commands', () => {
    const artifact = generateRenderYaml(d, ref({ repo: 'django-app' }));
    assertSchema(artifact);
    const doc = parseRender(artifact);
    const web = services(doc).find((s) => s.type === 'web')!;
    expect(web.runtime).toBe('python');
    expect(web.buildCommand).toBe('pip install -r requirements.txt');
    expect(web.startCommand).toBe('gunicorn project.wsgi');
    // No database need → no databases block.
    expect(doc.databases).toBeUndefined();
  });
});

describe('generateRenderYaml — Dockerfile-only', () => {
  const d = detection({
    framework: 'other',
    runtime: 'docker',
    appShape: 'fullstack',
    needs: [],
    build: NO_BUILD,
    existing: { vercel: false, netlify: false, render: false, dockerfile: true },
    signals: [{ ...strongSignal('file:Dockerfile'), kind: 'file-present', path: 'Dockerfile', excerpt: 'Dockerfile' }],
  });

  it('parses with runtime docker and no build/start command invented', () => {
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    const doc = parseRender(artifact);
    const web = services(doc).find((s) => s.type === 'web')!;
    expect(web.runtime).toBe('docker');
    // We must NOT invent build/start for docker.
    expect(web.buildCommand).toBeUndefined();
    expect(web.startCommand).toBeUndefined();
  });
});

describe('generateRenderYaml — static site', () => {
  const d = detection({
    framework: 'vite',
    runtime: 'static',
    appShape: 'static',
    needs: [],
    build: {
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      outputDir: 'dist',
      startCommand: null,
      nodeVersion: null,
    },
    signals: [strongSignal('dep:vite')],
  });

  it('parses as a web+static service with the detected publish dir', () => {
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    const doc = parseRender(artifact);
    const web = services(doc).find((s) => s.type === 'web')!;
    expect(web.runtime).toBe('static');
    expect(web.staticPublishPath).toBe('./dist');
    expect(web.buildCommand).toBe('npm run build');
  });
});

describe('generateRenderYaml — monorepo', () => {
  const d = detection({
    framework: 'express',
    runtime: 'node',
    appShape: 'api-only',
    needs: [],
    monorepo: true,
    build: {
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      outputDir: null,
      startCommand: 'npm start',
      nodeVersion: null,
    },
    signals: [strongSignal('dep:express')],
  });

  it('sets rootDir from ref.subdir', () => {
    const artifact = generateRenderYaml(d, ref({ subdir: 'apps/api' }));
    assertSchema(artifact);
    const doc = parseRender(artifact);
    const web = services(doc).find((s) => s.type === 'web')!;
    expect(web.rootDir).toBe('apps/api');
  });

  it('omits rootDir when there is no subdir', () => {
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    const doc = parseRender(artifact);
    const web = services(doc).find((s) => s.type === 'web')!;
    expect(web.rootDir).toBeUndefined();
  });
});

describe('generateRenderYaml — cache need emits a keyvalue service', () => {
  const d = detection({
    framework: 'express',
    runtime: 'node',
    appShape: 'fullstack',
    needs: ['cache'],
    build: { installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: null, startCommand: 'npm start', nodeVersion: null },
    signals: [strongSignal('dep:express')],
  });

  it('parses with a keyvalue service (required ipAllowList) and no databases', () => {
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    const doc = parseRender(artifact);
    const kv = services(doc).find((s) => s.type === 'keyvalue');
    expect(kv).toBeDefined();
    expect(kv?.ipAllowList).toEqual([]);
    // cache, not database
    expect(doc.databases).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* render.yaml — the hard invariants                                          */
/* -------------------------------------------------------------------------- */

describe('generateRenderYaml — invariants', () => {
  const scenarios: Array<[string, StackDetection, RepoRef]> = [
    [
      'express+postgres',
      detection({ framework: 'express', appShape: 'fullstack', needs: ['database'], build: { installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: null, startCommand: 'npm start', nodeVersion: null }, signals: [strongSignal('dep:express')] }),
      ref(),
    ],
    [
      'django',
      detection({ framework: 'django', runtime: 'python', appShape: 'fullstack', signals: [strongSignal('file:manage.py')] }),
      ref(),
    ],
    [
      'docker',
      detection({ framework: 'other', runtime: 'docker', appShape: 'fullstack', existing: { vercel: false, netlify: false, render: false, dockerfile: true }, signals: [{ ...strongSignal(), kind: 'file-present', path: 'Dockerfile', excerpt: 'Dockerfile' }] }),
      ref(),
    ],
    [
      'static',
      detection({ framework: 'vite', runtime: 'static', appShape: 'static', build: { installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: 'dist', startCommand: null, nodeVersion: null }, signals: [strongSignal('dep:vite')] }),
      ref(),
    ],
    [
      'monorepo-worker-cron-cache-db',
      detection({ framework: 'express', appShape: 'fullstack', needs: ['database', 'cache', 'background-worker', 'cron'], monorepo: true, build: { installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: null, startCommand: 'npm start', nodeVersion: null }, signals: [strongSignal('dep:express')] }),
      ref({ subdir: 'apps/api' }),
    ],
  ];

  it('every generated blueprint parses and contains autoDeploy: false on every git service', () => {
    for (const [label, d, r] of scenarios) {
      const artifact = generateRenderYaml(d, r);
      assertSchema(artifact);
      const doc = parseRender(artifact);
      const svcs = services(doc);
      // Every non-keyvalue service (git-backed) must carry autoDeploy:false.
      const gitServices = svcs.filter((s) => s.type !== 'keyvalue');
      expect(gitServices.length, label).toBeGreaterThan(0);
      for (const s of gitServices) {
        expect(s.autoDeploy, `${label}/${s.type}`).toBe(false);
      }
    }
  });

  it('never emits a literal env value: every envVar is sync:false or a from* reference', () => {
    for (const [label, d, r] of scenarios) {
      const artifact = generateRenderYaml(d, r);
      assertSchema(artifact);
      const doc = parseRender(artifact);
      for (const s of services(doc)) {
        for (const ev of s.envVars ?? []) {
          // A var either declares sync:false OR references a managed resource.
          const hasValue = Object.prototype.hasOwnProperty.call(ev, 'value');
          expect(hasValue, `${label}: envVar must not carry a literal value`).toBe(false);
          const isReference =
            'fromDatabase' in ev || 'fromService' in ev || ev.sync === false;
          expect(isReference, `${label}: envVar must be a reference or sync:false`).toBe(true);
        }
      }
    }
  });

  it('databases: appears only when a database need was detected', () => {
    for (const [label, d, r] of scenarios) {
      const artifact = generateRenderYaml(d, r);
      assertSchema(artifact);
      const doc = parseRender(artifact);
      if (d.needs.includes('database')) {
        expect(doc.databases, label).toBeDefined();
      } else {
        expect(doc.databases, label).toBeUndefined();
      }
    }
  });

  it('is deterministic (same input twice → identical content)', () => {
    for (const [label, d, r] of scenarios) {
      const a = generateRenderYaml(d, r);
      const b = generateRenderYaml(d, r);
      expect(a?.content, label).toBe(b?.content);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* render.yaml — the gates on WHEN we emit                                    */
/* -------------------------------------------------------------------------- */

describe('generateRenderYaml — emission gate', () => {
  it('returns null when the repo already contains a render.yaml', () => {
    const d = detection({
      framework: 'express',
      appShape: 'fullstack',
      needs: ['database'],
      existing: { vercel: false, netlify: false, render: true, dockerfile: false },
      signals: [strongSignal('dep:express')],
    });
    expect(generateRenderYaml(d, ref())).toBeNull();
  });

  it('returns null for a plain SSR Next.js app with no service needs', () => {
    // ssr + node + no needs + not docker → the serverless hosts handle it; no
    // blueprint is the honest answer.
    const d = detection({ appShape: 'ssr', needs: [] });
    expect(generateRenderYaml(d, ref())).toBeNull();
  });

  it('emits for a fullstack app even with no needs', () => {
    const d = detection({ framework: 'express', appShape: 'fullstack', needs: [], build: { installCommand: 'npm ci', buildCommand: null, outputDir: null, startCommand: 'npm start', nodeVersion: null }, signals: [strongSignal('dep:express')] });
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
  });
});

/* -------------------------------------------------------------------------- */
/* render.yaml — TODO placeholders for null commands                          */
/* -------------------------------------------------------------------------- */

describe('generateRenderYaml — null commands become TODO comments', () => {
  it('emits a # TODO comment (not an invented command) when startCommand is null', () => {
    const d = detection({
      framework: 'express',
      appShape: 'api-only',
      needs: [],
      build: { installCommand: null, buildCommand: null, outputDir: null, startCommand: null, nodeVersion: null },
      signals: [strongSignal('dep:express')],
    });
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    // Must still parse.
    parseRender(artifact);
    expect(artifact.content).toContain('# TODO:');
  });
});

/* -------------------------------------------------------------------------- */
/* MAJOR-3: an incomplete blueprint (placeholder command) is NOT required:true */
/* -------------------------------------------------------------------------- */

describe('generateRenderYaml — placeholder commands flip required:false (MAJOR-3)', () => {
  // The jekyll/minima repro: a static site with no npm scripts, so both the
  // build command and the output dir are legitimately null. The blueprint we
  // emit has placeholder values; we must NOT tell the user it is ready to
  // commit-and-deploy.
  const staticNoBuild = detection({
    framework: 'other',
    runtime: 'static',
    appShape: 'static',
    needs: [],
    build: NO_BUILD,
    signals: [strongSignal('file:_config.yml')],
  });

  it('a static site with no detectable build/output is required:false with a clear why', () => {
    const artifact = generateRenderYaml(staticNoBuild, ref({ repo: 'minima' }));
    assertSchema(artifact);
    expect(renderBlueprintHasPlaceholders(staticNoBuild)).toBe(true);
    expect(artifact.required).toBe(false);
    // The why must plainly tell the user to fill something in first.
    expect(artifact.why.toLowerCase()).toMatch(/placeholder|todo|fill|before you deploy/);
    // And the content still carries the visible TODO markers + parses.
    expect(artifact.content).toContain('# TODO:');
    parseRender(artifact);
  });

  it('a web app with no detectable build/start command is required:false', () => {
    const d = detection({
      framework: 'express',
      runtime: 'node',
      appShape: 'api-only',
      needs: [],
      build: NO_BUILD,
      signals: [strongSignal('dep:express')],
    });
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    expect(renderBlueprintHasPlaceholders(d)).toBe(true);
    expect(artifact.required).toBe(false);
  });

  it('a fully-known web blueprint stays required:true (unchanged)', () => {
    const d = detection({
      framework: 'express',
      runtime: 'node',
      appShape: 'fullstack',
      needs: ['database'],
      build: {
        installCommand: 'npm ci',
        buildCommand: 'npm run build',
        outputDir: null,
        startCommand: 'npm start',
        nodeVersion: '20',
      },
      signals: [strongSignal('dep:express')],
    });
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    expect(renderBlueprintHasPlaceholders(d)).toBe(false);
    expect(artifact.required).toBe(true);
  });

  it('a fully-known static blueprint stays required:true (unchanged)', () => {
    const d = detection({
      framework: 'vite',
      runtime: 'static',
      appShape: 'static',
      needs: [],
      build: {
        installCommand: 'npm ci',
        buildCommand: 'npm run build',
        outputDir: 'dist',
        startCommand: null,
        nodeVersion: null,
      },
      signals: [strongSignal('dep:vite')],
    });
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    expect(renderBlueprintHasPlaceholders(d)).toBe(false);
    expect(artifact.required).toBe(true);
  });

  it('a Docker-only web blueprint invents no command → required:true (unchanged)', () => {
    const d = detection({
      framework: 'other',
      runtime: 'docker',
      appShape: 'fullstack',
      needs: [],
      build: NO_BUILD,
      existing: { vercel: false, netlify: false, render: false, dockerfile: true },
      signals: [
        { ...strongSignal('file:Dockerfile'), kind: 'file-present', path: 'Dockerfile', excerpt: 'Dockerfile' },
      ],
    });
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    expect(renderBlueprintHasPlaceholders(d)).toBe(false);
    expect(artifact.required).toBe(true);
  });

  it('a worker/cron need forces required:false (start command is unknowable)', () => {
    const d = detection({
      framework: 'express',
      runtime: 'node',
      appShape: 'fullstack',
      needs: ['background-worker'],
      build: {
        installCommand: 'npm ci',
        buildCommand: 'npm run build',
        outputDir: null,
        startCommand: 'npm start',
        nodeVersion: '20',
      },
      signals: [strongSignal('dep:bullmq')],
    });
    const artifact = generateRenderYaml(d, ref());
    assertSchema(artifact);
    expect(renderBlueprintHasPlaceholders(d)).toBe(true);
    expect(artifact.required).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* vercel.json / netlify.toml                                                 */
/* -------------------------------------------------------------------------- */

describe('generateVercelJson / generateNetlifyToml — vanilla repos emit nothing', () => {
  it('returns null for a vanilla Next.js repo', () => {
    const d = detection({ framework: 'nextjs', appShape: 'ssr' });
    expect(generateVercelJson(d, ref())).toBeNull();
    expect(generateNetlifyToml(d, ref())).toBeNull();
  });

  it('returns null for a vanilla Vite repo', () => {
    const d = detection({
      framework: 'vite',
      runtime: 'static',
      appShape: 'static',
      build: { installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: 'dist', startCommand: null, nodeVersion: null },
      signals: [strongSignal('dep:vite')],
    });
    expect(generateVercelJson(d, ref())).toBeNull();
    expect(generateNetlifyToml(d, ref())).toBeNull();
  });
});

describe('generateVercelJson / generateNetlifyToml — monorepo emits a hint', () => {
  const d = detection({
    framework: 'nextjs',
    appShape: 'ssr',
    monorepo: true,
    build: { installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: null, startCommand: null, nodeVersion: null },
    signals: [strongSignal('dep:next')],
  });
  const r = ref({ subdir: 'apps/web' });

  it('vercel.json parses as JSON and explains the subdir', () => {
    const artifact = generateVercelJson(d, r);
    assertSchema(artifact);
    expect(artifact.language).toBe('json');
    const obj = JSON.parse(artifact.content);
    expect(obj).toBeTypeOf('object');
    expect(artifact.required).toBe(false);
    expect(artifact.why.toLowerCase()).toContain('subdirectory');
  });

  it('netlify.toml parses as TOML and sets base to the subdir', () => {
    const artifact = generateNetlifyToml(d, r);
    assertSchema(artifact);
    expect(artifact.language).toBe('toml');
    const obj = parseToml(artifact.content) as { build?: { base?: string } };
    expect(obj.build?.base).toBe('apps/web');
    expect(artifact.required).toBe(false);
  });
});

describe('generateVercelJson / generateNetlifyToml — custom build on an unknown framework', () => {
  const d = detection({
    framework: 'other',
    runtime: 'node',
    appShape: 'static',
    build: { installCommand: 'make deps', buildCommand: 'make build', outputDir: 'public', startCommand: null, nodeVersion: null },
    signals: [strongSignal('file:Makefile')],
  });

  it('vercel.json pins the custom build command and output dir', () => {
    const artifact = generateVercelJson(d, ref());
    assertSchema(artifact);
    const obj = JSON.parse(artifact.content) as Record<string, unknown>;
    expect(obj.buildCommand).toBe('make build');
    expect(obj.outputDirectory).toBe('public');
  });

  it('netlify.toml pins command and publish', () => {
    const artifact = generateNetlifyToml(d, ref());
    assertSchema(artifact);
    const obj = parseToml(artifact.content) as { build?: { command?: string; publish?: string } };
    expect(obj.build?.command).toBe('make build');
    expect(obj.build?.publish).toBe('public');
  });
});

describe('generateVercelJson / generateNetlifyToml — existing config suppresses', () => {
  const d = detection({
    framework: 'nextjs',
    appShape: 'ssr',
    monorepo: true,
    existing: { vercel: true, netlify: true, render: false, dockerfile: false },
    signals: [strongSignal('dep:next')],
  });

  it('returns null when the repo already has the provider config', () => {
    expect(generateVercelJson(d, ref({ subdir: 'apps/web' }))).toBeNull();
    expect(generateNetlifyToml(d, ref({ subdir: 'apps/web' }))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* generateConfigs                                                            */
/* -------------------------------------------------------------------------- */

describe('generateConfigs', () => {
  it('drops nulls and returns only applicable artifacts (vanilla Next.js → none)', () => {
    const d = detection({ framework: 'nextjs', appShape: 'ssr' });
    expect(generateConfigs(d, ref())).toEqual([]);
  });

  it('returns render.yaml for a fullstack+db app', () => {
    const d = detection({
      framework: 'express',
      appShape: 'fullstack',
      needs: ['database'],
      build: { installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: null, startCommand: 'npm start', nodeVersion: null },
      signals: [strongSignal('dep:express')],
    });
    const configs = generateConfigs(d, ref());
    expect(configs.map((c) => c.provider)).toContain('render');
    for (const c of configs) assertSchema(c);
  });

  it('returns render.yaml + vercel.json + netlify.toml for a monorepo fullstack app with custom build', () => {
    const d = detection({
      framework: 'other',
      runtime: 'node',
      appShape: 'fullstack',
      needs: ['database'],
      monorepo: true,
      build: { installCommand: 'make deps', buildCommand: 'make build', outputDir: 'out', startCommand: './run', nodeVersion: null },
      signals: [strongSignal('file:Makefile')],
    });
    const configs = generateConfigs(d, ref({ subdir: 'services/api' }));
    const providers = configs.map((c) => c.provider);
    expect(providers).toContain('render');
    expect(providers).toContain('vercel');
    expect(providers).toContain('netlify');
    // Stable order: render, vercel, netlify.
    expect(providers).toEqual(['render', 'vercel', 'netlify']);
    for (const c of configs) assertSchema(c);
  });

  it('is deterministic', () => {
    const d = detection({ framework: 'express', appShape: 'fullstack', needs: ['database'], build: { installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: null, startCommand: 'npm start', nodeVersion: null }, signals: [strongSignal('dep:express')] });
    expect(generateConfigs(d, ref())).toEqual(generateConfigs(d, ref()));
  });
});
