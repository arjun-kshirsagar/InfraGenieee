/**
 * Unit tests for the AI recommendation stage (`recommendDeployment`, task B9).
 *
 * OFFLINE and FREE: `callStructured` is fully mocked, so no real Anthropic call
 * is made and the suite bills nothing. The LIVE smoke test lives in
 * `recommend.live.test.ts` and is skipped unless `ANTHROPIC_API_KEY` is set.
 *
 * These tests prove the "don't trust, verify" contract:
 *   - 🔴 a model-invented `skuId` is DROPPED and the role falls back to the
 *     catalog default (output stays schema-valid and usable);
 *   - 🔴 a `serviceId` that exists but fills the WRONG role is rejected;
 *   - a PRD-required role the model omitted is filled with the catalog default;
 *   - a role the PRD does NOT need is dropped even when the model volunteers it;
 *   - `usageProfile` equals `deriveUsageProfile` (TS owns the arithmetic — the
 *     draft schema has no channel for the model to supply sizing);
 *   - every selection parses `costSelectionSchema` (no cross-provider leakage,
 *     no duplicate roles).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationError } from '@/lib/prd/generation';

// Mock the client before importing the stage so it picks up the mock.
vi.mock('@/lib/prd/llm/client', () => ({
  callStructured: vi.fn(),
}));

import { callStructured } from '@/lib/prd/llm/client';
import { recommendDeployment, _internal } from '@/lib/cost/llm/recommend';
import { serviceCatalog } from '@/lib/cost/catalog';
import { deriveUsageProfile, mapComponentsToRoles } from '@/lib/cost/estimate/derive';
import {
  costSelectionSchema,
  costRecommendationSchema,
  type CostContext,
  type CostRecommendationDraft,
} from '@/types/cost';

const mockCall = vi.mocked(callStructured);

/**
 * A realistic PRD context. Its components map (via `mapComponentsToRoles`) to:
 *   - client (Next.js)  → static-hosting + compute-web
 *   - service (Node API)→ compute-web (deduped)
 *   - datastore (Postgres) → db-relational
 *   - egress is ALWAYS added
 * so the required roles are: compute-web, static-hosting, db-relational, egress.
 * Notably it does NOT need a cache — used to prove volunteered extra roles drop.
 */
const context: CostContext = {
  title: 'Bakery surplus marketplace',
  context: {
    userScale: 'medium',
    trafficPattern: 'business-hours',
    budgetBand: 'startup',
    timelineWeeks: 12,
  },
  components: [
    { name: 'Web app', kind: 'client', responsibility: 'Customer UI', technology: 'Next.js' },
    { name: 'API', kind: 'service', responsibility: 'Business logic', technology: 'Node.js' },
    { name: 'Primary DB', kind: 'datastore', responsibility: 'Orders', technology: 'PostgreSQL' },
  ],
  summary: 'Marketplace for same-day surplus bread.',
};

const requiredRoles = mapComponentsToRoles(context).roles;

/** A minimal valid draft the model might return — one AWS selection. */
function awsDraft(overrides: Partial<CostRecommendationDraft> = {}): CostRecommendationDraft {
  return {
    recommendedProvider: 'aws',
    rationale:
      'At medium scale on a startup budget with business-hours traffic, AWS offers the broadest managed catalog and predictable RDS pricing for the relational store.',
    assumptions: ['No cache component was specified, so no cache is priced.'],
    selections: [
      {
        provider: 'aws',
        choices: [
          {
            role: 'compute-web',
            serviceId: 'aws:ec2',
            skuId: 'aws:ec2:t3-medium',
            units: 1,
            enabled: true,
          },
          {
            role: 'db-relational',
            serviceId: 'aws:rds-postgres',
            skuId: 'aws:rds-postgres:t4g-medium',
            units: 1,
            enabled: true,
          },
        ],
      },
    ],
    tradeoffs: [{ provider: 'aws', pros: ['Broadest managed catalog'], cons: ['Steeper learning curve'] }],
    ...overrides,
  };
}

