/**
 * InfraGenie — client-side persistence for Feature 1 (frontend-owned).
 *
 * There is no server persistence in v1 (see docs/architecture.md §4 and
 * docs/api-contracts.md "Client-side persistence"). Generated PRD documents and
 * the in-progress questionnaire draft live in `localStorage`:
 *
 *   - documents: `infragenie:prd:<id>`
 *   - draft:     `infragenie:prd-draft`
 *
 * Hard rules this module upholds so it can never crash a caller:
 *   1. SSR-safe. This is imported by client components in an App Router app, so
 *      it can be evaluated on the server. Every function guards
 *      `typeof window === 'undefined'` and no-ops / returns null there.
 *   2. Every `localStorage` access is wrapped in try/catch (quota exceeded,
 *      Safari private mode, disabled storage) — never throws at the caller.
 *   3. Every read is validated with zod (`prdDocumentSchema` /
 *      `questionnaireDraftSchema`) and returns `null` on mismatch. Stale data
 *      written by an older schema version can never crash the app; it is simply
 *      treated as absent.
 */

import {
  prdDocumentSchema,
  basicsSchema,
  scaleSchema,
  budgetSchema,
  stackSchema,
  dataModelAnswersSchema,
  authAnswersSchema,
  integrationsAnswersSchema,
  type PrdDocument,
  type QuestionnaireDraft,
} from '@/types/prd';
import { z } from 'zod';

const DOC_KEY_PREFIX = 'infragenie:prd:';
const DRAFT_KEY = 'infragenie:prd-draft';

/**
 * A tolerant, deep-partial schema for the in-progress draft.
 *
 * `questionnaireDraftSchema` in the contract is `answers.partial()` — it makes
 * each STEP GROUP optional, but any group that IS present must be COMPLETE
 * (every field valid). Autosave, however, must persist half-filled steps (the
 * user is mid-form). So for draft reads/writes we validate against a deeper
 * partial: each group is optional AND each field within a present group is
 * optional. This still rejects foreign/corrupt JSON and wrong enum/types —
 * "stale data never crashes the app" — while letting a genuinely partial draft
 * round-trip and be resumed. It never touches the shared contract in
 * `src/types/prd.ts`.
 */
const draftStorageSchema = z.object({
  basics: basicsSchema.partial().optional(),
  scale: scaleSchema.partial().optional(),
  budget: budgetSchema.partial().optional(),
  stack: stackSchema.partial().optional(),
  dataModel: dataModelAnswersSchema.partial().optional(),
  auth: authAnswersSchema.partial().optional(),
  integrations: integrationsAnswersSchema.partial().optional(),
});

/** Summary row returned by `listDocuments()`. */
export interface PrdDocumentSummary {
  id: string;
  title: string;
  createdAt: string;
}

const docKey = (id: string): string => `${DOC_KEY_PREFIX}${id}`;

/**
 * Safe accessor for `localStorage`. Returns `null` on the server or when
 * storage is unavailable (private mode, disabled cookies/storage), so callers
 * degrade gracefully instead of throwing.
 */
function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Parse JSON without throwing. Returns `undefined` on any failure. */
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

/** Persist a generated PRD document under `infragenie:prd:<id>`. No-op on SSR/error. */
export function saveDocument(doc: PrdDocument): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(docKey(doc.id), JSON.stringify(doc));
  } catch {
    // Quota exceeded / storage disabled — swallow. The caller keeps working
    // with the in-memory document; persistence is best-effort.
  }
}

/**
 * Load a PRD document by id. Returns `null` if absent, unreadable, not valid
 * JSON, or failing `prdDocumentSchema` (e.g. written by an older schema).
 */
export function loadDocument(id: string): PrdDocument | null {
  const storage = getStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(docKey(id));
  } catch {
    return null;
  }
  if (raw == null) return null;
  const parsed = safeParseJson(raw);
  if (parsed === undefined) return null;
  const result = prdDocumentSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * List all persisted documents as lightweight summaries, sorted newest first
 * (by `createdAt`, ISO-8601). Entries that fail validation are skipped rather
 * than crashing the list.
 */
export function listDocuments(): PrdDocumentSummary[] {
  const storage = getStorage();
  if (!storage) return [];

  const summaries: PrdDocumentSummary[] = [];
  let length: number;
  try {
    length = storage.length;
  } catch {
    return [];
  }

  for (let i = 0; i < length; i += 1) {
    let key: string | null;
    try {
      key = storage.key(i);
    } catch {
      continue;
    }
    if (!key || !key.startsWith(DOC_KEY_PREFIX)) continue;

    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      continue;
    }
    if (raw == null) continue;

    const parsed = safeParseJson(raw);
    if (parsed === undefined) continue;
    const result = prdDocumentSchema.safeParse(parsed);
    if (!result.success) continue;

    const { id, title, createdAt } = result.data;
    summaries.push({ id, title, createdAt });
  }

  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return summaries;
}

/* -------------------------------------------------------------------------- */
/* Draft                                                                      */
/* -------------------------------------------------------------------------- */

/** Persist the in-progress questionnaire draft. No-op on SSR/error. */
export function saveDraft(draft: QuestionnaireDraft): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Best-effort autosave; ignore quota/availability failures.
  }
}

/**
 * Load the questionnaire draft. Returns `null` if absent, unreadable, not valid
 * JSON, or failing `questionnaireDraftSchema` (stale/foreign data).
 */
export function loadDraft(): QuestionnaireDraft | null {
  const storage = getStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
  if (raw == null) return null;
  const parsed = safeParseJson(raw);
  if (parsed === undefined) return null;
  const result = draftStorageSchema.safeParse(parsed);
  return result.success ? (result.data as QuestionnaireDraft) : null;
}

/** Remove the persisted draft. No-op on SSR/error. */
export function clearDraft(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}
