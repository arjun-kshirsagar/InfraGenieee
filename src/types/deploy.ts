/**
 * InfraGenie — Feature 3 contract: one-click deploy.
 *
 * Owned by: **architect**. zod schemas are the source of truth; every TS type
 * here is `z.infer`red. Backend and frontend both import from this file — never
 * hand-write a parallel interface (docs/architecture.md §3 rule 1).
 *
 * ## The shape of the feature
 *
 * The user pastes THEIR OWN repo URL. We:
 *   1. parse it            → `RepoRef`        (pure, `src/lib/deploy/repo-url.ts`)
 *   2. read the repo        → `RepoSnapshot`   (impure, behind the `RepoSource` seam)
 *   3. detect the stack     → `StackDetection` (pure, `src/lib/deploy/detect/`)
 *   4. score the providers  → `ProviderFit[]`  (pure, `src/lib/deploy/recommend/`)
 *   5. generate configs     → `ConfigArtifact[]` (pure, `src/lib/deploy/generate/`)
 * …assembled into a `DeployPlan` and returned by `POST /api/deploy/analyze`.
 *
 * ## The invariant that makes this feature honest
 *
 * **Every claim about the user's stack must cite a file.** A `DetectionSignal`
 * cannot be constructed without a `path` and an `excerpt` lifted verbatim from
 * that file. This is the same posture as Feature 2's `PriceRecord.source.evidence`:
 * an uncited detection is indistinguishable from a fabricated guess. When there
 * are no strong signals, `confidence` is `'unknown'` and the UI must offer all
 * three providers with guidance rather than inventing a winner.
 *
 * ## We never deploy anything
 *
 * InfraGenie generates a URL into the PROVIDER'S OWN hosted flow. We hold no
 * provider tokens, call no provider API, and create no resources. That is a
 * product decision and a cost-safety guarantee (docs/architecture.md §6).
 */

import { z } from 'zod';

import {
  architectureComponentSchema,
  briefContextSchema,
  infrastructureSchema,
} from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * EXACTLY three providers in v1. Do not add Railway/AWS/Fly — the scope is
 * deliberate: these three share one "clone my repo" URL pattern, which is what
 * lets the builder stay a table rather than three integrations.
 */
export const deployProviderSchema = z.enum(['vercel', 'netlify', 'render']);
export type DeployProvider = z.infer<typeof deployProviderSchema>;

export const DEPLOY_PROVIDERS: readonly DeployProvider[] = ['vercel', 'netlify', 'render'] as const;

/**
 * Git hosts we accept. All three deploy providers accept GitHub, GitLab and
 * Bitbucket repos in their hosted flows, so we generate buttons for all three.
 *
 * **Content reading is GitHub-only in v1.** GitLab and Bitbucket have different
 * anonymous content APIs; rather than half-implement them and guess, a non-GitHub
 * ref yields `confidence: 'unknown'` with an explicit note. Honest beats broad.
 */
export const repoHostSchema = z.enum(['github', 'gitlab', 'bitbucket']);
export type RepoHost = z.infer<typeof repoHostSchema>;

/** Hosts whose contents we can actually read anonymously in v1. */
export const READABLE_HOSTS: readonly RepoHost[] = ['github'] as const;

/**
 * What kind of application this is — the single most important axis for
 * provider fit. `static` and `ssr` suit Vercel/Netlify; `fullstack`/`api-only`
 * with a long-lived server or a database lean Render.
 */
export const appShapeSchema = z.enum([
  'static', // prebuilt HTML/CSS/JS, no server at request time
  'ssr', // framework-rendered per request, serverless-compatible (Next, Nuxt, …)
  'fullstack', // app server + its own persistence / background work
  'api-only', // server with no UI
  'unknown', // no readable signal — say so, do not guess
]);
export type AppShape = z.infer<typeof appShapeSchema>;

/** Language runtime the provider must supply. `docker` = the repo ships its own. */
export const runtimeSchema = z.enum([
  'node',
  'python',
  'ruby',
  'go',
  'rust',
  'php',
  'java',
  'elixir',
  'docker',
  'static',
  'unknown',
]);
export type Runtime = z.infer<typeof runtimeSchema>;

/**
 * Frameworks we can detect from a real file signal. Anything unrecognised is
 * `other` (we saw a stack but can't name it) or `unknown` (we saw nothing) —
 * the two are different and the UI phrases them differently.
 */
