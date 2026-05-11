/**
 * Offline, fully-mocked unit tests for the F3 generate-flow logic.
 *
 * NO real network, NO real localStorage, NO real timers driving generation.
 * Each generation is a real paid call in production — these tests must never
 * hit the endpoint. `fetchGenerate` is exercised with an injected `fetchImpl`.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  mapGenerateError,
  fetchGenerate,
  saveAndRoute,
  documentPath,
  progressStageIndexAt,
  progressStageAt,
  progressFractionAt,
  PROGRESS_STAGES,
  type GenerateOutcome,
} from '@/lib/prd/generate-flow';
import type { ApiErrorCode, PrdDocument, ProjectBrief } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const brief: ProjectBrief = {
  idea: 'A marketplace where local bakeries list same-day surplus bread for pickup at a discount.',
  context: {
    userScale: 'medium',
    trafficPattern: 'business-hours',
    budgetBand: 'startup',
    timelineWeeks: 12,
  },
  clarifications: [],
};

/** A minimal but schema-valid PrdDocument, built to satisfy every floor. */
function makeDocument(id = 'prd_abcdef012345'): PrdDocument {
  const stories = Array.from({ length: 5 }, (_, i) => ({
    id: `US-${i + 1}`,
    asA: 'buyer',
    iWant: 'to browse surplus bread',
    soThat: 'I can grab a deal',
    priority: 'p1' as const,
    acceptanceCriteria: ['I can see listings'],
  }));
  const frs = Array.from({ length: 8 }, (_, i) => ({
    id: `FR-${i + 1}`,
    title: `Requirement ${i + 1}`,
    detail: 'The system does the thing described here in adequate detail.',
    priority: 'p1' as const,
  }));
  const nfrs = Array.from({ length: 5 }, (_, i) => ({
    id: `NFR-${i + 1}`,
    category: 'performance' as const,
    requirement: `Non-functional requirement ${i + 1}`,
    rationale: 'Because it matters for the users at this scale.',
  }));
  const entities = Array.from({ length: 3 }, (_, i) => ({
    name: `Entity${i + 1}`,
    description: 'An entity in the data model.',
    fields: [{ name: 'id', type: 'string' as const, required: true, notes: 'primary key' }],
  }));
  const components = Array.from({ length: 3 }, (_, i) => ({
    name: `Component${i + 1}`,
    kind: 'service' as const,
    responsibility: 'Does a coherent unit of work for the system.',
    technology: 'Next.js',
  }));
  const endpoints = Array.from({ length: 5 }, (_, i) => ({
    method: 'GET' as const,
    path: `/api/thing/${i + 1}`,
    purpose: 'Fetch a thing.',
    authRequired: false,
  }));
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    id: `T-${i + 1}`,
    title: `Task ${i + 1}`,
    description: 'Do a concrete piece of the build.',
    area: 'backend' as const,
    estimateHours: 4,
    dependsOn: [] as string[],
    acceptanceCriteria: ['The task is verifiably complete.'],
  }));
  const milestones = [
    { id: 'M-1', name: 'Foundations', goal: 'Set up the base', tasks: tasks.slice(0, 4) },
    { id: 'M-2', name: 'Core', goal: 'Build core features', tasks: tasks.slice(4, 8) },
    { id: 'M-3', name: 'Polish', goal: 'Finish and ship', tasks: tasks.slice(8, 12) },
  ];

  return {
    id,
    createdAt: '2026-07-25T00:00:00.000Z',
    generatorVersion: '1.0.0',
    model: 'claude-test',
    title: 'Surplus Bread Marketplace',
    brief,
    prd: {
      overview: {
        problem: 'Bakeries waste surplus bread.',
        solution: 'A same-day discount marketplace.',
        targetUsers: 'Local bakeries and bargain-seeking buyers.',
        valueProposition: ['Less waste', 'Cheaper bread'],
      },
      goals: ['Reduce waste', 'Grow supply', 'Delight buyers'],
      nonGoals: ['Delivery in v1'],
      userStories: stories,
      functionalRequirements: frs,
      nonFunctionalRequirements: nfrs,
      successMetrics: ['50 bakeries in 3 months', '10k orders/mo', '<2% waste'],
      risks: [
        { risk: 'Low supply', impact: 'p1', mitigation: 'Recruit bakeries' },
        { risk: 'Low demand', impact: 'p1', mitigation: 'Local marketing' },
        { risk: 'Pickup no-shows', impact: 'p2', mitigation: 'Prepay to hold' },
      ],
      openQuestions: ['Which cities first?'],
      assumptions: ['Pickup-only for v1; no delivery logistics were specified.'],
    },
    architecture: {
      summary: 'A Next.js app with a Postgres data store.',
      pattern: 'Monolith with API routes',
      components,
      dataModel: {
        entities,
        relationships: [{ from: 'Entity1', to: 'Entity2', kind: 'one-to-many' }],
      },
      apiEndpoints: endpoints,
      infrastructure: {
        hosting: 'Vercel',
        database: 'Supabase Postgres',
        cache: 'None',
        storage: 'Supabase Storage',
        cicd: 'GitHub Actions',
        environments: ['preview', 'production'],
        rationale: ['Fits the startup budget band.'],
      },
      diagramMermaid: 'graph TD;A-->B;',
    },
    plan: {
      milestones,
      criticalPath: ['T-1', 'T-5', 'T-9'],
      totalEstimateHours: 48,
      estimatedCalendarWeeks: 2,
    },
  };
}

