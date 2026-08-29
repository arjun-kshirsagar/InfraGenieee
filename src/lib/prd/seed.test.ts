import { describe, expect, it } from 'vitest';

import { seedPrdDocuments } from '@/lib/prd/seed';
import { prdDocumentSchema } from '@/types/prd';

describe('seedPrdDocuments', () => {
  it('returns schema-valid sample PRDs for account seeding', () => {
    const docs = seedPrdDocuments(new Date('2026-08-29T12:00:00.000Z'));

    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      expect(prdDocumentSchema.safeParse(doc).success).toBe(true);
      expect(doc.id).toMatch(/^prd_seed_/);
      expect(doc.architecture.apiEndpoints.some((endpoint) => endpoint.authRequired)).toBe(true);
    }
  });
});
