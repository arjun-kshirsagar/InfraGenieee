/**
 * Tests for the pure derivation layer (`src/lib/prd/derive`).
 *
 * This module is pure (no clock, no randomness, no I/O), so it's cheap to cover
 * exhaustively and there's no mocking. It previously had zero tests.
 */

import { describe, expect, it } from 'vitest';

import {
  buildArchitectureMermaid,
  criticalPath,
  estimateCalendarWeeks,
  mermaidNodeId,
  repairDependencyGraph,
  topoSort,
  totalEstimateHours,
} from '@/lib/prd/derive';
import type { ArchitectureComponent, Milestone, PlanTask } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

function task(id: string, dependsOn: string[] = [], estimateHours = 4): PlanTask {
  return {
    id,
    title: id,
    description: 'd',
    area: 'backend',
    estimateHours,
    dependsOn,
    acceptanceCriteria: ['ok'],
  };
}

function oneMilestone(tasks: PlanTask[]): Milestone[] {
  return [{ id: 'M1', name: 'm', goal: 'g', tasks }];
}

/* -------------------------------------------------------------------------- */
/* topoSort                                                                   */
/* -------------------------------------------------------------------------- */

describe('topoSort', () => {
  it('orders dependents after their dependencies, stable by declaration order', () => {
    const tasks = [task('A'), task('B', ['A']), task('C', ['B']), task('D', ['A'])];
    const order = topoSort(tasks);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('C'));
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('D'));
    expect(order).toHaveLength(4);
  });

  it('throws on a cycle', () => {
    const tasks = [task('A', ['B']), task('B', ['A'])];
    expect(() => topoSort(tasks)).toThrow(/cycle/i);
  });

  it('throws on a self-dependency', () => {
    expect(() => topoSort([task('A', ['A'])])).toThrow(/itself/i);
  });

  it('throws on an unknown dependency', () => {
    expect(() => topoSort([task('A', ['GHOST'])])).toThrow(/unknown/i);
  });
});

/* -------------------------------------------------------------------------- */
/* criticalPath                                                               */
/* -------------------------------------------------------------------------- */

describe('criticalPath', () => {
  it('picks the longest chain by summed hours, not by count', () => {
    // Two chains from A: A→B→D (4+10+4=18) vs A→C→D via C (4+2). D depends on
    // both B and C, so the chain through B (the heavier one) wins.
    const tasks = [
      task('A', [], 4),
      task('B', ['A'], 10),
      task('C', ['A'], 2),
      task('D', ['B', 'C'], 4),
    ];
    const path = criticalPath(tasks);
    expect(path).toEqual(['A', 'B', 'D']);
  });

  it('returns [] for no tasks', () => {
    expect(criticalPath([])).toEqual([]);
  });

  it('returns a genuine chain where each step depends on the previous', () => {
    const tasks = [task('A'), task('B', ['A']), task('C', ['B'])];
    const path = criticalPath(tasks);
    expect(path).toEqual(['A', 'B', 'C']);
  });
});

/* -------------------------------------------------------------------------- */
/* totalEstimateHours                                                         */
/* -------------------------------------------------------------------------- */

describe('totalEstimateHours', () => {
  it('sums all task estimates and rounds to one decimal', () => {
    expect(totalEstimateHours([task('A', [], 4.25), task('B', [], 3.1)])).toBe(7.4);
  });
});

/* -------------------------------------------------------------------------- */
/* estimateCalendarWeeks — critical-path floor                                 */
/* -------------------------------------------------------------------------- */

