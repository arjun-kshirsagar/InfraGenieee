'use client';

/**
 * Comparison badges — `cheapest`, `bestScaling`, `simplest`.
 *
 * 🔴 The winners come straight from the engine's `compare()` (via
 * `resolveBadges`). This component NEVER decides a winner. When an award is
 * `null` (one provider selected, or every estimate a floor → no honest winner)
 * `resolveBadges` returns nothing for it and we render nothing — no invented
 * "winner of a field of one".
 *
 * Each badge has a tooltip explaining what it means and where it comes from.
 * The `bestScaling` / `simplest` tooltips state explicitly that they are
 * editorial judgements (from each service's `tradeoff` line), NOT price claims.
 */

import * as React from 'react';
import { Coins, TrendingUp, Feather, Info } from 'lucide-react';

import type { CostComparison } from '@/types/cost';
import { resolveBadges, type BadgeKind } from '@/lib/cost/f3/comparison';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const BADGE_ICON: Record<BadgeKind, React.ComponentType<{ className?: string }>> = {
  cheapest: Coins,
  bestScaling: TrendingUp,
  simplest: Feather,
};

const BADGE_TONE: Record<BadgeKind, string> = {
  cheapest: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  bestScaling: 'border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  simplest: 'border-violet-500/50 bg-violet-500/10 text-violet-700 dark:text-violet-400',
};

export interface ComparisonBadgesProps {
  comparison: CostComparison;
  /** When true, prefixes each badge with the winning provider's name (used in
   *  the summary row). When false, just the badge (used inside a provider card,
   *  where the provider is already obvious). */
  showProvider?: boolean;
  className?: string;
}

/** The full badge row (summary strip). Renders the winners, each with a why. */
export function ComparisonBadges({
  comparison,
  showProvider = true,
  className,
}: ComparisonBadgesProps) {
  const badges = resolveBadges(comparison);
  if (badges.length === 0) return null;

  return (
    <TooltipProvider>
      <div className={className ?? 'flex flex-wrap items-center gap-2'}>
        {badges.map((b) => {
          const Icon = BADGE_ICON[b.kind];
          return (
            <Tooltip key={b.kind}>
              <TooltipTrigger
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${BADGE_TONE[b.kind]}`}
                aria-label={`${b.label}: ${b.providerLabel}. ${b.explanation}`}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden />
                <span>
                  {b.label}
                  {showProvider ? <span className="font-semibold">{`: ${b.providerLabel}`}</span> : null}
                </span>
                <Info className="size-3 opacity-60" aria-hidden />
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">
                  {b.label} — {b.providerLabel}
                </p>
                <p className="mt-1 text-muted-foreground">{b.explanation}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

/** Compact badges FOR ONE PROVIDER (rendered inside its card). Filters the
 *  resolved winners down to those this provider won. Returns null if none. */
export function ProviderBadges({
  comparison,
  provider,
}: {
  comparison: CostComparison;
  provider: CostComparison['estimates'][number]['provider'];
}) {
  const badges = resolveBadges(comparison).filter((b) => b.provider === provider);
  if (badges.length === 0) return null;

  return (
    <TooltipProvider>
      <div className="flex flex-wrap gap-1.5">
        {badges.map((b) => {
          const Icon = BADGE_ICON[b.kind];
          return (
            <Tooltip key={b.kind}>
              <TooltipTrigger
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${BADGE_TONE[b.kind]}`}
                aria-label={`${b.label}. ${b.explanation}`}
              >
                <Icon className="size-3 shrink-0" aria-hidden />
                {b.label}
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">{b.label}</p>
                <p className="mt-1 text-muted-foreground">{b.explanation}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

/** A tiny inline suppressed Badge kept for parity if a static (non-tooltip)
 *  pill is ever needed. Currently unused by the comparison view. */
export function StaticBadge({ label }: { label: string }) {
  return <Badge variant="secondary">{label}</Badge>;
}
