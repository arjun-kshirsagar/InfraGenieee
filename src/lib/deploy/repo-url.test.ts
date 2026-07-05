/**
 * Tests for the Feature 3 pure repo-URL parser (B1).
 *
 * Table-driven on purpose: every shape a user might paste (and every shape we
 * must reject) is one row, so a regression names itself. Two invariants beyond
 * the field-by-field checks:
 *
 *   1. every accepted `RepoRef` is asserted against `repoRefSchema` — not by
 *      eye — so the parser can never emit a value the contract would reject;
 *   2. the parser is pure: it uses no network and no clock (there is no `Date`
 *      in `repo-url.ts`; this is a static guarantee, restated here for readers).
 */

import { describe, it, expect } from 'vitest';

import { formatRepoLabel, parseRepoUrl } from './repo-url';
import { RepoError, type RepoErrorCode } from './repo-seam';
import { repoRefSchema, type RepoRef } from '@/types/deploy';

/* -------------------------------------------------------------------------- */
/* Accepted shapes                                                            */
/* -------------------------------------------------------------------------- */

interface AcceptCase {
  readonly name: string;
  readonly input: string;
  readonly expect: Pick<RepoRef, 'host' | 'owner' | 'repo' | 'branch' | 'subdir' | 'canonicalUrl'>;
}

