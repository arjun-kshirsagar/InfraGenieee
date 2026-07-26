/**
 * 🔴 LIVE end-to-end smoke test for the one-click-deploy pipeline (task B8, docs §10).
 *
 * This is the proof the brief demands, and the lesson Features 1 and 2 learned
 * the hard way: mocked-only tests hid real bugs in BOTH of them (Feature 2's
 * BLOCKER-1..4 were all found live, never by the 700+ passing unit tests).
 * Fixtures prove the detection matrix is self-consistent; only a live run proves
 * it is pointed at reality.
 *
 * It runs the REAL `GitHubRepoSource` (anonymous GitHub — NO token, NO auth
 * header) plus the REAL pure pipeline (`buildDeployPlan`) against FOUR real,
 * small, stable public repos of different shapes, and asserts per repo:
 *   1. the detected framework / appShape / runtime match reality;
 *   2. `stackDetectionSchema` and `deployPlanSchema` both parse;
 *   3. every signal's `excerpt` is non-empty and its `path` appears in the snapshot;
 *   4. all three deploy URLs are well-formed absolute https:// URLs whose base +
 *      repo param match `DEPLOY_PROVIDER_META`;
 *   5. the expected provider is `primary`;
 *   6. where a `render.yaml` is generated, it parses as YAML and sets `autoDeploy: false`.
 *
 * ## Guard / skip convention (mirrors `src/lib/cost/pricing/build.live.test.ts`)
 *
 * SKIPPED unless `RUN_LIVE_DEPLOY=1`, so `npm test` stays fast and offline by
 * default and CI without network passes green. Run it deliberately with:
 *
 *   RUN_LIVE_DEPLOY=1 npm run test:live:deploy
 *   # or: RUN_LIVE_DEPLOY=1 npx vitest run src/lib/deploy/deploy.live.test.ts
 *
 * ## Budget discipline
 *
 * Anonymous GitHub allows 60 core requests/hour/IP. Each analysis costs ~2–3
 * core requests (metadata + tree), so four repos ≈ 8–12 of 60. A real
 * `RepoSnapshotCache` (a temp dir, per-run) is injected so a re-run inside the
 * 15-minute TTL is nearly free. If the budget is exhausted mid-run, the source
 * throws `RepoError('rate_limited')`; we catch it and SKIP with a clear message
 * rather than fail — a rate limit is not a regression.
 *
 * ## Cost safety (hard)
 *
 * This test only READS public repos and BUILDS URL strings. It never opens a
 * deploy URL, never creates a provider account, never deploys anything, and
 * carries no credentials of any kind.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  DEPLOY_PROVIDER_META,
  DEPLOY_PROVIDERS,
  deployPlanSchema,
  stackDetectionSchema,
  type DeployPlan,
  type DeployProvider,
  type Framework,
  type AppShape,
  type Runtime,
  type ServiceNeed,
} from '@/types/deploy';

import { buildDeployPlan } from './plan';
import { parseRepoUrl } from './repo-url';
import { GitHubRepoSource } from './source/github';
import { RepoSnapshotCache } from './source/cache';
import { RepoError, type RepoSnapshotCache as RepoSnapshotCacheContract } from './repo-seam';

const RUN_LIVE = process.env.RUN_LIVE_DEPLOY === '1';

// A generous timeout: this makes several real GitHub round-trips per repo.
const LIVE_TIMEOUT_MS = 120_000;

/* -------------------------------------------------------------------------- */
/* The four repos, and the reality we expect (verified live 2026-07-29)       */
/* -------------------------------------------------------------------------- */

/**
 * Each expectation was VERIFIED against the real repo before being written:
 * its manifest/tree was fetched and the real `detectStack` was run against it.
 * The expectations describe what the repo actually is, not what we wish it were.
 * All four are small (respecting the 60 req/hr budget) and stable (two are on a
 * `master` default branch; one is archived — so none will vanish mid-review).
 */
