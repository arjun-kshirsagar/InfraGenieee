/**
 * InfraGenie — price-book assembly (task B5). This is where B1–B4 become usable
 * prices: it fetches each provider's pricing pages / feeds ONCE, runs every
 * candidate through the evidence gate, and assembles a schema-valid `PriceBook`.
 *
 * SERVER-ONLY. Implements `BuildPriceBook` from `../pricing-seam`.
 *
 * ## The pipeline, per provider (docs §5)
 *
 *   1. Slice the catalog to this provider; collect the distinct `pricingUrl`s
 *      across its services. A page usually prices several SKUs, so each URL is
 *      fetched EXACTLY ONCE (a cold cache must not hammer the API).
 *   2. Route by provider:
 *        - aws / azure  → the structured B4 feed adapters (their HTML pages
 *          render prices client-side; Tavily cannot read them).
 *        - gcp / vercel / digitalocean → Tavily fetch + the LLM extractor.
 *   3. Run EVERY candidate through `assertEvidenceSupportsPrice`. Survivors
 *      become `PriceRecord`s with a full `source`; casualties become `PriceGap`s
 *      with the right reason. (Feed adapters already gate internally, so a
 *      feed record arrives pre-proven; we still never invent for a feed miss.)
 *   4. 🔴 NEVER substitute a default, an average, a neighbouring SKU's price, or
 *      a remembered number for a rejected record. A gap is the correct output.
 *   5. Two conflicting candidates for one (skuId, dimensionId) → resolve or emit
 *      `ambiguous`. `priceBookSchema` REJECTS duplicates, so emitting both fails
 *      the parse — we must dedupe before returning.
 *   6. Parse with `priceBookSchema` before returning.
 *   7. A PARTIAL book is a SUCCESS. `PricingError` is thrown only when nothing
 *      at all could be produced (no records AND no gaps — i.e. the provider has
 *      no priceable dimensions, which is a catalog bug, not a runtime one).
 *
 * ## Testability
 *
 * The network edges (Tavily fetch, the LLM extractor, the three feed adapters)
 * are injected via `BuildDeps`, defaulting to the real implementations. Unit
 * tests pass fakes to prove the hallucination-discard, fetch-failure and
 * duplicate-resolution invariants OFFLINE, and the live smoke test uses the real
 * deps against DigitalOcean.
 */

import {
  priceBookSchema,
  PRICING_PIPELINE_VERSION,
  PRICED_REGION,
  type CloudProvider,
  type PriceBook,
  type PriceGap,
  type PriceRecord,
  type CatalogService,
} from '@/types/cost';

import { catalogServices } from '../catalog';
import {
  PricingError,
  DEFAULT_PRICE_EXTRACTOR_MODEL,
  type BuildPriceBook,
  type BuildPriceBookOptions,
  type FetchedPage,
} from '../pricing-seam';
import { priceBookCache } from './cache';
import { assertEvidenceSupportsPrice } from './evidence';
import { extractPrices, type ExtractionTarget } from './extractor';
import { fetchPricingPages } from './tavily';
import {
  fetchAwsPriceList,
  fetchEc2Metered,
  fetchAzureRetail,
  type FeedResult,
} from './feeds';
import {
  FEED_PROVIDERS,
  FEED_EXTRACTOR_LABEL,
  feedDescriptorFor,
  type FeedDescriptor,
} from './feeds/descriptors';
import type { PriceBookCache } from '../pricing-seam';

/* -------------------------------------------------------------------------- */
/* Injected dependencies (real by default; faked in unit tests)               */
/* -------------------------------------------------------------------------- */

export interface BuildDeps {
  fetchPages: typeof fetchPricingPages;
  extract: typeof extractPrices;
  awsPriceList: typeof fetchAwsPriceList;
  ec2Metered: typeof fetchEc2Metered;
  azureRetail: typeof fetchAzureRetail;
  cache: PriceBookCache;
}

const defaultDeps: BuildDeps = {
  fetchPages: fetchPricingPages,
  extract: extractPrices,
  awsPriceList: fetchAwsPriceList,
  ec2Metered: fetchEc2Metered,
  azureRetail: fetchAzureRetail,
  cache: priceBookCache,
};

