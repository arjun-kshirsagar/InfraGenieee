/**
 * POST /api/cost/estimate
 *
 * Server-side evaluation of the same PURE engine the client runs. It exists for
 * tests, for shareable links, and as the authority if the client and server ever
 * disagree. No LLM call, no upstream fetch beyond the (cached) price books.
 *
 * The handler contains NO cost logic (docs/api-contracts.md §Conventions):
 *   parse body → validate selection ids against the catalog → fetch the price
 *   books for the referenced providers → delegate to the pure engine
 *   (`estimateProvider` + `compare`) → self-validate the output → respond.
 *
 * `generatedAt` is INJECTED here by the route: the engine is pure and must never
 * read the clock, so the one impure fact (the current time) is supplied at the
 * boundary.
 *
 * Contract (docs/api-contracts.md §POST /api/cost/estimate):
 *   200 { comparison }         — success.
 *   400 bad_request            — body is not valid JSON.
 *   400 validation_error       — body fails the schema, an unknown SKU id, or a
 *                                role/provider mismatch (with issues[]).
 *   503 pricing_unavailable    — no price book at all (retryable).
 *   500 internal_error         — unexpected.
 */

import { NextResponse } from 'next/server';

import {
  estimateRequestSchema,
  estimateResponseSchema,
  type CloudProvider,
  type EstimateRequest,
  type PriceRecord,
  type ProviderEstimate,
} from '@/types/cost';
import type { ApiError } from '@/types/prd';
import { apiError, ERROR_STATUS, zodIssues } from '@/lib/prd/api';
import { catalogServices } from '@/lib/cost/catalog';
import { buildPriceBook } from '@/lib/cost/pricing/build';
import { estimateProvider, compare } from '@/lib/cost/estimate';

// Reads the (cached) price books; on a cold cache it may fetch. Never static.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Issues = NonNullable<ApiError['error']['issues']>;

/**
 * Validate every selected choice against the catalog: the SKU must exist, its
 * service must belong to the selection's provider, and the service's role must
 * match the choice's role. This is INPUT validation (the catalog equivalent of a
 * schema check), not cost logic, so it belongs at the route boundary. Returns
 * the offending `issues[]`, empty when everything resolves.
 */
function validateSelections(request: EstimateRequest): Issues {
  const issues: Issues = [];

  // Index the catalog once: skuId → { provider, role } of its owning service.
  const skuIndex = new Map<string, { provider: CloudProvider; role: string; skuId: string }>();
  for (const service of catalogServices) {
    for (const sku of service.skus) {
      skuIndex.set(sku.id, { provider: service.provider, role: service.role, skuId: sku.id });
    }
  }

  request.selections.forEach((selection, si) => {
    selection.choices.forEach((choice, ci) => {
      const at = `selections.${si}.choices.${ci}`;
      const entry = skuIndex.get(choice.skuId);
      if (!entry) {
        issues.push({ path: `${at}.skuId`, message: `Unknown SKU id "${choice.skuId}".` });
        return;
      }
      if (entry.provider !== selection.provider) {
        issues.push({
          path: `${at}.skuId`,
          message: `SKU "${choice.skuId}" belongs to provider "${entry.provider}", not "${selection.provider}".`,
        });
      }
      if (entry.role !== choice.role) {
        issues.push({
          path: `${at}.role`,
          message: `SKU "${choice.skuId}" fills role "${entry.role}", not "${choice.role}".`,
        });
      }
    });
  });

  return issues;
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Body must be valid JSON.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(apiError('bad_request', 'Request body is not valid JSON.'), {
      status: ERROR_STATUS.bad_request,
    });
  }

  // 2. Body must satisfy the request contract.
  const parsed = estimateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      apiError('validation_error', 'Request body failed validation.', zodIssues(parsed.error)),
      { status: ERROR_STATUS.validation_error },
    );
  }

  // 3. Selection ids must resolve against the catalog (unknown SKU / mismatch).
  const selectionIssues = validateSelections(parsed.data);
  if (selectionIssues.length > 0) {
    return NextResponse.json(
      apiError('validation_error', 'One or more selections do not match the catalog.', selectionIssues),
      { status: ERROR_STATUS.validation_error },
    );
  }

  // 4. Fetch the price books for the referenced providers. A provider whose book
  //    could not be produced simply contributes no PriceRecords — the engine
  //    then renders its required dimensions as unpriced (never as free). Only
  //    when NOT ONE book could be produced do we 503.
  const providers = [...new Set(parsed.data.selections.map((s) => s.provider))];
  const settled = await Promise.allSettled(
    providers.map((provider) => buildPriceBook(provider, { signal: request.signal })),
  );

  const recordsByProvider = new Map<CloudProvider, PriceRecord[]>();
  const regionByProvider = new Map<CloudProvider, string>();
  let anyBook = false;
  settled.forEach((outcome, i) => {
    const provider = providers[i];
    if (outcome.status === 'fulfilled') {
      anyBook = true;
      recordsByProvider.set(provider, outcome.value.records);
      regionByProvider.set(provider, outcome.value.region);
    } else {
      console.error(
        `[api/cost/estimate] price book failed for provider "${provider}"`,
        outcome.reason,
      );
    }
  });

  if (!anyBook) {
    return NextResponse.json(
      apiError('pricing_unavailable', 'No price data is available right now. Please try again.'),
      { status: ERROR_STATUS.pricing_unavailable },
    );
  }

  // 5. Delegate to the PURE engine, one estimate per selection, then compare.
  //    generatedAt is injected here — the engine never reads the clock.
  try {
    const estimates: ProviderEstimate[] = parsed.data.selections.map((selection) =>
      estimateProvider({
        usage: parsed.data.usage,
        selection,
        services: catalogServices,
        priceRecords: recordsByProvider.get(selection.provider) ?? [],
        region: regionByProvider.get(selection.provider) ?? '',
        requiredRoles: parsed.data.requiredRoles,
      }),
    );

    const comparison = compare({
      estimates,
      services: catalogServices,
      generatedAt: new Date().toISOString(),
    });

    // 6. Self-validate the output — never return a comparison that doesn't parse.
    const response = estimateResponseSchema.safeParse({ comparison });
    if (!response.success) {
      console.error('[api/cost/estimate] response failed self-validation', response.error);
      return NextResponse.json(apiError('internal_error', 'The cost estimate is unavailable.'), {
        status: ERROR_STATUS.internal_error,
      });
    }

    return NextResponse.json(response.data, { status: 200 });
  } catch (error) {
    console.error('[api/cost/estimate] estimation failed', error);
    return NextResponse.json(apiError('internal_error', 'The cost estimate is unavailable.'), {
      status: ERROR_STATUS.internal_error,
    });
  }
}