beforeEach(() => mockCall.mockReset());
afterEach(() => vi.restoreAllMocks());

/** Find the AWS selection in a recommendation. */
function aws(rec: Awaited<ReturnType<typeof recommendDeployment>>) {
  const sel = rec.selections.find((s) => s.provider === 'aws');
  if (!sel) throw new Error('no aws selection');
  return sel;
}

describe('recommendDeployment — the verify contract', () => {
  it('makes exactly ONE callStructured call and forwards model + signal', async () => {
    mockCall.mockResolvedValue(awsDraft());
    const signal = new AbortController().signal;

    await recommendDeployment(context, serviceCatalog, { model: 'test-model', signal });

    expect(mockCall).toHaveBeenCalledTimes(1);
    const opts = mockCall.mock.calls[0][0];
    expect(opts.model).toBe('test-model');
    expect(opts.signal).toBe(signal);
    // The draft schema is forced — the model cannot supply usageProfile.
    expect(opts.schema).toBeDefined();
  });

  it('🔴 usageProfile equals deriveUsageProfile — TypeScript owns the arithmetic', async () => {
    mockCall.mockResolvedValue(awsDraft());

    const rec = await recommendDeployment(context, serviceCatalog);
    expect(rec.usageProfile).toEqual(deriveUsageProfile(context));
  });

  it('🔴 drops a model-invented skuId and falls back to the catalog default', async () => {
    mockCall.mockResolvedValue(
      awsDraft({
        selections: [
          {
            provider: 'aws',
            choices: [
              {
                role: 'db-relational',
                serviceId: 'aws:rds-postgres',
                skuId: 'aws:rds-postgres:xxlarge', // invented — no such SKU
                units: 1,
                enabled: true,
              },
            ],
          },
        ],
      }),
    );

    const rec = await recommendDeployment(context, serviceCatalog);
    const db = aws(rec).choices.find((c) => c.role === 'db-relational');
    expect(db).toBeDefined();
    // Fell back to the catalog default SKU (the service's first SKU).
    expect(db!.serviceId).toBe('aws:rds-postgres');
    expect(db!.skuId).toBe('aws:rds-postgres:t4g-micro');
    // Still schema-valid and usable.
    expect(costSelectionSchema.safeParse(aws(rec)).success).toBe(true);
    expect(costRecommendationSchema.safeParse(rec).success).toBe(true);
  });

  it('🔴 rejects a serviceId that exists but fills the WRONG role', async () => {
    mockCall.mockResolvedValue(
      awsDraft({
        selections: [
          {
            provider: 'aws',
            choices: [
              {
                role: 'db-relational',
                serviceId: 'aws:s3', // real service, but it's object-storage
                skuId: 'aws:s3:standard',
                units: 1,
                enabled: true,
              },
            ],
          },
        ],
      }),
    );

    const rec = await recommendDeployment(context, serviceCatalog);
    const db = aws(rec).choices.find((c) => c.role === 'db-relational');
    // The wrong-role service was rejected; the role fell back to the DB default.
    expect(db!.serviceId).toBe('aws:rds-postgres');
    expect(db!.skuId).toBe('aws:rds-postgres:t4g-micro');
    // s3 did not leak into a db-relational choice anywhere.
    expect(aws(rec).choices.some((c) => c.serviceId === 'aws:s3' && c.role === 'db-relational')).toBe(
      false,
    );
  });

  it('fills a PRD-required role the model omitted (compute-web) with the catalog default', async () => {
    // Draft that only answers db-relational, omitting the required compute-web.
    mockCall.mockResolvedValue(
      awsDraft({
        selections: [
          {
            provider: 'aws',
            choices: [
              {
                role: 'db-relational',
                serviceId: 'aws:rds-postgres',
                skuId: 'aws:rds-postgres:t4g-medium',
                units: 1,
                enabled: true,
              },
            ],
          },
        ],
      }),
    );

    expect(requiredRoles).toContain('compute-web');
    const rec = await recommendDeployment(context, serviceCatalog);
    const web = aws(rec).choices.find((c) => c.role === 'compute-web');
    expect(web).toBeDefined();
    // The catalog default compute-web service for AWS is the first offered.
    expect(web!.serviceId).toBe('aws:ec2');
    expect(web!.skuId.startsWith('aws:ec2:')).toBe(true);
  });

  it('drops a role the PRD does NOT need even when the model volunteers it', async () => {
    // The context has no cache component, so cache-redis is not required.
    expect(requiredRoles).not.toContain('cache-redis');

    mockCall.mockResolvedValue(
      awsDraft({
        selections: [
          {
            provider: 'aws',
            choices: [
              {
                role: 'compute-web',
                serviceId: 'aws:ec2',
                skuId: 'aws:ec2:t3-small',
                units: 1,
                enabled: true,
              },
              {
                role: 'cache-redis', // volunteered, but not required
                serviceId: 'aws:elasticache',
                skuId: 'aws:elasticache:t4g-micro',
                units: 1,
                enabled: true,
              },
            ],
          },
        ],
      }),
    );

    const rec = await recommendDeployment(context, serviceCatalog);
    expect(aws(rec).choices.some((c) => c.role === 'cache-redis')).toBe(false);
  });

  it('every provider selection parses costSelectionSchema (no leakage, no dup roles)', async () => {
    mockCall.mockResolvedValue(awsDraft());
    const rec = await recommendDeployment(context, serviceCatalog);

    for (const sel of rec.selections) {
      expect(costSelectionSchema.safeParse(sel).success).toBe(true);
      // One choice per role.
      const roles = sel.choices.map((c) => c.role);
      expect(new Set(roles).size).toBe(roles.length);
      // No cross-provider leakage.
      for (const c of sel.choices) {
        expect(c.serviceId.startsWith(`${sel.provider}:`)).toBe(true);
        expect(c.skuId.startsWith(`${c.serviceId}:`)).toBe(true);
      }
    }
    // The whole recommendation is contract-valid.
    expect(costRecommendationSchema.safeParse(rec).success).toBe(true);
  });

  it('seeds a selection for every provider in the catalog (all five)', async () => {
    mockCall.mockResolvedValue(awsDraft());
    const rec = await recommendDeployment(context, serviceCatalog);
    const providers = rec.selections.map((s) => s.provider).sort();
    expect(providers).toEqual(['aws', 'azure', 'digitalocean', 'gcp', 'vercel']);
  });

  it('does NOT fabricate a choice for a role a provider cannot fill (Vercel has no db-relational)', async () => {
    mockCall.mockResolvedValue(awsDraft());
    const rec = await recommendDeployment(context, serviceCatalog);
    const vercel = rec.selections.find((s) => s.provider === 'vercel')!;
    // db-relational is required by the PRD but Vercel does not offer it — no
    // choice is fabricated (it surfaces as an unsupported role in the engine).
    expect(vercel.choices.some((c) => c.role === 'db-relational')).toBe(false);
    // It still fills the roles it CAN (compute-web, static-hosting, egress).
    expect(vercel.choices.some((c) => c.role === 'compute-web')).toBe(true);
  });
});

