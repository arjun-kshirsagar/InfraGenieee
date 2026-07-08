/**
 * Tests for the Feature 3 client persistence layer (`@/lib/deploy/store`).
 *
 * The vitest environment is `node` (see vitest.config.mts), so there is no
 * `window`/`localStorage` by default — exactly the SSR condition. We assert the
 * SSR no-op first, then install an in-memory `localStorage` + `window` stub for
 * the browser-path tests (mirroring `src/lib/prd/store.test.ts`).
 *
 * The three hard rules under test:
 *   1. SSR no-op — every function is safe with `window` undefined.
 *   2. A corrupt/non-JSON blob → `null` (treated as absent, never throws).
 *   3. A schema-mismatch blob, or one written for a different DETECTION_VERSION,
 *      → `null`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeployPlan } from '@/types/deploy';
import { DETECTION_VERSION } from '@/types/deploy';
import {
  saveDeployState,
  loadDeployState,
  clearDeployState,
  saveLastAnalyzed,
  loadLastAnalyzed,
} from '@/lib/deploy/store';

/* -------------------------------------------------------------------------- */
/* A valid DeployPlan fixture (test-only; never imported by runtime code)      */
/* -------------------------------------------------------------------------- */

const CANONICAL = 'https://github.com/vercel/next-learn';

function makeDeployPlan(overrides: Partial<DeployPlan> = {}): DeployPlan {
  const base: DeployPlan = {
    repo: {
      host: 'github',
      owner: 'vercel',
      repo: 'next-learn',
      branch: null,
      subdir: null,
      canonicalUrl: CANONICAL,
    },
    detection: {
      framework: 'nextjs',
      frameworkVersion: '^15.0.0',
      runtime: 'node',
      appShape: 'ssr',
      packageManager: 'npm',
      needs: [],
      build: {
        installCommand: 'npm install',
        buildCommand: 'next build',
        outputDir: null,
        startCommand: null,
        nodeVersion: null,
      },
      existing: { vercel: false, netlify: false, render: false, dockerfile: false },
      monorepo: false,
      signals: [
        {
          id: 'dep:next',
          kind: 'dependency',
          path: 'package.json',
          excerpt: '"next": "^15.0.0"',
          implies: 'next in dependencies → Next.js',
          weight: 'strong',
        },
      ],
      confidence: 'high',
      notes: [],
    },
    fits: [
      {
        provider: 'vercel',
        verdict: 'recommended',
        score: 95,
        reasons: ['Next.js is a first-class Vercel target.'],
        caveats: [],
        deployUrl: 'https://vercel.com/new/clone?repository-url=' + encodeURIComponent(CANONICAL),
        requiresConfig: false,
      },
      {
        provider: 'netlify',
        verdict: 'possible',
        score: 70,
        reasons: ['Netlify runs Next.js via its adapter.'],
        caveats: ['Some SSR features need the Netlify Next runtime.'],
        deployUrl: 'https://app.netlify.com/start/deploy?repository=' + encodeURIComponent(CANONICAL),
        requiresConfig: false,
      },
      {
        provider: 'render',
        verdict: 'possible',
        score: 55,
        reasons: ['Render can host a Next.js web service.'],
        caveats: ['You manage the server lifecycle yourself.'],
        deployUrl: 'https://render.com/deploy?repo=' + encodeURIComponent(CANONICAL),
        requiresConfig: true,
      },
    ],
    primary: 'vercel',
    assumptions: ['Assumed the default branch since none was given.'],
    configs: [],
    usedPrdContext: false,
    generatedAt: '2026-07-28T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

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

const KEY_PREFIX = 'infragenie:deploy:';

/* -------------------------------------------------------------------------- */
/* SSR path — no window at all                                                */
/* -------------------------------------------------------------------------- */

describe('deploy store — SSR (no window)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    expect(typeof window).toBe('undefined');
  });

  it('every function is a safe no-op and never throws with window undefined', () => {
    const plan = makeDeployPlan();
    expect(() => saveDeployState(plan)).not.toThrow();
    expect(loadDeployState(CANONICAL)).toBeNull();
    expect(() => clearDeployState(CANONICAL)).not.toThrow();
    expect(() => saveLastAnalyzed(CANONICAL)).not.toThrow();
    expect(loadLastAnalyzed()).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Browser path                                                               */
/* -------------------------------------------------------------------------- */

describe('deploy store — browser', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    installBrowser(storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips a plan via save/load keyed by canonical URL', () => {
    const plan = makeDeployPlan();
    saveDeployState(plan);
    expect(loadDeployState(CANONICAL)).toEqual(plan);
  });

  it('returns null loading a canonical URL that was never saved', () => {
    expect(loadDeployState('https://github.com/nobody/nothing')).toBeNull();
  });

  it('clearDeployState removes a saved plan', () => {
    const plan = makeDeployPlan();
    saveDeployState(plan);
    expect(loadDeployState(CANONICAL)).not.toBeNull();
    clearDeployState(CANONICAL);
    expect(loadDeployState(CANONICAL)).toBeNull();
  });

  it('round-trips the last-analyzed pointer', () => {
    expect(loadLastAnalyzed()).toBeNull();
    saveLastAnalyzed(CANONICAL);
    expect(loadLastAnalyzed()).toBe(CANONICAL);
  });

  it('a corrupt (non-JSON) blob → null, never throws', () => {
    storage.setItem(`${KEY_PREFIX}${CANONICAL}`, '{ not json at all ');
    expect(() => loadDeployState(CANONICAL)).not.toThrow();
    expect(loadDeployState(CANONICAL)).toBeNull();
  });

  it('a schema-mismatch blob → null (missing required fields)', () => {
    // Valid JSON, valid envelope shape, but the plan is not a DeployPlan.
    storage.setItem(
      `${KEY_PREFIX}${CANONICAL}`,
      JSON.stringify({ version: DETECTION_VERSION, plan: { repo: { owner: 'x' } } }),
    );
    expect(loadDeployState(CANONICAL)).toBeNull();
  });

  it('a plan from a DIFFERENT DETECTION_VERSION → null (discarded)', () => {
    storage.setItem(
      `${KEY_PREFIX}${CANONICAL}`,
      JSON.stringify({ version: '0.0.0-stale', plan: makeDeployPlan() }),
    );
    expect(loadDeployState(CANONICAL)).toBeNull();
  });

  it('an off-envelope blob (no version wrapper) → null', () => {
    // Just the bare plan, not wrapped in { version, plan }.
    storage.setItem(`${KEY_PREFIX}${CANONICAL}`, JSON.stringify(makeDeployPlan()));
    expect(loadDeployState(CANONICAL)).toBeNull();
  });

  it('a stale last-analyzed pointer just yields a clean miss', () => {
    saveLastAnalyzed('https://github.com/gone/away');
    // The pointer resolves, but there is no plan stored under that key.
    expect(loadLastAnalyzed()).toBe('https://github.com/gone/away');
    expect(loadDeployState('https://github.com/gone/away')).toBeNull();
  });
});
