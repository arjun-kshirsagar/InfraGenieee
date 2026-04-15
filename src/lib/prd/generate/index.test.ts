/**
 * Contract test for `generatePrdDocument` — the top-level composition.
 *
 * Asserts the four guarantees from docs/api-contracts.md:
 *   1. determinism (same answers + same id + same createdAt → toEqual)
 *   2. verbatim echo of `answers`
 *   3. self-validation against `prdDocumentSchema`
 *   4. minimum useful volume (≥5 stories, ≥8 FRs, ≥5 NFRs, ≥3 milestones,
 *      ≥12 plan tasks, ≥1 component per entity)
 * plus dependsOn integrity (guarantee #5) and the injected-param plumbing.
 */

import { describe, expect, it } from 'vitest';
import { generatePrdDocument } from './index';
import { prdDocumentSchema, GENERATOR_VERSION } from '@/types/prd';
import { VALID_ANSWERS } from '@/types/prd.test';
import { ENTERPRISE_VERY_LARGE, FREE_TIER_PROTOTYPE } from './fixtures.test-support';

const FIXTURES: Array<[string, typeof VALID_ANSWERS]> = [
  ['VALID_ANSWERS', VALID_ANSWERS],
  ['FREE_TIER_PROTOTYPE', FREE_TIER_PROTOTYPE],
  ['ENTERPRISE_VERY_LARGE', ENTERPRISE_VERY_LARGE],
];

const ID = 'prd_000000000000';
const CREATED = '2026-01-01T00:00:00.000Z';

describe('generatePrdDocument — plumbing', () => {
  it('uses the injected id, createdAt and GENERATOR_VERSION', () => {
    const doc = generatePrdDocument(VALID_ANSWERS, ID, CREATED);
    expect(doc.id).toBe(ID);
    expect(doc.createdAt).toBe(CREATED);
    expect(doc.generatorVersion).toBe(GENERATOR_VERSION);
  });

  it('derives the title from basics.projectName', () => {
    const doc = generatePrdDocument(VALID_ANSWERS, ID, CREATED);
    expect(doc.title).toContain(VALID_ANSWERS.basics.projectName);
  });
});

describe('generatePrdDocument — guarantee #1: determinism', () => {
  for (const [name, answers] of FIXTURES) {
    it(`same answers + id + createdAt → toEqual (${name})`, () => {
      const a = generatePrdDocument(answers, ID, CREATED);
      const b = generatePrdDocument(answers, ID, CREATED);
      expect(a).toEqual(b);
    });
  }

  it('only id and createdAt vary when those inputs vary', () => {
    const a = generatePrdDocument(VALID_ANSWERS, 'prd_aaaaaaaaaaaa', CREATED);
    const b = generatePrdDocument(VALID_ANSWERS, 'prd_bbbbbbbbbbbb', '2027-06-06T06:06:06.000Z');
    // Strip the two injected fields; everything else must be identical.
    const stripA = { ...a, id: '', createdAt: '' };
    const stripB = { ...b, id: '', createdAt: '' };
    expect(stripA).toEqual(stripB);
  });
});

describe('generatePrdDocument — guarantee #2: verbatim echo', () => {
  for (const [name, answers] of FIXTURES) {
    it(`echoes answers unchanged (${name})`, () => {
      const doc = generatePrdDocument(answers, ID, CREATED);
      expect(doc.answers).toEqual(answers);
    });
  }

  it('does not mutate the caller-supplied answers object', () => {
    const clone = structuredClone(VALID_ANSWERS);
    generatePrdDocument(VALID_ANSWERS, ID, CREATED);
    expect(VALID_ANSWERS).toEqual(clone);
  });
});

describe('generatePrdDocument — guarantee #3: self-validation', () => {
  for (const [name, answers] of FIXTURES) {
    it(`output parses against prdDocumentSchema (${name})`, () => {
      const doc = generatePrdDocument(answers, ID, CREATED);
      expect(prdDocumentSchema.safeParse(doc).success).toBe(true);
    });
  }
});

describe('generatePrdDocument — guarantee #4: minimum volume', () => {
  for (const [name, answers] of FIXTURES) {
    it(`meets every volume floor (${name})`, () => {
      const doc = generatePrdDocument(answers, ID, CREATED);
      expect(doc.prd.userStories.length).toBeGreaterThanOrEqual(5);
      expect(doc.prd.functionalRequirements.length).toBeGreaterThanOrEqual(8);
      expect(doc.prd.nonFunctionalRequirements.length).toBeGreaterThanOrEqual(5);
      expect(doc.plan.milestones.length).toBeGreaterThanOrEqual(3);

      const taskCount = doc.plan.milestones.reduce((n, m) => n + m.tasks.length, 0);
      expect(taskCount).toBeGreaterThanOrEqual(12);

      // ≥ 1 component per entity in the answers.
      expect(doc.architecture.components.length).toBeGreaterThanOrEqual(
        answers.dataModel.entities.length,
      );
    });
  }
});

describe('generatePrdDocument — guarantee #5: dependsOn integrity', () => {
  for (const [name, answers] of FIXTURES) {
    it(`every dependsOn id exists and criticalPath ids resolve (${name})`, () => {
      const doc = generatePrdDocument(answers, ID, CREATED);
      const allTaskIds = new Set(
        doc.plan.milestones.flatMap((m) => m.tasks.map((t) => t.id)),
      );
      for (const m of doc.plan.milestones) {
        for (const t of m.tasks) {
          for (const dep of t.dependsOn) {
            expect(allTaskIds.has(dep)).toBe(true);
          }
        }
      }
      for (const id of doc.plan.criticalPath) {
        expect(allTaskIds.has(id)).toBe(true);
      }
    });
  }
});