export const frameworkSchema = z.enum([
  // JS/TS — SSR / hybrid
  'nextjs',
  'nuxt',
  'remix',
  'sveltekit',
  'astro',
  'angular',
  // JS/TS — static / SPA
  'vite',
  'create-react-app',
  'gatsby',
  'docusaurus',
  'eleventy',
  'vuepress',
  // JS/TS — servers
  'express',
  'fastify',
  'nestjs',
  'hono',
  // other runtimes
  'django',
  'flask',
  'fastapi',
  'rails',
  'laravel',
  'phoenix',
  'spring-boot',
  'gin',
  // static site generators (non-JS)
  'hugo',
  'jekyll',
  'static-html',
  'other',
  'unknown',
]);
export type Framework = z.infer<typeof frameworkSchema>;

export const packageManagerSchema = z.enum(['npm', 'pnpm', 'yarn', 'bun', 'none', 'unknown']);
export type PackageManager = z.infer<typeof packageManagerSchema>;

/**
 * Managed services the app appears to need. Drives both provider fit (Render
 * has managed Postgres/Redis; Vercel/Netlify need an external add-on) and the
 * generated `render.yaml`.
 */
export const serviceNeedSchema = z.enum([
  'database',
  'cache',
  'queue',
  'object-storage',
  'cron',
  'websockets',
  'background-worker',
]);
export type ServiceNeed = z.infer<typeof serviceNeedSchema>;

/** How much we actually know. `unknown` = we could not read the repo's contents. */
export const detectionConfidenceSchema = z.enum(['high', 'medium', 'low', 'unknown']);
export type DetectionConfidence = z.infer<typeof detectionConfidenceSchema>;

export const fitVerdictSchema = z.enum(['recommended', 'possible', 'not-recommended']);
export type FitVerdict = z.infer<typeof fitVerdictSchema>;

/* -------------------------------------------------------------------------- */
/* 1. The repo reference (pure parse of what the user pasted)                 */
/* -------------------------------------------------------------------------- */

/**
 * A normalised pointer at a repository. Produced by `parseRepoUrl`, which
 * accepts the shapes people actually paste:
 *
 *   https://github.com/o/r            git@github.com:o/r.git
 *   https://github.com/o/r.git        github.com/o/r
 *   https://github.com/o/r/tree/main/apps/web      (branch + subdir)
 *
 * `canonicalUrl` is always `https://<host>/<owner>/<repo>` with no `.git`, no
 * trailing slash and no branch/subdir — that is the form the deploy providers
 * want. Branch and subdir travel separately because each provider expresses
 * them differently (see `DEPLOY_PROVIDER_META`).
 */
export const repoRefSchema = z.object({
  host: repoHostSchema,
  owner: z
    .string()
    .min(1)
    .max(100)
    // Git hosts allow letters, digits, dot, dash, underscore. Anything else is
    // a paste artifact, not an owner.
    .regex(/^[A-Za-z0-9._-]+$/, 'Invalid repository owner.'),
  repo: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, 'Invalid repository name.'),
  /** Explicit branch if the URL named one (`/tree/<branch>`), else `null` →
   *  "use the host's default branch". Never invent `main`. */
  branch: z.string().min(1).max(200).nullable(),
  /** Subdirectory inside the repo (monorepo case), no leading/trailing slash. */
  subdir: z.string().max(300).nullable(),
  /** `https://<host>/<owner>/<repo>` — canonical, no `.git`, no trailing slash. */
  canonicalUrl: z.string().url(),
});
export type RepoRef = z.infer<typeof repoRefSchema>;

/* -------------------------------------------------------------------------- */
/* 2. The snapshot (the only impure step; behind the RepoSource seam)         */
/* -------------------------------------------------------------------------- */

export const repoEntrySchema = z.object({
  /** Path relative to the analysed root (repo root, or `subdir` if given). */
  path: z.string().min(1).max(400),
  type: z.enum(['file', 'dir']),
  /** Bytes, when the host reported it. */
  size: z.number().int().nonnegative().optional(),
});
export type RepoEntry = z.infer<typeof repoEntrySchema>;

/** Public repo metadata. Every field optional: a host may not report it, and a
 *  missing field must never fail the parse and kill an otherwise good analysis. */