describe('recommendDeployment — error mapping', () => {
  /** Reject the call(s) with `err`; return the (mapped) error the stage threw.
   *  Terminal codes (not_configured/unavailable/unexpected) fail on attempt 0;
   *  `invalid_output` is retried, so queue the rejection for all bounded attempts. */
  async function codeOf(err: unknown, retryable = false): Promise<{ name?: string; code?: string }> {
    if (retryable) {
      mockCall.mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockRejectedValueOnce(err);
    } else {
      mockCall.mockRejectedValueOnce(err);
    }
    return (await recommendDeployment(context, serviceCatalog).catch((e) => e)) as {
      name?: string;
      code?: string;
    };
  }

  it('maps GenerationError("not_configured") → PricingError("not_configured")', async () => {
    const e = await codeOf(new GenerationError('not_configured', 'ANTHROPIC_API_KEY missing'));
    expect(e.name).toBe('PricingError');
    expect(e.code).toBe('not_configured');
  });

  it('maps GenerationError("unavailable") → PricingError("unavailable")', async () => {
    const e = await codeOf(new GenerationError('unavailable', 'org_id=leak-me-123 rate limited'));
    expect(e.name).toBe('PricingError');
    expect(e.code).toBe('unavailable');
  });

  it('maps GenerationError("invalid_output") → PricingError("invalid_output") after bounded retries', async () => {
    const e = await codeOf(new GenerationError('invalid_output', 'schema failed'), true);
    expect(e.code).toBe('invalid_output');
  });

  it('maps an unexpected non-GenerationError → PricingError("unavailable")', async () => {
    const e = await codeOf(new Error('boom'));
    expect(e.name).toBe('PricingError');
    expect(e.code).toBe('unavailable');
  });
});

