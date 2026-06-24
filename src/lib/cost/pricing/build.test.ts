/**
 * Tests for price-book assembly (`buildPriceBook`, task B5) — the 🔴 invariants.
 *
 * OFFLINE and FREE: the network edges (Tavily fetch, the LLM extractor, the
 * three feed adapters, the cache) are injected as fakes via `makeBuildPriceBook`,
 * so no real Anthropic / Tavily / vendor call is made. These tests prove the
 * anti-fabrication invariants against the REAL evidence gate (not a mock of it):
 *
 *   1. 🔴 a hallucinated price is DISCARDED → PriceGap{reason:'evidence_rejected'},
 *      and the book is still returned;
 *   2. a fetch_failed page yields gaps for its SKUs and does NOT abort the book;
 *   3. duplicate/conflicting candidates never reach the schema (resolved or
 *      ambiguous), so the book always parses.
 *
 * DigitalOcean is used as the extractor-path provider (its catalog has real
 * SKUs and pricingUrls); AWS/Azure exercise the feed path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  priceBookSchema,
  type CloudProvider,
  type PriceBook,
} from '@/types/cost';
import { catalogServices } from '@/lib/cost/catalog';
import { makeBuildPriceBook, type BuildDeps } from '@/lib/cost/pricing/build';
import type { FetchedPage } from '@/lib/cost/pricing-seam';
import type { ExtractedCandidate, ExtractionTarget } from '@/lib/cost/pricing/extractor';
import type { FeedResult } from '@/lib/cost/pricing/feeds';
import type {
  AwsPriceListQuery,
  Ec2MeteredQuery,
} from '@/lib/cost/pricing/feeds';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A no-op cache so every build runs the pipeline (never a hit) and writes nowhere. */
const noCache: BuildDeps['cache'] = {
  read: vi.fn(async () => null),
  write: vi.fn(async () => {}),
};

/** The distinct pricing URLs of a provider's catalog, for building fake pages. */
function pricingUrlsFor(provider: CloudProvider): string[] {
  const urls = new Set<string>();
  for (const s of catalogServices.filter((c) => c.provider === provider)) urls.add(s.pricingUrl);
  return [...urls];
}

/** The (skuId, dimensionId) targets of a provider, for asserting coverage. */
function dimensionKeys(provider: CloudProvider): string[] {
  const keys: string[] = [];
  for (const s of catalogServices.filter((c) => c.provider === provider))
    for (const sku of s.skus) for (const d of sku.dimensions) keys.push(`${sku.id}|${d.id}`);
  return keys;
}

