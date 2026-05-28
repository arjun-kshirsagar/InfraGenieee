/**
 * Tests for the two pure PRD→cost derivation functions.
 *
 * These run OFFLINE and FREE — both functions are pure (no I/O, no LLM, no
 * clock, no env). The suite covers every row of the docs §3 mapping table plus
 * the invariants the task calls out as 🔴: external → no role, dedup, the
 * Kafka split, the unclear-datastore default + assumption, always-on egress,
 * the SSR-vs-static client split, monotonic scale sizing, and determinism.
 */

import { describe, expect, it } from 'vitest';

import { deriveUsageProfile, mapComponentsToRoles } from '@/lib/cost/estimate/derive';
import { usageProfileSchema, type CostContext, type InfraRole } from '@/types/cost';
import type { ArchitectureComponent, BriefContext } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const BASE_CONTEXT: BriefContext = {
  userScale: 'medium',
  trafficPattern: 'steady',
  budgetBand: 'startup',
  timelineWeeks: 12,
};

function component(
  kind: ArchitectureComponent['kind'],
  technology: string,
  name = 'Component',
): ArchitectureComponent {
  return { name, kind, technology, responsibility: 'Handles a concern.' };
}

/** A realistic multi-component CostContext; override any slice per test. */
function makeCostContext(overrides: Partial<CostContext> = {}): CostContext {
  return {
    title: 'Surplus Bread Marketplace',
    context: { ...BASE_CONTEXT },
    components: [
      component('client', 'Next.js', 'Web app'),
      component('service', 'Node.js API', 'API server'),
      component('datastore', 'PostgreSQL', 'Primary DB'),
      component('cache', 'Redis', 'Session cache'),
      component('external', 'Stripe', 'Payments'),
    ],
    summary: 'A marketplace for discounted same-day surplus bread.',
    ...overrides,
  };
}

/** Just the components under test, with a neutral context and no upload signals
 *  in the summary (so `object-storage` is only added when a test asks for it). */
function ctxWith(components: ArchitectureComponent[], summary = 'A plain app.'): CostContext {
  return makeCostContext({ components, summary });
}

/* -------------------------------------------------------------------------- */
/* mapComponentsToRoles — the §3 table                                        */
/* -------------------------------------------------------------------------- */

describe('mapComponentsToRoles — §3 mapping table', () => {
  const rowsThatMapToOneRole: Array<{
    kind: ArchitectureComponent['kind'];
    tech: string;
    expected: InfraRole;
  }> = [
    // service
    { kind: 'service', tech: 'AWS Lambda', expected: 'compute-serverless' },
    { kind: 'service', tech: 'serverless function', expected: 'compute-serverless' },
    { kind: 'service', tech: 'edge function', expected: 'compute-serverless' },
    { kind: 'service', tech: 'background worker', expected: 'compute-worker' },
    { kind: 'service', tech: 'cron job', expected: 'compute-worker' },
    { kind: 'service', tech: 'batch processor', expected: 'compute-worker' },
    { kind: 'service', tech: 'Express API gateway', expected: 'compute-web' },
    { kind: 'service', tech: 'Go monolith', expected: 'compute-web' },
    // datastore
    { kind: 'datastore', tech: 'PostgreSQL', expected: 'db-relational' },
    { kind: 'datastore', tech: 'MySQL', expected: 'db-relational' },
    { kind: 'datastore', tech: 'Amazon RDS', expected: 'db-relational' },
    { kind: 'datastore', tech: 'Aurora', expected: 'db-relational' },
    { kind: 'datastore', tech: 'Prisma + SQL', expected: 'db-relational' },
    { kind: 'datastore', tech: 'DynamoDB', expected: 'db-nosql' },
    { kind: 'datastore', tech: 'Firestore', expected: 'db-nosql' },
    { kind: 'datastore', tech: 'MongoDB', expected: 'db-nosql' },
    { kind: 'datastore', tech: 'Cosmos DB', expected: 'db-nosql' },
    { kind: 'datastore', tech: 'document store', expected: 'db-nosql' },
    { kind: 'datastore', tech: 'S3 bucket', expected: 'object-storage' },
    { kind: 'datastore', tech: 'Blob storage', expected: 'object-storage' },
    { kind: 'datastore', tech: 'object store for uploads', expected: 'object-storage' },
    { kind: 'datastore', tech: 'Elasticsearch', expected: 'search' },
    { kind: 'datastore', tech: 'OpenSearch', expected: 'search' },
    { kind: 'datastore', tech: 'Algolia', expected: 'search' },
    { kind: 'datastore', tech: 'Typesense search', expected: 'search' },
    // cache
    { kind: 'cache', tech: 'Redis', expected: 'cache-redis' },
    { kind: 'cache', tech: 'Memcached', expected: 'cache-redis' },
    // queue
    { kind: 'queue', tech: 'Amazon SQS', expected: 'queue-basic' },
    { kind: 'queue', tech: 'Pub/Sub', expected: 'queue-basic' },
    // cdn
    { kind: 'cdn', tech: 'CloudFront', expected: 'cdn' },
  ];

  it.each(rowsThatMapToOneRole)(
    '$kind / "$tech" → $expected',
    ({ kind, tech, expected }) => {
      const { roles } = mapComponentsToRoles(ctxWith([component(kind, tech)]));
      expect(roles).toContain(expected);
    },
  );

  it('SSR client → BOTH static-hosting and compute-web', () => {
    for (const tech of ['Next.js', 'React SSR', 'server-side rendered']) {
      const { roles } = mapComponentsToRoles(ctxWith([component('client', tech)]));
      expect(roles).toContain('static-hosting');
      expect(roles).toContain('compute-web');
    }
  });

  it('static-only / SPA client → only static-hosting, not compute-web', () => {
    for (const tech of ['static site', 'SPA', 'Vite build']) {
      const { roles } = mapComponentsToRoles(ctxWith([component('client', tech)]));
      expect(roles).toContain('static-hosting');
      expect(roles).not.toContain('compute-web');
    }
  });

  it('mobile client hosts nothing (no static-hosting, no compute-web)', () => {
    for (const tech of ['iOS app', 'Android native', 'React Native mobile']) {
      const { roles } = mapComponentsToRoles(ctxWith([component('client', tech)]));
      expect(roles).not.toContain('static-hosting');
      expect(roles).not.toContain('compute-web');
    }
  });

  it('🔴 Kafka keywords → queue-kafka, NOT queue-basic', () => {
    for (const tech of ['Apache Kafka', 'AWS MSK', 'Confluent Cloud', 'Kinesis stream']) {
      const { roles } = mapComponentsToRoles(ctxWith([component('queue', tech)]));
      expect(roles).toContain('queue-kafka');
      expect(roles).not.toContain('queue-basic');
    }
  });
});

