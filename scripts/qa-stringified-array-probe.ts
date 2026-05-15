/**
 * QA probe: the "stringified array" failure class (reviewer-owned, ZERO API calls).
 *
 * Observed LIVE twice on real generations:
 *   - reviewer run 2026-07-26: plan stage returned `milestones` as a STRING
 *     → `Stage "plan" output failed schema validation: milestones: Invalid
 *       input: expected array, received string` → 500, whole document discarded.
 *   - F3 worker (t_70201242): prd stage returned `functionalRequirements` as a
 *     string → same hard failure.
 *
 * This probe proves the mechanism deterministically: a stringified array is
 * classified as STRUCTURAL by `isPurelyUnderVolume`, so `runStage` throws
 * immediately with NO retry — even though the content is present and parseable.
 *
 * Run: npx tsx scripts/qa-stringified-array-probe.ts
 */

let fails = 0;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) fails++;
};

const FAKE_KEY = 'sk-ant-FAKE-probe';

/** A COMPLETE, high-quality plan — but `milestones` arrives JSON-stringified. */
function buildMilestones() {
  const task = (id: string, h: number, deps: string[] = []) => ({
    id,
    title: `Task ${id}`,
    description: 'A real, buildable task.',
    area: 'backend',
    estimateHours: h,
    dependsOn: deps,
    acceptanceCriteria: ['Reviewer can check this off.'],
  });
  const all = Array.from({ length: 15 }, (_, i) => task(`T-${i + 1}`, 6, i === 0 ? [] : [`T-${i}`]));
  return [
    { id: 'M1', name: 'Foundations', goal: 'Scaffold', tasks: all.slice(0, 5) },
    { id: 'M2', name: 'Core', goal: 'Build', tasks: all.slice(5, 10) },
    { id: 'M3', name: 'Launch', goal: 'Ship', tasks: all.slice(10, 15) },
  ];
}

let upstreamCalls = 0;
let mode: 'stringified' | 'good' = 'stringified';

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (!url.includes('api.anthropic.com')) return originalFetch(input as never, init);
  upstreamCalls++;

  const milestones = buildMilestones();
  const payload =
    mode === 'stringified'
      ? { milestones: JSON.stringify(milestones) } // ← the observed real-world shape
      : { milestones };

  return new Response(
    JSON.stringify({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 100 },
      content: [{ type: 'tool_use', name: 'emit_plan', input: payload }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as typeof fetch;

async function main() {
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;

  const { generatePlanSection } = await import('../src/lib/prd/llm/stages/plan');
  const { isPurelyUnderVolume } = await import('../src/lib/prd/llm/shared');
  const { planDraftSchema } = await import('../src/types/prd');

  const brief = {
    idea: 'A marketplace where scuba instructors list open boat-trip seats and divers book them.',
    context: {
      userScale: 'large' as const,
      trafficPattern: 'seasonal' as const,
      budgetBand: 'growth' as const,
      timelineWeeks: 20,
    },
    clarifications: [],
  };
  // Use a REAL generated prd + architecture (from the live crud run) so the
  // stage's prompt-building code path is exercised exactly as in production.
  const { readFileSync } = await import('node:fs');
  const real = JSON.parse(readFileSync('/tmp/qa-gen/crud.json', 'utf8'));
  const ctx = {
    brief,
    model: 'claude-sonnet-5',
    prd: real.prd,
    architecture: real.architecture,
  };

  console.log('=== 1. The stringified-array output is classified STRUCTURAL (so: no retry) ===');
  const stringified = { milestones: JSON.stringify(buildMilestones()) };
  const parsed = planDraftSchema.safeParse(stringified);
  check('stringified milestones fails the schema', !parsed.success, parsed.success ? 'PARSED?!' : parsed.error.issues[0].message);
  if (!parsed.success) {
    check(
      'isPurelyUnderVolume() says NOT retryable → runStage throws immediately',
      isPurelyUnderVolume(parsed.error) === false,
      `isPurelyUnderVolume=${isPurelyUnderVolume(parsed.error)} (issue code: ${parsed.error.issues[0].code})`,
    );
  }

  console.log('\n=== 2. …and the content is fully recoverable, which is the point ===');
  const recovered = planDraftSchema.safeParse({ milestones: JSON.parse(stringified.milestones) });
  check(
    'JSON.parse()-ing the string yields a VALID plan (15 tasks, 3 milestones)',
    recovered.success,
    recovered.success ? `${recovered.data.milestones.flatMap((m) => m.tasks).length} tasks` : 'no',
  );

  console.log('\n=== 3. End to end: the stage now RECOVERS the stringified array in one call, no retry ===');
  // FIXED (MAJOR-1): runStage coerces a JSON-stringified container field via a
  // single JSON.parse() and re-validates — salvaging the already-paid-for
  // generation instead of discarding it. This is NOT a retry: still exactly one
  // upstream call. Before the fix this branch threw invalid_output; the probe's
  // expectation is updated to the corrected behaviour (not deleted).
  mode = 'stringified';
  upstreamCalls = 0;
  let err: unknown;
  let recoveredMs: unknown;
  try {
    recoveredMs = await generatePlanSection(ctx);
  } catch (e) {
    err = e;
  }
  check('generatePlanSection no longer throws (stringified array recovered)', err === undefined, err ? (err as Error)?.message?.slice(0, 120) : 'ok');
  check(
    'recovered plan is a valid 3-milestone / 15-task array',
    Array.isArray(recoveredMs) &&
      (recoveredMs as unknown[]).length === 3 &&
      (recoveredMs as { tasks: unknown[] }[]).flatMap((m) => m.tasks).length === 15,
    Array.isArray(recoveredMs)
      ? `${(recoveredMs as unknown[]).length} milestones, ${(recoveredMs as { tasks: unknown[] }[]).flatMap((m) => m.tasks).length} tasks`
      : 'not an array',
  );
  check(
    'STILL exactly 1 upstream call (coercion is not a retry)',
    upstreamCalls === 1,
    `${upstreamCalls} upstream call(s) — a mechanical retry would have been 2`,
  );
  void err; // referenced above; keep for clarity
  console.log(
    '\n  → In production this now completes instead of discarding ~$0.42 / 242s of\n' +
      '    already-billed generation. The model\'s content was correct; only its\n' +
      '    envelope (a stringified array) was wrong, and JSON.parse() fixes that.',
  );

  console.log('\n=== 4. Control: a well-shaped response succeeds on the first call ===');
  mode = 'good';
  upstreamCalls = 0;
  const ms = await generatePlanSection(ctx);
  check('good response returns milestones', Array.isArray(ms) && ms.length === 3, `${ms.length} milestones`);
  check('one upstream call', upstreamCalls === 1, String(upstreamCalls));

  console.log(`\n${fails === 0 ? 'PROBE COMPLETE — failure mode reproduced deterministically' : `${fails} CHECK(S) FAILED`}`);
  process.exit(fails === 0 ? 0 : 1);
}

void main();

export {};
