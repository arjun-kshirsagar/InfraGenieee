/**
 * Unit tests for the F3 wizard validation + server-issue mapping (wizard-validation.ts).
 *
 * Pure-function tests (vitest `node` env — see vitest.config.mts). The core
 * acceptance criterion (AC5) is that the `issues[].path → step` mapper is
 * covered as a pure function; the step-schema gating helpers are covered too.
 */

import { describe, it, expect } from 'vitest';
import {
  stepSchemaFor,
  validateStep,
  firstInvalidStepIndex,
  issuePathToStepIndex,
  stepKeyFromIssuePath,
  fieldFromIssuePath,
  mapServerIssues,
} from '@/components/prd/wizard-validation';
import { STEP_ORDER, type QuestionnaireAnswers } from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* stepSchemaFor                                                              */
/* -------------------------------------------------------------------------- */

describe('stepSchemaFor', () => {
  it('resolves a schema for every canonical step key', () => {
    for (const key of STEP_ORDER) {
      expect(stepSchemaFor(key)).toBeDefined();
    }
  });

  it('returns undefined for an unknown key', () => {
    expect(stepSchemaFor('nope')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* validateStep                                                               */
/* -------------------------------------------------------------------------- */

const validBasics = {
  projectName: 'Acme',
  oneLiner: 'Invoicing that chases late payers for you',
  productType: 'saas',
  targetAudience: 'Freelancers',
  problemStatement: 'Late payments hurt cash flow badly.',
};

describe('validateStep', () => {
  it('passes a complete, valid slice', () => {
    const r = validateStep('basics', validBasics);
    expect(r.ok).toBe(true);
    expect(r.fieldErrors).toEqual({});
    expect(r.firstInvalidField).toBeNull();
  });

  it('reports field errors and the first invalid field for an incomplete slice', () => {
    const r = validateStep('basics', { projectName: 'A' }); // too short + missing fields
    expect(r.ok).toBe(false);
    expect(r.firstInvalidField).not.toBeNull();
    // The projectName min(2) violation should be reported on projectName.
    expect(Object.keys(r.fieldErrors).length).toBeGreaterThan(0);
    expect(r.fieldErrors).toHaveProperty('projectName');
  });

  it('treats undefined slice as an empty object (required fields fail)', () => {
    const r = validateStep('scale', undefined);
    expect(r.ok).toBe(false);
    expect(r.firstInvalidField).not.toBeNull();
  });

  it('reports at most one message per field (first wins)', () => {
    const r = validateStep('scale', { regions: [] }); // min(1) violation
    expect(r.ok).toBe(false);
    expect(r.fieldErrors.regions).toBeDefined();
    // regions has exactly one message even if zod produced several issues.
    expect(typeof r.fieldErrors.regions).toBe('string');
  });

  it('an unknown step key is treated as valid (no schema to check)', () => {
    const r = validateStep('nope', { anything: 1 });
    expect(r.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* firstInvalidStepIndex                                                      */
/* -------------------------------------------------------------------------- */

describe('firstInvalidStepIndex', () => {
  it('returns 0 for an empty draft (basics is first and required)', () => {
    expect(firstInvalidStepIndex({})).toBe(0);
  });

  it('returns the index of the first incomplete step', () => {
    // basics valid, scale missing → scale is index 1.
    const draft = { basics: validBasics } as Partial<QuestionnaireAnswers>;
    expect(firstInvalidStepIndex(draft)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* issue path → step (the AC5 mapper)                                         */
/* -------------------------------------------------------------------------- */

describe('stepKeyFromIssuePath', () => {
  it('maps an answers-rooted path to its step key', () => {
    expect(stepKeyFromIssuePath('answers.scale.regions')).toBe('scale');
    expect(stepKeyFromIssuePath('answers.basics.oneLiner')).toBe('basics');
    expect(stepKeyFromIssuePath('answers.integrations.notes')).toBe('integrations');
  });

  it('maps a nested-array path to its owning step', () => {
    expect(stepKeyFromIssuePath('answers.dataModel.entities.0.name')).toBe('dataModel');
  });

  it('tolerates a path without the leading answers segment', () => {
    expect(stepKeyFromIssuePath('scale.regions')).toBe('scale');
  });

  it('returns null for an unrecognised step key', () => {
    expect(stepKeyFromIssuePath('answers.bogus.field')).toBeNull();
    expect(stepKeyFromIssuePath('answers')).toBeNull();
    expect(stepKeyFromIssuePath('')).toBeNull();
  });
});

describe('issuePathToStepIndex', () => {
  it('returns the canonical index for each step', () => {
    expect(issuePathToStepIndex('answers.basics.projectName')).toBe(0);
    expect(issuePathToStepIndex('answers.scale.regions')).toBe(1);
    expect(issuePathToStepIndex('answers.budget.teamSize')).toBe(2);
    expect(issuePathToStepIndex('answers.stack.frontend')).toBe(3);
    expect(issuePathToStepIndex('answers.dataModel.entities')).toBe(4);
    expect(issuePathToStepIndex('answers.auth.authRequired')).toBe(5);
    expect(issuePathToStepIndex('answers.integrations.integrations')).toBe(6);
  });

  it('stays in sync with STEP_ORDER (not a hand-written table)', () => {
    STEP_ORDER.forEach((key, i) => {
      expect(issuePathToStepIndex(`answers.${key}.someField`)).toBe(i);
    });
  });

  it('returns -1 for an unmappable path', () => {
    expect(issuePathToStepIndex('answers.bogus.x')).toBe(-1);
  });
});

describe('fieldFromIssuePath', () => {
  it('extracts the field within the step', () => {
    expect(fieldFromIssuePath('answers.scale.regions')).toBe('regions');
    expect(fieldFromIssuePath('answers.dataModel.entities.0.name')).toBe('entities');
    expect(fieldFromIssuePath('scale.uptimeTargetPercent')).toBe('uptimeTargetPercent');
  });

  it('returns null when there is no field segment', () => {
    expect(fieldFromIssuePath('answers.scale')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* mapServerIssues                                                            */
/* -------------------------------------------------------------------------- */

describe('mapServerIssues', () => {
  it('groups issues by step and reports the earliest offending step index', () => {
    const result = mapServerIssues([
      { path: 'answers.integrations.notes', message: 'Too long' },
      { path: 'answers.scale.regions', message: 'Required' },
      { path: 'answers.scale.peakRequestsPerSecond', message: 'Expected number' },
    ]);

    expect(result.byStep.scale).toEqual({
      regions: 'Required',
      peakRequestsPerSecond: 'Expected number',
    });
    expect(result.byStep.integrations).toEqual({ notes: 'Too long' });
    // scale (index 1) is earlier than integrations (index 6).
    expect(result.firstStepIndex).toBe(1);
    expect(result.unmapped).toEqual([]);
  });

  it('keeps the first message per field', () => {
    const result = mapServerIssues([
      { path: 'answers.basics.projectName', message: 'first' },
      { path: 'answers.basics.projectName', message: 'second' },
    ]);
    expect(result.byStep.basics).toEqual({ projectName: 'first' });
  });

  it('collects unmappable issues rather than dropping them', () => {
    const result = mapServerIssues([
      { path: 'answers.bogus.field', message: 'weird' },
      { path: 'answers.basics.oneLiner', message: 'Required' },
    ]);
    expect(result.byStep.basics).toEqual({ oneLiner: 'Required' });
    expect(result.unmapped).toEqual([{ path: 'answers.bogus.field', message: 'weird' }]);
    expect(result.firstStepIndex).toBe(0);
  });

  it('returns firstStepIndex -1 when nothing maps', () => {
    const result = mapServerIssues([{ path: 'answers', message: 'top-level' }]);
    expect(result.firstStepIndex).toBe(-1);
    expect(result.unmapped.length).toBe(1);
  });
});
