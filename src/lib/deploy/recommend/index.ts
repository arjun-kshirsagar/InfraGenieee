/**
 * InfraGenie — Feature 3, the PURE provider-fit engine (task B5, docs §6).
 *
 * `recommendProviders(detection, ref, options)` turns a `StackDetection` (plus an
 * optional PRD slice) into exactly three `ProviderFit`s — one per provider,
 * ALWAYS, including the ones we advise against — and names a `primary`, or `null`
 * when detection was too weak to crown one honestly.
 *
 * ## Why this is not an LLM
 *
 * Provider fit is a small, stable, explainable rule set. The mapping from
 * "Next.js SSR + a Postgres need" to "Vercel is first-party but you'd add an
 * external DB; Render bundles a managed one" does not vary between runs, so a
 * model would only add latency and non-determinism to a decision we can write
 * down. (Contrast Feature 2, where the model reasons about *sizing*, which
 * genuinely varies.) The architect made this call in docs §6; do not reintroduce
 * an LLM here.
 *
 * ## Purity
 *
 * No `Date`, no network, no randomness. Same `(detection, ref, options)` in →
 * deep-equal output. The `deployUrl` on each fit comes from `buildDeployUrl`,
 * which is itself pure and table-driven off `DEPLOY_PROVIDER_META` — we never
 * hand-build a URL here.
 *
 * ## The scoring model (docs §6 fit table, made concrete)
 *
 * Each provider starts from a BASE score keyed on the app's shape/runtime, then
 * `needs` and PRD context ADJUST it. The score is used ONLY for ordering (the
 * schema caps it 0–100 and says "never rendered as a precise number"); the
 * verdict — recommended / possible / not-recommended — is what the user sees,
 * and it is derived from the score via fixed thresholds so the two never drift.
 *
 * The reasoning is the product: every fit carries ≥1 `reason` that references
 * THIS app's detected stack or PRD context, and `caveats` carry the truths that
 * cost the user money (Vercel has no managed Postgres; Render web services never
 * scale to zero on the paid tier; …).
 */

import {
  DEPLOY_PROVIDERS,
  providerFitSchema,
  type DeployPrdContext,
  type DeployProvider,
  type ProviderFit,
  type RepoRef,
  type ServiceNeed,
  type StackDetection,
} from '@/types/deploy';
import { buildDeployUrl } from '@/lib/deploy/deploy-url';
import { renderBlueprintHasPlaceholders } from '@/lib/deploy/generate/render-yaml';

/* -------------------------------------------------------------------------- */
/* Public result shape                                                        */
/* -------------------------------------------------------------------------- */

export interface RecommendOptions {
  /** The PRD slice, when the user planned this app in Feature 1. Optional —
   *  a bare URL still gets a full answer; the PRD only sharpens it. */
  prdContext?: DeployPrdContext;
  /** The repo's default branch, forwarded to `buildDeployUrl` so a subdirectory
   *  URL gets a real branch anchor instead of a guessed `main`. */
  defaultBranch?: string;
}

export interface RecommendResult {
  /** Exactly three, sorted by score descending; ties broken by canonical
   *  `DEPLOY_PROVIDERS` order so the output is deterministic. */
  fits: ProviderFit[];
  /** The single best fit, or `null` when confidence is `unknown`. */
  primary: DeployProvider | null;
  /** Everything we decided that the user did not tell us — first-class, exactly
   *  as `prd.assumptions` (F1) and `recommendation.assumptions` (F2). */
  assumptions: string[];
  /** True only when the PRD context actually changed a verdict, score, reason
   *  or caveat. `false` when no context was passed. */
  usedPrdContext: boolean;
  /**
   * The needs the reasoning actually reasoned from: `detection.needs` plus any
   * PRD-supplied ones (docs §6 `foldPrdNeeds`). This is what the Render config
   * gate and the fit reasoning use, so the caller MUST feed the SAME set to
   * `generateConfigs` — otherwise the Render card can promise a managed Postgres
   * the blueprint omits (F3 BLOCKER-3). Never larger than the repo's needs at
   * `unknown` confidence, where the schema forbids needs and `foldPrdNeeds`
   * skips the PRD entirely — so `effectiveNeeds` is `[]` there too.
   */
  effectiveNeeds: ServiceNeed[];
}

