/**
 * Route test for POST /api/prd/generate.
 *
 * Imports the `POST` handler directly and calls it with a constructed
 * `Request` — no dev server needed. Covers the three documented outcomes:
 *   - 200 happy path with a schema-valid { document }
 *   - 400 validation_error with a populated issues[] on invalid answers
 *   - 400 bad_request on a malformed JSON body
 */

import { describe, expect, it } from 'vitest';
import { POST } from './route';
import { generateResponseSchema } from '@/types/prd';
import { VALID_ANSWERS } from '@/types/prd.test';

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/prd/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/prd/generate — 200 happy path', () => {
  it('returns 200 and a schema-valid { document }', async () => {
    const res = await POST(jsonRequest({ answers: VALID_ANSWERS }));
    expect(res.status).toBe(200);

    const payload = await res.json();
    const parsed = generateResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(true);

    const { document } = parsed.data!;
    expect(document.id).toMatch(/^prd_[0-9a-z]{12}$/);
    expect(document.answers).toEqual(VALID_ANSWERS);
    expect(document.title).toContain(VALID_ANSWERS.basics.projectName);
  });

  it('returns a fresh id on each call', async () => {
    const a = await (await POST(jsonRequest({ answers: VALID_ANSWERS }))).json();
    const b = await (await POST(jsonRequest({ answers: VALID_ANSWERS }))).json();
    expect(a.document.id).not.toBe(b.document.id);
  });
});

describe('POST /api/prd/generate — 400 validation_error', () => {
  it('returns 400 with a populated issues[] on invalid answers', async () => {
    // Missing required `basics` sub-fields → schema failure.
    const res = await POST(jsonRequest({ answers: { basics: {} } }));
    expect(res.status).toBe(400);

    const payload = await res.json();
    expect(payload.error.code).toBe('validation_error');
    expect(Array.isArray(payload.error.issues)).toBe(true);
    expect(payload.error.issues.length).toBeGreaterThan(0);
    expect(payload.error.issues[0]).toHaveProperty('path');
    expect(payload.error.issues[0]).toHaveProperty('message');
  });

  it('returns 400 when the top-level answers key is absent', async () => {
    const res = await POST(jsonRequest({ nope: true }));
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.code).toBe('validation_error');
    expect(payload.error.issues.length).toBeGreaterThan(0);
  });
});

describe('POST /api/prd/generate — 400 bad_request', () => {
  it('returns 400 bad_request on a malformed JSON body', async () => {
    const req = new Request('http://localhost/api/prd/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json ',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);

    const payload = await res.json();
    expect(payload.error.code).toBe('bad_request');
  });
});
