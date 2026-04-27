/**
 * Contract tests for `src/types/prd.ts`.
 *
 * These lock down the integrity rules that the previous iteration of this
 * feature only stated in prose — and therefore shipped broken. Specifically:
 * min-volume floors, entity-name uniqueness, and dependency-graph sanity are
 * asserted here as PARSE failures, not as documentation.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_PLAN_TASKS,
  MIN_USER_STORIES,
  clarifyResponseSchema,
  generateRequestSchema,
  prdDocumentSchema,
  projectBriefDraftSchema,
  projectBriefSchema,
} from '@/types/prd';
import { makePrdDocument, VALID_BRIEF } from '@/lib/prd/fixtures.test-support';

describe('projectBriefSchema', () => {
  it('accepts a realistic brief', () => {
    expect(projectBriefSchema.safeParse(VALID_BRIEF).success).toBe(true);
  });

  it('rejects an idea too short to reason from', () => {
    const result = projectBriefSchema.safeParse({ ...VALID_BRIEF, idea: 'an app' });
    expect(result.success).toBe(false);
  });

  it('defaults clarifications to an empty array — the AI may ask nothing', () => {
    const { clarifications: _omitted, ...withoutClarifications } = VALID_BRIEF;
    const result = projectBriefSchema.safeParse(withoutClarifications);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.clarifications).toEqual([]);
  });

  it('accepts a skipped clarifier (empty answer)', () => {
    const result = projectBriefSchema.safeParse({
      ...VALID_BRIEF,
      clarifications: [{ question: 'Anything?', answer: '' }],
    });
    expect(result.success).toBe(true);
  });

  it('caps clarifications at 5 so the step cannot become a questionnaire', () => {
    const result = projectBriefSchema.safeParse({
      ...VALID_BRIEF,
      clarifications: Array.from({ length: 6 }, (_, i) => ({ question: `q${i}`, answer: 'a' })),
    });
    expect(result.success).toBe(false);
  });

  it('does NOT require the user to supply entities or auth details', () => {
    const minimal = {
      idea: VALID_BRIEF.idea,
      context: {
        userScale: 'small',
        trafficPattern: 'unknown',
        budgetBand: 'free-tier',
        timelineWeeks: 4,
      },
    };
    expect(projectBriefSchema.safeParse(minimal).success).toBe(true);
  });
});

describe('projectBriefDraftSchema', () => {
  it('accepts a half-typed draft for autosave', () => {
    expect(projectBriefDraftSchema.safeParse({ idea: 'half a th' }).success).toBe(true);
    expect(projectBriefDraftSchema.safeParse({}).success).toBe(true);
    expect(
      projectBriefDraftSchema.safeParse({ context: { userScale: 'medium' } }).success,
    ).toBe(true);
  });

  it('still rejects foreign/corrupt values', () => {
    expect(
      projectBriefDraftSchema.safeParse({ context: { userScale: 'gigantic' } }).success,
    ).toBe(false);
  });
});

describe('prdDocumentSchema — the fixture is genuinely valid', () => {
  it('parses a complete document', () => {
    const result = prdDocumentSchema.safeParse(makePrdDocument());
    if (!result.success) console.error(result.error.issues);
    expect(result.success).toBe(true);
  });

  it('round-trips through the generate response envelope', () => {
    expect(generateRequestSchema.safeParse({ brief: VALID_BRIEF }).success).toBe(true);
  });
});

describe('min-volume floors are enforced by the schema, not by prose', () => {
  it(`rejects a plan with fewer than ${MIN_PLAN_TASKS} tasks`, () => {
    const doc = makePrdDocument();
    // Keep 3 milestones but strip them down to one task each = 3 tasks.
    doc.plan.milestones = doc.plan.milestones.map((m) => ({
      ...m,
      tasks: [{ ...m.tasks[0], dependsOn: [] }],
    }));
    doc.plan.criticalPath = [doc.plan.milestones[0].tasks[0].id];

    const result = prdDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('at least'))).toBe(true);
    }
  });

  it(`rejects fewer than ${MIN_USER_STORIES} user stories`, () => {
    const doc = makePrdDocument();
    doc.prd.userStories = doc.prd.userStories.slice(0, 2);
    expect(prdDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects fewer than 3 entities', () => {
    const doc = makePrdDocument();
    doc.architecture.dataModel = { entities: [], relationships: [] };
    expect(prdDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects an entity with no fields', () => {
    const doc = makePrdDocument();
    doc.architecture.dataModel.entities[0].fields = [];
    expect(prdDocumentSchema.safeParse(doc).success).toBe(false);
  });
});

describe('data model integrity — the old duplicate-entity bug cannot recur', () => {
  it('rejects duplicate entity names', () => {
    const doc = makePrdDocument();
    doc.architecture.dataModel.entities[1].name = doc.architecture.dataModel.entities[0].name;
    doc.architecture.dataModel.relationships = [];
    const result = prdDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('Duplicate entity name'))).toBe(
        true,
      );
    }
  });

  it('rejects case-insensitive duplicates', () => {
    const doc = makePrdDocument();
    doc.architecture.dataModel.entities[1].name =
      doc.architecture.dataModel.entities[0].name.toUpperCase();
    doc.architecture.dataModel.relationships = [];
    expect(prdDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects whitespace-padded duplicates', () => {
    const doc = makePrdDocument();
    doc.architecture.dataModel.entities[1].name = `  ${doc.architecture.dataModel.entities[0].name}  `;
    doc.architecture.dataModel.relationships = [];
    expect(prdDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects duplicate field names within one entity', () => {
    const doc = makePrdDocument();
    doc.architecture.dataModel.entities[0].fields = [
      { name: 'id', type: 'string', required: true },
      { name: 'ID', type: 'number', required: false },
    ];
    expect(prdDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects a relationship pointing at an undeclared entity', () => {
    const doc = makePrdDocument();
    doc.architecture.dataModel.relationships = [
      { from: 'Ghost', to: doc.architecture.dataModel.entities[0].name, kind: 'one-to-many' },
    ];
    expect(prdDocumentSchema.safeParse(doc).success).toBe(false);
  });
});

describe('plan graph integrity', () => {
  it('rejects a dangling dependsOn id', () => {
    const doc = makePrdDocument();
    doc.plan.milestones[0].tasks[0].dependsOn = ['T-nope'];
    const result = prdDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('unknown task'))).toBe(true);
    }
  });

  it('rejects a self-dependency', () => {
    const doc = makePrdDocument();
    const first = doc.plan.milestones[0].tasks[0];
    first.dependsOn = [first.id];
    expect(prdDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects duplicate task ids', () => {
    const doc = makePrdDocument();
    doc.plan.milestones[1].tasks[0].id = doc.plan.milestones[0].tasks[0].id;
    doc.plan.milestones[1].tasks[0].dependsOn = [];
    expect(prdDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects a criticalPath referencing an unknown task', () => {
    const doc = makePrdDocument();
    doc.plan.criticalPath = ['T-nope'];
    expect(prdDocumentSchema.safeParse(doc).success).toBe(false);
  });
});

describe('clarifyResponseSchema', () => {
  it('accepts zero questions — a valid, common answer', () => {
    expect(clarifyResponseSchema.safeParse({ questions: [] }).success).toBe(true);
  });

  it('caps at 3 questions', () => {
    const q = { id: 'q', question: 'why?', why: 'because', suggestions: [] };
    expect(clarifyResponseSchema.safeParse({ questions: Array(4).fill(q) }).success).toBe(false);
  });
});
