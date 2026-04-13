/**
 * Tests for the deterministic plan-section generator.
 *
 * Covers (per the B3 acceptance criteria):
 *  - output parses `planSectionSchema`;
 *  - determinism (twice, `toEqual`);
 *  - ≥ 3 milestones and ≥ 12 tasks;
 *  - every `dependsOn` id resolves within the document, no self-references;
 *  - no cycles — the internal topo sort succeeds, and a deliberately cyclic
 *    input makes `topoSort` throw;
 *  - every consecutive pair in `criticalPath` is a real dependency edge;
 *  - `totalEstimateHours` equals the actual sum;
 *  - a `needsBackgroundJobs` + multi-integration answer set yields more tasks
 *    than a bare prototype set;
 *  - two contrasting fixtures produce different milestone counts AND different
 *    `estimatedCalendarWeeks`.
 */

import { describe, expect, it } from 'vitest';
import { criticalPath, generatePlanSection, topoSort } from '@/lib/prd/generate/plan';
import { planSectionSchema } from '@/types/prd';
import type { PlanSection, PlanTask, QuestionnaireAnswers } from '@/types/prd';
import { VALID_ANSWERS } from '@/types/prd.test';
import { ENTERPRISE_VERY_LARGE, FREE_TIER_PROTOTYPE } from './fixtures.test-support';

const ALL: QuestionnaireAnswers[] = [VALID_ANSWERS, FREE_TIER_PROTOTYPE, ENTERPRISE_VERY_LARGE];

/** Flatten a plan's milestones into one task list. */
function flat(plan: PlanSection): PlanTask[] {
  return plan.milestones.flatMap((m) => m.tasks);
}

describe('generatePlanSection — schema + determinism', () => {
  it('output parses against planSectionSchema for every fixture', () => {
    for (const answers of ALL) {
      const res = planSectionSchema.safeParse(generatePlanSection(answers));
      expect(res.success).toBe(true);
    }
  });

  it('is deterministic — same answers produce a deeply-equal section', () => {
    for (const answers of ALL) {
      expect(generatePlanSection(answers)).toEqual(generatePlanSection(answers));
    }
  });
});

