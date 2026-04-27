/**
 * InfraGenie — deterministic derivation over LLM output.
 *
 * The LLM supplies substance (which components exist, which tasks depend on
 * which). This module supplies the mechanical artifacts that models get wrong:
 * Mermaid syntax and dependency-graph maths.
 *
 * Everything here is PURE: same input → same output, no clock, no randomness.
 * Owned by: architect (shared contract). Backend calls it; frontend must not.
 */

import type { ArchitectureComponent, Milestone, PlanTask } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Mermaid                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sanitise an arbitrary name into a Mermaid-safe node id: alphanumeric only,
 * runs of anything else collapsed to `_`. Mermaid node ids cannot contain
 * spaces, quotes, or punctuation, so we strip them here rather than risk a
 * syntax error in the string the frontend renders.
 */
export function mermaidNodeId(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'node';
}

/** Escape a human label for use inside a Mermaid `["…"]` node body. */
export function mermaidLabel(label: string): string {
  // Mermaid breaks on raw quotes/brackets inside a label; replace with safe
  // equivalents. Deterministic and lossy-but-legible.
  return label.replace(/["[\]{}|]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build a `flowchart TD` from the components the model chose.
 *
 * We never ask the model to emit Mermaid: it produces broken syntax often
 * enough that the diagram tab would intermittently fail to render. Instead we
 * derive edges from component KINDS, which the schema constrains to a known
 * enum, so the output is always syntactically valid.
 *
 * Topology: cdn → client → service → {datastore, cache, queue, external},
 * and queue → datastore when both exist.
 */
export function buildArchitectureMermaid(
  projectName: string,
  components: ArchitectureComponent[],
): string {
  const lines: string[] = [];
  lines.push(`%% InfraGenie architecture diagram for ${mermaidLabel(projectName)}`);
  lines.push('flowchart TD');

  if (components.length === 0) {
    lines.push('  empty["No components"]');
    return lines.join('\n');
  }

  // Assign a deterministic, unique node id per component.
  const ids = new Map<ArchitectureComponent, string>();
  const usedIds = new Set<string>();
  for (const c of components) {
    const base = mermaidNodeId(c.name);
    let id = base;
    let i = 2;
    while (usedIds.has(id)) {
      id = `${base}_${i++}`;
    }
    usedIds.add(id);
    ids.set(c, id);
    lines.push(`  ${id}["${mermaidLabel(c.name)}"]`);
  }

  const first = (kind: ArchitectureComponent['kind']) => components.find((c) => c.kind === kind);
  const client = first('client');
  const service = first('service');
  const datastore = first('datastore');
  const cache = first('cache');
  const queue = first('queue');
  const cdn = first('cdn');

  const seenEdges = new Set<string>();
  const edge = (a?: ArchitectureComponent, b?: ArchitectureComponent, label?: string) => {
    if (!a || !b || a === b) return;
    const idA = ids.get(a)!;
    const idB = ids.get(b)!;
    const key = `${idA}->${idB}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    lines.push(label ? `  ${idA} -->|${mermaidLabel(label)}| ${idB}` : `  ${idA} --> ${idB}`);
  };

  if (cdn && client) edge(cdn, client, 'edge cache');
  edge(client, service, 'HTTPS');
  edge(service, datastore, 'read/write');
  edge(service, cache, 'cache');
  edge(service, queue, 'enqueue');
  for (const c of components) {
    if (c.kind === 'external') edge(service, c);
  }
  if (queue && datastore) edge(queue, datastore, 'process');

  // Any service beyond the first still needs to reach the datastore, and any
  // orphan component would otherwise float unconnected in the diagram.
  const anchor = service ?? client ?? components[0];
  for (const c of components) {
    if (c === anchor) continue;
    const id = ids.get(c)!;
    const connected = [...seenEdges].some((k) => k.startsWith(`${id}->`) || k.endsWith(`->${id}`));
    if (!connected) edge(anchor, c);
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Dependency graph                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Repair an LLM-produced dependency graph in place-safe fashion.
 *
 * A model asked for `dependsOn` edges WILL occasionally reference a task id
 * that doesn't exist, or close a cycle. Both are fatal to `topoSort`, and
 * failing the whole (otherwise excellent, expensive) generation over one bad
 * edge is the wrong trade. So we drop the offending EDGES and keep the tasks:
 *
 *   1. self-dependencies → dropped
 *   2. edges to unknown ids → dropped
 *   3. edges that close a cycle → dropped (first one that would close it)
 *
 * Returns repaired milestones plus a list of what was removed, so the caller
 * can log it and we can tell a well-behaved model from a sloppy one.
 */
export interface GraphRepair {
  milestones: Milestone[];
  removedEdges: Array<{ from: string; to: string; reason: 'self' | 'unknown' | 'cycle' }>;
}

export function repairDependencyGraph(milestones: Milestone[]): GraphRepair {
  const tasks = milestones.flatMap((m) => m.tasks);
  const ids = new Set(tasks.map((t) => t.id));
  const removedEdges: GraphRepair['removedEdges'] = [];

  // Pass 1 — drop self and unknown edges.
  const cleaned = new Map<string, string[]>();
  for (const t of tasks) {
    const kept: string[] = [];
    for (const dep of t.dependsOn) {
      if (dep === t.id) {
        removedEdges.push({ from: t.id, to: dep, reason: 'self' });
      } else if (!ids.has(dep)) {
        removedEdges.push({ from: t.id, to: dep, reason: 'unknown' });
      } else if (!kept.includes(dep)) {
        kept.push(dep);
      }
    }
    cleaned.set(t.id, kept);
  }

  // Pass 2 — break cycles. Walk tasks in declaration order and only keep an
  // edge if the dependency is already reachable-free of the current task,
  // i.e. adding it cannot close a loop.
  const reaches = (from: string, target: string): boolean => {
    const stack = [...(cleaned.get(from) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(cleaned.get(cur) ?? []));
    }
    return false;
  };

  for (const t of tasks) {
    // Snapshot, then rebuild from empty. While we test each candidate edge,
    // `cleaned[t.id]` holds only the edges we've already kept — so if `dep`
    // can already reach `t.id`, adding it back would close a cycle.
    const candidates = cleaned.get(t.id) ?? [];
    const kept: string[] = [];
    cleaned.set(t.id, kept);
    for (const dep of candidates) {
      if (reaches(dep, t.id)) {
        removedEdges.push({ from: t.id, to: dep, reason: 'cycle' });
      } else {
        kept.push(dep);
      }
    }
    cleaned.set(t.id, kept);
  }

  const repaired = milestones.map((m) => ({
    ...m,
    tasks: m.tasks.map((t) => ({ ...t, dependsOn: cleaned.get(t.id) ?? [] })),
  }));

  return { milestones: repaired, removedEdges };
}

/**
 * Kahn's algorithm topological sort over the `dependsOn` edges. Returns the
 * task ids in a valid build order. THROWS if the graph is not a DAG or if any
 * `dependsOn` id references a task that does not exist — call
 * `repairDependencyGraph` first.
 *
 * Determinism: candidates with in-degree 0 are dequeued in the tasks' original
 * declaration order, so the returned order is stable for a given input.
 */
export function topoSort(tasks: PlanTask[]): string[] {
  const ids = new Set(tasks.map((t) => t.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep -> tasks that depend on it

  for (const t of tasks) {
    indegree.set(t.id, 0);
    dependents.set(t.id, []);
  }

  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) {
        throw new Error(`Task "${t.id}" depends on itself.`);
      }
      if (!ids.has(dep)) {
        throw new Error(`Task "${t.id}" depends on unknown task "${dep}".`);
      }
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.get(dep)!.push(t.id);
    }
  }

  const queue: string[] = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (order.length !== tasks.length) {
    const stuck = tasks.filter((t) => !order.includes(t.id)).map((t) => t.id);
    throw new Error(`Dependency cycle detected among tasks: ${stuck.join(', ')}.`);
  }
  return order;
}

/**
 * Longest path by summed `estimateHours` through the `dependsOn` DAG, returned
 * as an ordered array of task ids. Each consecutive pair (a, b) in the result
 * satisfies "b dependsOn a", so it is a genuine chain, not a hand-picked list.
 */
export function criticalPath(tasks: PlanTask[]): string[] {
  if (tasks.length === 0) return [];
  const order = topoSort(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const best = new Map<string, number>(); // total hours of best chain ending here
  const prev = new Map<string, string | null>(); // predecessor on that chain

  for (const id of order) {
    const task = byId.get(id)!;
    let bestPrevTotal = 0;
    let bestPrevId: string | null = null;
    for (const dep of task.dependsOn) {
      const total = best.get(dep) ?? 0;
      // Choose the predecessor whose best chain is longest. Tie-break on the
      // lexicographically-earlier dependency id so the chosen path is stable.
      const better =
        bestPrevId === null ||
        total > bestPrevTotal ||
        (total === bestPrevTotal && dep < bestPrevId);
      if (better) {
        bestPrevTotal = total;
        bestPrevId = dep;
      }
    }
    best.set(id, bestPrevTotal + task.estimateHours);
    prev.set(id, bestPrevId);
  }

  let endId: string | null = null;
  let endTotal = -1;
  for (const id of order) {
    const total = best.get(id) ?? 0;
    if (total > endTotal || (total === endTotal && endId !== null && id < endId)) {
      endTotal = total;
      endId = id;
    }
  }

  const path: string[] = [];
  let cur = endId;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur) ?? null;
  }
  return path;
}

/** Summed hours across every task in the plan. */
export function totalEstimateHours(tasks: PlanTask[]): number {
  const total = tasks.reduce((sum, t) => sum + t.estimateHours, 0);
  return Math.round(total * 10) / 10;
}

/**
 * Calendar weeks to deliver, floored by the critical path.
 *
 * Two constraints, whichever is longer:
 *   - throughput: total hours / (team capacity per week)
 *   - the critical path: no amount of parallelism beats the longest dependency
 *     chain. Omitting this floor is how a plan claims 40 people finish a
 *     6-week chain in 1 week.
 */
export function estimateCalendarWeeks(tasks: PlanTask[], teamSize = 3): number {
  if (tasks.length === 0) return 1;
  const HOURS_PER_PERSON_WEEK = 30; // productive hours, not billable hours
  const capacity = Math.max(1, teamSize) * HOURS_PER_PERSON_WEEK;

  const throughputWeeks = totalEstimateHours(tasks) / capacity;

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const pathHours = criticalPath(tasks).reduce(
    (sum, id) => sum + (byId.get(id)?.estimateHours ?? 0),
    0,
  );
  const criticalWeeks = pathHours / HOURS_PER_PERSON_WEEK;

  const weeks = Math.max(throughputWeeks, criticalWeeks);
  return Math.max(1, Math.ceil(weeks * 2) / 2); // round up to the nearest half-week
}
