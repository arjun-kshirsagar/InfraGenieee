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

/** CloudFront's per-viewer-geo egress/request meters live under this synthetic
 *  region in the Price List (not us-east-1). Verified live 2026-07-26. */
const CLOUDFRONT_REGION = 'aws-other';

/* -------------------------------------------------------------------------- */
/* AWS — feed descriptors. EC2 hours via the metered feed; everything else    */
/* via the Price List Bulk API. EVERY offerCode + attribute matcher below was  */
/* VERIFIED live against the Price List on 2026-07-26 (see the spot-checks in  */
/* aws-price-list.test.ts). Each matcher isolates EXACTLY ONE product in       */
/* us-east-1; a matcher that hits several products degrades to an `ambiguous`  */
/* gap (never a coin-flip), a matcher that hits none to a `not_found` gap, and */
/* the evidence gate proves the number on every survivor. A `priceScale` is    */
/* set wherever the Price List quotes per single item but the catalog dimension */
/* bills per batch — it MUST equal that dimension's catalog `pricePerUnits`     */
/* (asserted by aws-price-list.test.ts against the assembled catalog).          */
/* -------------------------------------------------------------------------- */

const AWS_DESCRIPTORS: Record<string, FeedDescriptor> = {
  /* ---- compute-web: EC2 on-demand hours (metered feed) ------------------ */
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

  /* ---- compute-web / compute-worker: Fargate (Price List, AmazonECS) ---- *
   * Linux/x86 vCPU-hour + GB-hour. Verified: perCPU 0.04048/hr, GB 0.004445/hr.
   * The `usagetype` (region-prefixed `USE1-`) isolates one row; ARM/Windows
   * variants carry different usagetypes and are excluded. */
  ...fargateDescriptors('aws:fargate:0-25vcpu'),
  ...fargateDescriptors('aws:fargate:0-5vcpu'),
  ...fargateDescriptors('aws:fargate:1vcpu'),
  ...fargateDescriptors('aws:fargate-worker:0-5vcpu'),
  ...fargateDescriptors('aws:fargate-worker:1vcpu'),
  ...fargateDescriptors('aws:fargate-worker:2vcpu'),

  /* ---- compute-serverless: Lambda (AWSLambda) --------------------------- *
   * requests: per-request $0.0000002 → per-million $0.20 (priceScale 1e6).
   * gb-second: x86 Tier-1 $0.0000166667; Arm Tier-1 $0.0000133334 (scale 1). */
  ...lambdaDescriptors('aws:lambda:x86-512mb', 'x86'),
  ...lambdaDescriptors('aws:lambda:x86-1024mb', 'x86'),
  ...lambdaDescriptors('aws:lambda:arm-1024mb', 'arm'),

  /* ---- static-hosting: S3 + CloudFront (S3 origin storage via AmazonS3, *
   * CDN egress/requests via AmazonCloudFront aws-other) ------------------- */
  [key('aws:s3-cloudfront:standard', 'storage-gb-month')]: s3StandardStorage(),
  [key('aws:s3-cloudfront:standard', 'cdn-egress-gb')]: cloudfrontEgress(),
  [key('aws:s3-cloudfront:standard', 'cdn-requests')]: cloudfrontRequests(10_000),

  /* ---- db-relational: RDS PostgreSQL + Aurora Serverless v2 (AmazonRDS) - */
  ...rdsDescriptors('aws:rds-postgres:t4g-micro', 'db.t4g.micro'),
  ...rdsDescriptors('aws:rds-postgres:t4g-medium', 'db.t4g.medium'),
  ...rdsDescriptors('aws:rds-postgres:m6g-large', 'db.m6g.large'),
  [key('aws:aurora-serverless-v2:standard', 'acu-hour')]: {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonRDS',
      region: AWS_REGION,
      attributes: { usagetype: 'Aurora:ServerlessV2Usage', databaseEngine: 'Aurora PostgreSQL' },
      expectedUnit: 'ACU-Hr',
    },
  },
  [key('aws:aurora-serverless-v2:standard', 'storage-gb-month')]: {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonRDS',
      region: AWS_REGION,
      attributes: { usagetype: 'Aurora:StorageUsage', databaseEngine: 'Any' },
      expectedUnit: 'GB-Mo',
    },
  },

  /* ---- db-nosql: DynamoDB on-demand (AmazonDynamoDB) -------------------- *
   * WRU/RRU quoted per single unit → per-million (priceScale 1e6). Storage
   * flattens past the $0-free first-25-GB tier to the first paid tier. */
  [key('aws:dynamodb:on-demand', 'write-request-units')]: {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonDynamoDB',
      region: AWS_REGION,
      attributes: { usagetype: 'WriteRequestUnits', group: 'DDB-WriteUnits' },
      expectedUnit: 'WriteRequestUnits',
      priceScale: 1_000_000,
    },
  },
  [key('aws:dynamodb:on-demand', 'read-request-units')]: {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonDynamoDB',
      region: AWS_REGION,
      attributes: { usagetype: 'ReadRequestUnits', group: 'DDB-ReadUnits' },
      expectedUnit: 'ReadRequestUnits',
      priceScale: 1_000_000,
    },
  },
  [key('aws:dynamodb:on-demand', 'storage-gb-month')]: {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonDynamoDB',
      region: AWS_REGION,
      attributes: { usagetype: 'TimedStorage-ByteHrs' },
      // Skip the $0.00 first-25-GB free tier; price the first PAID tier (§7).
      descriptionContains: 'beyond first 25',
      expectedUnit: 'GB-Mo',
    },
  },

  /* ---- cache-redis: ElastiCache Valkey nodes (AmazonElastiCache) -------- */
  [key('aws:elasticache:t4g-micro', 'node-hour')]: elastiCacheNode('cache.t4g.micro'),
  [key('aws:elasticache:t4g-small', 'node-hour')]: elastiCacheNode('cache.t4g.small'),
  [key('aws:elasticache:m7g-large', 'node-hour')]: elastiCacheNode('cache.m7g.large'),

  /* ---- queue-basic: SQS Standard (AWSQueueService) --------------------- *
   * Verified live in B4. Per-request $0.0000004 → per-million $0.40
   * (priceScale 1e6): without it the engine billed $0.0000004 for 1M msgs. */
  [key('aws:sqs:standard', 'requests')]: {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AWSQueueService',
      region: AWS_REGION,
      attributes: { group: 'SQS-APIRequest-Tier1', queueType: 'Standard' },
      expectedUnit: 'Requests',
      priceScale: 1_000_000,
    },
  },

  /* ---- queue-kafka: MSK Standard brokers + storage (AmazonMSK) ---------- */
  ...mskDescriptors('aws:msk:m7g-large', 'USE1-Kafka.m7g.large'),
  ...mskDescriptors('aws:msk:m5-2xlarge', 'USE1-Kafka.m5.2xlarge'),

  /* ---- object-storage: S3 Standard storage + PUT/GET requests --------- */
  [key('aws:s3:standard', 'storage-gb-month')]: s3StandardStorage(),
  [key('aws:s3:standard', 'put-requests')]: {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonS3',
      region: AWS_REGION,
      attributes: { usagetype: 'Requests-Tier1', group: 'S3-API-Tier1' },
      expectedUnit: 'Requests',
      priceScale: 1_000, // per-request → per-1,000 requests
    },
  },
  [key('aws:s3:standard', 'get-requests')]: {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonS3',
      region: AWS_REGION,
      attributes: { usagetype: 'Requests-Tier2', group: 'S3-API-Tier2' },
      expectedUnit: 'Requests',
      priceScale: 1_000, // per-request → per-1,000 requests
    },
  },

  /* ---- cdn: CloudFront pay-as-you-go egress + HTTPS requests ----------- */
  [key('aws:cloudfront:payg', 'egress-gb')]: cloudfrontEgress(),
  [key('aws:cloudfront:payg', 'https-requests')]: cloudfrontRequests(10_000),

  /* ---- search: OpenSearch data nodes + gp3 storage (AmazonES) ---------- */
  ...openSearchDescriptors('aws:opensearch:t3-small', 't3.small.search', 'ESInstance:t3.small'),
  ...openSearchDescriptors('aws:opensearch:m6g-large', 'm6g.large.search', 'ESInstance:m6g.large'),

  /* ---- egress: EC2/origin → internet (AWSDataTransfer) ----------------- *
   * Flattened to the first paid tier ($0.09/GB, first 10 TB, docs §7). */
  [key('aws:egress:internet', 'egress-gb')]: {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AWSDataTransfer',
      region: AWS_REGION,
      attributes: { transferType: 'AWS Outbound', fromLocation: 'US East (N. Virginia)' },
      expectedUnit: 'GB',
    },
  },
};