export const repoMetaSchema = z.object({
  description: z.string().max(1000).nullable().optional(),
  primaryLanguage: z.string().max(60).nullable().optional(),
  topics: z.array(z.string().max(60)).max(30).optional(),
  pushedAt: z.string().optional(),
  isFork: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  sizeKb: z.number().int().nonnegative().optional(),
});
export type RepoMeta = z.infer<typeof repoMetaSchema>;

/**
 * Everything the pure detector is allowed to see. Deliberately a plain data
 * object with no methods and no network: `detectStack(snapshot)` is a pure
 * function, so the whole detection matrix is testable from fixtures and cannot
 * silently depend on a live repo.
 *
 * `files` holds the CONTENTS of the probe files that actually existed. We fetch
 * only what the root listing proves is there — the GitHub anonymous budget is
 * 60 requests/hour/IP (measured 2026-07-28 via `x-ratelimit-limit`), so blind
 * probing is not affordable.
 */
export const repoSnapshotSchema = z.object({
  ref: repoRefSchema,
  /** The host's default branch (e.g. `main`, `canary`). */
  defaultBranch: z.string().min(1).max(200),
  /** The branch we actually read: `ref.branch ?? defaultBranch`. */
  resolvedBranch: z.string().min(1).max(200),
  meta: repoMetaSchema,
  /** Listing of the analysed root, one level deep. */
  entries: z.array(repoEntrySchema).max(2000),
  /** path → file contents, for the probe files that existed. Truncated per
   *  `MAX_PROBE_FILE_BYTES`; detection must tolerate a truncated tail. */
  files: z.record(z.string(), z.string()),
  /** True when the host's tree response was truncated (huge monorepo). */
  entriesTruncated: z.boolean().default(false),
  fetchedAt: z.string().min(20),
});
export type RepoSnapshot = z.infer<typeof repoSnapshotSchema>;

/** Probe files are read head-first and capped; a 5 MB lockfile teaches us
 *  nothing a 64 KB prefix doesn't. */
export const MAX_PROBE_FILE_BYTES = 64 * 1024;

/** Hard cap on probe-file reads per analysis, so one paste cannot burn the
 *  anonymous GitHub budget. `raw.githubusercontent.com` is not part of the
 *  60/hr core budget, but a bounded fan-out is still the right posture. */
export const MAX_PROBE_FILES = 16;

/* -------------------------------------------------------------------------- */
/* 3. Detection                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A single cited observation. **This is the anti-fabrication device.** Nothing
 * may appear in a `StackDetection` unless at least one signal supports it, and
 * a signal cannot exist without a real `path` plus an `excerpt` copied verbatim
 * out of that file (or, for `kind: 'file-present'`, the file's own path).
 *
 * `implies` is the human-readable inference ("`next` in dependencies → Next.js"),
 * which is what the UI renders under "how we know".
 */
export const detectionSignalSchema = z.object({
  /** Stable id so tests and the UI can key on a signal, e.g. `dep:next`. */
  id: z.string().min(1).max(80),
  kind: z.enum([
    'file-present', // the existence of the file is the signal
    'dependency', // a package appears in a manifest
    'script', // a build/start script
    'file-content', // a substring inside a file
    'metadata', // host-reported metadata (language, topics)
  ]),
  /** Repo-relative path of the evidence. Never empty — an uncited signal is
   *  a fabricated signal. */
  path: z.string().min(1).max(400),
  /** Verbatim excerpt from `path` supporting the inference. For
   *  `file-present`, the path itself is acceptable evidence. */
  excerpt: z.string().min(1).max(300),
  implies: z.string().min(1).max(200),
  /** `strong` signals can decide the framework on their own; `weak` ones only
   *  corroborate. Confidence is derived from this, never asserted by hand. */
  weight: z.enum(['strong', 'weak']),
});
export type DetectionSignal = z.infer<typeof detectionSignalSchema>;

/** Build settings we can suggest to the provider's flow. All nullable: an
 *  unknown build command must render as "we couldn't tell", never as a guess. */
export const buildHintsSchema = z.object({
  installCommand: z.string().max(200).nullable(),
  buildCommand: z.string().max(200).nullable(),
  /** Publish/output directory for static output (`dist`, `out`, `build`, …). */
  outputDir: z.string().max(200).nullable(),
  /** Long-running start command, when the app needs a server. */
  startCommand: z.string().max(200).nullable(),
  nodeVersion: z.string().max(40).nullable(),
});
export type BuildHints = z.infer<typeof buildHintsSchema>;

