/**
 * QA probe (reviewer-owned, offline, zero API calls).
 *
 * Verifies at the SCHEMA level the two Majors that were closed structurally,
 * plus the derived-field guarantees. Run: npx tsx scripts/qa-schema-probe.ts
 */

import {
  prdDocumentSchema,
  dataModelSchema,
  MIN_PLAN_TASKS,
  type Milestone,
  type PlanTask,
  type PrdDocument,
} from '../src/types/prd';
import {
  criticalPath,
  estimateCalendarWeeks,
  totalEstimateHours,
  buildArchitectureMermaid,
} from '../src/lib/prd/derive';

let fails = 0;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) fails++;
};

/* ---------- helpers to build a MINIMAL VALID document ---------------------- */

const task = (id: string, hours: number, dependsOn: string[] = []): PlanTask => ({
  id,
  title: `Task ${id}`,
  description: 'd',
  area: 'backend',
  estimateHours: hours,
  dependsOn,
  acceptanceCriteria: ['ac'],
});

const milestone = (id: string, tasks: PlanTask[]): Milestone => ({
  id,
  name: `M ${id}`,
  goal: 'g',
  tasks,
});

function baseDoc(overrides: Partial<PrdDocument> = {}): PrdDocument {
  const tasks = Array.from({ length: 12 }, (_, i) => task(`T-${i + 1}`, 8));
  const ms = [
    milestone('M1', tasks.slice(0, 4)),
    milestone('M2', tasks.slice(4, 8)),
    milestone('M3', tasks.slice(8, 12)),
  ];
  const flat = ms.flatMap((m) => m.tasks);
  const doc: PrdDocument = {
    id: 'prd_test00000',
    createdAt: new Date().toISOString(),
    generatorVersion: '2.0.0',
    model: 'claude-sonnet-5',
    title: 'T',
    brief: {
      idea: 'x'.repeat(40),
      context: {
        userScale: 'medium',
        trafficPattern: 'steady',
        budgetBand: 'startup',
        timelineWeeks: 12,
      },
      clarifications: [],
    },
    prd: {
      overview: { problem: 'p', solution: 's', targetUsers: 't', valueProposition: ['v'] },
      goals: ['g1', 'g2', 'g3'],
      nonGoals: ['ng'],
      userStories: Array.from({ length: 5 }, (_, i) => ({
        id: `US-${i}`,
        asA: 'a',
        iWant: 'w',
        soThat: 's',
        priority: 'p1' as const,
        acceptanceCriteria: ['ac'],
      })),
      functionalRequirements: Array.from({ length: 8 }, (_, i) => ({
        id: `FR-${i}`,
        title: 't',
        detail: 'd',
        priority: 'p1' as const,
      })),
      nonFunctionalRequirements: Array.from({ length: 5 }, (_, i) => ({
        id: `NFR-${i}`,
        category: 'performance' as const,
        requirement: 'r',
        rationale: 'why',
      })),
      successMetrics: ['m1', 'm2', 'm3'],
      risks: Array.from({ length: 3 }, () => ({
        risk: 'r',
        impact: 'p1' as const,
        mitigation: 'm',
      })),
      openQuestions: [],
      assumptions: ['a1'],
    },
    architecture: {
      summary: 's',
      pattern: 'p',
      components: [
        { name: 'Web', kind: 'client', responsibility: 'r', technology: 'next' },
        { name: 'API', kind: 'service', responsibility: 'r', technology: 'node' },
        { name: 'DB', kind: 'datastore', responsibility: 'r', technology: 'pg' },
      ],
      dataModel: {
        entities: [
          { name: 'Bakery', fields: [{ name: 'id', type: 'string', required: true }] },
          { name: 'Listing', fields: [{ name: 'id', type: 'string', required: true }] },
          { name: 'Reservation', fields: [{ name: 'id', type: 'string', required: true }] },
        ],
        relationships: [{ from: 'Bakery', to: 'Listing', kind: 'one-to-many' }],
      },
      apiEndpoints: Array.from({ length: 5 }, (_, i) => ({
        method: 'GET' as const,
        path: `/a${i}`,
        purpose: 'p',
        authRequired: false,
      })),
      infrastructure: {
        hosting: 'vercel',
        database: 'neon',
        cache: null,
        storage: null,
        cicd: 'gh actions',
        environments: ['prod'],
        rationale: ['because the brief says startup budget'],
      },
      diagramMermaid: 'flowchart TD\n  a --> b',
    },
    plan: {
      milestones: ms,
      criticalPath: criticalPath(flat),
      totalEstimateHours: totalEstimateHours(flat),
      estimatedCalendarWeeks: estimateCalendarWeeks(flat, 3),
    },
  };
  return { ...doc, ...overrides };
}

