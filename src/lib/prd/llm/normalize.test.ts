/**
 * Tests for the deterministic relationship-kind normalizer
 * (`src/lib/prd/llm/normalize.ts`).
 *
 * OFFLINE and FREE — pure functions, no client, no network. These directly
 * cover the class of bug that killed ~half of live architecture generations
 * (task t_ad18b485): the model emitting "belongs-to"/"has-many"/"1:N" instead
 * of the strict one-to-one|one-to-many|many-to-many enum.
 */

import { describe, expect, it } from 'vitest';

import {
  normalizeRelationshipKind,
  repairArchitectureRelationshipKinds,
  RELATIONSHIP_KINDS,
} from '@/lib/prd/llm/normalize';
import { relationshipSchema, architectureDraftSchema } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* normalizeRelationshipKind                                                  */
/* -------------------------------------------------------------------------- */

describe('normalizeRelationshipKind', () => {
  it('passes canonical enum values straight through', () => {
    for (const k of RELATIONSHIP_KINDS) {
      expect(normalizeRelationshipKind(k)).toBe(k);
    }
  });

  it('maps one-to-one synonyms', () => {
    for (const s of ['has-one', 'hasOne', 'One To One', 'one_to_one', '1-1', '1:1', 'o2o']) {
      expect(normalizeRelationshipKind(s)).toBe('one-to-one');
    }
  });

  it('maps one-to-many synonyms (incl. directional belongs-to / FK / many-to-one)', () => {
    for (const s of [
      'has-many',
      'hasMany',
      'one to many',
      'one_to_many',
      '1:N',
      '1-n',
      'o2m',
      'belongs-to',
      'belongsTo',
      'references',
      'reference',
      'refers-to',
      'foreign-key',
      'fk',
      'many-to-one',
      'manyToOne',
      'N:1',
      'm2o',
    ]) {
      expect(normalizeRelationshipKind(s)).toBe('one-to-many');
    }
  });

  it('maps many-to-many synonyms', () => {
    for (const s of ['many-to-many', 'manyToMany', 'many to many', 'm:n', 'm-n', 'n:m', 'm2m', 'n-n']) {
      expect(normalizeRelationshipKind(s)).toBe('many-to-many');
    }
  });

  it('returns null for genuinely unmappable / non-string values (never guesses)', () => {
    for (const bad of ['associated-with', 'related', '', 'xyz', null, undefined, 42, {}]) {
      expect(normalizeRelationshipKind(bad)).toBeNull();
    }
  });

  it('every mapped value is a valid zod enum member', () => {
    const mapped = normalizeRelationshipKind('has-many');
    const r = relationshipSchema.safeParse({ from: 'A', to: 'B', kind: mapped });
    expect(r.success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* repairArchitectureRelationshipKinds                                        */
/* -------------------------------------------------------------------------- */

function baseArchitecture(kinds: string[]) {
  return {
    summary: 'x',
    pattern: 'y',
    components: [
      { name: 'Web', kind: 'client', responsibility: 'r', technology: 't' },
      { name: 'API', kind: 'service', responsibility: 'r', technology: 't' },
      { name: 'DB', kind: 'datastore', responsibility: 'r', technology: 't' },
    ],
    dataModel: {
      entities: [
        { name: 'Gym', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Class', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Member', fields: [{ name: 'id', type: 'string', required: true }] },
      ],
      relationships: kinds.map((k, i) => ({
        from: 'Gym',
        to: i % 2 === 0 ? 'Class' : 'Member',
        kind: k,
      })),
    },
    apiEndpoints: [
      { method: 'GET', path: '/a', purpose: 'p', authRequired: false },
      { method: 'POST', path: '/b', purpose: 'p', authRequired: true },
      { method: 'GET', path: '/c', purpose: 'p', authRequired: false },
      { method: 'PATCH', path: '/d', purpose: 'p', authRequired: true },
      { method: 'DELETE', path: '/e', purpose: 'p', authRequired: true },
    ],
    infrastructure: {
      hosting: 'Vercel',
      database: 'Neon',
      cache: null,
      storage: null,
      cicd: 'GH Actions',
      environments: ['prod'],
      rationale: ['hobby budget'],
    },
  };
}

describe('repairArchitectureRelationshipKinds', () => {
  it('rewrites the exact live-failure synonyms so the draft then validates', () => {
    // These are the natural phrasings observed killing real generations.
    const raw = baseArchitecture(['belongs-to', 'has-many', 'references', '1:N', 'has-one', 'm2m']);

    // Before repair, the draft FAILS validation (that's the bug).
    expect(architectureDraftSchema.safeParse(raw).success).toBe(false);

    const repaired = repairArchitectureRelationshipKinds(raw) as typeof raw;

    // After repair every kind is a canonical enum value...
    const kinds = repaired.dataModel.relationships.map((r) => r.kind);
    expect(kinds).toEqual([
      'one-to-many', // belongs-to
      'one-to-many', // has-many
      'one-to-many', // references
      'one-to-many', // 1:N
      'one-to-one', //  has-one
      'many-to-many', // m2m
    ]);
    // ...and the whole draft now parses.
    expect(architectureDraftSchema.safeParse(repaired).success).toBe(true);
  });

  it('does not mutate the input (raw model output stays intact for logging)', () => {
    const raw = baseArchitecture(['has-many']);
    repairArchitectureRelationshipKinds(raw);
    expect(raw.dataModel.relationships[0].kind).toBe('has-many');
  });

  it('leaves already-valid kinds untouched and returns the same reference', () => {
    const raw = baseArchitecture(['one-to-many']);
    const out = repairArchitectureRelationshipKinds(raw);
    // No change → identity return (cheap no-op).
    expect(out).toBe(raw);
  });

  it('leaves an unmappable kind in place so zod rejects and runStage re-asks', () => {
    const raw = baseArchitecture(['associated-with']);
    const out = repairArchitectureRelationshipKinds(raw) as typeof raw;
    expect(out.dataModel.relationships[0].kind).toBe('associated-with');
    expect(architectureDraftSchema.safeParse(out).success).toBe(false);
  });

  it('is defensive against malformed shapes (missing dataModel / relationships)', () => {
    expect(repairArchitectureRelationshipKinds(null)).toBeNull();
    expect(repairArchitectureRelationshipKinds({})).toEqual({});
    expect(repairArchitectureRelationshipKinds({ dataModel: {} })).toEqual({ dataModel: {} });
    const noRel = { dataModel: { relationships: 'nope' } };
    expect(repairArchitectureRelationshipKinds(noRel)).toBe(noRel);
  });
});
