/**
 * InfraGenie — deterministic infrastructure recommender (Feature 1, backend).
 *
 * Pure function: same `QuestionnaireAnswers` in → same recommendation out.
 * No `Date.now()`, no `Math.random()`, no network, no I/O. Determinism is
 * contract guarantee #1 (docs/api-contracts.md) and is unit-tested.
 *
 * This module ONLY chooses infrastructure. It deliberately invents no dollar
 * figures — cost estimation is Feature 2's job and requires sourced pricing.
 *
 * Owned by: backend. Consumes the architect-owned contract in `@/types/prd`.
 */

import type {
  ArchitectureSection,
  QuestionnaireAnswers,
} from '@/types/prd';

type Infrastructure = ArchitectureSection['infrastructure'];

/**
 * Candidate hosting choice with the human-readable technology string we emit
 * and the free-text tokens a user might have typed into `stack.mustAvoid`.
 * `mustAvoid` is free text, so we match on any of these substrings.
 */
interface HostingCandidate {
  /** The `infrastructure.hosting` string we emit if this candidate wins. */
  tech: string;
  /** Lowercase tokens that mean "the user is avoiding this candidate". */
  avoidTokens: string[];
}

/**
 * Hosting candidates ordered best→worst per tier, so if the top pick collides
 * with a `mustAvoid` entry we can deterministically fall through to the next.
 * Only used when `stack.hosting === 'no-preference'`.
 */
const HOSTING_TIERS = {
  /** prototype/small + free-tier/hobby. */
  entry: [
    { tech: 'Vercel Hobby', avoidTokens: ['vercel'] },
    { tech: 'Render (free/starter)', avoidTokens: ['render'] },
    { tech: 'Fly.io (shared-cpu)', avoidTokens: ['fly.io', 'fly-io', 'fly'] },
    { tech: 'Cloudflare Pages', avoidTokens: ['cloudflare'] },
  ],
  /** medium + startup/growth. */
  mid: [
    { tech: 'Vercel Pro', avoidTokens: ['vercel'] },
    { tech: 'Render (standard)', avoidTokens: ['render'] },
    { tech: 'Fly.io (dedicated)', avoidTokens: ['fly.io', 'fly-io', 'fly'] },
    { tech: 'AWS (ECS/Fargate + RDS + CloudFront)', avoidTokens: ['aws', 'ecs', 'fargate', 'rds', 'cloudfront'] },
  ],
  /** large/very-large, aggressive growth, or enterprise budget. */
  scale: [
    { tech: 'AWS (ECS/Fargate + RDS + CloudFront)', avoidTokens: ['aws', 'ecs', 'fargate', 'rds', 'cloudfront'] },
    { tech: 'Google Cloud (Cloud Run + Cloud SQL + Cloud CDN)', avoidTokens: ['gcp', 'google cloud', 'cloud run', 'cloud sql'] },
    { tech: 'Fly.io (multi-region, dedicated)', avoidTokens: ['fly.io', 'fly-io', 'fly'] },
    { tech: 'Render (pro, autoscaling)', avoidTokens: ['render'] },
  ],
} satisfies Record<string, HostingCandidate[]>;

/** Map an explicit `stack.hosting` preference to the emitted tech string. */
const EXPLICIT_HOSTING: Record<Exclude<QuestionnaireAnswers['stack']['hosting'], 'no-preference'>, string> = {
  vercel: 'Vercel',
  aws: 'AWS (ECS/Fargate + RDS + CloudFront)',
  render: 'Render',
  'fly-io': 'Fly.io',
  cloudflare: 'Cloudflare',
  'self-hosted': 'Self-hosted',
};

/** Map an explicit `stack.database` preference to an emitted tech string. */
const EXPLICIT_DATABASE: Record<Exclude<QuestionnaireAnswers['stack']['database'], 'no-preference'>, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  sqlite: 'SQLite',
  dynamodb: 'DynamoDB',
  none: 'None',
};

/** Lowercase, trimmed `mustAvoid` tokens for case-insensitive matching. */
function avoidList(answers: QuestionnaireAnswers): string[] {
  return answers.stack.mustAvoid.map((v) => v.trim().toLowerCase()).filter(Boolean);
}

