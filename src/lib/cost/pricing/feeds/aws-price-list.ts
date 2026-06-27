/**
 * InfraGenie — AWS Price List Bulk API adapter (task B4).
 *
 * SERVER-ONLY. Free, public, unauthenticated read (docs §4/§10). No SDK, no
 * credentials — plain HTTPS GETs against:
 *
 *   GET https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<OfferCode>/current/region_index.json
 *   GET https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<OfferCode>/current/<region>/index.json
 *
 * Shape (verified 2026-07-26, `AWSQueueService` / us-east-1):
 *   - `products[sku].attributes` — usagetype, group, servicecode, location, …
 *   - `terms.OnDemand[sku][term].priceDimensions[dim]` with
 *       `description: "$0.40 per million Amazon SQS standard requests …"`,
 *       `pricePerUnit.USD: "0.0000004000"`, `unit: "Requests"`.
 *
 * Offer codes ≠ product names: SQS is `AWSQueueService` (NOT `AmazonSQS`, which
 * 404s). A wrong offer code is a 404 — it fails LOUDLY, never a wrong price.
 *
 * The evidence gate runs here too: `evidence` is the serialised matched
 * priceDimensions entry (which contains `pricePerUnit.USD`), checked against the
 * raw region-index body. A mis-joined SKU is caught, not trusted.
 */

import { PricingError } from '../../pricing-seam';
import { assertEvidenceSupportsPrice } from '../evidence';
import { gap, rawBodyAsPage, serializeRecordAsEvidence, type FeedResult } from './types';

const PRICE_LIST_BASE = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws';

/** How to locate ONE (skuId, dimensionId) inside an AWS Price List offer. */
export interface AwsPriceListQuery {
  skuId: string;
  dimensionId: string;
  /** e.g. `AWSQueueService`, `AmazonS3`, `AmazonRDS`. Resolved to a URL; a
   *  wrong code 404s rather than returning a wrong price. */
  offerCode: string;
  region: string;
  /**
   * Attribute equality matchers on `products[sku].attributes`. ALL must match.
   * This is what pins the exact product (e.g. `{ group: 'SQS-APIRequest-Tier1',
   * queueType: 'Standard' }`). A vague matcher that hits several products is an
   * `ambiguous` gap, never a coin-flip.
   */
  attributes: Record<string, string>;
  /**
   * Optional matcher on the priceDimensions entry's `description` (a substring,
   * case-insensitive) to disambiguate tiered rows on the same SKU — e.g. only
   * the "Tier1" / first paid row. Tiered pricing is flattened to the first paid
   * tier in v1 (docs §7); this picks that row deterministically.
   */
  descriptionContains?: string;
  /** Optional expected `unit` on the price dimension (e.g. `Requests`), a guard
   *  against joining a storage row to a request dimension. */
  expectedUnit?: string;
  /**
   * 🔴 Price-batch SCALE — how many single feed-units make up one catalog
   * `pricePerUnits`. The AWS Price List quotes `pricePerUnit.USD` PER SINGLE
   * ITEM (per request, per WRU), but the catalog's bulk dimensions declare
   * `pricePerUnits` (e.g. `1_000_000` for `USD / million requests`) and the
   * engine does `billable / pricePerUnits × unitPriceUsd` — so it expects
   * `unitPriceUsd` to be the PER-BATCH price, exactly like the Tavily providers
   * whose pages quote "$0.40 per million". Left at the default `1`, the raw
   * per-request price ($0.0000004) would be billed as if it were the
   * per-million price, understating by 10⁶× (this is the coordination gap
   * `t_e2022194` flagged: SQS shipped $0.0000004 where the truth is $0.40).
   *
   * When set, the adapter reports `unitPriceUsd = rawPerUnit × priceScale` and
   * MUST equal the catalog dimension's `pricePerUnits` for that dimension — a
   * build-time guard asserts they match so they cannot silently drift. The
   * evidence gate still runs against the RAW `pricePerUnit.USD` in the record
   * (always present, no dependency on the description's phrasing), so a
   * mis-joined SKU is caught before any scaling.
   */
  priceScale?: number;
}

interface AwsProduct {
  sku: string;
  productFamily?: string;
  attributes?: Record<string, string>;
}

interface AwsPriceDimension {
  rateCode?: string;
  description?: string;
  beginRange?: string;
  endRange?: string;
  unit?: string;
  pricePerUnit?: { USD?: string };
}

interface AwsOfferIndex {
  offerCode?: string;
  products?: Record<string, AwsProduct>;
  terms?: { OnDemand?: Record<string, Record<string, { priceDimensions?: Record<string, AwsPriceDimension> }>> };
}

