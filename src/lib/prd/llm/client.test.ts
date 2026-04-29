/**
 * Tests for the server-side Anthropic client (`callStructured`).
 *
 * Every test runs OFFLINE and FREE: `fetch` is stubbed with `vi.stubGlobal`, so
 * the real API is never contacted and the suite bills nothing. We assert both
 * the happy path and every failure mode's mapping onto `GenerationError.code`,
 * plus the retry/backoff behaviour (with faked timers so retries don't actually
 * sleep).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { callStructured } from '@/lib/prd/llm/client';
import { GenerationError } from '@/lib/prd/generation';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const outputSchema = z.object({ answer: z.string(), count: z.number() });

const baseOpts = {
  model: 'claude-haiku-4-5',
  system: 'You are a test.',
  messages: [{ role: 'user' as const, content: 'hi' }],
  toolName: 'emit',
  toolDescription: 'emit a result',
  jsonSchema: { type: 'object' },
  schema: outputSchema,
  maxTokens: 256,
};

/** Build a well-formed `tool_use` Messages response. */
function toolUseResponse(input: unknown, stopReason = 'tool_use') {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      stop_reason: stopReason,
      content: [{ type: 'tool_use', name: 'emit', input }],
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
    text: async () => '',
  } as unknown as Response;
}

function errorResponse(status: number, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => ({}),
    text: async () => `upstream body for ${status}`,
  } as unknown as Response;
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.ANTHROPIC_API_KEY;
});

/* -------------------------------------------------------------------------- */
/* Happy path                                                                 */
/* -------------------------------------------------------------------------- */

describe('callStructured — happy path', () => {
  it('returns typed, zod-validated data from a tool_use block', async () => {
    const payload = { answer: 'yes', count: 3 };
    const fetchMock = vi.fn().mockResolvedValue(toolUseResponse(payload));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callStructured({ ...baseOpts });

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Forced tool use is actually requested, and headers are correct.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('test-key-not-real');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit' });
    expect(body.tools[0].name).toBe('emit');
  });

  it('never logs the API key or prompt/response content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(toolUseResponse({ answer: 'x', count: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await callStructured({ ...baseOpts, system: 'SECRET-SYSTEM-PROMPT' });

    const logged = infoSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(logged).not.toContain('test-key-not-real');
    expect(logged).not.toContain('SECRET-SYSTEM-PROMPT');
    // But it does log tokens + latency.
    expect(logged).toContain('output_tokens');
  });
});

/* -------------------------------------------------------------------------- */
/* not_configured                                                             */
/* -------------------------------------------------------------------------- */

describe('callStructured — not_configured', () => {
  it('throws not_configured when the key is missing (no fetch)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(callStructured({ ...baseOpts })).rejects.toMatchObject({
      code: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 401 to not_configured and does not retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callStructured({ ...baseOpts })).rejects.toMatchObject({
      code: 'not_configured',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps 403 to not_configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(403));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callStructured({ ...baseOpts })).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('never leaks the upstream error body into the thrown message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    const err = await callStructured({ ...baseOpts }).catch((e) => e as GenerationError);
    expect(err).toBeInstanceOf(GenerationError);
    expect((err as GenerationError).message).not.toContain('upstream body');
  });
});

/* -------------------------------------------------------------------------- */
/* Retry / unavailable                                                        */
/* -------------------------------------------------------------------------- */

describe('callStructured — retry on unavailable', () => {
  it('retries after a 429 and then succeeds', async () => {
    vi.useFakeTimers();
    const payload = { answer: 'recovered', count: 7 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(toolUseResponse(payload));
    vi.stubGlobal('fetch', fetchMock);

    const promise = callStructured({ ...baseOpts });
    // Flush the backoff timer(s).
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up as unavailable after 429 x3 (initial + 2 retries)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    const promise = callStructured({ ...baseOpts });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'unavailable' });
    await vi.runAllTimersAsync();
    await assertion;

    // 1 initial + MAX_RETRIES(2) = 3 total; never an unbounded loop.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries 5xx', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(toolUseResponse({ answer: 'ok', count: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = callStructured({ ...baseOpts });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ answer: 'ok', count: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network error then succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(toolUseResponse({ answer: 'net-ok', count: 2 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = callStructured({ ...baseOpts });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ answer: 'net-ok', count: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours retry-after when present', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(toolUseResponse({ answer: 'ok', count: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = callStructured({ ...baseOpts });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ answer: 'ok', count: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/* -------------------------------------------------------------------------- */
/* invalid_output (never retried)                                             */
/* -------------------------------------------------------------------------- */

describe('callStructured — invalid_output', () => {
  it('maps a missing tool_use block to invalid_output', async () => {
    const res = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'here is your answer' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
      text: async () => '',
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal('fetch', fetchMock);

    await expect(callStructured({ ...baseOpts })).rejects.toMatchObject({
      code: 'invalid_output',
    });
    // Not retried — one call only.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a schema-invalid tool input to invalid_output with zod issues', async () => {
    // `count` is a string, violating the schema.
    const fetchMock = vi.fn().mockResolvedValue(toolUseResponse({ answer: 'x', count: 'nope' }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await callStructured({ ...baseOpts }).catch((e) => e as GenerationError);
    expect(err).toBeInstanceOf(GenerationError);
    expect((err as GenerationError).code).toBe('invalid_output');
    expect((err as GenerationError).message).toContain('count');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps stop_reason max_tokens to invalid_output (truncated)', async () => {
    // Even with otherwise-valid-looking input, truncation means the JSON is
    // incomplete — treat as invalid_output.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(toolUseResponse({ answer: 'x', count: 1 }, 'max_tokens'));
    vi.stubGlobal('fetch', fetchMock);

    const err = await callStructured({ ...baseOpts }).catch((e) => e as GenerationError);
    expect((err as GenerationError).code).toBe('invalid_output');
    expect((err as GenerationError).message).toContain('truncated');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps an unexpected 4xx (e.g. 400) to invalid_output and does not retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callStructured({ ...baseOpts })).rejects.toMatchObject({
      code: 'invalid_output',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Cancellation                                                               */
/* -------------------------------------------------------------------------- */

describe('callStructured — cancellation', () => {
  it('does not call fetch when the signal is already aborted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(toolUseResponse({ answer: 'x', count: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      callStructured({ ...baseOpts, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an abort during fetch to unavailable and does NOT retry', async () => {
    // Signal is NOT pre-aborted (so the pre-send guard passes and fetch runs),
    // but the fetch itself rejects with an AbortError — simulating the request
    // being cancelled in flight. That must be terminal, not retried.
    const abortErr = new DOMException('Aborted', 'AbortError');
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(
      callStructured({ ...baseOpts, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    // Aborted → terminal, so no retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
