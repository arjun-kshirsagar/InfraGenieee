/**
 * InfraGenie — pure, DOM-free logic for the generate submit (Feature 1, F3).
 *
 * This module owns everything about the generate step that is *logic* rather
 * than *rendering*:
 *
 *   - calling `POST /api/prd/generate` with NO short client timeout (the route
 *     sets `maxDuration = 300`; three sequential LLM calls take 30–60s),
 *   - classifying the result into a discriminated `GenerateOutcome`,
 *   - mapping each contract error `code` to a distinct, honest message and a
 *     retryability flag (the F3 error table),
 *   - the staged-progress timed heuristic that keeps the wait from feeling like
 *     a dead spinner (the route exposes no progress stream), and
 *   - the save-then-clear-draft-then-navigate success sequence, injectable so it
 *     can be unit-tested offline without touching localStorage or a router.
 *
 * Keeping it here (a) lets the vitest `node` environment test the behaviour
 * without a DOM, and (b) keeps the client component focused on wiring.
 *
 * ## Guarantees that matter most
 *
 * 1. **Never lose the user's brief.** `fetchGenerate` does not mutate storage;
 *    on any failure the caller still holds the brief (and it is still in the
 *    draft), so retry is one click with zero retyping.
 * 2. **No short timeout.** We pass the caller's `AbortSignal` straight through
 *    and impose none of our own. An abort is the only way this rejects.
 * 3. **Distinct message per code.** `mapGenerateError` returns a different
 *    message and the correct retryability for every code in the contract, so
 *    the UI can present an honest dead-end vs. a one-click retry vs. back-to-form.
 */

import {
  generateResponseSchema,
  apiErrorSchema,
  type ApiErrorCode,
  type PrdDocument,
  type ProjectBrief,
} from '@/types/prd';

export const GENERATE_ENDPOINT = '/api/prd/generate';

/* -------------------------------------------------------------------------- */
/* Error-code → message + retryability mapping (the F3 error table)           */
/* -------------------------------------------------------------------------- */

/**
 * How a failed generation should be presented. `retryable` drives whether the
 * UI shows a one-click Retry (the brief is preserved either way). `backToForm`
 * means the brief itself is the problem — send the user back to edit it.
 */
export interface GenerateErrorPresentation {
  /** The contract error code, or `'network'` for a transport-level failure. */
  code: ApiErrorCode | 'network';
  /** Honest, user-facing message. Never contains upstream/LLM error text. */
  message: string;
  /** Show a Retry button? Retry re-submits the same, still-present brief. */
  retryable: boolean;
  /**
   * Should the user be sent back to the form to fix their input? Only true for
   * `validation_error` — the brief failed the request schema.
   */
  backToForm: boolean;
}

/**
 * Map a contract error `code` (or a transport `'network'` failure) to a
 * distinct message + retryability. This is the pure heart of the F3 error
 * table and is unit-tested exhaustively.
 *
 * | code                | retry | back-to-form | gist                                   |
 * |---------------------|-------|--------------|----------------------------------------|
 * | llm_unavailable     |  yes  |   no         | AI service busy — try again            |
 * | generation_failed   |  yes  |   no         | didn't produce a usable document       |
 * | llm_not_configured  |  no   |   no         | server misconfigured — not your fault  |
 * | validation_error    |  no   |   yes        | brief is invalid — go fix it           |
 * | bad_request         |  no   |   yes        | (shouldn't happen; treat like invalid) |
 * | internal_error      |  yes  |   no         | unexpected — retry is reasonable       |
 * | not_found           |  yes  |   no         | (n/a for generate; retry is harmless)  |
 * | network             |  yes  |   no         | request never completed — try again    |
 */
