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
};
