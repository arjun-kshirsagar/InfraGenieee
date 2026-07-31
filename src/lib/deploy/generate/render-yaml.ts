/**
 * InfraGenie — Feature 3, the PURE `render.yaml` blueprint generator (task B6,
 * docs §7).
 *
 * `generateRenderYaml(detection, ref)` turns a `StackDetection` (plus the repo
 * `RepoRef`) into a Render Blueprint the user can copy or download into THEIR
 * OWN repo. We never commit to their repo — we generate text they paste.
 *
 * ## What "correct" means here
 *
 * The reviewer runs the emitted `content` through a real YAML parser and asserts
 * it parses. A blueprint that does not parse is worse than no blueprint, so this
 * module hand-builds YAML with a tiny, deterministic serializer (no clever
 * indentation, every string that could be ambiguous is quoted) rather than
 * gambling on a formatter.
 *
 * ## The spec this is built against (verified 2026-07-28)
 *
 * Fields, values and defaults are taken verbatim from Render's Blueprint YAML
 * Reference: https://render.com/docs/blueprint-spec
 *
 *   - `services[].type`      → `web` (a static site is `type: web` + `runtime: static`),
 *                              `worker`, `cron`, or `keyvalue` (a Redis/key-value store).
 *   - `services[].runtime`   → `node|python|ruby|go|rust|elixir|docker|static`.
 *                              This field REPLACES the deprecated `env` field.
 *   - `services[].buildCommand` / `startCommand` — required for non-Docker services.
 *   - `services[].staticPublishPath` — REQUIRED for a static site.
 *   - `services[].rootDir`   — the service's root dir within the repo; set for a
 *                              monorepo subdir. This is why a Render subdir is NOT
 *                              in the deploy URL (docs §4) — it lives here.
 *   - `services[].autoDeploy: false` — Render's own recommendation for repos
 *                              deployed via the Deploy-to-Render button; without
 *                              it every push to the source repo redeploys every
 *                              instance created from it. STILL SUPPORTED and
 *                              equivalent to `autoDeployTrigger: off`. We emit the
 *                              documented, button-recommended `autoDeploy: false`.
 *   - `databases[]`          → a Render Postgres instance (only when a `database`
 *                              need was detected). `plan: free` for the template.
 *   - a `keyvalue` SERVICE   → a Render Key Value (Redis) store, in the `services`
 *                              list, only when a `cache` need was detected. It
 *                              REQUIRES `ipAllowList`.
 *   - `envVars[]` with `sync: false` — Render prompts the user for the value at
 *                              blueprint-creation time. We NEVER emit a literal
 *                              value, never a secret, never anything read out of
 *                              the repo's env files. A `fromDatabase` reference
 *                              wires the managed Postgres/Redis URL in without a
 *                              secret ever touching the file.
 *
 * ## Purity
 *
 * No `Date`, no network, no randomness. Same `(detection, ref)` in → identical
 * `ConfigArtifact | null` out.
 */

import {
  configArtifactSchema,
  type ConfigArtifact,
  type Runtime,
  type StackDetection,
  type RepoRef,
} from '@/types/deploy';

/* -------------------------------------------------------------------------- */
/* When do we emit a blueprint at all?                                        */
/* -------------------------------------------------------------------------- */

/**
 * Emit `render.yaml` when the app is `fullstack`/`api-only` OR any `ServiceNeed`
 * was detected OR it is a static site OR it ships a Dockerfile — i.e. any shape
 * where the Render button needs the blueprint to know what to build. But NEVER
 * when the repo already contains a `render.yaml`: we must not tell the user to
 * add a file they already have (docs §6 `applyRenderConfigGate`).
 */
function shouldEmitRenderYaml(detection: StackDetection): boolean {
  if (detection.existing.render) return false;
  return (
    detection.appShape === 'fullstack' ||
    detection.appShape === 'api-only' ||
    detection.appShape === 'static' ||
    detection.runtime === 'docker' ||
    detection.needs.length > 0
  );
}

/* -------------------------------------------------------------------------- */
/* Blueprint completeness — do we have to fall back to a placeholder command?  */
/* -------------------------------------------------------------------------- */

