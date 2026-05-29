/**
 * AWS half of the Feature 2 service catalog — STRUCTURE ONLY, NO PRICES.
 *
 * Every number a user eventually sees arrives as a fetched, cited `PriceRecord`
 * (see `docs/feature-2-cost-predictor.md` §5, the evidence gate). This file
 * declares only *what* to fetch and *where* to fetch it from. There is no field
 * for a price here, and there must never be one in a comment or a `notes`
 * string either — a checked-in number is indistinguishable from a fetched one.
 *
 * Priced region: us-east-1 / "US East (N. Virginia)" (see `PRICED_REGION`).
 *
 * ## Sourcing notes (why these URLs)
 *
 * Per §4 of the design doc, AWS is mixed: some human pricing pages render their
 * price tables client-side, so an extractor pointed at them sees zero numbers.
 * For EC2/SQS the numbers are fetched from the AWS Price List / metered-unit
 * JSON feeds (task B4). `pricingUrl` here is still the human page a user would
 * click to check us, per rule 2 — but it is deliberately NOT one of the
 * known-bad URLs (`aws.amazon.com/ec2/pricing/on-demand/`,
 * `aws.amazon.com/sqs/pricing/`), which are dead ends. EC2 uses the
 * `/ec2/pricing/` overview; egress uses the VPC pricing page. Fargate, Lambda,
 * S3, CloudFront (pay-as-you-go), RDS, DynamoDB, ElastiCache, MSK and
 * OpenSearch pages were each fetched on 2026-07-26 and carry real per-unit
 * numbers in-body (examples/tables) or are the correct human landing page for
 * a feed-sourced number.
 */

import type { CatalogServiceInput } from './types';