export function mapGenerateError(
  code: ApiErrorCode | 'network',
): GenerateErrorPresentation {
  switch (code) {
    case 'llm_unavailable':
      return {
        code,
        message: 'The AI service is busy right now. Your brief is saved — try again.',
        retryable: true,
        backToForm: false,
      };
    case 'llm_not_configured':
      return {
        code,
        message:
          "The generator isn't configured on this server. This is a setup problem on our " +
          'end, not something you did — please reach out so we can fix it.',
        retryable: false,
        backToForm: false,
      };
    case 'generation_failed':
      return {
        code,
        message:
          "Generation didn't produce a usable document. This can happen with an unusual " +
          'brief — your brief is saved, so you can try again or tweak it first.',
        retryable: true,
        backToForm: false,
      };
    case 'validation_error':
      return {
        code,
        message:
          "Your brief didn't pass validation. Head back to the form to fix the highlighted " +
          'issues, then generate again.',
        retryable: false,
        backToForm: true,
      };
    case 'bad_request':
      // The client always sends well-formed JSON, so this is not expected in
      // practice. Treat it like a validation problem: the request body was the
      // issue, so send the user back to the form rather than looping a retry.
      return {
        code,
        message:
          'Something about the request was malformed. Head back to the form and try again.',
        retryable: false,
        backToForm: true,
      };
    case 'internal_error':
      return {
        code,
        message:
          'Something went wrong on our end. Your brief is saved — please try again in a moment.',
        retryable: true,
        backToForm: false,
      };
    case 'not_found':
      // Not reachable from /generate, but the enum includes it. Retry is a safe
      // default and never loses the brief.
      return {
        code,
        message: 'The generator endpoint could not be reached. Your brief is saved — try again.',
        retryable: true,
        backToForm: false,
      };
    case 'network':
    default:
      return {
        code: 'network',
        message:
          "The request didn't complete — this is usually a connection hiccup. Your brief is " +
          'saved, so just try again.',
        retryable: true,
        backToForm: false,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Calling the generator                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Result of a generate call, as a discriminated union:
 *
 *   - `ok`       — a schema-valid `PrdDocument` ready to save + show.
 *   - `error`    — a classified failure carrying the presentation from
 *                  `mapGenerateError` plus any server-provided `issues`.
 *
 * There is no `aborted` variant: an abort rejects the promise (the caller
 * initiated it, so it knows what to do). Every other failure resolves to
 * `error` — the function does not throw for HTTP or contract failures.
 */
export type GenerateOutcome =
  | { kind: 'ok'; document: PrdDocument }
  | {
      kind: 'error';
      presentation: GenerateErrorPresentation;
      issues?: { path: string; message: string }[];
    };

export interface FetchGenerateOptions {
  /** Forwarded to `fetch`. The ONLY way this call is cancelled — we impose no
   *  timeout of our own (generation legitimately takes 30–60s). */
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Was this thrown value an abort (user cancelled / navigated away)? */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException
      ? err.name === 'AbortError'
      : typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
  );
}

/**
 * Call `POST /api/prd/generate` and classify the result. Rejects ONLY on abort;
 * every other failure — non-2xx, network error, malformed JSON, off-contract
 * body — resolves to `{ kind: 'error' }` with a mapped presentation.
 *
 * We deliberately do NOT set a timeout. The route's `maxDuration` is 300s and
 * three sequential model calls take 30–60s; a short client timeout would abort
 * a perfectly healthy generation.
 */
export async function fetchGenerate(
  brief: ProjectBrief,
  options: FetchGenerateOptions = {},
): Promise<GenerateOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(GENERATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief }),
      signal: options.signal,
    });
  } catch (err) {
    // An abort is the caller's own doing — re-throw so it can distinguish
    // "user cancelled" from "generation failed".
    if (isAbortError(err)) throw err;
    // Network error / DNS / connection reset — transport failure, retryable.
    return { kind: 'error', presentation: mapGenerateError('network') };
  }

  if (!response.ok) {
    // Try to read the contract error envelope so we can map the specific code.
    // If the body is missing or off-contract, fall back to inferring from the
    // HTTP status (503 → unavailable, 400 → validation, else generation_failed).
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      return {
        kind: 'error',
        presentation: mapGenerateError(parsed.data.error.code),
        ...(parsed.data.error.issues ? { issues: parsed.data.error.issues } : {}),
      };
    }

    return { kind: 'error', presentation: mapGenerateError(statusToCode(response.status)) };
  }

  // 200 — must carry a schema-valid { document }.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A 200 with a non-JSON / truncated body: treat as a failed generation the
    // user can retry.
    return { kind: 'error', presentation: mapGenerateError('generation_failed') };
  }

  const parsed = generateResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: 'error', presentation: mapGenerateError('generation_failed') };
  }

  return { kind: 'ok', document: parsed.data.document };
}

/**
 * Best-effort mapping from an HTTP status to a contract code, used only when
 * the error body is missing or off-contract. Keeps a bad-body 503 honest as
 * "busy, retry" rather than a generic failure.
 */