/** Build a mock `fetch` returning the given status + JSON body. */
function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

/* -------------------------------------------------------------------------- */
/* mapGenerateError — the F3 error table                                      */
/* -------------------------------------------------------------------------- */

describe('mapGenerateError', () => {
  it('llm_unavailable → retryable, stays on page', () => {
    const p = mapGenerateError('llm_unavailable');
    expect(p.retryable).toBe(true);
    expect(p.backToForm).toBe(false);
    expect(p.message).toMatch(/busy/i);
  });

  it('llm_not_configured → NOT retryable, not the user\'s fault, no back-to-form', () => {
    const p = mapGenerateError('llm_not_configured');
    expect(p.retryable).toBe(false);
    expect(p.backToForm).toBe(false);
    expect(p.message).toMatch(/configured/i);
  });

  it('generation_failed → retryable, stays on page', () => {
    const p = mapGenerateError('generation_failed');
    expect(p.retryable).toBe(true);
    expect(p.backToForm).toBe(false);
    expect(p.message).toMatch(/usable document/i);
  });

  it('validation_error → NOT retryable, sends back to the form', () => {
    const p = mapGenerateError('validation_error');
    expect(p.retryable).toBe(false);
    expect(p.backToForm).toBe(true);
  });

  it('network → retryable, stays on page', () => {
    const p = mapGenerateError('network');
    expect(p.retryable).toBe(true);
    expect(p.backToForm).toBe(false);
  });

  it('every contract code maps to a DISTINCT message', () => {
    const codes: (ApiErrorCode | 'network')[] = [
      'validation_error',
      'not_found',
      'generation_failed',
      'bad_request',
      'internal_error',
      'llm_unavailable',
      'llm_not_configured',
      'network',
    ];
    const messages = codes.map((c) => mapGenerateError(c).message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('no message leaks internal jargon that a user would not understand', () => {
    // Sanity: messages should not echo raw codes or stack-ish text.
    for (const c of ['llm_unavailable', 'generation_failed', 'llm_not_configured'] as const) {
      expect(mapGenerateError(c).message).not.toMatch(/undefined|null|\bError:/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* fetchGenerate                                                              */
/* -------------------------------------------------------------------------- */

describe('fetchGenerate', () => {
  it('200 with a valid { document } → ok', async () => {
    const doc = makeDocument();
    // Guard: the fixture must actually satisfy the contract, else this test is
    // vacuous. Surfaces the exact schema issue if the fixture drifts.
    const check = (await import('@/types/prd')).prdDocumentSchema.safeParse(doc);
    if (!check.success) {
      throw new Error(
        'fixture invalid: ' +
          check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | '),
      );
    }
    const fetchImpl = mockFetch(200, { document: doc });
    const out = await fetchGenerate(brief, { fetchImpl });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.document.id).toBe(doc.id);
  });

  it('POSTs { brief } as JSON to the generate endpoint', async () => {
    const fetchImpl = mockFetch(200, { document: makeDocument() });
    await fetchGenerate(brief, { fetchImpl });
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toBe('/api/prd/generate');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ brief });
  });

  it('does NOT impose an AbortSignal of its own (only forwards the caller\'s)', async () => {
    const fetchImpl = mockFetch(200, { document: makeDocument() });
    await fetchGenerate(brief, { fetchImpl });
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as RequestInit;
    expect(init.signal).toBeUndefined();
  });

  it('forwards the caller\'s AbortSignal', async () => {
    const controller = new AbortController();
    const fetchImpl = mockFetch(200, { document: makeDocument() });
    await fetchGenerate(brief, { fetchImpl, signal: controller.signal });
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it('503 with llm_unavailable envelope → error, retryable', async () => {
    const fetchImpl = mockFetch(503, {
      error: { code: 'llm_unavailable', message: 'busy' },
    });
    const out = await fetchGenerate(brief, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.presentation.code).toBe('llm_unavailable');
      expect(out.presentation.retryable).toBe(true);
    }
  });

  it('500 with llm_not_configured envelope → error, NOT retryable', async () => {
    const fetchImpl = mockFetch(500, {
      error: { code: 'llm_not_configured', message: 'no key' },
    });
    const out = await fetchGenerate(brief, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.presentation.code).toBe('llm_not_configured');
      expect(out.presentation.retryable).toBe(false);
    }
  });

  it('400 validation_error → error, backToForm, surfaces issues[]', async () => {
    const issues = [{ path: 'brief.idea', message: 'Too small' }];
    const fetchImpl = mockFetch(400, {
      error: { code: 'validation_error', message: 'bad', issues },
    });
    const out = await fetchGenerate(brief, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.presentation.backToForm).toBe(true);
      expect(out.issues).toEqual(issues);
    }
  });

  it('non-2xx with a MISSING/off-contract body → infers code from HTTP status', async () => {
    const fetchImpl = mockFetch(503, { not: 'an envelope' });
    const out = await fetchGenerate(brief, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.presentation.code).toBe('llm_unavailable');
  });

  it('200 with an off-contract body → generation_failed (retryable)', async () => {
    const fetchImpl = mockFetch(200, { document: { id: 'nope' } });
    const out = await fetchGenerate(brief, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.presentation.code).toBe('generation_failed');
      expect(out.presentation.retryable).toBe(true);
    }
  });

  it('transport failure (fetch throws non-abort) → network error, retryable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const out = await fetchGenerate(brief, { fetchImpl });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.presentation.code).toBe('network');
      expect(out.presentation.retryable).toBe(true);
    }
  });

  it('abort → REJECTS (caller distinguishes cancel from failure)', async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new DOMException('aborted', 'AbortError');
      throw e;
    }) as unknown as typeof fetch;
    await expect(fetchGenerate(brief, { fetchImpl })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does NOT touch storage on any path (brief is never lost by this call)', async () => {
    // fetchGenerate has no storage dependency at all — this documents that the
    // save step lives entirely in saveAndRoute, so a failed generate cannot
    // clear a draft. Exercising an error path proves the outcome carries no
    // side-effect hook.
    const fetchImpl = mockFetch(503, { error: { code: 'llm_unavailable', message: 'x' } });
    const out: GenerateOutcome = await fetchGenerate(brief, { fetchImpl });
    expect(out).not.toHaveProperty('document');
  });
});

