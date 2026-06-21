'use client';

/**
 * Side-by-side provider comparison — the "which provider should I pick" view.
 *
 * All providers over ONE shared usage profile, each with its own selection.
 * Per provider card: badges (from the engine), monthly total, priced region,
 * per-role line summary, and the recommendation's pros/cons.
 *
 * 🔴 Honesty rules carried over verbatim from the selectors view:
 *  - A provider with `unsupportedRoles` is marked "can't run this app", sinks
 *    to the bottom (via `buildComparisonRows`), and is never the cheap option
 *    (the engine excludes it from `cheapest`).
 *  - An `incomplete` estimate shows its total as a FLOOR (≥), flagged.
 *  - Nothing unpriced ever renders as $0.00 — the row summary shows the floor.
 *
 * The row shaping + badge resolution are pure (`@/lib/cost/f3/comparison`); this
 * component only renders.
 */

import * as React from 'react';
import { MapPin, TriangleAlert, Sparkles, Check, X } from 'lucide-react';

import type { CloudProvider, CostComparison } from '@/types/cost';
import { buildComparisonRows, type ComparisonRow } from '@/lib/cost/f3/comparison';
import type { ProviderTradeoff } from '@/lib/cost/f3/export-md';
import { formatUsd } from '@/lib/cost/f2/format';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

import { ProviderBadges } from './comparison-badges';

export interface ProviderComparisonProps {
  comparison: CostComparison;
  tradeoffs: readonly ProviderTradeoff[];
  recommended: CloudProvider;
  /** Which provider is the active tab, highlighted here for continuity. */
  active: CloudProvider;
  onSelect?: (provider: CloudProvider) => void;
}

export function ProviderComparison({
  comparison,
  tradeoffs,
  recommended,
  active,
  onSelect,
}: ProviderComparisonProps) {
  const rows = React.useMemo(
    () => buildComparisonRows(comparison.estimates, comparison),
    [comparison],
  );
  const tradeoffByProvider = React.useMemo(() => {
    const m = new Map<CloudProvider, ProviderTradeoff>();
    for (const t of tradeoffs) m.set(t.provider, t);
    return m;
  }, [tradeoffs]);

  return (
    <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => (
        <ProviderCard
          key={row.provider}
          row={row}
          comparison={comparison}
          tradeoff={tradeoffByProvider.get(row.provider)}
          isRecommended={row.provider === recommended}
          isActive={row.provider === active}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function ProviderCard({
  row,
  comparison,
  tradeoff,
  isRecommended,
  isActive,
  onSelect,
}: {
  row: ComparisonRow;
  comparison: CostComparison;
  tradeoff: ProviderTradeoff | undefined;
  isRecommended: boolean;
  isActive: boolean;
  onSelect?: (provider: CloudProvider) => void;
}) {
  const clickable = Boolean(onSelect);
  return (
    <Card
      className={[
        'transition-colors',
        isActive ? 'ring-2 ring-primary' : '',
        !row.runnable ? 'opacity-90' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-current={isActive ? 'true' : undefined}
    >
      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={!clickable}
            onClick={() => onSelect?.(row.provider)}
            className="inline-flex items-center gap-1.5 text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:no-underline"
          >
            {row.providerLabel}
            {isRecommended ? (
              <Sparkles className="size-3.5 text-primary" aria-label="Recommended" />
            ) : null}
          </button>
          <ProviderBadges comparison={comparison} provider={row.provider} />
        </div>

        {/* Total — floor / unsupported / not-priced honesty carried over */}
        {row.runnable ? (
          row.notPriced ? (
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold tracking-tight text-muted-foreground">
                Not priced
              </span>
            </div>
          ) : (
            <div className="flex items-baseline gap-1.5">
              {row.incomplete ? (
                <span className="text-xs font-medium text-amber-600">at least</span>
              ) : null}
              <span className="text-2xl font-semibold tabular-nums tracking-tight">
                {formatUsd(row.monthlyUsd)}
              </span>
              <span className="text-xs text-muted-foreground">/mo</span>
            </div>
          )
        ) : (
          <div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            Can&rsquo;t run this app
          </div>
        )}

        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="size-3" aria-hidden />
          {row.regionLabel}
        </div>

        {row.notPriced && row.runnable ? (
          <p className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">
            Not priced — we couldn&rsquo;t verify a single price for this provider, so there is no cost
            to compare (not $0.00).
          </p>
        ) : null}

        {row.incomplete && !row.notPriced && row.runnable ? (
          <p className="rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
            Floor, not a full estimate — a required price couldn&rsquo;t be verified, so real cost is
            higher.
          </p>
        ) : null}

        {!row.runnable ? (
          <p className="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
            Missing: {row.unsupportedRoleLabels.join(', ')}. Not comparable to providers that can
            run the app.
          </p>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {/* Per-role line summary */}
        {row.lines.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs">
            {row.lines.map((line) => (
              <li key={line.role} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  <span className="text-foreground">{line.roleLabel}</span>{' '}
                  <span className="text-muted-foreground/80">
                    · {line.serviceName}
                    {line.units > 1 ? ` ×${line.units}` : ''}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {line.incomplete ? '≥ ' : ''}
                  {formatUsd(line.monthlyUsd)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No services selected.</p>
        )}

        {/* Trade-offs (pros / cons) */}
        {tradeoff ? (
          <div className="flex flex-col gap-1.5 border-t pt-2">
            <ul className="flex flex-col gap-0.5">
              {tradeoff.pros.map((p, i) => (
                <li key={`pro-${i}`} className="flex items-start gap-1.5 text-xs">
                  <Check className="mt-0.5 size-3 shrink-0 text-emerald-600" aria-label="Pro" />
                  <span className="text-muted-foreground">{p}</span>
                </li>
              ))}
              {tradeoff.cons.map((c, i) => (
                <li key={`con-${i}`} className="flex items-start gap-1.5 text-xs">
                  <X className="mt-0.5 size-3 shrink-0 text-destructive" aria-label="Con" />
                  <span className="text-muted-foreground">{c}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A small "no honest winner" note, shown when every badge award is null (one
 *  provider, or every estimate a floor). Rendered by the parent alongside the
 *  badge strip so the absence is explained, not silent. */
export function NoWinnerNote({ comparison }: { comparison: CostComparison }) {
  const hasWinner =
    comparison.cheapest !== null ||
    comparison.bestScaling !== null ||
    comparison.simplest !== null;
  if (hasWinner) return null;
  return (
    <p className="text-xs text-muted-foreground">
      No single winner to crown yet — with one provider, or when every estimate is a floor, there
      isn&rsquo;t an honest comparison to make.
    </p>
  );
}