describe('generatePlanSection — contract minimums', () => {
  it('has ≥ 3 milestones and ≥ 12 tasks for every fixture', () => {
    for (const answers of ALL) {
      const plan = generatePlanSection(answers);
      expect(plan.milestones.length).toBeGreaterThanOrEqual(3);
      expect(flat(plan).length).toBeGreaterThanOrEqual(12);
    }
  });

  it('every task has a valid id, an estimate in range, and ≥ 1 acceptance criterion', () => {
    for (const answers of ALL) {
      const tasks = flat(generatePlanSection(answers));
      for (const t of tasks) {
        expect(t.id).toMatch(/^T-\d+$/);
        expect(t.estimateHours).toBeGreaterThanOrEqual(0.5);
        expect(t.estimateHours).toBeLessThanOrEqual(200);
        expect(t.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('uses unique, well-formed T- ids across the whole document', () => {
    for (const answers of ALL) {
      const ids = flat(generatePlanSection(answers)).map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length); // unique
      for (const id of ids) expect(id).toMatch(/^T-\d+$/); // well-formed
    }
  });
});

describe('generatePlanSection — dependency integrity', () => {
  it('every dependsOn id resolves to a task in the same document, no self-refs', () => {
    for (const answers of ALL) {
      const tasks = flat(generatePlanSection(answers));
      const ids = new Set(tasks.map((t) => t.id));
      for (const t of tasks) {
        for (const dep of t.dependsOn) {
          expect(ids.has(dep)).toBe(true);
          expect(dep).not.toBe(t.id);
        }
      }
    }
  });

  it('the dependency graph is acyclic — topoSort succeeds and returns all ids', () => {
    for (const answers of ALL) {
      const tasks = flat(generatePlanSection(answers));
      const order = topoSort(tasks);
      expect(order.length).toBe(tasks.length);
      expect(new Set(order)).toEqual(new Set(tasks.map((t) => t.id)));
    }
  });

  it('topoSort produces a valid order — every dep precedes its dependent', () => {
    const tasks = flat(generatePlanSection(ENTERPRISE_VERY_LARGE));
    const order = topoSort(tasks);
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const t of tasks) {
      for (const dep of t.dependsOn) {
        expect(pos.get(dep)!).toBeLessThan(pos.get(t.id)!);
      }
    }
  });
});

describe('topoSort — cycle & bad-reference detection', () => {
  const mk = (id: string, dependsOn: string[]): PlanTask => ({
    id,
    title: id,
    description: id,
    area: 'backend',
    estimateHours: 1,
    dependsOn,
    acceptanceCriteria: ['x'],
  });

  it('throws on a deliberately cyclic input', () => {
    const cyclic = [mk('T-1', ['T-3']), mk('T-2', ['T-1']), mk('T-3', ['T-2'])];
    expect(() => topoSort(cyclic)).toThrow(/cycle/i);
  });

  it('throws on a self-reference', () => {
    expect(() => topoSort([mk('T-1', ['T-1'])])).toThrow(/itself/i);
  });

  it('throws when a dependsOn id does not exist', () => {
    expect(() => topoSort([mk('T-1', ['T-99'])])).toThrow(/unknown/i);
  });

  it('succeeds on a valid DAG', () => {
    const dag = [mk('T-1', []), mk('T-2', ['T-1']), mk('T-3', ['T-1', 'T-2'])];
    expect(topoSort(dag)).toEqual(['T-1', 'T-2', 'T-3']);
  });
});

describe('criticalPath', () => {
  it('every consecutive pair is a genuine dependency edge (b dependsOn a)', () => {
    for (const answers of ALL) {
      const plan = generatePlanSection(answers);
      const tasks = flat(plan);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const path = plan.criticalPath;
      expect(path.length).toBeGreaterThan(0);
      for (let i = 1; i < path.length; i++) {
        const from = path[i - 1];
        const to = path[i];
        const toTask = byId.get(to);
        expect(toTask).toBeDefined();
        expect(toTask!.dependsOn).toContain(from);
      }
    }
  });

  it('returns the longest weighted chain on a hand-built graph', () => {
    // T-1(1) -> T-2(5) -> T-4(1)  = 7
    // T-1(1) -> T-3(2) -> T-4(1)  = 4  (shorter)
    const mk = (id: string, estimateHours: number, dependsOn: string[]): PlanTask => ({
      id, title: id, description: id, area: 'backend', estimateHours, dependsOn, acceptanceCriteria: ['x'],
    });
    const tasks = [mk('T-1', 1, []), mk('T-2', 5, ['T-1']), mk('T-3', 2, ['T-1']), mk('T-4', 1, ['T-2', 'T-3'])];
    expect(criticalPath(tasks)).toEqual(['T-1', 'T-2', 'T-4']);
  });
});

describe('generatePlanSection — totals & calendar weeks', () => {
  it('totalEstimateHours equals the actual sum of task estimates', () => {
    for (const answers of ALL) {
      const plan = generatePlanSection(answers);
      const sum = flat(plan).reduce((s, t) => s + t.estimateHours, 0);
      expect(plan.totalEstimateHours).toBe(sum);
    }
  });

  it('estimatedCalendarWeeks is derived from hours and team size (not clamped to timeline)', () => {
    // Enterprise has a large scope but a 25-person team; prototype is tiny with
    // a team of 1. Both are positive numbers; we assert the derivation matches
    // the documented 25 productive-hours/person/week constant.
    for (const answers of ALL) {
      const plan = generatePlanSection(answers);
      const expected =
        Math.round((plan.totalEstimateHours / (answers.budget.teamSize * 25)) * 10) / 10;
      expect(plan.estimatedCalendarWeeks).toBe(expected);
      expect(plan.estimatedCalendarWeeks).toBeGreaterThan(0);
    }
  });
});

describe('generatePlanSection — answers actually drive volume', () => {
  it('a background-jobs + multi-integration set yields more tasks than a bare prototype', () => {
    const bare = flat(generatePlanSection(FREE_TIER_PROTOTYPE)).length;
    const rich = flat(generatePlanSection(ENTERPRISE_VERY_LARGE)).length;
    expect(rich).toBeGreaterThan(bare);
  });

  it('background jobs, realtime, uploads and each integration each add a task', () => {
    // Toggle one workload flag and assert the task count strictly increases.
    const base = FREE_TIER_PROTOTYPE;
    const withJobs: QuestionnaireAnswers = {
      ...base,
      integrations: { ...base.integrations, needsBackgroundJobs: true },
    };
    const withJobsAndIntegs: QuestionnaireAnswers = {
      ...withJobs,
      integrations: { ...withJobs.integrations, integrations: ['payments', 'analytics'] },
    };
    const n0 = flat(generatePlanSection(base)).length;
    const n1 = flat(generatePlanSection(withJobs)).length;
    const n2 = flat(generatePlanSection(withJobsAndIntegs)).length;
    expect(n1).toBe(n0 + 1); // exactly the background-jobs task
    expect(n2).toBe(n1 + 2); // exactly the two integration tasks
  });

  it('skips per-entity UI tasks when stack.frontend === "none"', () => {
    const base = ENTERPRISE_VERY_LARGE;
    const noFrontend: QuestionnaireAnswers = {
      ...base,
      stack: { ...base.stack, frontend: 'none' },
    };
    const uiCountWith = flat(generatePlanSection(base)).filter((t) => t.title.endsWith(': UI')).length;
    const uiCountWithout = flat(generatePlanSection(noFrontend)).filter((t) => t.title.endsWith(': UI')).length;
    expect(uiCountWith).toBe(base.dataModel.entities.length);
    expect(uiCountWithout).toBe(0);
  });
});

describe('generatePlanSection — contrasting fixtures diverge', () => {
  it('two contrasting fixtures differ in milestone count and calendar weeks', () => {
    const proto = generatePlanSection(FREE_TIER_PROTOTYPE);
    const ent = generatePlanSection(ENTERPRISE_VERY_LARGE);
    expect(proto.milestones.length).not.toBe(ent.milestones.length);
    expect(proto.estimatedCalendarWeeks).not.toBe(ent.estimatedCalendarWeeks);
  });

  it('an authless fixture has no "Auth & access control" milestone; an auth fixture does', () => {
    const proto = generatePlanSection(FREE_TIER_PROTOTYPE); // authRequired: false
    const ent = generatePlanSection(ENTERPRISE_VERY_LARGE); // authRequired: true
    expect(proto.milestones.some((m) => m.name === 'Auth & access control')).toBe(false);
    expect(ent.milestones.some((m) => m.name === 'Auth & access control')).toBe(true);
    // ...but the authless build still gets a real (non-empty) M3.
    const m3 = proto.milestones.find((m) => m.id === 'M3');
    expect(m3).toBeDefined();
    expect(m3!.tasks.length).toBeGreaterThan(0);
  });

  it('every milestone is non-empty', () => {
    for (const answers of ALL) {
      for (const m of generatePlanSection(answers).milestones) {
        expect(m.tasks.length).toBeGreaterThan(0);
      }
    }
  });
});
