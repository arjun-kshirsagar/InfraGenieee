/**
 * QA probe for POST /api/prd/generate — reviewer-owned, not shipped code.
 * Usage: node scripts/qa-probe.mjs http://127.0.0.1:PORT
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3111';
const OUT = '/tmp/qa';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const base = (o) => JSON.parse(JSON.stringify(o));

const A = {
  basics: { projectName: 'TinyLinks', oneLiner: 'A minimal link shortener for personal use.', productType: 'web-app', targetAudience: 'Indie hackers', problemStatement: 'Sharing long URLs is ugly and untrackable for solo makers.' },
  scale: { userScale: 'prototype', peakRequestsPerSecond: 1, dataVolumeGb: 0.5, growthExpectation: 'flat', regions: ['us-east'], uptimeTargetPercent: 99 },
  budget: { monthlyBudgetBand: 'free-tier', budgetIsHardLimit: true, teamSize: 1, timelineWeeks: 2 },
  stack: { frontend: 'nextjs', backend: 'next-api-routes', database: 'sqlite', hosting: 'no-preference', mustUse: [], mustAvoid: [] },
  dataModel: { entities: [{ name: 'Link', description: 'A shortened URL', fields: [{ name: 'slug', type: 'string', required: true }, { name: 'target', type: 'string', required: true }] }] },
  auth: { authRequired: false, authMethods: [], roles: [], multiTenant: false, compliance: ['none'] },
  integrations: { integrations: [], needsRealtime: false, needsBackgroundJobs: false, needsFileUploads: false },
};

const B = {
  basics: { projectName: 'DeskPilot', oneLiner: 'Multi-tenant helpdesk SaaS for small support teams.', productType: 'saas', targetAudience: 'SMB support managers in the EU', problemStatement: 'Small teams juggle email inboxes and lose track of customer issues.' },
  scale: { userScale: 'medium', peakRequestsPerSecond: 60, dataVolumeGb: 40, growthExpectation: 'steady', regions: ['eu-west', 'eu-central'], uptimeTargetPercent: 99.9 },
  budget: { monthlyBudgetBand: 'startup', budgetIsHardLimit: false, teamSize: 4, timelineWeeks: 12 },
  stack: { frontend: 'nextjs', backend: 'next-api-routes', database: 'postgres', hosting: 'no-preference', mustUse: ['Stripe'], mustAvoid: ['MongoDB'] },
  dataModel: { entities: [
    { name: 'Tenant', description: 'A customer org', fields: [{ name: 'name', type: 'string', required: true }] },
    { name: 'Ticket', description: 'A support ticket', fields: [{ name: 'subject', type: 'string', required: true }, { name: 'status', type: 'enum', required: true }] },
    { name: 'Agent', description: 'A support agent', fields: [{ name: 'email', type: 'string', required: true }] },
  ], relationshipNotes: 'Tenants own tickets; agents belong to tenants.' },
  auth: { authRequired: true, authMethods: ['email-password', 'oauth-google'], roles: ['admin', 'agent'], multiTenant: true, compliance: ['gdpr'] },
  integrations: { integrations: ['payments', 'transactional-email'], needsRealtime: false, needsBackgroundJobs: true, needsFileUploads: false },
};

const C = {
  basics: { projectName: 'VitalStream', oneLiner: 'Realtime patient vitals monitoring for hospital networks.', productType: 'saas', targetAudience: 'Hospital IT and clinical ops teams', problemStatement: 'Clinicians lack a unified realtime view of patient vitals across wards.' },
  scale: { userScale: 'very-large', peakRequestsPerSecond: 8000, dataVolumeGb: 40000, growthExpectation: 'aggressive', regions: ['us-east', 'us-west', 'eu-west', 'ap-south', 'global-edge'], uptimeTargetPercent: 99.99 },
  budget: { monthlyBudgetBand: 'enterprise', budgetIsHardLimit: false, teamSize: 40, timelineWeeks: 52 },
  stack: { frontend: 'react-spa', backend: 'go', database: 'postgres', hosting: 'no-preference', mustUse: ['Kafka'], mustAvoid: ['Vercel', 'Firebase'] },
  dataModel: { entities: [
    { name: 'Patient', fields: [{ name: 'mrn', type: 'string', required: true }] },
    { name: 'Ward', fields: [{ name: 'name', type: 'string', required: true }] },
    { name: 'Device', fields: [{ name: 'serial', type: 'string', required: true }] },
    { name: 'VitalReading', fields: [{ name: 'value', type: 'number', required: true }, { name: 'takenAt', type: 'date', required: true }] },
    { name: 'Alert', fields: [{ name: 'severity', type: 'enum', required: true }] },
    { name: 'Clinician', fields: [{ name: 'npi', type: 'string', required: true }] },
    { name: 'AuditEvent', fields: [{ name: 'action', type: 'string', required: true }] },
  ], relationshipNotes: 'Patients are admitted to wards; devices emit vital readings; alerts fire from readings.' },
  auth: { authRequired: true, authMethods: ['sso-saml', 'email-password'], roles: ['admin', 'clinician', 'auditor'], multiTenant: true, compliance: ['hipaa', 'soc2'] },
  integrations: { integrations: ['file-storage', 'analytics', 'webhooks'], needsRealtime: true, needsBackgroundJobs: true, needsFileUploads: true },
};

const D = {
  basics: { projectName: 'GeoPing API', oneLiner: 'A stateless geocoding and reverse-geocoding HTTP API.', productType: 'api-service', targetAudience: 'Backend developers', problemStatement: 'Existing geocoding APIs are expensive and rate limited for small teams.' },
  scale: { userScale: 'small', peakRequestsPerSecond: 25, dataVolumeGb: 0, growthExpectation: 'steady', regions: ['global-edge'], uptimeTargetPercent: 99.5 },
  budget: { monthlyBudgetBand: 'hobby', budgetIsHardLimit: true, teamSize: 2, timelineWeeks: 6 },
  stack: { frontend: 'none', backend: 'go', database: 'none', hosting: 'no-preference', mustUse: [], mustAvoid: [] },
  dataModel: { entities: [{ name: 'GeocodeRequest', description: 'An in-flight lookup', fields: [{ name: 'query', type: 'string', required: true }] }] },
  auth: { authRequired: true, authMethods: ['api-keys'], roles: [], multiTenant: false, compliance: ['none'] },
  integrations: { integrations: ['webhooks'], needsRealtime: false, needsBackgroundJobs: false, needsFileUploads: false },
};

const SETS = { a: A, b: B, c: C, d: D };

async function post(body, raw = false) {
  const res = await fetch(`${BASE}/api/prd/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text };
}

function deepEqualIgnoring(a, b) {
  const stripA = { ...a, id: 'X', createdAt: 'X' };
  const stripB = { ...b, id: 'X', createdAt: 'X' };
  return JSON.stringify(stripA) === JSON.stringify(stripB);
}

function mermaidIssues(m) {
  const problems = [];
  if (!/^\s*flowchart\s+(TD|LR|TB)/.test(m)) problems.push('missing flowchart header');
  const lines = m.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (/^(flowchart|subgraph|end|%%)/.test(l)) continue;
    // find node declarations: id[label] / id(label) / id{label}
    const decls = [...l.matchAll(/([A-Za-z0-9_\-]*)\s*[\[\(\{]/g)];
    for (const d of decls) {
      const id = d[1];
      if (id === '') problems.push(`empty node id in: ${l}`);
      else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) problems.push(`unsafe node id "${id}" in: ${l}`);
    }
    // unquoted label with special chars
    const labels = [...l.matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]);
    for (const lab of labels) {
      if (/[()<>{}]/.test(lab) && !/^".*"$/.test(lab)) problems.push(`unquoted special chars in label: ${lab}`);
    }
  }
  return problems;
}

function analyse(key, doc) {
  const ids = new Set();
  const tasks = [];
  for (const m of doc.plan.milestones) for (const t of m.tasks) { tasks.push(t); ids.add(t.id); }
  const missingDeps = [];
  for (const t of tasks) for (const d of (t.dependsOn || [])) if (!ids.has(d)) missingDeps.push(`${t.id}->${d}`);
  // cycle detection
  const adj = new Map(tasks.map((t) => [t.id, t.dependsOn || []]));
  const state = new Map();
  const cycles = [];
  const visit = (n, stack) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) { cycles.push([...stack, n].join('->')); return; }
    state.set(n, 1);
    for (const m of adj.get(n) || []) visit(m, [...stack, n]);
    state.set(n, 2);
  };
  for (const t of tasks) visit(t.id, []);
  // critical path genuine? consecutive links must be dependsOn-connected
  const cp = doc.plan.criticalPath;
  const cpUnknown = cp.filter((id) => !ids.has(id));
  const cpBreaks = [];
  for (let i = 1; i < cp.length; i++) {
    const deps = adj.get(cp[i]) || [];
    if (!deps.includes(cp[i - 1])) cpBreaks.push(`${cp[i - 1]} !-> ${cp[i]}`);
  }
  const entityNames = new Set(doc.answers.dataModel.entities.map((e) => e.name));
  const badRel = doc.architecture.dataModel.relationships.filter(
    (r) => !entityNames.has(r.from) || !entityNames.has(r.to),
  ).map((r) => `${r.from}->${r.to}`);
  const mustAvoid = doc.answers.stack.mustAvoid;
  const infraBlob = JSON.stringify(doc.architecture.infrastructure) + JSON.stringify(doc.architecture.components);
  const avoidHits = mustAvoid.filter((x) => new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(infraBlob));
  const frontendish = doc.architecture.components.filter((c) => /frontend|ui|web app|client/i.test(c.kind + ' ' + c.name + ' ' + c.technology));
  const uiTasks = tasks.filter((t) => t.area === 'frontend' || t.area === 'design');
  return {
    key,
    title: doc.title,
    hosting: doc.architecture.infrastructure.hosting,
    database: doc.architecture.infrastructure.database,
    cache: doc.architecture.infrastructure.cache,
    storage: doc.architecture.infrastructure.storage,
    cicd: doc.architecture.infrastructure.cicd,
    envs: doc.architecture.infrastructure.environments,
    pattern: doc.architecture.pattern,
    rationale: doc.architecture.infrastructure.rationale,
    components: doc.architecture.components.length,
    componentNames: doc.architecture.components.map((c) => `${c.name}/${c.kind}`),
    endpoints: doc.architecture.apiEndpoints.length,
    stories: doc.prd.userStories.length,
    frs: doc.prd.functionalRequirements.length,
    nfrs: doc.prd.nonFunctionalRequirements.length,
    nfrCats: doc.prd.nonFunctionalRequirements.map((n) => n.category),
    nfrTexts: doc.prd.nonFunctionalRequirements.map((n) => n.requirement),
    goals: doc.prd.goals.length,
    risks: doc.prd.risks.map((r) => r.risk),
    milestones: doc.plan.milestones.length,
    milestoneNames: doc.plan.milestones.map((m) => m.name),
    tasks: tasks.length,
    totalHours: doc.plan.totalEstimateHours,
    weeks: doc.plan.estimatedCalendarWeeks,
    cpLen: cp.length,
    minVolumeOk: doc.prd.userStories.length >= 5 && doc.prd.functionalRequirements.length >= 8 && doc.prd.nonFunctionalRequirements.length >= 5 && doc.plan.milestones.length >= 3 && tasks.length >= 12,
    missingDeps, cycles, cpUnknown, cpBreaks, badRel, avoidHits,
    frontendComponents: frontendish.map((c) => c.name),
    uiTaskTitles: uiTasks.map((t) => `${t.area}:${t.title}`),
    mermaidIssues: mermaidIssues(doc.architecture.diagramMermaid),
    mermaidHead: doc.architecture.diagramMermaid.split('\n').slice(0, 6).join(' | '),
    answersEchoVerbatim: null,
  };
}

const report = {};
for (const [key, answers] of Object.entries(SETS)) {
  const r1 = await post({ answers });
  if (r1.status !== 200) { report[key] = { FAILED: r1.status, body: r1.json }; continue; }
  const r2 = await post({ answers });
  const doc = r1.json.document;
  writeFileSync(`${OUT}/doc-${key}.json`, JSON.stringify(doc, null, 2));
  const an = analyse(key, doc);
  an.deterministic = deepEqualIgnoring(doc, r2.json.document);
  // verbatim echo: compare echo against input after zod defaults; do subset check on provided keys
  const echoIssues = [];
  const walk = (inp, out, path) => {
    for (const k of Object.keys(inp)) {
      const iv = inp[k], ov = out?.[k];
      if (iv && typeof iv === 'object' && !Array.isArray(iv)) walk(iv, ov, `${path}.${k}`);
      else if (JSON.stringify(iv) !== JSON.stringify(ov)) echoIssues.push(`${path}.${k}: sent ${JSON.stringify(iv)} got ${JSON.stringify(ov)}`);
    }
  };
  walk(answers, doc.answers, 'answers');
  an.answersEchoVerbatim = echoIssues.length === 0 ? true : echoIssues;
  an.idFormatOk = /^prd_[a-z0-9]{12}$/.test(doc.id);
  an.createdAtIso = doc.createdAt;
  report[key] = an;
}

// error paths
const errs = {};
errs.malformed = await post('{not json', true);
const bad = base(A); delete bad.scale.regions;
errs.validation = await post({ answers: bad });
errs.emptyBody = await post({}, false);
const badUptime = base(A); badUptime.scale.uptimeTargetPercent = 50;
errs.rangeUptime = await post({ answers: badUptime });
errs.extraKeys = await post({ answers: A, bogus: 1 });
report._errors = Object.fromEntries(Object.entries(errs).map(([k, v]) => [k, { status: v.status, body: v.json ?? v.text.slice(0, 200) }]));

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
