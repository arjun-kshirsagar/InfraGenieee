/**
 * Tests for GET /api/cost/catalog.
 *
 * OFFLINE and FREE: the catalog is a checked-in static module — no upstream
 * calls, no keys, nothing billed. We cover the full contract from
 * docs/api-contracts.md §GET /api/cost/catalog:
 *   - 200 with a body that parses against `catalogResponseSchema`
 *   - the catalog itself parses against `serviceCatalogSchema` (the self-check)
 *   - the route cannot 503 (no upstream calls)
 */

import { describe, expect, it } from 'vitest';

import { catalogResponseSchema, serviceCatalogSchema } from '@/types/cost';
import { GET } from './route';

describe('GET /api/cost/catalog', () => {
  it('returns 200 with a schema-valid catalog body', async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    // Every 200 body parses against the response schema — the contract.
    expect(catalogResponseSchema.safeParse(body).success).toBe(true);
    // And the catalog inside it is itself valid.
    expect(serviceCatalogSchema.safeParse(body.catalog).success).toBe(true);
  });

  it('serves a non-empty catalog with all five providers represented', async () => {
    const res = await GET();
    const body = await res.json();

    const providers = new Set(body.catalog.services.map((s: { provider: string }) => s.provider));
    expect(providers).toEqual(new Set(['aws', 'gcp', 'azure', 'vercel', 'digitalocean']));
    expect(body.catalog.services.length).toBeGreaterThan(0);
  });

  it('carries no prices in the catalog (structure only)', async () => {
    const res = await GET();
    const body = await res.json();
    // A price would show up as a numeric field on a SKU/dimension; the catalog
    // must never carry one. The evidence: no `unitPriceUsd` key anywhere.
    expect(JSON.stringify(body)).not.toContain('unitPriceUsd');
  });
});
