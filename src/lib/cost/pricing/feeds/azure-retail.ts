/**
 * InfraGenie — Azure Retail Prices API adapter (task B4).
 *
 * SERVER-ONLY. Free, public, unauthenticated read (docs §4/§10). No SDK, no
 * credentials — plain HTTPS GETs against:
 *
 *   GET https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview
 *       &currencyCode=USD&$filter=<filter>
 *
 * This adapter exists because EVERY `azure.microsoft.com/.../pricing/details/**`
 * page renders its prices as literally `$-` (JS-injected after load) — Tavily
 * physically cannot price Azure (docs §4).
 *
 * Shape (verified 2026-07-26): `{ Items: [{ retailPrice, unitOfMeasure ("1 Hour",
 * "1 GB/Month"), meterName, productName, skuName, armSkuName, type,
 * armRegionName }], NextPageLink, Count }`.
 *
 * 🔴 TWO PINS ON EVERY QUERY: `armRegionName eq '<region>'` AND
 * `type eq 'Consumption'`. Without them, reserved-instance and other-region rows
 * silently OUTBID the on-demand price. `buildAzureFilter` enforces both so no
 * caller can forget; a test asserts the filter carries both pins.
 *
 * Pagination: follow `NextPageLink` until null (bounded by MAX_PAGES so a
 * runaway filter cannot loop forever).
 *
 * The evidence gate runs here too: `evidence` is the serialised matched item
 * (which contains the raw `retailPrice`), checked against the raw response body.
 */

import { PricingError } from '../../pricing-seam';
import { assertEvidenceSupportsPrice } from '../evidence';
import { gap, rawBodyAsPage, serializeRecordAsEvidence, type FeedResult } from './types';

const AZURE_RETAIL_BASE = 'https://prices.azure.com/api/retail/prices';
const API_VERSION = '2023-01-01-preview';

/** Hard cap on pagination so a broad filter cannot loop unbounded. */
const MAX_PAGES = 25;

export interface AzureRetailItem {
  retailPrice?: number;
  unitOfMeasure?: string;
  meterName?: string;
  productName?: string;
  skuName?: string;
  armSkuName?: string;
  serviceName?: string;
  type?: string;
  armRegionName?: string;
  [k: string]: unknown;
}

interface AzureRetailPage {
  Items?: AzureRetailItem[];
  NextPageLink?: string | null;
  Count?: number;
}

/** How to locate ONE (skuId, dimensionId) inside the Azure Retail API. */
export interface AzureRetailQuery {
  skuId: string;
  dimensionId: string;
  /** ARM region name, e.g. `eastus`. Pinned into every filter. */
  armRegionName: string;
  /**
   * The service-specific narrowing clause from the docs §4 `$filter` cookbook,
   * e.g. `contains(productName,'PostgreSQL') and meterName eq 'vCore'` or
   * `serviceName eq 'Redis Cache'`. `armRegionName` and `type eq 'Consumption'`
   * are added automatically — do NOT include them here.
   */
  filterClause: string;
  /**
   * After fetching, narrow to the exact row. ALL entries must equal the item's
   * field. e.g. `{ meterName: 'vCore', skuName: '2 vCore' }`. Multiple survivors
   * → `ambiguous` gap.
   */
  match?: Record<string, string>;
  /** Optional expected `unitOfMeasure` guard, e.g. `1 Hour`, `1 GB/Month`. */
  expectedUnit?: string;
}

/**
 * Build the full `$filter`, ALWAYS pinning region + Consumption. Exported so a
 * test can assert both pins are present.
 */
export function buildAzureFilter(armRegionName: string, clause: string): string {
  const pins = `armRegionName eq '${armRegionName}' and type eq 'Consumption'`;
  const trimmed = clause.trim();
  return trimmed ? `${pins} and (${trimmed})` : pins;
}

/** Build the first-page request URL for a query. */
export function azureRetailUrl(query: AzureRetailQuery): string {
  const filter = buildAzureFilter(query.armRegionName, query.filterClause);
  const params = new URLSearchParams({
    'api-version': API_VERSION,
    currencyCode: 'USD',
    $filter: filter,
  });
  return `${AZURE_RETAIL_BASE}?${params.toString()}`;
}

/** GET one page; return parsed page + the raw body text (for the evidence gate). */
async function getPage(
  url: string,
  signal?: AbortSignal,
): Promise<{ page: AzureRetailPage; rawBody: string }> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    throw new PricingError('unavailable', `Network error fetching Azure Retail Prices: ${url}`, {
      provider: 'azure',
      cause: err,
    });
  }
  if (!res.ok) {
    throw new PricingError('unavailable', `Azure Retail Prices returned HTTP ${res.status}.`, {
      provider: 'azure',
    });
  }
  const rawBody = await res.text();
  let page: AzureRetailPage;
  try {
    page = JSON.parse(rawBody) as AzureRetailPage;
  } catch (err) {
    throw new PricingError('unavailable', 'Azure Retail Prices returned invalid JSON.', {
      provider: 'azure',
      cause: err,
    });
  }
  return { page, rawBody };
}

