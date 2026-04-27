/**
 * InfraGenie — the LLM generation seam.
 *
 * This module defines the INTERFACE between the API routes and the Anthropic
 * generation pipeline. The architect owns this file (it is a contract); the
 * backend owns the implementation under `src/lib/prd/llm/`.
 *
 * Both entry points currently throw `not_implemented`. Backend replaces the
 * bodies — the signatures and error taxonomy must not change without an
 * architect sign-off comment on the board.
 */

import type {
  ArchitectureSection,
  BriefContext,
  ClarifyQuestion,
  PlanSection,
  PrdDocument,
  PrdSection,
  ProjectBrief,
} from '@/types/prd';

/* -------------------------------------------------------------------------- */
/* Model selection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Verified available on our key via `GET /v1/models` (2026-07-25).
 *
 * Defaults are deliberate, from a measured spike (~140 output tok/s):
 *   - clarify is short and latency-sensitive → the fast model.
 *   - generation is the product's core value → the strong model.
 * Override per-environment with `ANTHROPIC_MODEL` / `ANTHROPIC_CLARIFY_MODEL`.
 */
export const DEFAULT_GENERATION_MODEL = 'claude-sonnet-5';
export const DEFAULT_CLARIFY_MODEL = 'claude-haiku-4-5-20251001';

/* -------------------------------------------------------------------------- */
/* Error taxonomy                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The only error type the generation layer may throw. Routes map `code`
 * straight onto the HTTP error envelope, so every failure mode the client can
 * see is enumerated here.
 *
 * `cause` carries the underlying error for server-side logging ONLY. It must
 * never be serialised into a response — upstream messages can contain request
 * ids, org ids, and other detail we don't expose.
 */
export type GenerationErrorCode =
  | 'not_configured' // ANTHROPIC_API_KEY missing from the server env
  | 'unavailable' // upstream 429/5xx/timeout/refusal — retryable
  | 'invalid_output' // model output failed schema validation after retries
  | 'not_implemented'; // seam not yet filled in

export class GenerationError extends Error {
  readonly code: GenerationErrorCode;
  /** Which pipeline stage failed, for logs and metrics. */
  readonly stage?: 'clarify' | 'title' | 'prd' | 'architecture' | 'plan';

  constructor(
    code: GenerationErrorCode,
    message: string,
    options?: { stage?: GenerationError['stage']; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'GenerationError';
    this.code = code;
    this.stage = options?.stage;
  }
}

/* -------------------------------------------------------------------------- */
/* Progress reporting                                                         */
/* -------------------------------------------------------------------------- */

/** Pipeline stages in execution order, for progress UI. */
export const GENERATION_STAGES = ['prd', 'architecture', 'plan'] as const;
export type GenerationStage = (typeof GENERATION_STAGES)[number];

/**
 * Optional progress callback. Generation takes 30–60s across three calls, so
 * the pipeline reports stage transitions and the route may surface them.
 */
export type ProgressReporter = (stage: GenerationStage, status: 'start' | 'done') => void;

export interface GenerateOptions {
  /** Overrides `ANTHROPIC_MODEL`. Used by evals to compare models. */
  model?: string;
  onProgress?: ProgressReporter;
  signal?: AbortSignal;
}

/* -------------------------------------------------------------------------- */
/* Stage-level interfaces (backend implements each in its own module)         */
/* -------------------------------------------------------------------------- */

export interface StageContext {
  brief: ProjectBrief;
  model: string;
  signal?: AbortSignal;
}

/** Stage 1 — reason out the product requirements from the idea. */
export type GeneratePrdStage = (ctx: StageContext) => Promise<PrdSection>;

/** Stage 2 — infer the data model and architecture. Sees stage 1's output. */
export type GenerateArchitectureStage = (
  ctx: StageContext & { prd: PrdSection },
) => Promise<ArchitectureSection>;

/** Stage 3 — break the work down. Sees stages 1 and 2. */
export type GeneratePlanStage = (
  ctx: StageContext & { prd: PrdSection; architecture: ArchitectureSection },
) => Promise<PlanSection>;

/* -------------------------------------------------------------------------- */
/* Public entry points                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Ask the model what it still needs to know. Returns 0–3 questions; **zero is
 * a valid and common answer** and callers must handle it by skipping the
 * clarifier step entirely rather than showing an empty screen.
 *
 * @throws {GenerationError}
 */
export async function generateClarifyingQuestions(
  _idea: string,
  _context: BriefContext,
  _options?: { model?: string; signal?: AbortSignal },
): Promise<ClarifyQuestion[]> {
  throw new GenerationError(
    'not_implemented',
    'Clarifying-question generation is not implemented yet.',
    { stage: 'clarify' },
  );
}

/**
 * Run the full three-stage pipeline and assemble a validated `PrdDocument`.
 *
 * Implementation contract for the backend:
 *   1. Run the three stages in order, feeding each the previous outputs.
 *   2. Derive `diagramMermaid`, `criticalPath`, `totalEstimateHours` and
 *      `estimatedCalendarWeeks` with `src/lib/prd/derive` — never from the
 *      model.
 *   3. Repair the dependency graph before deriving (`repairDependencyGraph`).
 *   4. Parse the assembled document with `prdDocumentSchema` and throw
 *      `invalid_output` if it fails. The floors in the schema are the gate.
 *   5. `id` and `createdAt` are injected by the caller-supplied values so the
 *      pipeline stays free of ambient clock/randomness.
 *
 * @throws {GenerationError}
 */
export async function generatePrdDocument(
  _brief: ProjectBrief,
  _id: string,
  _createdAt: string,
  _options?: GenerateOptions,
): Promise<PrdDocument> {
  throw new GenerationError('not_implemented', 'PRD generation is not implemented yet.', {
    stage: 'prd',
  });
}
