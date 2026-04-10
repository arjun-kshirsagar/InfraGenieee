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
import type { PrdDocument, QuestionnaireDraft } from '@/types/prd';
import { VALID_ANSWERS } from '@/types/prd.test';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A minimal valid PrdDocument. `answers` reuses the contract test fixture. */
function makeDoc(overrides: Partial<PrdDocument> = {}): PrdDocument {
  return {
    id: 'prd_abcdef012345',
    createdAt: '2026-01-01T00:00:00.000Z',
    generatorVersion: '1.0.0',
    title: 'Acme Invoicing',
    answers: VALID_ANSWERS,
    prd: {
      overview: { problem: 'p', solution: 's', targetUsers: 'u', valueProposition: ['v'] },
      goals: ['g'],
      nonGoals: ['ng'],
      userStories: [
        { id: 'us1', asA: 'user', iWant: 'x', soThat: 'y', priority: 'p0', acceptanceCriteria: ['ac'] },
      ],
      functionalRequirements: [{ id: 'fr1', title: 't', detail: 'd', priority: 'p0' }],
      nonFunctionalRequirements: [
        { id: 'nfr1', category: 'performance', requirement: 'r', rationale: 'why' },
      ],
      successMetrics: ['m'],
      risks: [{ risk: 'r', impact: 'p1', mitigation: 'm' }],
      openQuestions: ['q'],
    },
    architecture: {
      summary: 'sum',
      pattern: 'monolith',
      components: [{ name: 'web', kind: 'client', responsibility: 'ui', technology: 'next' }],
      dataModel: { entities: VALID_ANSWERS.dataModel.entities, relationships: [] },
      apiEndpoints: [{ method: 'GET', path: '/x', purpose: 'p', authRequired: false }],
      infrastructure: {
        hosting: 'Vercel',
        database: 'Postgres',
        cache: null,
        storage: null,
        cicd: 'GitHub Actions',
        environments: ['prod'],
        rationale: ['cheap'],
      },
      diagramMermaid: 'flowchart TD\n A --> B',
    },
    plan: {
      milestones: [
        {
          id: 'm1',
          name: 'MVP',
          goal: 'ship',
          tasks: [
            {
              id: 'task1',
              title: 't',
              description: 'd',
              area: 'frontend',
              estimateHours: 4,
              dependsOn: [],
              acceptanceCriteria: ['ac'],
            },
          ],
        },
      ],
      criticalPath: ['task1'],
      totalEstimateHours: 4,
      estimatedCalendarWeeks: 1,
    },
    ...overrides,
  };
}

const SAMPLE_DRAFT: QuestionnaireDraft = {
  basics: {
    projectName: 'Draft Project',
    oneLiner: 'A partial one-liner here',
    productType: 'web-app',
    targetAudience: 'testers',
    problemStatement: 'We are mid-way through the questionnaire.',
  },
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

  it('round-trips a genuinely partial step (autosave mid-form)', () => {
    // Only one field of `basics` is filled — the contract's
    // questionnaireDraftSchema would reject this (it requires whole groups),
    // but the store must tolerate partial autosave so the user can resume.
    const partial = { basics: { projectName: 'Half-typed' } } as QuestionnaireDraft;
    saveDraft(partial);
    expect(loadDraft()).toEqual(partial);
  });

  it('accepts an empty draft (fresh autosave)', () => {
    saveDraft({});
    expect(loadDraft()).toEqual({});
  });

  it('returns null on a corrupt draft', () => {
    localStorage.setItem('infragenie:prd-draft', '{not json');
    expect(loadDraft()).toBeNull();
  });

  it('returns null on a draft that fails schema validation', () => {
    localStorage.setItem(
      'infragenie:prd-draft',
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
