/**
 * InfraGenie — server-side Anthropic Messages client.
 *
 * SERVER-ONLY. This module reads `ANTHROPIC_API_KEY` and must NEVER be imported
 * by a client component or reached from anything that ships to the browser. It
 * is used only through route handlers (`src/app/api/prd/**`) via the generation
 * pipeline.
 *
 * It exposes a single primitive — `callStructured` — a small typed wrapper
 * around POST /v1/messages that returns **schema-validated structured output**
 * via forced tool use:
 *
 *     tools: [{ name, description, input_schema: <JSON Schema> }]
 *     tool_choice: { type: 'tool', name }
 *
 * The response carries a `tool_use` content block whose `.input` is JSON that
 * matches the schema, with `stop_reason: 'tool_use'`. We validate that `.input`
 * with a zod schema before returning it. We NEVER parse prose or fenced JSON
 * out of a text block — that is the failure mode this design exists to avoid.
 *
 * No SDK dependency: `fetch` keeps the dependency surface (and the bundle) small.
 *
 * Error taxonomy (all failures become `GenerationError`, from generation.ts):
 *   - 401/403                         → not_configured
 *   - 429 / 5xx / network / timeout   → unavailable  (retried, see below)
 *   - abort via `signal`              → unavailable  (NOT retried)
 *   - stop_reason === 'max_tokens'    → invalid_output (truncated → bad JSON)
 *   - no tool_use block               → invalid_output
 *   - .input fails the zod schema     → invalid_output (issues logged, not returned)
 *
 * Retry policy: only `unavailable` (429/5xx/network) is retried — at most 2
 * retries, exponential backoff (~1s, ~2s), honouring `retry-after` when the
 * upstream sends it. `invalid_output` and `not_configured` are NEVER retried
 * here: schema retries are a semantic concern owned by the stages, not a
 * mechanical one. There is no unbounded loop — the retry count is a hard cap.
 */

import type { z } from 'zod';

import { GenerationError, type GenerationError as GenerationErrorType } from '@/lib/prd/generation';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Only `unavailable` is retried, and only this many times. Hard cap — no loop. */
const MAX_RETRIES = 2;
/** Base backoff in ms; attempt N (0-indexed) waits BASE * 2**N → ~1s, ~2s. */
const BACKOFF_BASE_MS = 1000;
/** A `retry-after` larger than this is clamped so a hostile header can't hang us. */
const MAX_RETRY_AFTER_MS = 10_000;

type StageName = NonNullable<GenerationErrorType['stage']>;

export interface CallStructuredOptions<T> {
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Forced-tool name; also logged as the stage label. */
  toolName: string;
  toolDescription: string;
  /** JSON Schema for the tool's `input_schema`. Shape the model must emit. */
  jsonSchema: Record<string, unknown>;
  /** Validates `tool_use.input` before it is returned. */
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Cancellation. Aborting maps to `unavailable` and is not retried. */
  signal?: AbortSignal;
  /** Optional stage label for logs/errors; defaults to `toolName`. */
  stage?: StageName;
}

/** The subset of the Messages response we read. */
interface AnthropicMessageResponse {
  stop_reason?: string;
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; name: string; input: unknown }
    | { type: string; [k: string]: unknown }
  >;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const isAbortError = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Parse a `retry-after` header. Anthropic sends seconds; be liberal and also
 * accept an HTTP-date. Returns a clamped delay in ms, or null if unparseable.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(asSeconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(asDate - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return null;
}

/**
 * One HTTP attempt. Returns the parsed response on success. On a retryable
 * condition it throws a `GenerationError('unavailable')` carrying the suggested
 * backoff on `.retryAfterMs`; on a terminal condition it throws the final
 * `GenerationError` directly (which the caller does not retry).
 */
async function attempt<T>(
  opts: CallStructuredOptions<T>,
  stage: StageName,
): Promise<{ response: AnthropicMessageResponse; startedAt: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Re-checked per attempt is cheap and keeps the key read local to server code.
  if (!apiKey) {
    throw new GenerationError(
      'not_configured',
      'ANTHROPIC_API_KEY is not set in the server environment.',
      { stage },
    );
  }

  const body = JSON.stringify({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    max_tokens: opts.maxTokens,
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: opts.jsonSchema,
      },
    ],
    tool_choice: { type: 'tool', name: opts.toolName },
  });

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body,
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbortError(err) || opts.signal?.aborted) {
      // Caller cancelled — surface as unavailable, but do NOT retry (the caller
      // distinguishes abort from a transient failure and stops).
      const e = new GenerationError('unavailable', 'Request was aborted.', { stage, cause: err });
      (e as GenerationError & { aborted?: boolean }).aborted = true;
      throw e;
    }
    // Network/DNS/connection error — retryable.
    const e = new GenerationError('unavailable', 'Network error contacting Anthropic.', {
      stage,
      cause: err,
    });
    (e as GenerationError & { retryAfterMs?: number | null }).retryAfterMs = null;
    throw e;
  }

  if (!res.ok) {
    // Drain the body for server logs only; it can carry request/org ids so it is
    // never returned to the client.
    const errText = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new GenerationError(
        'not_configured',
        `Anthropic rejected the API key (HTTP ${res.status}).`,
        { stage, cause: errText || undefined },
      );
    }
    if (res.status === 429 || res.status >= 500) {
      const e = new GenerationError(
        'unavailable',
        `Anthropic returned HTTP ${res.status}.`,
        { stage, cause: errText || undefined },
      );
      (e as GenerationError & { retryAfterMs?: number | null }).retryAfterMs = parseRetryAfter(
        res.headers.get('retry-after'),
      );
      throw e;
    }
    // Any other 4xx (400/404/422 …) is a bug in our request, not a transient
    // fault. Not retryable; treat as invalid_output so it surfaces clearly.
    throw new GenerationError(
      'invalid_output',
      `Anthropic returned an unexpected HTTP ${res.status}.`,
      { stage, cause: errText || undefined },
    );
  }

  let json: AnthropicMessageResponse;
  try {
    json = (await res.json()) as AnthropicMessageResponse;
  } catch (err) {
    // A 200 with an unreadable body is treated as transient.
    const e = new GenerationError('unavailable', 'Could not parse the Anthropic response body.', {
      stage,
      cause: err,
    });
    (e as GenerationError & { retryAfterMs?: number | null }).retryAfterMs = null;
    throw e;
  }

  return { response: json, startedAt };
}

