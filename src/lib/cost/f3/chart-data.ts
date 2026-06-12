/**
 * InfraGenie — Feature 3 chart data mapping. PURE, DOM-free, deterministic.
 *
 * Recharts wants flat rows of numbers. This module produces them from the
 * engine's estimates WITHOUT ever inventing data:
 *
 * 🔴 The one misreading we cannot ship is a zero bar that reads as "free". So
 *    every provider bar carries a `state`:
 *      - 'priced'      — a real, complete, runnable total; draw solid.
 *      - 'incomplete'  — a floor (an unpriced required line); draw hatched/muted
 *                        with a legend note. The bar value is the floor, NOT 0.
 *      - 'unsupported' — the provider can't run the app; draw muted/greyed and
 *                        label it "can't run", NEVER as a cheap short bar.
 *    A provider with a genuine $0 total is still 'priced' (it earned the zero);
 *    the distinction is "we couldn't price it" vs "it is priced at zero".
 *
 * The composition chart (where the money goes for one provider) is built only
 * from that provider's line items; an incomplete line is flagged so the UI can
 * hatch its slice/segment rather than draw a confident block.
 */

import {
  INFRA_ROLE_LABEL,
  PROVIDER_LABEL,
  type CloudProvider,
  type InfraRole,
  type ProviderEstimate,
} from '@/types/cost';

/* -------------------------------------------------------------------------- */
/* Grouped bar: monthly total per provider                                    */
/* -------------------------------------------------------------------------- */

export type BarState = 'priced' | 'incomplete' | 'unsupported';

export interface ProviderBarDatum {
  provider: CloudProvider;
  /** Short axis label. */
  label: string;
  /** The monthly total. For 'incomplete' this is a FLOOR, for 'unsupported'
   *  it is whatever the priceable subset totalled — the UI must not present it
   *  as a comparable full cost. Never fabricated; taken straight from the
   *  estimate. */
  monthlyUsd: number;
  state: BarState;
}

function barState(e: ProviderEstimate): BarState {
  if (e.unsupportedRoles.length > 0) return 'unsupported';
  if (e.incomplete) return 'incomplete';
  return 'priced';
}

/**
 * One datum per provider for the grouped/comparison bar chart, in the order the
 * estimates are given. No sorting here — the caller controls ordering (the
 * comparison view sorts; the chart may want provider-enum order).
 */
export function toProviderBars(estimates: readonly ProviderEstimate[]): ProviderBarDatum[] {
  return estimates.map((e) => ({
    provider: e.provider,
    label: PROVIDER_LABEL[e.provider],
    monthlyUsd: e.monthlyUsd,
    state: barState(e),
  }));
}

/** True when at least one bar is a floor or an unsupported provider — the chart
 *  must then show the "hatched = couldn't fully price / can't run" legend. */
export function barsNeedCaveatLegend(bars: readonly ProviderBarDatum[]): boolean {
  return bars.some((b) => b.state !== 'priced');
}

/* -------------------------------------------------------------------------- */
/* Composition: where one provider's money goes, by role                      */
/* -------------------------------------------------------------------------- */

export interface CompositionDatum {
  role: InfraRole;
  /** Human role label, e.g. "Relational database". */
  label: string;
  monthlyUsd: number;
  /** The dominant service filling this role, for the tooltip. */
  serviceName: string;
  /** A required dimension on this line is unpriced → its cost is a floor. */
  incomplete: boolean;
  /** Share of the provider total in [0,1]. 0 when the total is 0. */
  share: number;
}

/**
 * Cost composition by role for ONE provider, largest first. Zero-cost lines are
 * dropped from the pie/stack (they add no visual signal) UNLESS they are
 * incomplete — an incomplete zero is "we couldn't price this", which the chart
 * must still surface, not hide.
 */
export function toComposition(estimate: ProviderEstimate): CompositionDatum[] {
  const total = estimate.monthlyUsd;
  const data: CompositionDatum[] = estimate.items
    .filter((it) => it.monthlyUsd > 0 || it.incomplete)
    .map((it) => ({
      role: it.role,
      label: INFRA_ROLE_LABEL[it.role],
      monthlyUsd: it.monthlyUsd,
      serviceName: it.serviceName,
      incomplete: it.incomplete,
      share: total > 0 ? it.monthlyUsd / total : 0,
    }));
  return data.sort((a, b) => b.monthlyUsd - a.monthlyUsd);
}

/* -------------------------------------------------------------------------- */
/* Stable palette                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A stable, colour-blind-conscious palette keyed by index. Recharts needs an
 * explicit fill per series; returning from a fixed ring keeps the same role the
 * same colour across renders. These are hsl strings usable directly as `fill`.
 */
export const CHART_PALETTE: readonly string[] = [
  'hsl(221 83% 53%)', // blue
  'hsl(142 71% 45%)', // green
  'hsl(38 92% 50%)', // amber
  'hsl(280 65% 60%)', // purple
  'hsl(340 75% 55%)', // pink
  'hsl(190 80% 42%)', // teal
  'hsl(16 85% 55%)', // orange
  'hsl(255 60% 62%)', // indigo
  'hsl(96 55% 45%)', // lime
  'hsl(0 72% 55%)', // red
  'hsl(210 15% 55%)', // slate
  'hsl(48 90% 45%)', // gold
  'hsl(170 60% 40%)', // sea
];

export function paletteColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length];
}
