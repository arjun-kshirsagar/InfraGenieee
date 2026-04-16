/**
 * Unit tests for the F2 field renderer's pure logic (field-logic.ts).
 *
 * These deliberately test the *logic* (visibility predicate, number coercion,
 * per-field validation, entity limits/round-trip) rather than the DOM — vitest
 * runs in the `node` environment (see vitest.config.mts), and the acceptance
 * criteria call for the tricky bits to be testable as pure functions.
 */

import { describe, it, expect } from 'vitest';
import {
  isQuestionVisible,
  coerceNumberInput,
  validateAnswer,
  isEmptyValue,
  fieldSchemaFor,
  addTag,
  removeTagAt,
  duplicateEntityNames,
  validateEntities,
  emptyEntity,
  emptyField,
  type DraftEntity,
} from '@/components/prd/field-logic';
import { QUESTIONS_BY_PATH } from '@/lib/prd/questionnaire';
import { dataModelAnswersSchema, type QuestionDef } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* visibleWhen predicate                                                      */
/* -------------------------------------------------------------------------- */

describe('isQuestionVisible', () => {
  const authMethods = QUESTIONS_BY_PATH['auth.authMethods'];
  const roles = QUESTIONS_BY_PATH['auth.roles'];
  const multiTenant = QUESTIONS_BY_PATH['auth.multiTenant'];
  const projectName = QUESTIONS_BY_PATH['basics.projectName'];

  it('always shows a question with no visibleWhen guard', () => {
    expect(isQuestionVisible(projectName, () => undefined)).toBe(true);
  });

  it('hides gated auth questions when authRequired is off/unset', () => {
    const readOff = (p: string) => (p === 'auth.authRequired' ? false : undefined);
    expect(isQuestionVisible(authMethods, readOff)).toBe(false);
    expect(isQuestionVisible(roles, readOff)).toBe(false);
    expect(isQuestionVisible(multiTenant, readOff)).toBe(false);

    const readUnset = () => undefined;
    expect(isQuestionVisible(authMethods, readUnset)).toBe(false);
  });

  it('reveals gated auth questions when authRequired is on', () => {
    const readOn = (p: string) => (p === 'auth.authRequired' ? true : undefined);
    expect(isQuestionVisible(authMethods, readOn)).toBe(true);
    expect(isQuestionVisible(roles, readOn)).toBe(true);
    expect(isQuestionVisible(multiTenant, readOn)).toBe(true);
  });

  it('uses strict equality against the guard value (truthy string ≠ true)', () => {
    const readString = (p: string) =>
      p === 'auth.authRequired' ? ('true' as unknown) : undefined;
    // 'true' (string) does not === true (boolean guard) → stays hidden.
    expect(isQuestionVisible(authMethods, readString)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* number coercion                                                            */
/* -------------------------------------------------------------------------- */

describe('coerceNumberInput', () => {
  it('produces a real number, not a string', () => {
    const out = coerceNumberInput('42');
    expect(typeof out).toBe('number');
    expect(out).toBe(42);
  });

  it('parses decimals', () => {
    expect(coerceNumberInput('99.9')).toBe(99.9);
  });

  it('returns undefined for empty/whitespace so it reads as unanswered', () => {
    expect(coerceNumberInput('')).toBeUndefined();
    expect(coerceNumberInput('   ')).toBeUndefined();
  });

  it('returns undefined for unparseable text (no NaN in state)', () => {
    expect(coerceNumberInput('abc')).toBeUndefined();
    expect(coerceNumberInput('12px')).toBeUndefined();
  });

  it('handles zero and negatives correctly', () => {
    expect(coerceNumberInput('0')).toBe(0);
    expect(coerceNumberInput('-5')).toBe(-5);
  });

  it('feeds a number that passes the schema (would 400 as a string)', () => {
    const q = QUESTIONS_BY_PATH['scale.peakRequestsPerSecond'];
    const coerced = coerceNumberInput('1000');
    expect(validateAnswer(q, coerced)).toBeNull();
    // The stringified version must NOT validate — proving coercion matters.
    expect(validateAnswer(q, '1000')).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* isEmptyValue                                                               */
/* -------------------------------------------------------------------------- */

describe('isEmptyValue', () => {
  it.each([
    [undefined, true],
    [null, true],
    ['', true],
    ['  ', true],
    [[], true],
    ['x', false],
    [0, false],
    [false, false],
    [['a'], false],
  ])('isEmptyValue(%p) === %p', (input, expected) => {
    expect(isEmptyValue(input)).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* per-field validation (driven by the schema, not re-declared here)          */
/* -------------------------------------------------------------------------- */

describe('validateAnswer', () => {
  it('flags a required empty field', () => {
    const q = QUESTIONS_BY_PATH['basics.projectName'];
    expect(validateAnswer(q, '')).toContain('required');
  });

  it('passes an optional empty field silently', () => {
    const q = QUESTIONS_BY_PATH['scale.uptimeTargetPercent'];
    expect(q.required).toBe(false);
    expect(validateAnswer(q, undefined)).toBeNull();
  });

  it('enforces the schema min length without re-declaring it', () => {
    const q = QUESTIONS_BY_PATH['basics.projectName']; // schema min(2)
    expect(validateAnswer(q, 'a')).not.toBeNull();
    expect(validateAnswer(q, 'ab')).toBeNull();
  });

  it('enforces a number range from the schema', () => {
    const q = QUESTIONS_BY_PATH['budget.teamSize']; // schema min(1) max(500)
    expect(validateAnswer(q, 0)).not.toBeNull();
    expect(validateAnswer(q, 5)).toBeNull();
    expect(validateAnswer(q, 501)).not.toBeNull();
  });

  it('validates enum select values', () => {
    const q = QUESTIONS_BY_PATH['basics.productType'];
    expect(validateAnswer(q, 'saas')).toBeNull();
    expect(validateAnswer(q, 'not-a-type')).not.toBeNull();
  });
});

describe('fieldSchemaFor', () => {
  it('resolves a real path', () => {
    expect(fieldSchemaFor('basics.projectName')).toBeDefined();
  });
  it('returns undefined for a bogus path', () => {
    expect(fieldSchemaFor('nope.nada')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* tag-list helpers                                                           */
/* -------------------------------------------------------------------------- */

describe('tag helpers', () => {
  it('adds a trimmed tag', () => {
    expect(addTag([], '  Stripe  ')).toEqual(['Stripe']);
  });
  it('ignores empty input', () => {
    expect(addTag(['a'], '   ')).toEqual(['a']);
  });
  it('de-duplicates', () => {
    expect(addTag(['Stripe'], 'Stripe')).toEqual(['Stripe']);
  });
  it('removes by index', () => {
    expect(removeTagAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
  });
});

/* -------------------------------------------------------------------------- */
/* entity builder logic + round-trip                                          */
/* -------------------------------------------------------------------------- */

describe('duplicateEntityNames', () => {
  it('finds case-insensitive duplicates', () => {
    const dups = duplicateEntityNames([{ name: 'User' }, { name: 'user' }, { name: 'Invoice' }]);
    expect(dups.has('user')).toBe(true);
    expect(dups.has('invoice')).toBe(false);
  });
  it('ignores blank names', () => {
    expect(duplicateEntityNames([{ name: '' }, { name: '  ' }]).size).toBe(0);
  });
});

describe('validateEntities', () => {
  it('requires at least one entity', () => {
    expect(validateEntities([])).not.toBeNull();
  });
  it('rejects duplicate names before schema errors', () => {
    const entities: DraftEntity[] = [
      { name: 'User', fields: [] },
      { name: 'user', fields: [] },
    ];
    expect(validateEntities(entities)).toMatch(/[Dd]uplicate/);
  });

  it('round-trips: 2 valid entities parse dataModelAnswersSchema', () => {
    const entities: DraftEntity[] = [
      {
        name: 'User',
        description: 'An account holder',
        fields: [
          { name: 'email', type: 'string', required: true },
          { name: 'createdAt', type: 'date', required: true },
        ],
      },
      {
        name: 'Invoice',
        fields: [
          { name: 'amountCents', type: 'number', required: true },
          { name: 'paid', type: 'boolean', required: false, notes: 'set by webhook' },
        ],
      },
    ];
    expect(validateEntities(entities)).toBeNull();

    const parsed = dataModelAnswersSchema.safeParse({ entities });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.entities).toHaveLength(2);
      expect(parsed.data.entities[0].fields[0].name).toBe('email');
    }
  });
});

describe('empty factories', () => {
  it('emptyEntity has an empty fields array', () => {
    expect(emptyEntity().fields).toEqual([]);
  });
  it('emptyField defaults to a non-required string', () => {
    const f = emptyField();
    expect(f.type).toBe('string');
    expect(f.required).toBe(false);
  });
});

/* Type-only guard: every questionKind maps to a QuestionDef we can render. */
describe('coverage of question kinds', () => {
  it('every question in the questionnaire has a resolvable schema or is entity/tag', () => {
    for (const q of Object.values(QUESTIONS_BY_PATH) as QuestionDef[]) {
      // entity-builder + tag-list validate as arrays; the rest resolve a schema.
      expect(fieldSchemaFor(q.path)).toBeDefined();
    }
  });
});