function makeDeps(overrides: Partial<BuildDeps>): BuildDeps {
  return {
    fetchPages: vi.fn(async () => []),
    extract: vi.fn(async () => []),
    awsPriceList: vi.fn(async () => []),
    ec2Metered: vi.fn(async () => []),
    azureRetail: vi.fn(async () => []),
    cache: noCache,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

/* -------------------------------------------------------------------------- */
/* 🔴 Hallucination discard                                                    */
/* -------------------------------------------------------------------------- */

describe('buildPriceBook — 🔴 a hallucinated price is discarded, book still returned', () => {
  it('rejects a candidate whose price is NOT in the evidence → evidence_rejected gap', async () => {
    // Pick the first DigitalOcean SKU dimension and its page.
    const doServices = catalogServices.filter((s) => s.provider === 'digitalocean');
    const svc = doServices[0];
    const sku = svc.skus[0];
    const dim = sku.dimensions[0];

    // A real page whose markdown contains 0.00893 but NOT the fabricated 0.99.
    const pageMarkdown = `| 1 GiB | 1 vCPU | 25 GiB SSD | $0.00893 | $6.00 |`;

    const deps = makeDeps({
      fetchPages: vi.fn(async (urls: string[]) =>
        urls.map((url) => ({
          url,
          title: 'pricing',
          markdown: pageMarkdown,
          fetchedAt: '2026-07-26T00:00:00.000Z',
        })),
      ),
      // The extractor HALLUCINATES: it claims $0.99 with evidence that does not
      // contain 0.99 (it copies the real row, but the number is invented).
      extract: vi.fn(async (page: FetchedPage, targets: ExtractionTarget[]): Promise<ExtractedCandidate[]> => {
        if (targets.some((t) => t.skuId === sku.id && t.dimensionId === dim.id)) {
          return [
            {
              skuId: sku.id,
              dimensionId: dim.id,
              unitPriceUsd: 0.99, // FABRICATED — not present in the evidence
              includedQuantity: 0,
              evidence: '| 1 GiB | 1 vCPU | 25 GiB SSD | $0.00893 | $6.00 |',
            },
          ];
        }
        return [];
      }),
    });

    const book = await makeBuildPriceBook(deps)('digitalocean', { force: true });

    // The book is returned (partial = success) and is schema-valid.
    expect(priceBookSchema.safeParse(book).success).toBe(true);

    // The fabricated dimension is a gap with the right reason — NEVER a record.
    const record = book.records.find((r) => r.skuId === sku.id && r.dimensionId === dim.id);
    expect(record).toBeUndefined();
    const gap = book.gaps.find((g) => g.skuId === sku.id && g.dimensionId === dim.id);
    expect(gap?.reason).toBe('evidence_rejected');
  });

  it('accepts a candidate whose price IS in the evidence → PriceRecord with source', async () => {
    const svc = catalogServices.find((s) => s.provider === 'digitalocean')!;
    const sku = svc.skus[0];
    const dim = sku.dimensions[0];
    const markdown = `Basic Droplet 1 GiB 1 vCPU — $0.00893/hr`;

    const deps = makeDeps({
      fetchPages: vi.fn(async (urls: string[]) =>
        urls.map((url) => ({ url, title: 't', markdown, fetchedAt: '2026-07-26T00:00:00.000Z' })),
      ),
      extract: vi.fn(async (_page: FetchedPage, targets: ExtractionTarget[]): Promise<ExtractedCandidate[]> =>
        targets
          .filter((t) => t.skuId === sku.id && t.dimensionId === dim.id)
          .map((t) => ({
            skuId: t.skuId,
            dimensionId: t.dimensionId,
            unitPriceUsd: 0.00893, // REAL — present verbatim in the markdown
            includedQuantity: 0,
            evidence: '$0.00893/hr',
          })),
      ),
    });

    const book = await makeBuildPriceBook(deps)('digitalocean', { force: true });
    const record = book.records.find((r) => r.skuId === sku.id && r.dimensionId === dim.id);
    expect(record).toBeDefined();
    expect(record?.unitPriceUsd).toBe(0.00893);
    expect(record?.source.url).toBe(svc.pricingUrl);
    expect(record?.source.evidence).toContain('0.00893');
    expect(record?.source.extractorModel).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Fetch failure does not abort the book                                      */
/* -------------------------------------------------------------------------- */

describe('buildPriceBook — a fetch_failed page yields gaps, never aborts', () => {
  it('a page omitted by the fetch layer → fetch_failed gaps for its dimensions; other pages still price', async () => {
    const urls = pricingUrlsFor('digitalocean');
    expect(urls.length).toBeGreaterThan(1);
    const deadUrl = urls[0];

    const deps = makeDeps({
      // Return EVERY page except the dead one.
      fetchPages: vi.fn(async (requested: string[]) =>
        requested
          .filter((u) => u !== deadUrl)
          .map((url) => ({
            url,
            title: 't',
            markdown: 'nothing priceable here',
            fetchedAt: '2026-07-26T00:00:00.000Z',
          })),
      ),
      extract: vi.fn(async () => []), // other pages simply find nothing
    });

    const book = await makeBuildPriceBook(deps)('digitalocean', { force: true });
    expect(priceBookSchema.safeParse(book).success).toBe(true);

    // Dimensions on the dead page are fetch_failed gaps.
    const deadServiceSkuDims = catalogServices
      .filter((s) => s.provider === 'digitalocean' && s.pricingUrl === deadUrl)
      .flatMap((s) => s.skus.flatMap((sku) => sku.dimensions.map((d) => ({ sku: sku.id, dim: d.id }))));
    expect(deadServiceSkuDims.length).toBeGreaterThan(0);
    for (const { sku, dim } of deadServiceSkuDims) {
      const gap = book.gaps.find((g) => g.skuId === sku && g.dimensionId === dim);
      expect(gap?.reason).toBe('fetch_failed');
    }
  });

  it('a total fetch failure (no key) makes every dimension a fetch_failed gap, not an exception', async () => {
    const { PricingError } = await import('@/lib/cost/pricing-seam');
    const deps = makeDeps({
      fetchPages: vi.fn(async () => {
        throw new PricingError('not_configured', 'TAVILY_API_KEY missing');
      }),
    });

    const book = await makeBuildPriceBook(deps)('digitalocean', { force: true });
    expect(priceBookSchema.safeParse(book).success).toBe(true);
    expect(book.records).toHaveLength(0);
    const keys = dimensionKeys('digitalocean');
    expect(book.gaps.length).toBe(keys.length);
    expect(book.gaps.every((g) => g.reason === 'fetch_failed')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Duplicate / conflicting candidates never reach the schema                  */
/* -------------------------------------------------------------------------- */

describe('buildPriceBook — duplicates are resolved or become ambiguous, never emitted twice', () => {
  it('two candidates with the SAME price for one dimension collapse to one record', async () => {
    const svc = catalogServices.find((s) => s.provider === 'digitalocean')!;
    const sku = svc.skus[0];
    const dim = sku.dimensions[0];
    const markdown = 'price is $0.00893/hr here';

    const deps = makeDeps({
      fetchPages: vi.fn(async (urls: string[]) =>
        urls.map((url) => ({ url, title: 't', markdown, fetchedAt: '2026-07-26T00:00:00.000Z' })),
      ),
      extract: vi.fn(async (_p: FetchedPage, targets: ExtractionTarget[]): Promise<ExtractedCandidate[]> => {
        const t = targets.find((x) => x.skuId === sku.id && x.dimensionId === dim.id);
        if (!t) return [];
        // The model emitted the SAME dimension twice with identical prices.
        return [
          { skuId: t.skuId, dimensionId: t.dimensionId, unitPriceUsd: 0.00893, includedQuantity: 0, evidence: '$0.00893/hr' },
          { skuId: t.skuId, dimensionId: t.dimensionId, unitPriceUsd: 0.00893, includedQuantity: 0, evidence: '$0.00893/hr' },
        ];
      }),
    });

    const book = await makeBuildPriceBook(deps)('digitalocean', { force: true });
    expect(priceBookSchema.safeParse(book).success).toBe(true); // schema rejects dupes; we passed
    const records = book.records.filter((r) => r.skuId === sku.id && r.dimensionId === dim.id);
    expect(records).toHaveLength(1);
  });

  it('two candidates with DIFFERENT prices for one dimension become an ambiguous gap, not two records', async () => {
    const svc = catalogServices.find((s) => s.provider === 'digitalocean')!;
    const sku = svc.skus[0];
    const dim = sku.dimensions[0];
    const markdown = 'it could be $0.00893/hr or maybe $0.01000/hr';

    const deps = makeDeps({
      fetchPages: vi.fn(async (urls: string[]) =>
        urls.map((url) => ({ url, title: 't', markdown, fetchedAt: '2026-07-26T00:00:00.000Z' })),
      ),
      extract: vi.fn(async (_p: FetchedPage, targets: ExtractionTarget[]): Promise<ExtractedCandidate[]> => {
        const t = targets.find((x) => x.skuId === sku.id && x.dimensionId === dim.id);
        if (!t) return [];
        // Both prices are genuinely on the page (both pass the gate), but they
        // conflict — the builder must NOT coin-flip.
        return [
          { skuId: t.skuId, dimensionId: t.dimensionId, unitPriceUsd: 0.00893, includedQuantity: 0, evidence: '$0.00893/hr' },
          { skuId: t.skuId, dimensionId: t.dimensionId, unitPriceUsd: 0.01, includedQuantity: 0, evidence: '$0.01000/hr' },
        ];
      }),
    });

    const book = await makeBuildPriceBook(deps)('digitalocean', { force: true });
    expect(priceBookSchema.safeParse(book).success).toBe(true);
    const records = book.records.filter((r) => r.skuId === sku.id && r.dimensionId === dim.id);
    expect(records).toHaveLength(0);
    const gap = book.gaps.find((g) => g.skuId === sku.id && g.dimensionId === dim.id);
    expect(gap?.reason).toBe('ambiguous');
  });
});

/* -------------------------------------------------------------------------- */
/* Feed path routing (aws / azure)                                            */
/* -------------------------------------------------------------------------- */

describe('buildPriceBook — feed path (aws / azure)', () => {
  it('routes AWS to the feed adapters and folds their records/gaps into the book', async () => {
    const deps = makeDeps({
      ec2Metered: vi.fn(async (queries: Ec2MeteredQuery[]): Promise<FeedResult[]> =>
        queries.map((q) => ({
          kind: 'record' as const,
          candidate: {
            skuId: q.skuId,
            dimensionId: q.dimensionId,
            unitPriceUsd: 0.0208,
            includedQuantity: 0,
            evidence: '{ "price" : "0.0208" }',
            feedUrl: 'https://b0.p.awsstatic.com/...',
            fetchedAt: '2026-07-26T00:00:00.000Z',
          },
        })),
      ),
      awsPriceList: vi.fn(async (queries: AwsPriceListQuery[]): Promise<FeedResult[]> =>
        queries.map((q) => ({
          kind: 'gap' as const,
          gap: { skuId: q.skuId, dimensionId: q.dimensionId, reason: 'not_found_on_page' as const },
        })),
      ),
    });

    const book = await makeBuildPriceBook(deps)('aws', { force: true });
    expect(priceBookSchema.safeParse(book).success).toBe(true);
    expect(book.provider).toBe('aws');
    // Tavily must NOT be called for a feed provider.
    expect(deps.fetchPages).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
    // EC2 records made it in.
    const ec2 = book.records.find((r) => r.skuId.startsWith('aws:ec2:'));
    expect(ec2?.unitPriceUsd).toBe(0.0208);
    expect(ec2?.source.extractorModel).toContain('feed');
  });

  it('a dimension with no wired feed descriptor becomes an honest not_found gap (never fabricated)', async () => {
    // Use the real feed adapters returning nothing so undescribed dims fall
    // through to the not_found path. Simplest: stub feeds to echo gaps only for
    // what they are asked, and confirm undescribed dims are gaps regardless.
    const deps = makeDeps({
      ec2Metered: vi.fn(async () => []),
      awsPriceList: vi.fn(async () => []),
    });
    const book = await makeBuildPriceBook(deps)('aws', { force: true });
    expect(priceBookSchema.safeParse(book).success).toBe(true);
    // e.g. RDS storage has no descriptor wired yet → must be a gap, not a record.
    const rds = book.gaps.find((g) => g.skuId.startsWith('aws:rds-postgres:'));
    expect(rds).toBeDefined();
    expect(book.records.every((r) => r.unitPriceUsd >= 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 🔴 RC2 (BLOCKER-3): one invalid record must NOT take the whole book down    */
/* -------------------------------------------------------------------------- */

describe('buildPriceBook — 🔴 a single invalid record becomes a gap; the rest of the book survives', () => {
  it('an over-long evidence string on ONE record → invalid_record gap, the OTHER records still price (Azure BLOCKER-3)', async () => {
    // This is the exact shape of BLOCKER-3: a feed produced several real,
    // evidence-backed prices, but one record's serialised evidence exceeded the
    // schema cap. Before RC2 that failed `priceBookSchema.safeParse` and dropped
    // the ENTIRE provider's book. Now the bad record becomes an `invalid_record`
    // gap and the good ones survive.
    const azureQueries: { skuId: string; dimensionId: string }[] = [];

    // An evidence string that PASSES the evidence gate (it is the page and it
    // contains the price) but EXCEEDS priceSourceSchema's 2000-char cap.
    const overLongEvidence = `retailPrice 8 ${'x'.repeat(2100)}`;
    expect(overLongEvidence.length).toBeGreaterThan(2000);

    const deps = makeDeps({
      azureRetail: vi.fn(async (queries: { skuId: string; dimensionId: string }[]): Promise<FeedResult[]> => {
        azureQueries.push(...queries);
        return queries.map((q, i) => {
          // The FIRST query gets the over-long evidence (the poison record);
          // every other query gets a normal, valid short evidence.
          const evidence = i === 0 ? overLongEvidence : `retailPrice 8`;
          return {
            kind: 'record' as const,
            candidate: {
              skuId: q.skuId,
              dimensionId: q.dimensionId,
              unitPriceUsd: 8,
              includedQuantity: 0,
              evidence,
              feedUrl: 'https://prices.azure.com/api/retail/prices',
              fetchedAt: '2026-07-26T00:00:00.000Z',
            },
          };
        });
      }),
    });

    const book = await makeBuildPriceBook(deps)('azure', { force: true });

    // 🔴 The book is RETURNED and schema-valid — one bad record did not sink it.
    expect(priceBookSchema.safeParse(book).success).toBe(true);
    expect(book.provider).toBe('azure');

    // Azure had more than one descriptor-wired dimension, so we exercised >1 query.
    expect(azureQueries.length).toBeGreaterThan(1);

    // The poison record is a gap with the new reason; NOT a record.
    const poison = azureQueries[0];
    const poisonRecord = book.records.find(
      (r) => r.skuId === poison.skuId && r.dimensionId === poison.dimensionId,
    );
    expect(poisonRecord).toBeUndefined();
    const poisonGap = book.gaps.find(
      (g) => g.skuId === poison.skuId && g.dimensionId === poison.dimensionId,
    );
    expect(poisonGap?.reason).toBe('invalid_record');

    // Every OTHER Azure feed dimension still priced — the good records survived.
    const survivors = azureQueries.slice(1);
    expect(survivors.length).toBeGreaterThan(0);
    for (const q of survivors) {
      const rec = book.records.find((r) => r.skuId === q.skuId && r.dimensionId === q.dimensionId);
      expect(rec, `${q.skuId}|${q.dimensionId} should have survived`).toBeDefined();
      expect(rec?.unitPriceUsd).toBe(8);
    }
    // And the book carries real records, not just gaps.
    expect(book.records.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Cache behaviour                                                            */
/* -------------------------------------------------------------------------- */

describe('buildPriceBook — cache', () => {
  it('returns a cached book without running the pipeline when not forced', async () => {
    const cached: PriceBook = {
      provider: 'digitalocean',
      region: 'nyc3',
      pipelineVersion: '1.0.0',
      generatedAt: '2026-07-26T00:00:00.000Z',
      records: [],
      gaps: [],
    };
    const deps = makeDeps({
      cache: { read: vi.fn(async () => cached), write: vi.fn(async () => {}) },
    });
    const book = await makeBuildPriceBook(deps)('digitalocean');
    expect(book).toBe(cached);
    expect(deps.fetchPages).not.toHaveBeenCalled();
  });

  it('force:true bypasses the cache and runs the pipeline', async () => {
    const deps = makeDeps({
      cache: { read: vi.fn(async () => null), write: vi.fn(async () => {}) },
      fetchPages: vi.fn(async () => []),
    });
    await makeBuildPriceBook(deps)('digitalocean', { force: true });
    expect(deps.cache.read).not.toHaveBeenCalled();
    expect(deps.fetchPages).toHaveBeenCalled();
  });

  it('writes the freshly-built book to the cache', async () => {
    const write = vi.fn(async (book: PriceBook) => {
      void book;
    });
    const deps = makeDeps({
      cache: { read: vi.fn(async () => null), write },
    });
    await makeBuildPriceBook(deps)('digitalocean', { force: true });
    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0][0];
    expect(written.provider).toBe('digitalocean');
    expect(priceBookSchema.safeParse(written).success).toBe(true);
  });
});
