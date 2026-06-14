'use client';

/**
 * F2 — the interactive cost selectors + live-updating totals. This is the
 * centerpiece the brief calls out. It replaces F1's placeholder inside the
 * explorer frame and owns all the interactive state:
 *
 *   - `usage`: the editable UsageProfile (seeded from the recommendation),
 *   - `selections`: one editable CostSelection per provider,
 *   - `active`: which provider tab is open.
 *
 * 🔴 LIVE = LOCAL. Every estimate is recomputed IN THE BROWSER with the pure
 * engine (`estimateProvider`) on every change — a toggle, a slider, a SKU swap
 * is a re-render, NOT a network call. `POST /api/cost/estimate` is never called
 * here (it exists only for tests / shareable links). Verify in the Network tab:
 * dragging a slider fires zero requests.
 *
 * State is mirrored to `localStorage` (via `@/lib/cost/f2/store`, zod-validated
 * on read → `null` on mismatch) so a reload doesn't lose the user's work, and a
 * corrupt/stale blob is ignored rather than fatal.
 */

import * as React from 'react';

import type { CostData } from '@/app/cost/cost-client';
import {
  CLOUD_PROVIDERS,
  PRICED_REGION,
  PRICED_REGION_LABEL,
  PROVIDER_LABEL,
  type CloudProvider,
  type CostSelection,
  type PriceRecord,
  type ProviderEstimate,
  type UsageProfile,
  type InfraRole,
} from '@/types/cost';
import { estimateProvider, compare } from '@/lib/cost/estimate';
import {
  buildRoleRows,
  seedAllSelections,
  setService,
  setSku,
  setUnits,
  setEnabled,
} from '@/lib/cost/f2/selection';
import { clampUsageValue, type UsageKey } from '@/lib/cost/f2/usage';
import { formatUsd } from '@/lib/cost/f2/format';
import { loadCostState, saveCostState } from '@/lib/cost/f2/store';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

import { ProviderTabs } from './provider-tabs';
import { MonthlyTotal } from './monthly-total';
import { RoleSelectorRow } from './role-selector-row';
import { CostBreakdown } from './cost-breakdown';
import { UsageSliders } from './usage-sliders';
import { ComparisonBadges } from './comparison-badges';
import { ComparisonCharts } from './comparison-charts';
import { ProviderComparison, NoWinnerNote } from './provider-comparison';
import { CostExport } from './cost-export';

export interface CostSelectorsProps {
  data: CostData;
}

