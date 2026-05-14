/**
 * QA contract probe (reviewer-owned). Calls the REAL route handlers over the
 * REAL pipeline, with only `globalThis.fetch` stubbed to impersonate Anthropic.
 *
 * This is stronger than module-mocking the seam: it exercises client.ts's actual
 * error taxonomy (401→not_configured, 429/5xx→unavailable, bad tool_use →
 * invalid_output) and proves the route's mapping + leak-suppression on the real
 * path. ZERO real API calls — every fetch is intercepted.
 *
 * Run: npx tsx scripts/qa-contract-probe.ts
 */

let fails = 0;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) fails++;
};

const FAKE_KEY = 'sk-ant-FAKEKEY-do-not-use-1234567890';

/** Strings that upstream would send. If any reaches a response body: leak. */
const UPSTREAM_SECRETS = [
  FAKE_KEY,
  'req_01ABCDEF',
  'org_9999',
  'x-api-key',
  'organization id 4242',
];

const UPSTREAM_ERROR_BODY = JSON.stringify({
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message: `Rate limited. request_id=req_01ABCDEF org=org_9999 organization id 4242 (x-api-key sk-ant-FAKEKEY-do-not-use-1234567890)`,
  },
});

let fetchMode = 'ok-429';
let realFetchCalls = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (!url.includes('api.anthropic.com')) {
    return originalFetch(input as never, init);
  }
  realFetchCalls++;
  switch (fetchMode) {
    case '429':
      return new Response(UPSTREAM_ERROR_BODY, { status: 429, headers: { 'retry-after': '0' } });
    case '500':
      return new Response(UPSTREAM_ERROR_BODY, { status: 500 });
    case '401':
      return new Response(UPSTREAM_ERROR_BODY, { status: 401 });
    case 'network':
      throw new TypeError('fetch failed: ECONNREFUSED 1.2.3.4:443 (x-api-key sk-ant-FAKEKEY-do-not-use-1234567890)');
    case 'no-tool-use':
      return new Response(
        JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'here is your PRD in prose' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    case 'thin-prd':
      // A syntactically-valid tool_use whose PRD is UNDER the volume floors.
      // This is the old Major's exact shape: the model returns a thin section.
      return new Response(
        JSON.stringify({
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [
            {
              type: 'tool_use',
              name: 'emit_prd',
              input: {
                overview: { problem: 'p', solution: 's', targetUsers: 't', valueProposition: ['v'] },
                goals: ['g1'],
                nonGoals: ['n'],
                userStories: [],
                functionalRequirements: [],
                nonFunctionalRequirements: [],
                successMetrics: ['m'],
                risks: [],
                openQuestions: [],
                assumptions: [],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    case 'max-tokens':
      return new Response(
        JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', name: 'emit_prd', input: {} }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    case 'clarify-over-cap':
      return new Response(
        JSON.stringify({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              name: 'emit_clarifying_questions',
              input: {
                questions: Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, question: 'q?', why: 'w', suggestions: [] })),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    case 'clarify-empty':
      return new Response(
        JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'emit_clarifying_questions', input: { questions: [] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    default:
      throw new Error(`unknown fetchMode ${fetchMode}`);
  }
}) as typeof fetch;

async function main() {
  const { POST: generatePOST } = await import('../src/app/api/prd/generate/route');
  const { POST: clarifyPOST } = await import('../src/app/api/prd/clarify/route');

  const post = (handler: typeof generatePOST, body: unknown, raw?: string) =>
    handler(
      new Request('http://localhost/api/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw ?? JSON.stringify(body),
      }),
    );

  const validBrief = {
    idea: 'A marketplace where local bakeries list same-day surplus bread for pickup by neighbours.',
    context: {
      userScale: 'medium' as const,
      trafficPattern: 'business-hours' as const,
      budgetBand: 'startup' as const,
      timelineWeeks: 12,
    },
    clarifications: [],
  };
  const clarifyBody = { idea: validBrief.idea, context: validBrief.context };

  const leakCheck = (label: string, text: string) => {
    const leaked = UPSTREAM_SECRETS.filter((s) => text.includes(s));
    check(`no upstream/secret leak in ${label}`, leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(' | ')}` : `clean (body: ${text.slice(0, 90)})`);
  };

  const run = async (
    label: string,
    handler: typeof generatePOST,
    body: unknown,
    mode: string,
    key: string | undefined,
    expectStatus: number,
    expectCode: string,
  ) => {
    fetchMode = mode;
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
    const res = await post(handler, body);
    const text = await res.text();
    let parsed: { error?: { code?: string; issues?: unknown[] } } = {};
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
    check(
      `${label} → ${expectStatus} ${expectCode}`,
      res.status === expectStatus && parsed.error?.code === expectCode,
      `got ${res.status} ${parsed.error?.code ?? '(no code)'}`,
    );
    leakCheck(label, text);
    return { res, text, parsed };
  };

  console.log('=== POST /api/prd/generate — every contract code, real pipeline ===');

  // Body-level failures (no pipeline involvement).
  {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const res = await post(generatePOST, null, 'not json{{{');
    const b = await res.json();
    check('malformed JSON → 400 bad_request', res.status === 400 && b.error?.code === 'bad_request', `${res.status} ${b.error?.code}`);
  }
  {
    const res = await post(generatePOST, { brief: { idea: 'too short', context: {} } });
    const b = await res.json();
    check(
      'invalid brief → 400 validation_error + issues[]',
      res.status === 400 && b.error?.code === 'validation_error' && Array.isArray(b.error?.issues) && b.error.issues.length > 0,
      `${res.status} ${b.error?.code} issues=${b.error?.issues?.length}`,
    );
    check(
      'issues[] entries are {path,message} strings',
      b.error.issues.every((i: { path: unknown; message: unknown }) => typeof i.path === 'string' && typeof i.message === 'string'),
      JSON.stringify(b.error.issues.slice(0, 2)),
    );
  }

  // Pipeline failures, through the real client.
  await run('missing API key', generatePOST, { brief: validBrief }, '429', undefined, 500, 'llm_not_configured');
  await run('upstream 401', generatePOST, { brief: validBrief }, '401', FAKE_KEY, 500, 'llm_not_configured');
  await run('upstream 429 (after retries)', generatePOST, { brief: validBrief }, '429', FAKE_KEY, 503, 'llm_unavailable');
  await run('upstream 500 (after retries)', generatePOST, { brief: validBrief }, '500', FAKE_KEY, 503, 'llm_unavailable');
  await run('network failure', generatePOST, { brief: validBrief }, 'network', FAKE_KEY, 503, 'llm_unavailable');
  await run('no tool_use block (prose response)', generatePOST, { brief: validBrief }, 'no-tool-use', FAKE_KEY, 500, 'generation_failed');
  await run('stop_reason=max_tokens (truncated)', generatePOST, { brief: validBrief }, 'max-tokens', FAKE_KEY, 500, 'generation_failed');

  // THE MAJOR-1 REGRESSION, end to end: a thin PRD section from the model must
  // fail — extend-retry gets the same thin output, then it is rejected.
  {
    realFetchCalls = 0;
    const { res, parsed } = await run(
      'UNDER-VOLUME model output (thin PRD, the old Major)',
      generatePOST,
      { brief: validBrief },
      'thin-prd',
      FAKE_KEY,
      500,
      'generation_failed',
    );
    check('no document returned on under-volume', parsed.error !== undefined && !('document' in (parsed as object)), JSON.stringify(parsed).slice(0, 80));
    void res;
    check(
      'under-volume issued EXACTLY ONE extend-retry (2 upstream calls, no loop)',
      realFetchCalls === 2,
      `${realFetchCalls} upstream calls`,
    );
  }

  console.log('\n=== POST /api/prd/clarify — every contract code, real pipeline ===');
  {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const res = await post(clarifyPOST, null, '}{');
    const b = await res.json();
    check('malformed JSON → 400 bad_request', res.status === 400 && b.error?.code === 'bad_request', `${res.status} ${b.error?.code}`);
  }
  {
    const res = await post(clarifyPOST, { idea: 'short', context: {} });
    const b = await res.json();
    check('invalid body → 400 validation_error', res.status === 400 && b.error?.code === 'validation_error', `${res.status} ${b.error?.code}`);
  }
  await run('missing API key', clarifyPOST, clarifyBody, '429', undefined, 500, 'llm_not_configured');
  await run('upstream 401', clarifyPOST, clarifyBody, '401', FAKE_KEY, 500, 'llm_not_configured');
  await run('upstream 429', clarifyPOST, clarifyBody, '429', FAKE_KEY, 503, 'llm_unavailable');
  await run('over-cap questions (6 > 3)', clarifyPOST, clarifyBody, 'clarify-over-cap', FAKE_KEY, 500, 'generation_failed');
  {
    fetchMode = 'clarify-empty';
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const res = await post(clarifyPOST, clarifyBody);
    const b = await res.json();
    check(
      'empty questions[] → 200 with { questions: [] } (never 204/error)',
      res.status === 200 && Array.isArray(b.questions) && b.questions.length === 0,
      `${res.status} ${JSON.stringify(b)}`,
    );
  }

  /* ---- retry-storm / cost audit ------------------------------------------- */
  console.log('\n=== COST: upstream call counts (retry storm check) ===');
  const countCalls = async (mode: string, label: string, expectMax: number) => {
    fetchMode = mode;
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    realFetchCalls = 0;
    await post(generatePOST, { brief: validBrief });
    check(`${label}: ${realFetchCalls} upstream call(s) ≤ ${expectMax}`, realFetchCalls <= expectMax, `${realFetchCalls}`);
    return realFetchCalls;
  };
  await countCalls('429', 'persistent 429 (1 try + 2 backoff retries)', 3);
  await countCalls('no-tool-use', 'no tool_use (terminal, NOT retried)', 1);
  await countCalls('max-tokens', 'max_tokens (terminal, NOT retried)', 1);
  await countCalls('thin-prd', 'under-volume (1 + exactly 1 extend-retry)', 2);

  console.log(`\n${fails === 0 ? 'ALL CONTRACT PROBES PASSED' : `${fails} CONTRACT PROBE(S) FAILED`}`);
  process.exit(fails === 0 ? 0 : 1);
}

void main();

export {};
