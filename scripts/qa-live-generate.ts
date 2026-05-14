/**
 * QA live-generation probe (reviewer-owned).
 *
 * Runs the REAL pipeline against 4 materially different briefs and dumps the
 * full documents to /tmp/qa-gen/ for adversarial reading. Also asserts the
 * contract guarantees that can only be checked on real output.
 *
 * COST: 4 briefs x 4 Anthropic calls = 16 calls on OUR key (the product's only
 * paid dependency). No deploys, no other paid API.
 *
 * Run: npx tsx --env-file=.env.local scripts/qa-live-generate.ts [briefKey...]
 */

import { writeFileSync, mkdirSync } from 'node:fs';

import { prdDocumentSchema, type ProjectBrief } from '../src/types/prd';
import { generatePrdDocument } from '../src/lib/prd/generation';
import { newPrdId } from '../src/lib/prd/api';

const OUT = '/tmp/qa-gen';
mkdirSync(OUT, { recursive: true });

const BRIEFS: Record<string, ProjectBrief> = {
  /* 1 — deliberately SIMPLE CRUD tool, tiny scale, zero budget. */
  crud: {
    idea:
      'A tiny internal tool for our 6-person law office to track which physical case files ' +
      'are checked out of the cabinet and by whom. Someone scans a barcode on the folder, ' +
      'picks their name, and it logs the checkout. We want to see what is overdue.',
    context: {
      userScale: 'prototype',
      trafficPattern: 'business-hours',
      budgetBand: 'free-tier',
      timelineWeeks: 3,
      constraints: 'Nobody here is technical. Must be a single simple web page. No mobile app.',
    },
    clarifications: [],
  },

  /* 2 — COMPLEX two-sided marketplace, large scale, real money. */
  marketplace: {
    idea:
      'A marketplace where independent scuba diving instructors list open spots on their boat ' +
      'trips and divers book last-minute seats. Instructors set their own prices and cancellation ' +
      'windows. We take 12% commission. Divers need to upload their certification card and it ' +
      'must be verified before they can book anything deeper than 18 metres. Weather cancellations ' +
      'are constant so we need automatic refunds and a rebooking flow. Instructors get paid out weekly.',
    context: {
      userScale: 'large',
      trafficPattern: 'seasonal',
      budgetBand: 'growth',
      timelineWeeks: 20,
      constraints:
        'Operating in Thailand, Egypt and Mexico — multi-currency and local payout rails. ' +
        'Payments must go through Stripe Connect. No crypto.',
    },
    clarifications: [
      {
        question: 'Do instructors verify diver certifications themselves, or does your team?',
        answer: 'Our team verifies them centrally — instructors cannot be trusted to check properly.',
      },
    ],
    additionalNotes: 'v1 is web only. Instructor mobile app is explicitly out of scope.',
  },

  /* 3 — HARD COMPLIANCE constraints. */
  compliance: {
    idea:
      'A platform for community mental-health clinics to run group therapy sessions over video ' +
      'and keep clinical notes. Therapists write SOAP notes after each session, and a supervising ' +
      'psychiatrist countersigns notes for trainee therapists. Patients get a portal to see their ' +
      'appointment schedule but must never see raw clinical notes.',
    context: {
      userScale: 'medium',
      trafficPattern: 'business-hours',
      budgetBand: 'enterprise',
      timelineWeeks: 36,
      constraints:
        'HIPAA is non-negotiable — BAA required from every vendor that touches PHI. Must also ' +
        'satisfy 42 CFR Part 2 for substance-use records. All PHI must stay in US regions. ' +
        'Full audit trail of every note read/write. Our team only knows Python and Postgres.',
    },
    clarifications: [],
  },

  /* 4 — deliberately VAGUE. The AI must assume, and must say so. */
  vague: {
    idea: 'Something like Airbnb but for renting out gear you already own. Kind of a side project idea.',
    context: {
      userScale: 'small',
      trafficPattern: 'unknown',
      budgetBand: 'hobby',
      timelineWeeks: 8,
    },
    clarifications: [
      {
        question: 'Do renters and owners meet in person to hand over the gear, or is it shipped?',
        answer: '',
      },
    ],
  },
};

const GENERIC_NOUNS = [
  'user', 'users', 'item', 'items', 'thing', 'things', 'entity', 'entities',
  'object', 'objects', 'record', 'records', 'data', 'resource', 'resources',
  'product', 'products', 'order', 'orders', 'category', 'categories', 'tag', 'tags',
];

async function run(key: string) {
  const brief = BRIEFS[key];
  const t0 = Date.now();
  console.log(`\n[${key}] starting…`);
  try {
    const doc = await generatePrdDocument(brief, newPrdId(), new Date().toISOString());
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    writeFileSync(`${OUT}/${key}.json`, JSON.stringify(doc, null, 2));

    const parsed = prdDocumentSchema.safeParse(doc);
    const entities = doc.architecture.dataModel.entities.map((e) => e.name);
    const genericEntities = entities.filter((n) => GENERIC_NOUNS.includes(n.trim().toLowerCase()));
    const tasks = doc.plan.milestones.flatMap((m) => m.tasks);
    const briefEchoed = JSON.stringify(doc.brief) === JSON.stringify(brief);

    console.log(
      [
        `[${key}] DONE in ${secs}s`,
        `  title:              ${doc.title}`,
        `  model:              ${doc.model}`,
        `  schema parses:      ${parsed.success}`,
        `  brief echoed:       ${briefEchoed}`,
        `  entities (${entities.length}):     ${entities.join(', ')}`,
        `  GENERIC entities:   ${genericEntities.length === 0 ? 'none' : genericEntities.join(', ')}`,
        `  components:         ${doc.architecture.components.map((c) => `${c.name}[${c.kind}]`).join(', ')}`,
        `  pattern:            ${doc.architecture.pattern}`,
        `  hosting/db:         ${doc.architecture.infrastructure.hosting} / ${doc.architecture.infrastructure.database}`,
        `  stories/FR/NFR:     ${doc.prd.userStories.length}/${doc.prd.functionalRequirements.length}/${doc.prd.nonFunctionalRequirements.length}`,
        `  assumptions:        ${doc.prd.assumptions.length}`,
        `  endpoints:          ${doc.architecture.apiEndpoints.length}`,
        `  milestones/tasks:   ${doc.plan.milestones.length}/${tasks.length}`,
        `  criticalPath len:   ${doc.plan.criticalPath.length}`,
        `  hours / weeks:      ${doc.plan.totalEstimateHours}h / ${doc.plan.estimatedCalendarWeeks}w`,
        `  saved:              ${OUT}/${key}.json`,
      ].join('\n'),
    );
    return { key, ok: true };
  } catch (err) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const code = (err as { code?: string }).code ?? 'unknown';
    console.log(`[${key}] FAILED after ${secs}s code=${code} msg=${(err as Error).message}`);
    return { key, ok: false, code, message: (err as Error).message };
  }
}

async function main() {
  const keys = process.argv.slice(2).filter((k) => k in BRIEFS);
  const targets = keys.length > 0 ? keys : Object.keys(BRIEFS);
  console.log(`Running ${targets.length} live generation(s): ${targets.join(', ')}`);

  const results = await Promise.all(targets.map(run));
  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`  ${r.key}: ${r.ok ? 'ok' : `FAILED (${r.code})`}`);
}

void main();
