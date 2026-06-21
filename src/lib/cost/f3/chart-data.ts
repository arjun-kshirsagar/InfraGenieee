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
import { isEntirelyUnpriced } from '../estimate/engine';

/* -------------------------------------------------------------------------- */
/* Grouped bar: monthly total per provider                                    */
/* -------------------------------------------------------------------------- */

export type BarState = 'priced' | 'incomplete' | 'unsupported' | 'notpriced';

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
  // 🔴 Services selected but ZERO priced dimensions → we could NOT price this
  // provider at all. Its $0 is a floor of pure unknowns, NOT a real total. Draw
  // it as an explicit "couldn't price" marker, never a (possibly zero-height)
  // confident bar (BLOCKER-3 / MINOR-1). A provider that priced genuinely $0
  // (only free-tier lines) HAS priced dimensions → stays 'priced' (it earned
  // the zero). Checked before `incomplete` because notpriced is the stronger,
  // more specific state.
  if (isEntirelyUnpriced(e)) return 'notpriced';
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

/**
 * A readable Y-axis cap for the provider-totals chart.
 *
 * An `incomplete` floor can be a wild outlier — an unpriced per-second SKU can
 * yield a nonsense $1.2M "floor" that, if it set the axis scale, would flatten
 * every other provider's bar to an invisible sliver and make the money-shot
 * chart useless. So we scale the axis to the largest *trustworthy* bar:
 *
 *   - Prefer the max over `priced` bars (complete, runnable — real numbers).
 *   - Else, among the non-unsupported bars, use a ROBUST max: the largest value
 *     that is not a lone extreme outlier. Concretely, if the top value is more
 *     than 10x the next one, the top is treated as off-scale and the axis caps
 *     at that next value — so a single garbage floor can't flatten the rest.
 *   - If everything is genuinely zero, return a nominal 1 so the axis renders.
 *
 * Bars taller than the cap are drawn clamped to the cap and flagged `offScale`
 * by `capBars` so the UI can mark them "off the chart" rather than silently
 * truncating — the number is still shown in the tooltip and the cards.
 */
export function chartAxisCap(bars: readonly ProviderBarDatum[]): number {
  const priced = bars.filter((b) => b.state === 'priced').map((b) => b.monthlyUsd);
  if (priced.length > 0) {
    const max = Math.max(...priced);
    if (max > 0) return max;
  }
  // No priced bars — fall back to a robust max over the non-unsupported bars.
  const values = bars
    .filter((b) => b.state !== 'unsupported')
    .map((b) => b.monthlyUsd)
    .filter((v) => v > 0)
    .sort((a, b) => b - a);
  if (values.length === 0) return 1;
  if (values.length === 1) return values[0];
  const [top, next] = values;
  // A lone extreme outlier (>10x the next bar) is capped OUT of the scale so the
  // remaining bars stay legible; otherwise the true top sets the scale.
  return top > next * 10 ? next : top;
}

export interface CappedBarDatum extends ProviderBarDatum {
  /** Value used for the bar height (clamped to the axis cap). */
  displayValue: number;
  /** True when the real value exceeds the axis cap (drawn at the cap + marked). */
  offScale: boolean;
}

/**
 * Clamp bar heights to `cap` so one outlier floor cannot flatten the chart,
 * while preserving the true value (in `monthlyUsd`) for the tooltip and marking
 * clamped bars `offScale`. Purely presentational clamping — never changes a
 * number the user reads, only how tall the rectangle is drawn.
 */
export function capBars(bars: readonly ProviderBarDatum[], cap: number): CappedBarDatum[] {
  return bars.map((b) => ({
    ...b,
    displayValue: Math.min(b.monthlyUsd, cap),
    offScale: b.monthlyUsd > cap,
  }));
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
