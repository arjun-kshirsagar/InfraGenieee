/**
 * InfraGenie — Feature 2 cost engine, step 2: estimate + compare.
 *
 *   estimateProvider(input) → ProviderEstimate
 *   compare(estimates, services, generatedAt) → CostComparison
 *
 * The engine does exactly the docs §7 arithmetic per priced dimension and
 * nothing else:
 *
 *     quantity = deriveQuantities(usage, sku, choice.units)[dimension.quantityKey]
 *     billable = max(0, quantity - record.includedQuantity)
 *     monthly  = (billable / dimension.pricePerUnits) * record.unitPriceUsd
 *
 * `pricePerUnits` (dimension-level, default 1) is how many quantityKey units one
 * `unitPriceUsd` buys — it makes the vendor's quoted scale machine-readable so a
 * bulk price ("USD / million requests") or a per-hour rate billed against a
 * per-month quantity ("USD / GiB-hour" vs a GbMonth key) is reconciled HERE, in
 * the one arithmetic site, with no per-provider special cases.
 *
 * and then decorates the result with the honesty affordances the whole feature
 * exists to guarantee:
 *
 *   🔴 unpriced ≠ free — a dimension with no surviving PriceRecord is
 *      `unpriced: true, monthlyUsd: 0, source: null`, and if it is `required`
 *      the line AND the estimate are `incomplete`. A failed fetch rendered as
 *      $0 would make a provider look cheap; that is the exact bug this prevents.
 *   🔴 a provider that cannot run the app (unsupportedRoles) never wins cheapest.
 *   🔴 cheapest / bestScaling / simplest are all nullable — with one provider or
 *      with every estimate incomplete there is no honest winner.
 *
 * PURE: no clock, no randomness, no env, no I/O. `CostComparison.generatedAt`
 * is PASSED IN by the caller, never read from the clock — that is what lets this
 * module import cleanly into a client component and drive live totals.
 *
 * Owned by: backend. Consumes the catalog (`CatalogService`) and price book
 * (`PriceRecord`) as plain data — it does not fetch either.
 */

import {
  type CatalogService,
  type CatalogSku,
  type CloudProvider,
  type CostComparison,
  type CostDimensionResult,
  type CostLineItem,
  type CostSelection,
  type InfraRole,
  type PriceRecord,
  type PriceSource,
  type ProviderEstimate,
  type QuantityKey,
  type RoleChoice,
  type UsageProfile,
} from '@/types/cost';

import { deriveQuantities } from './quantities';

/* -------------------------------------------------------------------------- */
/* Lookups (built from plain data — no I/O)                                   */
/* -------------------------------------------------------------------------- */

/** Key for a price record: `${skuId}|${dimensionId}`, matching the price book's
 *  own uniqueness key (see `priceBookSchema.superRefine`). */
function priceKey(skuId: string, dimensionId: string): string {
  return `${skuId}|${dimensionId}`;
}

/** Index price records by `skuId|dimensionId` for O(1) lookup. Duplicate keys
 *  are a price-book parse error upstream, so last-write-wins here is safe. */
function indexPrices(records: readonly PriceRecord[]): Map<string, PriceRecord> {
  const m = new Map<string, PriceRecord>();
  for (const r of records) m.set(priceKey(r.skuId, r.dimensionId), r);
  return m;
}

/** Index SKUs by id and remember which service each belongs to (for names and
 *  editorial scores). */
interface SkuEntry {
  sku: CatalogSku;
  service: CatalogService;
}

function indexSkus(services: readonly CatalogService[]): Map<string, SkuEntry> {
  const m = new Map<string, SkuEntry>();
  for (const service of services) {
    for (const sku of service.skus) m.set(sku.id, { sku, service });
  }
  return m;
}

function indexServices(services: readonly CatalogService[]): Map<string, CatalogService> {
  const m = new Map<string, CatalogService>();
  for (const s of services) m.set(s.id, s);
  return m;
}

/** ISO-8601 min: the lexicographic min of two ISO timestamps is the earlier
 *  one, so a string compare is correct and needs no Date parsing (which would
 *  be impure-ish and slower). `null` means "nothing priced yet". */
function earlier(a: string | null, b: string): string {
  return a === null || b < a ? b : a;
}

/* -------------------------------------------------------------------------- */
/* Per-dimension pricing                                                      */
/* -------------------------------------------------------------------------- */

interface DimensionOutcome {
  result: CostDimensionResult;
  /** True when this dimension is `required` AND unpriced — makes the line
   *  incomplete. An OPTIONAL unpriced dimension does not. */
  makesIncomplete: boolean;
  /** The source used, for the estimate's oldestPriceAt fold. */
  source: PriceSource | null;
  warning: string | null;
}

