/**
 * InfraGenie — pure formatter turning a raw draft answer into a human-readable
 * string for the review summary (F3). No React / DOM imports, so it's unit
 * testable in vitest's `node` env.
 *
 * Driven entirely by the `QuestionDef`: `select`/`multi-select` values are mapped
 * to their option labels; booleans → Yes/No; arrays → comma-joined; the
 * entity-builder → an entity/field count summary; empty answers → an em dash.
 */

import type { QuestionDef, Entity } from '@/types/prd';

const EMPTY = '—';

/** Map an option value to its label using the question's `options`. */
function optionLabel(question: QuestionDef, value: string): string {
  const opt = question.options?.find((o) => o.value === value);
  return opt ? opt.label : value;
}

export function formatAnswerValue(question: QuestionDef, value: unknown): string {
  if (value === undefined || value === null) return EMPTY;

  switch (question.kind) {
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : EMPTY;

    case 'select':
      return typeof value === 'string' && value !== ''
        ? optionLabel(question, value)
        : EMPTY;

    case 'multi-select': {
      if (!Array.isArray(value) || value.length === 0) return EMPTY;
      return value.map((v) => optionLabel(question, String(v))).join(', ');
    }

    case 'tag-list': {
      if (!Array.isArray(value) || value.length === 0) return EMPTY;
      return value.map((v) => String(v)).join(', ');
    }

    case 'entity-builder': {
      if (!Array.isArray(value) || value.length === 0) return EMPTY;
      const entities = value as Entity[];
      return entities
        .map((e) => {
          const fieldCount = Array.isArray(e.fields) ? e.fields.length : 0;
          const name = e.name?.trim() || '(unnamed)';
          return `${name} (${fieldCount} field${fieldCount === 1 ? '' : 's'})`;
        })
        .join(', ');
    }

    case 'number':
      return typeof value === 'number' ? String(value) : EMPTY;

    case 'text':
    case 'textarea':
    default: {
      const s = typeof value === 'string' ? value.trim() : String(value);
      return s === '' ? EMPTY : s;
    }
  }
}
