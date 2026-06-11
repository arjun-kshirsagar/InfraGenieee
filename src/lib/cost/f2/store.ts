/**
 * InfraGenie — Feature 2 client persistence (frontend-owned).
 *
 * Saves the user's cost-explorer work — the (possibly edited) usage profile and
 * the per-provider selections — to `localStorage`, keyed by PRD id so switching
 * PRDs never bleeds one app's selection into another:
 *
 *   `infragenie:cost:<prdId>`
 *
 * It upholds the exact same hard rules as `src/lib/prd/store.ts`, because a
 * schema change to the cost contract must never crash the explorer on a stale
 * blob:
 *   1. SSR-safe — every function guards `typeof window === 'undefined'`.
 *   2. Every `localStorage` access is try/catch'd (quota / private mode /
 *      disabled storage) — never throws at the caller.
 *   3. Every READ is zod-validated (`costStateSchema`) and returns `null` on
 *      mismatch. Stale/foreign JSON is treated as absent, not fatal.
 */

import { z } from 'zod';

import {
  usageProfileSchema,
  costSelectionSchema,
  CATALOG_VERSION,
} from '@/types/cost';

const KEY_PREFIX = 'infragenie:cost:';

/**
 * The persisted shape. `version` pins the catalog version: if the catalog's
 * SKU ids shift under us, an old blob is discarded rather than resurrecting a
 * selection that references SKUs that no longer exist. `selections` is a map
 * keyed by provider (kept as a record so a corrupt provider key just fails the
 * parse and the whole blob is treated as absent — same posture as the PRD store).
 */
export const costStateSchema = z.object({
  version: z.string().min(1),
  usage: usageProfileSchema,
  activeProvider: z.string().min(1),
  selections: z.record(z.string(), costSelectionSchema),
});

export type CostState = z.infer<typeof costStateSchema>;

const stateKey = (prdId: string): string => `${KEY_PREFIX}${prdId}`;

/** Safe `localStorage` accessor — `null` on server / unavailable storage. */
function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Persist the explorer state for a PRD. Best-effort: no-op on SSR, unavailable
 * storage, or quota errors — the in-memory state keeps working regardless.
 * Stamps the current `CATALOG_VERSION` so a later catalog change invalidates it.
 */
export function saveCostState(prdId: string, state: Omit<CostState, 'version'>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const payload: CostState = { version: CATALOG_VERSION, ...state };
    storage.setItem(stateKey(prdId), JSON.stringify(payload));
  } catch {
    // Quota exceeded / storage disabled — persistence is best-effort.
  }
}

/**
 * Load the explorer state for a PRD. Returns `null` when absent, unreadable,
 * invalid JSON, failing `costStateSchema`, or written for a DIFFERENT catalog
 * version (a stale blob referencing dropped SKUs must not be trusted). A `null`
 * return means "start from the recommendation seed", which is always safe.
 */
export function loadCostState(prdId: string): CostState | null {
  const storage = getStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(stateKey(prdId));
  } catch {
    return null;
  }
  if (raw == null) return null;
  const parsed = safeParseJson(raw);
  if (parsed === undefined) return null;
  const result = costStateSchema.safeParse(parsed);
  if (!result.success) return null;
  // A blob from an older catalog references SKUs that may no longer exist —
  // treat it as absent so we re-seed cleanly rather than render broken rows.
  if (result.data.version !== CATALOG_VERSION) return null;
  return result.data;
}

/** Remove the persisted state for a PRD. No-op on SSR/error. */
export function clearCostState(prdId: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(stateKey(prdId));
  } catch {
    // ignore
  }
}
