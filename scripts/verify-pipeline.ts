/**
 * MANUAL VERIFICATION — generates full PrdDocuments for a few genuinely
 * different briefs and prints a comparison, to confirm the pipeline produces
 * real, brief-grounded output (not generic filler).
 *
 * Cost safety: this makes REAL Anthropic calls on our key — ~4 calls per brief
 * (prd, architecture, plan, title). Keep the brief list SHORT (2–3). Do NOT run
 * a sweep. Run only to validate prompt quality after changes.
 *
 *   npx tsx --env-file=.env.local scripts/verify-pipeline.ts
 *
 * Optional: ANTHROPIC_MODEL overrides the generation model (default sonnet-5).
 * Set VERIFY_MODEL=claude-sonnet-4-6 etc. to try a cheaper model.
 */

import { runGenerationPipeline } from '../src/lib/prd/llm/pipeline';
import { GenerationError } from '../src/lib/prd/generation';
import { prdDocumentSchema, type ProjectBrief } from '../src/types/prd';

const BRIEFS: { label: string; brief: ProjectBrief }[] = [
  {
    label: 'FREE-TIER PROTOTYPE',
    brief: {
      idea: 'A tiny weekend web app where a solo indie hacker can paste a list of their side-project URLs and get a single public status page showing whether each one is up, refreshed every few minutes.',
      context: {
        userScale: 'prototype',
        trafficPattern: 'steady',
        budgetBand: 'free-tier',
        timelineWeeks: 2,
        constraints: 'Must cost literally $0/month. Single developer. No paid services.',
      },
      clarifications: [],
      additionalNotes: 'Keep it dead simple — no accounts needed for viewers.',
    },
  },
  {
    label: 'VERY-LARGE ENTERPRISE (HARD COMPLIANCE)',
    brief: {
      idea: 'A patient-facing telehealth platform where clinicians run video consultations, write clinical notes, issue e-prescriptions, and patients book appointments and view their records, integrated with hospital EHR systems.',
      context: {
        userScale: 'very-large',
        trafficPattern: 'business-hours',
        budgetBand: 'enterprise',
        timelineWeeks: 52,
        constraints:
          'Must be HIPAA compliant with full audit logging and BAAs. Data residency in the US. SSO via hospital identity providers. High availability required.',
      },
      clarifications: [
        { question: 'Do you need real-time video, or async only?', answer: 'Real-time video is core.' },
        { question: 'Which EHR systems must you integrate with?', answer: 'Epic and Cerner via FHIR.' },
      ],
      additionalNotes: 'Auditability and patient privacy are non-negotiable.',
    },
  },
];

function line(label: string, value: string | number) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main() {
  const model = process.env.VERIFY_MODEL ?? process.env.ANTHROPIC_MODEL;
  const only = process.env.VERIFY_ONLY; // substring match on label, optional
  const briefs = only
    ? BRIEFS.filter((b) => b.label.toLowerCase().includes(only.toLowerCase()))
    : BRIEFS;
  console.log(`\n=== Pipeline verification (${briefs.length} briefs)${model ? ` — model ${model}` : ''} ===\n`);

  for (const { label, brief } of briefs) {
    console.log(`\n──────────────────────────────────────────────────────────`);
    console.log(`▶ ${label}`);
    console.log(`──────────────────────────────────────────────────────────`);
    const started = Date.now();
    try {
      const doc = await runGenerationPipeline(
        brief,
        `prd_verify_${label.replace(/\W+/g, '_').toLowerCase().slice(0, 12)}`,
        new Date().toISOString(),
        model ? { model } : undefined,
      );

      // Self-check against the full schema — should always pass here.
      const ok = prdDocumentSchema.safeParse(doc).success;

      line('title', doc.title);
      line('schema-valid', ok ? 'YES' : 'NO (!!)');
      line('elapsed', `${((Date.now() - started) / 1000).toFixed(1)}s`);
      console.log('');
      line('#user stories', doc.prd.userStories.length);
      line('#func reqs', doc.prd.functionalRequirements.length);
      line('#non-func reqs', doc.prd.nonFunctionalRequirements.length);
      line('#entities', doc.architecture.dataModel.entities.length);
      line('#components', doc.architecture.components.length);
      line('#endpoints', doc.architecture.apiEndpoints.length);
      line('#milestones', doc.plan.milestones.length);
      line('#plan tasks', doc.plan.milestones.flatMap((m) => m.tasks).length);
      line('critical path len', doc.plan.criticalPath.length);
      line('total est. hours', doc.plan.totalEstimateHours);
      line('calendar weeks', doc.plan.estimatedCalendarWeeks);
      console.log('');
      console.log('  ENTITIES:', doc.architecture.dataModel.entities.map((e) => e.name).join(', '));
      console.log('');
      console.log('  INFRASTRUCTURE:');
      line('    hosting', doc.architecture.infrastructure.hosting);
      line('    database', doc.architecture.infrastructure.database);
      line('    cache', String(doc.architecture.infrastructure.cache));
      line('    cicd', doc.architecture.infrastructure.cicd);
      console.log('  INFRA RATIONALE:');
      for (const r of doc.architecture.infrastructure.rationale) console.log(`    - ${r}`);
      console.log('  ASSUMPTIONS (stage 1 decided):');
      for (const a of doc.prd.assumptions.slice(0, 5)) console.log(`    - ${a}`);
    } catch (err) {
      if (err instanceof GenerationError) {
        console.error(`  FAILED: GenerationError[${err.code}] stage=${err.stage} — ${err.message}`);
      } else {
        console.error('  FAILED (unexpected):', err);
      }
      process.exitCode = 1;
    }
  }
  console.log('\n=== done ===\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