/** True when any of `tokens` appears as a substring of any avoided value. */
function isAvoided(avoided: string[], tokens: string[]): boolean {
  return avoided.some((a) => tokens.some((t) => a.includes(t) || t.includes(a)));
}

/**
 * Pick the first candidate in a tier that isn't in `mustAvoid`. Returns the
 * winner plus whether a fallback happened and which candidate was skipped, so
 * the caller can record it in `rationale`.
 */
function pickFromTier(
  tier: HostingCandidate[],
  avoided: string[],
): { tech: string; skipped: string | null } {
  const top = tier[0];
  if (!isAvoided(avoided, top.avoidTokens)) {
    return { tech: top.tech, skipped: null };
  }
  const fallback = tier.find((c) => !isAvoided(avoided, c.avoidTokens));
  // If every candidate is avoided, keep the top pick rather than emit nothing —
  // the rationale will flag the unsatisfiable constraint.
  return { tech: fallback?.tech ?? top.tech, skipped: top.tech };
}

/**
 * Turn a completed questionnaire into an infrastructure recommendation.
 *
 * Every branch below is documented with the rule it implements. All rules are
 * driven by the answers — no static defaults that ignore inputs.
 */
export function recommendInfrastructure(answers: QuestionnaireAnswers): Infrastructure {
  const { scale, budget, stack, auth, integrations, basics } = answers;
  const avoided = avoidList(answers);
  const rationale: string[] = [];

  /* ---------------------------------------------------------------------- */
  /* Hosting                                                                */
  /* ---------------------------------------------------------------------- */

  // Rule: honour `stack.hosting` when it is not `no-preference`.
  let hosting: string;
  if (stack.hosting !== 'no-preference') {
    hosting = EXPLICIT_HOSTING[stack.hosting];
    rationale.push(`Hosting set to ${hosting} because you chose "${stack.hosting}" explicitly.`);
    // A collision between an explicit hosting choice and mustAvoid is a
    // contradiction we surface rather than silently override.
    if (isAvoided(avoided, [stack.hosting, hosting.toLowerCase()])) {
      rationale.push(
        `Warning: you picked ${hosting} but also listed it under "must avoid" — keeping your explicit choice; resolve the contradiction if unintended.`,
      );
    }
  } else {
    // Rule: derive from userScale + monthlyBudgetBand (and growth/enterprise).
    const enterpriseBudget = budget.monthlyBudgetBand === 'enterprise';
    const bigScale = scale.userScale === 'large' || scale.userScale === 'very-large';
    const aggressive = scale.growthExpectation === 'aggressive';

    let tier: HostingCandidate[];
    let tierWhy: string;
    if (bigScale || aggressive || enterpriseBudget) {
      // large/very-large, aggressive growth, or enterprise budget → cloud-scale.
      tier = HOSTING_TIERS.scale;
      const driver = bigScale
        ? `${scale.userScale} user scale`
        : aggressive
          ? 'aggressive growth expectation'
          : 'enterprise budget band';
      tierWhy = `No hosting preference given; ${driver} → cloud-scale platform (containers + managed RDS + CDN).`;
    } else if (
      scale.userScale === 'medium' ||
      budget.monthlyBudgetBand === 'startup' ||
      budget.monthlyBudgetBand === 'growth'
    ) {
      // medium + startup/growth → managed PaaS with room to grow.
      tier = HOSTING_TIERS.mid;
      tierWhy = `No hosting preference given; ${scale.userScale} scale on a ${budget.monthlyBudgetBand} budget → managed PaaS (Vercel Pro / Render).`;
    } else {
      // prototype/small + free-tier/hobby → cheapest managed entry tier.
      tier = HOSTING_TIERS.entry;
      tierWhy = `No hosting preference given; ${scale.userScale} scale on a ${budget.monthlyBudgetBand} budget → free/hobby managed hosting.`;
    }

    const picked = pickFromTier(tier, avoided);
    hosting = picked.tech;
    rationale.push(tierWhy);
    if (picked.skipped) {
      rationale.push(`"${picked.skipped}" is on your must-avoid list → picked ${hosting} instead.`);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Database                                                               */
  /* ---------------------------------------------------------------------- */

  // Rule: honour `stack.database` when not `no-preference`; otherwise default
  // to Postgres — unless it's a pure stateless API service (api-service with
  // dataVolumeGb === 0), which needs no database.
  let database: string;
  if (stack.database !== 'no-preference') {
    database = EXPLICIT_DATABASE[stack.database];
    rationale.push(`Database is ${database} because you chose "${stack.database}" explicitly.`);
  } else if (basics.productType === 'api-service' && scale.dataVolumeGb === 0) {
    database = 'None';
    rationale.push('API service storing 0 GB of data → no database provisioned.');
  } else {
    // Managed Postgres pairs cleanly with every hosting tier above.
    const managed =
      hosting.startsWith('AWS')
        ? 'PostgreSQL (Amazon RDS)'
        : hosting.startsWith('Google Cloud')
          ? 'PostgreSQL (Cloud SQL)'
          : 'PostgreSQL (managed — Neon / Supabase)';
    database = managed;
    rationale.push(`No database preference given → managed ${managed} as a safe relational default for ${basics.productType}.`);
  }

  /* ---------------------------------------------------------------------- */
  /* Cache                                                                  */
  /* ---------------------------------------------------------------------- */

  // Rule: add a cache when scale is large/very-large, growth is aggressive,
  // or sustained peak load exceeds 100 rps.
  let cache: string | null = null;
  const bigScale = scale.userScale === 'large' || scale.userScale === 'very-large';
  const aggressive = scale.growthExpectation === 'aggressive';
  const highRps = scale.peakRequestsPerSecond > 100;
  if (bigScale || aggressive || highRps) {
    cache = hosting.startsWith('AWS')
      ? 'Redis (Amazon ElastiCache)'
      : 'Redis (managed — Upstash / Redis Cloud)';
    const driver = bigScale
      ? `${scale.userScale} user scale`
      : aggressive
        ? 'aggressive growth expectation'
        : `${scale.peakRequestsPerSecond} rps peak load`;
    rationale.push(`${driver} → ${cache} added up front for hot-path caching.`);
  }

  /* ---------------------------------------------------------------------- */
  /* Object storage                                                         */
  /* ---------------------------------------------------------------------- */

  // Rule: add object storage when the product needs file uploads or lists the
  // `file-storage` integration.
  let storage: string | null = null;
  const wantsUploads = integrations.needsFileUploads;
  const wantsFileStorage = integrations.integrations.includes('file-storage');
  if (wantsUploads || wantsFileStorage) {
    storage = hosting.startsWith('AWS') ? 'Amazon S3' : 'S3-compatible object storage (Cloudflare R2 / AWS S3)';
    const driver = wantsUploads ? 'user file uploads' : 'file-storage integration';
    rationale.push(`${driver} → ${storage} for durable blob storage.`);
  }

  /* ---------------------------------------------------------------------- */
  /* Environments                                                           */
  /* ---------------------------------------------------------------------- */

  // Rule: always development/preview/production; add staging when the team is
  // large (> 5) or any compliance flag beyond `none` applies.
  const environments = ['development', 'preview', 'production'];
  const hasCompliance = auth.compliance.some((c) => c !== 'none');
  if (budget.teamSize > 5 || hasCompliance) {
    environments.push('staging');
    const driver = budget.teamSize > 5 ? `team size ${budget.teamSize} (> 5)` : `compliance requirements (${auth.compliance.filter((c) => c !== 'none').join(', ')})`;
    rationale.push(`${driver} → dedicated staging environment for pre-production validation.`);
  }

  /* ---------------------------------------------------------------------- */
  /* CI/CD                                                                  */
  /* ---------------------------------------------------------------------- */

  // CI/CD follows the hosting choice: Vercel/Render/Fly ship native git
  // deploys; anything else uses GitHub Actions.
  const cicd =
    hosting.startsWith('Vercel')
      ? 'GitHub → Vercel Git integration (preview deploys per PR)'
      : hosting.startsWith('Render')
        ? 'GitHub → Render auto-deploy (preview environments per PR)'
        : hosting.startsWith('Fly.io')
          ? 'GitHub Actions → flyctl deploy'
          : 'GitHub Actions (build, test, deploy pipeline)';
  rationale.push(`CI/CD: ${cicd}, matched to the ${hosting.split(' ')[0]} hosting choice.`);

  return {
    hosting,
    database,
    cache,
    storage,
    cicd,
    environments,
    rationale,
  };
}
