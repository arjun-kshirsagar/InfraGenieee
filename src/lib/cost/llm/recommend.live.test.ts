/**
 * LIVE smoke test for the AI recommendation stage (`recommendDeployment`).
 *
 * ⚠️  Makes a REAL Anthropic API call and is GUARDED: `describe.skipIf` turns the
 *     whole block into a no-op unless `ANTHROPIC_API_KEY` is present. So
 *     `npm test` with keys UNSET skips it entirely and bills nothing; run it
 *     deliberately with:
 *
 *         ANTHROPIC_API_KEY=… npx vitest run src/lib/cost/llm/recommend.live.test.ts
 *
 *     (Do NOT `source .env.local` to run it — that un-skips Feature 1's live PRD
 *     tests too and makes the whole suite take >8 min.)
 *
 * WHY THIS EXISTS: mocked tests always feed catalog-valid ids, so they cannot
 * catch a model that names `aws:rds-postgres:xxlarge`. This runs ONE real
 * recommendation against the real catalog and asserts:
 *   - the result parses `costRecommendationSchema`, AND
 *   - 🔴 every returned serviceId/skuId actually exists in the catalog and fills
 *     the role it claims — proving the deterministic verify gate holds against a
 *     real model, not just a fixture.
 *
 * COST SAFETY: uses our Anthropic key only, ONE call on the recommend model.
 * No other paid service is touched (no Tavily, no deployments).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  costContextSchema,
  costRecommendationSchema,
  costSelectionSchema,
  type CostContext,
} from '@/types/cost';
import { serviceCatalog } from '@/lib/cost/catalog';
import { recommendDeployment } from '@/lib/cost/llm/recommend';
import { deriveUsageProfile, mapComponentsToRoles } from '@/lib/cost/estimate/derive';

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

/** Optional cheaper override for the smoke run; defaults to the real model. */
const LIVE_MODEL = process.env.COST_RECOMMEND_MODEL;

/** A realistic PRD context — a mid-scale marketplace on a startup budget. */
const context: CostContext = {
  title: 'Bakery surplus marketplace',
  context: {
    userScale: 'medium',
    trafficPattern: 'business-hours',
    budgetBand: 'startup',
    timelineWeeks: 12,
  },
  components: [
    { name: 'Web app', kind: 'client', responsibility: 'Customer + bakery UI', technology: 'Next.js' },
    { name: 'API', kind: 'service', responsibility: 'Listings, orders, auth', technology: 'Node.js' },
    { name: 'Primary DB', kind: 'datastore', responsibility: 'Bakeries, listings, orders', technology: 'PostgreSQL' },
    { name: 'Image store', kind: 'datastore', responsibility: 'Listing photos', technology: 'S3' },
    { name: 'Stripe', kind: 'external', responsibility: 'Payments', technology: 'Stripe' },
  ],
  summary: 'A marketplace where local bakeries list same-day surplus bread at a discount for pickup.',
};

describe.skipIf(!HAS_KEY)('recommendDeployment — LIVE smoke', () => {
  it(
    'produces a schema-valid recommendation whose every id exists in the catalog',
    async () => {
      const rec = await recommendDeployment(context, serviceCatalog, {
        model: LIVE_MODEL,
      });

      // 1. The whole thing parses the public contract.
      expect(costRecommendationSchema.safeParse(rec).success).toBe(true);

      // 2. TypeScript owns the sizing — the model never supplied it.
      expect(rec.usageProfile).toEqual(deriveUsageProfile(context));

      // 3. 🔴 Every returned serviceId/skuId exists in the catalog AND fills the
      //    role it claims. Build a lookup once, then check every choice.
      const serviceById = new Map(serviceCatalog.services.map((s) => [s.id, s]));
      const skuIds = new Set(
        serviceCatalog.services.flatMap((s) => s.skus.map((k) => k.id)),
      );

      const requiredRoles = new Set(mapComponentsToRoles(context).roles);

      for (const sel of rec.selections) {
        // Each selection is contract-valid on its own.
        expect(costSelectionSchema.safeParse(sel).success).toBe(true);

        for (const choice of sel.choices) {
          const svc = serviceById.get(choice.serviceId);
          expect(svc, `service ${choice.serviceId} exists`).toBeDefined();
          expect(svc!.provider).toBe(sel.provider);
          expect(svc!.role).toBe(choice.role);
          expect(skuIds.has(choice.skuId), `sku ${choice.skuId} exists`).toBe(true);
          expect(choice.skuId.startsWith(`${choice.serviceId}:`)).toBe(true);
          // No choice for a role the PRD does not need.
          expect(requiredRoles.has(choice.role)).toBe(true);
        }
      }

      // 4. The recommended provider is one that was actually seeded.
      expect(rec.selections.some((s) => s.provider === rec.recommendedProvider)).toBe(true);

      // Surface the real output so it can be pasted into the kanban thread.
      console.log(
        '\n=== LIVE recommendDeployment output ===\n' +
          JSON.stringify(
            {
              recommendedProvider: rec.recommendedProvider,
              rationale: rec.rationale,
              assumptions: rec.assumptions,
              selections: rec.selections.map((s) => ({
                provider: s.provider,
                choices: s.choices.map((c) => `${c.role}=${c.skuId}`),
              })),
              tradeoffs: rec.tradeoffs,
            },
            null,
            2,
          ),
      );
    },
    180_000, // generous timeout: one real call, plus up to 2 bounded retries
  );
});

