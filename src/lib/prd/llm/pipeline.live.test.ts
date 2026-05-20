/**
 * LIVE end-to-end smoke test for the full 3-stage PRD generation pipeline.
 *
 * ⚠️  This test makes REAL Anthropic API calls and is GUARDED: it is a no-op
 *     unless `ANTHROPIC_API_KEY` is present in the environment. So `npm test`
 *     in CI (no key) skips it entirely and bills nothing; a developer with a
 *     key gets real coverage of the thing mocked tests can't see.
 *
 * WHY THIS EXISTS (task t_ad18b485): mocked unit tests always fed valid enum
 * values, so they stayed green while ~half of LIVE architecture generations
 * died on zod validation because the model returned relationship `kind` values
 * like "belongs-to"/"has-many" instead of the strict
 * one-to-one|one-to-many|many-to-many enum. Only a real generation catches that
 * class of drift. This runs the WHOLE pipeline (prd → architecture → plan +
 * derivation + assembly) end to end and asserts the assembled document passes
 * `prdDocumentSchema.safeParse`, across a few varied ideas so enum drift in any
 * one domain is caught.
 *
 * COST SAFETY: uses our Anthropic key only, on a FAST model (Haiku), a handful
 * of calls total. No other paid service is touched.
 */

import { describe, expect, it } from 'vitest';

import { prdDocumentSchema, type ProjectBrief } from '@/types/prd';
import { runGenerationPipeline } from '@/lib/prd/llm/pipeline';

/** Fast, cheap model for the live smoke — keeps the paid footprint minimal. */
const LIVE_MODEL = process.env.ANTHROPIC_SMOKE_MODEL ?? 'claude-haiku-4-5-20251001';

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

/** A few varied ideas so relationship-kind drift in any one domain surfaces. */
const IDEAS: { label: string; brief: ProjectBrief }[] = [
  {
    label: 'gym class booking',
    brief: {
      idea: 'A tool for gyms to schedule classes and let members book spots from their phone.',
      context: {
        userScale: 'small',
        trafficPattern: 'steady',
        budgetBand: 'hobby',
        timelineWeeks: 6,
      },
      clarifications: [],
    },
  },
  {
    label: 'link-in-bio',
    brief: {
      idea: 'A link-in-bio page builder where creators collect their links, sell digital products, and see click analytics.',
      context: {
        userScale: 'medium',
        trafficPattern: 'spiky',
        budgetBand: 'startup',
        timelineWeeks: 8,
      },
      clarifications: [],
    },
  },
  {
    label: 'internal CRM',
    brief: {
      idea: 'An internal CRM for a small sales team to track companies, contacts, deals, and activity notes.',
      context: {
        userScale: 'small',
        trafficPattern: 'business-hours',
        budgetBand: 'startup',
        timelineWeeks: 10,
      },
      clarifications: [],
    },
  },
];

describe.skipIf(!HAS_KEY)('LIVE: full PRD generation pipeline (real Anthropic)', () => {
  // Real generations are slow (3 sequential LLM stages + a title call, each
  // several thousand output tokens). Give each idea a generous per-test budget.
  const PER_IDEA_TIMEOUT_MS = 240_000;

  it.each(IDEAS)(
    'produces a schema-valid PrdDocument end to end for "$label"',
    async ({ label, brief }) => {
      const id = `prd_live_${label.replace(/\W+/g, '').slice(0, 8)}`;
      const createdAt = new Date().toISOString();

      const doc = await runGenerationPipeline(brief, id, createdAt, { model: LIVE_MODEL });

      const parsed = prdDocumentSchema.safeParse(doc);
      if (!parsed.success) {
        // Surface the exact failing paths — this is the whole point of the test.
        const issues = parsed.error.issues
          .map((iss) => `${iss.path.map(String).join('.') || '<root>'}: ${iss.message}`)
          .join('\n  ');
        throw new Error(`[${label}] assembled document failed schema validation:\n  ${issues}`);
      }

      expect(parsed.success).toBe(true);

      // Specifically assert the regression under test: every relationship kind
      // is one of the three strict enum values (the bug produced others).
      const kinds = doc.architecture.dataModel.relationships.map((r) => r.kind);
      for (const k of kinds) {
        expect(['one-to-one', 'one-to-many', 'many-to-many']).toContain(k);
      }
      // Provenance is injected, not invented.
      expect(doc.id).toBe(id);
      expect(doc.model).toBe(LIVE_MODEL);
    },
    PER_IDEA_TIMEOUT_MS,
  );
});
