/**
 * InfraGenie — AWS EC2 metered-unit feed adapter (task B4).
 *
 * SERVER-ONLY. Free, public, unauthenticated read (docs §4/§10). This is the
 * very feed the AWS EC2 pricing page itself consumes:
 *
 *   GET https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/
 *       ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json
 *
 * 🔴 THE FAILURE I ACTUALLY HIT: the response body is **gzip-encoded and NOT
 * declared** as such (no `Content-Encoding: gzip`). `fetch().json()` /
 * `res.text()` therefore try to decode raw gzip bytes as UTF-8 and throw an
 * invalid-byte error. We MUST read the arrayBuffer and `gunzipSync` it
 * explicitly before parsing. (Some CDNs DO transparently decode; we detect the
 * gzip magic `1f 8b` and only decompress when present, so both work.)
 *
 * Shape (verified 2026-07-26): `regions["US East (N. Virginia)"][key] =
 * { price: "0.0208000000", "Instance Type": "t3.small", Memory: "2 GiB",
 * vCPU: "2", … }`. 1,322 SKUs. e.g. `m9g.large` → `0.09784`/hr.
 *
 * The evidence gate runs here too: `evidence` is the serialised matched region
 * entry (which contains the raw `price` string), checked against the decompressed
 * raw body text. A wrong instance-type join is caught, not trusted.
 */

import { gunzipSync } from 'node:zlib';

import { PricingError } from '../../pricing-seam';
import { assertEvidenceSupportsPrice } from '../evidence';
import { gap, rawBodyAsPage, serializeRecordAsEvidence, type FeedResult } from './types';

const EC2_METERED_BASE =
  'https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current';

/** Build the EC2 metered feed URL for a region label + OS. */
export function ec2MeteredUrl(
  regionLabel = 'US East (N. Virginia)',
  os = 'Linux',
  set = 'ec2-ondemand-without-sec-sel',
): string {
  // The path segments contain spaces and parens — encode each segment.
  return `${EC2_METERED_BASE}/${set}/${encodeURIComponent(regionLabel)}/${encodeURIComponent(os)}/index.json`;
}

/** How to locate ONE (skuId, dimensionId) inside the EC2 metered feed. */
export interface Ec2MeteredQuery {
  skuId: string;
  dimensionId: string;
  /** Exact `Instance Type`, e.g. `t3.small`, `m7i.large`. */
  instanceType: string;
  /** Region label key in `regions`, defaults to US East (N. Virginia). */
  regionLabel?: string;
  os?: string;
}

interface Ec2MeteredEntry {
  rateCode?: string;
  price?: string;
  Location?: string;
  'Instance Type'?: string;
  Memory?: string;
  vCPU?: string;
  [k: string]: unknown;
}

interface Ec2MeteredFeed {
  regions?: Record<string, Record<string, Ec2MeteredEntry>>;
}

/**
 * Decompress a raw feed body if (and only if) it carries the gzip magic bytes
 * `1f 8b`. Returns the UTF-8 text. This is the whole point of the adapter — a
 * naive `res.text()` on the gzip bytes throws.
 */
export function decodeMeteredBody(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const out = isGzip ? gunzipSync(Buffer.from(bytes)) : Buffer.from(bytes);
  return out.toString('utf-8');
}

/** GET the metered feed, decompress explicitly, return raw text. */
async function fetchMeteredText(url: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    throw new PricingError('unavailable', `Network error fetching EC2 metered feed: ${url}`, {
      provider: 'aws',
      cause: err,
    });
  }
  if (!res.ok) {
    throw new PricingError('unavailable', `EC2 metered feed returned HTTP ${res.status} for ${url}`, {
      provider: 'aws',
    });
  }
  const buf = await res.arrayBuffer();
  return decodeMeteredBody(buf);
}

/** Price one EC2 metered query against an already-decoded feed body. */
function priceOne(
  feed: Ec2MeteredFeed,
  feedUrl: string,
  fetchedAt: string,
  query: Ec2MeteredQuery,
): FeedResult {
  const { skuId, dimensionId } = query;
  const regionLabel = query.regionLabel ?? 'US East (N. Virginia)';
  const region = feed.regions?.[regionLabel];
  if (!region) {
    return gap(skuId, dimensionId, 'not_found_on_page', `feed has no region "${regionLabel}"`);
  }

  const matches = Object.values(region).filter(
    (e) => e['Instance Type'] === query.instanceType,
  );
  if (matches.length === 0) {
    return gap(skuId, dimensionId, 'not_found_on_page', `no entry for instance type ${query.instanceType}`);
  }
  if (matches.length > 1) {
    return gap(skuId, dimensionId, 'ambiguous', `${matches.length} entries for ${query.instanceType}`);
  }

  const entry = matches[0];
  const unitPriceUsd = Number(entry.price);
  if (entry.price === undefined || !Number.isFinite(unitPriceUsd)) {
    return gap(skuId, dimensionId, 'not_found_on_page', `entry has no numeric price: ${entry.price}`);
  }

  // Evidence = the serialised matched region entry (whitespace-padded so numbers
  // are clean tokens). It contains the raw `price` string; page === evidence so
  // the substring check holds and the gate proves the number against the record
  // we actually read. A wrong instance-type join fails here, not silently.
  const evidence = serializeRecordAsEvidence(entry);
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
      includedQuantity: 0, // EC2 on-demand has no free allowance in this feed.
      evidence,
      feedUrl,
      fetchedAt,
    },
  };
}

/**
 * Fetch EC2 on-demand hourly prices for a set of queries. Queries sharing a
 * (regionLabel, os) fetch the feed once. A transport failure turns that group's
 * queries into `fetch_failed` gaps rather than throwing — partial success.
 */
export async function fetchEc2Metered(
  queries: Ec2MeteredQuery[],
  options?: { signal?: AbortSignal },
): Promise<FeedResult[]> {
  const results: FeedResult[] = [];

  const groups = new Map<string, Ec2MeteredQuery[]>();
  for (const q of queries) {
    const key = `${q.regionLabel ?? 'US East (N. Virginia)'}|${q.os ?? 'Linux'}`;
    const list = groups.get(key) ?? [];
    list.push(q);
    groups.set(key, list);
  }

  for (const [, group] of groups) {
    const first = group[0];
    const feedUrl = ec2MeteredUrl(first.regionLabel, first.os);
    const fetchedAt = new Date().toISOString();
    let rawBody: string;
    let feed: Ec2MeteredFeed;
    try {
      rawBody = await fetchMeteredText(feedUrl, options?.signal);
      feed = JSON.parse(rawBody) as Ec2MeteredFeed;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      for (const q of group) results.push(gap(q.skuId, q.dimensionId, 'fetch_failed', detail));
      continue;
    }
    for (const q of group) results.push(priceOne(feed, feedUrl, fetchedAt, q));
  }

  return results;
}

/** Exposed for unit tests: price against an already-decoded feed body. */
export function _priceEc2MeteredFromFeed(
  feed: Ec2MeteredFeed,
  feedUrl: string,
  fetchedAt: string,
  queries: Ec2MeteredQuery[],
): FeedResult[] {
  return queries.map((q) => priceOne(feed, feedUrl, fetchedAt, q));
}

export type { Ec2MeteredFeed, Ec2MeteredEntry };
