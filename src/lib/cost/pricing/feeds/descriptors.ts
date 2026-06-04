/**
 * InfraGenie — catalog → feed-query descriptors (task B5).
 *
 * SERVER-ONLY (pure data + a lookup; no I/O itself).
 *
 * ## Why this module exists
 *
 * The B4 feed adapters (`aws-ec2-metered`, `aws-price-list`, `azure-retail`) are
 * driven by EXPLICIT structured descriptors (an instance type, an offer code +
 * attribute matchers, an Azure `$filter` + `match`), NOT by the catalog's
 * free-text `extractionHint` (which is written for the LLM extractor). Something
 * has to translate a catalog `(skuId, dimensionId)` into the right structured
 * query. That is this module.
 *
 * ## The anti-fabrication posture (READ THIS)
 *
 * A descriptor here is only as trustworthy as it is VERIFIED. A vague or guessed
 * attribute matcher is exactly the "wrong-but-real price" failure the design doc
 * warns about (§4). So the rule for this table is strict:
 *
 *   - Only (skuId, dimensionId) pairs with a VERIFIED or docs-§4-cookbook-backed
 *     descriptor appear here.
 *   - A pair with NO descriptor is NOT an error and NOT a fabricated number: the
 *     builder emits an honest `PriceGap{reason:'not_found_on_page'}` for it. A
 *     partial book is a success (docs §5, the seam).
 *
 * Even for the descriptors that ARE here, the feed adapters still run every
 * result through the evidence gate and return a gap (not a guess) on any miss or
 * ambiguity — so a matcher that is subtly wrong degrades to a gap, never to a
 * confidently-wrong price.
 *
 * Coverage is intentionally incremental: EC2 on-demand hours (verified live in
 * B4) and the Azure Retail cookbook queries (region + Consumption pinned, from
 * docs §4) are wired first. Remaining AWS Price List services (RDS, S3,
 * CloudFront, DynamoDB, ElastiCache, MSK, OpenSearch, egress) each need their
 * own per-service live verification before they can be added without risking a
 * wrong join — that is deliberate follow-up work, not a silent gap-by-neglect.
 */

import { PRICED_REGION, type CloudProvider } from '@/types/cost';

import type { AwsPriceListQuery } from './aws-price-list';
import type { Ec2MeteredQuery } from './aws-ec2-metered';
import type { AzureRetailQuery } from './azure-retail';

/** A descriptor without its `skuId`/`dimensionId` (those come from the key). */
type Ec2Descriptor = Omit<Ec2MeteredQuery, 'skuId' | 'dimensionId'>;
type PriceListDescriptor = Omit<AwsPriceListQuery, 'skuId' | 'dimensionId'>;
type AzureDescriptor = Omit<AzureRetailQuery, 'skuId' | 'dimensionId'>;

/**
 * Tagged union so the builder can route each descriptor to the right adapter.
 * The `feed` tag is also what `PriceSource.extractorModel` records for a fed
 * price ("feed:ec2-metered" etc.), keeping provenance explicit.
 */
export type FeedDescriptor =
  | { feed: 'ec2-metered'; query: Ec2Descriptor }
  | { feed: 'aws-price-list'; query: PriceListDescriptor }
  | { feed: 'azure-retail'; query: AzureDescriptor };

/** Provenance label stored in `PriceSource.extractorModel` for a fed price. */
export const FEED_EXTRACTOR_LABEL: Record<FeedDescriptor['feed'], string> = {
  'ec2-metered': 'feed:aws-ec2-metered',
  'aws-price-list': 'feed:aws-price-list',
  'azure-retail': 'feed:azure-retail',
};

/** Key into the descriptor table. */
const key = (skuId: string, dimensionId: string): string => `${skuId}|${dimensionId}`;

const AWS_REGION = PRICED_REGION.aws; // us-east-1
const AZURE_REGION = PRICED_REGION.azure; // eastus

/* -------------------------------------------------------------------------- */
/* AWS — EC2 on-demand hours (verified live in B4: t3.small → 0.0208/hr)      */
/* -------------------------------------------------------------------------- */

