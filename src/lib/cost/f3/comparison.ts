/**
 * InfraGenie — Feature 3 (side-by-side comparison) pure shaping helpers.
 *
 * DOM-free, deterministic, no clock, no I/O. Turns the engine's per-provider
 * `ProviderEstimate`s and the `CostComparison` badge awards into the row model
 * the comparison UI renders, plus the small copy that explains each badge.
 *
 * 🔴 Honesty rules carried over from the engine — NOT re-decided here:
 *  - The badge winners come from `compare()` (the engine). This module never
 *    recomputes a winner; `resolveBadges` only maps the engine's answer to a
 *    label + explanation, and returns nothing for a `null` award.
 *  - A provider with `unsupportedRoles` is `runnable: false` and sorts to the
 *    bottom — it is never presented above a provider that can run the app.
 *  - An `incomplete` estimate is a floor, flagged, and (per the engine) can
 *    never be the cheapest.
 */

import {
  INFRA_ROLE_LABEL,
  PRICED_REGION_LABEL,
  PROVIDER_LABEL,
  type CloudProvider,
  type CostComparison,
  type CostLineItem,
  type InfraRole,
  type ProviderEstimate,
} from '@/types/cost';

import { isEntirelyUnpriced } from '../estimate/engine';

/* -------------------------------------------------------------------------- */
/* Per-provider comparison row                                                */
/* -------------------------------------------------------------------------- */

/** One line in a provider's per-role summary (compact form of a CostLineItem). */
export interface ComparisonLineSummary {
  role: InfraRole;
  roleLabel: string;
  serviceName: string;
  skuName: string;
  units: number;
  monthlyUsd: number;
  /** A required dimension on this line is unpriced → line total is a floor. */
  incomplete: boolean;
}

/**
 * One provider's column/card in the side-by-side comparison. Carries everything
 * the card renders and the honesty flags that decide how it renders — never a
 * bare number the UI could misread as "cheap".
 */
export interface ComparisonRow {
  provider: CloudProvider;
  providerLabel: string;
  regionLabel: string;
  monthlyUsd: number;
  /** `true` when the provider cannot fill a role the PRD requires. Such a
   *  provider is never the cheap option and never sorts above a runnable one. */
  runnable: boolean;
  /** Roles this provider genuinely cannot serve (labels), for the gap note. */
  unsupportedRoleLabels: string[];
  /** A required dimension somewhere is unpriced → the total is a FLOOR. */
  incomplete: boolean;
  /** 🔴 The provider priced NOTHING — its book is 100% missing, so `monthlyUsd`
   *  is a $0 floor of pure unknowns, not a comparable cost. The UI must render
   *  "not priced" (no dollar figure), NOT "≥ $0.00", and this row sorts after
   *  every priced/floor row (BLOCKER-3 / MINOR-1). */
  notPriced: boolean;
  lines: ComparisonLineSummary[];
  /** Which badges this provider won, in a stable order. Empty when none. */
  badges: BadgeKind[];
}

export type BadgeKind = 'cheapest' | 'bestScaling' | 'simplest';

function summariseLine(item: CostLineItem): ComparisonLineSummary {
  return {
    role: item.role,
    roleLabel: INFRA_ROLE_LABEL[item.role],
    serviceName: item.serviceName,
    skuName: item.skuName,
    units: item.units,
    monthlyUsd: item.monthlyUsd,
    incomplete: item.incomplete,
  };
}

/**
 * Shape one estimate into a comparison row, attaching the badges it won
 * according to the engine's comparison (never recomputed here).
 */
export function toComparisonRow(
  estimate: ProviderEstimate,
  comparison: CostComparison,
): ComparisonRow {
  const badges: BadgeKind[] = [];
  if (comparison.cheapest === estimate.provider) badges.push('cheapest');
  if (comparison.bestScaling === estimate.provider) badges.push('bestScaling');
  if (comparison.simplest === estimate.provider) badges.push('simplest');

  return {
    provider: estimate.provider,
    providerLabel: PROVIDER_LABEL[estimate.provider],
    regionLabel: PRICED_REGION_LABEL[estimate.provider],
    monthlyUsd: estimate.monthlyUsd,
    runnable: estimate.unsupportedRoles.length === 0,
    unsupportedRoleLabels: estimate.unsupportedRoles.map((r) => INFRA_ROLE_LABEL[r]),
    incomplete: estimate.incomplete,
    notPriced: isEntirelyUnpriced(estimate),
    lines: estimate.items.map(summariseLine),
    badges,
  };
}

