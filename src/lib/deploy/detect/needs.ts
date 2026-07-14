/**
 * InfraGenie — Feature 3, service-need inference (task B4, docs §2).
 *
 * `detectNeeds(probe)` decides which managed services an app appears to need —
 * `database`, `cache`, `queue`, `object-storage`, `cron`, `websockets`,
 * `background-worker`. This is the axis that pushes the recommendation toward
 * Render (it has managed Postgres/Redis and long-lived workers; Vercel/Netlify
 * need an external add-on). Getting it wrong in either direction is bad:
 *
 *   - a FALSE POSITIVE tells the user to provision a database they don't need;
 *   - a FALSE NEGATIVE sends a Postgres app to a provider that can't host one.
 *
 * ## The one invariant everything here obeys
 *
 * **Every need cites a real file.** A `ServiceNeed` with no supporting
 * `DetectionSignal` must not exist. Signals are minted only through
 * `citedSignal` / `depExcerpt` (from `rules.ts`), which refuse to produce a
 * citation whose `excerpt` is not a genuine verbatim substring of the file it
 * names. The tests assert this again programmatically (the anti-fabrication
 * gate), so an invented need cannot survive.
 *
 * ## Purity
 *
 * No `Date`, no network, no randomness. Same probe in → identical result out.
 *
 * ## The `.env.example` rule (hard)
 *
 * We may cite the PRESENCE of a KEY name (`DATABASE_URL`, `REDIS_URL`, …). We
 * must NEVER read, echo, or place a VALUE into an `excerpt` — the result ends
 * up rendered in a browser, and a `.env` value can be a live secret. If the
 * file looks like a real `.env` (values that are not obviously placeholders) we
 * skip it entirely and add a note instead. Only the quoted/bare KEY token —
 * which is by construction a real substring and carries no secret — is cited.
 */

import type { DetectionSignal, ServiceNeed } from '@/types/deploy';

import { citedSignal, depExcerpt, type Probe } from './rules';

export interface NeedsVerdict {
  needs: ServiceNeed[];
  signals: DetectionSignal[];
  notes: string[];
}

/* -------------------------------------------------------------------------- */
/* Accumulator — keeps needs, signals and notes de-duplicated                 */
/* -------------------------------------------------------------------------- */

class NeedsAcc {
  private readonly needSet = new Set<ServiceNeed>();
  private readonly signalIds = new Set<string>();
  private readonly signalList: DetectionSignal[] = [];
  private readonly noteSet = new Set<string>();
  private readonly noteList: string[] = [];

  addNeed(need: ServiceNeed): void {
    this.needSet.add(need);
  }

  /** Record a signal (de-duped by id). Never mints one itself — the caller
   *  passes an already-cited signal produced by `citedSignal`/`depExcerpt`. */
  addSignal(signal: DetectionSignal | null): boolean {
    if (!signal) return false;
    if (this.signalIds.has(signal.id)) return true;
    this.signalIds.add(signal.id);
    this.signalList.push(signal);
    return true;
  }

  /** Attach a need together with the cited signal that justifies it. The need
   *  is only asserted when the signal is real — a null signal (needle absent
   *  from the file) records nothing, upholding "no need without a citation". */
  addCited(need: ServiceNeed, signal: DetectionSignal | null): boolean {
    if (!signal) return false;
    this.addSignal(signal);
    this.addNeed(need);
    return true;
  }

  addNote(note: string): void {
    const trimmed = note.length > 300 ? note.slice(0, 300) : note;
    if (this.noteSet.has(trimmed)) return;
    this.noteSet.add(trimmed);
    this.noteList.push(trimmed);
  }

  has(need: ServiceNeed): boolean {
    return this.needSet.has(need);
  }

  result(): NeedsVerdict {
    return { needs: [...this.needSet], signals: this.signalList, notes: this.noteList };
  }
}

/* -------------------------------------------------------------------------- */
/* Evidence tables (dep name → the need it implies)                           */
/* -------------------------------------------------------------------------- */

/**
 * package.json dependencies that imply a managed-database need. `better-sqlite3`
 * is deliberately ABSENT — a file DB is handled separately as a note, not a
 * managed-database need.
 */