/* -------------------------------------------------------------------------- */
/* Score → verdict thresholds                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Verdict is DERIVED from score so a hand-set verdict can never contradict the
 * ordering the user sees. `unknown` confidence is the one exception: docs §6
 * forces all three to `possible` regardless of score.
 */
const RECOMMENDED_AT = 70;
const POSSIBLE_AT = 40;

function verdictFor(score: number): ProviderFit['verdict'] {
  if (score >= RECOMMENDED_AT) return 'recommended';
  if (score >= POSSIBLE_AT) return 'possible';
  return 'not-recommended';
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* -------------------------------------------------------------------------- */
/* A mutable working fit, collapsed to a ProviderFit at the end               */
/* -------------------------------------------------------------------------- */

interface Draft {
  provider: DeployProvider;
  score: number;
  reasons: string[];
  caveats: string[];
  requiresConfig: boolean;
}

function newDraft(provider: DeployProvider, score: number): Draft {
  return { provider, score, reasons: [], caveats: [], requiresConfig: false };
}

/** Push a reason once (dedupe keeps the output stable and within the 6 cap). */
function addReason(d: Draft, reason: string): void {
  if (!d.reasons.includes(reason)) d.reasons.push(reason);
}
function addCaveat(d: Draft, caveat: string): void {
  if (!d.caveats.includes(caveat)) d.caveats.push(caveat);
}

/* -------------------------------------------------------------------------- */
/* Base scoring: shape + runtime (docs §6 rows 1–8)                           */
/* -------------------------------------------------------------------------- */

const SERVER_NEEDS: readonly ServiceNeed[] = [
  'background-worker',
  'cron',
  'websockets',
] as const;
const DATA_NEEDS: readonly ServiceNeed[] = ['database', 'cache', 'queue'] as const;

/**
 * The base scores encode the §6 table's shape/runtime rows. They are chosen so
 * the DERIVED verdict matches the table cell-for-cell:
 *
 *   ≥70 → recommended, 40–69 → possible, <40 → not-recommended.
 */
function scoreShape(
  detection: StackDetection,
  drafts: Record<DeployProvider, Draft>,
): void {
  const { framework, appShape, runtime } = detection;
  const v = drafts.vercel;
  const n = drafts.netlify;
  const r = drafts.render;

  // runtime: docker → Render only (row 7); a non-Node server → Render (row 8).
  if (runtime === 'docker') {
    v.score = 15;
    n.score = 15;
    r.score = 90;
    addReason(
      r,
      'Your repo ships a Dockerfile, and Render builds and runs Docker images directly — the closest match of the three.',
    );
    addReason(
      v,
      'Vercel deploys framework builds and serverless functions, not a long-running container from your Dockerfile.',
    );
    addReason(
      n,
      'Netlify deploys static output and functions, not a long-running container from your Dockerfile.',
    );
    return;
  }

  switch (appShape) {
    case 'static': {
      // Row 1: static → Vercel + Netlify recommended, Render possible.
      v.score = 85;
      n.score = 88;
      r.score = 50;
      addReason(
        v,
        `We detected a static site${framework !== 'unknown' && framework !== 'other' ? ` (${framework})` : ''}; Vercel serves static output on a global CDN with zero server to run.`,
      );
      addReason(
        n,
        `We detected a static site${framework !== 'unknown' && framework !== 'other' ? ` (${framework})` : ''}; Netlify is purpose-built for static/JAMstack hosting and edge delivery.`,
      );
      addReason(
        r,
        'Render can host a static site, but the two CDN-first hosts are a more natural fit for prebuilt output.',
      );
      return;
    }
    case 'ssr': {
      if (framework === 'nextjs') {
        // Row 2: Next.js SSR → Vercel recommended (first-party), others possible.
        v.score = 95;
        n.score = 55;
        r.score = 50;
        addReason(
          v,
          'Vercel is the first-party host for Next.js, which we detected in your package.json — SSR, ISR, image optimisation and edge functions work with no adapter.',
        );
        addReason(
          n,
          'Netlify runs Next.js through its Next runtime/adapter; it works but is a step behind first-party support.',
        );
        addReason(
          r,
          'Render can run Next.js as a Node web service, but you manage the server yourself instead of the framework-native serverless deploy.',
        );
      } else {
        // Row 3: Nuxt/SvelteKit/Remix/Astro-SSR → Vercel + Netlify recommended.
        v.score = 82;
        n.score = 80;
        r.score = 52;
        addReason(
          v,
          `We detected an SSR framework${framework !== 'unknown' && framework !== 'other' ? ` (${framework})` : ''}; Vercel has a first-class serverless adapter for it.`,
        );
        addReason(
          n,
          `We detected an SSR framework${framework !== 'unknown' && framework !== 'other' ? ` (${framework})` : ''}; Netlify ships an adapter/plugin for it and hosts the serverless output well.`,
        );
        addReason(
          r,
          'Render can run the SSR server as a Node web service, but a serverless host matches the framework more naturally when there is no long-lived state.',
        );
      }
      return;
    }
    case 'fullstack':
    case 'api-only': {
      // Row 4: long-lived server → Render recommended, Vercel/Netlify not.
      v.score = 30;
      n.score = 25;
      r.score = 88;
      const shapeWord = appShape === 'api-only' ? 'an API/back-end service' : 'a full-stack app with its own server';
      addReason(
        r,
        `We detected ${shapeWord}${runtime !== 'node' && runtime !== 'unknown' ? ` on ${runtime}` : ''}; Render runs a long-lived web service, which is what this shape needs.`,
      );
      addReason(
        v,
        'Vercel runs serverless functions, not a persistent server process, so a long-lived back-end does not map cleanly onto it.',
      );
      addReason(
        n,
        'Netlify runs functions, not a persistent server process, so a long-lived back-end does not map cleanly onto it.',
      );
      if (runtime !== 'node' && runtime !== 'unknown' && runtime !== 'static') {
        addReason(
          r,
          `Your runtime is ${runtime}; Render supports native ${runtime} services, whereas Vercel/Netlify functions are JavaScript/edge-first.`,
        );
      }
      return;
    }
    case 'unknown':
    default: {
      // No readable shape. Neutral middle; confidence gate below handles the
      // `unknown` case entirely. Give a low-but-nonzero base so all three read
      // as `possible` when confidence is low (a nameable framework we couldn't
      // shape) rather than three not-recommended.
      v.score = 50;
      n.score = 50;
      r.score = 50;
      addReason(v, 'We could not determine the app shape confidently, so Vercel is offered as one option.');
      addReason(n, 'We could not determine the app shape confidently, so Netlify is offered as one option.');
      addReason(r, 'We could not determine the app shape confidently, so Render is offered as one option.');
      return;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Needs adjustments (docs §6 rows 5–6)                                       */
/* -------------------------------------------------------------------------- */

function applyNeeds(
  needs: readonly ServiceNeed[],
  drafts: Record<DeployProvider, Draft>,
  fromPrd: Set<ServiceNeed>,
): void {
  const v = drafts.vercel;
  const n = drafts.netlify;
  const r = drafts.render;

  const dataNeeds = DATA_NEEDS.filter((x) => needs.includes(x));
  const serverNeeds = SERVER_NEEDS.filter((x) => needs.includes(x));

  // Row 5: database / cache / queue → Render recommended (managed), others
  // possible + a "separate bill" caveat.
  if (dataNeeds.length > 0) {
    const list = dataNeeds.join(', ');
    const src = dataNeeds.every((x) => fromPrd.has(x))
      ? ' (from your PRD, not the repo)'
      : '';
    r.score += 8;
    addReason(
      r,
      `This app needs ${list}${src}; Render offers managed Postgres and Redis alongside the service, so it can host all of it.`,
    );
    if (dataNeeds.includes('database')) {
      addCaveat(
        v,
        'Vercel has no managed relational database — you would add an external one (Neon, Supabase, PlanetScale), which is a separate account and a separate bill.',
      );
      addCaveat(
        n,
        'Netlify has no managed relational database — you would add an external one (Neon, Supabase, PlanetScale), a separate account and a separate bill.',
      );
    }
    if (dataNeeds.includes('cache') || dataNeeds.includes('queue')) {
      addCaveat(
        v,
        'A cache/queue means an external service (Upstash, Redis Cloud) wired in from Vercel — another vendor to manage and pay.',
      );
      addCaveat(
        n,
        'A cache/queue means an external service (Upstash, Redis Cloud) wired in from Netlify — another vendor to manage and pay.',
      );
    }
    // Vercel/Netlify stay usable for the app tier, just with the caveat.
    addReason(v, `You can still deploy the app on Vercel and connect an external ${list} — see the caveat.`);
    addReason(n, `You can still deploy the app on Netlify and connect an external ${list} — see the caveat.`);
  }

  // Row 6: background-worker / cron / websockets → Render recommended, the
  // serverless hosts not-recommended for that part of the workload.
  if (serverNeeds.length > 0) {
    const list = serverNeeds.join(', ');
    const src = serverNeeds.every((x) => fromPrd.has(x)) ? ' (from your PRD, not the repo)' : '';
    r.score += 12;
    v.score -= 25;
    n.score -= 25;
    addReason(
      r,
      `This app needs ${list}${src}; Render runs persistent background workers, cron jobs and WebSocket servers, which serverless functions cannot hold open.`,
    );
    const kill =
      'Serverless functions are short-lived and stateless, so a background worker, a WebSocket server or a real cron process does not run on it as-is.';
    addReason(v, kill);
    addReason(n, kill);
  }
}

/* -------------------------------------------------------------------------- */
/* Existing-config → requiresConfig (docs §6 + §7)                            */
/* -------------------------------------------------------------------------- */

/**
 * The Render button reads `render.yaml` from the repo. A full-stack / API / any
 * service-need app therefore needs the blueprint committed FIRST, so the button
 * `requiresConfig` unless the repo already has one.
 */
function applyRenderConfigGate(detection: StackDetection, r: Draft): void {
  const needsBlueprint =
    detection.appShape === 'fullstack' ||
    detection.appShape === 'api-only' ||
    detection.needs.length > 0 ||
    detection.runtime === 'docker';

  // MAJOR-3: a static site ALSO gets a render.yaml generated (a `type: web` +
  // `runtime: static` service), and its buildCommand/staticPublishPath can be a
  // placeholder we couldn't detect (jekyll/minima: a Ruby site with no npm
  // scripts). Such a site is NOT a `needsBlueprint` case — Render's static
  // button works from the dashboard without a committed blueprint, so we must
  // NOT flip `requiresConfig` or tell the user to commit the file. But we DO owe
  // them the warning that the blueprint we generated is incomplete, so it lands
  // whether or not `needsBlueprint` is true. `existing.render` short-circuits
  // both paths — we never comment on a file the user already has.
  const isStatic = detection.appShape === 'static' || detection.runtime === 'static';
  const emitsBlueprint = needsBlueprint || isStatic;
  const hasPlaceholders = emitsBlueprint && renderBlueprintHasPlaceholders(detection);

  if (!needsBlueprint) {
    // Static (or otherwise no-blueprint) path: leave `requiresConfig` alone, but
    // still warn if the generated blueprint carries # TODO placeholders.
    if (hasPlaceholders && !detection.existing.render) {
      addCaveat(r, PLACEHOLDER_CAVEAT);
    }
    return;
  }

  if (detection.existing.render) {
    r.requiresConfig = false;
    addReason(
      r,
      'Your repo already contains a render.yaml, so the Render button works as-is — we will not tell you to add one.',
    );
  } else {
    r.requiresConfig = true;
    addCaveat(
      r,
      'Render reads a render.yaml blueprint from your repo; commit the one we generate before using the button, or the deploy will not be configured correctly.',
    );
    // When we couldn't detect a build/start command, the blueprint we generate
    // carries placeholder (# TODO) values. Surface that HERE — the caveat renders
    // BEFORE the deploy button — so the user is warned they must fill it in
    // first, rather than committing-and-clicking an incomplete file that
    // "succeeds" and serves an empty site. Uses the same predicate the generator
    // uses to flip the artifact's `required` flag, so the two agree.
    if (hasPlaceholders) {
      addCaveat(r, PLACEHOLDER_CAVEAT);
    }
  }
}

/** The MAJOR-3 warning: the generated blueprint has # TODO placeholders the
 *  user must fill in before the deploy actually builds anything. Rendered as a
 *  caveat, which the fit card shows ABOVE the deploy button. Kept ≤300 chars. */
const PLACEHOLDER_CAVEAT =
  "We couldn't detect your build/start command, so the generated render.yaml has placeholder values marked # TODO — fill those in before you deploy, or the button will build nothing and serve an empty site.";

/* -------------------------------------------------------------------------- */
/* PRD sharpening (docs §6) — sharpens, never overrides a file signal         */
/* -------------------------------------------------------------------------- */

/** Map a PRD architecture-component `kind` onto the `ServiceNeed` it corroborates. */
function needForComponentKind(kind: string): ServiceNeed | null {
  switch (kind) {
    case 'datastore':
      return 'database';
    case 'cache':
      return 'cache';
    case 'queue':
      return 'queue';
    default:
      return null;
  }
}

interface PrdOutcome {
  usedPrdContext: boolean;
  assumptions: string[];
  /** Needs the PRD SUPPLIED that the repo did not already assert. */
  suppliedNeeds: Set<ServiceNeed>;
  /** All needs after folding in PRD-supplied ones. */
  effectiveNeeds: ServiceNeed[];
}

/**
 * Fold PRD context into the needs set BEFORE base+needs scoring, and stage the
 * budget/scale adjustments to run AFTER (they nudge scores, they never rename a
 * shape a file signal decided). Returns what changed so callers can set
 * `usedPrdContext` and record `assumptions` honestly.
 */
function foldPrdNeeds(detection: StackDetection, prd: DeployPrdContext | undefined): PrdOutcome {
  const out: PrdOutcome = {
    usedPrdContext: false,
    assumptions: [],
    suppliedNeeds: new Set(),
    effectiveNeeds: [...detection.needs],
  };
  if (!prd) return out;

  // A datastore/cache/queue component can SUPPLY a need when the repo was quiet
  // (docs §6). It can only ADD, never remove — the repo is authoritative.
  // Skipped entirely at `unknown` confidence, where the schema forbids needs.
  if (detection.confidence !== 'unknown') {
    for (const comp of prd.components) {
      const need = needForComponentKind(comp.kind);
      if (!need) continue;
      if (!out.effectiveNeeds.includes(need)) {
        out.effectiveNeeds.push(need);
        out.suppliedNeeds.add(need);
        out.usedPrdContext = true;
        out.assumptions.push(
          `Your repo didn't clearly show a ${need}, but your PRD lists a ${comp.kind} component ("${comp.name}"), so we assumed a ${need} is needed. This came from the PRD, not the code.`,
        );
      }
    }
  }

  return out;
}

/**
 * Budget/scale sharpening — runs after scoring, adjusts scores + adds caveats,
 * but is CLAMPED so it can never flip a verdict a strong file signal decided.
 * Returns whether it changed anything and any assumptions it introduced.
 */
function applyPrdBudgetAndScale(
  detection: StackDetection,
  prd: DeployPrdContext,
  drafts: Record<DeployProvider, Draft>,
  effectiveNeeds: readonly ServiceNeed[],
): { changed: boolean; assumptions: string[] } {
  let changed = false;
  const assumptions: string[] = [];
  const v = drafts.vercel;
  const n = drafts.netlify;
  const r = drafts.render;

  const band = prd.context.budgetBand;
  const scale = prd.context.userScale;
  const traffic = prd.context.trafficPattern;

  // Budget band: free-tier / hobby → bias toward the workable free tier for
  // this shape, and add the caveat where a managed DB breaks it.
  if (band === 'free-tier' || band === 'hobby') {
    changed = true;
    const isServerless =
      detection.appShape === 'static' || detection.appShape === 'ssr';
    if (isServerless && detection.runtime !== 'docker') {
      // Static/SSR on a $0/hobby budget → the CDN hosts' free tiers shine.
      v.score += 3;
      n.score += 3;
      addReason(
        v,
        `Your PRD budget is "${band}"; Vercel's Hobby tier hosts a static/SSR site like this at no cost for personal, non-commercial use.`,
      );
      addReason(
        n,
        `Your PRD budget is "${band}"; Netlify's free tier covers a static/SSR site like this within its build-minute and bandwidth limits.`,
      );
      assumptions.push(
        `Because your PRD budget band is "${band}", we favoured hosts with a workable free tier for a static/SSR app.`,
      );
    } else {
      // A server/DB app on a $0 budget: name the honest limit rather than
      // pretend it's free.
      addCaveat(
        r,
        `Your PRD budget is "${band}", but a persistent web service plus a managed database on Render is not free — expect a small monthly floor once you leave the free instance's limits (which sleep on inactivity).`,
      );
      assumptions.push(
        `Your PRD budget band is "${band}", but this app needs a persistent server; we flagged that a free tier will not cover it long-term.`,
      );
    }
    if (effectiveNeeds.includes('database')) {
      addCaveat(
        v,
        `On a "${band}" budget, note the external database (Neon/Supabase free tier) has its own row-count and sleep limits that a growing app outgrows.`,
      );
      addCaveat(
        n,
        `On a "${band}" budget, note the external database (Neon/Supabase free tier) has its own row-count and sleep limits that a growing app outgrows.`,
      );
    }
  }

  // Scale + spiky traffic: favour serverless/edge for static/ssr; note
  // instance sizing / cold starts for Render.
  if (
    (scale === 'large' || scale === 'very-large') &&
    (detection.appShape === 'static' || detection.appShape === 'ssr')
  ) {
    changed = true;
    v.score += 4;
    n.score += 4;
    addReason(
      v,
      `Your PRD expects "${scale}" scale${traffic === 'spiky' ? ' with spiky traffic' : ''}; Vercel's serverless/edge model absorbs bursts by scaling per-request, with no instance to size.`,
    );
    if (traffic === 'spiky') {
      addCaveat(
        r,
        'For spiky, large-scale traffic on Render you would size and autoscale instances yourself, and cold starts apply when scaling from zero — the serverless hosts handle bursts more transparently.',
      );
    }
    assumptions.push(
      `Because your PRD expects "${scale}" scale${traffic === 'spiky' ? ' with spiky traffic' : ''}, we favoured serverless/edge hosting for this static/SSR app.`,
    );
  } else if (
    (scale === 'large' || scale === 'very-large') &&
    (detection.appShape === 'fullstack' || detection.appShape === 'api-only')
  ) {
    changed = true;
    addCaveat(
      r,
      `Your PRD expects "${scale}" scale; on Render you will need to size the web service instance and enable autoscaling deliberately — plan for it in the cost estimate.`,
    );
    assumptions.push(
      `Because your PRD expects "${scale}" scale for a server app, we noted explicit instance sizing/autoscaling on Render.`,
    );
  }

  return { changed, assumptions };
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                 */
/* -------------------------------------------------------------------------- */

export function recommendProviders(
  detection: StackDetection,
  ref: RepoRef,
  options: RecommendOptions = {},
): RecommendResult {
  const { prdContext, defaultBranch } = options;

  const drafts: Record<DeployProvider, Draft> = {
    vercel: newDraft('vercel', 0),
    netlify: newDraft('netlify', 0),
    render: newDraft('render', 0),
  };

  const assumptions: string[] = [];

  /* ---- unknown confidence: docs §6 forces all three `possible`, primary null ---- */
  if (detection.confidence === 'unknown') {
    for (const provider of DEPLOY_PROVIDERS) {
      const d = drafts[provider];
      d.score = 50;
      addReason(
        d,
        `We could not read this repository's contents (${detection.notes[0] ? 'see the note in the analysis' : 'unreadable host or empty repo'}), so we cannot say ${provider} fits better than the others — all three are offered with guidance.`,
      );
    }
    assumptions.push(
      'Detection confidence is "unknown", so no provider is crowned; try a public GitHub URL for a specific recommendation.',
    );
    const fits = DEPLOY_PROVIDERS.map((p) =>
      collapse(drafts[p], ref, defaultBranch, /* forceVerdict */ 'possible'),
    );
    return {
      fits: sortFits(fits),
      primary: null,
      assumptions: capAssumptions(assumptions),
      usedPrdContext: false,
      // Unknown confidence: the schema forbids needs and `foldPrdNeeds` was never
      // consulted, so there is nothing effective to surface.
      effectiveNeeds: [],
    };
  }

  /* ---- 1. base score from shape/runtime ---- */
  scoreShape(detection, drafts);

  /* ---- 2. PRD supplies needs before the needs pass (repo stays authoritative) ---- */
  const prdNeeds = foldPrdNeeds(detection, prdContext);
  let usedPrdContext = prdNeeds.usedPrdContext;
  for (const a of prdNeeds.assumptions) assumptions.push(a);

  /* ---- 3. needs adjustments ---- */
  applyNeeds(prdNeeds.effectiveNeeds, drafts, prdNeeds.suppliedNeeds);

  /* ---- 4. Render blueprint gate (requiresConfig) ---- */
  // Base it on the EFFECTIVE needs so a PRD-supplied database still requires a blueprint.
  applyRenderConfigGate(
    { ...detection, needs: prdNeeds.effectiveNeeds },
    drafts.render,
  );

  /* ---- 5. PRD budget/scale sharpening (clamped: never flips a file verdict) ---- */
  if (prdContext) {
    const before = snapshotVerdicts(drafts);
    const { changed, assumptions: budgetAssumptions } = applyPrdBudgetAndScale(
      detection,
      prdContext,
      drafts,
      prdNeeds.effectiveNeeds,
    );
    if (changed) {
      usedPrdContext = true;
      for (const a of budgetAssumptions) assumptions.push(a);
    }
    // Guard the invariant: a PRD nudge must not flip a verdict that base+needs
    // (i.e. the file signals) decided. If it did, pull the score back to the
    // threshold boundary so the verdict is preserved. This is the concrete
    // encoding of "PRD sharpens, never overrides a file signal".
    clampVerdictsTo(before, drafts);
  }

  /* ---- 6. clamp scores, collapse, order ---- */
  const fits = DEPLOY_PROVIDERS.map((p) => collapse(drafts[p], ref, defaultBranch));

  const ordered = sortFits(fits);

  // primary = the top fit IF it is recommended (never crown a `possible`/`not`).
  const top = ordered[0];
  const primary = top && top.verdict === 'recommended' ? top.provider : null;
  if (primary === null) {
    assumptions.push(
      'No single provider was a strong enough fit to crown as primary; the top options are offered with their trade-offs.',
    );
  }

  return {
    fits: ordered,
    primary,
    assumptions: capAssumptions(assumptions),
    usedPrdContext: prdContext ? usedPrdContext : false,
    // Surface the SAME needs the reasoning and the Render config gate used, so
    // the caller can feed an effective-needs detection to `generateConfigs` and
    // the blueprint can never disagree with the card (F3 BLOCKER-3).
    effectiveNeeds: prdNeeds.effectiveNeeds,
  };
}

/* -------------------------------------------------------------------------- */
/* Collapse / order / cap helpers                                             */
/* -------------------------------------------------------------------------- */

/** A guaranteed reason so the schema's `min(1)` never trips, even in a corner. */
function ensureReason(d: Draft): void {
  if (d.reasons.length === 0) {
    addReason(
      d,
      `${d.provider} is offered as an option for this repository based on the detected stack.`,
    );
  }
}

function collapse(
  d: Draft,
  ref: RepoRef,
  defaultBranch: string | undefined,
  forceVerdict?: ProviderFit['verdict'],
): ProviderFit {
  ensureReason(d);
  const score = clampScore(d.score);
  const fit: ProviderFit = {
    provider: d.provider,
    verdict: forceVerdict ?? verdictFor(score),
    score,
    reasons: d.reasons.slice(0, 6),
    caveats: d.caveats.slice(0, 6),
    deployUrl: buildDeployUrl(ref, d.provider, { defaultBranch }),
    requiresConfig: d.requiresConfig,
  };
  // Fail loud in dev if we ever emit an invalid fit — the schema is the contract.
  return providerFitSchema.parse(fit);
}

/** Sort by score desc; ties broken by canonical `DEPLOY_PROVIDERS` order. */
function sortFits(fits: ProviderFit[]): ProviderFit[] {
  const order = new Map<DeployProvider, number>(DEPLOY_PROVIDERS.map((p, i) => [p, i]));
  return [...fits].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0);
  });
}

function capAssumptions(assumptions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of assumptions) {
    const trimmed = a.length > 300 ? a.slice(0, 300) : a;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 10) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Verdict-preservation guard for PRD sharpening                              */
/* -------------------------------------------------------------------------- */

function snapshotVerdicts(
  drafts: Record<DeployProvider, Draft>,
): Record<DeployProvider, ProviderFit['verdict']> {
  return {
    vercel: verdictFor(clampScore(drafts.vercel.score)),
    netlify: verdictFor(clampScore(drafts.netlify.score)),
    render: verdictFor(clampScore(drafts.render.score)),
  };
}

/**
 * Ensure the post-PRD score still yields the same verdict the file signals
 * produced. If a nudge crossed a threshold, pull the score to the nearest point
 * INSIDE the original verdict's band. Small nudges (a few points) never trigger
 * this; it exists purely as a hard guarantee behind the "sharpen, never
 * override" rule so no future weight tweak can silently violate it.
 */
function clampVerdictsTo(
  before: Record<DeployProvider, ProviderFit['verdict']>,
  drafts: Record<DeployProvider, Draft>,
): void {
  for (const provider of DEPLOY_PROVIDERS) {
    const d = drafts[provider];
    const want = before[provider];
    const nowScore = clampScore(d.score);
    if (verdictFor(nowScore) === want) continue;
    // Snap into the target band.
    if (want === 'recommended') d.score = Math.max(d.score, RECOMMENDED_AT);
    else if (want === 'not-recommended') d.score = Math.min(d.score, POSSIBLE_AT - 1);
    else {
      // possible: keep within [POSSIBLE_AT, RECOMMENDED_AT - 1]
      d.score = Math.min(Math.max(d.score, POSSIBLE_AT), RECOMMENDED_AT - 1);
    }
  }
}