interface RepoCase {
  /** Human label for the console proof + the test name. */
  label: string;
  url: string;
  framework: Framework;
  appShape: AppShape;
  runtime: Runtime;
  /** The provider we expect to be crowned `primary`. */
  primary: DeployProvider;
  /** Service needs we require to be present (subset check, not exact). */
  needs: ServiceNeed[];
  /** True when the pipeline is expected to emit a render.yaml blueprint. */
  expectRenderYaml: boolean;
  /** True when the repo is a monorepo/workspace root — we then assert
   *  `detection.monorepo === true` (BLOCKER-2: the honesty machinery must steer
   *  the user to a subdir rather than claim the repo is unreadable). */
  expectMonorepo?: boolean;
  /** True when the repo is big enough that OUR entry cap (or GitHub's) fires,
   *  so `entriesTruncated` must be true and the truncation caveat must appear.
   *  BLOCKER-2 regression guard: a real monorepo whose root manifests sit past
   *  raw tree index 2000 must STILL be read (framework known, confidence not
   *  `unknown`) — the exact false-negative that shipped. */
  expectSelfTruncated?: boolean;
}

const REPOS: RepoCase[] = [
  {
    // A Next.js app. Root package.json declares `next: ^14` + a `next start`
    // script → nextjs / ssr / node. Vercel is the natural home.
    label: 'Next.js app (vercel/next-learn)',
    url: 'https://github.com/vercel/next-learn',
    framework: 'nextjs',
    appShape: 'ssr',
    runtime: 'node',
    primary: 'vercel',
    needs: [],
    // An SSR app with no service needs does not require a render.yaml.
    expectRenderYaml: false,
  },
  {
    // A static site: a Create React App front-end that builds to static output
    // (react-scripts, no server) → static / static. Netlify + Vercel both fit.
    label: 'Static site (docker/welcome-to-docker)',
    url: 'https://github.com/docker/welcome-to-docker',
    framework: 'create-react-app',
    appShape: 'static',
    runtime: 'static',
    primary: 'netlify',
    needs: [],
    // A static site still gets a render.yaml (static web service blueprint).
    expectRenderYaml: true,
  },
  {
    // A full-stack app with a database: a Django project (manage.py +
    // requirements.txt pulling psycopg/django) → django / fullstack / python,
    // needs: database. Render is crowned; a render.yaml is generated.
    label: 'Full-stack + Postgres (digitalocean/sample-django)',
    url: 'https://github.com/digitalocean/sample-django',
    framework: 'django',
    appShape: 'fullstack',
    runtime: 'python',
    primary: 'render',
    needs: ['database'],
    expectRenderYaml: true,
  },
  {
    // A Dockerfile-only, non-Node service: a Dockerfile + index.html, no
    // package.json → framework `other`, runtime `docker`. Render is crowned;
    // a render.yaml (docker web service) is generated. Its default branch is
    // `master`, which also exercises the non-`main` branch path.
    label: 'Dockerfile-only service (crccheck/docker-hello-world)',
    url: 'https://github.com/crccheck/docker-hello-world',
    framework: 'other',
    appShape: 'fullstack',
    runtime: 'docker',
    primary: 'render',
    needs: [],
    expectRenderYaml: true,
  },
  {
    // BLOCKER-2 regression guard (t_5db233af LIVE QA). A large, real pnpm+turbo
    // monorepo whose root manifests (package.json at raw tree index ~5059,
    // pnpm-workspace.yaml, turbo.json) sit FAR past GitHub's raw index 2000.
    // Before the fix the arrival-order cap dropped them from `existingPaths`, so
    // the prober never read package.json and the repo was falsely reported
    // "we couldn't read this repository's contents" (confidence: unknown). The
    // fix builds `existingPaths` from the FULL tree, so package.json is read and
    // a NAMED framework is detected with confidence != 'unknown', monorepo:true,
    // and the truncation caveat fires. We assert a NAMED framework + monorepo +
    // truncation rather than a specific one, because the honesty-correct verdict
    // for a workspace ROOT is "named framework, monorepo:true, go to a subdir",
    // not a guess at which app under apps/ is "the" app.
    label: 'Large monorepo root (shadcn-ui/ui)',
    url: 'https://github.com/shadcn-ui/ui',
    // The root workspace is a Vite-based tooling root; the Next.js apps live
    // under apps/. `framework` here is whatever the root manifest honestly
    // implies — asserted below only as "not `other`/unknown", plus monorepo.
    framework: 'vite',
    appShape: 'static',
    runtime: 'static',
    primary: 'netlify',
    needs: [],
    // A monorepo root still gets a (static) render.yaml blueprint.
    expectRenderYaml: true,
    expectMonorepo: true,
    expectSelfTruncated: true,
  },
];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** True when a thrown error is a retryable rate-limit — a skip, never a fail. */
function isRateLimit(err: unknown): err is RepoError {
  return err instanceof RepoError && err.code === 'rate_limited';
}