export const awsServices: CatalogServiceInput[] = [
  /* ------------------------------------------------------------------ */
  /* compute-web                                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:ec2',
    provider: 'aws',
    role: 'compute-web',
    name: 'Amazon EC2',
    kind: 'iaas',
    description:
      'Raw Linux virtual machines you operate yourself. Maximum control and the cheapest steady-state compute, at the cost of running your own OS, autoscaling and load balancer.',
    pricingUrl: 'https://aws.amazon.com/ec2/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/ec2/',
    scalingScore: 3,
    simplicityScore: 2,
    tradeoff:
      'You own patching, autoscaling and the load balancer — skip EC2 if you want the platform to keep the app alive for you.',
    freeTierNote: '750 hours/month of t2.micro or t3.micro for the first 12 months (new accounts).',
    skus: [
      {
        id: 'aws:ec2:t3-small',
        displayName: 't3.small',
        tier: 'starter',
        specs: { vcpu: 2, memoryGb: 2, summary: '2 vCPU · 2 GB · burstable' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Instance runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand Linux hourly price for a t3.small instance (2 vCPU, 2 GiB) in US East (N. Virginia), us-east-1, shared tenancy.',
          },
        ],
      },
      {
        id: 'aws:ec2:t3-medium',
        displayName: 't3.medium',
        tier: 'small',
        specs: { vcpu: 2, memoryGb: 4, summary: '2 vCPU · 4 GB · burstable' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Instance runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand Linux hourly price for a t3.medium instance (2 vCPU, 4 GiB) in US East (N. Virginia), us-east-1, shared tenancy.',
          },
        ],
      },
      {
        id: 'aws:ec2:m7i-large',
        displayName: 'm7i.large',
        tier: 'medium',
        specs: { vcpu: 2, memoryGb: 8, summary: '2 vCPU · 8 GB · general purpose' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Instance runtime',
            quantityKey: 'instanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand Linux hourly price for an m7i.large instance (2 vCPU, 8 GiB) in US East (N. Virginia), us-east-1, shared tenancy.',
          },
        ],
      },
    ],
  },
  {
    id: 'aws:fargate',
    provider: 'aws',
    role: 'compute-web',
    name: 'AWS Fargate',
    kind: 'serverless',
    description:
      'Serverless containers on ECS: you pick vCPU and memory, AWS runs the host. No servers to patch; billed per vCPU-second and GB-second while the task runs.',
    pricingUrl: 'https://aws.amazon.com/fargate/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/AmazonECS/latest/userguide/what-is-fargate.html',
    scalingScore: 4,
    simplicityScore: 4,
    tradeoff:
      'Per-second container pricing is pricier than a reserved EC2 box at steady 24/7 load — pick EC2 once utilisation is predictably high.',
    skus: [
      {
        id: 'aws:fargate:0-25vcpu',
        displayName: 'Fargate 0.25 vCPU',
        tier: 'starter',
        specs: { vcpu: 0.25, memoryGb: 0.5, summary: '0.25 vCPU · 0.5 GB · Linux/x86' },
        dimensions: [
          {
            id: 'vcpu-hour',
            label: 'vCPU runtime',
            quantityKey: 'vcpuHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Fargate Linux/x86 per-vCPU price (per vCPU per hour) in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'gb-hour',
            label: 'Memory runtime',
            quantityKey: 'gbRamHours',
            unit: 'USD / GB-hour',
            extractionHint:
              'Fargate Linux/x86 per-GB memory price (per GB per hour) in US East (N. Virginia), us-east-1.',
          },
        ],
      },
      {
        id: 'aws:fargate:0-5vcpu',
        displayName: 'Fargate 0.5 vCPU',
        tier: 'small',
        specs: { vcpu: 0.5, memoryGb: 1, summary: '0.5 vCPU · 1 GB · Linux/x86' },
        dimensions: [
          {
            id: 'vcpu-hour',
            label: 'vCPU runtime',
            quantityKey: 'vcpuHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Fargate Linux/x86 per-vCPU price (per vCPU per hour) in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'gb-hour',
            label: 'Memory runtime',
            quantityKey: 'gbRamHours',
            unit: 'USD / GB-hour',
            extractionHint:
              'Fargate Linux/x86 per-GB memory price (per GB per hour) in US East (N. Virginia), us-east-1.',
          },
        ],
      },
      {
        id: 'aws:fargate:1vcpu',
        displayName: 'Fargate 1 vCPU',
        tier: 'medium',
        specs: { vcpu: 1, memoryGb: 2, summary: '1 vCPU · 2 GB · Linux/x86' },
        dimensions: [
          {
            id: 'vcpu-hour',
            label: 'vCPU runtime',
            quantityKey: 'vcpuHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Fargate Linux/x86 per-vCPU price (per vCPU per hour) in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'gb-hour',
            label: 'Memory runtime',
            quantityKey: 'gbRamHours',
            unit: 'USD / GB-hour',
            extractionHint:
              'Fargate Linux/x86 per-GB memory price (per GB per hour) in US East (N. Virginia), us-east-1.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* compute-worker                                                     */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:fargate-worker',
    provider: 'aws',
    role: 'compute-worker',
    name: 'AWS Fargate (worker)',
    kind: 'serverless',
    description:
      'The same Fargate container platform run as a background worker/consumer instead of behind a load balancer. Billed per vCPU-second and GB-second while the task runs.',
    pricingUrl: 'https://aws.amazon.com/fargate/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/AmazonECS/latest/userguide/what-is-fargate.html',
    scalingScore: 4,
    simplicityScore: 4,
    tradeoff:
      'For a worker pinned at 100% CPU around the clock, a reserved EC2 instance is cheaper than per-second Fargate.',
    skus: [
      {
        id: 'aws:fargate-worker:0-5vcpu',
        displayName: 'Worker 0.5 vCPU',
        tier: 'starter',
        specs: { vcpu: 0.5, memoryGb: 1, summary: '0.5 vCPU · 1 GB · Linux/x86' },
        dimensions: [
          {
            id: 'vcpu-hour',
            label: 'vCPU runtime',
            quantityKey: 'vcpuHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Fargate Linux/x86 per-vCPU price (per vCPU per hour) in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'gb-hour',
            label: 'Memory runtime',
            quantityKey: 'gbRamHours',
            unit: 'USD / GB-hour',
            extractionHint:
              'Fargate Linux/x86 per-GB memory price (per GB per hour) in US East (N. Virginia), us-east-1.',
          },
        ],
      },
      {
        id: 'aws:fargate-worker:1vcpu',
        displayName: 'Worker 1 vCPU',
        tier: 'small',
        specs: { vcpu: 1, memoryGb: 2, summary: '1 vCPU · 2 GB · Linux/x86' },
        dimensions: [
          {
            id: 'vcpu-hour',
            label: 'vCPU runtime',
            quantityKey: 'vcpuHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Fargate Linux/x86 per-vCPU price (per vCPU per hour) in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'gb-hour',
            label: 'Memory runtime',
            quantityKey: 'gbRamHours',
            unit: 'USD / GB-hour',
            extractionHint:
              'Fargate Linux/x86 per-GB memory price (per GB per hour) in US East (N. Virginia), us-east-1.',
          },
        ],
      },
      {
        id: 'aws:fargate-worker:2vcpu',
        displayName: 'Worker 2 vCPU',
        tier: 'medium',
        specs: { vcpu: 2, memoryGb: 4, summary: '2 vCPU · 4 GB · Linux/x86' },
        dimensions: [
          {
            id: 'vcpu-hour',
            label: 'vCPU runtime',
            quantityKey: 'vcpuHours',
            unit: 'USD / vCPU-hour',
            extractionHint:
              'Fargate Linux/x86 per-vCPU price (per vCPU per hour) in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'gb-hour',
            label: 'Memory runtime',
            quantityKey: 'gbRamHours',
            unit: 'USD / GB-hour',
            extractionHint:
              'Fargate Linux/x86 per-GB memory price (per GB per hour) in US East (N. Virginia), us-east-1.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* compute-serverless                                                 */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:lambda',
    provider: 'aws',
    role: 'compute-serverless',
    name: 'AWS Lambda',
    kind: 'serverless',
    description:
      'Per-request functions that scale to zero. Billed on invocation count and GB-seconds of execution (memory × duration). Ideal for spiky or event-driven workloads.',
    pricingUrl: 'https://aws.amazon.com/lambda/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/lambda/latest/dg/welcome.html',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'At sustained high throughput the per-GB-second rate overtakes an always-on container — Lambda wins on spiky, not steady, load.',
    freeTierNote: '1M free requests and 400,000 GB-seconds of compute per month, indefinitely.',
    skus: [
      {
        id: 'aws:lambda:x86-512mb',
        displayName: 'Lambda 512 MB (x86)',
        tier: 'starter',
        specs: { memoryGb: 0.5, summary: '512 MB · x86 · scale-to-zero' },
        dimensions: [
          {
            id: 'requests',
            label: 'Invocations',
            quantityKey: 'invocations',
            unit: 'USD / million requests',
            extractionHint:
              'Lambda price per 1 million requests for x86 functions in US East (N. Virginia), us-east-1 (the flat request charge, not the duration charge).',
          },
          {
            id: 'gb-second',
            label: 'Compute duration',
            quantityKey: 'gbSeconds',
            unit: 'USD / GB-second',
            extractionHint:
              'Lambda x86 duration price per GB-second in US East (N. Virginia), us-east-1, first pricing tier (on-demand, not Managed Instances).',
          },
        ],
      },
      {
        id: 'aws:lambda:x86-1024mb',
        displayName: 'Lambda 1 GB (x86)',
        tier: 'small',
        specs: { memoryGb: 1, summary: '1024 MB · x86 · scale-to-zero' },
        dimensions: [
          {
            id: 'requests',
            label: 'Invocations',
            quantityKey: 'invocations',
            unit: 'USD / million requests',
            extractionHint:
              'Lambda price per 1 million requests for x86 functions in US East (N. Virginia), us-east-1 (the flat request charge, not the duration charge).',
          },
          {
            id: 'gb-second',
            label: 'Compute duration',
            quantityKey: 'gbSeconds',
            unit: 'USD / GB-second',
            extractionHint:
              'Lambda x86 duration price per GB-second in US East (N. Virginia), us-east-1, first pricing tier (on-demand, not Managed Instances).',
          },
        ],
      },
      {
        id: 'aws:lambda:arm-1024mb',
        displayName: 'Lambda 1 GB (Arm)',
        tier: 'medium',
        specs: { memoryGb: 1, summary: '1024 MB · Arm/Graviton · scale-to-zero' },
        dimensions: [
          {
            id: 'requests',
            label: 'Invocations',
            quantityKey: 'invocations',
            unit: 'USD / million requests',
            extractionHint:
              'Lambda price per 1 million requests for Arm/Graviton functions in US East (N. Virginia), us-east-1 (the flat request charge).',
          },
          {
            id: 'gb-second',
            label: 'Compute duration',
            quantityKey: 'gbSeconds',
            unit: 'USD / GB-second',
            extractionHint:
              'Lambda Arm/Graviton duration price per GB-second in US East (N. Virginia), us-east-1, first pricing tier (on-demand).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* static-hosting  (S3 origin + CloudFront edge)                      */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:s3-cloudfront',
    provider: 'aws',
    role: 'static-hosting',
    name: 'Amazon S3 + CloudFront',
    kind: 'managed',
    description:
      'Static site / SPA hosting: assets live in an S3 bucket and are served worldwide through the CloudFront CDN. Billed on stored GB, edge egress GB and requests.',
    pricingUrl: 'https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/',
    docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html',
    scalingScore: 5,
    simplicityScore: 4,
    tradeoff:
      'Serves static assets only — anything server-rendered still needs a compute-web service alongside it.',
    freeTierNote:
      'CloudFront always-free tier: 1 TB egress and 10M requests per month. S3: 5 GB standard storage for 12 months (new accounts).',
    skus: [
      {
        id: 'aws:s3-cloudfront:standard',
        displayName: 'S3 Standard + CloudFront',
        tier: 'small',
        specs: { summary: 'S3 Standard origin · CloudFront edge · US pricing' },
        dimensions: [
          {
            id: 'storage-gb-month',
            label: 'Origin storage',
            quantityKey: 'objectStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'S3 Standard storage price per GB-month for the first 50 TB tier in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'cdn-egress-gb',
            label: 'CDN data transfer out',
            quantityKey: 'cdnEgressGb',
            unit: 'USD / GB',
            extractionHint:
              'CloudFront pay-as-you-go Regional Data Transfer Out to internet per GB for United States, Mexico, and Canada, the "Next 9TB" (first paid) tier after the free 1 TB.',
          },
          {
            id: 'cdn-requests',
            label: 'CDN HTTPS requests',
            quantityKey: 'cdnRequests',
            unit: 'USD / 10,000 requests',
            extractionHint:
              'CloudFront pay-as-you-go price per 10,000 HTTPS requests for United States, Mexico, and Canada (after the first 10M free requests).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* db-relational                                                      */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:rds-postgres',
    provider: 'aws',
    role: 'db-relational',
    name: 'Amazon RDS for PostgreSQL',
    kind: 'managed',
    description:
      'Fully managed PostgreSQL: AWS handles backups, patching and failover. You pick an instance class and storage; billed per DB instance-hour plus provisioned storage.',
    pricingUrl: 'https://aws.amazon.com/rds/postgresql/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html',
    scalingScore: 3,
    simplicityScore: 4,
    tradeoff:
      'A single-AZ instance runs 24/7 whether or not it gets traffic — for bursty or intermittent load Aurora Serverless scales down further.',
    freeTierNote:
      '750 hours/month of a Single-AZ db.t-class instance, 20 GB gp2 storage and 20 GB backup for the first 12 months (new accounts).',
    skus: [
      {
        id: 'aws:rds-postgres:t4g-micro',
        displayName: 'db.t4g.micro (Single-AZ)',
        tier: 'starter',
        specs: { vcpu: 2, memoryGb: 1, summary: '2 vCPU · 1 GB · Single-AZ · burstable' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'DB instance runtime',
            quantityKey: 'dbInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand hourly price for a db.t4g.micro Single-AZ RDS PostgreSQL instance in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'storage-gb-month',
            label: 'Provisioned storage',
            quantityKey: 'dbStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'gp3 General Purpose SSD storage price per GB-month for Single-AZ RDS PostgreSQL in US East (N. Virginia), us-east-1.',
          },
        ],
      },
      {
        id: 'aws:rds-postgres:t4g-medium',
        displayName: 'db.t4g.medium (Single-AZ)',
        tier: 'small',
        specs: { vcpu: 2, memoryGb: 4, summary: '2 vCPU · 4 GB · Single-AZ · burstable' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'DB instance runtime',
            quantityKey: 'dbInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand hourly price for a db.t4g.medium Single-AZ RDS PostgreSQL instance in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'storage-gb-month',
            label: 'Provisioned storage',
            quantityKey: 'dbStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'gp3 General Purpose SSD storage price per GB-month for Single-AZ RDS PostgreSQL in US East (N. Virginia), us-east-1.',
          },
        ],
      },
      {
        id: 'aws:rds-postgres:m6g-large',
        displayName: 'db.m6g.large (Single-AZ)',
        tier: 'medium',
        specs: { vcpu: 2, memoryGb: 8, summary: '2 vCPU · 8 GB · Single-AZ · general purpose' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'DB instance runtime',
            quantityKey: 'dbInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand hourly price for a db.m6g.large Single-AZ RDS PostgreSQL instance in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'storage-gb-month',
            label: 'Provisioned storage',
            quantityKey: 'dbStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'gp3 General Purpose SSD storage price per GB-month for Single-AZ RDS PostgreSQL in US East (N. Virginia), us-east-1.',
          },
        ],
      },
    ],
  },
  {
    id: 'aws:aurora-serverless-v2',
    provider: 'aws',
    role: 'db-relational',
    name: 'Amazon Aurora Serverless v2 (PostgreSQL)',
    kind: 'serverless',
    description:
      'PostgreSQL-compatible Aurora that scales capacity in fine-grained ACU steps and can idle down. Billed per ACU-hour plus storage; suits variable or unpredictable load.',
    pricingUrl: 'https://aws.amazon.com/rds/aurora/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html',
    scalingScore: 5,
    simplicityScore: 3,
    tradeoff:
      'Per-ACU-hour pricing is more expensive than a right-sized fixed instance at steady load — its edge is idling down when traffic drops.',
    skus: [
      {
        id: 'aws:aurora-serverless-v2:standard',
        displayName: 'Aurora Serverless v2',
        tier: 'small',
        specs: { summary: 'Auto-scaling ACUs · 2 GB RAM per ACU · scales to a floor' },
        dimensions: [
          {
            id: 'acu-hour',
            label: 'Aurora Capacity Unit runtime',
            quantityKey: 'dbInstanceHours',
            unit: 'USD / ACU-hour',
            extractionHint:
              'Aurora Serverless v2 price per ACU-hour (Aurora Capacity Unit) for Aurora PostgreSQL-Compatible Edition in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'storage-gb-month',
            label: 'Database storage',
            quantityKey: 'dbStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'Aurora PostgreSQL storage rate per GB-month (Standard storage) in US East (N. Virginia), us-east-1.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* db-nosql                                                           */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:dynamodb',
    provider: 'aws',
    role: 'db-nosql',
    name: 'Amazon DynamoDB',
    kind: 'serverless',
    description:
      'Serverless key-value / document store. On-demand mode bills per read and write request unit plus stored GB, with no capacity to provision — scales to zero cost at rest.',
    pricingUrl: 'https://aws.amazon.com/dynamodb/pricing/on-demand/',
    docsUrl: 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html',
    scalingScore: 5,
    simplicityScore: 4,
    tradeoff:
      'A key-value access model — if you need ad-hoc joins or rich queries, a relational database fits better.',
    freeTierNote: '25 GB storage plus 25 provisioned WCU/RCU per month (DynamoDB free tier).',
    skus: [
      {
        id: 'aws:dynamodb:on-demand',
        displayName: 'DynamoDB On-Demand',
        tier: 'small',
        specs: { summary: 'On-demand capacity · Standard table class · pay per request' },
        dimensions: [
          {
            id: 'write-request-units',
            label: 'Write request units',
            quantityKey: 'nosqlWrites',
            unit: 'USD / million WRU',
            extractionHint:
              'DynamoDB on-demand price per million write request units (WRU) for the Standard table class in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'read-request-units',
            label: 'Read request units',
            quantityKey: 'nosqlReads',
            unit: 'USD / million RRU',
            extractionHint:
              'DynamoDB on-demand price per million read request units (RRU), eventually-consistent, Standard table class, in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'storage-gb-month',
            label: 'Stored data',
            quantityKey: 'nosqlStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'DynamoDB Standard table class data storage price per GB-month in US East (N. Virginia), us-east-1.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* cache-redis                                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:elasticache',
    provider: 'aws',
    role: 'cache-redis',
    name: 'Amazon ElastiCache',
    kind: 'managed',
    description:
      'Managed Redis-compatible in-memory cache. You choose an on-demand node type; billed per cache node-hour. AWS handles the engine, failover and patching.',
    pricingUrl: 'https://aws.amazon.com/elasticache/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.html',
    scalingScore: 3,
    simplicityScore: 4,
    tradeoff:
      'On-demand nodes run 24/7 regardless of hit rate — for spiky cache traffic ElastiCache Serverless bills closer to actual use.',
    freeTierNote:
      '750 hours/month of a cache.t3.micro node for 12 months if you signed up before 15 Jul 2025.',
    skus: [
      {
        id: 'aws:elasticache:t4g-micro',
        displayName: 'cache.t4g.micro',
        tier: 'starter',
        specs: { memoryGb: 0.5, nodes: 1, summary: '~0.5 GB · 1 node · burstable' },
        dimensions: [
          {
            id: 'node-hour',
            label: 'Cache node runtime',
            quantityKey: 'cacheInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand hourly price for a cache.t4g.micro ElastiCache Valkey node in US East (N. Virginia), us-east-1.',
          },
        ],
      },
      {
        id: 'aws:elasticache:t4g-small',
        displayName: 'cache.t4g.small',
        tier: 'small',
        specs: { memoryGb: 1.37, nodes: 1, summary: '~1.4 GB · 1 node · burstable' },
        dimensions: [
          {
            id: 'node-hour',
            label: 'Cache node runtime',
            quantityKey: 'cacheInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand hourly price for a cache.t4g.small ElastiCache Valkey node in US East (N. Virginia), us-east-1.',
          },
        ],
      },
      {
        id: 'aws:elasticache:m7g-large',
        displayName: 'cache.m7g.large',
        tier: 'medium',
        specs: { memoryGb: 6.38, nodes: 1, summary: '~6.4 GB · 1 node · general purpose' },
        dimensions: [
          {
            id: 'node-hour',
            label: 'Cache node runtime',
            quantityKey: 'cacheInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand hourly price for a cache.m7g.large ElastiCache Valkey node in US East (N. Virginia), us-east-1.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* queue-basic                                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:sqs',
    provider: 'aws',
    role: 'queue-basic',
    name: 'Amazon SQS',
    kind: 'serverless',
    description:
      'Fully managed message queue billed purely per request (send / receive / delete). No brokers to run and no idle cost — scales to zero when quiet.',
    pricingUrl: 'https://aws.amazon.com/sqs/',
    docsUrl: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'A plain queue with at-least-once delivery — if you need durable, replayable event streams, choose Kafka (MSK) instead.',
    freeTierNote: '1M free requests per month, indefinitely.',
    skus: [
      {
        id: 'aws:sqs:standard',
        displayName: 'SQS Standard',
        tier: 'small',
        specs: { summary: 'Standard queue · at-least-once · pay per request' },
        dimensions: [
          {
            id: 'requests',
            label: 'Queue requests',
            quantityKey: 'queueMessages',
            unit: 'USD / million requests',
            extractionHint:
              'Amazon SQS Standard queue price per 1 million requests in US East (N. Virginia), us-east-1 (the first paid tier after the 1M free requests).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* queue-kafka                                                        */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:msk',
    provider: 'aws',
    role: 'queue-kafka',
    name: 'Amazon MSK',
    kind: 'managed',
    description:
      'Managed Apache Kafka. You choose broker instance type and count; billed per broker-hour plus provisioned storage GB-month. Durable, replayable event streaming.',
    pricingUrl: 'https://aws.amazon.com/msk/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/msk/latest/developerguide/what-is-msk.html',
    scalingScore: 4,
    simplicityScore: 2,
    tradeoff:
      'Brokers run 24/7 with a multi-broker minimum, so it is heavy and pricey for a low-volume queue — reach for SQS unless you genuinely need Kafka semantics.',
    skus: [
      {
        id: 'aws:msk:m7g-large',
        displayName: 'kafka.m7g.large broker',
        tier: 'small',
        specs: { vcpu: 2, memoryGb: 8, nodes: 3, summary: '2 vCPU · 8 GB · per broker (3-broker min)' },
        dimensions: [
          {
            id: 'broker-hour',
            label: 'Broker runtime',
            quantityKey: 'kafkaBrokerHours',
            unit: 'USD / broker-hour',
            extractionHint:
              'Amazon MSK Standard broker hourly price for a kafka.m7g.large broker instance in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'storage-gb-month',
            label: 'Broker storage',
            quantityKey: 'kafkaStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'Amazon MSK broker storage price per GB-month in US East (N. Virginia), us-east-1.',
          },
        ],
      },
      {
        id: 'aws:msk:m5-2xlarge',
        displayName: 'kafka.m5.2xlarge broker',
        tier: 'medium',
        specs: { vcpu: 8, memoryGb: 32, nodes: 3, summary: '8 vCPU · 32 GB · per broker (3-broker min)' },
        dimensions: [
          {
            id: 'broker-hour',
            label: 'Broker runtime',
            quantityKey: 'kafkaBrokerHours',
            unit: 'USD / broker-hour',
            extractionHint:
              'Amazon MSK Standard broker hourly price for a kafka.m5.2xlarge broker instance in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'storage-gb-month',
            label: 'Broker storage',
            quantityKey: 'kafkaStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'Amazon MSK broker storage price per GB-month in US East (N. Virginia), us-east-1.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* object-storage                                                     */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:s3',
    provider: 'aws',
    role: 'object-storage',
    name: 'Amazon S3',
    kind: 'managed',
    description:
      'Durable object storage for uploads, backups and blobs. Billed on stored GB-month plus PUT/GET request charges. The default storage class is S3 Standard.',
    pricingUrl: 'https://aws.amazon.com/s3/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html',
    scalingScore: 5,
    simplicityScore: 5,
    tradeoff:
      'Object storage, not a filesystem — apps needing POSIX file semantics or low-latency random writes want EFS/EBS instead.',
    freeTierNote: '5 GB of S3 Standard storage for the first 12 months (new accounts).',
    skus: [
      {
        id: 'aws:s3:standard',
        displayName: 'S3 Standard',
        tier: 'small',
        specs: { summary: 'S3 Standard class · single region · 11 nines durability' },
        dimensions: [
          {
            id: 'storage-gb-month',
            label: 'Stored data',
            quantityKey: 'objectStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'S3 Standard storage price per GB-month for the first 50 TB tier in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'put-requests',
            label: 'PUT / COPY / POST requests',
            quantityKey: 'objectWriteOps',
            unit: 'USD / 1,000 requests',
            extractionHint:
              'S3 Standard price per 1,000 PUT, COPY, POST or LIST requests in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'get-requests',
            label: 'GET / SELECT requests',
            quantityKey: 'objectReadOps',
            unit: 'USD / 1,000 requests',
            extractionHint:
              'S3 Standard price per 1,000 GET, SELECT and all other requests in US East (N. Virginia), us-east-1.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* cdn                                                                */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:cloudfront',
    provider: 'aws',
    role: 'cdn',
    name: 'Amazon CloudFront',
    kind: 'managed',
    description:
      'Global CDN / edge cache in front of your app. Pay-as-you-go billing is per GB of data transferred out to the internet plus per-request charges.',
    pricingUrl: 'https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/',
    docsUrl: 'https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html',
    scalingScore: 5,
    simplicityScore: 4,
    tradeoff:
      'Per-GB egress adds up at very high sustained volume, where a flat-rate CloudFront plan or a bandwidth-pooled provider can be cheaper.',
    freeTierNote: 'Always-free tier: 1 TB data transfer out and 10M requests per month.',
    skus: [
      {
        id: 'aws:cloudfront:payg',
        displayName: 'CloudFront pay-as-you-go',
        tier: 'small',
        specs: { summary: 'Per-GB egress + per-request · US/Canada/Mexico pricing' },
        dimensions: [
          {
            id: 'egress-gb',
            label: 'Data transfer out',
            quantityKey: 'cdnEgressGb',
            unit: 'USD / GB',
            extractionHint:
              'CloudFront pay-as-you-go Regional Data Transfer Out to internet per GB for United States, Mexico, and Canada, the "Next 9TB" (first paid) tier after the free 1 TB.',
          },
          {
            id: 'https-requests',
            label: 'HTTPS requests',
            quantityKey: 'cdnRequests',
            unit: 'USD / 10,000 requests',
            extractionHint:
              'CloudFront pay-as-you-go price per 10,000 HTTPS requests for United States, Mexico, and Canada (after the first 10M free requests).',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* search                                                             */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:opensearch',
    provider: 'aws',
    role: 'search',
    name: 'Amazon OpenSearch Service',
    kind: 'managed',
    description:
      'Managed OpenSearch (Elasticsearch-compatible) cluster for full-text search and log analytics. Billed per data-node instance-hour plus EBS index storage GB-month.',
    pricingUrl: 'https://aws.amazon.com/opensearch-service/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/opensearch-service/latest/developerguide/what-is.html',
    scalingScore: 3,
    simplicityScore: 3,
    tradeoff:
      'A managed cluster runs 24/7 with a node minimum — for occasional search a serverless collection or a hosted SaaS may cost less.',
    skus: [
      {
        id: 'aws:opensearch:t3-small',
        displayName: 't3.small.search',
        tier: 'starter',
        specs: { vcpu: 2, memoryGb: 2, nodes: 1, summary: '2 vCPU · 2 GB · 1 data node' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Data node runtime',
            quantityKey: 'searchInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand hourly price for a t3.small.search OpenSearch Service data node in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'storage-gb-month',
            label: 'Index storage (EBS gp3)',
            quantityKey: 'searchStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'EBS gp3 storage price per GB-month attached to OpenSearch Service data nodes in US East (N. Virginia), us-east-1.',
          },
        ],
      },
      {
        id: 'aws:opensearch:m6g-large',
        displayName: 'm6g.large.search',
        tier: 'medium',
        specs: { vcpu: 2, memoryGb: 8, nodes: 1, summary: '2 vCPU · 8 GB · 1 data node' },
        dimensions: [
          {
            id: 'instance-hour',
            label: 'Data node runtime',
            quantityKey: 'searchInstanceHours',
            unit: 'USD / hour',
            extractionHint:
              'On-Demand hourly price for an m6g.large.search OpenSearch Service data node in US East (N. Virginia), us-east-1.',
          },
          {
            id: 'storage-gb-month',
            label: 'Index storage (EBS gp3)',
            quantityKey: 'searchStorageGbMonth',
            unit: 'USD / GB-month',
            extractionHint:
              'EBS gp3 storage price per GB-month attached to OpenSearch Service data nodes in US East (N. Virginia), us-east-1.',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------------------ */
  /* egress                                                             */
  /* ------------------------------------------------------------------ */
  {
    id: 'aws:egress',
    provider: 'aws',
    role: 'egress',
    name: 'AWS Data Transfer Out',
    kind: 'managed',
    description:
      'Data transferred out from AWS compute/origin to the public internet, billed per GB. Frequently a top-three line item that is invisible if you only price the boxes.',
    pricingUrl: 'https://aws.amazon.com/vpc/pricing/',
    docsUrl: 'https://docs.aws.amazon.com/whitepapers/latest/aws-overview/networking-services.html',
    scalingScore: 3,
    simplicityScore: 3,
    tradeoff:
      'Origin egress bypasses the CDN, so routing user-facing traffic through CloudFront instead usually lands a lower per-GB rate.',
    freeTierNote: '100 GB of data transfer out to the internet per month, aggregated across most services.',
    skus: [
      {
        id: 'aws:egress:internet',
        displayName: 'Internet data transfer out',
        tier: 'small',
        specs: { summary: 'EC2/origin → internet · US East · first paid tier' },
        dimensions: [
          {
            id: 'egress-gb',
            label: 'Data transfer out',
            quantityKey: 'egressGb',
            unit: 'USD / GB',
            extractionHint:
              'EC2 Data Transfer Out to internet price per GB for the first paid tier (up to 10 TB/month) from US East (N. Virginia), us-east-1, after the 100 GB free allowance.',
          },
        ],
      },
    ],
  },
];
