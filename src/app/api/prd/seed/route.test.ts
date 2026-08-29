import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  saveUserPrdDocuments: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
}));

vi.mock('@/lib/prd/mongo-store', () => ({
  saveUserPrdDocuments: mocks.saveUserPrdDocuments,
}));

import { POST } from './route';

beforeEach(() => {
  mocks.getAuthenticatedUser.mockReset();
  mocks.saveUserPrdDocuments.mockReset();
});

describe('POST /api/prd/seed', () => {
  it('returns 401 for anonymous requests', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);

    const res = await POST();

    expect(res.status).toBe(401);
    expect(mocks.saveUserPrdDocuments).not.toHaveBeenCalled();
  });

  it('saves seed PRDs for the authenticated user', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ id: 'user-123' });
    mocks.saveUserPrdDocuments.mockResolvedValue([
      { id: 'prd_seed_auth_mongo_prd', title: 'Authenticated PRD Workspace', createdAt: '2026-08-29T00:00:00.000Z' },
    ]);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(mocks.saveUserPrdDocuments).toHaveBeenCalledTimes(1);
    expect(mocks.saveUserPrdDocuments.mock.calls[0][0]).toBe('user-123');
    expect(mocks.saveUserPrdDocuments.mock.calls[0][1]).toHaveLength(2);
    expect(await res.json()).toEqual({
      documents: [
        { id: 'prd_seed_auth_mongo_prd', title: 'Authenticated PRD Workspace', createdAt: '2026-08-29T00:00:00.000Z' },
      ],
    });
  });
});
