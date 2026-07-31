/**
 * Tests for the PURE `recommendProviders` (task B5, docs §6).
 *
 * The engine is the "which provider, and why" half of Feature 3. These tests
 * prove:
 *
 *   1. DETERMINISM — same input twice → deep-equal output.
 *   2. Every fit parses `providerFitSchema`, and there are always exactly three.
 *   3. One case per row of the §6 fit table asserts the verdict per provider.
 *   4. The headline scenarios: Next.js→Vercel primary, Django+Postgres→Render
 *      primary w/ requiresConfig, Hugo→Vercel+Netlify recommended, Docker-only→
 *      Render primary + the other two not-recommended, unknown→primary null.
 *   5. PRD context CHANGES something (a caveat, a supplied need with a PRD
 *      attribution note) AND cannot flip a verdict a strong file signal decided.
 *   6. usedPrdContext===false with no context, and every fit has ≥1 reason.
 *
 * Pure and offline: no network, no clock.
 */

import { describe, expect, it } from 'vitest';

import { recommendProviders } from '@/lib/deploy/recommend';
import {
  providerFitSchema,
  DEPLOY_PROVIDERS,
  type BuildHints,
  type DeployPrdContext,
  type DeployProvider,
  type DetectionSignal,
  type FitVerdict,
  type Framework,
  type Runtime,
  type ServiceNeed,
  type StackDetection,
  type RepoRef,
} from '@/types/deploy';

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

const REF: RepoRef = {
  host: 'github',
  owner: 'acme',
  repo: 'app',
  branch: null,
  subdir: null,
  canonicalUrl: 'https://github.com/acme/app',
};

const NO_BUILD: BuildHints = {
  installCommand: null,
  buildCommand: null,
  outputDir: null,
  startCommand: null,
  nodeVersion: null,
};

/** A single strong signal so `confidence: 'high'` is legal. */
function strongSignal(id = 'dep:framework'): DetectionSignal {
  return {
    id,
    kind: 'dependency',
    path: 'package.json',
    excerpt: '"next": "^15.0.0"',
    implies: 'a framework dependency',
    weight: 'strong',
  };
}