const DB_DEPS: ReadonlyArray<[string, string]> = [
  ['prisma', '`prisma` → a managed SQL database'],
  ['@prisma/client', '`@prisma/client` → a managed SQL database'],
  ['drizzle-orm', '`drizzle-orm` → a managed SQL database'],
  ['typeorm', '`typeorm` → a managed SQL database'],
  ['sequelize', '`sequelize` → a managed SQL database'],
  ['mongoose', '`mongoose` → a managed MongoDB database'],
  ['knex', '`knex` → a managed SQL database'],
  ['pg', '`pg` (Postgres driver) → a managed Postgres database'],
  ['mysql2', '`mysql2` (MySQL driver) → a managed MySQL database'],
];

const CACHE_DEPS: ReadonlyArray<[string, string]> = [
  ['redis', '`redis` → a Redis cache'],
  ['ioredis', '`ioredis` → a Redis cache'],
  ['@upstash/redis', '`@upstash/redis` → a Redis cache'],
];

const QUEUE_DEPS: ReadonlyArray<[string, string]> = [
  ['bullmq', '`bullmq` → a job queue'],
  ['bull', '`bull` → a job queue'],
  ['kafkajs', '`kafkajs` → a Kafka message queue'],
  ['graphile-worker', '`graphile-worker` → a Postgres-backed job queue'],
  ['amqplib', '`amqplib` (RabbitMQ client) → a message queue'],
];

const WS_DEPS: ReadonlyArray<[string, string]> = [
  ['socket.io', '`socket.io` → websockets (needs a long-lived server)'],
  ['ws', '`ws` → websockets (needs a long-lived server)'],
  ['@nestjs/websockets', '`@nestjs/websockets` → websockets'],
];

const CRON_DEPS: ReadonlyArray<[string, string]> = [
  ['node-cron', '`node-cron` → scheduled jobs (cron)'],
  ['croner', '`croner` → scheduled jobs (cron)'],
];

const STORAGE_DEPS: ReadonlyArray<[string, string]> = [
  ['@aws-sdk/client-s3', '`@aws-sdk/client-s3` → S3 object storage'],
  ['aws-sdk', '`aws-sdk` → AWS object storage'],
  ['cloudinary', '`cloudinary` → managed object/media storage'],
  ['@vercel/blob', '`@vercel/blob` → object storage'],
  ['multer', '`multer` → uploaded-file storage (disk is ephemeral)'],
];

/**
 * Python `requirements.txt` / `pyproject.toml` substrings.
 * `[needle, need, implies]`. Needles are matched case-insensitively by lower-
 * casing the file first, but the CITED excerpt is sliced from the ORIGINAL text
 * so it stays verbatim.
 */
const PY_EVIDENCE: ReadonlyArray<[string, ServiceNeed, string]> = [
  ['psycopg2', 'database', 'psycopg2 → a managed Postgres database'],
  ['psycopg', 'database', 'psycopg → a managed Postgres database'],
  ['asyncpg', 'database', 'asyncpg → a managed Postgres database'],
  ['sqlalchemy', 'database', 'SQLAlchemy → a managed SQL database'],
  ['django', 'database', 'Django → a managed SQL database'],
  ['redis', 'cache', 'redis → a Redis cache'],
  ['celery', 'queue', 'celery → a task queue'],
  ['boto3', 'object-storage', 'boto3 → AWS/S3 object storage'],
];

/** Gemfile substrings. */
const RUBY_EVIDENCE: ReadonlyArray<[string, ServiceNeed, string]> = [
  ['activerecord', 'database', 'activerecord → a managed SQL database'],
  ['pg', 'database', "gem 'pg' → a managed Postgres database"],
  ['sidekiq', 'queue', 'sidekiq → a job queue'],
];

/** `.env.example` KEY tokens → the need they imply. We cite the KEY only. */
const ENV_KEY_EVIDENCE: ReadonlyArray<[string, ServiceNeed, string]> = [
  ['DATABASE_URL', 'database', '`DATABASE_URL` env key → a managed database'],
  ['MONGO_URI', 'database', '`MONGO_URI` env key → a managed MongoDB database'],
  ['MONGODB_URI', 'database', '`MONGODB_URI` env key → a managed MongoDB database'],
  ['REDIS_URL', 'cache', '`REDIS_URL` env key → a Redis cache'],
  ['AWS_S3_BUCKET', 'object-storage', '`AWS_S3_BUCKET` env key → S3 object storage'],
];