function statusToCode(status: number): ApiErrorCode | 'network' {
  if (status === 503) return 'llm_unavailable';
  if (status === 400) return 'validation_error';
  if (status === 404) return 'not_found';
  return 'generation_failed';
}

/* -------------------------------------------------------------------------- */
/* Staged progress — timed heuristic (no progress stream from the route)      */
/* -------------------------------------------------------------------------- */

/**
 * One stage of the progress display. `atMs` is the elapsed time at which this
 * stage becomes the current one. The three real pipeline stages mirror the
 * backend (prd → architecture → plan); a final "Finalizing" stage covers the
 * title call + TS derivation + save so the bar never sits at "done" while the
 * document is still being assembled.
 */
export interface ProgressStage {
  /** Elapsed ms at which this stage activates. */
  atMs: number;
  /** Short label, present-tense. */
  label: string;
  /** One-line reassurance shown under the label. */
  detail: string;
}

/**
 * The timed heuristic. Tuned to a ~45s median generation: the first three
 * stages roughly track the three model calls; "Finalizing" holds from ~40s
 * onward so a slower run still shows forward-looking copy rather than a stuck
 * bar. These are cues, not promises — the real completion is the fetch
 * resolving, never a timer.
 */
export const PROGRESS_STAGES: readonly ProgressStage[] = [
  {
    atMs: 0,
    label: 'Writing requirements…',
    detail: 'Turning your idea into goals, user stories and requirements.',
  },
  {
    atMs: 15_000,
    label: 'Designing architecture…',
    detail: 'Choosing components, a data model and infrastructure for your scale.',
  },
  {
    atMs: 30_000,
    label: 'Breaking down the plan…',
    detail: 'Sequencing milestones and tasks with dependencies.',
  },
  {
    atMs: 42_000,
    label: 'Finalizing your document…',
    detail: 'Naming it, drawing the diagram and computing the timeline.',
  },
] as const;

/** The index of the active progress stage for a given elapsed time. */
export function progressStageIndexAt(
  elapsedMs: number,
  stages: readonly ProgressStage[] = PROGRESS_STAGES,
): number {
  let index = 0;
  for (let i = 0; i < stages.length; i += 1) {
    if (elapsedMs >= stages[i].atMs) index = i;
    else break;
  }
  return index;
}

/** The active progress stage for a given elapsed time. */
export function progressStageAt(
  elapsedMs: number,
  stages: readonly ProgressStage[] = PROGRESS_STAGES,
): ProgressStage {
  return stages[progressStageIndexAt(elapsedMs, stages)];
}

/**
 * A smooth 0–95% progress value for the given elapsed time. Never reaches 100%
 * on a timer — only a resolved generation completes the bar — so the UI cannot
 * imply "done" while work is still happening. `expectedMs` is the point the
 * bar approaches (but never hits) 95%.
 */
export function progressFractionAt(elapsedMs: number, expectedMs = 45_000): number {
  if (elapsedMs <= 0) return 0.02;
  // Asymptotic approach to 0.95: fast at first, slowing as it nears the cap.
  const raw = 0.95 * (1 - Math.exp(-elapsedMs / (expectedMs / 2)));
  return Math.min(0.95, Math.max(0.02, raw));
}

/* -------------------------------------------------------------------------- */
/* Success sequence: save → clearDraft → navigate                            */
/* -------------------------------------------------------------------------- */

/** Injectable side-effects for {@link saveAndRoute}, so it is unit-testable. */
export interface SaveAndRouteDeps {
  save: (doc: PrdDocument) => void;
  clearDraft: () => void;
  navigate: (path: string) => void;
}

/**
 * Build the document route for an id. Kept as a function so tests and the
 * component share one source of truth.
 */
export function documentPath(id: string): string {
  return `/prd/${id}`;
}

/**
 * The success sequence, in the one correct order:
 *
 *   1. `save(document)`   — persist first, so the target route can load it.
 *   2. `clearDraft()`     — the brief is now embodied in a saved document.
 *   3. `navigate(/prd/id)`— send the user to their document.
 *
 * Order matters: navigating before saving would land on a "not found" page,
 * and clearing the draft before a successful save would risk losing the brief.
 * Returns the path navigated to.
 */
export function saveAndRoute(document: PrdDocument, deps: SaveAndRouteDeps): string {
  deps.save(document);
  deps.clearDraft();
  const path = documentPath(document.id);
  deps.navigate(path);
  return path;
}
