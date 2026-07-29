/**
 * InfraGenie — Feature 3, the plan builder (task B7, docs §1 and §8).
 *
 * `buildDeployPlan(rawUrl, deps, options)` wires the whole one-click-deploy
 * pipeline into one function and one output:
 *
 * ```
 * parseRepoUrl(rawUrl) → RepoSource.fetchSnapshot(ref) → detectStack(snapshot)
 *   → recommendProviders(detection, ref, { prdContext, defaultBranch })
 *   → generateConfigs(detection, ref)
 *   → DeployPlan
 * ```
 *
 * ## Dependency injection — the module stays testable without a network or a clock
 *
 * The one impure step (reading the repo) is behind the `RepoSource` seam and is
 * INJECTED via `deps.source`; the plan's `generatedAt` comes from an INJECTED
 * `deps.now()`, never `new Date()` inline. That is what lets `plan.test.ts`
 * exercise every branch of the pipeline against a stub `RepoSource` with a fixed
 * clock — deterministically, offline, and for free.
 *
 * ## Non-GitHub hosts (docs §5)
 *
 * We can only read GitHub contents anonymously in v1. For a GitLab/Bitbucket
 * ref the snapshot fetch is SKIPPED ENTIRELY — there is nothing to read — and we
 * build an honest `confidence: 'unknown'` detection with an explicit note. The
 * three deploy buttons still work (all three providers accept those hosts), so
 * `recommendProviders` still emits all three URLs with `primary: null` and
 * guidance. Detection is what's missing, not the buttons.
 *
 * ## Errors
 *
 * Every failure is a `RepoError` (thrown by `parseRepoUrl` or the `RepoSource`).
 * The route maps `RepoError.code` → an HTTP status; this module never maps to
 * HTTP and never swallows a `RepoError`.
 *
 * ## Purity of everything downstream of the fetch
 *
 * `detectStack`, `recommendProviders` and `generateConfigs` are all pure. The
 * only non-determinism in a plan is `generatedAt`, and that is injected — so two
 * plans of the same repo built with the same clock are deep-equal.
 */

import {
  deployPlanSchema,
  type DeployPlan,
  type DeployPrdContext,
  type StackDetection,
} from '@/types/deploy';

import type { RepoSource, RepoSnapshotCache } from './repo-seam';
import { parseRepoUrl } from './repo-url';
import { detectStack, unknownDetection, UNREADABLE_HOST_NOTE } from './detect';
import { recommendProviders } from './recommend';
import { generateConfigs } from './generate';

/* -------------------------------------------------------------------------- */
/* Injected dependencies                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The seams the plan builder needs. Injecting them (rather than importing the
 * concrete GitHub source and `new Date()`) is what keeps the module unit-testable
 * without a network or a real clock.
 */
export interface BuildDeployPlanDeps {
  /** Reads a public repository into a `RepoSnapshot`. In production this is the
   *  GitHub source; in tests it is a stub that returns a fixture. */
  source: RepoSource;
  /** Optional 15-minute snapshot cache, checked before the source and populated
   *  after a fetch. A cache miss (or no cache at all) just means a fresh fetch. */
  cache?: RepoSnapshotCache;
  /** The clock. Returns the ISO timestamp stamped onto `plan.generatedAt`.
   *  Injected so a test can assert a fixed value and so the pure pipeline never
   *  reads `Date` itself. */
  now: () => string;
}

export interface BuildDeployPlanOptions {
  /** The PRD slice, when the user planned this app in Feature 1. Optional — a
   *  bare URL still yields a full plan; the PRD only sharpens provider fit. */
  prdContext?: DeployPrdContext;
  /** Propagated to the `RepoSource` so a client abort cancels the fetches. */
  signal?: AbortSignal;
}

/* -------------------------------------------------------------------------- */
/* The builder                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Turn a pasted repo URL into a fully-assembled {@link DeployPlan}.
 *
 * @throws {import('./repo-seam').RepoError} `invalid_url` / `unsupported_host`
 *   from `parseRepoUrl`, or `not_found` / `rate_limited` / `unavailable` /
 *   `too_large` from the `RepoSource`. The route maps these onto HTTP statuses;
 *   this function does not.
 *
 * The returned plan is validated against `deployPlanSchema` before it is
 * returned — an assembly bug (e.g. a `primary` set under `unknown` confidence)
 * surfaces here loudly rather than reaching the client. That self-validation is
 * ALSO repeated at the route boundary via `analyzeResponseSchema`; both layers
 * are intentional (the contract's "self-validate output" rule).
 */
