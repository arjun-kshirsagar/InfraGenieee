/**
 * Tests for the PURE service-need inference `detectNeeds` (task B4).
 *
 * These are the credibility gate for "this app needs a database". They prove:
 *
 *   1. Determinism — same probe in → deep-equal out.
 *   2. Each need fires on a POSITIVE fixture and stays silent on a NEGATIVE one.
 *   3. THE ANTI-FABRICATION GATE — every emitted signal's `excerpt` is a real
 *      verbatim substring of the file it cites (or the path, for file-present).
 *   4. `better-sqlite3` yields a NOTE, never a `database` need.
 *   5. A queue dependency IMPLIES `background-worker`.
 *   6. A `.env.example` VALUE never appears in any excerpt — asserted against a
 *      fixture whose values contain a fake secret token.
 *
 * OFFLINE and pure: no network, no clock, no fetch.
 */

import { describe, expect, it } from 'vitest';

import { detectNeeds } from '@/lib/deploy/detect/needs';
import { parsePackageJson, type Probe } from '@/lib/deploy/detect/rules';

/* -------------------------------------------------------------------------- */
/* Probe builder over a flat file map                                         */
/* -------------------------------------------------------------------------- */

function probeOf(files: Record<string, string>, extraPresent: string[] = []): Probe {
  const present = new Set([...Object.keys(files), ...extraPresent]);
  const pkgRaw = files['package.json'];
  return {
    pkg: pkgRaw !== undefined ? parsePackageJson(pkgRaw) : null,
    present: (p) => present.has(p),
    content: (p) => files[p],
  };
}

function pkg(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2);
}

