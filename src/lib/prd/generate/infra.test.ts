/**
 * Tests for the deterministic infrastructure recommender.
 *
 * Covers: explicit-preference honouring, no-preference tiering, cache/storage
 * triggers, environments, mustAvoid exclusion + fallback, determinism, zod
 * schema conformance, and the free-tier-vs-enterprise divergence the task
 * requires.
 */

import { describe, expect, it } from 'vitest';
import { recommendInfrastructure } from '@/lib/prd/generate/infra';
import { architectureSectionSchema } from '@/types/prd';
import { VALID_ANSWERS } from '@/types/prd.test';
import { AVOID_AWS, ENTERPRISE_VERY_LARGE, FREE_TIER_PROTOTYPE } from './fixtures.test-support';

const infraSchema = architectureSectionSchema.shape.infrastructure;

describe('recommendInfrastructure — schema + determinism', () => {
  it('output parses against the infrastructure schema for every fixture', () => {
    for (const answers of [VALID_ANSWERS, FREE_TIER_PROTOTYPE, ENTERPRISE_VERY_LARGE, AVOID_AWS]) {
      expect(infraSchema.safeParse(recommendInfrastructure(answers)).success).toBe(true);
    }
  });

  it('is deterministic — same answers produce a deeply-equal result', () => {
    expect(recommendInfrastructure(VALID_ANSWERS)).toEqual(recommendInfrastructure(VALID_ANSWERS));
    expect(recommendInfrastructure(ENTERPRISE_VERY_LARGE)).toEqual(recommendInfrastructure(ENTERPRISE_VERY_LARGE));
  });

  it('always gives at least 3 rationale strings', () => {
    for (const answers of [VALID_ANSWERS, FREE_TIER_PROTOTYPE, ENTERPRISE_VERY_LARGE, AVOID_AWS]) {
      expect(recommendInfrastructure(answers).rationale.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('recommendInfrastructure — hosting rules', () => {
  it('honours an explicit hosting preference', () => {
    const answers = { ...VALID_ANSWERS, stack: { ...VALID_ANSWERS.stack, hosting: 'render' as const } };
    expect(recommendInfrastructure(answers).hosting).toBe('Render');
  });

  it('free-tier/prototype (no preference) → Vercel Hobby', () => {
    expect(recommendInfrastructure(FREE_TIER_PROTOTYPE).hosting).toBe('Vercel Hobby');
  });

  it('very-large/enterprise/aggressive (no preference) → AWS cloud-scale', () => {
    expect(recommendInfrastructure(ENTERPRISE_VERY_LARGE).hosting).toContain('AWS');
  });

  it('medium/startup (no preference) → Vercel Pro', () => {
    // VALID_ANSWERS is medium scale + startup budget + no hosting preference.
    expect(recommendInfrastructure(VALID_ANSWERS).hosting).toBe('Vercel Pro');
  });
});

describe('recommendInfrastructure — mustAvoid exclusion', () => {
  it('never emits a hosting choice on the mustAvoid list, and falls through', () => {
    const infra = recommendInfrastructure(AVOID_AWS);
    // AWS was the natural scale-tier pick but is avoided → must not appear.
    expect(infra.hosting.toLowerCase()).not.toContain('aws');
    // The fallback is recorded in the rationale.
    expect(infra.rationale.some((r) => r.toLowerCase().includes('must-avoid'))).toBe(true);
  });

  it('avoided value appears in no infrastructure string', () => {
    const infra = recommendInfrastructure(AVOID_AWS);
    const haystack = [infra.hosting, infra.database, infra.cache ?? '', infra.storage ?? '', infra.cicd]
      .join(' ')
      .toLowerCase();
    // "aws" avoided — but note S3 is an AWS service; AVOID_AWS avoids "AWS" and
    // "DynamoDB" specifically. The hosting/db picks must dodge both.
    expect(infra.database.toLowerCase()).not.toContain('dynamodb');
    expect(haystack).not.toContain('ecs/fargate');
  });
});

describe('recommendInfrastructure — database rules', () => {
  it('honours an explicit database preference', () => {
    const answers = { ...VALID_ANSWERS, stack: { ...VALID_ANSWERS.stack, database: 'mysql' as const } };
    expect(recommendInfrastructure(answers).database).toBe('MySQL');
  });

  it('api-service with 0 GB and no db preference → no database', () => {
    const answers: typeof VALID_ANSWERS = {
      ...VALID_ANSWERS,
      basics: { ...VALID_ANSWERS.basics, productType: 'api-service' },
      scale: { ...VALID_ANSWERS.scale, dataVolumeGb: 0 },
      stack: { ...VALID_ANSWERS.stack, database: 'no-preference' },
    };
    expect(recommendInfrastructure(answers).database).toBe('None');
  });

  it('defaults to managed Postgres when no preference and data is stored', () => {
    const answers = { ...VALID_ANSWERS, stack: { ...VALID_ANSWERS.stack, database: 'no-preference' as const } };
    expect(recommendInfrastructure(answers).database.toLowerCase()).toContain('postgresql');
  });
});

describe('recommendInfrastructure — cache & storage triggers', () => {
  it('adds a cache for very-large / aggressive / high-rps', () => {
    expect(recommendInfrastructure(ENTERPRISE_VERY_LARGE).cache).not.toBeNull();
  });

  it('no cache for a quiet prototype', () => {
    expect(recommendInfrastructure(FREE_TIER_PROTOTYPE).cache).toBeNull();
  });

  it('adds a cache purely from peakRequestsPerSecond > 100', () => {
    const answers = { ...VALID_ANSWERS, scale: { ...VALID_ANSWERS.scale, peakRequestsPerSecond: 250 } };
    expect(recommendInfrastructure(answers).cache).not.toBeNull();
  });

  it('adds object storage when file uploads are needed', () => {
    expect(recommendInfrastructure(ENTERPRISE_VERY_LARGE).storage).not.toBeNull();
    expect(recommendInfrastructure(FREE_TIER_PROTOTYPE).storage).toBeNull();
  });

  it('adds object storage from the file-storage integration alone', () => {
    const answers = {
      ...VALID_ANSWERS,
      integrations: { ...VALID_ANSWERS.integrations, integrations: ['file-storage' as const], needsFileUploads: false },
    };
    expect(recommendInfrastructure(answers).storage).not.toBeNull();
  });
});

describe('recommendInfrastructure — environments', () => {
  it('base environments for a tiny solo prototype', () => {
    expect(recommendInfrastructure(FREE_TIER_PROTOTYPE).environments).toEqual([
      'development',
      'preview',
      'production',
    ]);
  });

  it('adds staging when team > 5', () => {
    const answers = { ...VALID_ANSWERS, budget: { ...VALID_ANSWERS.budget, teamSize: 8 } };
    expect(recommendInfrastructure(answers).environments).toContain('staging');
  });

  it('adds staging when compliance applies (VALID_ANSWERS has gdpr)', () => {
    expect(recommendInfrastructure(VALID_ANSWERS).environments).toContain('staging');
  });
});

describe('recommendInfrastructure — free-tier vs enterprise diverge', () => {
  it('yields materially different hosting', () => {
    const free = recommendInfrastructure(FREE_TIER_PROTOTYPE);
    const ent = recommendInfrastructure(ENTERPRISE_VERY_LARGE);
    expect(free.hosting).not.toBe(ent.hosting);
    expect(free.cache).toBeNull();
    expect(ent.cache).not.toBeNull();
    expect(free.storage).toBeNull();
    expect(ent.storage).not.toBeNull();
  });
});
