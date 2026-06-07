/**
 * GET /api/cost/catalog
 *
 * The provider/service/SKU structure that populates the Feature 2 selectors.
 * Contains NO prices — that separation is load-bearing (docs/feature-2-cost-
 * predictor.md): prices arrive separately via /api/cost/prices as fetched,
 * cited PriceRecords, and never inside the catalog.
 *
 * The handler contains NO business logic (docs/api-contracts.md §Conventions):
 * self-validate the checked-in catalog → respond. There are no upstream calls,
 * so this route cannot 503. A parse failure is our bug → `internal_error` (500).
 */

import { NextResponse } from 'next/server';

import { catalogResponseSchema, serviceCatalogSchema } from '@/types/cost';
import { apiError, ERROR_STATUS } from '@/lib/prd/api';
import { serviceCatalog } from '@/lib/cost/catalog';

// Deterministic, no upstream calls — safe to serve from the node runtime.
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  // Self-validate the checked-in catalog before responding, exactly as
  // /api/prd/generate self-validates its output. A failure here means the
  // catalog we ship is malformed — our bug, not the caller's.
  const parsed = serviceCatalogSchema.safeParse(serviceCatalog);
  if (!parsed.success) {
    console.error('[api/cost/catalog] catalog failed self-validation', parsed.error);
    return NextResponse.json(apiError('internal_error', 'The service catalog is unavailable.'), {
      status: ERROR_STATUS.internal_error,
    });
  }

  // Validate the full response envelope before sending it — the contract.
  const response = catalogResponseSchema.safeParse({ catalog: parsed.data });
  if (!response.success) {
    console.error('[api/cost/catalog] response failed self-validation', response.error);
    return NextResponse.json(apiError('internal_error', 'The service catalog is unavailable.'), {
      status: ERROR_STATUS.internal_error,
    });
  }

  return NextResponse.json(response.data, { status: 200 });
}