describe('recommendDeployment — recommended provider', () => {
  it('keeps the model\'s valid recommended provider', async () => {
    mockCall.mockResolvedValue(awsDraft());
    const rec = await recommendDeployment(context, serviceCatalog);
    expect(rec.recommendedProvider).toBe('aws');
  });

  it('pickFallbackProvider chooses the provider filling the most required roles', () => {
    const index = new _internal.CatalogIndex(serviceCatalog);
    const providers = index.providersPresent();
    const choice = _internal.pickFallbackProvider(index, providers, requiredRoles);
    // Must be a real provider that supports compute-web at minimum.
    expect(providers).toContain(choice);
    expect(index.supports(choice, 'compute-web')).toBe(true);
  });
});

describe('_internal.verifyChoice — the deterministic gate', () => {
  const index = new _internal.CatalogIndex(serviceCatalog);

  it('accepts a real, role-consistent, provider-consistent choice', () => {
    const v = _internal.verifyChoice(
      index,
      'aws',
      'db-relational',
      'aws:rds-postgres',
      'aws:rds-postgres:t4g-micro',
    );
    expect(v.pick).not.toBeNull();
  });

  it('rejects an invented service id', () => {
    const v = _internal.verifyChoice(index, 'aws', 'db-relational', 'aws:made-up', 'aws:made-up:x');
    expect(v.pick).toBeNull();
  });

  it('rejects a real service used for the wrong role', () => {
    const v = _internal.verifyChoice(index, 'aws', 'db-relational', 'aws:s3', 'aws:s3:standard');
    expect(v.pick).toBeNull();
  });

  it('rejects a cross-provider service (gcp service claimed as aws)', () => {
    const v = _internal.verifyChoice(
      index,
      'aws',
      'db-relational',
      'gcp:cloud-sql',
      'gcp:cloud-sql:ent-1vcpu-3.75gb',
    );
    expect(v.pick).toBeNull();
  });

  it('rejects a SKU that does not belong to the named service', () => {
    const v = _internal.verifyChoice(
      index,
      'aws',
      'db-relational',
      'aws:rds-postgres',
      'aws:ec2:t3-small',
    );
    expect(v.pick).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* BLOCKER-4: coerceDraft repairs the observed serialisation drift            */
/* -------------------------------------------------------------------------- */

describe('_internal.coerceDraft — repairs real sonnet serialisation drift', () => {
  /** A permissive draft with well-shaped selections/tradeoffs; only the field
   *  under test is drifted. Kept minimal so the strict schema is satisfied once
   *  the drift is repaired. */
  function permissive(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      recommendedProvider: 'aws',
      rationale:
        'At medium scale on a startup budget with business-hours traffic, AWS offers a broad managed catalog and predictable RDS pricing.',
      assumptions: ['No cache component was specified, so no cache is priced.'],
      selections: [
        {
          provider: 'aws',
          choices: [
            { role: 'compute-web', serviceId: 'aws:ec2', skuId: 'aws:ec2:t3-medium', units: 1, enabled: true },
          ],
        },
      ],
      tradeoffs: [{ provider: 'aws', pros: ['Broad catalog'], cons: ['Steeper learning curve'] }],
      ...overrides,
    };
  }

  it('extractJsonArray pulls the array out of the observed XML-leak wrapper', () => {
    // Exactly the shape captured live: a field VALUE containing the tool XML.
    const leaked =
      '\n<parameter name="assumptions">["Defaulted the relational engine to PostgreSQL.", "Assumed Redis is a pure in-memory cache."]';
    const arr = _internal.extractJsonArray(leaked);
    expect(arr).toEqual([
      'Defaulted the relational engine to PostgreSQL.',
      'Assumed Redis is a pure in-memory cache.',
    ]);
  });

  it('extractJsonArray respects string literals containing brackets', () => {
    const arr = _internal.extractJsonArray('junk ["a [nested] bracket", "b"] trailing');
    expect(arr).toEqual(['a [nested] bracket', 'b']);
  });

  it('extractJsonArray returns null when there is no decodable array', () => {
    expect(_internal.extractJsonArray('no array here')).toBeNull();
    expect(_internal.extractJsonArray('[ unterminated')).toBeNull();
  });

  it('decodeArrayField decodes a plain JSON-string array', () => {
    expect(_internal.decodeArrayField('[{"provider":"aws"}]')).toEqual([{ provider: 'aws' }]);
  });

  it('decodeArrayField passes a real array through untouched', () => {
    const arr = [{ provider: 'aws' }];
    expect(_internal.decodeArrayField(arr)).toBe(arr);
  });

  it('DRIFT A: assumptions leaked as an XML-wrapped string → decoded to a real array', () => {
    const draft = _internal.coerceDraft(
      permissive({
        assumptions:
          '\n<parameter name="assumptions">["Defaulted the relational engine to managed PostgreSQL with a read replica.", "Assumed Redis is used purely as an in-memory hot cache."]',
      }) as never,
    );
    expect(draft.assumptions).toEqual([
      'Defaulted the relational engine to managed PostgreSQL with a read replica.',
      'Assumed Redis is used purely as an in-memory hot cache.',
    ]);
  });

  it('DRIFT B: an assumption longer than 300 chars is CLAMPED, not rejected', () => {
    const long = 'A'.repeat(420);
    const draft = _internal.coerceDraft(permissive({ assumptions: [long] }) as never);
    expect(draft.assumptions[0].length).toBeLessThanOrEqual(300);
    // It is the model's own text, trimmed — starts with the original content.
    expect(draft.assumptions[0].startsWith('AAAA')).toBe(true);
  });

  it('selections arriving as a JSON string are decoded', () => {
    const selStr = JSON.stringify([
      {
        provider: 'aws',
        choices: [
          { role: 'compute-web', serviceId: 'aws:ec2', skuId: 'aws:ec2:t3-medium', units: 1, enabled: true },
        ],
      },
    ]);
    const draft = _internal.coerceDraft(permissive({ selections: selStr }) as never);
    expect(Array.isArray(draft.selections)).toBe(true);
    expect(draft.selections[0].provider).toBe('aws');
  });

  it('tradeoffs arriving as a JSON string are decoded', () => {
    const tStr = JSON.stringify([{ provider: 'aws', pros: ['fast'], cons: ['pricey'] }]);
    const draft = _internal.coerceDraft(permissive({ tradeoffs: tStr }) as never);
    expect(Array.isArray(draft.tradeoffs)).toBe(true);
    expect(draft.tradeoffs[0].provider).toBe('aws');
  });

  it('over-long tradeoff pros/cons entries are clamped to 240 chars, not rejected', () => {
    const longPro = 'P'.repeat(400);
    const longCon = 'C'.repeat(400);
    const draft = _internal.coerceDraft(
      permissive({ tradeoffs: [{ provider: 'aws', pros: [longPro], cons: [longCon] }] }) as never,
    );
    expect(draft.tradeoffs[0].pros[0].length).toBeLessThanOrEqual(240);
    expect(draft.tradeoffs[0].cons[0].length).toBeLessThanOrEqual(240);
  });

  it('a genuinely malformed draft (missing required field) STILL throws PricingError(invalid_output)', () => {
    // Clamp/decode must not paper over real garbage — the strict schema is still
    // the gate. Here selections cannot be repaired into a valid array.
    expect(() =>
      _internal.coerceDraft(permissive({ selections: 'not-an-array-and-no-brackets' }) as never),
    ).toThrow(/schema validation/);
  });

  it('DRIFT C: a whole field OMITTED by the model → strict-parse failure (retryable), not a client crash', () => {
    // Observed live: sonnet sometimes emits an incomplete tool call missing an
    // entire field (e.g. `tradeoffs`). The permissive client schema accepts the
    // omission (undefined) so it does NOT throw a client-side GenerationError;
    // coerceDraft then rejects it as a retryable strict-parse failure.
    const withoutTradeoffs = permissive({});
    delete (withoutTradeoffs as Record<string, unknown>).tradeoffs;
    expect(() => _internal.coerceDraft(withoutTradeoffs as never)).toThrow(/schema validation/);
  });

  it('DRIFT D: the model leaked the WHOLE tool call into one field → sibling fields recovered', () => {
    // The worst observed shape: the model dumps every parameter as tool XML into
    // `assumptions`, leaving `selections`/`tradeoffs` undefined. recoverLeakedFields
    // pulls each sibling back out of the leaked blob — turning a retry into a
    // first-attempt success with the model's OWN content.
    const leakedBlob =
      '\n<parameter name="assumptions">["Defaulted the relational engine to PostgreSQL."]' +
      '\n<parameter name="selections">[{"provider":"aws","choices":[{"role":"compute-web","serviceId":"aws:ec2","skuId":"aws:ec2:t3-medium","units":1,"enabled":true}]}]' +
      '\n<parameter name="tradeoffs">[{"provider":"aws","pros":["Broad catalog"],"cons":["Steeper learning curve"]}]';
    const drifted = {
      recommendedProvider: 'aws',
      rationale:
        'At medium scale on a startup budget, AWS offers a broad managed catalog and predictable RDS pricing for this workload.',
      assumptions: leakedBlob,
      selections: undefined,
      tradeoffs: undefined,
    };
    const draft = _internal.coerceDraft(drifted as never);
    expect(draft.assumptions).toEqual(['Defaulted the relational engine to PostgreSQL.']);
    expect(draft.selections[0].provider).toBe('aws');
    expect(draft.selections[0].choices[0].serviceId).toBe('aws:ec2');
    expect(draft.tradeoffs[0].provider).toBe('aws');
    expect(draft.tradeoffs[0].pros).toEqual(['Broad catalog']);
  });

  it('recoverLeakedFields never overwrites a field that already has a good value', () => {
    const goodSelections = [
      { provider: 'gcp', choices: [{ role: 'compute-web', serviceId: 'gcp:cloud-run', skuId: 'gcp:cloud-run:std', units: 1, enabled: true }] },
    ];
    const recovered = _internal.recoverLeakedFields({
      recommendedProvider: 'aws',
      rationale: 'x',
      assumptions: '\n<parameter name="selections">[{"provider":"aws","choices":[]}]',
      selections: goodSelections,
      tradeoffs: [{ provider: 'aws', pros: ['a'], cons: ['b'] }],
    } as never) as { selections: unknown };
    // The already-good selections must be preserved, not clobbered by the leak.
    expect(recovered.selections).toBe(goodSelections);
  });

  it('DRIFT E: array elements arrive as JSON-object STRINGS → each element decoded', () => {
    // Observed live (small PRD): the outer arrays are real, but each ITEM is a
    // JSON-encoded object string — surfacing as `tradeoffs.0: expected object,
    // received string` and `selections.0.choices: expected array, received
    // undefined`. decodeObjectArrayField decodes each element.
    const draft = _internal.coerceDraft(
      permissive({
        selections: [
          JSON.stringify({
            provider: 'aws',
            choices: [
              { role: 'compute-web', serviceId: 'aws:ec2', skuId: 'aws:ec2:t3-medium', units: 1, enabled: true },
            ],
          }),
        ],
        tradeoffs: [JSON.stringify({ provider: 'aws', pros: ['fast'], cons: ['pricey'] })],
      }) as never,
    );
    expect(draft.selections[0].provider).toBe('aws');
    expect(draft.selections[0].choices[0].serviceId).toBe('aws:ec2');
    expect(draft.tradeoffs[0].provider).toBe('aws');
    expect(draft.tradeoffs[0].pros).toEqual(['fast']);
  });

  it('clampString is a no-op under the cap and ellipsises over it', () => {
    expect(_internal.clampString('short', 300)).toBe('short');
    const clamped = _internal.clampString('x'.repeat(500), 300);
    expect(clamped.length).toBeLessThanOrEqual(300);
    expect(clamped.endsWith('…')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* BLOCKER-4: retry policy — truncation vs serialisation drift                */
/* -------------------------------------------------------------------------- */

describe('recommendDeployment — retry policy (BLOCKER-4)', () => {
  it('does NOT retry a truncation at the same budget — retries ONCE at a raised budget', async () => {
    // First call truncates (max_tokens); the raised-budget retry succeeds.
    const truncErr = new GenerationError(
      'invalid_output',
      'Output truncated at max_tokens (8192); the structured JSON is incomplete.',
      { truncated: true },
    );
    mockCall.mockRejectedValueOnce(truncErr).mockResolvedValueOnce(awsDraft());

    const rec = await recommendDeployment(context, serviceCatalog);
    expect(costRecommendationSchema.safeParse(rec).success).toBe(true);

    // Exactly two calls: the truncation, then the raised-budget retry.
    expect(mockCall).toHaveBeenCalledTimes(2);
    const firstBudget = mockCall.mock.calls[0][0].maxTokens;
    const retryBudget = mockCall.mock.calls[1][0].maxTokens;
    expect(retryBudget).toBeGreaterThan(firstBudget);
  });

  it('fails FAST when the raised-budget retry ALSO truncates — no third call', async () => {
    const truncErr = () =>
      new GenerationError('invalid_output', 'Output truncated at max_tokens', { truncated: true });
    mockCall.mockRejectedValueOnce(truncErr()).mockRejectedValueOnce(truncErr());

    const err = (await recommendDeployment(context, serviceCatalog).catch((e) => e)) as {
      name?: string;
      code?: string;
    };
    expect(err.name).toBe('PricingError');
    expect(err.code).toBe('invalid_output');
    // Truncation (1) + one raised-budget retry (2) = 2 calls, then fail fast.
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  it('retries serialisation drift at the SAME budget then succeeds', async () => {
    // A coerceDraft failure surfaces as a strict-parse PricingError inside the
    // loop. Simulate it by returning an unrepairable draft once, then a good one.
    mockCall
      .mockResolvedValueOnce({ recommendedProvider: 'aws', rationale: 'x', assumptions: 'not-an-array-no-brackets', selections: 'bad', tradeoffs: 'bad' } as never)
      .mockResolvedValueOnce(awsDraft());

    const rec = await recommendDeployment(context, serviceCatalog);
    expect(costRecommendationSchema.safeParse(rec).success).toBe(true);
    expect(mockCall).toHaveBeenCalledTimes(2);
    // Both attempts used the SAME (base) budget — drift is not a budget problem.
    expect(mockCall.mock.calls[0][0].maxTokens).toBe(mockCall.mock.calls[1][0].maxTokens);
  });

  it('does NOT retry not_configured — fails on the first call', async () => {
    mockCall.mockRejectedValueOnce(new GenerationError('not_configured', 'no key'));
    const err = (await recommendDeployment(context, serviceCatalog).catch((e) => e)) as {
      code?: string;
    };
    expect(err.code).toBe('not_configured');
    expect(mockCall).toHaveBeenCalledTimes(1);
  });
});
