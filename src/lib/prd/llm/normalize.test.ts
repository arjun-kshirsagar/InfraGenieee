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
import { z } from 'zod';

import {
  normalizeRelationshipKind,
  repairArchitectureRelationshipKinds,
  clampString,
  clampStringsToSchema,
  RELATIONSHIP_KINDS,
} from '@/lib/prd/llm/normalize';
import {
  relationshipSchema,
  architectureDraftSchema,
  clarifyResponseSchema,
  entitySchema,
} from '@/types/prd';

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

/* -------------------------------------------------------------------------- */
/* clampString                                                                */
/* -------------------------------------------------------------------------- */

describe('clampString', () => {
  it('returns a compliant string byte-for-byte (no ellipsis, no change)', () => {
    expect(clampString('short', 200)).toBe('short');
    const exact = 'x'.repeat(50);
    expect(clampString(exact, 50)).toBe(exact);
  });

  it('truncates an over-long string to at most `max` characters', () => {
    const long = 'word '.repeat(100).trim(); // ~499 chars
    const out = clampString(long, 200);
    expect([...out].length).toBeLessThanOrEqual(200);
  });

  it('appends an ellipsis when it truncates (and it counts toward the cap)', () => {
    const long = 'a b c d e f g h i j k l m n o p q r s t u v w x y z'.repeat(20);
    const out = clampString(long, 40);
    expect(out.endsWith('…')).toBe(true);
    expect([...out].length).toBeLessThanOrEqual(40);
  });

  it('prefers a word boundary rather than cutting mid-word', () => {
    const out = clampString('alpha beta gamma delta epsilon zeta', 20);
    // Within cap, and the text before the ellipsis ends on a complete word
    // (the source has no trailing partial word left dangling).
    expect([...out].length).toBeLessThanOrEqual(20);
    const body = out.replace(/…$/u, '');
    // Every whitespace-separated token in the body is a whole word from the input.
    const words = new Set('alpha beta gamma delta epsilon zeta'.split(' '));
    for (const token of body.split(' ').filter(Boolean)) {
      expect(words.has(token)).toBe(true);
    }
  });

  it('hard-cuts a single unbroken long token instead of emptying it', () => {
    const out = clampString('x'.repeat(500), 10);
    expect([...out].length).toBe(10);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, 9)).toBe('x'.repeat(9));
  });

  it('counts by code points so multi-unit characters are never split', () => {
    const emoji = '😀'.repeat(50); // each is 2 UTF-16 code units
    const out = clampString(emoji, 10);
    expect([...out].length).toBeLessThanOrEqual(10);
    // No lone surrogate: re-spreading yields only whole emoji (+ ellipsis).
    for (const ch of [...out]) {
      expect(ch === '😀' || ch === '…').toBe(true);
    }
  });

  it('returns empty string for a non-positive cap', () => {
    expect(clampString('anything', 0)).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* clampStringsToSchema — the schema-driven salvage that kills the bug class    */
/* -------------------------------------------------------------------------- */

describe('clampStringsToSchema', () => {
  it('THE REPRO: an entity field note over its 200 cap is clamped so the entity parses', () => {
    // Mirrors the live failure: dataModel.entities[i].fields[j].notes too long.
    const verboseNote =
      'This field stores the appointment reminder configuration including the SMS ' +
      'template, the lead time in hours, the retry policy, the opt-out handling, and ' +
      'the escalation path when a patient does not confirm within the configured window ' +
      'which in practice must be tuned per clinic and per provider preference.';
    expect(verboseNote.length).toBeGreaterThan(200);

    const rawEntity = {
      name: 'Appointment',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'reminderConfig', type: 'json', required: false, notes: verboseNote },
      ],
    };

    // Before clamp the entity is rejected (that's the bug).
    expect(entitySchema.safeParse(rawEntity).success).toBe(false);

    const clamped = clampStringsToSchema(entitySchema, rawEntity) as typeof rawEntity;
    // After clamp it parses, and the note is within cap.
    const parsed = entitySchema.safeParse(clamped);
    expect(parsed.success).toBe(true);
    expect(clamped.fields[1].notes!.length).toBeLessThanOrEqual(200);
  });

  it('clamps an over-long note nested deep inside a full architecture draft', () => {
    const longNote = 'detail '.repeat(80).trim(); // ~500+ chars, over the 200 cap
    const raw = baseArchitecture(['one-to-many']);
    // Overflow a field note and an entity description (both capped).
    raw.dataModel.entities[0].fields[0] = {
      name: 'id',
      type: 'string',
      required: true,
      // @ts-expect-error — deliberately over-cap raw model output
      notes: longNote,
    };
    // @ts-expect-error — description is optional/capped at 300 on the entity
    raw.dataModel.entities[1].description = 'x'.repeat(400);

    expect(architectureDraftSchema.safeParse(raw).success).toBe(false);

    const clamped = clampStringsToSchema(architectureDraftSchema, raw) as typeof raw;
    expect(architectureDraftSchema.safeParse(clamped).success).toBe(true);
  });

  it('clamps clarify `why` (max 200) and `suggestions` items (max 120)', () => {
    const raw = {
      questions: [
        {
          id: 'q1',
          question: 'Do clinics manage their own schedules?',
          why: 'w'.repeat(400),
          suggestions: ['s'.repeat(300), 'ok answer'],
        },
      ],
    };
    expect(clarifyResponseSchema.safeParse(raw).success).toBe(false);

    const clamped = clampStringsToSchema(clarifyResponseSchema, raw) as typeof raw;
    const parsed = clarifyResponseSchema.safeParse(clamped);
    expect(parsed.success).toBe(true);
    expect(clamped.questions[0].why.length).toBeLessThanOrEqual(200);
    expect(clamped.questions[0].suggestions[0].length).toBeLessThanOrEqual(120);
    expect(clamped.questions[0].suggestions[1]).toBe('ok answer'); // compliant → untouched
  });

  it('leaves a fully-compliant payload untouched and returns the same reference', () => {
    const raw = baseArchitecture(['one-to-many']);
    const out = clampStringsToSchema(architectureDraftSchema, raw);
    expect(out).toBe(raw); // no over-cap string → identity, no clone
  });

  it('does NOT mutate the input (raw model output stays intact for logging)', () => {
    const longNote = 'y'.repeat(500);
    const raw = {
      name: 'E',
      fields: [{ name: 'id', type: 'string', required: true, notes: longNote }],
    };
    clampStringsToSchema(entitySchema, raw);
    expect(raw.fields[0].notes).toBe(longNote); // original still 500 chars
  });

  it('handles a nullable capped string by clamping the string branch', () => {
    const schema = z.object({ label: z.string().max(5).nullable() });
    const clamped = clampStringsToSchema(schema, { label: 'abcdefghij' }) as { label: string };
    expect([...clamped.label].length).toBeLessThanOrEqual(5);
    // A null value is passed through, not touched.
    expect(clampStringsToSchema(schema, { label: null })).toEqual({ label: null });
  });

  it('only touches strings that ACTUALLY exceed the cap (structural non-length errors survive)', () => {
    // Missing required field is a structural failure, not a length one — clamp
    // must not paper over it; it should still fail zod so the re-ask path fires.
    const raw = { name: 'E', fields: [] }; // fields.min(1) violated
    const out = clampStringsToSchema(entitySchema, raw);
    expect(entitySchema.safeParse(out).success).toBe(false);
  });

  it('is defensive: non-object / primitive inputs pass straight through', () => {
    expect(clampStringsToSchema(entitySchema, null)).toBeNull();
    expect(clampStringsToSchema(entitySchema, 42)).toBe(42);
    expect(clampStringsToSchema(entitySchema, 'raw')).toBe('raw');
  });
});