/**
 * True when the blueprint we would emit contains at least one PLACEHOLDER value
 * the user must replace before the deploy actually works — a `buildCommand` /
 * `startCommand` we couldn't detect (emitted as `echo "TODO: ..."`), a
 * `staticPublishPath` we had to guess (`./dist`), or a worker/cron service whose
 * start command is inherently unknowable.
 *
 * This is the single source of truth for "the blueprint is incomplete". The
 * generator uses it to flip `required`/`why`, and `recommend` uses it (via the
 * same detection) to warn the user BEFORE the deploy button. They MUST agree,
 * so the placeholder logic lives here and only here — it mirrors, branch for
 * branch, what the service emitters below actually write.
 *
 * MAJOR-3: shipping `required: true` for a blueprint whose `buildCommand` is
 * `echo "TODO: ..."` told the user "commit this and click deploy" for a file we
 * knew was incomplete; the deploy then succeeded and served an empty site
 * because `echo` exits 0. A silent wrong result is worse than a visible one.
 */
export function renderBlueprintHasPlaceholders(detection: StackDetection): boolean {
  const isStatic = detection.appShape === 'static' || detection.runtime === 'static';

  if (isStatic) {
    // emitStaticService: buildCommand and staticPublishPath both fall back.
    if (!detection.build.buildCommand) return true;
    if (!detection.build.outputDir) return true;
    return false;
  }

  // A background-worker or cron service always emits a TODO start command (and,
  // for cron, a placeholder schedule) — those values are unknowable from
  // detection, so any such service makes the blueprint incomplete.
  if (detection.needs.includes('background-worker')) return true;
  if (detection.needs.includes('cron')) return true;

  // emitWebService: a Docker runtime invents no build/start command, so it is
  // never a placeholder. Every other runtime needs both filled in.
  const runtime = chooseRuntime(detection);
  if (runtime.value === 'docker') return false;

  if (!(detection.build.buildCommand ?? detection.build.installCommand)) return true;
  if (!detection.build.startCommand) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Runtime mapping — StackDetection.runtime → Render `runtime` value          */
/* -------------------------------------------------------------------------- */

/**
 * Render supports these native runtimes plus the special-case `docker`/`static`.
 * A runtime we can't map to one of Render's (php/java, or `unknown`) falls back
 * to `docker` ONLY when the repo actually ships a Dockerfile; otherwise we emit
 * `node` with a TODO note, because a blueprint MUST name a runtime and guessing
 * silently would be worse than a visible placeholder.
 */
const RENDER_NATIVE_RUNTIMES: ReadonlySet<Runtime> = new Set<Runtime>([
  'node',
  'python',
  'ruby',
  'go',
  'rust',
  'elixir',
]);

interface RuntimeChoice {
  /** The value to write for `runtime:`. */
  value: string;
  /** A note appended as a comment when we had to make an assumption. */
  note: string | null;
}

function chooseRuntime(detection: StackDetection): RuntimeChoice {
  const { runtime, existing } = detection;
  if (runtime === 'docker') return { value: 'docker', note: null };
  if (runtime === 'static') return { value: 'static', note: null };
  if (RENDER_NATIVE_RUNTIMES.has(runtime)) return { value: runtime, note: null };

  // php / java / unknown: Render has no first-class native runtime we can name.
  if (existing.dockerfile) {
    return {
      value: 'docker',
      note: "We couldn't map your language to a native Render runtime, but your repo ships a Dockerfile, so Render will build the image.",
    };
  }
  return {
    value: 'node',
    note: `We couldn't confidently map your runtime (${runtime}) to a native Render runtime — set the correct one (node/python/ruby/go/rust/elixir/docker) before deploying.`,
  };
}

/* -------------------------------------------------------------------------- */
/* A tiny, deterministic YAML serializer                                      */
/* -------------------------------------------------------------------------- */

/**
 * We build the blueprint as an array of lines. Everything that could be
 * misread as a non-string scalar (a command with a colon, a path, a bare word
 * like `false`) is single-quoted, which is always safe in YAML. `# TODO:` lines
 * are plain comments and parse away to nothing — the reviewer's parser ignores
 * them, and the user sees exactly where a value is missing.
 */
class Y {
  readonly lines: string[] = [];

  raw(line: string): void {
    this.lines.push(line);
  }

  comment(indent: number, text: string): void {
    this.lines.push(`${' '.repeat(indent)}# ${text}`);
  }

  /** `key: 'value'` — value single-quoted (with internal `'` escaped as `''`). */
  kv(indent: number, key: string, value: string): void {
    this.lines.push(`${' '.repeat(indent)}${key}: ${quote(value)}`);
  }

  /** `key: value` for a bare scalar we control (booleans, enum-like values). */
  kvBare(indent: number, key: string, value: string): void {
    this.lines.push(`${' '.repeat(indent)}${key}: ${value}`);
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }
}

/** Single-quote a YAML string; `'` → `''` per the YAML spec. Always safe. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/* -------------------------------------------------------------------------- */
/* The generator                                                              */
/* -------------------------------------------------------------------------- */

export function generateRenderYaml(detection: StackDetection, ref: RepoRef): ConfigArtifact | null {
  if (!shouldEmitRenderYaml(detection)) return null;

  const isStatic = detection.appShape === 'static' || detection.runtime === 'static';
  const needsDatabase = detection.needs.includes('database');
  const needsCache = detection.needs.includes('cache');
  const needsWorker = detection.needs.includes('background-worker');
  const needsCron = detection.needs.includes('cron');

  const serviceName = sanitizeName(ref.repo);
  const y = new Y();

  y.comment(
    0,
    'render.yaml — generated by InfraGenie. Review it, then commit it to the ROOT of your repo.',
  );
  y.comment(
    0,
    'autoDeploy is set to false as Render recommends for Deploy-to-Render button repos:',
  );
  y.comment(0, 'otherwise every push to this repo redeploys every instance created from it.');

  /* ---- services --------------------------------------------------------- */
  y.raw('services:');

  if (isStatic) {
    emitStaticService(y, detection, ref, serviceName, { needsDatabase, needsCache, baseName: serviceName });
  } else {
    emitWebService(y, detection, ref, serviceName, { needsDatabase, needsCache, baseName: serviceName });
  }

  // A cache need → a Render Key Value (Redis) store. It lives in `services`,
  // NOT in `databases` (which is Postgres-only), and REQUIRES `ipAllowList`.
  // Emitted for a static site too when the need exists (e.g. a PRD-supplied
  // cache): the store must actually exist for the `fromService` reference above
  // to resolve.
  if (needsCache) {
    emitKeyValueService(y, `${serviceName}-cache`);
  }

  // A background-worker need → a `type: worker` service. We cannot know its
  // start command, so we emit a clearly-marked TODO rather than invent one.
  if (needsWorker && !isStatic) {
    emitWorkerService(y, detection, ref, `${serviceName}-worker`);
  }

  // A cron need → a `type: cron` service. Both the schedule and the command are
  // unknowable from detection, so both are TODO placeholders.
  if (needsCron && !isStatic) {
    emitCronService(y, detection, ref, `${serviceName}-cron`);
  }

  /* ---- databases (Postgres only) ---------------------------------------- */
  if (needsDatabase) {
    y.raw('');
    y.comment(0, 'Managed Postgres. Render injects its connection string into the service above');
    y.comment(0, 'via the fromDatabase reference — no secret is ever written into this file.');
    y.raw('databases:');
    y.kv(2, '- name', `${serviceName}-db`);
    // `free` is the smallest tier so the template costs nothing until the user
    // chooses to scale it; the spec's default is `basic-256mb` (a paid tier).
    y.kvBare(4, 'plan', 'free');
  }

  const content = y.toString();

  const hasPlaceholders = renderBlueprintHasPlaceholders(detection);

  const why = renderWhy(detection, { needsDatabase, needsCache, isStatic, hasPlaceholders });

  const artifact: ConfigArtifact = {
    provider: 'render',
    filename: 'render.yaml',
    language: 'yaml',
    content,
    why,
    // MAJOR-3: a blueprint with a placeholder build/start command (or a guessed
    // publish dir, or a worker/cron TODO) is NOT ready to deploy as-is. Marking
    // it `required: false` stops the UI from labelling it "Required" and telling
    // the user to commit-and-click a file we know is incomplete — `why` and the
    // Render fit's caveat both say plainly that they must fill it in first. A
    // fully-known blueprint stays `required: true` (unchanged).
    required: !hasPlaceholders,
  };

  // Self-validate against the contract so a malformed artifact never escapes.
  return configArtifactSchema.parse(artifact);
}

/* -------------------------------------------------------------------------- */
/* Service emitters                                                           */
/* -------------------------------------------------------------------------- */

function emitStaticService(
  y: Y,
  detection: StackDetection,
  ref: RepoRef,
  name: string,
  opts: { needsDatabase: boolean; needsCache: boolean; baseName: string },
): void {
  y.kv(2, '- type', 'web');
  y.kvBare(4, 'runtime', 'static');
  y.kv(4, 'name', name);
  emitRootDir(y, ref);

  const build = detection.build.buildCommand;
  if (build) {
    y.kv(4, 'buildCommand', build);
  } else {
    y.comment(4, 'TODO: set the command that builds your static output (e.g. npm run build).');
    y.kv(4, 'buildCommand', 'echo "TODO: set your build command"');
  }

  const publish = detection.build.outputDir;
  if (publish) {
    y.kv(4, 'staticPublishPath', normalizePublish(publish));
  } else {
    y.comment(4, 'TODO: set the directory that holds your built files (e.g. ./dist, ./build, ./out).');
    y.kv(4, 'staticPublishPath', './dist');
  }

  y.kvBare(4, 'autoDeploy', 'false');

  // A managed-service need (typically PRD-supplied for a static site) must be
  // wired to the site, or the `databases:`/`keyvalue` entry below dangles with
  // nothing referencing it. Static sites accept `envVars` (available to the
  // build), so we emit the same `fromDatabase`/`fromService` references — never
  // a literal value, never a secret.
  emitWebEnvVars(y, opts);
}

function emitWebService(
  y: Y,
  detection: StackDetection,
  ref: RepoRef,
  name: string,
  opts: { needsDatabase: boolean; needsCache: boolean; baseName: string },
): void {
  const runtime = chooseRuntime(detection);
  y.kv(2, '- type', 'web');
  if (runtime.note) y.comment(4, `TODO: ${runtime.note}`);
  y.kvBare(4, 'runtime', runtime.value);
  y.kv(4, 'name', name);
  emitRootDir(y, ref);

  const isDocker = runtime.value === 'docker';

  if (!isDocker) {
    const build = detection.build.buildCommand ?? detection.build.installCommand;
    if (build) {
      y.kv(4, 'buildCommand', build);
    } else {
      y.comment(4, 'TODO: set the command that installs deps and builds your app (e.g. npm ci && npm run build).');
      y.kv(4, 'buildCommand', 'echo "TODO: set your build command"');
    }

    const start = detection.build.startCommand;
    if (start) {
      y.kv(4, 'startCommand', start);
    } else {
      y.comment(4, 'TODO: set the command that starts your server (e.g. npm start, gunicorn app.wsgi).');
      y.kv(4, 'startCommand', 'echo "TODO: set your start command"');
    }
  } else {
    y.comment(4, 'Docker runtime: Render builds ./Dockerfile and runs its CMD. Set dockerCommand to override.');
  }

  y.kvBare(4, 'plan', 'free');
  y.kvBare(4, 'autoDeploy', 'false');

  emitWebEnvVars(y, opts);
}

function emitWorkerService(y: Y, detection: StackDetection, ref: RepoRef, name: string): void {
  y.raw('');
  y.comment(2, 'Background worker — a long-lived process for your queue/worker workload.');
  const runtime = chooseRuntime(detection);
  y.kv(2, '- type', 'worker');
  y.kvBare(4, 'runtime', runtime.value === 'static' ? 'node' : runtime.value);
  y.kv(4, 'name', name);
  emitRootDir(y, ref);
  if (runtime.value !== 'docker') {
    const build = detection.build.buildCommand ?? detection.build.installCommand;
    if (build) {
      y.kv(4, 'buildCommand', build);
    } else {
      y.comment(4, 'TODO: set the worker build command (often the same as your web service).');
      y.kv(4, 'buildCommand', 'echo "TODO: set your build command"');
    }
    y.comment(4, 'TODO: set the command that starts your worker (e.g. npm run worker, celery -A app worker).');
    y.kv(4, 'startCommand', 'echo "TODO: set your worker start command"');
  }
  y.kvBare(4, 'plan', 'starter');
  y.kvBare(4, 'autoDeploy', 'false');
}

function emitCronService(y: Y, detection: StackDetection, ref: RepoRef, name: string): void {
  y.raw('');
  y.comment(2, 'Cron job — runs on a schedule. Both the schedule and command are yours to set.');
  const runtime = chooseRuntime(detection);
  y.kv(2, '- type', 'cron');
  y.kvBare(4, 'runtime', runtime.value === 'static' ? 'node' : runtime.value);
  y.kv(4, 'name', name);
  emitRootDir(y, ref);
  y.comment(4, 'TODO: set a cron expression for when this should run (e.g. "0 * * * *" for hourly).');
  y.kv(4, 'schedule', '0 * * * *');
  if (runtime.value !== 'docker') {
    const build = detection.build.buildCommand ?? detection.build.installCommand;
    if (build) {
      y.kv(4, 'buildCommand', build);
    } else {
      y.comment(4, 'TODO: set the cron build command.');
      y.kv(4, 'buildCommand', 'echo "TODO: set your build command"');
    }
  }
  y.comment(4, 'TODO: set the command this cron job runs (e.g. npm run cleanup).');
  y.kv(4, 'startCommand', 'echo "TODO: set your cron command"');
  y.kvBare(4, 'autoDeploy', 'false');
}

function emitKeyValueService(y: Y, name: string): void {
  y.raw('');
  y.comment(2, 'Managed Redis / Key Value store. ipAllowList is REQUIRED by the spec;');
  y.comment(2, 'an empty list means "reachable only over Render\'s private network".');
  y.kv(2, '- type', 'keyvalue');
  y.kv(4, 'name', name);
  y.kvBare(4, 'plan', 'free');
  y.kvBare(4, 'ipAllowList', '[]');
}

/* -------------------------------------------------------------------------- */
/* env vars — sync:false or fromDatabase; NEVER a literal value               */
/* -------------------------------------------------------------------------- */

function emitWebEnvVars(
  y: Y,
  opts: { needsDatabase: boolean; needsCache: boolean; baseName: string },
): void {
  const rows: Array<() => void> = [];

  if (opts.needsDatabase) {
    const dbName = `${opts.baseName}-db`;
    rows.push(() => {
      y.comment(6, 'Wired from the managed Postgres above — Render fills this in, not you.');
      y.kv(6, '- key', 'DATABASE_URL');
      y.kvBare(8, 'fromDatabase', '');
      y.kv(10, 'name', dbName);
      y.kvBare(10, 'property', 'connectionString');
    });
  }

  if (opts.needsCache) {
    const kvName = `${opts.baseName}-cache`;
    rows.push(() => {
      y.comment(6, 'Wired from the Key Value store above — Render fills this in, not you.');
      y.kv(6, '- key', 'REDIS_URL');
      y.kvBare(8, 'fromService', '');
      y.kv(10, 'type', 'keyvalue');
      y.kv(10, 'name', kvName);
      y.kvBare(10, 'property', 'connectionString');
    });
  }

  if (rows.length === 0) return;

  y.comment(4, 'Environment variables. Managed-service URLs are referenced (no secret in this file).');
  y.comment(4, 'Add your own app secrets here as `- key: NAME` + `sync: false` so Render prompts you.');
  y.raw('    envVars:');
  for (const emit of rows) emit();
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `rootDir` — set only for a monorepo subdir. Render reads a subdir HERE (not
 *  the URL, docs §4). */
function emitRootDir(y: Y, ref: RepoRef): void {
  if (ref.subdir) {
    y.comment(4, 'Monorepo: the app lives in a subdirectory, so Render builds from there.');
    y.kv(4, 'rootDir', ref.subdir);
  }
}

/** Render's `staticPublishPath` wants a repo-relative path; keep a leading `./`
 *  when the user's dir is bare (`dist` → `./dist`) for readability, but never
 *  double it. */
function normalizePublish(dir: string): string {
  if (dir.startsWith('./') || dir.startsWith('/')) return dir;
  return `./${dir}`;
}

/** A Render service `name` must be a simple token; a repo can contain `.`. */
function sanitizeName(repo: string): string {
  const cleaned = repo
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'app';
}

/* -------------------------------------------------------------------------- */
/* `why`                                                                      */
/* -------------------------------------------------------------------------- */

function renderWhy(
  detection: StackDetection,
  opts: { needsDatabase: boolean; needsCache: boolean; isStatic: boolean; hasPlaceholders: boolean },
): string {
  // MAJOR-3: when the blueprint contains a placeholder we couldn't fill, say so
  // FIRST and plainly. The user must edit the file before it will deploy — we do
  // NOT want them to commit-and-click a blueprint whose build command is a TODO
  // (that "succeeds" and serves an empty site). This takes priority over the
  // provider-need copy below because it is a precondition for the file working
  // at all.
  if (opts.hasPlaceholders) {
    if (opts.isStatic) {
      return "We couldn't detect your build command and/or the folder that holds your built files, so this blueprint has placeholder values (marked # TODO). Fill them in before you deploy — as-is, the build does nothing and Render would publish an empty site.";
    }
    return "We couldn't detect your build and/or start command, so this blueprint has placeholder values (marked # TODO). Replace them with your real commands before you deploy — as-is, the deploy will succeed but your app won't actually build or start.";
  }
  if (opts.needsDatabase) {
    return "Render reads this blueprint from your repo; without it the Deploy-to-Render button can't know you need a managed Postgres database alongside your service.";
  }
  if (opts.needsCache) {
    return 'Render reads this blueprint from your repo; without it the button would deploy your service alone, with no managed Key Value (Redis) store wired in.';
  }
  if (detection.runtime === 'docker') {
    return 'Render reads this blueprint from your repo so the Deploy-to-Render button knows to build and run your Dockerfile as a web service.';
  }
  if (opts.isStatic) {
    return 'Render reads this blueprint from your repo so the button knows this is a static site and which directory holds the built files to publish.';
  }
  return 'Render reads this blueprint from your repo; without it the Deploy-to-Render button has no configured web service to build and run.';
}
