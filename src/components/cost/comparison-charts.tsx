'use client';

/**
 * Comparison charts (Recharts). Two visualisations, both responsive:
 *
 *  1. **Grouped/comparison bar** — monthly total per provider (the money shot).
 *  2. **Role composition** — where the SELECTED provider's money goes, by role.
 *
 * 🔴 The one misreading we cannot ship is a zero bar that reads as "free". So:
 *  - Bars carry a `state` (priced | incomplete | unsupported). Incomplete and
 *    unsupported bars are drawn with a diagonal HATCH fill + a legend note, so
 *    the eye reads "not a clean number" rather than "cheap". They are never
 *    silently zeroed — the floor value is drawn, just marked.
 *  - The composition chart hatches an unpriced (incomplete) role slice too.
 *
 * All maths is done by the pure `@/lib/cost/f3/chart-data` helpers; this file is
 * presentation only. `formatUsd` keeps axis + tooltip currency consistent with
 * the rest of the UI.
 */

import * as React from 'react';
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  CartesianGrid,
} from 'recharts';

import type { ProviderEstimate } from '@/types/cost';
import { PROVIDER_LABEL } from '@/types/cost';
import { formatUsd, formatCompact } from '@/lib/cost/f2/format';
import {
  toProviderBars,
  toComposition,
  barsNeedCaveatLegend,
  paletteColor,
  type BarState,
  type ProviderBarDatum,
  type CompositionDatum,
} from '@/lib/cost/f3/chart-data';

/* -------------------------------------------------------------------------- */
/* SVG hatch pattern defs — the "couldn't fully price / can't run" texture     */
/* -------------------------------------------------------------------------- */

/** Stable ids so <Cell fill="url(#...)"> can reference them. */
const HATCH_INCOMPLETE = 'infragenie-hatch-incomplete';
const HATCH_UNSUPPORTED = 'infragenie-hatch-unsupported';

const BAR_SOLID = 'hsl(221 83% 53%)'; // priced — same blue as palette[0]
const INCOMPLETE_BASE = 'hsl(38 92% 50%)'; // amber
const UNSUPPORTED_BASE = 'hsl(0 0% 60%)'; // muted grey

function HatchDefs() {
  return (
    <defs>
      <pattern
        id={HATCH_INCOMPLETE}
        patternUnits="userSpaceOnUse"
        width="6"
        height="6"
        patternTransform="rotate(45)"
      >
        <rect width="6" height="6" fill={INCOMPLETE_BASE} opacity={0.18} />
        <line x1="0" y1="0" x2="0" y2="6" stroke={INCOMPLETE_BASE} strokeWidth="3" />
      </pattern>
      <pattern
        id={HATCH_UNSUPPORTED}
        patternUnits="userSpaceOnUse"
        width="6"
        height="6"
        patternTransform="rotate(45)"
      >
        <rect width="6" height="6" fill={UNSUPPORTED_BASE} opacity={0.15} />
        <line x1="0" y1="0" x2="0" y2="6" stroke={UNSUPPORTED_BASE} strokeWidth="3" />
      </pattern>
    </defs>
  );
}

function barFill(state: BarState): string {
  if (state === 'incomplete') return `url(#${HATCH_INCOMPLETE})`;
  if (state === 'unsupported') return `url(#${HATCH_UNSUPPORTED})`;
  return BAR_SOLID;
}

/* -------------------------------------------------------------------------- */
/* Custom tooltips (currency-formatted, honesty-aware)                        */
/* -------------------------------------------------------------------------- */

interface TooltipPayload<T> {
  active?: boolean;
  payload?: { payload: T }[];
}

function ProviderBarTooltip({ active, payload }: TooltipPayload<ProviderBarDatum>) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="font-medium">{d.label}</p>
      {d.state === 'unsupported' ? (
        <p className="mt-0.5 text-destructive">Can&rsquo;t run this app — not comparable</p>
      ) : (
        <p className="mt-0.5 tabular-nums">
          {d.state === 'incomplete' ? '\u2265 ' : ''}
          {formatUsd(d.monthlyUsd)}/mo
          {d.state === 'incomplete' ? ' (floor)' : ''}
        </p>
      )}
    </div>
  );
}