/**
 * Price one dimension of one SKU. Implements the §7 formula and the unpriced≠
 * free rule. `quantity` is the already-unit-multiplied quantity for this
 * dimension's `quantityKey`.
 */
function priceDimension(
  dimension: CatalogSku['dimensions'][number],
  quantity: number,
  record: PriceRecord | undefined,
): DimensionOutcome {
  const base = {
    dimensionId: dimension.id,
    label: dimension.label,
    unit: dimension.unit,
    quantityKey: dimension.quantityKey,
    quantity,
  };

  // 🔴 No surviving price record → unpriced, NOT free.
  if (record === undefined) {
    return {
      result: {
        ...base,
        includedQuantity: 0,
        billableQuantity: 0,
        unitPriceUsd: 0,
        monthlyUsd: 0,
        source: null,
        unpriced: true,
      },
      makesIncomplete: dimension.required,
      source: null,
      warning: null,
    };
  }

  // §7 arithmetic — exactly this, nothing else.
  //
  // 🔴 `pricePerUnits` (dimension-level, default 1) is how many quantityKey
  // units one `unitPriceUsd` buys — the fix for BLOCKER-1/2. Dividing billable
  // by it reconciles the vendor's quoted scale with our single-item / per-month
  // quantity vocabulary in ONE place, with NO per-provider special cases:
  //   • bulk unit ("USD / million requests" → pricePerUnits 1_000_000):
  //       10_000_000 req / 1_000_000 × $0.40 = $4.00   (not $4,000,000)
  //   • per-hour rate vs per-month quantity ("USD / GiB-hour", GbMonth key →
  //     pricePerUnits 1/730): 500 GiB / (1/730) × $0.0000274 = $10.00 (not $0.01)
  // Default 1 leaves already-per-unit prices (per-hour nodes, per-GB egress,
  // per-month plan fees) unchanged.
  const billableQuantity = Math.max(0, quantity - record.includedQuantity);
  const monthlyUsd = (billableQuantity / dimension.pricePerUnits) * record.unitPriceUsd;

  return {
    result: {
      ...base,
      includedQuantity: record.includedQuantity,
      billableQuantity,
      unitPriceUsd: record.unitPriceUsd,
      monthlyUsd,
      source: record.source,
      unpriced: false,
    },
    makesIncomplete: false,
    source: record.source,
    warning: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-line-item (one role choice)                                            */
/* -------------------------------------------------------------------------- */

interface LineOutcome {
  item: CostLineItem;
  /** ISO-8601 of the oldest price used in this line, or null if nothing priced. */
  oldestPriceAt: string | null;
  warnings: string[];
}

function estimateLine(
  usage: UsageProfile,
  choice: RoleChoice,
  entry: SkuEntry,
  prices: Map<string, PriceRecord>,
): LineOutcome {
  const { sku, service } = entry;
  const quantities: Record<QuantityKey, number> = deriveQuantities(usage, sku, choice.units);

  const dimensions: CostDimensionResult[] = [];
  const warnings: string[] = [];
  let lineIncomplete = false;
  let monthlyUsd = 0;
  let oldest: string | null = null;

  for (const dim of sku.dimensions) {
    const record = prices.get(priceKey(sku.id, dim.id));
    const outcome = priceDimension(dim, quantities[dim.quantityKey], record);
    dimensions.push(outcome.result);
    monthlyUsd += outcome.result.monthlyUsd;
    if (outcome.makesIncomplete) lineIncomplete = true;
    if (outcome.source) oldest = earlier(oldest, outcome.source.fetchedAt);
    if (outcome.warning) warnings.push(outcome.warning);
  }

  const item: CostLineItem = {
    role: choice.role,
    serviceId: service.id,
    serviceName: service.name,
    skuId: sku.id,
    skuName: sku.displayName,
    units: choice.units,
    dimensions,
    monthlyUsd,
    incomplete: lineIncomplete,
  };

  return { item, oldestPriceAt: oldest, warnings };
}

/* -------------------------------------------------------------------------- */
/* Per-provider estimate                                                      */
/* -------------------------------------------------------------------------- */

export interface EstimateProviderInput {
  usage: UsageProfile;
  selection: CostSelection;
  /** Catalog services. May be the whole catalog or just this provider's slice —
   *  only the ids referenced by the selection are read. */
  services: readonly CatalogService[];
  /** Fetched, cited price records. Only this provider's are read. */
  priceRecords: readonly PriceRecord[];
  /** Region the prices are pinned to (from `PRICED_REGION`). */
  region: string;
  /** Roles the PRD requires. Any required role this provider has no enabled,
   *  priceable choice for becomes an `unsupportedRoles` gap. */
  requiredRoles?: readonly InfraRole[];
}

/**
 * Estimate one provider's monthly cost for a selection. Pure.
 *
 * - `enabled: false` choices contribute nothing but are skipped silently (they
 *   remain visible upstream in the selection; the estimate simply doesn't
 *   total them). A disabled choice never satisfies a required role.
 * - A required role with no enabled choice that this provider can actually serve
 *   is reported in `unsupportedRoles` — a provider is NOT cheaper for being
 *   unable to run part of the app.
 */
export function estimateProvider(input: EstimateProviderInput): ProviderEstimate {
  const { usage, selection, region } = input;
  const requiredRoles = input.requiredRoles ?? [];

  const skuIndex = indexSkus(input.services);
  const prices = indexPrices(input.priceRecords);

  // Which roles this provider offers ANY service for at all — used to tell
  // "provider genuinely can't do this" (unsupported) from "user turned it off".
  const providerRoles = new Set<InfraRole>();
  for (const svc of input.services) {
    if (svc.provider === selection.provider) providerRoles.add(svc.role);
  }

  const items: CostLineItem[] = [];
  const warnings: string[] = [];
  let monthlyUsd = 0;
  let incomplete = false;
  let oldestPriceAt: string | null = null;

  // Roles the selection actually satisfies with an enabled, resolvable choice.
  const satisfiedRoles = new Set<InfraRole>();

  for (const choice of selection.choices) {
    if (!choice.enabled) {
      // Disabled: contributes 0, does not satisfy its role. (Stays visible in
      // the selection object upstream; we just don't total it.)
      continue;
    }

    const entry = skuIndex.get(choice.skuId);
    if (!entry) {
      // A choice referencing a SKU the catalog does not contain cannot be
      // priced. Treat the role as unmet and warn — do NOT silently drop to $0.
      warnings.push(
        `Choice for role "${choice.role}" references unknown SKU "${choice.skuId}"; it was skipped.`,
      );
      continue;
    }

    const line = estimateLine(usage, choice, entry, prices);
    items.push(line.item);
    monthlyUsd += line.item.monthlyUsd;
    satisfiedRoles.add(choice.role);
    if (line.item.incomplete) incomplete = true;
    if (line.oldestPriceAt) oldestPriceAt = earlier(oldestPriceAt, line.oldestPriceAt);
    warnings.push(...line.warnings);

    // Surface an explicit unpriced warning so the user knows WHY a line is a
    // floor rather than an estimate.
    if (line.item.incomplete) {
      warnings.push(
        `${line.item.serviceName} (${choice.role}) has an unpriced required dimension — its total is a floor, not a full estimate.`,
      );
    }
  }

  // 🔴 unsupportedRoles: required roles this provider offers NO service for.
  // A required role the provider *does* offer but the user left unselected is a
  // selection gap, not a provider limitation, so it does not land here.
  const unsupportedRoles = requiredRoles.filter((r) => !providerRoles.has(r));

  // A required role the provider CAN serve but the selection left unsatisfied
  // (no enabled choice) also makes the estimate incomplete — the total is
  // missing a component the app needs.
  for (const role of requiredRoles) {
    if (providerRoles.has(role) && !satisfiedRoles.has(role)) {
      incomplete = true;
      warnings.push(
        `Required role "${role}" has no enabled choice for ${selection.provider}; the total is missing it.`,
      );
    }
  }

  return {
    provider: selection.provider,
    region,
    items,
    monthlyUsd,
    unsupportedRoles,
    incomplete,
    oldestPriceAt,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Comparison + badges                                                        */
/* -------------------------------------------------------------------------- */

/** Sum a per-service editorial score over the enabled, resolvable choices of an
 *  estimate. Used for the bestScaling / simplest badges. Unpriced lines still
 *  count — the score is a property of the service, not its price. */
function sumServiceScore(
  estimate: ProviderEstimate,
  serviceIndex: Map<string, CatalogService>,
  pick: (s: CatalogService) => number,
): number {
  let total = 0;
  for (const item of estimate.items) {
    const svc = serviceIndex.get(item.serviceId);
    if (svc) total += pick(svc);
  }
  return total;
}

/**
 * Pick the winner: the estimate maximising `score`, resolving ties by provider
 * order (first in the array wins) for determinism. Returns null if `candidates`
 * is empty.
 */
function argmax(
  candidates: readonly ProviderEstimate[],
  score: (e: ProviderEstimate) => number,
): CloudProvider | null {
  let best: ProviderEstimate | null = null;
  let bestScore = -Infinity;
  for (const e of candidates) {
    const s = score(e);
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  return best ? best.provider : null;
}

/**
 * Pick the cheapest: the estimate minimising `monthlyUsd` among COMPLETE
 * estimates that can actually run the app (no unsupportedRoles). Ties resolve to
 * the first in array order. Returns null when no estimate qualifies.
 */
function argminCost(candidates: readonly ProviderEstimate[]): CloudProvider | null {
  let best: ProviderEstimate | null = null;
  let bestCost = Infinity;
  for (const e of candidates) {
    if (e.monthlyUsd < bestCost) {
      bestCost = e.monthlyUsd;
      best = e;
    }
  }
  return best ? best.provider : null;
}

/** True when the estimate has at least one dimension that carries a real,
 *  gate-proven price (a non-null `source`). Used to distinguish "priced at zero"
 *  (a real, gate-proven price that computes to $0 — a provider EARNED the zero)
 *  from "couldn't price at all" (below). */
export function hasAnyPricedDimension(estimate: ProviderEstimate): boolean {
  return estimate.items.some((item) =>
    item.dimensions.some((d) => !d.unpriced && d.source !== null),
  );
}

/**
 * True when the estimate has line items but NONE of them carry a single priced
 * dimension — i.e. services WERE selected but every price is a gap, so the whole
 * price book is missing (the Azure BLOCKER-3 case). Such an estimate's
 * `monthlyUsd` is a $0 floor of pure unknowns, not a comparable cost: it must
 * NOT win a price-adjacent badge (RC3), must sort last (RC4), and must render as
 * "not priced" rather than "≥ $0.00" (MINOR-1).
 *
 * 🔴 This is deliberately NOT the same as `monthlyUsd === 0`: a provider whose
 * priced dimensions genuinely total $0 (e.g. only free-tier lines) HAS priced
 * dimensions and "earned the zero" — it stays priced. And an estimate with NO
 * items at all (an empty selection) is a separate degenerate state, not this
 * one.
 */
export function isEntirelyUnpriced(estimate: ProviderEstimate): boolean {
  return estimate.items.length > 0 && !hasAnyPricedDimension(estimate);
}

export interface CompareInput {
  estimates: readonly ProviderEstimate[];
  /** Catalog services, for the editorial-score badges. */
  services: readonly CatalogService[];
  /** ISO-8601 timestamp, PASSED IN by the caller — never read from the clock.
   *  This keeps the engine pure and testable to the byte. */
  generatedAt: string;
}

/**
 * Compare provider estimates and award the three badges. Pure.
 *
 * 🔴 All three badges are nullable:
 *   - `cheapest`: lowest `monthlyUsd` among COMPLETE estimates with NO
 *     unsupportedRoles. Null when fewer than two estimates, or none qualifies.
 *   - `bestScaling`: highest summed `scalingScore`. Null when < 2 estimates.
 *   - `simplest`: highest summed `simplicityScore`. Null when < 2 estimates.
 *
 * With a single provider there is nothing to compare, so every badge is null —
 * naming a "winner" of a field of one is not an honest comparison.
 */
export function compare(input: CompareInput): CostComparison {
  const { estimates, generatedAt } = input;
  const serviceIndex = indexServices(input.services);

  // With one (or zero) provider there is no honest comparison to make.
  const hasComparison = estimates.length >= 2;

  // cheapest considers ONLY complete estimates that can run the whole app.
  const cheapestCandidates = estimates.filter(
    (e) => !e.incomplete && e.unsupportedRoles.length === 0,
  );

  const cheapest = hasComparison ? argminCost(cheapestCandidates) : null;

  // 🔴 bestScaling / simplest are editorial scores, but docs §8 forbids them
  // from standing in for a MISSING price. A provider whose price book is 100%
  // missing (services selected, zero priced dimensions) has a $0 floor of pure
  // unknowns — it must never win a badge on the strength of a scaling/simplicity
  // score alone (RC3 / BLOCKER-3). Filter those out before the argmax. (A
  // provider that is merely `incomplete` — some priced, one required line
  // unpriced — still qualifies: it has real prices and the score is honestly
  // earned. A provider that priced genuinely $0 also qualifies — it earned it.)
  const scored = estimates.filter((e) => !isEntirelyUnpriced(e));

  const bestScaling = hasComparison
    ? argmax(scored, (e) => sumServiceScore(e, serviceIndex, (s) => s.scalingScore))
    : null;
  const simplest = hasComparison
    ? argmax(scored, (e) => sumServiceScore(e, serviceIndex, (s) => s.simplicityScore))
    : null;

  return {
    generatedAt,
    estimates: [...estimates],
    cheapest,
    bestScaling,
    simplest,
  };
}