/* -------------------------------------------------------------------------- */
/* saveAndRoute — the success sequence                                        */
/* -------------------------------------------------------------------------- */

describe('saveAndRoute', () => {
  it('saves, clears the draft, then navigates — in that exact order', () => {
    const order: string[] = [];
    const doc = makeDocument('prd_zzz111222333');
    const path = saveAndRoute(doc, {
      save: () => order.push('save'),
      clearDraft: () => order.push('clear'),
      navigate: () => order.push('navigate'),
    });
    expect(order).toEqual(['save', 'clear', 'navigate']);
    expect(path).toBe('/prd/prd_zzz111222333');
  });

  it('saves the exact document and navigates to its id', () => {
    const doc = makeDocument('prd_route12345a');
    const save = vi.fn();
    const navigate = vi.fn();
    saveAndRoute(doc, { save, clearDraft: vi.fn(), navigate });
    expect(save).toHaveBeenCalledWith(doc);
    expect(navigate).toHaveBeenCalledWith('/prd/prd_route12345a');
  });

  it('documentPath builds the /prd/:id route', () => {
    expect(documentPath('prd_abc')).toBe('/prd/prd_abc');
  });
});

/* -------------------------------------------------------------------------- */
/* Progress heuristic                                                         */
/* -------------------------------------------------------------------------- */

describe('progress heuristic', () => {
  it('has the three real pipeline stages plus a finalizing stage, in time order', () => {
    expect(PROGRESS_STAGES).toHaveLength(4);
    for (let i = 1; i < PROGRESS_STAGES.length; i += 1) {
      expect(PROGRESS_STAGES[i].atMs).toBeGreaterThan(PROGRESS_STAGES[i - 1].atMs);
    }
    expect(PROGRESS_STAGES[0].label).toMatch(/requirements/i);
    expect(PROGRESS_STAGES[1].label).toMatch(/architecture/i);
    expect(PROGRESS_STAGES[2].label).toMatch(/plan/i);
  });

  it('progressStageIndexAt advances through the stages over elapsed time', () => {
    expect(progressStageIndexAt(0)).toBe(0);
    expect(progressStageIndexAt(14_999)).toBe(0);
    expect(progressStageIndexAt(15_000)).toBe(1);
    expect(progressStageIndexAt(30_000)).toBe(2);
    expect(progressStageIndexAt(42_000)).toBe(3);
    expect(progressStageIndexAt(999_999)).toBe(3); // clamps at the last stage
  });

  it('progressStageAt returns the matching stage object', () => {
    expect(progressStageAt(0).label).toBe(PROGRESS_STAGES[0].label);
    expect(progressStageAt(60_000).label).toBe(PROGRESS_STAGES[3].label);
  });

  it('progressFractionAt is monotincreasing and NEVER reaches 1 on a timer', () => {
    const t = [0, 5_000, 15_000, 30_000, 45_000, 120_000, 600_000];
    const fracs = t.map((ms) => progressFractionAt(ms));
    for (let i = 1; i < fracs.length; i += 1) {
      expect(fracs[i]).toBeGreaterThanOrEqual(fracs[i - 1]);
    }
    expect(Math.max(...fracs)).toBeLessThanOrEqual(0.95);
    expect(Math.min(...fracs)).toBeGreaterThanOrEqual(0.02);
  });
});