/** Provider configs already committed in the repo — changes our advice, because
 *  an existing `render.yaml` means we must not tell the user to add one. */
export const existingConfigSchema = z.object({
  vercel: z.boolean(),
  netlify: z.boolean(),
  render: z.boolean(),
  dockerfile: z.boolean(),
});
export type ExistingConfig = z.infer<typeof existingConfigSchema>;

/**
 * The pure output of `detectStack(snapshot)`.
 *
 * Integrity rules enforced by zod (not prose — prose floors shipped broken in
 * Features 1 and 2):
 *   - A named framework (anything but `unknown`) REQUIRES at least one signal.
 *   - `confidence: 'unknown'` REQUIRES `framework: 'unknown'` and no needs —
 *     you cannot be certain about a stack you couldn't read.
 *   - `confidence: 'high'` REQUIRES at least one `strong` signal.
 */
export const stackDetectionSchema = z
  .object({
    framework: frameworkSchema,
    /** Version range as written in the manifest (`^15.2.0`), verbatim. */
    frameworkVersion: z.string().max(60).nullable(),
    runtime: runtimeSchema,
    appShape: appShapeSchema,
    packageManager: packageManagerSchema,
    needs: z.array(serviceNeedSchema).max(7),
    build: buildHintsSchema,
    existing: existingConfigSchema,
    /** A workspace/monorepo root (pnpm-workspace.yaml, workspaces field, …). */
    monorepo: z.boolean(),
    signals: z.array(detectionSignalSchema).max(60),
    confidence: detectionConfidenceSchema,
    /** Caveats the user must see: "couldn't read GitLab contents", "monorepo —
     *  pick the app directory", "no lockfile". */
    notes: z.array(z.string().max(300)).max(10),
  })
  .superRefine((d, ctx) => {
    if (d.framework !== 'unknown' && d.signals.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['signals'],
        message: `Detected framework "${d.framework}" with no supporting signal — every detection must cite a file.`,
      });
    }
    if (d.confidence === 'unknown') {
      if (d.framework !== 'unknown') {
        ctx.addIssue({
          code: 'custom',
          path: ['framework'],
          message: 'confidence "unknown" cannot name a framework.',
        });
      }
      if (d.needs.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['needs'],
          message: 'confidence "unknown" cannot assert service needs.',
        });
      }
    }
    if (d.confidence === 'high' && !d.signals.some((s) => s.weight === 'strong')) {
      ctx.addIssue({
        code: 'custom',
        path: ['confidence'],
        message: 'confidence "high" requires at least one strong signal.',
      });
    }
  });
export type StackDetection = z.infer<typeof stackDetectionSchema>;

/* -------------------------------------------------------------------------- */
/* 4. Provider fit                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How well one provider suits THIS app, with the reasoning shown to the user.
 *
 * `reasons` explains the verdict (min 1 — a verdict with no reason is a verdict
 * the user can't trust). `caveats` is what will bite them anyway. Both must
 * reference the detected stack or the PRD context, not generic marketing.
 */
export const providerFitSchema = z.object({
  provider: deployProviderSchema,
  verdict: fitVerdictSchema,
  /** 0–100, for ordering only. Never rendered as a precise number. */
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.string().min(1).max(300)).min(1).max(6),
  caveats: z.array(z.string().min(1).max(300)).max(6),
  /** The generated one-click URL into the provider's own flow. */
  deployUrl: z.string().url(),
  /** True when the button only works properly once the user commits the config
   *  artifact we generated (Render blueprints, notably). */
  requiresConfig: z.boolean(),
});
export type ProviderFit = z.infer<typeof providerFitSchema>;

/* -------------------------------------------------------------------------- */
/* 5. Generated config artifacts                                             */
/* -------------------------------------------------------------------------- */

/**
 * A file the user can copy or download into their own repo so the deploy button
 * actually works. We generate, we never commit — it is their repo.
 */
