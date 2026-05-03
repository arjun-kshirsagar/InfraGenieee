/**
 * MANUAL SMOKE TEST — not part of the automated suite. Makes exactly TWO real
 * Anthropic calls to prove the adaptive clarifier stage works end-to-end against
 * the live API and, critically, that it exercises RESTRAINT:
 *   1. a VAGUE brief   → expect 1–3 genuinely useful, branching questions
 *   2. a DETAILED brief → expect 0–1 questions
 *
 * The check that matters most: NO question may ask the user to enumerate
 * entities / fields / tables / columns / endpoints — that is a direct
 * regression to the deleted questionnaire.
 *
 * Cost safety: hits our paid Anthropic key. Exactly TWO calls — do NOT loop or
 * sweep. The unit suites (clarify.test.ts, route.test.ts) are fully mocked and
 * free; use those for iteration.
 *
 * Usage (loads .env.local automatically):
 *   npx tsx --env-file=.env.local scripts/smoke-clarify.ts
 */

import { runClarifyStage } from '../src/lib/prd/llm/stages/clarify';
import { GenerationError } from '../src/lib/prd/generation';
import type { BriefContext } from '../src/types/prd';

/**
 * Patterns that flag a regression to the deleted questionnaire: asking the user
 * to ENUMERATE / LIST structure. We match an enumeration verb near a structure
 * noun rather than a bare substring, so legitimate uses ("business entity",
 * "multi-tenant") don't false-positive — only "what fields...", "list the
 * entities...", "which columns..." style questions trip it.
 */
const REGRESSION_PATTERNS: RegExp[] = [
  /\bwhat\b.{0,40}\b(fields?|columns?|attributes?|tables?|entit\w*|endpoints?|data types?)\b/i,
  /\b(list|enumerate|specify|define|name)\b.{0,40}\b(fields?|columns?|attributes?|tables?|entit\w*|endpoints?)\b/i,
  /\b(which|what)\b.{0,40}\b(fields?|columns?|attributes?)\b.{0,20}\b(need|require|have)\b/i,
];

function flagRegressions(questions: { question: string }[]): string[] {
  const flags: string[] = [];
  for (const q of questions) {
    for (const pattern of REGRESSION_PATTERNS) {
      if (pattern.test(q.question)) {
        flags.push(`  ⚠️  "${q.question}" reads like an enumeration request (${pattern})`);
        break;
      }
    }
  }
  return flags;
}

async function runOne(
  label: string,
  idea: string,
  context: BriefContext,
): Promise<string[]> {
  console.log(`\n=== ${label} ===`);
  console.log(`idea: ${idea}`);
  const questions = await runClarifyStage(idea, context);
  console.log(`→ ${questions.length} question(s):`);
  for (const q of questions) {
    console.log(`  • ${q.question}`);
    console.log(`      why: ${q.why}`);
    if (q.suggestions.length > 0) {
      console.log(`      suggestions: ${q.suggestions.join(' | ')}`);
    }
  }
  return flagRegressions(questions);
}

async function main() {
  const flags: string[] = [];

  // 1. VAGUE brief — the idea is genuinely silent on things that branch the
  //    design (who manages content, the core interaction model).
  flags.push(
    ...(await runOne(
      'VAGUE brief (expect 1–3 branching questions)',
      'An app for organizing community events.',
      {
        userScale: 'small',
        trafficPattern: 'business-hours',
        budgetBand: 'hobby',
        timelineWeeks: 8,
      },
    )),
  );

  // 2. DETAILED brief — the idea already answers the branching questions, so
  //    the clarifier should ask 0–1 and assume the rest.
  flags.push(
    ...(await runOne(
      'DETAILED brief (expect 0–1 questions)',
      'A B2B SaaS where verified restaurant owners self-serve manage their own ' +
        'menu listings and pricing; diners browse public menus and place pickup ' +
        'orders paid via Stripe. Owners see an analytics dashboard of orders. ' +
        'No delivery in v1. Owners authenticate via email magic-link; diners ' +
        'check out as guests.',
      {
        userScale: 'medium',
        trafficPattern: 'business-hours',
        budgetBand: 'startup',
        timelineWeeks: 12,
        constraints: 'Must be GDPR compliant; hosted in the EU.',
      },
    )),
  );

  console.log('\n=== VERDICT ===');
  if (flags.length > 0) {
    console.log('REGRESSION: a question asked the user to enumerate structure:');
    console.log(flags.join('\n'));
    process.exit(2);
  }
  console.log('✓ No question asked the user to enumerate entities/fields/endpoints.');
}

main().catch((err) => {
  if (err instanceof GenerationError) {
    console.error(`[smoke] GenerationError(${err.code}, stage=${err.stage}): ${err.message}`);
  } else {
    console.error('[smoke] unexpected error:', err);
  }
  process.exit(1);
});