interface AwsRegionIndex {
  regions?: Record<string, { regionCode?: string; currentVersionUrl?: string }>;
}

/** GET + text, mapping transport faults to `PricingError('unavailable')`. */
async function getText(url: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    throw new PricingError('unavailable', `Network error fetching AWS Price List: ${url}`, {
      provider: 'aws',
      cause: err,
    });
  }
  if (!res.ok) {
    // A 404 here is almost always a wrong offer code / region — surface loudly.
    throw new PricingError('unavailable', `AWS Price List returned HTTP ${res.status} for ${url}`, {
      provider: 'aws',
    });
  }
  return res.text();
}

/** Resolve `<region>/index.json` URL via the offer's region_index.json. */
async function resolveRegionIndexUrl(
  offerCode: string,
  region: string,
  signal?: AbortSignal,
): Promise<string> {
  const regionIndexUrl = `${PRICE_LIST_BASE}/${offerCode}/current/region_index.json`;
  const body = await getText(regionIndexUrl, signal);
  let parsed: AwsRegionIndex;
  try {
    parsed = JSON.parse(body) as AwsRegionIndex;
  } catch (err) {
    throw new PricingError('unavailable', `AWS region_index.json was not valid JSON (${offerCode}).`, {
      provider: 'aws',
      cause: err,
    });
  }
  const entry = parsed.regions?.[region];
  if (!entry?.currentVersionUrl) {
    throw new PricingError(
      'unavailable',
      `AWS offer ${offerCode} has no region "${region}" in its region index.`,
      { provider: 'aws' },
    );
  }
  // currentVersionUrl is an absolute PATH like "/offers/v1.0/aws/…/index.json".
  return new URL(entry.currentVersionUrl, 'https://pricing.us-east-1.amazonaws.com').toString();
}

/** Find the products whose attributes match ALL of `attributes`. */
function matchProducts(index: AwsOfferIndex, attributes: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [sku, product] of Object.entries(index.products ?? {})) {
    const attrs = product.attributes ?? {};
    const ok = Object.entries(attributes).every(([k, v]) => attrs[k] === v);
    if (ok) out.push(sku);
  }
  return out;
}

/**
 * From one SKU's OnDemand terms, pick the priceDimensions entry to price on.
 * When `descriptionContains` is set we filter to it; otherwise we take the row
 * with the lowest numeric `beginRange` (the first / base tier). Tiered pricing
 * is flattened to the first paid tier in v1 (docs §7).
 */
function pickPriceDimension(
  index: AwsOfferIndex,
  sku: string,
  query: AwsPriceListQuery,
): AwsPriceDimension | { error: string } {
  const terms = index.terms?.OnDemand?.[sku];
  if (!terms) return { error: `no OnDemand terms for sku ${sku}` };

  const dims: AwsPriceDimension[] = [];
  for (const term of Object.values(terms)) {
    for (const dim of Object.values(term.priceDimensions ?? {})) dims.push(dim);
  }
  if (dims.length === 0) return { error: `no priceDimensions for sku ${sku}` };

  let candidates = dims;
  if (query.descriptionContains) {
    const needle = query.descriptionContains.toLowerCase();
    candidates = candidates.filter((d) => (d.description ?? '').toLowerCase().includes(needle));
    if (candidates.length === 0) {
      return { error: `no priceDimensions matched descriptionContains="${query.descriptionContains}"` };
    }
  }
  if (query.expectedUnit) {
    candidates = candidates.filter((d) => d.unit === query.expectedUnit);
    if (candidates.length === 0) {
      return { error: `no priceDimensions with unit="${query.expectedUnit}"` };
    }
  }

  // Deterministic: lowest beginRange = the first / base tier.
  candidates.sort((a, b) => Number(a.beginRange ?? '0') - Number(b.beginRange ?? '0'));
  return candidates[0];
}

