/**
 * Unit tests for the review-summary answer formatter (format-answer.ts).
 * Pure functions, vitest `node` env.
 */

import { describe, it, expect } from 'vitest';
import { formatAnswerValue } from '@/components/prd/format-answer';
import { QUESTIONS_BY_PATH } from '@/lib/prd/questionnaire';
import type { QuestionDef } from '@/types/prd';

const q = (path: string): QuestionDef => {
  const def = QUESTIONS_BY_PATH[path];
  if (!def) throw new Error(`no question at ${path}`);
  return def;
};

describe('formatAnswerValue', () => {
  it('renders an em dash for empty / missing values', () => {
    expect(formatAnswerValue(q('basics.projectName'), undefined)).toBe('—');
    expect(formatAnswerValue(q('basics.projectName'), '')).toBe('—');
    expect(formatAnswerValue(q('scale.regions'), [])).toBe('—');
    expect(formatAnswerValue(q('stack.mustUse'), [])).toBe('—');
  });

  it('maps a select value to its option label', () => {
    expect(formatAnswerValue(q('basics.productType'), 'saas')).toBe('SaaS product');
    expect(formatAnswerValue(q('scale.growthExpectation'), 'aggressive')).toBe('Aggressive');
  });

  it('maps a multi-select array to comma-joined labels', () => {
    expect(formatAnswerValue(q('scale.regions'), ['us-east', 'eu-west'])).toBe(
      'US East, EU West',
    );
  });

  it('joins tag-list values verbatim', () => {
    expect(formatAnswerValue(q('stack.mustUse'), ['Stripe', 'Prisma'])).toBe('Stripe, Prisma');
  });

  it('renders booleans as Yes / No', () => {
    expect(formatAnswerValue(q('auth.authRequired'), true)).toBe('Yes');
    expect(formatAnswerValue(q('auth.authRequired'), false)).toBe('No');
  });

  it('renders numbers', () => {
    expect(formatAnswerValue(q('scale.peakRequestsPerSecond'), 50)).toBe('50');
    expect(formatAnswerValue(q('scale.dataVolumeGb'), 0)).toBe('0');
  });

  it('summarises entity-builder values with field counts', () => {
    const entities = [
      { name: 'Invoice', fields: [{ name: 'amount', type: 'number', required: true }] },
      { name: 'User', fields: [] },
    ];
    expect(formatAnswerValue(q('dataModel.entities'), entities)).toBe(
      'Invoice (1 field), User (0 fields)',
    );
  });

  it('renders text / textarea trimmed', () => {
    expect(formatAnswerValue(q('basics.projectName'), '  Acme  ')).toBe('Acme');
  });
});