function detection(overrides: Partial<StackDetection> = {}): StackDetection {
  const base: StackDetection = {
    framework: 'nextjs' as Framework,
    frameworkVersion: '^15.0.0',
    runtime: 'node' as Runtime,
    appShape: 'ssr',
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

function verdictMap(fits: ReturnType<typeof recommendProviders>['fits']): Record<DeployProvider, FitVerdict> {
  const out = {} as Record<DeployProvider, FitVerdict>;
  for (const f of fits) out[f.provider] = f.verdict;
  return out;
}

function fitFor(
  result: ReturnType<typeof recommendProviders>,
  provider: DeployProvider,
) {
  const fit = result.fits.find((f) => f.provider === provider);
  if (!fit) throw new Error(`no fit for ${provider}`);
  return fit;
}

/* -------------------------------------------------------------------------- */
/* 1. Determinism + structural invariants                                     */
/* -------------------------------------------------------------------------- */

describe('recommendProviders — purity & structure', () => {
  it('is deterministic: same input twice → deep-equal', () => {
    const d = detection();
    const a = recommendProviders(d, REF, {});
    const b = recommendProviders(d, REF, {});
    expect(a).toEqual(b);
  });

  it('is deterministic with PRD context too', () => {
    const d = detection({ appShape: 'fullstack', needs: ['database'] });
    const prd = prdContext({ budgetBand: 'free-tier' });
    const a = recommendProviders(d, REF, { prdContext: prd });
    const b = recommendProviders(d, REF, { prdContext: prd });
    expect(a).toEqual(b);
  });

  it('always returns exactly three fits, one per provider, each schema-valid', () => {
    const r = recommendProviders(detection(), REF, {});
    expect(r.fits).toHaveLength(3);
    const providers = new Set(r.fits.map((f) => f.provider));
    expect(providers).toEqual(new Set(DEPLOY_PROVIDERS));
    for (const f of r.fits) {
      expect(providerFitSchema.safeParse(f).success).toBe(true);
      expect(f.reasons.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('fits are sorted by score descending; ties broken by canonical order', () => {
    const r = recommendProviders(detection(), REF, {});
    for (let i = 1; i < r.fits.length; i += 1) {
      expect(r.fits[i - 1].score).toBeGreaterThanOrEqual(r.fits[i].score);
    }
  });

  it('deployUrl comes from the builder (points at the provider flow)', () => {
    const r = recommendProviders(detection(), REF, {});
    expect(fitFor(r, 'vercel').deployUrl).toContain('vercel.com/new/clone');
    expect(fitFor(r, 'netlify').deployUrl).toContain('app.netlify.com/start/deploy');
    expect(fitFor(r, 'render').deployUrl).toContain('render.com/deploy');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. One case per row of the §6 fit table                                    */
/* -------------------------------------------------------------------------- */

interface Row {
  name: string;
  detection: StackDetection;
  expect: Record<DeployProvider, FitVerdict>;
}

const TABLE_ROWS: Row[] = [
  {
    name: 'row1 static (Hugo)',
    detection: detection({
      framework: 'hugo',
      runtime: 'static',
      appShape: 'static',
      packageManager: 'none',
      signals: [
        {
          id: 'file:hugo',
          kind: 'file-present',
          path: 'config.toml',
          excerpt: 'config.toml',
          implies: 'Hugo site',
          weight: 'strong',
        },
      ],
    }),
    expect: { vercel: 'recommended', netlify: 'recommended', render: 'possible' },
  },
  {
    name: 'row1 static (Vite SPA)',
    detection: detection({
      framework: 'vite',
      runtime: 'node',
      appShape: 'static',
      signals: [strongSignal('dep:vite')],
    }),
    expect: { vercel: 'recommended', netlify: 'recommended', render: 'possible' },
  },
  {
    name: 'row2 ssr Next.js',
    detection: detection(),
    expect: { vercel: 'recommended', netlify: 'possible', render: 'possible' },
  },
  {
    name: 'row3 ssr Nuxt',
    detection: detection({
      framework: 'nuxt',
      appShape: 'ssr',
      signals: [strongSignal('dep:nuxt')],
    }),
    expect: { vercel: 'recommended', netlify: 'recommended', render: 'possible' },
  },
  {
    name: 'row3 ssr SvelteKit',
    detection: detection({
      framework: 'sveltekit',
      appShape: 'ssr',
      signals: [strongSignal('dep:sveltekit')],
    }),
    expect: { vercel: 'recommended', netlify: 'recommended', render: 'possible' },
  },
  {
    name: 'row4 fullstack (Express server)',
    detection: detection({
      framework: 'express',
      appShape: 'fullstack',
      signals: [strongSignal('dep:express')],
    }),
    expect: { vercel: 'not-recommended', netlify: 'not-recommended', render: 'recommended' },
  },
  {
    name: 'row4 api-only (Fastify)',
    detection: detection({
      framework: 'fastify',
      appShape: 'api-only',
      signals: [strongSignal('dep:fastify')],
    }),
    expect: { vercel: 'not-recommended', netlify: 'not-recommended', render: 'recommended' },
  },
  {
    name: 'row5 needs database (Next.js + Prisma/Postgres)',
    detection: detection({
      appShape: 'fullstack',
      needs: ['database'],
      signals: [strongSignal(), strongSignal('dep:prisma')],
    }),
    expect: { vercel: 'not-recommended', netlify: 'not-recommended', render: 'recommended' },
  },
  {
    name: 'row5 needs cache on an SSR app (stays possible on serverless)',
    detection: detection({
      appShape: 'ssr',
      needs: ['cache'],
      signals: [strongSignal()],
    }),
    expect: { vercel: 'recommended', netlify: 'possible', render: 'possible' },
  },
  {
    name: 'row6 needs background-worker',
    detection: detection({
      appShape: 'fullstack',
      needs: ['background-worker'],
      signals: [strongSignal('dep:bullmq')],
    }),
    expect: { vercel: 'not-recommended', netlify: 'not-recommended', render: 'recommended' },
  },
  {
    name: 'row6 needs websockets',
    detection: detection({
      framework: 'express',
      appShape: 'fullstack',
      needs: ['websockets'],
      signals: [strongSignal('dep:ws')],
    }),
    expect: { vercel: 'not-recommended', netlify: 'not-recommended', render: 'recommended' },
  },
  {
    name: 'row6 needs cron',
    detection: detection({
      appShape: 'fullstack',
      needs: ['cron'],
      signals: [strongSignal('dep:node-cron')],
    }),
    expect: { vercel: 'not-recommended', netlify: 'not-recommended', render: 'recommended' },
  },
  {
    name: 'row7 docker',
    detection: detection({
      framework: 'other',
      runtime: 'docker',
      appShape: 'fullstack',
      signals: [
        {
          id: 'file:dockerfile',
          kind: 'file-present',
          path: 'Dockerfile',
          excerpt: 'Dockerfile',
          implies: 'ships its own container',
          weight: 'strong',
        },
      ],
      existing: { vercel: false, netlify: false, render: false, dockerfile: true },
    }),
    expect: { vercel: 'not-recommended', netlify: 'not-recommended', render: 'recommended' },
  },
  {
    name: 'row8 non-Node server (Django + Postgres)',
    detection: detection({
      framework: 'django',
      runtime: 'python',
      appShape: 'fullstack',
      packageManager: 'none',
      needs: ['database'],
      frameworkVersion: null,
      signals: [
        {
          id: 'dep:django',
          kind: 'dependency',
          path: 'requirements.txt',
          excerpt: 'Django==5.0',
          implies: 'Django project',
          weight: 'strong',
        },
      ],
    }),
    expect: { vercel: 'not-recommended', netlify: 'not-recommended', render: 'recommended' },
  },
  {
    name: 'row9 unknown confidence',
    detection: detection({
      framework: 'unknown',
      runtime: 'unknown',
      appShape: 'unknown',
      packageManager: 'unknown',
      frameworkVersion: null,
      needs: [],
      signals: [],
      confidence: 'unknown',
      notes: ['We could not read this repo (GitLab contents unreadable in v1).'],
    }),
    expect: { vercel: 'possible', netlify: 'possible', render: 'possible' },
  },
];

describe('recommendProviders — §6 fit table (one case per row)', () => {
  it('has at least 14 table cases', () => {
    expect(TABLE_ROWS.length).toBeGreaterThanOrEqual(14);
  });

  for (const row of TABLE_ROWS) {
    it(`${row.name}: verdicts match the table AND every fit parses`, () => {
      const r = recommendProviders(row.detection, REF, {});
      const got = verdictMap(r.fits);
      expect(got).toEqual(row.expect);
      for (const f of r.fits) {
        expect(providerFitSchema.safeParse(f).success).toBe(true);
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 3. Headline scenarios (acceptance criteria)                                */
/* -------------------------------------------------------------------------- */

describe('recommendProviders — headline scenarios', () => {
  it('Next.js → Vercel primary', () => {
    const r = recommendProviders(detection(), REF, {});
    expect(r.primary).toBe('vercel');
    expect(fitFor(r, 'vercel').verdict).toBe('recommended');
    expect(fitFor(r, 'vercel').reasons.join(' ')).toMatch(/first-party|Next\.js/i);
  });

  it('Django + Postgres → Render primary with requiresConfig: true', () => {
    const d = TABLE_ROWS.find((x) => x.name.startsWith('row8'))!.detection;
    const r = recommendProviders(d, REF, {});
    expect(r.primary).toBe('render');
    expect(fitFor(r, 'render').verdict).toBe('recommended');
    expect(fitFor(r, 'render').requiresConfig).toBe(true);
    expect(fitFor(r, 'render').caveats.join(' ')).toMatch(/render\.yaml/i);
  });

  it('Hugo → Vercel + Netlify recommended, Render possible', () => {
    const d = TABLE_ROWS.find((x) => x.name.startsWith('row1 static (Hugo)'))!.detection;
    const r = recommendProviders(d, REF, {});
    expect(fitFor(r, 'vercel').verdict).toBe('recommended');
    expect(fitFor(r, 'netlify').verdict).toBe('recommended');
    expect(fitFor(r, 'render').verdict).toBe('possible');
    // A static site needs no blueprint → Render button works as-is.
    expect(fitFor(r, 'render').requiresConfig).toBe(false);
  });

  it('Dockerfile-only → Render primary, the other two not-recommended with a reason', () => {
    const d = TABLE_ROWS.find((x) => x.name.startsWith('row7'))!.detection;
    const r = recommendProviders(d, REF, {});
    expect(r.primary).toBe('render');
    expect(fitFor(r, 'vercel').verdict).toBe('not-recommended');
    expect(fitFor(r, 'netlify').verdict).toBe('not-recommended');
    expect(fitFor(r, 'vercel').reasons.join(' ')).toMatch(/Dockerfile|container/i);
    expect(fitFor(r, 'netlify').reasons.join(' ')).toMatch(/Dockerfile|container/i);
    expect(fitFor(r, 'render').requiresConfig).toBe(true);
  });

  it('unknown confidence → primary null, three × possible with guidance', () => {
    const d = TABLE_ROWS.find((x) => x.name.startsWith('row9'))!.detection;
    const r = recommendProviders(d, REF, {});
    expect(r.primary).toBeNull();
    for (const p of DEPLOY_PROVIDERS) {
      expect(fitFor(r, p).verdict).toBe('possible');
      expect(fitFor(r, p).reasons.length).toBeGreaterThanOrEqual(1);
    }
    expect(r.usedPrdContext).toBe(false);
  });

  it('Render requiresConfig is FALSE when the repo already has render.yaml, and says so', () => {
    const d = detection({
      framework: 'express',
      appShape: 'fullstack',
      needs: ['database'],
      signals: [strongSignal('dep:express')],
      existing: { vercel: false, netlify: false, render: true, dockerfile: false },
    });
    const r = recommendProviders(d, REF, {});
    expect(fitFor(r, 'render').requiresConfig).toBe(false);
    expect(fitFor(r, 'render').reasons.join(' ')).toMatch(/already contains a render\.yaml/i);
  });

  // MAJOR-3: when the blueprint we generate carries a placeholder build/start
  // command (we couldn't detect one), the Render fit must WARN the user BEFORE
  // the deploy button — a caveat renders above the button — so they don't
  // commit-and-click an incomplete file that "succeeds" and serves nothing.
  it('Render fit carries a placeholder-warning caveat when the build/start command is unknown (MAJOR-3)', () => {
    const d = detection({
      framework: 'express',
      runtime: 'node',
      appShape: 'fullstack',
      needs: ['database'],
      build: NO_BUILD, // no detectable build/start → blueprint has # TODO placeholders
      signals: [strongSignal('dep:express')],
    });
    const r = recommendProviders(d, REF, {});
    const render = fitFor(r, 'render');
    expect(render.requiresConfig).toBe(true);
    // The warning must reference the placeholder / TODO / fill-in-first idea.
    expect(render.caveats.join(' ')).toMatch(/placeholder|# TODO|fill|empty site/i);
  });

  it('Render fit does NOT carry the placeholder caveat when build+start are fully known (MAJOR-3)', () => {
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
    const r = recommendProviders(d, REF, {});
    const render = fitFor(r, 'render');
    expect(render.requiresConfig).toBe(true);
    expect(render.caveats.join(' ')).not.toMatch(/placeholder|# TODO|empty site/i);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. No PRD context                                                          */
/* -------------------------------------------------------------------------- */

describe('recommendProviders — without PRD context', () => {
  it('usedPrdContext === false and every fit still has ≥1 reason', () => {
    for (const row of TABLE_ROWS) {
      const r = recommendProviders(row.detection, REF, {});
      expect(r.usedPrdContext).toBe(false);
      for (const f of r.fits) expect(f.reasons.length).toBeGreaterThanOrEqual(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5. PRD context sharpens                                                    */
/* -------------------------------------------------------------------------- */

function prdContext(ctx: Partial<DeployPrdContext['context']> = {}, components?: DeployPrdContext['components']): DeployPrdContext {
  return {
    title: 'My App',
    context: {
      userScale: 'medium',
      trafficPattern: 'steady',
      budgetBand: 'startup',
      timelineWeeks: 8,
      ...ctx,
    },
    components: components ?? [
      { name: 'Web', kind: 'client', responsibility: 'UI', technology: 'Next.js' },
    ],
  };
}

describe('recommendProviders — PRD context changes something', () => {
  it("budgetBand 'free-tier' alters a caveat vs no PRD", () => {
    const d = detection({ appShape: 'ssr' });
    const withoutPrd = recommendProviders(d, REF, {});
    const withPrd = recommendProviders(d, REF, {
      prdContext: prdContext({ budgetBand: 'free-tier' }),
    });
    expect(withPrd.usedPrdContext).toBe(true);
    // A new free-tier reason/caveat that the no-PRD run does not carry.
    const beforeText = JSON.stringify(withoutPrd.fits);
    const afterText = JSON.stringify(withPrd.fits);
    expect(afterText).not.toBe(beforeText);
    expect(afterText).toMatch(/free-tier|Hobby|free tier/i);
  });

  it('a datastore component SUPPLIES a database consideration, with a PRD attribution note', () => {
    // Repo is quiet about a DB (no needs), PRD lists a datastore component.
    const d = detection({ appShape: 'ssr', needs: [] });
    const prd = prdContext({}, [
      { name: 'Web', kind: 'client', responsibility: 'UI', technology: 'Next.js' },
      { name: 'Primary DB', kind: 'datastore', responsibility: 'persistence', technology: 'Postgres' },
    ]);
    const r = recommendProviders(d, REF, { prdContext: prd });
    expect(r.usedPrdContext).toBe(true);
    // Render now cites a managed DB; Vercel/Netlify carry the external-DB caveat.
    expect(fitFor(r, 'render').reasons.join(' ')).toMatch(/database/i);
    expect(fitFor(r, 'vercel').caveats.join(' ')).toMatch(/managed relational database|external/i);
    // The attribution note lands in assumptions.
    expect(r.assumptions.join(' ')).toMatch(/from the PRD, not the code|PRD lists a datastore/i);
  });

  it('a PRD CANNOT flip a verdict that a strong file signal decided', () => {
    // Strong file signal: Next.js SSR → Vercel recommended. Even a free-tier
    // budget (which nudges scores) must not demote Vercel below recommended,
    // and must not promote Render to recommended for a plain SSR app.
    const d = detection({ appShape: 'ssr' }); // Next.js, high confidence
    const noPrd = recommendProviders(d, REF, {});
    const withPrd = recommendProviders(d, REF, {
      prdContext: prdContext({ budgetBand: 'free-tier', userScale: 'very-large', trafficPattern: 'spiky' }),
    });
    // The file-decided verdicts are preserved.
    expect(fitFor(noPrd, 'vercel').verdict).toBe('recommended');
    expect(fitFor(withPrd, 'vercel').verdict).toBe('recommended');
    expect(fitFor(withPrd, 'render').verdict).not.toBe('recommended');
    expect(withPrd.primary).toBe('vercel');
  });

  it('a PRD datastore cannot override a Docker file signal (Render still primary, serverless still not-recommended)', () => {
    const d = TABLE_ROWS.find((x) => x.name.startsWith('row7'))!.detection;
    const prd = prdContext({ budgetBand: 'free-tier' }, [
      { name: 'Web', kind: 'client', responsibility: 'UI', technology: 'x' },
      { name: 'DB', kind: 'datastore', responsibility: 'db', technology: 'pg' },
    ]);
    const r = recommendProviders(d, REF, { prdContext: prd });
    expect(r.primary).toBe('render');
    expect(fitFor(r, 'vercel').verdict).toBe('not-recommended');
    expect(fitFor(r, 'netlify').verdict).toBe('not-recommended');
  });

  it('PRD-supplied need does not apply at unknown confidence (schema forbids needs there)', () => {
    const d = TABLE_ROWS.find((x) => x.name.startsWith('row9'))!.detection;
    const prd = prdContext({}, [
      { name: 'DB', kind: 'datastore', responsibility: 'db', technology: 'pg' },
    ]);
    const r = recommendProviders(d, REF, { prdContext: prd });
    // Still unknown → primary null, all possible, and we didn't invent a need.
    expect(r.primary).toBeNull();
    for (const p of DEPLOY_PROVIDERS) expect(fitFor(r, p).verdict).toBe('possible');
  });
});
