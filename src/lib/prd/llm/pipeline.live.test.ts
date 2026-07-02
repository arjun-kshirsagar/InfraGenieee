/**
 * LIVE end-to-end smoke test for the full 3-stage PRD generation pipeline.
 *
 * ⚠️  This test makes REAL Anthropic API calls and is GUARDED: it is a no-op
 *     unless `ANTHROPIC_API_KEY` is present in the environment. So `npm test`
 *     in CI (no key) skips it entirely and bills nothing; a developer with a
 *     key gets real coverage of the thing mocked tests can't see.
 *
 * WHY THIS EXISTS (tasks t_ad18b485, t_fd71a759): mocked unit tests always fed
 * SHORT, valid values, so they stayed green while LIVE generations died on zod
 * validation for two related reasons:
 *   1. the model returned relationship `kind` values like "belongs-to"/"has-many"
 *      instead of the strict one-to-one|one-to-many|many-to-many enum, and
 *   2. a VERBOSE model overflowed a `.max()` cap on a free-text field (e.g.
 *      dataModel.entities[i].fields[j].notes > 200 chars), discarding the whole
 *      paid multi-stage generation.
 * Only a real generation catches either class of drift. This runs the WHOLE
 * pipeline (prd → architecture → plan + derivation + assembly) end to end and
 * asserts the assembled document passes `prdDocumentSchema.safeParse`, across
 * several VARIED ideas — including deliberately verbose ones — so a cap overflow
 * or enum drift in any one domain is caught. The clinic-SaaS idea is the EXACT
 * repro from t_fd71a759 and MUST pass.
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

/**
 * Varied ideas so relationship-kind drift AND free-text cap overflow surface.
 * The clinic-SaaS and enterprise-multitenant briefs are deliberately rich so the
 * model writes long entity/field notes — the exact condition that overflowed the
 * 200-char cap and killed a paid generation (t_fd71a759).
 */
const IDEAS: { label: string; brief: ProjectBrief }[] = [
  {
    // ── THE EXACT REPRO from task t_fd71a759 — MUST pass. ──
    label: 'clinic SaaS (repro)',
    brief: {
      idea: 'A SaaS app for small clinics to book patient appointments, send SMS reminders, and manage doctor schedules and availability.',
      context: {
        userScale: 'medium',
        trafficPattern: 'steady',
        budgetBand: 'startup',
        timelineWeeks: 12,
      },
      clarifications: [],
    },
  },
  {
    // Verbose, high-surface enterprise idea — provokes long free-text notes.
    label: 'enterprise multi-tenant',
    brief: {
      idea: 'An enterprise multi-tenant workforce-management platform for large staffing agencies: tenant isolation, role-based access control, shift scheduling with compliance rules per jurisdiction, timesheet approval workflows, payroll export integrations, and an audit log of every change for SOC2.',
      context: {
        userScale: 'large',
        trafficPattern: 'business-hours',
        budgetBand: 'enterprise',
        timelineWeeks: 24,
        constraints: 'Must be SOC2-compliant, support SSO/SAML, and keep tenant data strictly isolated.',
      },
      clarifications: [],
    },
  },
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
  // Real generations are slow: 3 sequential LLM stages + a title call. On the
  // fast model each stage is several thousand output tokens; a VERBOSE idea
  // (enterprise multi-tenant) has been measured at prd≈107s + architecture≈154s
  // + a heavy plan stage, which blew past a 360s budget on the shared endpoint —
  // a false TIMEOUT failure, not a schema failure. Give each idea 10 minutes so
  // the verbose repro cases have real headroom.
  const PER_IDEA_TIMEOUT_MS = 600_000;

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

      // t_fd71a759 regression: every capped free-text field the model wrote is
      // within its cap (the clamp truncates overflow instead of discarding the
      // generation). schema.safeParse already enforces this, but assert the
      // exact fields the bug hit so a future cap change surfaces here loudly.
      for (const e of doc.architecture.dataModel.entities) {
        if (e.description != null) expect(e.description.length).toBeLessThanOrEqual(300);
        for (const f of e.fields) {
          if (f.notes != null) expect(f.notes.length).toBeLessThanOrEqual(200);
        }
      }

      // Provenance is injected, not invented.
      expect(doc.id).toBe(id);
      expect(doc.model).toBe(LIVE_MODEL);
    },
    PER_IDEA_TIMEOUT_MS,
  );
});