export async function buildDeployPlan(
  rawUrl: string,
  deps: BuildDeployPlanDeps,
  options: BuildDeployPlanOptions = {},
): Promise<DeployPlan> {
  const { source, cache, now } = deps;
  const { prdContext, signal } = options;

  // 1. Parse — pure. Throws RepoError('invalid_url' | 'unsupported_host').
  const ref = parseRepoUrl(rawUrl);

  // 2a. Non-GitHub host: skip the fetch entirely (v1 can't read GitLab/Bitbucket
  //     contents). Build the honest unknown detection; the buttons still work.
  if (ref.host !== 'github') {
    const detection = unknownDetection([UNREADABLE_HOST_NOTE(ref.host)]);
    // No snapshot means no default branch to anchor a subdirectory URL; that is
    // fine — buildDeployUrl falls back to the bare repo rather than guessing.
    return assemble(detection, ref, prdContext, undefined, now());
  }

  // 2b. GitHub: read the repo (the one impure step), preferring a fresh cache
  //     hit so a re-analysis doesn't burn a second anonymous budget.
  let snapshot = (await cache?.get(ref, { branch: ref.branch ?? undefined })) ?? null;
  if (snapshot === null) {
    // Throws RepoError('not_found' | 'rate_limited' | 'unavailable' | 'too_large').
    snapshot = await source.fetchSnapshot(ref, { signal });
    // Best-effort populate; cache.set never throws on its own.
    await cache?.set(snapshot);
  }

  // 3. Detect — pure. Detection is a function of the snapshot's CONTENTS
  //    (entries + probed files), which is all the snapshot is trusted for.
  const detection = detectStack(snapshot);

  // The plan's IDENTITY (repo, branch, subdir, and therefore every deploy URL)
  // comes from the PARSED ref, never `snapshot.ref`. Treating the snapshot as
  // identity was F3 BLOCKER-1 / MAJOR-1: a cache entry written by another scope
  // (root vs. subdir, or branchless-resolved-to-main vs. pinned /tree/main)
  // would otherwise stamp the wrong repo/branch/subdir onto this user's plan and
  // hand them deploy buttons for code they never pasted. The snapshot is
  // contents; the ref is identity. `defaultBranch` is a fact about the repo, so
  // it legitimately comes from the snapshot.
  return assemble(detection, ref, prdContext, snapshot.defaultBranch, now());
}

/**
 * Shared tail: score the providers, generate configs, assemble and self-validate
 * the plan. Kept in one place so the GitHub and non-GitHub paths produce a plan
 * of exactly the same shape.
 */
function assemble(
  detection: StackDetection,
  ref: DeployPlan['repo'],
  prdContext: DeployPrdContext | undefined,
  defaultBranch: string | undefined,
  generatedAt: string,
): DeployPlan {
  // 4. Provider fit — pure. Always three fits; primary null under unknown.
  const { fits, primary, assumptions, usedPrdContext, effectiveNeeds } = recommendProviders(
    detection,
    ref,
    {
      prdContext,
      defaultBranch,
    },
  );

  // The needs the fit reasoning actually reasoned from (repo needs + any the PRD
  // supplied). We build ONE effective-needs detection and use it for BOTH the
  // plan's `detection` and `generateConfigs`, so the Render card, the UI's
  // "Managed services needed" list, and the emitted blueprint can never
  // disagree (F3 BLOCKER-3). The PRD attribution is not lost: `foldPrdNeeds`
  // records a "this came from the PRD, not the code" assumption for each
  // supplied need, and those surface in `assumptions` below.
  //
  // Safe against the schema: at `unknown` confidence `recommendProviders`
  // returns `effectiveNeeds: []` and never folds the PRD, so this is a no-op
  // there and `stackDetectionSchema`'s "unknown ⇒ no needs" rule still holds.
  const effectiveDetection: StackDetection =
    effectiveNeeds.length === detection.needs.length
      ? detection
      : { ...detection, needs: effectiveNeeds };

  // 5. Generated configs — pure. An unknown detection yields none. Uses the
  //    EFFECTIVE-needs detection so whatever a fit promises, the blueprint
  //    delivers (e.g. a PRD-supplied database ⇒ a `databases:` block).
  const configs = generateConfigs(effectiveDetection, ref);

  const plan = {
    repo: ref,
    detection: effectiveDetection,
    fits,
    primary,
    assumptions,
    configs,
    usedPrdContext,
    generatedAt,
  };

  // Self-validate: an assembly bug must fail here, not at the client.
  return deployPlanSchema.parse(plan);
}
