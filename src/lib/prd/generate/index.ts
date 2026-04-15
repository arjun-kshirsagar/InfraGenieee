/**
 * PRD generator — top-level composition.
 *
 * Composes the three deterministic section generators (prd / architecture /
 * plan) into a single `PrdDocument`. Pure and deterministic: `id` and
 * `createdAt` are INJECTED, never generated here, so the same answers + same
 * id + same createdAt always produce a `toEqual`-identical document
 * (docs/architecture.md §3 rule 3; docs/api-contracts.md guarantee #1).
 *
 * Owned by: backend. Consumed by: `src/app/api/prd/generate/route.ts`.
 */

import type { PrdDocument, QuestionnaireAnswers } from '@/types/prd';
import { GENERATOR_VERSION } from '@/types/prd';
import { generatePrdSection } from './prd';
import { generateArchitectureSection } from './architecture';
import { generatePlanSection } from './plan';

/**
 * Build a complete PrdDocument from completed questionnaire answers.
 *
 * @param answers   Validated questionnaire answers. Echoed back verbatim
 *                  (contract guarantee #2) — never mutated.
 * @param id        Document id (`prd_` + 12 base36 chars). Injected by the
 *                  caller so this function stays pure.
 * @param createdAt ISO-8601 timestamp. Injected by the caller.
 */
export function generatePrdDocument(
  answers: QuestionnaireAnswers,
  id: string,
  createdAt: string,
): PrdDocument {
  return {
    id,
    createdAt,
    generatorVersion: GENERATOR_VERSION,
    title: `${answers.basics.projectName} — Product Requirements Document`,
    answers,
    prd: generatePrdSection(answers),
    architecture: generateArchitectureSection(answers),
    plan: generatePlanSection(answers),
  };
}
