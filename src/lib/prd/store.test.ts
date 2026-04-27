/**
 * Tests for the client-side persistence layer.
 *
 * The vitest environment is `node` (see vitest.config.mts), so there is no
 * `window`/`localStorage` by default — which is exactly the SSR condition. We
 * assert the SSR no-op behaviour with `window` absent, then install a minimal
 * in-memory `localStorage` + `window` stub for the browser-path tests and tear
 * it down afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  saveDocument,
  loadDocument,
  listDocuments,
  saveDraft,
  loadDraft,
  clearDraft,
} from '@/lib/prd/store';
import type { PrdDocument, ProjectBriefDraft } from '@/types/prd';
import { makePrdDocument } from '@/lib/prd/fixtures.test-support';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A valid PrdDocument from the shared fixture. */
function makeDoc(overrides: Partial<PrdDocument> = {}): PrdDocument {
  return makePrdDocument(overrides);
}

const SAMPLE_DRAFT: ProjectBriefDraft = {
  idea: 'A partially typed idea about renting out camera gear between photographers.',
  context: { userScale: 'small', budgetBand: 'hobby' },
};

/* -------------------------------------------------------------------------- */
/* In-memory localStorage stub                                                */
/* -------------------------------------------------------------------------- */

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

function installBrowser(storage: Storage = new MemoryStorage()): void {
  vi.stubGlobal('window', { localStorage: storage } as unknown as Window);
  vi.stubGlobal('localStorage', storage);
}

/* -------------------------------------------------------------------------- */
/* SSR path — no window at all                                                */
/* -------------------------------------------------------------------------- */

describe('store — SSR (no window)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // Ensure `window` is genuinely absent in this test.
    expect(typeof window).toBe('undefined');
  });

  it('returns null / empty and never throws when window is undefined', () => {
    expect(() => saveDocument(makeDoc())).not.toThrow();
    expect(loadDocument('prd_abcdef012345')).toBeNull();
    expect(listDocuments()).toEqual([]);
    expect(() => saveDraft(SAMPLE_DRAFT)).not.toThrow();
    expect(loadDraft()).toBeNull();
    expect(() => clearDraft()).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Browser path                                                               */
/* -------------------------------------------------------------------------- */

describe('store — browser', () => {
  beforeEach(() => {
    installBrowser();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips a document via save/load', () => {
    const doc = makeDoc();
    saveDocument(doc);
    expect(loadDocument(doc.id)).toEqual(doc);
  });

  it('returns null loading a document that was never saved', () => {
    expect(loadDocument('prd_doesnotexist')).toBeNull();
  });

  it('returns null on corrupt (non-JSON) stored data', () => {
    localStorage.setItem('infragenie:prd:prd_corrupt00001', '{not json');
    expect(loadDocument('prd_corrupt00001')).toBeNull();
  });

  it('returns null on foreign JSON that does not match the schema', () => {
    localStorage.setItem(
      'infragenie:prd:prd_foreign00001',
      JSON.stringify({ id: 'prd_foreign00001', hello: 'world' }),
    );
    expect(loadDocument('prd_foreign00001')).toBeNull();
  });

  it('lists documents newest-first and skips invalid entries', () => {
    saveDocument(makeDoc({ id: 'prd_old000000001', createdAt: '2026-01-01T00:00:00.000Z', title: 'Old' }));
    saveDocument(makeDoc({ id: 'prd_new000000001', createdAt: '2026-06-01T00:00:00.000Z', title: 'New' }));
    // A corrupt entry and an unrelated key must not appear or crash the list.
    localStorage.setItem('infragenie:prd:prd_bad000000001', '{broken');
    localStorage.setItem('unrelated:key', 'ignore me');

    const list = listDocuments();
    expect(list.map((d) => d.id)).toEqual(['prd_new000000001', 'prd_old000000001']);
    expect(list[0]).toEqual({ id: 'prd_new000000001', title: 'New', createdAt: '2026-06-01T00:00:00.000Z' });
  });

  it('round-trips a draft via save/load', () => {
    saveDraft(SAMPLE_DRAFT);
    expect(loadDraft()).toEqual(SAMPLE_DRAFT);
  });

  it('round-trips a genuinely partial draft (autosave mid-typing)', () => {
    const partial: ProjectBriefDraft = { idea: 'Half-typed' };
    saveDraft(partial);
    expect(loadDraft()).toEqual(partial);
  });

  it('accepts an empty draft (fresh autosave)', () => {
    saveDraft({});
    expect(loadDraft()).toEqual({});
  });

  it('returns null on a corrupt draft', () => {
    localStorage.setItem('infragenie:brief-draft', '{not json');
    expect(loadDraft()).toBeNull();
  });

  it('returns null on a draft that fails schema validation', () => {
    localStorage.setItem(
      'infragenie:brief-draft',
      JSON.stringify({ scale: { userScale: 'gigantic' } }),
    );
    expect(loadDraft()).toBeNull();
  });

  it('clears the draft', () => {
    saveDraft(SAMPLE_DRAFT);
    expect(loadDraft()).not.toBeNull();
    clearDraft();
    expect(loadDraft()).toBeNull();
  });

  it('never throws when setItem throws (quota / private mode)', () => {
    const throwing = new MemoryStorage();
    vi.spyOn(throwing, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    installBrowser(throwing);
    expect(() => saveDocument(makeDoc())).not.toThrow();
    expect(() => saveDraft(SAMPLE_DRAFT)).not.toThrow();
  });
});