export const configArtifactSchema = z.object({
  provider: deployProviderSchema,
  /** Destination path in the user's repo, e.g. `render.yaml`. */
  filename: z.string().min(1).max(120),
  language: z.enum(['yaml', 'json', 'toml']),
  content: z.string().min(1).max(20_000),
  /** Why this file is needed, in one or two sentences. */
  why: z.string().min(1).max(400),
  /** `true` = the button will not work without it. */
  required: z.boolean(),
});
export type ConfigArtifact = z.infer<typeof configArtifactSchema>;

/* -------------------------------------------------------------------------- */
/* PRD context (optional — the feature must work from a bare URL too)         */
/* -------------------------------------------------------------------------- */

/**
 * The PRD slice Feature 3 needs, shaped exactly like Feature 2's `CostContext`
 * and for the same reason: PRDs live in `localStorage`, so the client POSTs the
 * slice rather than an id.
 *
 * It is OPTIONAL everywhere. A user who never used Feature 1 pastes a URL and
 * still gets a full answer; the PRD only sharpens it (budget → free-tier bias,
 * scale → serverless-vs-server, a `datastore` component → Render's managed DB).
 */
export const deployPrdContextSchema = z.object({
  title: z.string().min(1).max(120),
  context: briefContextSchema,
  components: z.array(architectureComponentSchema).min(1).max(40),
  infrastructure: infrastructureSchema.optional(),
  summary: z.string().max(1000).optional(),
});
export type DeployPrdContext = z.infer<typeof deployPrdContextSchema>;

/* -------------------------------------------------------------------------- */
/* The assembled plan                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What `POST /api/deploy/analyze` returns.
 *
 * `fits` carries **all three** providers, always — including the ones we advise
 * against, with the reason why. Hiding a provider would hide the reasoning, and
 * the reasoning is the product.
 *
 * `primary` is the single best fit, or `null` when detection was too weak to
 * name one honestly (the brief's "if detection is uncertain, say so and offer
 * all three with guidance").
 */
export const deployPlanSchema = z
  .object({
    repo: repoRefSchema,
    detection: stackDetectionSchema,
    fits: z.array(providerFitSchema).length(DEPLOY_PROVIDERS.length),
    primary: deployProviderSchema.nullable(),
    /** What we assumed where the repo/PRD was silent — first-class, exactly as
     *  `prd.assumptions` (F1) and `recommendation.assumptions` (F2). */
    assumptions: z.array(z.string().max(300)).max(10),
    configs: z.array(configArtifactSchema).max(6),
    /** True when the PRD context was supplied and influenced the fit. */
    usedPrdContext: z.boolean(),
    generatedAt: z.string().min(20),
  })
  .superRefine((plan, ctx) => {
    // One fit per provider, no duplicates, no strangers.
    const seen = new Set<string>();
    plan.fits.forEach((f, i) => {
      if (seen.has(f.provider)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fits', i, 'provider'],
          message: `Duplicate fit for provider "${f.provider}".`,
        });
      }
      seen.add(f.provider);
    });
    for (const p of DEPLOY_PROVIDERS) {
      if (!seen.has(p)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fits'],
          message: `Missing fit for provider "${p}" — all three are always reported.`,
        });
      }
    }
    // `primary` must be a provider we actually endorsed.
    if (plan.primary !== null) {
      const fit = plan.fits.find((f) => f.provider === plan.primary);
      if (fit && fit.verdict === 'not-recommended') {
        ctx.addIssue({
          code: 'custom',
          path: ['primary'],
          message: `primary "${plan.primary}" is marked not-recommended.`,
        });
      }
    }
    // An unreadable repo cannot yield a confident winner.
    if (plan.detection.confidence === 'unknown' && plan.primary !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['primary'],
        message:
          'Detection confidence is "unknown" — primary must be null and all three providers offered with guidance.',
      });
    }
    // Every generated config must belong to a provider in the plan.
    plan.configs.forEach((c, i) => {
      if (!seen.has(c.provider)) {
        ctx.addIssue({
          code: 'custom',
          path: ['configs', i, 'provider'],
          message: `Config for unknown provider "${c.provider}".`,
        });
      }
    });
  });
export type DeployPlan = z.infer<typeof deployPlanSchema>;

/* -------------------------------------------------------------------------- */
/* Provider table — the one place a deploy URL is defined                     */
/* -------------------------------------------------------------------------- */