/* ---- descriptor factories (keep the table above readable) ------------- */

function fargateDescriptors(skuId: string): Record<string, FeedDescriptor> {
  return {
    [key(skuId, 'vcpu-hour')]: {
      feed: 'aws-price-list',
      query: {
        offerCode: 'AmazonECS',
        region: AWS_REGION,
        attributes: { usagetype: 'USE1-Fargate-vCPU-Hours:perCPU' },
      },
    },
    [key(skuId, 'gb-hour')]: {
      feed: 'aws-price-list',
      query: {
        offerCode: 'AmazonECS',
        region: AWS_REGION,
        attributes: { usagetype: 'USE1-Fargate-GB-Hours' },
      },
    },
  };
}

function lambdaDescriptors(skuId: string, arch: 'x86' | 'arm'): Record<string, FeedDescriptor> {
  const durationGroup = arch === 'arm' ? 'AWS-Lambda-Duration-ARM' : 'AWS-Lambda-Duration';
  const durationUsage = arch === 'arm' ? 'Lambda-GB-Second-ARM' : 'Lambda-GB-Second';
  return {
    [key(skuId, 'requests')]: {
      feed: 'aws-price-list',
      query: {
        offerCode: 'AWSLambda',
        region: AWS_REGION,
        attributes: { group: 'AWS-Lambda-Requests', usagetype: 'Request' },
        priceScale: 1_000_000, // per-request → per-million requests
      },
    },
    [key(skuId, 'gb-second')]: {
      feed: 'aws-price-list',
      query: {
        offerCode: 'AWSLambda',
        region: AWS_REGION,
        attributes: { group: durationGroup, usagetype: durationUsage },
        // Two tiers exist; the lowest beginRange (Tier-1) is picked deterministically.
      },
    },
  };
}

