/**
 * QA probe: markdown export fidelity on the REAL generated documents.
 * Offline, zero API calls. Run: npx tsx scripts/qa-markdown-probe.ts
 */
import { readFileSync } from 'node:fs';

import { prdDocumentSchema } from '../src/types/prd';
import { toMarkdown } from '../src/lib/prd/markdown';

let fails = 0;
const check = (n: string, p: boolean, d = '') => {
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
  if (!p) fails++;
};

async function main() {
  for (const key of ['crud', 'marketplace', 'compliance', 'vague']) {
    const raw = JSON.parse(readFileSync(`/tmp/qa-gen/${key}.json`, 'utf8'));
    const parsed = prdDocumentSchema.safeParse(raw);
    check(`${key}: real generated document parses prdDocumentSchema`, parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3)));
    if (!parsed.success) continue;
    const doc = parsed.data;

    const md = toMarkdown(doc);
    const tasks = doc.plan.milestones.flatMap((m) => m.tasks);

    console.log(`\n--- ${key}: markdown ${md.length} chars, ${md.split('\n').length} lines ---`);
    check(`${key}: title in markdown`, md.includes(doc.title));
    check(`${key}: brief idea echoed`, md.includes(doc.brief.idea.slice(0, 60)));
    check(`${key}: every entity name present`,
      doc.architecture.dataModel.entities.every((e) => md.includes(e.name)),
      doc.architecture.dataModel.entities.filter((e) => !md.includes(e.name)).map((e) => e.name).join(',') || 'all present');
    check(`${key}: every task id present`,
      tasks.every((t) => md.includes(t.id)),
      tasks.filter((t) => !md.includes(t.id)).map((t) => t.id).join(',') || `all ${tasks.length} present`);
    check(`${key}: every assumption present`,
      doc.prd.assumptions.every((a) => md.includes(a.slice(0, 40))),
      `${doc.prd.assumptions.length} assumptions`);
    check(`${key}: mermaid diagram fenced as \`\`\`mermaid`, md.includes('```mermaid'));
    check(`${key}: mermaid body included`, md.includes('flowchart TD'));
    check(`${key}: infra rationale present`,
      doc.architecture.infrastructure.rationale.every((r) => md.includes(r.slice(0, 40))));
    check(`${key}: no unresolved template markers`, !/\{\{|\}\}|undefined|\[object Object\]/.test(md),
      (md.match(/\{\{|\}\}|undefined|\[object Object\]/g) || []).join(','));
    check(`${key}: totals rendered`, md.includes(String(doc.plan.totalEstimateHours)) && md.includes(String(doc.plan.estimatedCalendarWeeks)));
  }
  console.log(`\n${fails === 0 ? 'ALL MARKDOWN PROBES PASSED' : `${fails} FAILED`}`);
  process.exit(fails === 0 ? 0 : 1);
}
void main();
export {};