/**
 * Provider metadata + the canonical one-click URL shape.
 *
 * **Verified against the providers' own docs on 2026-07-28** (do not "tidy"
 * these without re-reading the source):
 *
 * - Vercel  — https://vercel.com/docs/deploy-button/source
 *   `https://vercel.com/new/clone?repository-url=<url-encoded repo url>`
 *   `repository-url` is required; a subdirectory is expressed INSIDE the value
 *   as `/tree/<branch>/<subdir>`. Optional: `project-name`, `repository-name`.
 *
 * - Netlify — https://docs.netlify.com/deploy/create-deploys ("Deploy to Netlify button")
 *   `https://app.netlify.com/start/deploy?repository=<repo url>`
 *   Branch via `&branch=<branch>`; a subdirectory via `&create_from_path=<path>`
 *   (clone just that subdir) or `&base=<path>` (whole repo, build from subdir).
 *
 * - Render  — https://render.com/docs/deploy-to-render
 *   `https://render.com/deploy?repo=<repo url>`
 *   Branch by appending `/tree/<branch>` to the `repo` VALUE. Render reads a
 *   `render.yaml` blueprint from the repo, and its docs explicitly recommend
 *   `autoDeploy: false` for blueprints deployed via the button.
 */
export const DEPLOY_PROVIDER_META: Record<
  DeployProvider,
  {
    /** Display name. */
    label: string;
    /** Base URL of the provider's hosted flow — no query string. */
    deployBase: string;
    /** Query parameter carrying the repo URL. */
    repoParam: 'repository-url' | 'repository' | 'repo';
    /** How a branch is expressed. `path-suffix` = append `/tree/<branch>` to
     *  the repo value; `query` = a separate query parameter. */
    branchMode: 'path-suffix' | 'query';
    /** Query parameter name when `branchMode === 'query'`. */
    branchParam?: string;
    /** How a monorepo subdirectory is expressed. */
    subdirMode: 'path-suffix' | 'query' | 'unsupported';
    subdirParam?: string;
    /** Where the above was verified. Cited in code per the project's real-data rule. */
    docsUrl: string;
    /** The provider's own button image (their CDN, hotlinking is the documented
     *  usage). Used in generated markdown snippets. */
    buttonImageUrl: string;
    /** Config file the provider reads from the repo, if any. */
    configFile: string | null;
  }
> = {
  vercel: {
    label: 'Vercel',
    deployBase: 'https://vercel.com/new/clone',
    repoParam: 'repository-url',
    branchMode: 'path-suffix',
    subdirMode: 'path-suffix',
    docsUrl: 'https://vercel.com/docs/deploy-button/source',
    buttonImageUrl: 'https://vercel.com/button',
    configFile: 'vercel.json',
  },
  netlify: {
    label: 'Netlify',
    deployBase: 'https://app.netlify.com/start/deploy',
    repoParam: 'repository',
    branchMode: 'query',
    branchParam: 'branch',
    subdirMode: 'query',
    subdirParam: 'base',
    docsUrl: 'https://docs.netlify.com/deploy/create-deploys',
    buttonImageUrl: 'https://www.netlify.com/img/deploy/button.svg',
    configFile: 'netlify.toml',
  },
  render: {
    label: 'Render',
    deployBase: 'https://render.com/deploy',
    repoParam: 'repo',
    branchMode: 'path-suffix',
    subdirMode: 'unsupported', // expressed inside render.yaml (`rootDir`), not the URL
    docsUrl: 'https://render.com/docs/deploy-to-render',
    buttonImageUrl: 'https://render.com/images/deploy-to-render-button.svg',
    configFile: 'render.yaml',
  },
};

/* -------------------------------------------------------------------------- */
/* API envelopes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/deploy/analyze`
 *
 * `repoUrl` is whatever the user pasted — unnormalised. The server parses it;
 * the client must NOT try to canonicalise first, so that one parser (and one
 * set of error messages) is authoritative.
 */
export const analyzeRequestSchema = z.object({
  repoUrl: z.string().min(5).max(400),
  prdContext: deployPrdContextSchema.optional(),
});
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;

export const analyzeResponseSchema = z.object({
  plan: deployPlanSchema,
});
export type AnalyzeResponse = z.infer<typeof analyzeResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Versioning                                                                 */
/* -------------------------------------------------------------------------- */

/** Bumped when the detection matrix or fit weights change materially. Cached
 *  snapshots/plans written by an older version are discarded, not trusted. */
export const DETECTION_VERSION = '1.0.0';