/* -------------------------------------------------------------------------- */
/* BLOCKER-4 regression — PRODUCTION prompt size                              */
/* -------------------------------------------------------------------------- */

/**
 * The smaller context above passed even with the broken 4096-token budget,
 * which is exactly why BLOCKER-4 shipped: the drift the retry loop survives at a
 * small prompt becomes DETERMINISTIC at production size (`input_tokens≈8300`),
 * and 4096 truncates every full 5-provider emit. This test drives the LARGE
 * ColdWatch context (12 components: Kafka + Redis + Postgres + object storage +
 * CDN) that reproduced Mode A 3/3 in the QA report, and asserts a 200-equivalent
 * (a schema-valid recommendation, no throw). Revert the token fix
 * (`MAX_OUTPUT_TOKENS` back to 4096) and this MUST fail with truncation.
 *
 * COST SAFETY: our Anthropic key only, ONE recommend call (plus at most the
 * bounded truncation/drift retries). No other paid service is touched.
 */
function loadCostContext(file: string): CostContext {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'public', file), 'utf8'));
  return costContextSchema.parse(raw);
}

describe.skipIf(!HAS_KEY)('recommendDeployment — LIVE at production prompt size', () => {
  it(
    'ColdWatch (12-component) context returns a schema-valid recommendation, not a truncation 500',
    async () => {
      const ctx = loadCostContext('__qa-cost-context.json');

      // Must NOT throw. Under the old 4096 budget this rejected with
      // PricingError('invalid_output') "Output truncated at max_tokens (4096)".
      const rec = await recommendDeployment(ctx, serviceCatalog, {});

      // 200-equivalent: the response is a schema-valid recommendation.
      expect(costRecommendationSchema.safeParse(rec).success).toBe(true);

      // TypeScript owns the sizing.
      expect(rec.usageProfile).toEqual(deriveUsageProfile(ctx));

      // Every id verified against the catalog and role-consistent.
      const serviceById = new Map(serviceCatalog.services.map((s) => [s.id, s]));
      const skuIds = new Set(serviceCatalog.services.flatMap((s) => s.skus.map((k) => k.id)));
      const requiredRoles = new Set(mapComponentsToRoles(ctx).roles);

      for (const sel of rec.selections) {
        expect(costSelectionSchema.safeParse(sel).success).toBe(true);
        for (const choice of sel.choices) {
          const svc = serviceById.get(choice.serviceId);
          expect(svc, `service ${choice.serviceId} exists`).toBeDefined();
          expect(svc!.provider).toBe(sel.provider);
          expect(svc!.role).toBe(choice.role);
          expect(skuIds.has(choice.skuId), `sku ${choice.skuId} exists`).toBe(true);
          expect(choice.skuId.startsWith(`${choice.serviceId}:`)).toBe(true);
          expect(requiredRoles.has(choice.role)).toBe(true);
        }
      }

      // A large PRD needs a Kafka queue + a cache — assert the required-role set
      // actually reached production size (this is what pushed the payload over
      // 4096 tokens), so a shrunk fixture can't silently pass.
      expect(requiredRoles.has('queue-kafka')).toBe(true);
      expect(requiredRoles.has('cache-redis')).toBe(true);
      expect(requiredRoles.size).toBeGreaterThanOrEqual(6);

      expect(rec.selections.some((s) => s.provider === rec.recommendedProvider)).toBe(true);

      console.log(
        '\n=== LIVE recommendDeployment (production size) ===\n' +
          JSON.stringify(
            {
              recommendedProvider: rec.recommendedProvider,
              requiredRoles: [...requiredRoles],
              assumptions: rec.assumptions.length,
              selections: rec.selections.map((s) => ({
                provider: s.provider,
                choices: s.choices.map((c) => `${c.role}=${c.skuId}`),
              })),
              tradeoffs: rec.tradeoffs.length,
            },
            null,
            2,
          ),
      );
    },
    240_000, // production prompt is larger and may hit the raised-budget retry
  );
});
