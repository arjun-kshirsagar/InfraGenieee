'use client';

/**
 * Provider tabs — all five providers, seeded from the recommendation with the
 * recommended one preselected and badged "Recommended". Each tab shows the
 * provider's PRICED REGION (§region caveat) so a number is never mistaken for a
 * global truth, plus a small live monthly figure per provider so switching is
 * an informed choice, not a blind one.
 *
 * A provider that cannot run the app (has `unsupportedRoles`) is badged so the
 * user sees the gap before they even open the tab.
 *
 * These are card-shaped selectors, not a compact pill bar, so this uses the
 * Base UI Tabs primitives directly rather than the shadcn `TabsList` wrapper
 * (whose `h-8` pill styling would clip the multi-line cards).
 */

import * as React from 'react';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { Sparkles, TriangleAlert } from 'lucide-react';

import type { CloudProvider, ProviderEstimate } from '@/types/cost';
import { PROVIDER_LABEL, PRICED_REGION_LABEL } from '@/types/cost';
import { formatUsd } from '@/lib/cost/f2/format';
import { isEntirelyUnpriced } from '@/lib/cost/estimate/engine';
import { Badge } from '@/components/ui/badge';

export interface ProviderTabsProps {
  providers: CloudProvider[];
  active: CloudProvider;
  recommended: CloudProvider;
  /** Per-provider estimate, for the mini total + gap badge on each tab. */
  estimates: Record<string, ProviderEstimate | undefined>;
  onChange: (provider: CloudProvider) => void;
}

export function ProviderTabs({
  providers,
  active,
  recommended,
  estimates,
  onChange,
}: ProviderTabsProps) {
  return (
    <TabsPrimitive.Root value={active} onValueChange={(v) => onChange(v as CloudProvider)}>
      <TabsPrimitive.List className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {providers.map((provider) => {
          const est = estimates[provider];
          const unsupported = (est?.unsupportedRoles.length ?? 0) > 0;
          const incomplete = est?.incomplete ?? false;
          // Zero priced dimensions (services selected) → "not priced", never
          // "≥ $0.00" (MINOR-1).
          const notPriced = est ? isEntirelyUnpriced(est) : false;
          return (
            <TabsPrimitive.Tab
              key={provider}
              value={provider}
              className="flex min-w-0 cursor-pointer flex-col items-start gap-1 rounded-lg border bg-card p-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:border-primary aria-selected:bg-primary/5"
            >
              <div className="flex w-full min-w-0 items-center justify-between gap-1">
                <span className="truncate text-sm font-medium">{PROVIDER_LABEL[provider]}</span>
                {provider === recommended ? (
                  <Sparkles className="size-3.5 shrink-0 text-primary" aria-label="Recommended" />
                ) : null}
              </div>
              <span className="w-full truncate text-[10px] text-muted-foreground">
                {PRICED_REGION_LABEL[provider]}
              </span>
              <div className="flex w-full min-w-0 items-center justify-between gap-1">
                <span className="truncate text-sm font-semibold tabular-nums">
                  {!est
                    ? '—'
                    : notPriced
                      ? 'Not priced'
                      : `${incomplete ? '≥ ' : ''}${formatUsd(est.monthlyUsd)}`}
                </span>
                {unsupported ? (
                  <TriangleAlert
                    className="size-3.5 shrink-0 text-destructive"
                    aria-label="Cannot run this app"
                  />
                ) : null}
              </div>
              {provider === recommended ? (
                <Badge variant="secondary" className="text-[10px]">
                  Recommended
                </Badge>
              ) : null}
            </TabsPrimitive.Tab>
          );
        })}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}