/** Prefix-matched env keys (e.g. any `POSTGRES_*`, any `S3_*`). */
const ENV_PREFIX_EVIDENCE: ReadonlyArray<[string, ServiceNeed, string]> = [
  ['POSTGRES_', 'database', '`POSTGRES_*` env key → a managed Postgres database'],
  ['S3_', 'object-storage', '`S3_*` env key → S3 object storage'],
];

/* -------------------------------------------------------------------------- */
/* The detector                                                               */
/* -------------------------------------------------------------------------- */

export function detectNeeds(probe: Probe): NeedsVerdict {
  const acc = new NeedsAcc();

  scanNodeDeps(probe, acc);
  scanSqlite(probe, acc);
  scanScriptsAndProcfile(probe, acc);
  scanDockerCompose(probe, acc);
  scanRequirements(probe, acc);
  scanGemfile(probe, acc);
  scanCron(probe, acc);
  scanEnvExample(probe, acc);

  // A queue implies a consumer: something has to drain it. So a detected queue
  // ALSO implies a background-worker. We reuse the queue's own citation rather
  // than minting a new signal (there's no separate file to cite), and record a
  // note explaining the inference so the UI can show its reasoning.
  if (acc.has('queue') && !acc.has('background-worker')) {
    acc.addNeed('background-worker');
    acc.addNote(
      'A queue library was detected, which implies a background worker to consume the queue. Vercel/Netlify have no long-lived worker; Render (or a separate worker service) does.',
    );
  }

  return acc.result();
}

/* -------------------------------------------------------------------------- */
/* Node: package.json dependencies                                            */
/* -------------------------------------------------------------------------- */

function nodeDepSignal(
  probe: Probe,
  id: string,
  dep: string,
  implies: string,
): DetectionSignal | null {
  if (!probe.pkg) return null;
  const excerpt = depExcerpt(probe.pkg, dep);
  if (!excerpt) return null;
  return { id, kind: 'dependency', path: 'package.json', excerpt, implies, weight: 'weak' };
}