/**
 * Fetch ALL pages for a query, following `NextPageLink` (bounded). Returns the
 * accumulated items across every page.
 */
async function fetchAllPages(
  query: AzureRetailQuery,
  signal?: AbortSignal,
): Promise<{ items: AzureRetailItem[]; firstUrl: string }> {
  const firstUrl = azureRetailUrl(query);
  let url: string | null = firstUrl;
  const items: AzureRetailItem[] = [];
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const { page }: { page: AzureRetailPage; rawBody: string } = await getPage(url, signal);
    items.push(...(page.Items ?? []));
    url = page.NextPageLink ?? null;
    pages += 1;
  }

  return { items, firstUrl };
}

/** Narrow accumulated items to the exact row for a query. */
function narrowItems(items: AzureRetailItem[], query: AzureRetailQuery): AzureRetailItem[] {
  let out = items;
  if (query.match) {
    out = out.filter((it) =>
      Object.entries(query.match ?? {}).every(([k, v]) => (it as Record<string, unknown>)[k] === v),
    );
  }
  if (query.expectedUnit) {
    out = out.filter((it) => it.unitOfMeasure === query.expectedUnit);
  }
  return out;
}

/** Price one query against already-fetched items. */
function priceOne(
  items: AzureRetailItem[],
  feedUrl: string,
  fetchedAt: string,
  query: AzureRetailQuery,
): FeedResult {
  const { skuId, dimensionId } = query;
  const narrowed = narrowItems(items, query);

  if (narrowed.length === 0) {
    return gap(skuId, dimensionId, 'not_found_on_page', 'no Azure item matched the filter/match');
  }
  if (narrowed.length > 1) {
    // Distinct prices among survivors is a genuine ambiguity; identical prices
    // are just duplicate meters and we can take the first safely.
    const distinctPrices = new Set(narrowed.map((it) => it.retailPrice));
    if (distinctPrices.size > 1) {
      return gap(
        skuId,
        dimensionId,
        'ambiguous',
        `${narrowed.length} items with ${distinctPrices.size} distinct prices; refine match`,
      );
    }
  }

  const item = narrowed[0];
  const unitPriceUsd = item.retailPrice;
  if (typeof unitPriceUsd !== 'number' || !Number.isFinite(unitPriceUsd)) {
    return gap(skuId, dimensionId, 'not_found_on_page', `item has no numeric retailPrice`);
  }

  // Evidence = the serialised matched item (whitespace-padded so numbers are
  // clean tokens). It contains the raw `retailPrice`; page === evidence so the
  // substring check holds and the gate proves the number against the item we
  // actually read. A reserved/other-region row that slipped the filter fails here.
  const evidence = serializeRecordAsEvidence(item);
  const page = rawBodyAsPage(feedUrl, evidence, fetchedAt);
  const reason = assertEvidenceSupportsPrice({ page, evidence, unitPriceUsd });
  if (reason !== null) {
    return gap(skuId, dimensionId, 'evidence_rejected', reason);
  }

  return {
    kind: 'record',
    candidate: {
      skuId,
      dimensionId,
      unitPriceUsd,
      includedQuantity: 0, // Retail API carries no free-tier allowance.
      evidence,
      feedUrl,
      fetchedAt,
      note: item.unitOfMeasure ? `unitOfMeasure: ${item.unitOfMeasure}` : undefined,
    },
  };
}

/**
 * Fetch Azure Retail prices for a set of queries. Each query is its own filter
 * (paginated), fetched independently. A transport failure for one query becomes
 * a `fetch_failed` gap rather than sinking the others.
 */
export async function fetchAzureRetail(
  queries: AzureRetailQuery[],
  options?: { signal?: AbortSignal },
): Promise<FeedResult[]> {
  const results: FeedResult[] = [];
  for (const query of queries) {
    const fetchedAt = new Date().toISOString();
    try {
      const { items, firstUrl } = await fetchAllPages(query, options?.signal);
      results.push(priceOne(items, firstUrl, fetchedAt, query));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push(gap(query.skuId, query.dimensionId, 'fetch_failed', detail));
    }
  }
  return results;
}

/** Exposed for unit tests: price against already-fetched items. */
export function _priceAzureFromItems(
  items: AzureRetailItem[],
  feedUrl: string,
  fetchedAt: string,
  queries: AzureRetailQuery[],
): FeedResult[] {
  return queries.map((q) => priceOne(items, feedUrl, fetchedAt, q));
}