const AWS_DESCRIPTORS: Record<string, FeedDescriptor> = {
  [key('aws:ec2:t3-small', 'instance-hour')]: {
    feed: 'ec2-metered',
    query: { instanceType: 't3.small' },
  },
  [key('aws:ec2:t3-medium', 'instance-hour')]: {
    feed: 'ec2-metered',
    query: { instanceType: 't3.medium' },
  },
  [key('aws:ec2:m7i-large', 'instance-hour')]: {
    feed: 'ec2-metered',
    query: { instanceType: 'm7i.large' },
  },

  /* SQS Standard — offer code `AWSQueueService`, us-east-1. B4 verified the
   * offer + shape live; the Standard queue's per-request Tier1 row is pinned by
   * queueType + group. A wrong matcher degrades to an `ambiguous`/`not_found`
   * gap (never a wrong price), and the evidence gate proves the number. */
  [key('aws:sqs:standard', 'requests')]: {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AWSQueueService',
      region: AWS_REGION,
      attributes: { group: 'SQS-APIRequest-Tier1', queueType: 'Standard' },
      expectedUnit: 'Requests',
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Azure — Retail Prices cookbook (docs §4). region + Consumption auto-pinned */
/* by buildAzureFilter, so filterClause carries only the narrowing clause.     */
/*                                                                             */
/* Every match below was VERIFIED against the live Retail API (eastus) on      */
/* 2026-07-26 — the exact productName + skuName + meterName that isolates ONE   */
/* row. This is essential: a bare `meterName eq 'vCore'` matches ~140 Postgres  */
/* rows from 0.017 to 63/hr, so an imprecise match is exactly the wrong-but-    */
/* real price the docs warn about. A non-isolating match degrades to an        */
/* `ambiguous` gap (never a coin-flip), and the evidence gate proves the number.*/
/* -------------------------------------------------------------------------- */

const AZURE_DESCRIPTORS: Record<string, FeedDescriptor> = {
  // Postgres Flexible Server — Burstable B1ms compute (verified: 0.017/hr).
  [key('azure:postgres-flexible:b1ms', 'vcore-hour')]: {
    feed: 'azure-retail',
    query: {
      armRegionName: AZURE_REGION,
      filterClause: "contains(productName,'PostgreSQL')",
      match: {
        productName: 'Azure Database for PostgreSQL Flexible Server Burstable BS Series Compute',
        skuName: 'B1MS',
        meterName: 'B1MS',
      },
      expectedUnit: '1 Hour',
    },
  },
  // Postgres Flexible Server — General Purpose Ddsv5, 2 vCore (verified: 0.178/hr).
  [key('azure:postgres-flexible:d2ds-v5', 'vcore-hour')]: {
    feed: 'azure-retail',
    query: {
      armRegionName: AZURE_REGION,
      filterClause: "contains(productName,'PostgreSQL')",
      match: {
        productName:
          'Azure Database for PostgreSQL Flexible Server General Purpose Ddsv5 Series Compute',
        skuName: '2 vCore',
        meterName: 'vCore',
      },
      expectedUnit: '1 Hour',
    },
  },
  // Postgres Flexible Server — provisioned storage (verified: 0.115/GB-month).
  // Shared meter for both instance SKUs (storage is priced independently of the
  // compute tier), so both storage dimensions point at the same feed row.
  [key('azure:postgres-flexible:b1ms', 'storage-gb-month')]: {
    feed: 'azure-retail',
    query: {
      armRegionName: AZURE_REGION,
      filterClause: "contains(productName,'PostgreSQL')",
      match: {
        productName: 'Az DB for PostgreSQL Flexible Server Storage',
        skuName: 'Storage',
        meterName: 'Storage Data Stored',
      },
      expectedUnit: '1 GB/Month',
    },
  },
  [key('azure:postgres-flexible:d2ds-v5', 'storage-gb-month')]: {
    feed: 'azure-retail',
    query: {
      armRegionName: AZURE_REGION,
      filterClause: "contains(productName,'PostgreSQL')",
      match: {
        productName: 'Az DB for PostgreSQL Flexible Server Storage',
        skuName: 'Storage',
        meterName: 'Storage Data Stored',
      },
      expectedUnit: '1 GB/Month',
    },
  },

  // Redis Cache (verified). Basic C0 → 0.022/hr; Standard C1 → 0.069/hr;
  // Standard C3 → 0.225/hr. Basic vs Standard is the productName; the meter
  // name differs between Basic ("C0 Cache") and Standard ("C1 Cache Instance").
  [key('azure:cache-redis:basic-c0', 'instance-hour')]: {
    feed: 'azure-retail',
    query: {
      armRegionName: AZURE_REGION,
      filterClause: "serviceName eq 'Redis Cache'",
      match: { productName: 'Azure Redis Cache Basic', skuName: 'C0', meterName: 'C0 Cache' },
      expectedUnit: '1 Hour',
    },
  },
  [key('azure:cache-redis:standard-c1', 'instance-hour')]: {
    feed: 'azure-retail',
    query: {
      armRegionName: AZURE_REGION,
      filterClause: "serviceName eq 'Redis Cache'",
      match: {
        productName: 'Azure Redis Cache Standard',
        skuName: 'C1',
        meterName: 'C1 Cache Instance',
      },
      expectedUnit: '1 Hour',
    },
  },
  [key('azure:cache-redis:standard-c3', 'instance-hour')]: {
    feed: 'azure-retail',
    query: {
      armRegionName: AZURE_REGION,
      filterClause: "serviceName eq 'Redis Cache'",
      match: {
        productName: 'Azure Redis Cache Standard',
        skuName: 'C3',
        meterName: 'C3 Cache Instance',
      },
      expectedUnit: '1 Hour',
    },
  },

  // Service Bus Standard — base monthly fee (verified: Standard Base Unit,
  // 1/Month → 10.0). The per-operation meter's first tier is $0 (included
  // allowance), so `operations` is intentionally left as a gap rather than
  // reporting a bare 0 that the UI could misread as "free forever".
  [key('azure:service-bus:standard', 'base-month')]: {
    feed: 'azure-retail',
    query: {
      armRegionName: AZURE_REGION,
      filterClause: "serviceName eq 'Service Bus'",
      match: { skuName: 'Standard', meterName: 'Standard Base Unit' },
      expectedUnit: '1/Month',
    },
  },
};

/**
 * The full descriptor table, keyed `<skuId>|<dimensionId>`. Providers not routed
 * through a feed (gcp/vercel/digitalocean) have no entries here — they go via
 * the Tavily extractor.
 */
const DESCRIPTORS: Record<string, FeedDescriptor> = {
  ...AWS_DESCRIPTORS,
  ...AZURE_DESCRIPTORS,
};

/** Providers whose prices come from a structured feed rather than Tavily. */
export const FEED_PROVIDERS: ReadonlySet<CloudProvider> = new Set<CloudProvider>(['aws', 'azure']);

/**
 * Look up the feed descriptor for one catalog dimension, or `null` when none is
 * wired. A `null` here is not an error — the builder turns it into an honest
 * `PriceGap{reason:'not_found_on_page'}`.
 */
export function feedDescriptorFor(skuId: string, dimensionId: string): FeedDescriptor | null {
  return DESCRIPTORS[key(skuId, dimensionId)] ?? null;
}

export const _internal = { DESCRIPTORS, AWS_DESCRIPTORS, AZURE_DESCRIPTORS, key };