/**
 * Validate a successful response and return the typed, schema-checked payload.
 * All failures here are terminal `invalid_output` (never retried mechanically).
 */
function extractAndValidate<T>(
  response: AnthropicMessageResponse,
  opts: CallStructuredOptions<T>,
  stage: StageName,
): T {
  // Truncated output → the JSON in the tool_use block is incomplete.
  if (response.stop_reason === 'max_tokens') {
    throw new GenerationError(
      'invalid_output',
      `Output truncated at max_tokens (${opts.maxTokens}); the structured JSON is incomplete. ` +
        'Raise maxTokens for this stage or reduce what it must emit.',
      { stage },
    );
  }

  const toolUse = response.content?.find(
    (block): block is { type: 'tool_use'; name: string; input: unknown } =>
      block.type === 'tool_use',
  );
  if (!toolUse) {
    throw new GenerationError(
      'invalid_output',
      `No tool_use block in the response (stop_reason: ${response.stop_reason ?? 'unknown'}). ` +
        'The model did not call the forced tool.',
      { stage },
    );
  }

  const parsed = opts.schema.safeParse(toolUse.input);
  if (!parsed.success) {
    // Zod issues go to server logs (via the error message) — they describe the
    // SHAPE of the model output, not user data, so they are safe to log. They
    // must still never be returned raw to the client; the route maps `code`.
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new GenerationError(
      'invalid_output',
      `Model output failed schema validation for tool "${opts.toolName}": ${issues}`,
      { stage },
    );
  }

  return parsed.data;
}

/**
 * Call the Anthropic Messages API with forced tool use and return typed,
 * zod-validated structured output.
 *
 * @throws {GenerationError} with `code` set per the taxonomy above.
 */
export async function callStructured<T>(opts: CallStructuredOptions<T>): Promise<T> {
  const stage: StageName = opts.stage ?? (opts.toolName as StageName);

  let lastError: unknown;
  // attempt 0 = first try; attempts 1..MAX_RETRIES = retries. Hard-bounded.
  for (let attemptNo = 0; attemptNo <= MAX_RETRIES; attemptNo++) {
    if (opts.signal?.aborted) {
      throw new GenerationError('unavailable', 'Request was aborted before sending.', { stage });
    }

    try {
      const { response, startedAt } = await attempt(opts, stage);
      const latencyMs = Date.now() - startedAt;

      // Usage logging: model, stage, tokens, latency — NEVER prompt or response
      // content (both can be large and contain user data).
      console.info(
        '[prd.llm] model=%s stage=%s input_tokens=%d output_tokens=%d latency_ms=%d attempt=%d',
        opts.model,
        stage,
        response.usage?.input_tokens ?? 0,
        response.usage?.output_tokens ?? 0,
        latencyMs,
        attemptNo,
      );

      // Validation failures are terminal — thrown out of the retry loop.
      return extractAndValidate(response, opts, stage);
    } catch (err) {
      // Only `unavailable` is retryable, and aborts never are.
      const isGen = err instanceof GenerationError;
      const aborted =
        (isGen && (err as GenerationError & { aborted?: boolean }).aborted) ||
        opts.signal?.aborted;
      const retryable = isGen && (err as GenerationError).code === 'unavailable' && !aborted;

      if (!retryable || attemptNo === MAX_RETRIES) {
        throw err;
      }

      lastError = err;
      const suggested = (err as GenerationError & { retryAfterMs?: number | null }).retryAfterMs;
      const backoff =
        typeof suggested === 'number' && suggested >= 0
          ? suggested
          : BACKOFF_BASE_MS * 2 ** attemptNo;

      console.info(
        '[prd.llm] retrying stage=%s attempt=%d after_ms=%d reason=unavailable',
        stage,
        attemptNo + 1,
        backoff,
      );

      try {
        await sleep(backoff, opts.signal);
      } catch {
        // Aborted while backing off.
        throw new GenerationError('unavailable', 'Request was aborted during backoff.', {
          stage,
          cause: lastError,
        });
      }
    }
  }

  // Unreachable — the loop either returns or throws. Kept for exhaustiveness.
  throw lastError instanceof Error
    ? lastError
    : new GenerationError('unavailable', 'Anthropic call failed after retries.', { stage });
}