/**
 * Build the ordered comparison rows.
 *
 * Sort order (deterministic — ties fall back to the estimate array order, which
 * is provider enum order):
 *   1. runnable providers first, unrunnable ("can't run this app") last;
 *   2. within runnable, providers that priced SOMETHING before ones that priced
 *      NOTHING (a 100%-missing book is a $0 floor of pure unknowns — it must
 *      never sort ahead of a real estimate just because its floor is $0);
 *   3. within that, complete estimates before incomplete floors;
 *   4. within each group, cheapest monthly first.
 *
 * This guarantees a provider that can't run the app — or that couldn't price a
 * single dimension — is never displayed as the top/cheap choice, matching the
 * engine's `cheapest` and badge exclusions (BLOCKER-3 / RC4).
 */
export function buildComparisonRows(
  estimates: readonly ProviderEstimate[],
  comparison: CostComparison,
): ComparisonRow[] {
  const rows = estimates.map((e) => toComparisonRow(e, comparison));
  const order = new Map<CloudProvider, number>();
  estimates.forEach((e, i) => order.set(e.provider, i));

  return [...rows].sort((a, b) => {
    if (a.runnable !== b.runnable) return a.runnable ? -1 : 1;
    if (a.runnable) {
      // priced-something before priced-nothing: a $0 floor of pure unknowns must
      // never sort ahead of a real estimate (RC4).
      if (a.notPriced !== b.notPriced) return a.notPriced ? 1 : -1;
      // complete before incomplete floor
      if (a.incomplete !== b.incomplete) return a.incomplete ? 1 : -1;
      if (a.monthlyUsd !== b.monthlyUsd) return a.monthlyUsd - b.monthlyUsd;
    }
    return (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0);
  });
}

/* -------------------------------------------------------------------------- */
/* Badge explanations                                                         */
/* -------------------------------------------------------------------------- */

export interface BadgeInfo {
  kind: BadgeKind;
  /** Short label for the pill. */
  label: string;
  /** Tooltip copy explaining what the badge means and where it comes from.
   *  bestScaling/simplest explicitly say they are editorial, not price. */
  explanation: string;
  provider: CloudProvider;
  providerLabel: string;
}

const BADGE_LABEL: Record<BadgeKind, string> = {
  cheapest: 'Cheapest',
  bestScaling: 'Best scaling',
  simplest: 'Simplest',
};

const BADGE_EXPLANATION: Record<BadgeKind, string> = {
  cheapest:
    'Lowest total monthly cost among providers that can run the whole app. ' +
    'Providers with an unpriced required line (a floor) or a missing capability are excluded — a gap is not a discount.',
  bestScaling:
    'Highest combined scaling score across the selected services. This is an ' +
    'editorial judgement (how gracefully each service grows), justified in each ' +
    'service\u2019s trade-off note \u2014 it is NOT a price claim.',
  simplest:
    'Highest combined simplicity score across the selected services \u2014 how ' +
    'little operational effort they take. An editorial judgement, justified in ' +
    'each service\u2019s trade-off note, NOT a price claim.',
};

/**
 * Resolve the engine's badge awards into displayable `BadgeInfo`. A `null`
 * award (one provider selected, or every estimate incomplete → no honest
 * winner) yields NO entry: the UI renders nothing rather than inventing a
 * winner. Order is stable: cheapest, then bestScaling, then simplest.
 */
export function resolveBadges(comparison: CostComparison): BadgeInfo[] {
  const out: BadgeInfo[] = [];
  const map: [BadgeKind, CloudProvider | null][] = [
    ['cheapest', comparison.cheapest],
    ['bestScaling', comparison.bestScaling],
    ['simplest', comparison.simplest],
  ];
  for (const [kind, provider] of map) {
    if (provider === null) continue;
    out.push({
      kind,
      label: BADGE_LABEL[kind],
      explanation: BADGE_EXPLANATION[kind],
      provider,
      providerLabel: PROVIDER_LABEL[provider],
    });
  }
  return out;
}

/** Static badge descriptor (label + explanation) without a winner attached —
 *  used for a legend/key even when the award is null. */
export function badgeMeta(kind: BadgeKind): { label: string; explanation: string } {
  return { label: BADGE_LABEL[kind], explanation: BADGE_EXPLANATION[kind] };
}
