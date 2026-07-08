/**
 * InfraGenie — Feature 3 client persistence (frontend-owned).
 *
 * Saves the last successful deploy analysis to `localStorage`, keyed by the
 * repo's **canonical URL** so a reload doesn't lose it and re-analysing the same
 * repo can restore instantly:
 *
 *   `infragenie:deploy:<canonicalUrl>`
 *
 * It upholds the exact same hard rules as `src/lib/prd/store.ts`, because a
 * schema change to the deploy contract must never crash the page on a stale blob:
 *   1. SSR-safe — every function guards `typeof window === 'undefined'`.
 *   2. Every `localStorage` access is try/catch'd (quota / private mode /
 *      disabled storage) — never throws at the caller.
 *   3. Every READ is zod-validated (`deployStateSchema`) and returns `null` on
 *      mismatch. Stale/foreign JSON is treated as absent, not fatal.
 *   4. A blob written for a DIFFERENT `DETECTION_VERSION` is discarded — the
 *      detection matrix / fit weights may have changed under it, so a cached
 *      plan from an older version would lie.
 */

import { z } from 'zod';

import { deployPlanSchema, DETECTION_VERSION } from '@/types/deploy';

const KEY_PREFIX = 'infragenie:deploy:';
/** A tiny pointer to the canonical URL of the most recent analysis, so a plain
 *  reload can restore the last result without the user re-pasting. It stores a
 *  KEY, never a plan — the plan itself always comes back through the versioned,
 *  zod-validated `loadDeployState`, so a stale pointer just yields a clean miss. */
const LAST_KEY = 'infragenie:deploy:last';

/**
 * The persisted shape. `version` pins `DETECTION_VERSION`; `plan` is the full
 * validated `DeployPlan`. Keyed by canonical URL so the key is stable across the
 * many raw forms of the same repo the user might paste.
 */
export const deployStateSchema = z.object({
  version: z.string().min(1),
  plan: deployPlanSchema,
});

export type DeployState = z.infer<typeof deployStateSchema>;

const stateKey = (canonicalUrl: string): string => `${KEY_PREFIX}${canonicalUrl}`;

/** Safe `localStorage` accessor — `null` on server / unavailable storage. */
function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Parse JSON without throwing. Returns `undefined` on any failure. */
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Persist the analysis for a repo, keyed by `plan.repo.canonicalUrl`.
 * Best-effort: no-op on SSR, unavailable storage, or quota errors — the
 * in-memory plan keeps working regardless. Stamps the current
 * `DETECTION_VERSION` so a later matrix change invalidates it.
 */
export function saveDeployState(plan: DeployState['plan']): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const payload: DeployState = { version: DETECTION_VERSION, plan };
    storage.setItem(stateKey(plan.repo.canonicalUrl), JSON.stringify(payload));
  } catch {
    // Quota exceeded / storage disabled — persistence is best-effort.
  }
}

/**
 * Load the last analysis for a canonical repo URL. Returns `null` when absent,
 * unreadable, invalid JSON, failing `deployStateSchema`, or written for a
 * DIFFERENT `DETECTION_VERSION`. A `null` return means "re-analyse", which is
 * always safe.
 */
export function loadDeployState(canonicalUrl: string): DeployState['plan'] | null {
  const storage = getStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(stateKey(canonicalUrl));
  } catch {
    return null;
  }
  if (raw == null) return null;
  const parsed = safeParseJson(raw);
  if (parsed === undefined) return null;
  const result = deployStateSchema.safeParse(parsed);
  if (!result.success) return null;
  // A blob from an older detection version may encode fits/signals that no
  // longer match the current matrix — treat it as absent so we re-analyse.
  if (result.data.version !== DETECTION_VERSION) return null;
  return result.data.plan;
}

/** Remove the persisted analysis for a canonical URL. No-op on SSR/error. */
export function clearDeployState(canonicalUrl: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(stateKey(canonicalUrl));
  } catch {
    // ignore
  }
}

/**
 * Record which canonical URL was analysed most recently, so a plain reload can
 * restore that result. Best-effort, no-op on SSR/error.
 */
export function saveLastAnalyzed(canonicalUrl: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(LAST_KEY, canonicalUrl);
  } catch {
    // ignore
  }
}

/** The canonical URL of the most recent analysis, or `null`. No-op on SSR. */
export function loadLastAnalyzed(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(LAST_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
