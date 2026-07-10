/**
 * Tests for the PURE `detectStack` (task B3).
 *
 * These are the credibility gate for Feature 3. They prove four things:
 *
 *   1. Determinism — calling `detectStack` twice on one snapshot deep-equals.
 *   2. Every result is schema-valid (`stackDetectionSchema.safeParse === true`).
 *   3. Each fixture's framework/runtime/appShape/confidence match expectation.
 *   4. THE ANTI-FABRICATION GATE — for every signal in every result, the cited
 *      `excerpt` is genuinely a substring of the file at `signal.path` (or, for
 *      `file-present`, equals the path). No claim can escape without real
 *      evidence in a real file.
 *
 * OFFLINE and pure: no network, no clock, no fetch.
 */

import { describe, expect, it } from 'vitest';

import { detectStack } from '@/lib/deploy/detect';
import { stackDetectionSchema, type RepoSnapshot } from '@/types/deploy';

import { FIXTURES } from './__fixtures__';

/* -------------------------------------------------------------------------- */
/* 1. Purity / determinism                                                    */
/* -------------------------------------------------------------------------- */

describe('detectStack — determinism (purity)', () => {
  for (const fx of FIXTURES) {
    it(`is deterministic for "${fx.name}"`, () => {
      const a = detectStack(fx.snapshot);
      const b = detectStack(fx.snapshot);
      expect(a).toEqual(b);
    });
  }

  it('does not mutate the input snapshot', () => {
    const fx = FIXTURES[0];
    const before = JSON.stringify(fx.snapshot);
    detectStack(fx.snapshot);
    expect(JSON.stringify(fx.snapshot)).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Schema validity                                                         */
/* -------------------------------------------------------------------------- */

describe('detectStack — every result is schema-valid', () => {
  for (const fx of FIXTURES) {
    it(`"${fx.name}" satisfies stackDetectionSchema`, () => {
      const result = detectStack(fx.snapshot);
      const parsed = stackDetectionSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 3. Expectation matrix                                                      */
/* -------------------------------------------------------------------------- */

describe('detectStack — detection matrix', () => {
  for (const fx of FIXTURES) {
    it(`classifies "${fx.name}" correctly`, () => {
      const d = detectStack(fx.snapshot);
      expect(d.framework).toBe(fx.expect.framework);
      expect(d.runtime).toBe(fx.expect.runtime);
      expect(d.appShape).toBe(fx.expect.appShape);
      expect(d.confidence).toBe(fx.expect.confidence);
      if (fx.expect.packageManager !== undefined) {
        expect(d.packageManager).toBe(fx.expect.packageManager);
      }
      if (fx.expect.monorepo !== undefined) {
        expect(d.monorepo).toBe(fx.expect.monorepo);
      }
      if (fx.expect.needsIncludes) {
        for (const need of fx.expect.needsIncludes) {
          expect(d.needs).toContain(need);
        }
      }
      if (fx.expect.noteIncludes) {
        const joined = d.notes.join(' \u2016 ');
        expect(joined.toLowerCase()).toContain(fx.expect.noteIncludes.toLowerCase());
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 4. THE ANTI-FABRICATION GATE                                               */
/* -------------------------------------------------------------------------- */

describe('detectStack — no uncited claim can escape', () => {
  for (const fx of FIXTURES) {
    it(`every signal in "${fx.name}" cites a real substring of a real file`, () => {
      const d = detectStack(fx.snapshot);
      const files = fx.snapshot.files;

      for (const signal of d.signals) {
        // The cited path must be a real file OR a real directory in the tree.
        const isFile = signal.path in files;
        const isEntry = fx.snapshot.entries.some((e) => e.path === signal.path);
        expect(
          isFile || isEntry,
          `signal ${signal.id} cites path "${signal.path}" that is neither a probed file nor a tree entry`,
        ).toBe(true);

        if (signal.kind === 'file-present') {
          // For file-present, the excerpt IS the path (docs §detectionSignal).
          expect(
            signal.excerpt,
            `file-present signal ${signal.id} must cite its own path as excerpt`,
          ).toBe(signal.path);
          continue;
        }

        // For every other kind, the excerpt must be a VERBATIM substring of the
        // file we cited. This is the anti-fabrication invariant, asserted
        // programmatically rather than trusted.
        const content = files[signal.path];
        expect(
          content,
          `signal ${signal.id} kind "${signal.kind}" cites file "${signal.path}" whose contents we don't have`,
        ).toBeDefined();
        expect(
          content!.includes(signal.excerpt),
          `signal ${signal.id} excerpt ${JSON.stringify(
            signal.excerpt,
          )} is NOT a verbatim substring of ${signal.path} — that is a fabricated citation`,
        ).toBe(true);
      }
    });
  }

  it('a named framework always carries at least one signal', () => {
    for (const fx of FIXTURES) {
      const d = detectStack(fx.snapshot);
      if (d.framework !== 'unknown') {
        expect(d.signals.length, `"${fx.name}" named ${d.framework} with no signal`).toBeGreaterThan(0);
      }
    }
  });

  it('high confidence always rests on at least one strong signal', () => {
    for (const fx of FIXTURES) {
      const d = detectStack(fx.snapshot);
      if (d.confidence === 'high') {
        expect(
          d.signals.some((s) => s.weight === 'strong'),
          `"${fx.name}" is high-confidence but has no strong signal`,
        ).toBe(true);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5. `unknown` invariants                                                    */
/* -------------------------------------------------------------------------- */

describe('detectStack — unknown confidence is honest', () => {
  it('non-GitHub ref → unknown, no framework, no needs, an explaining note', () => {
    const gitlab = FIXTURES.find((f) => f.name === 'gitlab-ref-unknown')!;
    const d = detectStack(gitlab.snapshot);
    expect(d.confidence).toBe('unknown');
    expect(d.framework).toBe('unknown');
    expect(d.needs).toEqual([]);
    expect(d.signals).toEqual([]);
    expect(d.notes.length).toBeGreaterThan(0);
  });

  it('an empty readable GitHub repo → unknown with a note', () => {
    const empty: RepoSnapshot = {
      ref: {
        host: 'github',
        owner: 'acme',
        repo: 'empty',
        branch: null,
        subdir: null,
        canonicalUrl: 'https://github.com/acme/empty',
      },
      defaultBranch: 'main',
      resolvedBranch: 'main',
      meta: {},
      entries: [],
      files: {},
      entriesTruncated: false,
      fetchedAt: '2026-07-28T12:00:00.000Z',
    };
    const d = detectStack(empty);
    expect(d.confidence).toBe('unknown');
    expect(d.framework).toBe('unknown');
  });
});
