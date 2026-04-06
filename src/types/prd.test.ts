/**
 * Contract smoke tests. These guard the architect-owned contract itself:
 * if someone changes `src/types/prd.ts` or the questionnaire definition in a
 * way that breaks the invariants both sides rely on, this fails.
 */

import { describe, expect, it } from 'vitest';
import {
  questionnaireAnswersSchema,
  questionnaireDraftSchema,
  STEP_ORDER,
  type QuestionnaireAnswers,
} from '@/types/prd';
import { QUESTIONNAIRE, QUESTIONS_BY_PATH } from '@/lib/prd/questionnaire';
import { newPrdId } from '@/lib/prd/api';

/** A complete, valid answer set. Reused by backend/frontend tests as a fixture. */
export const VALID_ANSWERS: QuestionnaireAnswers = {
  basics: {
    projectName: 'Acme Invoicing',
    oneLiner: 'Invoicing that chases late payers for you',
    productType: 'saas',
    targetAudience: 'Freelance designers in the EU',
    problemStatement: 'Freelancers waste hours chasing unpaid invoices by hand.',
  },
  scale: {
    userScale: 'medium',
    peakRequestsPerSecond: 50,
    dataVolumeGb: 20,
    growthExpectation: 'steady',
    regions: ['eu-west'],
    uptimeTargetPercent: 99.9,
  },
  budget: {
    monthlyBudgetBand: 'startup',
    budgetIsHardLimit: true,
    teamSize: 3,
    timelineWeeks: 10,
  },
  stack: {
    frontend: 'nextjs',
    backend: 'next-api-routes',
    database: 'postgres',
    hosting: 'no-preference',
    mustUse: ['Stripe'],
    mustAvoid: [],
  },
  dataModel: {
    entities: [
      {
        name: 'Invoice',
        description: 'A bill sent to a client',
        fields: [
          { name: 'amount', type: 'number', required: true },
          { name: 'dueDate', type: 'date', required: true },
        ],
      },
    ],
    relationshipNotes: 'A User has many Invoices',
  },
  auth: {
    authRequired: true,
    authMethods: ['email-password'],
    roles: ['admin', 'member'],
    multiTenant: true,
    compliance: ['gdpr'],
  },
  integrations: {
    integrations: ['payments'],
    needsRealtime: false,
    needsBackgroundJobs: true,
    needsFileUploads: false,
    notes: undefined,
  },
};

describe('questionnaire answers contract', () => {
  it('accepts a complete answer set', () => {
    expect(questionnaireAnswersSchema.safeParse(VALID_ANSWERS).success).toBe(true);
  });

  it('rejects a missing required group', () => {
    const rest: Record<string, unknown> = { ...VALID_ANSWERS };
    delete rest.basics;
    expect(questionnaireAnswersSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an unknown enum value', () => {
    const bad = { ...VALID_ANSWERS, scale: { ...VALID_ANSWERS.scale, userScale: 'gigantic' } };
    expect(questionnaireAnswersSchema.safeParse(bad).success).toBe(false);
  });

  it('requires at least one entity', () => {
    const bad = { ...VALID_ANSWERS, dataModel: { entities: [] } };
    expect(questionnaireAnswersSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts an empty draft (autosave of a fresh form)', () => {
    expect(questionnaireDraftSchema.safeParse({}).success).toBe(true);
  });
});

describe('questionnaire definition', () => {
  it('covers every step in canonical order', () => {
    expect(QUESTIONNAIRE.steps.map((s) => s.key)).toEqual([...STEP_ORDER]);
  });

  it('has at least one question per step', () => {
    for (const step of QUESTIONNAIRE.steps) {
      expect(step.questions.length).toBeGreaterThan(0);
    }
  });

  it('prefixes every question path with its step key', () => {
    for (const step of QUESTIONNAIRE.steps) {
      for (const q of step.questions) {
        expect(q.path.startsWith(`${step.key}.`)).toBe(true);
      }
    }
  });

  it('has unique question paths', () => {
    const paths = QUESTIONNAIRE.steps.flatMap((s) => s.questions.map((q) => q.path));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('gives options to every select / multi-select question', () => {
    for (const q of Object.values(QUESTIONS_BY_PATH)) {
      if (q.kind === 'select' || q.kind === 'multi-select') {
        expect(q.options?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('points every visibleWhen at a real question path', () => {
    for (const q of Object.values(QUESTIONS_BY_PATH)) {
      if (q.visibleWhen) {
        expect(QUESTIONS_BY_PATH[q.visibleWhen.path]).toBeDefined();
      }
    }
  });

  it('resolves every question path against the answers schema', () => {
    const shape = questionnaireAnswersSchema.shape;
    for (const step of QUESTIONNAIRE.steps) {
      const groupKeys = Object.keys(shape[step.key].shape);
      for (const q of step.questions) {
        expect(groupKeys).toContain(q.path.slice(step.key.length + 1));
      }
    }
  });
});

describe('newPrdId', () => {
  it('matches the documented format', () => {
    expect(newPrdId()).toMatch(/^prd_[a-z0-9]{12}$/);
  });

  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 500 }, newPrdId));
    expect(ids.size).toBe(500);
  });
});