/* -------------------------------------------------------------------------- */
/* Catalog slicing                                                            */
/* -------------------------------------------------------------------------- */

/** One (skuId, dimensionId) that needs a price, plus where to get it. */
interface DimensionTarget {
  skuId: string;
  dimensionId: string;
  extractionHint: string;
  unit: string;
  /** The human pricing page cited by `PriceSource.url`. */
  pricingUrl: string;
}

function servicesFor(provider: CloudProvider): CatalogService[] {
  return catalogServices.filter((s) => s.provider === provider);
}

/** Flatten a provider's catalog into the list of dimensions to price. */
function targetsFor(services: CatalogService[]): DimensionTarget[] {
  const out: DimensionTarget[] = [];
  for (const svc of services) {
    for (const sku of svc.skus) {
      for (const dim of sku.dimensions) {
        out.push({
          skuId: sku.id,
          dimensionId: dim.id,
          extractionHint: dim.extractionHint,
          unit: dim.unit,
          pricingUrl: svc.pricingUrl,
        });
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Candidate → record/gap, with the evidence gate                             */
/* -------------------------------------------------------------------------- */

/** A proven or rejected candidate, ready to fold into the book. */
type Resolved =
  | { kind: 'record'; record: PriceRecord }
  | { kind: 'gap'; gap: PriceGap };

/**
 * Run one extractor candidate through the evidence gate against the page it
 * claims to come from. Survivor → PriceRecord; casualty → evidence_rejected gap.
 * NEVER repairs or defaults a rejected value.
 */
function resolveExtracted(
  target: DimensionTarget,
  page: FetchedPage,
  candidate: { unitPriceUsd: number; includedQuantity: number; evidence: string },
  extractorModel: string,
): Resolved {
  const reason = assertEvidenceSupportsPrice({
    page,
    evidence: candidate.evidence,
    unitPriceUsd: candidate.unitPriceUsd,
  });
  if (reason !== null) {
    return {
      kind: 'gap',
      gap: {
        skuId: target.skuId,
        dimensionId: target.dimensionId,
        reason: 'evidence_rejected',
        detail: reason,
      },
    };
  }
  return {
    kind: 'record',
    record: {
      skuId: target.skuId,
      dimensionId: target.dimensionId,
      unitPriceUsd: candidate.unitPriceUsd,
      includedQuantity: candidate.includedQuantity,
      currency: 'USD',
      source: {
        url: target.pricingUrl,
        fetchedAt: page.fetchedAt,
        evidence: candidate.evidence,
        extractorModel,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The extractor path (gcp / vercel / digitalocean)                           */
/* -------------------------------------------------------------------------- */

async function buildViaExtractor(
  provider: CloudProvider,
  targets: DimensionTarget[],
  deps: BuildDeps,
  options: BuildPriceBookOptions,
): Promise<{ records: PriceRecord[]; gaps: PriceGap[] }> {
  const records: PriceRecord[] = [];
  const gaps: PriceGap[] = [];

  // Group targets by pricingUrl so each page is fetched (and extracted) once.
  const byUrl = new Map<string, DimensionTarget[]>();
  for (const t of targets) {
    const list = byUrl.get(t.pricingUrl) ?? [];
    list.push(t);
    byUrl.set(t.pricingUrl, list);
  }

  const urls = [...byUrl.keys()];

  // Fetch every page once. A total fetch failure (e.g. no key) makes EVERY
  // dimension a fetch_failed gap rather than throwing — a partial/empty book is
  // still a success (the seam), and the route decides 503-only-when-empty.
  let pages: FetchedPage[];
  try {
    pages = await deps.fetchPages(urls, { signal: options.signal });
  } catch (err) {
    const detail = err instanceof PricingError ? err.message : String(err);
    for (const t of targets) {
      gaps.push({ skuId: t.skuId, dimensionId: t.dimensionId, reason: 'fetch_failed', detail });
    }
    return { records, gaps };
  }

  const pageByUrl = new Map(pages.map((p) => [p.url, p]));
  const model = options.model;

  for (const [url, urlTargets] of byUrl) {
    const page = pageByUrl.get(url);
    if (!page) {
      // The page was omitted from the fetch result (failed_results / dead URL).
      for (const t of urlTargets) {
        gaps.push({
          skuId: t.skuId,
          dimensionId: t.dimensionId,
          reason: 'fetch_failed',
          detail: `page not returned by fetch layer: ${url}`,
        });
      }
      continue;
    }

    // One extractor call per page (a page prices several SKUs).
    const extractionTargets: ExtractionTarget[] = urlTargets.map((t) => ({
      skuId: t.skuId,
      dimensionId: t.dimensionId,
      extractionHint: t.extractionHint,
      unit: t.unit,
    }));

    let candidates: Awaited<ReturnType<typeof extractPrices>>;
    try {
      candidates = await deps.extract(page, extractionTargets, {
        model,
        signal: options.signal,
      });
    } catch (err) {
      // Extraction failed for this page → its dimensions are gaps, but other
      // pages of the same provider are unaffected (partial success).
      const detail = err instanceof PricingError ? err.message : String(err);
      for (const t of urlTargets) {
        gaps.push({
          skuId: t.skuId,
          dimensionId: t.dimensionId,
          reason: 'fetch_failed',
          detail: `extractor failed: ${detail}`,
        });
      }
      continue;
    }

    const usedModel = model ?? DEFAULT_PRICE_EXTRACTOR_MODEL;
    const candByKey = new Map<string, typeof candidates>();
    for (const c of candidates) {
      const k = `${c.skuId}|${c.dimensionId}`;
      const list = candByKey.get(k) ?? [];
      list.push(c);
      candByKey.set(k, list);
    }

    for (const t of urlTargets) {
      const k = `${t.skuId}|${t.dimensionId}`;
      const cands = candByKey.get(k) ?? [];
      if (cands.length === 0) {
        gaps.push({
          skuId: t.skuId,
          dimensionId: t.dimensionId,
          reason: 'not_found_on_page',
          detail: 'extractor returned no candidate for this dimension',
        });
        continue;
      }
      const resolved = resolveMany(
        t,
        cands.map((c) => resolveExtracted(t, page, c, usedModel)),
      );
      if (resolved.kind === 'record') records.push(resolved.record);
      else gaps.push(resolved.gap);
    }
  }

  void provider; // (kept for symmetry / future per-provider handling)
  return { records, gaps };
}

/* -------------------------------------------------------------------------- */
/* The feed path (aws / azure)                                                */
/* -------------------------------------------------------------------------- */

/** Convert a feed adapter result into our Resolved shape. */
function feedResultToResolved(
  r: FeedResult,
  target: DimensionTarget,
  feed: FeedDescriptor['feed'],
): Resolved {
  if (r.kind === 'gap') return { kind: 'gap', gap: r.gap };
  const c = r.candidate;
  return {
    kind: 'record',
    record: {
      skuId: c.skuId,
      dimensionId: c.dimensionId,
      unitPriceUsd: c.unitPriceUsd,
      includedQuantity: c.includedQuantity,
      currency: 'USD',
      source: {
        // Cite the human pricing page a user clicks to verify us (rule 2), while
        // the feed adapter's `feedUrl` provenance lives in the evidence itself.
        url: target.pricingUrl,
        fetchedAt: c.fetchedAt,
        evidence: c.evidence,
        extractorModel: FEED_EXTRACTOR_LABEL[feed],
      },
    },
  };
}

async function buildViaFeeds(
  provider: CloudProvider,
  targets: DimensionTarget[],
  deps: BuildDeps,
  options: BuildPriceBookOptions,
): Promise<{ records: PriceRecord[]; gaps: PriceGap[] }> {
  const records: PriceRecord[] = [];
  const gaps: PriceGap[] = [];

  // Bucket targets by feed via the descriptor table. A dimension with no wired
  // descriptor is an honest not_found gap — never a fabricated number.
  const targetMeta = new Map<string, { target: DimensionTarget; feed: FeedDescriptor['feed'] }>();
  const ec2Queries: Parameters<typeof fetchEc2Metered>[0] = [];
  const priceListQueries: Parameters<typeof fetchAwsPriceList>[0] = [];
  const azureQueries: Parameters<typeof fetchAzureRetail>[0] = [];

  for (const t of targets) {
    const desc = feedDescriptorFor(t.skuId, t.dimensionId);
    if (!desc) {
      gaps.push({
        skuId: t.skuId,
        dimensionId: t.dimensionId,
        reason: 'not_found_on_page',
        detail: 'no verified price-feed descriptor is wired for this dimension yet',
      });
      continue;
    }
    targetMeta.set(`${t.skuId}|${t.dimensionId}`, { target: t, feed: desc.feed });
    if (desc.feed === 'ec2-metered') {
      ec2Queries.push({ skuId: t.skuId, dimensionId: t.dimensionId, ...desc.query });
    } else if (desc.feed === 'aws-price-list') {
      priceListQueries.push({ skuId: t.skuId, dimensionId: t.dimensionId, ...desc.query });
    } else {
      azureQueries.push({ skuId: t.skuId, dimensionId: t.dimensionId, ...desc.query });
    }
  }

  const foldResults = (results: FeedResult[]) => {
    for (const r of results) {
      const skuId = r.kind === 'record' ? r.candidate.skuId : r.gap.skuId;
      const dimensionId = r.kind === 'record' ? r.candidate.dimensionId : r.gap.dimensionId;
      const meta = targetMeta.get(`${skuId}|${dimensionId}`);
      if (!meta) {
        // Defensive: a feed returned a pair we did not ask for. Drop it.
        continue;
      }
      const resolved = feedResultToResolved(r, meta.target, meta.feed);
      if (resolved.kind === 'record') records.push(resolved.record);
      else gaps.push(resolved.gap);
    }
  };

  // Run only the feeds this provider actually uses. A feed adapter never throws
  // for a per-query miss (it returns gaps), so a dead endpoint degrades to gaps
  // and never sinks the whole book.
  try {
    if (ec2Queries.length > 0) foldResults(await deps.ec2Metered(ec2Queries, { signal: options.signal }));
    if (priceListQueries.length > 0)
      foldResults(await deps.awsPriceList(priceListQueries, { signal: options.signal }));
    if (azureQueries.length > 0)
      foldResults(await deps.azureRetail(azureQueries, { signal: options.signal }));
  } catch (err) {
    // A feed adapter should not throw, but if one does, degrade its unresolved
    // targets to fetch_failed gaps rather than aborting the whole provider.
    const detail = err instanceof PricingError ? err.message : String(err);
    const resolvedKeys = new Set(records.map((r) => `${r.skuId}|${r.dimensionId}`));
    for (const g of gaps) resolvedKeys.add(`${g.skuId}|${g.dimensionId}`);
    for (const { target } of targetMeta.values()) {
      const k = `${target.skuId}|${target.dimensionId}`;
      if (!resolvedKeys.has(k)) {
        gaps.push({
          skuId: target.skuId,
          dimensionId: target.dimensionId,
          reason: 'fetch_failed',
          detail,
        });
      }
    }
  }

  void provider;
  return { records, gaps };
}

/* -------------------------------------------------------------------------- */
/* Conflict resolution (rule 5)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Given all `Resolved`s for ONE (skuId, dimensionId), collapse to a single
 * outcome. Multiple accepted records with the SAME price are duplicate meters →
 * take one. Multiple accepted records with DIFFERENT prices are a genuine
 * conflict → `ambiguous` (we never coin-flip). If none were accepted, surface a
 * representative gap.
 */
function resolveMany(target: DimensionTarget, resolveds: Resolved[]): Resolved {
  const records = resolveds.filter((r): r is Extract<Resolved, { kind: 'record' }> => r.kind === 'record');
  if (records.length === 0) {
    // Prefer an evidence_rejected reason over not_found if present (more useful).
    const gap =
      resolveds.find((r) => r.kind === 'gap' && r.gap.reason === 'evidence_rejected') ??
      resolveds.find((r) => r.kind === 'gap');
    if (gap && gap.kind === 'gap') return gap;
    return {
      kind: 'gap',
      gap: { skuId: target.skuId, dimensionId: target.dimensionId, reason: 'not_found_on_page' },
    };
  }
  const distinctPrices = new Set(records.map((r) => r.record.unitPriceUsd));
  if (distinctPrices.size > 1) {
    return {
      kind: 'gap',
      gap: {
        skuId: target.skuId,
        dimensionId: target.dimensionId,
        reason: 'ambiguous',
        detail: `extractor returned ${distinctPrices.size} conflicting prices`,
      },
    };
  }
  return records[0];
}

/**
 * Final safety net: de-duplicate records by (skuId, dimensionId) so the book can
 * never fail `priceBookSchema`'s duplicate check. Identical prices collapse to
 * one; a slipped-through conflict becomes an `ambiguous` gap (both records are
 * dropped). This makes rule 5 hold even if a caller path missed `resolveMany`.
 */
function dedupeRecords(
  records: PriceRecord[],
  gaps: PriceGap[],
): { records: PriceRecord[]; gaps: PriceGap[] } {
  const byKey = new Map<string, PriceRecord[]>();
  for (const r of records) {
    const k = `${r.skuId}|${r.dimensionId}`;
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }

  const outRecords: PriceRecord[] = [];
  const outGaps = [...gaps];
  for (const [, list] of byKey) {
    const distinct = new Set(list.map((r) => r.unitPriceUsd));
    if (distinct.size === 1) {
      outRecords.push(list[0]);
    } else {
      outGaps.push({
        skuId: list[0].skuId,
        dimensionId: list[0].dimensionId,
        reason: 'ambiguous',
        detail: `${distinct.size} conflicting prices survived; both dropped`,
      });
    }
  }

  // A dimension that ended up with BOTH a record and a gap keeps the record and
  // drops the (now redundant) gap for the same key — a priced dimension is not
  // also a gap.
  const recordKeys = new Set(outRecords.map((r) => `${r.skuId}|${r.dimensionId}`));
  const dedupedGaps: PriceGap[] = [];
  const seenGapKeys = new Set<string>();
  for (const g of outGaps) {
    const k = `${g.skuId}|${g.dimensionId}`;
    if (recordKeys.has(k)) continue;
    if (seenGapKeys.has(k)) continue; // one gap per key is enough for the UI
    seenGapKeys.add(k);
    dedupedGaps.push(g);
  }

  return { records: outRecords, gaps: dedupedGaps };
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build (or read from cache) the price book for one provider.
 *
 * @throws {PricingError} only when nothing at all could be produced (no records
 *   and no gaps — a catalog with no priceable dimensions for the provider).
 */
export function makeBuildPriceBook(deps: BuildDeps = defaultDeps): BuildPriceBook {
  return async function buildPriceBook(provider, options = {}) {
    // Cache: a fresh book short-circuits the whole fetch/extract pipeline. The
    // live smoke test passes `force` to bypass it.
    if (!options.force) {
      const cached = await deps.cache.read(provider);
      if (cached) return cached;
    }

    const services = servicesFor(provider);
    const targets = targetsFor(services);

    if (targets.length === 0) {
      // No priceable dimensions for this provider is a catalog bug, not a
      // runtime condition — surface it loudly rather than caching an empty book.
      throw new PricingError('invalid_output', `Catalog has no dimensions for provider "${provider}".`, {
        provider,
      });
    }

    const { records, gaps } = FEED_PROVIDERS.has(provider)
      ? await buildViaFeeds(provider, targets, deps, options)
      : await buildViaExtractor(provider, targets, deps, options);

    const deduped = dedupeRecords(records, gaps);

    const book: PriceBook = {
      provider,
      region: PRICED_REGION[provider],
      pipelineVersion: PRICING_PIPELINE_VERSION,
      generatedAt: new Date().toISOString(),
      records: deduped.records,
      gaps: deduped.gaps,
    };

    // Parse before returning — a malformed book is a bug we want to see, not
    // ship. `priceBookSchema` also enforces the no-duplicate invariant (rule 5).
    const parsed = priceBookSchema.safeParse(book);
    if (!parsed.success) {
      throw new PricingError(
        'invalid_output',
        `Assembled price book for "${provider}" failed schema validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        { provider },
      );
    }

    // Persist the (possibly partial) book. A partial book is a success and is
    // worth caching — it still saves the API quota on the priced dimensions.
    await deps.cache.write(parsed.data);

    return parsed.data;
  };
}

/** The default, wired to the real fetch/extract/feed/cache implementations. */
export const buildPriceBook: BuildPriceBook = makeBuildPriceBook();

export const _internal = {
  targetsFor,
  servicesFor,
  resolveExtracted,
  resolveMany,
  dedupeRecords,
  feedResultToResolved,
  defaultDeps,
};