function CompositionTooltip({ active, payload }: TooltipPayload<CompositionDatum>) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="font-medium">{d.label}</p>
      <p className="text-muted-foreground">{d.serviceName}</p>
      {d.incomplete ? (
        <p className="mt-0.5 text-amber-600">Unpriced required line — a floor</p>
      ) : (
        <p className="mt-0.5 tabular-nums">
          {formatUsd(d.monthlyUsd)}/mo · {(d.share * 100).toFixed(0)}%
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Grouped bar: total per provider                                            */
/* -------------------------------------------------------------------------- */

function ProviderTotalsChart({ estimates }: { estimates: readonly ProviderEstimate[] }) {
  const bars = React.useMemo(() => toProviderBars(estimates), [estimates]);
  const needsLegend = barsNeedCaveatLegend(bars);
  const allZero = bars.every((b) => b.monthlyUsd === 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="h-64 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bars as ProviderBarDatum[]} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <HatchDefs />
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11 }}
              interval={0}
              angle={-12}
              textAnchor="end"
              height={48}
              className="fill-muted-foreground"
            />
            <YAxis
              tickFormatter={(v: number) => formatCompact(v)}
              tick={{ fontSize: 11 }}
              width={52}
              className="fill-muted-foreground"
              // A flat-zero domain would draw nothing; give it a nominal top.
              domain={allZero ? [0, 1] : [0, 'auto']}
            />
            <RTooltip content={<ProviderBarTooltip />} cursor={{ fill: 'hsl(0 0% 50% / 0.06)' }} />
            <Bar dataKey="monthlyUsd" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {bars.map((b) => (
                <Cell
                  key={b.provider}
                  fill={barFill(b.state)}
                  stroke={b.state === 'priced' ? undefined : 'hsl(0 0% 45% / 0.5)'}
                  strokeWidth={b.state === 'priced' ? 0 : 1}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {needsLegend ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <LegendSwatch fill={barFill('incomplete')} label="Floor — an unpriced required line (real cost is higher)" />
          <LegendSwatch fill={barFill('unsupported')} label="Can’t run this app — not a comparable total" />
        </div>
      ) : null}
    </div>
  );
}

function LegendSwatch({ fill, label }: { fill: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="14" height="14" aria-hidden className="shrink-0">
        <HatchDefs />
        <rect width="14" height="14" rx="2" fill={fill} stroke="hsl(0 0% 45% / 0.5)" strokeWidth="1" />
      </svg>
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Composition donut for the selected provider                                */
/* -------------------------------------------------------------------------- */

function CompositionChart({ estimate }: { estimate: ProviderEstimate }) {
  const data = React.useMemo(() => toComposition(estimate), [estimate]);

  if (data.length === 0) {
    return (
      <p className="flex h-64 items-center justify-center rounded-md bg-muted/30 p-4 text-center text-sm text-muted-foreground">
        No priced lines to break down yet for {PROVIDER_LABEL[estimate.provider]}.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="h-56 w-full sm:h-64 sm:w-1/2">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <HatchDefs />
            <Pie
              data={data}
              dataKey="monthlyUsd"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={1}
              isAnimationActive={false}
              // A pie of all-zero (only incomplete lines) still needs slices, so
              // fall back to an equal split when every value is 0.
              minAngle={data.every((d) => d.monthlyUsd === 0) ? 30 : 2}
            >
              {data.map((d, i) => (
                <Cell
                  key={d.role}
                  fill={d.incomplete ? `url(#${HATCH_INCOMPLETE})` : paletteColor(i)}
                  stroke="hsl(0 0% 100% / 0.6)"
                  strokeWidth={1}
                />
              ))}
            </Pie>
            <RTooltip content={<CompositionTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex w-full flex-col gap-1.5 text-xs sm:w-1/2">
        {data.map((d, i) => (
          <li key={d.role} className="flex items-center gap-2">
            <span
              className="size-3 shrink-0 rounded-sm"
              style={{ background: d.incomplete ? INCOMPLETE_BASE : paletteColor(i) }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{d.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {d.incomplete ? 'unpriced' : `${formatUsd(d.monthlyUsd)} · ${(d.share * 100).toFixed(0)}%`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Public                                                                     */
/* -------------------------------------------------------------------------- */

export interface ComparisonChartsProps {
  estimates: readonly ProviderEstimate[];
  /** The provider whose cost composition is shown (the active tab). */
  selected: ProviderEstimate;
}

export function ComparisonCharts({ estimates, selected }: ComparisonChartsProps) {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <div>
          <h3 className="text-sm font-medium">Monthly cost by provider</h3>
          <p className="text-xs text-muted-foreground">
            The same usage across every provider. Hatched bars aren&rsquo;t cheap — they couldn&rsquo;t be
            fully priced or can&rsquo;t run the app.
          </p>
        </div>
        <ProviderTotalsChart estimates={estimates} />
      </section>

      <section className="flex flex-col gap-2">
        <div>
          <h3 className="text-sm font-medium">
            Where the money goes — {PROVIDER_LABEL[selected.provider]}
          </h3>
          <p className="text-xs text-muted-foreground">
            Cost composition by role for the selected provider. A hatched slice is an unpriced
            required line (a floor), not a zero.
          </p>
        </div>
        <CompositionChart estimate={selected} />
      </section>
    </div>
  );
}