/** Price one AWS Price List query against an already-fetched offer index. */
function priceOne(
  index: AwsOfferIndex,
  feedUrl: string,
  fetchedAt: string,
  query: AwsPriceListQuery,
): FeedResult {
  const { skuId, dimensionId } = query;

  const matched = matchProducts(index, query.attributes);
  if (matched.length === 0) {
    return gap(skuId, dimensionId, 'not_found_on_page', 'no product matched the attribute filter');
  }
  if (matched.length > 1) {
    return gap(
      skuId,
      dimensionId,
      'ambiguous',
      `${matched.length} products matched the attribute filter; refine it`,
    );
  }

  const picked = pickPriceDimension(index, matched[0], query);
  if ('error' in picked) {
    return gap(skuId, dimensionId, 'not_found_on_page', picked.error);
  }

  const usd = picked.pricePerUnit?.USD;
  if (usd === undefined) {
    return gap(skuId, dimensionId, 'not_found_on_page', 'matched dimension has no pricePerUnit.USD');
  }
  const rawUnitPriceUsd = Number(usd);
  if (!Number.isFinite(rawUnitPriceUsd)) {
    return gap(skuId, dimensionId, 'not_found_on_page', `pricePerUnit.USD is not numeric: ${usd}`);
  }

  // Evidence = the serialised matched priceDimensions entry (whitespace-padded
  // so numbers are clean tokens). It contains the raw `pricePerUnit.USD` string,
  // so the gate proves the number — a mis-join fails here rather than being
  // trusted. page === evidence, so the substring check holds trivially and the
  // load-bearing check is the number proof against the record we actually read.
  //
  // CRUCIAL: we gate the RAW per-unit price (the value literally in the record),
  // then scale it to the catalog's per-batch representation for reporting. This
  // keeps the anti-fabrication proof independent of the description's phrasing.
  const evidence = serializeRecordAsEvidence(picked);
  const page = rawBodyAsPage(feedUrl, evidence, fetchedAt);
  const reason = assertEvidenceSupportsPrice({ page, evidence, unitPriceUsd: rawUnitPriceUsd });
  if (reason !== null) {
    return gap(skuId, dimensionId, 'evidence_rejected', reason);
  }

  // The AWS Price List quotes per single item; the catalog bulk dimension bills
  // per `pricePerUnits`, so report the per-batch price (see `priceScale`). A
  // scale of 1 (the default) is a no-op for per-hour / per-GB-month dimensions.
  const priceScale = query.priceScale ?? 1;
  const unitPriceUsd = rawUnitPriceUsd * priceScale;

  const scaleNote =
    priceScale !== 1
      ? `per-batch price = ${rawUnitPriceUsd} × ${priceScale} (feed quotes per single unit)`
      : undefined;

  return {
    kind: 'record',
    candidate: {
      skuId,
      dimensionId,
      unitPriceUsd,
      includedQuantity: 0, // AWS Price List carries no free-tier allowance here.
      evidence,
      feedUrl,
      fetchedAt,
      note:
        [
          query.descriptionContains ? undefined : 'first/base tier (tiered pricing flattened, docs §7)',
          scaleNote,
        ]
          .filter(Boolean)
          .join('; ') || undefined,
    },
  };
}

/**
 * Fetch AWS Price List prices for a set of queries. Queries are grouped by
 * (offerCode, region) so each offer index is fetched exactly once.
 *
 * A transport failure for an offer turns EVERY query on that offer into a
 * `fetch_failed` gap (not an exception) so one dead offer cannot sink the whole
 * book — mirrors the Tavily path's partial-success posture (docs §5).
 *
 * @throws never for per-query misses; only re-raises `not_configured` (n/a here).
 */
export async function fetchAwsPriceList(
  queries: AwsPriceListQuery[],
  options?: { signal?: AbortSignal },
): Promise<FeedResult[]> {
  const results: FeedResult[] = [];

  // Group by offer+region.
  const groups = new Map<string, AwsPriceListQuery[]>();
  for (const q of queries) {
    const key = `${q.offerCode}|${q.region}`;
    const list = groups.get(key) ?? [];
    list.push(q);
    groups.set(key, list);
  }

  for (const [, group] of groups) {
    const { offerCode, region } = group[0];
    let rawBody: string;
    let feedUrl: string;
    let index: AwsOfferIndex;
    const fetchedAt = new Date().toISOString();
    try {
      feedUrl = await resolveRegionIndexUrl(offerCode, region, options?.signal);
      rawBody = await getText(feedUrl, options?.signal);
      index = JSON.parse(rawBody) as AwsOfferIndex;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      for (const q of group) results.push(gap(q.skuId, q.dimensionId, 'fetch_failed', detail));
      continue;
    }
    for (const q of group) {
      results.push(priceOne(index, feedUrl, fetchedAt, q));
    }
  }

  return results;
}

/** Exposed for unit tests: price queries against an already-parsed index. */
export function _priceAwsPriceListFromIndex(
  index: AwsOfferIndex,
  feedUrl: string,
  fetchedAt: string,
  queries: AwsPriceListQuery[],
): FeedResult[] {
  return queries.map((q) => priceOne(index, feedUrl, fetchedAt, q));
}

export type { AwsOfferIndex };