const ACCEPT: readonly AcceptCase[] = [
  // ---- plain https, GitHub -------------------------------------------------
  {
    name: 'https github, bare',
    input: 'https://github.com/o/r',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'https github, trailing slash',
    input: 'https://github.com/o/r/',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'https github, .git suffix',
    input: 'https://github.com/o/r.git',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'http (not https) is canonicalised to https',
    input: 'http://github.com/o/r',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  // ---- no scheme -----------------------------------------------------------
  {
    name: 'bare host, no scheme',
    input: 'github.com/o/r',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'www. host, no scheme',
    input: 'www.github.com/o/r',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'www. host with https',
    input: 'https://www.github.com/o/r',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  // ---- SSH / SCP -----------------------------------------------------------
  {
    name: 'git@ SCP syntax with .git',
    input: 'git@github.com:o/r.git',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'git@ SCP syntax without .git',
    input: 'git@github.com:o/r',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'ssh:// URL with .git',
    input: 'ssh://git@github.com/o/r.git',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  // ---- /tree/ branch -------------------------------------------------------
  {
    name: 'tree → simple branch',
    input: 'https://github.com/o/r/tree/main',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: 'main',
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'tree → branch with slash (first segment taken as branch; see header)',
    input: 'https://github.com/o/r/tree/feat/x',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      // Ambiguous: could be branch 'feat/x'. Pure parser takes 'feat' + subdir
      // 'x'; B2 corrects against the real branch list. Documented in the module.
      branch: 'feat',
      subdir: 'x',
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'tree → branch + monorepo subdir',
    input: 'https://github.com/o/r/tree/main/apps/web',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: 'main',
      subdir: 'apps/web',
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'tree with trailing slash',
    input: 'https://github.com/o/r/tree/main/',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: 'main',
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  // ---- other hosts ---------------------------------------------------------
  {
    name: 'gitlab',
    input: 'https://gitlab.com/o/r',
    expect: {
      host: 'gitlab',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://gitlab.com/o/r',
    },
  },
  {
    name: 'gitlab SCP',
    input: 'git@gitlab.com:o/r.git',
    expect: {
      host: 'gitlab',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://gitlab.com/o/r',
    },
  },
  {
    name: 'bitbucket',
    input: 'https://bitbucket.org/o/r',
    expect: {
      host: 'bitbucket',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://bitbucket.org/o/r',
    },
  },
  {
    name: 'bitbucket .git',
    input: 'https://bitbucket.org/o/r.git',
    expect: {
      host: 'bitbucket',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://bitbucket.org/o/r',
    },
  },
  // ---- whitespace + query + fragment --------------------------------------
  {
    name: 'surrounding whitespace is trimmed',
    input: '   https://github.com/o/r   ',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'trailing #fragment stripped',
    input: 'https://github.com/o/r#readme',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'trailing ?query stripped',
    input: 'https://github.com/o/r?tab=readme-ov-file',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'query + fragment together, no scheme',
    input: 'github.com/o/r?x=1#y',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  // ---- charset edges that ARE legal ---------------------------------------
  {
    name: 'owner/repo with dots, dashes, underscores',
    input: 'https://github.com/my-org/some_repo.js',
    expect: {
      host: 'github',
      owner: 'my-org',
      repo: 'some_repo.js',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/my-org/some_repo.js',
    },
  },
  {
    name: 'repo named exactly with .git-like suffix keeps its dot segment',
    input: 'https://github.com/o/r.github.io',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r.github.io',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r.github.io',
    },
  },
  {
    name: 'uppercase host is normalised',
    input: 'https://GitHub.com/o/r',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
  {
    name: 'non-tree trailing path (blob) is ignored, no branch inferred',
    input: 'https://github.com/o/r/blob/main/readme.md',
    expect: {
      host: 'github',
      owner: 'o',
      repo: 'r',
      branch: null,
      subdir: null,
      canonicalUrl: 'https://github.com/o/r',
    },
  },
];

describe('parseRepoUrl — accepted shapes', () => {
  for (const c of ACCEPT) {
    it(c.name, () => {
      const ref = parseRepoUrl(c.input);
      expect(ref).toMatchObject(c.expect);
      // Assert against the contract, not by eye.
      expect(repoRefSchema.safeParse(ref).success).toBe(true);
    });
  }

  it('covers at least the documented shapes (>= 25 accept cases)', () => {
    expect(ACCEPT.length).toBeGreaterThanOrEqual(25);
  });
});

/* -------------------------------------------------------------------------- */
/* Rejected shapes                                                            */
/* -------------------------------------------------------------------------- */

interface RejectCase {
  readonly name: string;
  readonly input: string;
  readonly code: RepoErrorCode;
}

const REJECT: readonly RejectCase[] = [
  { name: 'empty string', input: '', code: 'invalid_url' },
  { name: 'whitespace only', input: '   ', code: 'invalid_url' },
  { name: 'no owner/repo — host only', input: 'https://github.com', code: 'invalid_url' },
  { name: 'no owner/repo — host + slash', input: 'https://github.com/', code: 'invalid_url' },
  { name: 'owner but no repo', input: 'https://github.com/o', code: 'invalid_url' },
  {
    name: 'owner with path separator (traversal-ish)',
    input: 'https://github.com/o/../etc/passwd',
    code: 'invalid_url',
  },
  {
    name: 'repo with illegal character (space)',
    input: 'https://github.com/o/a b',
    code: 'invalid_url',
  },
  {
    name: 'owner with illegal character (@)',
    input: 'https://github.com/o@x/r',
    code: 'invalid_url',
  },
  { name: 'javascript: scheme', input: 'javascript:alert(1)//github.com/o/r', code: 'invalid_url' },
  {
    name: 'data: scheme',
    input: 'data:text/html,<script>//github.com/o/r',
    code: 'invalid_url',
  },
  {
    name: 'unsupported git host (self-hosted)',
    input: 'https://git.example.com/o/r',
    code: 'unsupported_host',
  },
  {
    name: 'unsupported host — sourcehut',
    input: 'https://git.sr.ht/~o/r',
    code: 'unsupported_host', // host is resolved before the path charset is checked
  },
  {
    name: 'unsupported host via SCP',
    input: 'git@gitea.example.com:o/r.git',
    code: 'unsupported_host',
  },
  {
    name: 'plausible-but-wrong host (githubusercontent)',
    input: 'https://raw.githubusercontent.com/o/r',
    code: 'unsupported_host',
  },
];

describe('parseRepoUrl — rejected shapes', () => {
  for (const c of REJECT) {
    it(`${c.name} → ${c.code}`, () => {
      try {
        parseRepoUrl(c.input);
        throw new Error(`expected parseRepoUrl(${JSON.stringify(c.input)}) to throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(RepoError);
        expect((err as RepoError).code).toBe(c.code);
      }
    });
  }

  it('covers a spread of rejections (>= 10 reject cases)', () => {
    expect(REJECT.length).toBeGreaterThanOrEqual(10);
  });
});

/* -------------------------------------------------------------------------- */
/* formatRepoLabel                                                            */
/* -------------------------------------------------------------------------- */

describe('formatRepoLabel', () => {
  const base: RepoRef = {
    host: 'github',
    owner: 'acme',
    repo: 'store',
    branch: null,
    subdir: null,
    canonicalUrl: 'https://github.com/acme/store',
  };

  it('owner/repo only', () => {
    expect(formatRepoLabel(base)).toBe('acme/store');
  });
  it('with branch', () => {
    expect(formatRepoLabel({ ...base, branch: 'main' })).toBe('acme/store · main');
  });
  it('with subdir only', () => {
    expect(formatRepoLabel({ ...base, subdir: 'apps/web' })).toBe('acme/store · /apps/web');
  });
  it('with branch and subdir', () => {
    expect(formatRepoLabel({ ...base, branch: 'main', subdir: 'apps/web' })).toBe(
      'acme/store · main · /apps/web',
    );
  });
});