/** Assert every signal cites a real verbatim substring of the file it names. */
function assertCitationsReal(files: Record<string, string>, probe: Probe): void {
  const { signals } = detectNeeds(probe);
  for (const s of signals) {
    if (s.kind === 'file-present') {
      expect(s.excerpt, `file-present ${s.id} must cite its path`).toBe(s.path);
      continue;
    }
    const content = files[s.path];
    expect(content, `signal ${s.id} cites file "${s.path}" we don't have`).toBeDefined();
    expect(
      content!.includes(s.excerpt),
      `signal ${s.id} excerpt ${JSON.stringify(s.excerpt)} is NOT a substring of ${s.path} — fabricated citation`,
    ).toBe(true);
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Determinism                                                             */
/* -------------------------------------------------------------------------- */

describe('detectNeeds — determinism (purity)', () => {
  it('same probe in → deep-equal out', () => {
    const files = { 'package.json': pkg({ dependencies: { pg: '^8.11.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe)).toEqual(detectNeeds(probe));
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Per-need positive + negative                                            */
/* -------------------------------------------------------------------------- */

describe('detectNeeds — database', () => {
  it('POSITIVE: prisma dependency → database', () => {
    const files = { 'package.json': pkg({ dependencies: { '@prisma/client': '^5.11.0' } }) };
    const probe = probeOf(files);
    const { needs } = detectNeeds(probe);
    expect(needs).toContain('database');
    assertCitationsReal(files, probe);
  });

  it('POSITIVE: pg driver → database', () => {
    const files = { 'package.json': pkg({ dependencies: { pg: '^8.11.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('database');
  });

  it('POSITIVE: Django in requirements.txt → database', () => {
    const files = { 'requirements.txt': 'Django==5.0.3\npsycopg2-binary==2.9.9\n' };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('database');
    assertCitationsReal(files, probe);
  });

  it('POSITIVE: activerecord in Gemfile → database', () => {
    const files = { Gemfile: "source 'https://rubygems.org'\ngem 'activerecord'\n" };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('database');
    assertCitationsReal(files, probe);
  });

  it('POSITIVE: postgres service in docker-compose → database', () => {
    const files = {
      'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n',
    };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('database');
    assertCitationsReal(files, probe);
  });

  it('NEGATIVE: a plain Vite SPA → no database', () => {
    const files = { 'package.json': pkg({ devDependencies: { vite: '^5.2.0', react: '^18.2.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).not.toContain('database');
  });
});

describe('detectNeeds — cache', () => {
  it('POSITIVE: ioredis → cache', () => {
    const files = { 'package.json': pkg({ dependencies: { ioredis: '^5.3.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('cache');
    assertCitationsReal(files, probe);
  });

  it('POSITIVE: REDIS_URL key in .env.example → cache', () => {
    const files = { '.env.example': 'REDIS_URL=redis://localhost:6379\n' };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('cache');
    assertCitationsReal(files, probe);
  });

  it('NEGATIVE: no redis anywhere → no cache', () => {
    const files = { 'package.json': pkg({ dependencies: { next: '^15.0.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).not.toContain('cache');
  });
});

describe('detectNeeds — queue', () => {
  it('POSITIVE: bullmq → queue', () => {
    const files = { 'package.json': pkg({ dependencies: { bullmq: '^5.0.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('queue');
    assertCitationsReal(files, probe);
  });

  it('POSITIVE: celery in requirements → queue', () => {
    const files = { 'requirements.txt': 'celery==5.3.6\nredis==5.0.1\n' };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('queue');
    assertCitationsReal(files, probe);
  });

  it('NEGATIVE: no queue lib → no queue', () => {
    const files = { 'package.json': pkg({ dependencies: { express: '^4.19.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).not.toContain('queue');
  });
});

describe('detectNeeds — websockets', () => {
  it('POSITIVE: socket.io → websockets', () => {
    const files = { 'package.json': pkg({ dependencies: { 'socket.io': '^4.7.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('websockets');
    assertCitationsReal(files, probe);
  });

  it('NEGATIVE: plain express → no websockets', () => {
    const files = { 'package.json': pkg({ dependencies: { express: '^4.19.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).not.toContain('websockets');
  });
});

describe('detectNeeds — cron', () => {
  it('POSITIVE: node-cron → cron', () => {
    const files = { 'package.json': pkg({ dependencies: { 'node-cron': '^3.0.3' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('cron');
    assertCitationsReal(files, probe);
  });

  it('POSITIVE: a crons field in vercel.json → cron', () => {
    const files = {
      'vercel.json': '{\n  "crons": [{ "path": "/api/cron", "schedule": "0 0 * * *" }]\n}\n',
    };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('cron');
    assertCitationsReal(files, probe);
  });

  it('NEGATIVE: a vercel.json with no crons → no cron', () => {
    const files = { 'vercel.json': '{ "framework": "nextjs" }\n' };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).not.toContain('cron');
  });
});

describe('detectNeeds — object-storage', () => {
  it('POSITIVE: @aws-sdk/client-s3 → object-storage', () => {
    const files = { 'package.json': pkg({ dependencies: { '@aws-sdk/client-s3': '^3.500.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('object-storage');
    assertCitationsReal(files, probe);
  });

  it('POSITIVE: boto3 in requirements → object-storage', () => {
    const files = { 'requirements.txt': 'boto3==1.34.0\n' };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('object-storage');
    assertCitationsReal(files, probe);
  });

  it('POSITIVE: AWS_S3_BUCKET key in .env.example → object-storage', () => {
    const files = { '.env.example': 'AWS_S3_BUCKET=my-bucket-name\n' };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('object-storage');
    assertCitationsReal(files, probe);
  });

  it('NEGATIVE: no storage signal → no object-storage', () => {
    const files = { 'package.json': pkg({ dependencies: { next: '^15.0.0' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).not.toContain('object-storage');
  });
});

describe('detectNeeds — background-worker', () => {
  it('POSITIVE: a `worker` script → background-worker', () => {
    const files = {
      'package.json': pkg({ scripts: { start: 'node index.js', worker: 'node worker.js' } }),
    };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('background-worker');
    assertCitationsReal(files, probe);
  });

  it('POSITIVE: a Procfile worker line → background-worker', () => {
    const files = { Procfile: 'web: node index.js\nworker: node worker.js\n' };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).toContain('background-worker');
    assertCitationsReal(files, probe);
  });

  it('NEGATIVE: only a web script → no background-worker', () => {
    const files = { 'package.json': pkg({ scripts: { start: 'node index.js', build: 'tsc' } }) };
    const probe = probeOf(files);
    expect(detectNeeds(probe).needs).not.toContain('background-worker');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. SQLite is a NOTE, never a database need                                 */
/* -------------------------------------------------------------------------- */

describe('detectNeeds — SQLite is not a managed-database need', () => {
  it('better-sqlite3 yields a note, NOT a database need', () => {
    const files = { 'package.json': pkg({ dependencies: { 'better-sqlite3': '^11.0.0' } }) };
    const probe = probeOf(files);
    const { needs, notes } = detectNeeds(probe);
    expect(needs).not.toContain('database');
    expect(notes.some((n) => n.toLowerCase().includes('sqlite'))).toBe(true);
  });

  it('better-sqlite3 alongside a real Postgres dep still reports database (from pg)', () => {
    const files = {
      'package.json': pkg({ dependencies: { 'better-sqlite3': '^11.0.0', pg: '^8.11.0' } }),
    };
    const probe = probeOf(files);
    const { needs, notes } = detectNeeds(probe);
    expect(needs).toContain('database'); // from pg, not from better-sqlite3
    expect(notes.some((n) => n.toLowerCase().includes('sqlite'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. A queue implies a background-worker                                      */
/* -------------------------------------------------------------------------- */

describe('detectNeeds — a queue implies a background worker', () => {
  it('bullmq → both queue AND background-worker', () => {
    const files = { 'package.json': pkg({ dependencies: { bullmq: '^5.0.0' } }) };
    const probe = probeOf(files);
    const { needs, notes } = detectNeeds(probe);
    expect(needs).toContain('queue');
    expect(needs).toContain('background-worker');
    expect(notes.some((n) => n.toLowerCase().includes('worker'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. THE .env.example SECRET GATE                                            */
/* -------------------------------------------------------------------------- */

describe('detectNeeds — a .env.example value never enters an excerpt', () => {
  // A placeholder env file: keys are cited, values are NEVER echoed.
  it('cites KEY names but no VALUE appears in any excerpt (placeholder file)', () => {
    const secretValue = 'REPLACE_ME_PLACEHOLDER'; // an obvious placeholder → file IS read
    const files = {
      '.env.example': [
        `DATABASE_URL=postgres://user:pass@localhost:5432/mydb`,
        `REDIS_URL=redis://localhost:6379`,
        `AWS_S3_BUCKET=your-bucket-here`,
        `API_TOKEN=${secretValue}`,
      ].join('\n') + '\n',
    };
    const probe = probeOf(files);
    const { needs, signals } = detectNeeds(probe);
    expect(needs).toContain('database');
    expect(needs).toContain('cache');
    expect(needs).toContain('object-storage');
    // No excerpt may contain any VALUE substring.
    for (const s of signals) {
      expect(s.excerpt).not.toContain('postgres://');
      expect(s.excerpt).not.toContain('redis://');
      expect(s.excerpt).not.toContain('user:pass');
      expect(s.excerpt).not.toContain('your-bucket-here');
      expect(s.excerpt).not.toContain(secretValue);
    }
    // Every cited excerpt is still a real substring of the file.
    assertCitationsReal(files, probe);
  });

  // A file whose values look like REAL secrets: it must be refused entirely.
  it('refuses a .env.example that contains real-looking secret values', () => {
    const realSecret = 'sk9d8f7A6bC5e4F3g2H1j0kLmN9pQ8rS'; // long, mixed, high-entropy
    const files = {
      '.env.example': `DATABASE_URL=postgres://admin:${realSecret}@db.prod.internal:5432/app\nSTRIPE_KEY=${realSecret}\n`,
    };
    const probe = probeOf(files);
    const { needs, signals, notes } = detectNeeds(probe);
    // The file was refused: no need derived from it, and a note explains why.
    expect(needs).not.toContain('database');
    expect(notes.some((n) => n.toLowerCase().includes('real values'))).toBe(true);
    // And, categorically, the secret is nowhere in any excerpt.
    for (const s of signals) {
      expect(s.excerpt).not.toContain(realSecret);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Anti-fabrication sweep across a matrix                                  */
/* -------------------------------------------------------------------------- */

describe('detectNeeds — no uncited claim across a matrix', () => {
  const matrix: Array<{ name: string; files: Record<string, string> }> = [
    { name: 'prisma', files: { 'package.json': pkg({ dependencies: { prisma: '^5.11.0' } }) } },
    { name: 'redis', files: { 'package.json': pkg({ dependencies: { redis: '^4.6.0' } }) } },
    { name: 'kafkajs', files: { 'package.json': pkg({ dependencies: { kafkajs: '^2.2.0' } }) } },
    { name: 'sidekiq', files: { Gemfile: "gem 'sidekiq'\n" } },
    {
      name: 'compose-redis',
      files: { 'compose.yaml': 'services:\n  cache:\n    image: redis:7\n' },
    },
    { name: 'render-cron', files: { 'render.yaml': 'services:\n  - type: cron\n    schedule: "0 * * * *"\n' } },
  ];

  for (const { name, files } of matrix) {
    it(`"${name}": every emitted signal cites a real substring`, () => {
      const probe = probeOf(files);
      const { needs } = detectNeeds(probe);
      // The need set is non-empty for these (a sanity check on the fixture).
      expect(needs.length).toBeGreaterThan(0);
      assertCitationsReal(files, probe);
    });
  }
});
