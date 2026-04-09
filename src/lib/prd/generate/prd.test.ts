/**
 * Tests for the deterministic PRD-section generator.
 *
 * Covers: the contract minimums (≥5 stories, ≥8 FRs, ≥5 NFRs), determinism,
 * zod schema conformance, id formats, that answers actually drive the output
 * (mustAvoid appears in non-goals; compliance drives NFRs; open questions are
 * derived from gaps), and the free-tier-vs-enterprise divergence in NFR count.
 */

import { describe, expect, it } from 'vitest';
import { generatePrdSection } from '@/lib/prd/generate/prd';
import { prdSectionSchema } from '@/types/prd';
import { VALID_ANSWERS } from '@/types/prd.test';
import { ENTERPRISE_VERY_LARGE, FREE_TIER_PROTOTYPE } from './fixtures.test-support';

const ALL = [VALID_ANSWERS, FREE_TIER_PROTOTYPE, ENTERPRISE_VERY_LARGE];

describe('generatePrdSection — schema + determinism', () => {
  it('output parses against prdSectionSchema for every fixture', () => {
    for (const answers of ALL) {
      expect(prdSectionSchema.safeParse(generatePrdSection(answers)).success).toBe(true);
    }
  });

  it('is deterministic — same answers produce a deeply-equal section', () => {
    for (const answers of ALL) {
      expect(generatePrdSection(answers)).toEqual(generatePrdSection(answers));
    }
  });
});

describe('generatePrdSection — contract minimums', () => {
  it('meets the minimum volumes for every fixture', () => {
    for (const answers of ALL) {
      const prd = generatePrdSection(answers);
      expect(prd.userStories.length).toBeGreaterThanOrEqual(5);
      expect(prd.functionalRequirements.length).toBeGreaterThanOrEqual(8);
      expect(prd.nonFunctionalRequirements.length).toBeGreaterThanOrEqual(5);
      expect(prd.goals.length).toBeGreaterThanOrEqual(3);
      expect(prd.nonGoals.length).toBeGreaterThanOrEqual(2);
      expect(prd.successMetrics.length).toBeGreaterThanOrEqual(3);
      expect(prd.risks.length).toBeGreaterThanOrEqual(3);
      expect(prd.openQuestions.length).toBeGreaterThanOrEqual(2);
      expect(prd.overview.valueProposition.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('every user story has at least one acceptance criterion', () => {
    for (const answers of ALL) {
      for (const story of generatePrdSection(answers).userStories) {
        expect(story.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('generatePrdSection — id formats', () => {
  it('uses sequential US-/FR-/NFR- ids', () => {
    const prd = generatePrdSection(ENTERPRISE_VERY_LARGE);
    expect(prd.userStories.map((s) => s.id)).toEqual(prd.userStories.map((_, i) => `US-${i + 1}`));
    expect(prd.functionalRequirements.map((r) => r.id)).toEqual(prd.functionalRequirements.map((_, i) => `FR-${i + 1}`));
    expect(prd.nonFunctionalRequirements.map((r) => r.id)).toEqual(prd.nonFunctionalRequirements.map((_, i) => `NFR-${i + 1}`));
  });
});

describe('generatePrdSection — answers actually drive the output', () => {
  it('overview.problem echoes the problem statement verbatim', () => {
    expect(generatePrdSection(VALID_ANSWERS).overview.problem).toBe(VALID_ANSWERS.basics.problemStatement);
  });

  it('mustAvoid entries show up as non-goals', () => {
    const answers = { ...VALID_ANSWERS, stack: { ...VALID_ANSWERS.stack, mustAvoid: ['Firebase'] } };
    const nonGoals = generatePrdSection(answers).nonGoals.join(' ');
    expect(nonGoals).toContain('Firebase');
  });

  it('authRequired: false produces a "no accounts" non-goal', () => {
    const nonGoals = generatePrdSection(FREE_TIER_PROTOTYPE).nonGoals.join(' ').toLowerCase();
    expect(nonGoals).toContain('no user accounts');
  });

  it('each active compliance flag yields a compliance NFR', () => {
    const prd = generatePrdSection(ENTERPRISE_VERY_LARGE);
    const complianceNfrs = prd.nonFunctionalRequirements.filter((n) => n.category === 'compliance');
    // ENTERPRISE_VERY_LARGE lists gdpr, soc2, pci → 3 compliance NFRs.
    expect(complianceNfrs.length).toBe(3);
  });

  it('every NFR names the answer that produced it (non-empty rationale)', () => {
    for (const answers of ALL) {
      for (const nfr of generatePrdSection(answers).nonFunctionalRequirements) {
        expect(nfr.rationale.length).toBeGreaterThan(0);
      }
    }
  });

  it('budget hard-limit produces a budget risk', () => {
    // VALID_ANSWERS.budget.budgetIsHardLimit === true
    const risks = generatePrdSection(VALID_ANSWERS).risks.map((r) => r.risk.toLowerCase()).join(' ');
    expect(risks).toContain('budget');
  });

  it('open questions are derived from gaps (0 rps, empty relationship notes)', () => {
    const q = generatePrdSection(FREE_TIER_PROTOTYPE).openQuestions.join(' ').toLowerCase();
    expect(q).toContain('requests/second');
    expect(q).toContain('relationship');
  });

  it('a role separation story appears only when there is more than one role', () => {
    const many = generatePrdSection(ENTERPRISE_VERY_LARGE).userStories.map((s) => s.iWant).join(' ').toLowerCase();
    expect(many).toContain('role');
    // FREE_TIER_PROTOTYPE has no auth at all → no role story.
    const none = generatePrdSection(FREE_TIER_PROTOTYPE).userStories.map((s) => s.iWant).join(' ').toLowerCase();
    expect(none).not.toContain('what each role');
  });
});

describe('generatePrdSection — free-tier vs enterprise diverge', () => {
  it('produces a different (larger) NFR count for enterprise than free-tier', () => {
    const free = generatePrdSection(FREE_TIER_PROTOTYPE);
    const ent = generatePrdSection(ENTERPRISE_VERY_LARGE);
    expect(ent.nonFunctionalRequirements.length).not.toBe(free.nonFunctionalRequirements.length);
    expect(ent.nonFunctionalRequirements.length).toBeGreaterThan(free.nonFunctionalRequirements.length);
  });

  it('produces materially different documents (stories + FRs differ in count)', () => {
    const free = generatePrdSection(FREE_TIER_PROTOTYPE);
    const ent = generatePrdSection(ENTERPRISE_VERY_LARGE);
    expect(ent.userStories.length).toBeGreaterThan(free.userStories.length);
    expect(ent.functionalRequirements.length).toBeGreaterThan(free.functionalRequirements.length);
  });
});