function rdsDescriptors(skuId: string, instanceType: string): Record<string, FeedDescriptor> {
  return {
    [key(skuId, 'instance-hour')]: {
      feed: 'aws-price-list',
      query: {
        offerCode: 'AmazonRDS',
        region: AWS_REGION,
        attributes: { instanceType, databaseEngine: 'PostgreSQL', deploymentOption: 'Single-AZ' },
        expectedUnit: 'Hrs',
      },
    },
    [key(skuId, 'storage-gb-month')]: {
      feed: 'aws-price-list',
      query: {
        offerCode: 'AmazonRDS',
        region: AWS_REGION,
        attributes: {
          databaseEngine: 'PostgreSQL',
          deploymentOption: 'Single-AZ',
          usagetype: 'RDS:GP3-Storage',
        },
        expectedUnit: 'GB-Mo',
      },
    },
  };
}

function elastiCacheNode(instanceType: string): FeedDescriptor {
  return {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonElastiCache',
      region: AWS_REGION,
      // Valkey engine + un-prefixed NodeUsage isolates the standard on-demand
      // node (excludes ExtendedSupport `USE1-…` rows and Redis/Memcached).
      attributes: {
        instanceType,
        cacheEngine: 'Valkey',
        usagetype: `NodeUsage:${instanceType}`,
      },
      expectedUnit: 'Hrs',
    },
  };
}

function mskDescriptors(skuId: string, brokerUsagetype: string): Record<string, FeedDescriptor> {
  return {
    [key(skuId, 'broker-hour')]: {
      feed: 'aws-price-list',
      query: {
        offerCode: 'AmazonMSK',
        region: AWS_REGION,
        attributes: { usagetype: brokerUsagetype },
        expectedUnit: 'hours',
      },
    },
    [key(skuId, 'storage-gb-month')]: {
      feed: 'aws-price-list',
      query: {
        offerCode: 'AmazonMSK',
        region: AWS_REGION,
        attributes: { usagetype: 'USE1-Kafka.Storage.GP2' },
        expectedUnit: 'GB-Mo',
      },
    },
  };
}

function openSearchDescriptors(
  skuId: string,
  instanceType: string,
  instanceUsagetype: string,
): Record<string, FeedDescriptor> {
  return {
    [key(skuId, 'instance-hour')]: {
      feed: 'aws-price-list',
      query: {
        offerCode: 'AmazonES',
        region: AWS_REGION,
        attributes: { instanceType, usagetype: instanceUsagetype },
        expectedUnit: 'Hrs',
      },
    },
    [key(skuId, 'storage-gb-month')]: {
      feed: 'aws-price-list',
      query: {
        offerCode: 'AmazonES',
        region: AWS_REGION,
        attributes: { usagetype: 'ES:GP3-Storage' },
        expectedUnit: 'GB-Mo',
      },
    },
  };
}

function s3StandardStorage(): FeedDescriptor {
  return {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonS3',
      region: AWS_REGION,
      attributes: { volumeType: 'Standard', usagetype: 'TimedStorage-ByteHrs' },
      // Three tiers on one SKU; the lowest beginRange = first 50 TB is picked.
      descriptionContains: 'first 50 TB',
      expectedUnit: 'GB-Mo',
    },
  };
}

function cloudfrontEgress(): FeedDescriptor {
  return {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonCloudFront',
      region: CLOUDFRONT_REGION,
      attributes: {
        transferType: 'CloudFront Outbound',
        fromLocation: 'United States',
        usagetype: 'US-DataTransfer-Out-Bytes',
      },
      // Tiered; the lowest beginRange (first 10 TB / first paid tier) is picked.
      expectedUnit: 'GB',
    },
  };
}

function cloudfrontRequests(scale: number): FeedDescriptor {
  return {
    feed: 'aws-price-list',
    query: {
      offerCode: 'AmazonCloudFront',
      region: CLOUDFRONT_REGION,
      // US HTTPS GET/HEAD (Tier2) — the "$0.0100 per 10,000 HTTPS Requests" row.
      attributes: { usagetype: 'US-Requests-Tier2-HTTPS' },
      expectedUnit: 'Requests',
      priceScale: scale, // per-request → per-10,000 requests
    },
  };
}

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
