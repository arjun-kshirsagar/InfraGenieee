/**
 * Unit tests for the pure `toMarkdown` serialiser.
 *
 * Two fixtures:
 *   1. A complete, schema-valid document — every section must appear, and
 *      every id (US-*, FR-*, NFR-*, task ids) present.
 *   2. A hand-built minimal document with all OPTIONAL arrays empty — asserts
 *      the serialiser never emits a dangling header for an empty section.
 */

import { describe, expect, it } from 'vitest';
import { toMarkdown } from './markdown';
import { prdDocumentSchema, type PrdDocument } from '@/types/prd';
import { makePrdDocument, VALID_BRIEF } from './fixtures.test-support';

const realDoc = makePrdDocument({ id: 'prd_testfixture1' });

describe('toMarkdown — purity & determinism', () => {
  it('returns the identical string for the same document (pure)', () => {
    expect(toMarkdown(realDoc)).toBe(toMarkdown(realDoc));
  });

  it('does not mutate the input document', () => {
    const snapshot = JSON.stringify(realDoc);
    toMarkdown(realDoc);
    expect(JSON.stringify(realDoc)).toBe(snapshot);
  });
});

describe('toMarkdown — every section appears', () => {
  const md = toMarkdown(realDoc);

  it('includes the document title and metadata', () => {
    expect(md).toContain(`# ${realDoc.title}`);
    expect(md).toContain(realDoc.id);
    expect(md).toContain(realDoc.createdAt);
    expect(md).toContain(realDoc.generatorVersion);
  });

  it('includes all top-level section headers', () => {
    expect(md).toContain('## Product Requirements');
    expect(md).toContain('## Architecture');
    expect(md).toContain('## Delivery plan');
    expect(md).toContain('## The brief');
  });

  it('includes PRD sub-sections', () => {
    for (const h of [
      '### Overview',
      '### Goals',
      '### Non-goals',
      '### User stories',
      '### Functional requirements',
      '### Non-functional requirements',
      '### Success metrics',
      '### Risks',
      '### Open questions',
    ]) {
      expect(md).toContain(h);
    }
  });

  it('includes architecture sub-sections', () => {
    for (const h of [
      '### Summary',
      '### Components',
      '### Data model',
      '### API endpoints',
      '### Infrastructure',
      '#### Why this infrastructure',
      '### Architecture diagram',
    ]) {
      expect(md).toContain(h);
    }
  });

  it('embeds the mermaid diagram in a fenced block', () => {
    expect(md).toContain('```mermaid');
    expect(md).toContain(realDoc.architecture.diagramMermaid);
  });

  it('includes plan totals and critical path', () => {
    expect(md).toContain(`${realDoc.plan.totalEstimateHours} h`);
    expect(md).toContain(`${realDoc.plan.estimatedCalendarWeeks} weeks`);
    expect(md).toContain('### Critical path');
  });

  it('renders every user story, FR, and NFR id', () => {
    for (const s of realDoc.prd.userStories) expect(md).toContain(s.id);
    for (const r of realDoc.prd.functionalRequirements) expect(md).toContain(r.id);
    for (const n of realDoc.prd.nonFunctionalRequirements) expect(md).toContain(n.id);
  });

  it('renders dependsOn / criticalPath as task titles, not raw ids', () => {
    const titleById = new Map<string, string>();
    for (const m of realDoc.plan.milestones) for (const t of m.tasks) titleById.set(t.id, t.title);
    // The first critical-path task's title must appear under "Critical path".
    const firstCp = realDoc.plan.criticalPath[0];
    expect(md).toContain(titleById.get(firstCp)!);
  });

  it('echoes the brief that produced the document', () => {
    for (const h of ['### Idea', '### Context', '### Clarifications', '### Additional notes']) {
      expect(md).toContain(h);
    }
    expect(md).toContain(VALID_BRIEF.idea);
    expect(md).toContain(VALID_BRIEF.additionalNotes!);
  });

  it('renders the AI assumptions section', () => {
    expect(md).toContain('### Assumptions');
    for (const a of realDoc.prd.assumptions) expect(md).toContain(a);
  });

  it('omits clarifications the user skipped', () => {
    const skipped = VALID_BRIEF.clarifications.find((c) => c.answer.trim() === '');
    expect(skipped).toBeDefined();
    expect(md).not.toContain(skipped!.question);
  });
});

describe('toMarkdown — empty optional arrays produce no dangling headers', () => {
  // A deliberately EMPTIED document. It does NOT satisfy prdDocumentSchema —
  // the min-volume floors reject it, which is the point: the API can never
  // return this. We construct it anyway to prove the serialiser degrades
  // gracefully rather than emitting headers with nothing under them.
  const minimal: PrdDocument = {
    ...realDoc,
    prd: {
      overview: {
        problem: 'p',
        solution: 's',
        targetUsers: 't',
        valueProposition: [],
      },
      goals: [],
      nonGoals: [],
      userStories: [],
      functionalRequirements: [],
      nonFunctionalRequirements: [],
      successMetrics: [],
      risks: [],
      openQuestions: [],
      assumptions: [],
    },
    architecture: {
      summary: 'sum',
      pattern: 'pat',
      components: [],
      dataModel: { entities: [], relationships: [] },
      apiEndpoints: [],
      infrastructure: {
        hosting: 'h',
        database: 'd',
        cache: null,
        storage: null,
        cicd: 'ci',
        environments: [],
        rationale: [],
      },
      diagramMermaid: 'flowchart TD\n A --> B',
    },
    plan: {
      milestones: [],
      criticalPath: [],
      totalEstimateHours: 0,
      estimatedCalendarWeeks: 0,
    },
  };

  const md = toMarkdown(minimal);

  it('is rejected by the schema — floors make an empty document unreturnable', () => {
    expect(prdDocumentSchema.safeParse(minimal).success).toBe(false);
  });

  it('omits headers whose content is empty', () => {
    for (const h of [
      '### Goals',
      '### Non-goals',
      '### User stories',
      '### Functional requirements',
      '### Non-functional requirements',
      '### Success metrics',
      '### Risks',
      '### Open questions',
      '### Assumptions',
      '### Components',
      '### API endpoints',
      '### Critical path',
      '**Value proposition**',
    ]) {
      expect(md).not.toContain(h);
    }
  });

  it('still renders required scalar content (summary, infra, mermaid)', () => {
    expect(md).toContain('### Summary');
    expect(md).toContain('### Infrastructure');
    expect(md).toContain('```mermaid');
  });

  it('never emits a header immediately followed by another header (no dangling)', () => {
    const lines = md.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (/^#{2,4} /.test(lines[i].trim())) {
        // find next non-empty line
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j += 1;
        const next = j < lines.length ? lines[j].trim() : '';
        // A header may legitimately be followed by a sub-header (## then ###),
        // but never by a same-or-higher-level header with nothing between.
        const level = (lines[i].match(/^#+/) ?? [''])[0].length;
        const nextLevel = (next.match(/^#+/) ?? [''])[0].length;
        if (nextLevel > 0 && nextLevel <= level) {
          throw new Error(`Dangling header at line ${i + 1}: "${lines[i]}" followed by "${next}"`);
        }
      }
    }
  });
});
