/**
 * Shared, dependency-free helpers for the PRD API surface.
 * Owned by: architect. Used by route handlers and the generator.
 */

import { z } from 'zod';
import type { ApiError } from '@/types/prd';

/** `prd_` + 12 lowercase base36 chars. URL-safe, no dependency. */
export function newPrdId(): string {
  let out = '';
  while (out.length < 12) {
    out += Math.random().toString(36).slice(2);
  }
  return `prd_${out.slice(0, 12)}`;
}

export function apiError(
  code: ApiError['error']['code'],
  message: string,
  issues?: ApiError['error']['issues'],
): ApiError {
  return { error: { code, message, ...(issues ? { issues } : {}) } };
}

/** Flatten a ZodError into the contract's `issues[]` shape. */
export function zodIssues(error: z.ZodError): NonNullable<ApiError['error']['issues']> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/** HTTP status for each error code. */
export const ERROR_STATUS: Record<ApiError['error']['code'], number> = {
  validation_error: 400,
  bad_request: 400,
  not_found: 404,
  generation_failed: 500,
  internal_error: 500,
  // 503: the upstream model is down/rate-limited. Distinct from 500 so the
  // client can offer a retry rather than presenting a dead end.
  llm_unavailable: 503,
  // 500: a server misconfiguration (no API key), never the user's fault.
  llm_not_configured: 500,
};

/**
 * Map a `GenerationError.code` onto the public API error code.
 *
 * Kept here rather than in the routes so both `/clarify` and `/generate`
 * report identical failures identically. `not_implemented` deliberately
 * surfaces as `generation_failed` — clients need no special case for a seam
 * that only exists mid-migration.
 */
export const GENERATION_ERROR_CODE: Record<string, ApiError['error']['code']> = {
  not_configured: 'llm_not_configured',
  unavailable: 'llm_unavailable',
  invalid_output: 'generation_failed',
  not_implemented: 'generation_failed',
};