function scanNodeDeps(probe: Probe, acc: NeedsAcc): void {
  if (!probe.pkg) return;
  const tables: ReadonlyArray<[ServiceNeed, ReadonlyArray<[string, string]>]> = [
    ['database', DB_DEPS],
    ['cache', CACHE_DEPS],
    ['queue', QUEUE_DEPS],
    ['websockets', WS_DEPS],
    ['cron', CRON_DEPS],
    ['object-storage', STORAGE_DEPS],
  ];
  for (const [need, table] of tables) {
    for (const [dep, implies] of table) {
      acc.addCited(need, nodeDepSignal(probe, `need:${need}:${dep}`, dep, implies));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* SQLite: a file DB, NOT a managed-database need                             */
/* -------------------------------------------------------------------------- */

function scanSqlite(probe: Probe, acc: NeedsAcc): void {
  // better-sqlite3 dependency, OR a committed *.sqlite / *.db file.
  const hasBetterSqlite =
    probe.pkg && depExcerpt(probe.pkg, 'better-sqlite3') !== null;
  const hasSqliteDep = probe.pkg && depExcerpt(probe.pkg, 'sqlite3') !== null;

  if (hasBetterSqlite || hasSqliteDep) {
    acc.addNote(
      'A SQLite dependency was found. SQLite is a local file database, not a managed service — it will NOT survive an ephemeral/serverless filesystem. Use a managed database, or a persistent disk, if the data must last.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Background worker: scripts, Procfile                                       */
/* -------------------------------------------------------------------------- */

/** Verbatim excerpt of a package.json script entry (`"worker": "node w.js"`). */
function scriptExcerpt(rawPkg: string, script: string, cmd: string): string | null {
  const pretty = `"${script}": "${cmd}"`;
  if (rawPkg.includes(pretty)) return pretty;
  const compact = `"${script}":"${cmd}"`;
  if (rawPkg.includes(compact)) return compact;
  const key = `"${script}"`;
  if (rawPkg.includes(key)) return key;
  return null;
}

function scanScriptsAndProcfile(probe: Probe, acc: NeedsAcc): void {
  // package.json `worker` / `worker:*` script.
  if (probe.pkg) {
    for (const [name, cmd] of Object.entries(probe.pkg.scripts)) {
      if (name === 'worker' || name.startsWith('worker:')) {
        const excerpt = scriptExcerpt(probe.pkg.raw, name, cmd);
        if (excerpt) {
          acc.addCited('background-worker', {
            id: `need:background-worker:script:${name}`,
            kind: 'script',
            path: 'package.json',
            excerpt,
            implies: `\`${name}\` script → a background worker process`,
            weight: 'weak',
          });
        }
      }
    }
  }

  // Procfile with a `worker:` line (Heroku/Render convention).
  const procfile = probe.content('Procfile');
  if (procfile) {
    acc.addCited(
      'background-worker',
      citedSignal(
        'file-content',
        'need:background-worker:procfile',
        'Procfile',
        procfile,
        'worker:',
        'a `worker:` line in the Procfile → a background worker process',
        'strong',
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* docker-compose services                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cite a compose service by name. We match on the literal image/service token
 * as it appears verbatim in the file (`postgres`, `redis`, …) so the excerpt is
 * a real substring. This is a heuristic, not a YAML parse — it is intentionally
 * conservative and only fires on well-known image names.
 */
function scanDockerCompose(probe: Probe, acc: NeedsAcc): void {
  const paths = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  let path: string | null = null;
  let body: string | undefined;
  for (const p of paths) {
    const c = probe.content(p);
    if (c !== undefined) {
      path = p;
      body = c;
      break;
    }
  }
  if (!path || body === undefined) return;

  const compose = body;
  const tables: ReadonlyArray<[ServiceNeed, ReadonlyArray<[string, string]>]> = [
    [
      'database',
      [
        ['postgres', 'a `postgres` service in docker-compose → a managed database'],
        ['mysql', 'a `mysql` service in docker-compose → a managed database'],
        ['mariadb', 'a `mariadb` service in docker-compose → a managed database'],
        ['mongo', 'a `mongo` service in docker-compose → a managed database'],
      ],
    ],
    [
      'cache',
      [['redis', 'a `redis` service in docker-compose → a cache']],
    ],
    [
      'queue',
      [
        ['rabbitmq', 'a `rabbitmq` service in docker-compose → a message queue'],
        ['kafka', 'a `kafka` service in docker-compose → a message queue'],
      ],
    ],
  ];
  for (const [need, table] of tables) {
    for (const [needle, implies] of table) {
      acc.addCited(
        need,
        citedSignal(
          'file-content',
          `need:${need}:compose:${needle}`,
          path,
          compose,
          needle,
          implies,
          'weak',
        ),
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Python: requirements.txt / pyproject.toml                                  */
/* -------------------------------------------------------------------------- */

/**
 * Case-insensitive substring locate that returns the VERBATIM slice from the
 * original text (so the excerpt is a real substring even when the dependency is
 * written with different casing than our needle).
 */
function verbatimSlice(haystack: string, needleLower: string): string | null {
  const idx = haystack.toLowerCase().indexOf(needleLower);
  if (idx === -1) return null;
  return haystack.slice(idx, idx + needleLower.length);
}

function scanRequirements(probe: Probe, acc: NeedsAcc): void {
  const sources: Array<[string, string | undefined]> = [
    ['requirements.txt', probe.content('requirements.txt')],
    ['pyproject.toml', probe.content('pyproject.toml')],
  ];
  for (const [path, body] of sources) {
    if (body === undefined) continue;
    for (const [needle, need, implies] of PY_EVIDENCE) {
      const verbatim = verbatimSlice(body, needle);
      if (verbatim === null) continue;
      acc.addCited(
        need,
        citedSignal('dependency', `need:${need}:py:${needle}`, path, body, verbatim, implies, 'weak'),
      );
    }
    // celery beat → cron (only when celery already implied a queue above).
    if (verbatimSlice(body, 'celery beat') !== null) {
      const verbatim = verbatimSlice(body, 'celery beat')!;
      acc.addCited(
        'cron',
        citedSignal('file-content', `need:cron:py:celery-beat`, path, body, verbatim, 'celery beat → scheduled jobs (cron)', 'weak'),
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Ruby: Gemfile                                                              */
/* -------------------------------------------------------------------------- */

function scanGemfile(probe: Probe, acc: NeedsAcc): void {
  const gemfile = probe.content('Gemfile');
  if (gemfile === undefined) return;
  for (const [needle, need, implies] of RUBY_EVIDENCE) {
    acc.addCited(
      need,
      citedSignal('dependency', `need:${need}:rb:${needle}`, 'Gemfile', gemfile, needle, implies, 'weak'),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* cron: vercel.json crons, render.yaml schedules                             */
/* -------------------------------------------------------------------------- */

function scanCron(probe: Probe, acc: NeedsAcc): void {
  const vercel = probe.content('vercel.json');
  if (vercel !== undefined) {
    acc.addCited(
      'cron',
      citedSignal(
        'file-content',
        'need:cron:vercel',
        'vercel.json',
        vercel,
        '"crons"',
        'a `crons` field in vercel.json → scheduled jobs (cron)',
        'strong',
      ),
    );
  }
  const render = probe.content('render.yaml');
  if (render !== undefined) {
    acc.addCited(
      'cron',
      citedSignal(
        'file-content',
        'need:cron:render',
        'render.yaml',
        render,
        'schedule',
        'a `schedule` in render.yaml → scheduled jobs (cron)',
        'strong',
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* .env.example — KEY names only, NEVER a value                               */
/* -------------------------------------------------------------------------- */

/**
 * Does a line's VALUE look like a real secret rather than an obvious
 * placeholder? Placeholders are things people commit on purpose: empty, a
 * single token like `changeme`, `your-...`, `xxx`, `<...>`, `example`, a bare
 * `postgres://user:pass@host/db` template, etc. Anything that looks like real
 * entropy (long, mixed-case+digits, base64/hex-ish) is treated as a real value
 * and makes us refuse to read the file at all.
 */
function looksLikeRealSecret(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, '');
  if (v.length === 0) return false;
  const lower = v.toLowerCase();
  const placeholderTokens = [
    'changeme', 'change_me', 'your', 'example', 'placeholder', 'todo', 'xxx',
    'secret', 'password', 'pass', 'value', 'here', 'dummy', 'test', 'localhost',
    'user', 'username', 'host', 'dbname', 'db', 'foo', 'bar', 'baz',
  ];
  // Templated connection strings and obviously-fake values are fine.
  if (/^<.*>$/.test(v)) return false;
  if (/\$\{.*\}/.test(v)) return false; // ${SOMETHING} interpolation
  if (placeholderTokens.some((t) => lower.includes(t))) return false;
  // A URL template like postgres://user:pass@localhost:5432/db — already caught
  // by the tokens above (user/pass/localhost/db). A remaining bare scheme URL
  // with a real-looking host+creds is suspicious.
  // Heuristic for "real": long and high-entropy-ish (letters+digits, no spaces).
  if (v.length >= 16 && /[A-Za-z]/.test(v) && /[0-9]/.test(v) && !/\s/.test(v)) {
    return true;
  }
  return false;
}

function scanEnvExample(probe: Probe, acc: NeedsAcc): void {
  const path = '.env.example';
  const body = probe.content(path);
  if (body === undefined) return;

  // Guard: if any line's VALUE looks like a real secret, refuse the file
  // entirely and note it. Secrets must never travel into a rendered plan.
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const value = line.slice(eq + 1);
    if (looksLikeRealSecret(value)) {
      acc.addNote(
        'A .env.example file was present but appears to contain real values, so it was NOT read for service-need inference. Commit only placeholder values in example env files.',
      );
      return;
    }
  }

  // Collect only the KEY tokens (left of `=`). We cite the KEY token itself,
  // which is a verbatim substring and by construction carries no value.
  const keys = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim().replace(/^export\s+/, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) keys.add(key);
  }

  for (const [needle, need, implies] of ENV_KEY_EVIDENCE) {
    if (!keys.has(needle)) continue;
    // Cite the KEY token as it appears in the file (verbatim, no value).
    acc.addCited(
      need,
      citedSignal('file-content', `need:${need}:env:${needle}`, path, body, needle, implies, 'weak'),
    );
  }
  for (const [prefix, need, implies] of ENV_PREFIX_EVIDENCE) {
    const match = [...keys].find((k) => k.startsWith(prefix));
    if (!match) continue;
    acc.addCited(
      need,
      citedSignal('file-content', `need:${need}:env:${prefix}`, path, body, match, implies, 'weak'),
    );
  }
}