describe('estimateCalendarWeeks', () => {
  it('is floored by the critical path even with a huge team', () => {
    // A 6-task chain of 30h each = 180h critical path = 6 person-weeks. No team
    // size can beat the chain: even 40 people can't parallelise a dependency
    // chain.
    const chain: PlanTask[] = [];
    for (let i = 0; i < 6; i++) chain.push(task(`T${i}`, i === 0 ? [] : [`T${i - 1}`], 30));
    const weeks = estimateCalendarWeeks(chain, 40);
    expect(weeks).toBeGreaterThanOrEqual(6);
  });

  it('uses throughput when the work is fully parallelisable', () => {
    // 12 independent 30h tasks = 360h. With a team of 3 (90h/week) → 4 weeks.
    const parallel = Array.from({ length: 12 }, (_, i) => task(`P${i}`, [], 30));
    const weeks = estimateCalendarWeeks(parallel, 3);
    expect(weeks).toBe(4);
  });

  it('never returns less than 1 week', () => {
    expect(estimateCalendarWeeks([task('A', [], 0.5)], 3)).toBe(1);
    expect(estimateCalendarWeeks([], 3)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* repairDependencyGraph                                                       */
/* -------------------------------------------------------------------------- */

describe('repairDependencyGraph', () => {
  it('keeps a valid graph untouched', () => {
    const ms = oneMilestone([task('A'), task('B', ['A'])]);
    const { milestones, removedEdges } = repairDependencyGraph(ms);
    expect(removedEdges).toEqual([]);
    expect(milestones[0].tasks[1].dependsOn).toEqual(['A']);
  });

  it('drops a self-edge, keeping the task', () => {
    const { milestones, removedEdges } = repairDependencyGraph(oneMilestone([task('A', ['A'])]));
    expect(removedEdges).toContainEqual({ from: 'A', to: 'A', reason: 'self' });
    expect(milestones[0].tasks[0].dependsOn).toEqual([]);
  });

  it('drops an unknown-target edge, keeping the task', () => {
    const { milestones, removedEdges } = repairDependencyGraph(
      oneMilestone([task('A', ['GHOST']), task('B')]),
    );
    expect(removedEdges).toContainEqual({ from: 'A', to: 'GHOST', reason: 'unknown' });
    expect(milestones[0].tasks[0].dependsOn).toEqual([]);
  });

  it('drops the cycle-closing edge but keeps the rest of the chain', () => {
    // A→B→C→A is a cycle; repair must drop exactly one edge to break it and
    // leave a topo-sortable graph.
    const ms = oneMilestone([task('A', ['C']), task('B', ['A']), task('C', ['B'])]);
    const { milestones, removedEdges } = repairDependencyGraph(ms);
    expect(removedEdges.some((e) => e.reason === 'cycle')).toBe(true);
    // The repaired graph must now be a DAG (topoSort succeeds).
    const tasks = milestones.flatMap((m) => m.tasks);
    expect(() => topoSort(tasks)).not.toThrow();
  });

  it('handles a mix of self, unknown, and cycle edges in one pass', () => {
    const ms = oneMilestone([
      task('A', ['A', 'GHOST', 'B']),
      task('B', ['A']),
    ]);
    const { milestones, removedEdges } = repairDependencyGraph(ms);
    // A→A self, A→GHOST unknown, and A→B closes a cycle (B→A already) — all gone.
    expect(removedEdges.map((e) => e.reason).sort()).toEqual(['cycle', 'self', 'unknown']);
    expect(() => topoSort(milestones.flatMap((m) => m.tasks))).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* buildArchitectureMermaid                                                     */
/* -------------------------------------------------------------------------- */

function comp(name: string, kind: ArchitectureComponent['kind']): ArchitectureComponent {
  return { name, kind, responsibility: 'r', technology: 't' };
}

describe('buildArchitectureMermaid', () => {
  it('emits a flowchart with a node per component and connects all of them', () => {
    const components = [
      comp('CDN', 'cdn'),
      comp('Web App', 'client'),
      comp('API', 'service'),
      comp('Postgres', 'datastore'),
      comp('Redis', 'cache'),
      comp('Stripe', 'external'),
    ];
    const mermaid = buildArchitectureMermaid('Test Product', components);
    expect(mermaid).toContain('flowchart TD');

    // Every component id appears as a node declaration.
    for (const c of components) {
      const id = mermaidNodeId(c.name);
      expect(mermaid).toContain(`${id}[`);
    }

    // No component is left unconnected: each node id appears in at least one
    // edge line (a line containing '-->').
    const edgeLines = mermaid.split('\n').filter((l) => l.includes('-->'));
    for (const c of components) {
      const id = mermaidNodeId(c.name);
      const connected = edgeLines.some((l) => l.includes(id));
      expect(connected, `${c.name} (${id}) should be connected`).toBe(true);
    }
  });

  it('produces syntactically safe node ids from messy names', () => {
    expect(mermaidNodeId('My "Cool" Service!')).toMatch(/^[A-Za-z0-9_]+$/);
    expect(mermaidNodeId('***')).toBe('node');
  });

  it('handles the empty-components case without throwing', () => {
    const mermaid = buildArchitectureMermaid('Empty', []);
    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('No components');
  });

  /* --- MINOR-3 regression: arrow DIRECTION for multi-UI products ---------- */

  /** Parse `A -->|label| B` / `A --> B` edge lines into [from, to] pairs. */
  function edges(mermaid: string): Array<[string, string]> {
    return mermaid
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('-->'))
      .map((l) => {
        const m = /^([A-Za-z0-9_]+)\s*-->(?:\|[^|]*\|)?\s*([A-Za-z0-9_]+)$/.exec(l);
        expect(m, `unparseable edge line: ${l}`).not.toBeNull();
        return [m![1], m![2]] as [string, string];
      });
  }

  it('points EVERY client at the service, never away from it', () => {
    // The real shape that exposed the bug: three UI surfaces on one API.
    const components = [
      comp('Clinician Web App', 'client'),
      comp('Patient Portal', 'client'),
      comp('Admin Console', 'client'),
      comp('Core API', 'service'),
      comp('Postgres', 'datastore'),
    ];
    const mermaid = buildArchitectureMermaid('Multi UI', components);
    const e = edges(mermaid);
    const api = mermaidNodeId('Core API');

    for (const name of ['Clinician Web App', 'Patient Portal', 'Admin Console']) {
      const id = mermaidNodeId(name);
      expect(e, `${name} should call the service`).toContainEqual([id, api]);
      expect(
        e.some(([from, to]) => from === api && to === id),
        `${name} must NOT be drawn as an outbound edge from the service`,
      ).toBe(false);
    }
  });

  it('never draws an edge from a service into a client or a cdn', () => {
    // Whole-shape guard: no matter which components exist, callers point inward.
    const components = [
      comp('CDN', 'cdn'),
      comp('Web', 'client'),
      comp('Mobile Web', 'client'),
      comp('API', 'service'),
      comp('Worker', 'service'),
      comp('Pooler', 'service'),
      comp('Postgres', 'datastore'),
      comp('Blob Storage', 'datastore'),
      comp('Redis', 'cache'),
      comp('Queue', 'queue'),
      comp('Stripe', 'external'),
    ];
    const mermaid = buildArchitectureMermaid('Everything', components);
    const byId = new Map(components.map((c) => [mermaidNodeId(c.name), c]));

    for (const [from, to] of edges(mermaid)) {
      const target = byId.get(to)!;
      const source = byId.get(from)!;
      if (target.kind === 'client') {
        expect(source.kind, `${from} -> ${to}: only a cdn may point at a client`).toBe('cdn');
      }
      expect(target.kind, `${from} -> ${to}: nothing may point at a cdn`).not.toBe('cdn');
    }

    // And every component is still connected (no regression on orphan rescue).
    const touched = new Set(edges(mermaid).flat());
    for (const c of components) {
      expect(touched.has(mermaidNodeId(c.name)), `${c.name} should be connected`).toBe(true);
    }
  });

  it('fronts every client with the cdn, not just the first', () => {
    const components = [
      comp('CDN', 'cdn'),
      comp('Web', 'client'),
      comp('Admin', 'client'),
      comp('API', 'service'),
    ];
    const e = edges(buildArchitectureMermaid('CDN fan-out', components));
    expect(e).toContainEqual([mermaidNodeId('CDN'), mermaidNodeId('Web')]);
    expect(e).toContainEqual([mermaidNodeId('CDN'), mermaidNodeId('Admin')]);
  });

  it('sends clients to the datastore when there is no service at all', () => {
    const components = [
      comp('Web', 'client'),
      comp('Admin', 'client'),
      comp('Supabase', 'datastore'),
    ];
    const e = edges(buildArchitectureMermaid('BaaS', components));
    expect(e).toContainEqual([mermaidNodeId('Web'), mermaidNodeId('Supabase')]);
    expect(e).toContainEqual([mermaidNodeId('Admin'), mermaidNodeId('Supabase')]);
  });

  it('is deterministic — same input, byte-identical output', () => {
    const components = [
      comp('CDN', 'cdn'),
      comp('Web', 'client'),
      comp('Admin', 'client'),
      comp('API', 'service'),
      comp('Pooler', 'service'),
      comp('Postgres', 'datastore'),
      comp('Stripe', 'external'),
    ];
    const a = buildArchitectureMermaid('Same', components);
    const b = buildArchitectureMermaid('Same', components);
    expect(a).toBe(b);
  });
});