/**
 * The set of every path the snapshot can legitimately cite as evidence: the
 * entry paths (the tree listing) plus the probe-file keys (files we read). A
 * signal whose `path` is not in this set would be a fabricated citation.
 */
function snapshotPaths(plan: DeployPlan, entries: string[], files: string[]): Set<string> {
  void plan;
  return new Set<string>([...entries, ...files]);
}

/* -------------------------------------------------------------------------- */
/* The suite                                                                   */
/* -------------------------------------------------------------------------- */

describe.skipIf(!RUN_LIVE)('one-click deploy — LIVE smoke (real GitHub + real pipeline)', () => {
  // One real filesystem cache for the whole run, in a throwaway temp dir, so a
  // re-run within the 15-minute TTL costs ~0 GitHub requests and CI leaves no
  // droppings in the repo's own .cache.
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'infragenie-deploy-live-'));
  const source = new GitHubRepoSource();

  it.each(REPOS)(
    'analyzes $label correctly, end to end',
    async (rc) => {
      // A fresh cache per repo keyed under the shared temp dir.
      const cache = new RepoSnapshotCache({ rootDir: cacheDir });

      // Fetch the snapshot ONCE via the real source and keep it in hand (so we
      // can validate signal→path citations below without a second read). Then
      // feed it to `buildDeployPlan` through a pre-populated in-memory cache so
      // the pipeline runs against the SAME real snapshot without a second
      // network read (the anonymous ref has no branch key on disk, so the file
      // cache would miss and re-fetch — this guarantees exactly one read/repo).
      let plan: DeployPlan;
      let snap;
      try {
        const ref = parseRepoUrl(rc.url);
        snap = await source.fetchSnapshot(ref);
        // Best-effort: also persist to the shared file cache so a manual re-run
        // of `buildDeployPlan` (with a pinned branch) is free.
        await cache.set(snap);
        const primed = snap;
        const primedCache: RepoSnapshotCacheContract = {
          get: async () => primed,
          set: async () => {},
        };
        plan = await buildDeployPlan(rc.url, {
          source,
          cache: primedCache,
          now: () => new Date().toISOString(),
        });
      } catch (err) {
        if (isRateLimit(err)) {
          // A rate limit is NOT a regression. Say so loudly and skip this case.
          console.warn(
            `\n⏭️  SKIPPED ${rc.label}: GitHub anonymous rate limit reached ` +
              `(60 req/hr/IP). Re-run later; this is not a test failure.`,
          );
          // Vitest has no per-iteration skip API inside it.each; bail as a pass.
          return;
        }
        throw err;
      }

      /* --- (2) both schemas parse -------------------------------------- */
      expect(stackDetectionSchema.safeParse(plan.detection).success).toBe(true);
      expect(deployPlanSchema.safeParse(plan).success).toBe(true);

      /* --- (1) detection matches reality ------------------------------- */
      if (rc.expectMonorepo) {
        // For a monorepo ROOT we assert the honesty-correct verdict rather than
        // a specific framework (which app under apps/ is "the" app is not ours
        // to guess): a NAMED framework (never `other`), confidence != 'unknown',
        // and monorepo:true so the user is steered to a subdir. This is the
        // exact BLOCKER-2 false-negative guard — a readable monorepo must not be
        // reported unreadable.
        expect(plan.detection.framework).not.toBe('other');
        expect(plan.detection.confidence).not.toBe('unknown');
        expect(plan.detection.monorepo).toBe(true);
        expect(plan.primary).not.toBeNull();
      } else {
        expect(plan.detection.framework).toBe(rc.framework);
        expect(plan.detection.appShape).toBe(rc.appShape);
        expect(plan.detection.runtime).toBe(rc.runtime);
        /* --- (5) the expected provider is primary ---------------------- */
        expect(plan.primary).toBe(rc.primary);
      }
      for (const need of rc.needs) {
        expect(plan.detection.needs).toContain(need);
      }

      /* --- BLOCKER-2: WE-truncated a large tree, so the caveat must fire  */
      if (rc.expectSelfTruncated) {
        expect(snap.entriesTruncated).toBe(true);
        // The user MUST be told we stopped reading — not silently mislead.
        expect(
          plan.detection.notes.some((n) => /too large to list fully/i.test(n)),
          'a self-truncated repo must surface the truncation caveat',
        ).toBe(true);
        // And the root manifest MUST have been read despite the cap — the whole
        // point of the fix. A monorepo root always has a package.json.
        expect(Object.keys(snap.files)).toContain('package.json');
      }

      /* --- (3) every signal is cited: non-empty excerpt + real path ---- */
      // Use the snapshot the plan was built from to rebuild the set of
      // legitimate evidence paths.
      const entryPaths = snap.entries.filter((e) => e.type === 'file').map((e) => e.path);
      const fileKeys = Object.keys(snap.files);
      const legitPaths = snapshotPaths(plan, entryPaths, fileKeys);

      expect(plan.detection.signals.length).toBeGreaterThan(0);
      for (const sig of plan.detection.signals) {
        expect(sig.excerpt.trim().length).toBeGreaterThan(0);
        expect(sig.path.length).toBeGreaterThan(0);
        expect(legitPaths.has(sig.path)).toBe(true);
      }

      /* --- (4) all three deploy URLs are well-formed + table-consistent  */
      expect(plan.fits).toHaveLength(DEPLOY_PROVIDERS.length);
      const canonical = plan.repo.canonicalUrl;
      for (const fit of plan.fits) {
        const meta = DEPLOY_PROVIDER_META[fit.provider];
        const parsed = new URL(fit.deployUrl); // throws if not absolute
        expect(parsed.protocol).toBe('https:');
        // base (origin + pathname, no query) must equal the provider's deployBase.
        expect(`${parsed.origin}${parsed.pathname}`).toBe(meta.deployBase);
        // the repo param must carry the user's canonical repo URL.
        const repoValue = parsed.searchParams.get(meta.repoParam);
        expect(repoValue).not.toBeNull();
        expect(repoValue!.startsWith(canonical)).toBe(true);
      }

      /* --- (6) render.yaml (when generated) parses as YAML w/ autoDeploy:false */
      const renderCfg = plan.configs.find((c) => c.provider === 'render');
      if (rc.expectRenderYaml) {
        expect(renderCfg, `${rc.label} should generate a render.yaml`).toBeDefined();
      }
      if (renderCfg) {
        expect(renderCfg.filename).toBe('render.yaml');
        expect(renderCfg.language).toBe('yaml');
        // Real YAML parse — a blueprint that does not parse is worse than none.
        const doc = parseYaml(renderCfg.content) as {
          services?: Array<Record<string, unknown>>;
        };
        expect(doc).toBeTruthy();
        expect(Array.isArray(doc.services)).toBe(true);
        expect(doc.services!.length).toBeGreaterThan(0);
        // Every service the blueprint defines must set autoDeploy: false (the
        // boolean, not the string) — Render's own button recommendation.
        for (const svc of doc.services!) {
          expect(svc.autoDeploy).toBe(false);
        }
      }

      /* --- human-readable proof for the kanban comment ----------------- */
      console.log(
        `\n✅ ${rc.label}\n` +
          `   framework=${plan.detection.framework} appShape=${plan.detection.appShape} ` +
          `runtime=${plan.detection.runtime} confidence=${plan.detection.confidence}\n` +
          `   needs=[${plan.detection.needs.join(', ')}] primary=${plan.primary}\n` +
          `   signals=${plan.detection.signals.length} ` +
          `(${plan.detection.signals.map((s) => s.id).slice(0, 6).join(', ')})\n` +
          `   render.yaml=${renderCfg ? 'generated' : 'none'}\n` +
          `   URLs: ${plan.fits
            .map((f) => `${f.provider}→${new URL(f.deployUrl).origin}${new URL(f.deployUrl).pathname}`)
            .join('  ')}`,
      );
    },
    LIVE_TIMEOUT_MS,
  );
});