export function CostSelectors({ data }: CostSelectorsProps) {
  const { doc, catalog, books, requiredRoles, recommendation } = data;
  const rec = recommendation.recommendation;

  // Price records indexed by provider, from the loaded books (client-side data
  // — no key, no re-fetch). A provider with no book simply has no priced rows.
  const recordsByProvider = React.useMemo(() => {
    const m = new Map<CloudProvider, PriceRecordList>();
    for (const book of books) m.set(book.provider, book.records);
    return m;
  }, [books]);

  // ---- seed initial state: persisted (if valid) else recommendation --------
  const [usage, setUsage] = React.useState<UsageProfile>(() => rec.usageProfile);
  const [selections, setSelections] = React.useState<Record<string, CostSelection>>(() =>
    seedAllSelections(catalog, CLOUD_PROVIDERS, requiredRoles, rec),
  );
  const [active, setActive] = React.useState<CloudProvider>(() => rec.recommendedProvider);

  // On mount, hydrate from localStorage if a valid, current-version blob exists.
  // Runs once; a corrupt/stale blob returns null and we keep the seed.
  const hydratedRef = React.useRef(false);
  React.useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const saved = loadCostState(doc.id);
    if (!saved) return;
    // Rehydrate persisted work on mount (React↔localStorage sync).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUsage(saved.usage);
    setSelections((prev) => ({ ...prev, ...saved.selections }));
    if (CLOUD_PROVIDERS.includes(saved.activeProvider as CloudProvider)) {
      setActive(saved.activeProvider as CloudProvider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on any change (after the initial hydrate attempt). Best-effort.
  React.useEffect(() => {
    if (!hydratedRef.current) return;
    saveCostState(doc.id, { usage, activeProvider: active, selections });
  }, [doc.id, usage, active, selections]);

  // ---- 🔴 live, LOCAL estimates for every provider (pure engine) -----------
  // Recomputed on any state change with useMemo — never a network round-trip.
  const estimates = React.useMemo(() => {
    const out: Record<string, ProviderEstimate> = {};
    for (const provider of CLOUD_PROVIDERS) {
      const selection = selections[provider];
      if (!selection) continue;
      out[provider] = estimateProvider({
        usage,
        selection,
        services: catalog.services,
        priceRecords: recordsByProvider.get(provider) ?? [],
        region: PRICED_REGION[provider],
        requiredRoles,
      });
    }
    return out;
  }, [usage, selections, catalog.services, recordsByProvider, requiredRoles]);

  // A single, stable `now` per render pass for relative-age labels (avoids a
  // hydration mismatch — never read the clock during the render body itself).
  const [now, setNow] = React.useState<number>(() => 0);
  React.useEffect(() => {
    // Read the clock once after mount (never in render → no hydration mismatch).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
  }, []);

  // ---- 🔴 comparison + badges, straight from the pure engine ---------------
  // The estimates array in provider-enum order (stable for the chart), fed to
  // `compare()` which awards cheapest / bestScaling / simplest. The UI NEVER
  // recomputes a winner — it renders whatever the engine returns (nullable).
  // `generatedAt` is derived from the mount clock so the render stays pure.
  const orderedEstimates = React.useMemo(
    () => CLOUD_PROVIDERS.map((p) => estimates[p]).filter((e): e is ProviderEstimate => Boolean(e)),
    [estimates],
  );
  const comparison = React.useMemo(
    () =>
      compare({
        estimates: orderedEstimates,
        services: catalog.services,
        // Stable within a session; only affects the export's "generated" line.
        generatedAt: new Date(now || 0).toISOString(),
      }),
    [orderedEstimates, catalog.services, now],
  );

  const activeSelection = selections[active];
  const activeEstimate = estimates[active];
  const roleRows = React.useMemo(
    () =>
      activeSelection ? buildRoleRows(catalog, active, requiredRoles, activeSelection) : [],
    [catalog, active, requiredRoles, activeSelection],
  );

  // ---- mutation handlers (pure reducers, immutable state) ------------------
  const mutate = React.useCallback(
    (provider: CloudProvider, fn: (s: CostSelection) => CostSelection) => {
      setSelections((prev) => {
        const current = prev[provider];
        if (!current) return prev;
        return { ...prev, [provider]: fn(current) };
      });
    },
    [],
  );

  const onServiceChange = (role: InfraRole, serviceId: string) =>
    mutate(active, (s) => setService(catalog, s, role, serviceId));
  const onSkuChange = (role: InfraRole, skuId: string) =>
    mutate(active, (s) => setSku(catalog, s, role, skuId));
  const onUnitsChange = (role: InfraRole, units: number) =>
    mutate(active, (s) => setUnits(s, role, units));
  const onEnabledChange = (role: InfraRole, enabled: boolean) =>
    mutate(active, (s) => setEnabled(s, role, enabled));
  const onUsageChange = (key: UsageKey, value: number) =>
    setUsage((prev) => ({ ...prev, [key]: clampUsageValue(key, value) }));

  return (
    <div className="flex flex-col gap-6">
      {/* Provider tabs with live mini-totals */}
      <ProviderTabs
        providers={[...CLOUD_PROVIDERS]}
        active={active}
        recommended={rec.recommendedProvider}
        estimates={estimates}
        onChange={setActive}
      />

      {activeEstimate ? (
        <Card>
          <CardHeader className="gap-4">
            <MonthlyTotal
              estimate={activeEstimate}
              regionLabel={PRICED_REGION_LABEL[active]}
            />
          </CardHeader>
        </Card>
      ) : null}

      {/* Usage drivers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage</CardTitle>
          <CardDescription>
            Adjust the traffic and storage your app expects — every total below updates instantly,
            with no page reload or server call.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UsageSliders usage={usage} onChange={onUsageChange} />
        </CardContent>
      </Card>

      {/* Per-role selectors */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Services for {PROVIDER_LABEL[active]}</CardTitle>
          <CardDescription>
            Pick a service and size for each capability your PRD needs. Turn a role off to see its
            impact — it stays visible so you know what you excluded.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {roleRows.length === 0 ? (
            <p className="rounded-md bg-muted/40 p-4 text-center text-sm text-muted-foreground">
              No roles to configure for this PRD.
            </p>
          ) : (
            roleRows.map((row) => (
              <RoleSelectorRow
                key={row.role}
                row={row}
                onServiceChange={onServiceChange}
                onSkuChange={onSkuChange}
                onUnitsChange={onUnitsChange}
                onEnabledChange={onEnabledChange}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Breakdown */}
      {activeEstimate ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cost breakdown</CardTitle>
            <CardDescription>
              Expand a service to see the exact maths: quantity → included → billable → unit price →
              monthly. Every priced row links to the vendor page it came from.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CostBreakdown items={activeEstimate.items} now={now} />
            <Separator className="my-4" />
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Total for {PROVIDER_LABEL[active]}</span>
              <span className="text-lg font-semibold tabular-nums">
                {activeEstimate.incomplete ? '≥ ' : ''}
                {formatUsd(activeEstimate.monthlyUsd)}
              </span>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* F3 — side-by-side comparison, charts, badges, trade-offs, export. */}
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Compare all providers</h2>
          <p className="text-sm text-muted-foreground">
            The same usage across every provider — updates live as you change the sliders or a
            provider&rsquo;s services. Badges come from the estimate itself, not a guess.
          </p>
        </div>

        {/* Badges (from compare()) + export */}
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-col gap-2">
                <CardTitle className="text-base">Recommended picks</CardTitle>
                <ComparisonBadges comparison={comparison} />
                <NoWinnerNote comparison={comparison} />
              </div>
              <CostExport
                title={doc.title}
                comparison={comparison}
                tradeoffs={rec.tradeoffs}
              />
            </div>
          </CardHeader>
        </Card>

        {/* Charts: grouped bar (money shot) + composition for the active provider */}
        {orderedEstimates.length > 0 && activeEstimate ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Visual comparison</CardTitle>
              <CardDescription>
                Monthly cost per provider, and where the selected provider&rsquo;s money goes.
                Hatched means &ldquo;couldn&rsquo;t fully price&rdquo; or &ldquo;can&rsquo;t run this
                app&rdquo; — never a cheap zero.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ComparisonCharts estimates={orderedEstimates} selected={activeEstimate} />
            </CardContent>
          </Card>
        ) : null}

        {/* Side-by-side provider cards with trade-offs */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Side by side</CardTitle>
            <CardDescription>
              Every provider over your shared usage. Click a card to open its detailed selectors
              above. A provider that can&rsquo;t run the app is marked and never shown as the cheap
              option.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProviderComparison
              comparison={comparison}
              tradeoffs={rec.tradeoffs}
              recommended={rec.recommendedProvider}
              active={active}
              onSelect={setActive}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

type PriceRecordList = readonly PriceRecord[];