console.log('=== sanity: the baseline document must PARSE ===');
const base = prdDocumentSchema.safeParse(baseDoc());
check('baseline valid document parses', base.success, base.success ? '' : JSON.stringify(base.error.issues.slice(0, 5)));

/* ---------- MAJOR #1 regression: min-volume floors ------------------------- */

console.log('\n=== REGRESSION 1: min-volume floors are schema-enforced ===');

type Floor = { name: string; mutate: (d: PrdDocument) => void; expectPath: string };
const floors: Floor[] = [
  { name: 'userStories < 5', mutate: (d) => { d.prd.userStories = d.prd.userStories.slice(0, 4); }, expectPath: 'prd.userStories' },
  { name: 'functionalRequirements < 8', mutate: (d) => { d.prd.functionalRequirements = d.prd.functionalRequirements.slice(0, 7); }, expectPath: 'prd.functionalRequirements' },
  { name: 'nonFunctionalRequirements < 5', mutate: (d) => { d.prd.nonFunctionalRequirements = d.prd.nonFunctionalRequirements.slice(0, 4); }, expectPath: 'prd.nonFunctionalRequirements' },
  { name: 'goals < 3', mutate: (d) => { d.prd.goals = ['only one']; }, expectPath: 'prd.goals' },
  { name: 'successMetrics < 3', mutate: (d) => { d.prd.successMetrics = ['one']; }, expectPath: 'prd.successMetrics' },
  { name: 'risks < 3', mutate: (d) => { d.prd.risks = d.prd.risks.slice(0, 1); }, expectPath: 'prd.risks' },
  { name: 'assumptions empty', mutate: (d) => { d.prd.assumptions = []; }, expectPath: 'prd.assumptions' },
  { name: 'entities < 3', mutate: (d) => { d.architecture.dataModel.entities = d.architecture.dataModel.entities.slice(0, 2); d.architecture.dataModel.relationships = []; }, expectPath: 'architecture.dataModel.entities' },
  { name: 'entity with 0 fields', mutate: (d) => { d.architecture.dataModel.entities[0].fields = []; }, expectPath: 'fields' },
  { name: 'components < 3', mutate: (d) => { d.architecture.components = d.architecture.components.slice(0, 2); }, expectPath: 'architecture.components' },
  { name: 'apiEndpoints < 5', mutate: (d) => { d.architecture.apiEndpoints = d.architecture.apiEndpoints.slice(0, 4); }, expectPath: 'architecture.apiEndpoints' },
  { name: 'infrastructure.rationale empty', mutate: (d) => { d.architecture.infrastructure.rationale = []; }, expectPath: 'rationale' },
  { name: 'milestones < 3', mutate: (d) => { d.plan.milestones = d.plan.milestones.slice(0, 2); d.plan.criticalPath = [d.plan.milestones[0].tasks[0].id]; }, expectPath: 'plan.milestones' },
  {
    name: `plan tasks < ${MIN_PLAN_TASKS} (the ORIGINAL Major)`,
    mutate: (d) => {
      // 3 milestones, 2 tasks each = 6 tasks. Milestone floor satisfied.
      const t = Array.from({ length: 6 }, (_, i) => task(`S-${i}`, 8));
      d.plan.milestones = [milestone('M1', t.slice(0, 2)), milestone('M2', t.slice(2, 4)), milestone('M3', t.slice(4, 6))];
      d.plan.criticalPath = ['S-0'];
      d.plan.totalEstimateHours = 48;
      d.plan.estimatedCalendarWeeks = 1;
    },
    expectPath: 'plan.milestones',
  },
];

