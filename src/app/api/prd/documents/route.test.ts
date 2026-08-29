import { beforeEach, describe, expect, it, vi } from 'vitest';

import { seedPrdDocuments } from '@/lib/prd/seed';

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  listUserPrdDocuments: vi.fn(),
  saveUserPrdDocument: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
}));

vi.mock('@/lib/prd/mongo-store', () => ({
  listUserPrdDocuments: mocks.listUserPrdDocuments,
  saveUserPrdDocument: mocks.saveUserPrdDocument,
}));

import { GET, POST } from './route';

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/prd/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.getAuthenticatedUser.mockReset();
  mocks.listUserPrdDocuments.mockReset();
  mocks.saveUserPrdDocument.mockReset();
});

describe('/api/prd/documents', () => {
  it('GET returns 401 for anonymous requests', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mocks.listUserPrdDocuments).not.toHaveBeenCalled();
  });

  it('GET lists only the authenticated user documents', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ id: 'user-123' });
    mocks.listUserPrdDocuments.mockResolvedValue([
      { id: 'prd_1', title: 'One', createdAt: '2026-08-29T00:00:00.000Z' },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(mocks.listUserPrdDocuments).toHaveBeenCalledWith('user-123');
    expect(await res.json()).toEqual({
      documents: [{ id: 'prd_1', title: 'One', createdAt: '2026-08-29T00:00:00.000Z' }],
    });
  });

  it('POST derives ownership from Supabase, not from the request body', async () => {
    const document = seedPrdDocuments(new Date('2026-08-29T12:00:00.000Z'))[0];
    mocks.getAuthenticatedUser.mockResolvedValue({ id: 'real-user' });
    mocks.saveUserPrdDocument.mockResolvedValue(document);

    const res = await POST(jsonRequest({ userId: 'attacker-user', document }));

    expect(res.status).toBe(200);
    expect(mocks.saveUserPrdDocument).toHaveBeenCalledWith('real-user', document);
  });

  it('POST rejects invalid document payloads before saving', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ id: 'user-123' });

    const res = await POST(jsonRequest({ document: { id: 'too-thin' } }));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_error');
    expect(mocks.saveUserPrdDocument).not.toHaveBeenCalled();
  });
});