describe('mapComponentsToRoles — the 🔴 invariants', () => {
  it('🔴 external components contribute NO role', () => {
    const ctx = ctxWith([
      component('external', 'Stripe', 'Payments'),
      component('external', 'SendGrid', 'Email'),
    ]);
    const { roles } = mapComponentsToRoles(ctx);
    // Only egress (always-added) should survive — no compute/db/etc. from the
    // externals themselves.
    expect(roles).toEqual(['egress']);
  });

  it('🔴 three compute-web-mapping services collapse to ONE role', () => {
    const ctx = ctxWith([
      component('service', 'Express API', 'Auth service'),
      component('service', 'REST API', 'Orders service'),
      component('service', 'GraphQL gateway', 'Gateway'),
    ]);
    const { roles } = mapComponentsToRoles(ctx);
    expect(roles.filter((r) => r === 'compute-web')).toHaveLength(1);
  });

  it('egress is ALWAYS present, even for an empty-ish app', () => {
    const ctx = ctxWith([component('external', 'Stripe', 'Payments')]);
    const { roles } = mapComponentsToRoles(ctx);
    expect(roles).toContain('egress');
  });

  it('unclear datastore → db-relational AND records an assumption', () => {
    const ctx = ctxWith([component('datastore', 'a database', 'Data layer')]);
    const { roles, assumptions } = mapComponentsToRoles(ctx);
    expect(roles).toContain('db-relational');
    expect(assumptions.length).toBeGreaterThan(0);
    expect(assumptions.join(' ')).toMatch(/relational/i);
  });

  it('a clear datastore does NOT record a default-datastore assumption', () => {
    const ctx = ctxWith([component('datastore', 'PostgreSQL', 'DB')]);
    const { assumptions } = mapComponentsToRoles(ctx);
    expect(assumptions).toHaveLength(0);
  });

  it('object-storage is added from PRD upload signals with no explicit component', () => {
    const ctx = makeCostContext({
      components: [component('service', 'API', 'API')],
      summary: 'Users can upload profile photos and image attachments.',
    });
    const { roles, assumptions } = mapComponentsToRoles(ctx);
    expect(roles).toContain('object-storage');
    expect(assumptions.join(' ')).toMatch(/object storage/i);
  });

  it('object-storage assumption is NOT duplicated when an explicit object component exists', () => {
    const ctx = makeCostContext({
      components: [component('datastore', 'S3 bucket for uploads', 'Files')],
      summary: 'Users upload images.',
    });
    const { roles, assumptions } = mapComponentsToRoles(ctx);
    expect(roles.filter((r) => r === 'object-storage')).toHaveLength(1);
    expect(assumptions.join(' ')).not.toMatch(/object storage was added/i);
  });

  it('roles are returned in a stable, deterministic order', () => {
    const ctx = makeCostContext();
    const a = mapComponentsToRoles(ctx).roles;
    const b = mapComponentsToRoles(ctx).roles;
    expect(a).toEqual(b);
  });

  it('a realistic full context maps to the expected role set', () => {
    const { roles } = mapComponentsToRoles(makeCostContext());
    // client(Next.js) → static-hosting + compute-web; service → compute-web
    // (dedup); datastore(Postgres) → db-relational; cache → cache-redis;
    // external(Stripe) → nothing; + always egress.
    expect(new Set(roles)).toEqual(
      new Set<InfraRole>([
        'compute-web',
        'static-hosting',
        'db-relational',
        'cache-redis',
        'egress',
      ]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* deriveUsageProfile                                                         */
/* -------------------------------------------------------------------------- */

const SCALES = ['prototype', 'small', 'medium', 'large', 'very-large'] as const;

describe('deriveUsageProfile', () => {
  it('every userScale bucket yields a schema-valid profile', () => {
    for (const userScale of SCALES) {
      const ctx = makeCostContext({ context: { ...BASE_CONTEXT, userScale } });
      const profile = deriveUsageProfile(ctx);
      expect(() => usageProfileSchema.parse(profile)).not.toThrow();
    }
  });

  it('bigger scale never costs less — MAU, requests, storage strictly increase', () => {
    const profiles = SCALES.map((userScale) =>
      deriveUsageProfile(makeCostContext({ context: { ...BASE_CONTEXT, userScale } })),
    );
    for (let i = 1; i < profiles.length; i++) {
      expect(profiles[i].monthlyActiveUsers).toBeGreaterThan(profiles[i - 1].monthlyActiveUsers);
      expect(profiles[i].monthlyRequests).toBeGreaterThan(profiles[i - 1].monthlyRequests);
      expect(profiles[i].dbStorageGb).toBeGreaterThanOrEqual(profiles[i - 1].dbStorageGb);
      expect(profiles[i].originEgressGb).toBeGreaterThan(profiles[i - 1].originEgressGb);
    }
  });

  it('is deterministic — same input → deep-equal output', () => {
    const ctx = makeCostContext();
    expect(deriveUsageProfile(ctx)).toEqual(deriveUsageProfile(ctx));
  });

  it('origin egress is always > 0 (egress role is always present)', () => {
    const ctx = ctxWith([component('external', 'Stripe', 'Payments')]);
    expect(deriveUsageProfile(ctx).originEgressGb).toBeGreaterThan(0);
  });

  it('a spiky app runs fewer compute-hours-per-node than a steady app', () => {
    const svc = [component('service', 'API')];
    const steady = deriveUsageProfile(
      makeCostContext({ components: svc, context: { ...BASE_CONTEXT, trafficPattern: 'steady' } }),
    );
    const spiky = deriveUsageProfile(
      makeCostContext({ components: svc, context: { ...BASE_CONTEXT, trafficPattern: 'spiky' } }),
    );
    expect(spiky.computeHoursPerNode).toBeLessThan(steady.computeHoursPerNode);
  });

  it('roles the app does not use are seeded to zero, not fabricated', () => {
    // A pure static SPA: no DB, no cache, no queue, no nosql, no serverless.
    const ctx = ctxWith([component('client', 'static SPA', 'Web')]);
    const p = deriveUsageProfile(ctx);
    expect(p.dbStorageGb).toBe(0);
    expect(p.cacheGb).toBe(0);
    expect(p.queueMessagesPerMonth).toBe(0);
    expect(p.nosqlWritesPerMonth).toBe(0);
    expect(p.serverlessInvocations).toBe(0);
    expect(p.computeNodes).toBe(0); // no compute-web role
  });

  it('present roles produce non-zero seeds', () => {
    const ctx = ctxWith([
      component('service', 'API'),
      component('datastore', 'PostgreSQL'),
      component('cache', 'Redis'),
      component('queue', 'SQS'),
      component('datastore', 'DynamoDB', 'Events'),
      component('cdn', 'CloudFront'),
    ]);
    const p = deriveUsageProfile(ctx);
    expect(p.computeNodes).toBeGreaterThan(0);
    expect(p.dbStorageGb).toBeGreaterThan(0);
    expect(p.cacheGb).toBeGreaterThan(0);
    expect(p.queueMessagesPerMonth).toBeGreaterThan(0);
    expect(p.nosqlWritesPerMonth).toBeGreaterThan(0);
    expect(p.cdnEgressGb).toBeGreaterThan(0);
  });

  it('budget band nudges node count (enterprise ≥ hobby)', () => {
    const svc = [component('service', 'API')];
    const hobby = deriveUsageProfile(
      makeCostContext({ components: svc, context: { ...BASE_CONTEXT, budgetBand: 'hobby' } }),
    );
    const enterprise = deriveUsageProfile(
      makeCostContext({ components: svc, context: { ...BASE_CONTEXT, budgetBand: 'enterprise' } }),
    );
    expect(enterprise.computeNodes).toBeGreaterThanOrEqual(hobby.computeNodes);
    expect(enterprise.computeVcpuPerNode).toBeGreaterThan(hobby.computeVcpuPerNode);
  });

  it('serverless role seeds invocations from requests', () => {
    const ctx = ctxWith([component('service', 'Lambda function', 'API')]);
    const p = deriveUsageProfile(ctx);
    expect(p.serverlessInvocations).toBeGreaterThan(0);
    expect(p.computeNodes).toBe(0); // serverless, not always-on
  });
});