for (const f of floors) {
  const d = baseDoc();
  f.mutate(d);
  const r = prdDocumentSchema.safeParse(d);
  const paths = r.success ? [] : r.error.issues.map((i) => i.path.map(String).join('.'));
  check(
    `rejected: ${f.name}`,
    !r.success,
    r.success ? 'PARSED — floor NOT enforced!' : `issue at ${paths.join(' | ')}`,
  );
}

/* ---------- MAJOR #2 regression: integrity rules --------------------------- */

console.log('\n=== REGRESSION 2: data-model + graph integrity are parse errors ===');

const dmCases: Array<{ name: string; dm: unknown }> = [
  {
    name: 'duplicate entity name (exact)',
    dm: {
      entities: [
        { name: 'Bakery', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Bakery', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Listing', fields: [{ name: 'id', type: 'string', required: true }] },
      ],
      relationships: [],
    },
  },
  {
    name: 'duplicate entity name (case-insensitive: Tenant / tenant)',
    dm: {
      entities: [
        { name: 'Tenant', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'tenant', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Listing', fields: [{ name: 'id', type: 'string', required: true }] },
      ],
      relationships: [],
    },
  },
  {
    name: 'duplicate entity name (trimmed: "Tenant " / "Tenant")',
    dm: {
      entities: [
        { name: 'Tenant ', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Tenant', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Listing', fields: [{ name: 'id', type: 'string', required: true }] },
      ],
      relationships: [],
    },
  },
  {
    name: 'duplicate field within an entity (case-insensitive)',
    dm: {
      entities: [
        {
          name: 'Bakery',
          fields: [
            { name: 'email', type: 'string', required: true },
            { name: 'Email', type: 'string', required: false },
          ],
        },
        { name: 'Listing', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Reservation', fields: [{ name: 'id', type: 'string', required: true }] },
      ],
      relationships: [],
    },
  },
  {
    name: 'relationship endpoint is not a declared entity',
    dm: {
      entities: [
        { name: 'Bakery', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Listing', fields: [{ name: 'id', type: 'string', required: true }] },
        { name: 'Reservation', fields: [{ name: 'id', type: 'string', required: true }] },
      ],
      relationships: [{ from: 'Bakery', to: 'Ghost', kind: 'one-to-many' }],
    },
  },
];

for (const c of dmCases) {
  const r = dataModelSchema.safeParse(c.dm);
  check(
    `rejected: ${c.name}`,
    !r.success,
    r.success ? 'PARSED — integrity rule NOT enforced!' : r.error.issues.map((i) => i.message).join(' | '),
  );
}

const planCases: Array<{ name: string; mutate: (d: PrdDocument) => void }> = [
  { name: 'duplicate plan task id', mutate: (d) => { d.plan.milestones[0].tasks[1].id = d.plan.milestones[0].tasks[0].id; } },
  { name: 'self dependency', mutate: (d) => { const t0 = d.plan.milestones[0].tasks[0]; t0.dependsOn = [t0.id]; } },
  { name: 'dangling dependsOn', mutate: (d) => { d.plan.milestones[0].tasks[0].dependsOn = ['NOPE']; } },
  { name: 'criticalPath references unknown task', mutate: (d) => { d.plan.criticalPath = ['GHOST']; } },
];
for (const c of planCases) {
  const d = baseDoc();
  c.mutate(d);
  const r = prdDocumentSchema.safeParse(d);
  check(`rejected: ${c.name}`, !r.success, r.success ? 'PARSED — NOT enforced!' : r.error.issues.map((i) => i.message)[0]);
}

/* ---------- derived fields genuinely derived ------------------------------- */

console.log('\n=== DERIVED FIELDS ===');

// A chain T1->T2->...->T6 of 40h each = 240h critical path.
const chain: PlanTask[] = Array.from({ length: 6 }, (_, i) =>
  task(`C-${i + 1}`, 40, i === 0 ? [] : [`C-${i}`]),
);
// Plus 6 wide independent 1h tasks to satisfy the >=12 floor without extending the path.
const wide: PlanTask[] = Array.from({ length: 6 }, (_, i) => task(`W-${i + 1}`, 1));
const mixed = [...chain, ...wide];

const cp1 = criticalPath(mixed);
check(
  'criticalPath follows the chain (6 chained tasks)',
  JSON.stringify(cp1) === JSON.stringify(['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6']),
  JSON.stringify(cp1),
);

// Mutate dependsOn: break the chain in the middle -> critical path must shorten.
const broken = mixed.map((t) => (t.id === 'C-4' ? { ...t, dependsOn: [] } : t));
const cp2 = criticalPath(broken);
check(
  'mutating dependsOn changes criticalPath (chain broken at C-4)',
  cp2.length < cp1.length && JSON.stringify(cp2) !== JSON.stringify(cp1),
  `${JSON.stringify(cp1)} -> ${JSON.stringify(cp2)}`,
);

// Re-point the chain: make W-1 depend on C-6 -> path must extend.
const extended = mixed.map((t) => (t.id === 'W-1' ? { ...t, dependsOn: ['C-6'] } : t));
const cp3 = criticalPath(extended);
check(
  'extending dependsOn extends criticalPath',
  cp3.length === cp1.length + 1 && cp3[cp3.length - 1] === 'W-1',
  JSON.stringify(cp3),
);

check('totalEstimateHours sums all tasks', totalEstimateHours(mixed) === 6 * 40 + 6 * 1, String(totalEstimateHours(mixed)));

// The old MINOR: teamSize 40 collapsing a long chain to ~1 week.
const pathHours = 6 * 40; // 240h
const criticalWeeksFloor = pathHours / 30; // 8 weeks
for (const teamSize of [1, 3, 10, 40, 400]) {
  const w = estimateCalendarWeeks(mixed, teamSize);
  check(
    `estimatedCalendarWeeks respects the critical-path floor (teamSize=${teamSize})`,
    w >= criticalWeeksFloor,
    `${w} weeks (floor ${criticalWeeksFloor})`,
  );
}

/* ---------- Mermaid validity ---------------------------------------------- */

console.log('\n=== MERMAID (adversarial component names) ===');
const nastyComponents = [
  { name: 'Web "App" [beta]', kind: 'client' as const, responsibility: 'r', technology: 't' },
  { name: 'API|Gateway{v2}', kind: 'service' as const, responsibility: 'r', technology: 't' },
  { name: 'Postgres (Neon)', kind: 'datastore' as const, responsibility: 'r', technology: 't' },
  { name: 'Redis', kind: 'cache' as const, responsibility: 'r', technology: 't' },
  { name: 'Stripe', kind: 'external' as const, responsibility: 'r', technology: 't' },
  { name: 'Stripe', kind: 'external' as const, responsibility: 'r', technology: 't' }, // dup name
  { name: '!!!', kind: 'queue' as const, responsibility: 'r', technology: 't' },
  { name: '', kind: 'cdn' as const, responsibility: 'r', technology: 't' },
];
const mm = buildArchitectureMermaid('My Project "X"', nastyComponents);
console.log(mm);
check('mermaid starts with flowchart TD', mm.split('\n')[1] === 'flowchart TD');
check('no raw double quotes inside labels', !/\["[^"]*"[^"\]]*"/.test(mm));
check('no unescaped [ or ] inside a label body', !/\["[^"]*[[\]|{}][^"]*"\]/.test(mm));
const nodeIds = [...mm.matchAll(/^ {2}([A-Za-z0-9_]+)\["/gm)].map((m) => m[1]);
check('all node ids unique', new Set(nodeIds).size === nodeIds.length, nodeIds.join(','));
check('every component got a node', nodeIds.length === nastyComponents.length, `${nodeIds.length}/${nastyComponents.length}`);

console.log(`\n${fails === 0 ? 'ALL PROBES PASSED' : `${fails} PROBE(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
