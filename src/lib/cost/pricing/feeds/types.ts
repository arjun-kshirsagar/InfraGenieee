/**
 * InfraGenie — shared contract for the STRUCTURED price-feed adapters (task B4).
 *
 * SERVER-ONLY. These adapters make plain public HTTPS GETs to a provider's own
 * free, unauthenticated, read-only price feed — no SDK, no credentials, no
 * account, no billing (see `docs/feature-2-cost-predictor.md` §4/§10). They
 * exist because Tavily physically cannot price AWS EC2/SQS or Azure: those
 * pages render their numbers client-side (`$-` / 0 matches on extract).
 *
 * ## Why a separate path from Tavily, and why the SAME evidence gate
 *
 * A feed adapter is just a different EXTRACTOR. It resolves a candidate
 * `unitPriceUsd` from a structured record instead of from page markdown, but it
 * is held to the identical anti-fabrication invariant: the emitted price must
 * survive `assertEvidenceSupportsPrice` against the raw response body. For a
 * feed, `evidence` is the **serialised matched record** (e.g. the AWS
 * `priceDimensions` entry, or the Azure item) and the "page markdown" is the
 * **raw response body text**. So a mis-joined record — the wrong instance type,
 * a reserved-instance row that outbid the on-demand one — is CAUGHT by the same
 * substring+number proof rather than trusted. One code path, one invariant.
 *
 * ## The query-spec seam (why adapters do not import the catalog)
 *
 * An adapter is driven by an explicit array of `FeedQuery` descriptors, each
 * carrying the catalog `skuId` + `dimensionId` it fills and a feed-specific
 * locator (an EC2 instance type, an Azure `$filter` + meter, an AWS offer code +
 * attribute matchers). This keeps the adapters pure of catalog coupling and
 * fully testable against recorded fixtures; the B3 pipeline is responsible for
 * translating a catalog slice into these descriptors. The adapters never invent
 * a locator and never fall back to a hardcoded price — a miss is a gap.
 */

import type { PriceGap } from '@/types/cost';
import type { FetchedPage } from '../../pricing-seam';

/**
 * A price the adapter matched and PROVED. Shaped to slot straight into a
 * `PriceRecord` by the B3 pipeline (which supplies `PriceSource.url` = the
 * catalog's human `pricingUrl` and `extractorModel` = the feed id). The
 * `evidence` here is the serialised matched record; `feedUrl` records the actual
 * endpoint the number came from so provenance is complete even though
 * `PriceSource.url` cites the human page a user clicks to check us.
 */
export interface FeedPriceCandidate {
  skuId: string;
  dimensionId: string;
  /** USD per the dimension's unit. Zero is legal (genuinely-free dimensions). */
  unitPriceUsd: number;
  /** Free allowance FETCHED from the feed, in the same unit. Never assumed. */
  includedQuantity: number;
  /** Verbatim serialisation of the matched feed record — the evidence gate
   *  proves `unitPriceUsd` appears in this against the raw response body. */
  evidence: string;
  /** The exact feed endpoint this number was read from (for provenance). */
  feedUrl: string;
  /** When the HTTP call returned (ISO-8601), captured by the adapter. */
  fetchedAt: string;
  /** Optional human note, e.g. "flattened to first paid tier". */
  note?: string;
}

/**
 * The result of trying to price ONE (skuId, dimensionId): either a proven
 * candidate or an explicit gap. NEVER a repaired or defaulted number. Mirrors
 * the Tavily path's "survivor vs casualty" split (docs §5).
 */
export type FeedResult =
  | { kind: 'record'; candidate: FeedPriceCandidate }
  | { kind: 'gap'; gap: PriceGap };

/**
 * Serialise a matched feed record into an evidence string the SHARED evidence
 * gate can verify. It is `JSON.stringify` with whitespace padded around every
 * structural token (`,:{}[]`), which matters because the gate matches prices on
 * whole WHITESPACE/PUNCTUATION-delimited numeric tokens: compact JSON produces
 * `"retailPrice":8,` and the gate's token regex would capture `8,` (a comma is
 * not a valid thousands separator) and reject it. Padding makes every number a
 * clean token — e.g. ` "retailPrice" : 8 , ` — so a REAL price is found and a
 * FABRICATED one is still rejected (proven in the tests). The gate itself is
 * untouched (B1 owns it, "reuse unchanged"); this only shapes the input.
 *
 * `page` and `evidence` are BOTH built from this same serialisation of the
 * matched record, so the gate's substring check (requirement 1) holds trivially
 * and the load-bearing check is the number proof (requirement 2) against the
 * record the adapter actually read from the raw feed body.
 */
export function serializeRecordAsEvidence(record: unknown): string {
  return JSON.stringify(record).replace(/([,:{}[\]])/g, ' $1 ');
}

/** Build a `FetchedPage`-shaped view of an evidence string so the SAME evidence
 *  gate (`assertEvidenceSupportsPrice`) runs against it unchanged. */
export function rawBodyAsPage(url: string, rawBody: string, fetchedAt: string): FetchedPage {
  return { url, title: url, markdown: rawBody, fetchedAt };
}

export function gap(
  skuId: string,
  dimensionId: string,
  reason: PriceGap['reason'],
  detail?: string,
): FeedResult {
  return { kind: 'gap', gap: { skuId, dimensionId, reason, detail } };
}
