/**
 * InfraGenie — Feature 3, the PURE `vercel.json` / `netlify.toml` hint
 * generators (task B6, docs §7).
 *
 * Both Vercel and Netlify AUTO-DETECT the common frameworks, so for a vanilla
 * Next.js / Vite / Astro repo the right answer is **no config file at all**.
 * Emitting noise config teaches the user to distrust our output, so these
 * functions return `null` unless detection found something the provider will
 * NOT infer on its own:
 *
 *   - a monorepo base directory (`ref.subdir`) — the provider builds from the
 *     repo root by default and won't find the app,
 *   - a non-standard build command (one the framework preset wouldn't run),
 *   - an output/publish directory that isn't the framework's default.
 *
 * When something is emitted it is marked `required: false` and its `why` names
 * the exact problem it solves.
 *
 * ## Correctness
 *
 * `vercel.json` is JSON; `netlify.toml` is TOML. The reviewer parses both with a
 * real parser, so we build a plain object and `JSON.stringify` it for Vercel,
 * and hand-build minimal, correctly-quoted TOML for Netlify. Both are validated
 * against `configArtifactSchema` before return.
 *
 * ## Purity
 *
 * No `Date`, no network, no randomness. Same `(detection, ref)` in → identical
 * output out.
 *
 * Sources (verified 2026-07-28):
 *   - Vercel project config: https://vercel.com/docs/project-configuration
 *     (`buildCommand`, `outputDirectory` are repo-root-relative; a monorepo uses
 *     the dashboard "Root Directory" — `vercel.json` alone can't relocate the
 *     base, so for a subdir we document that and set the build fields.)
 *   - Netlify file-based config: https://docs.netlify.com/configure-builds/file-based-configuration/
 *     (`[build] base`, `command`, `publish`; `base` is the subdir Netlify cd's
 *     into before building, `publish` is relative to `base`.)
 */

import {
  configArtifactSchema,
  type ConfigArtifact,
  type Framework,
  type StackDetection,
  type RepoRef,
} from '@/types/deploy';

/* -------------------------------------------------------------------------- */
/* What counts as "the provider would NOT infer this"                         */
/* -------------------------------------------------------------------------- */

/**
 * The frameworks whose build command AND output directory both providers detect
 * from a zero-config preset. For these we only ever emit config to solve a
 * monorepo-base problem, never to restate the preset's own defaults.
 */
const AUTO_DETECTED: ReadonlySet<Framework> = new Set<Framework>([
  'nextjs',
  'nuxt',
  'remix',
  'sveltekit',
  'astro',
  'angular',
  'vite',
  'create-react-app',
  'gatsby',
  'docusaurus',
  'eleventy',
  'vuepress',
  'hugo',
  'jekyll',
]);

interface HintReasons {
  /** The app lives in a subdirectory the provider builds from the root of. */
  monorepo: boolean;
  /** A build command the framework preset would not run on its own. */
  customBuild: boolean;
  /** An output dir that isn't the detected framework's default. */
  customOutput: boolean;
}

function reasonsToEmit(detection: StackDetection, ref: RepoRef): HintReasons {
  const monorepo = ref.subdir !== null && ref.subdir.length > 0;

  // A build command is only "custom" (worth pinning) when the framework is not
  // one both providers auto-detect. For an auto-detected framework the preset
  // already runs the right command, so restating it is noise.
  const customBuild =
    detection.build.buildCommand !== null &&
    !AUTO_DETECTED.has(detection.framework);

  // An output dir is "custom" when it's set and the framework is not auto-
  // detected (an auto-detected framework's default is already known to the
  // provider). We deliberately do NOT try to compare against a hardcoded
  // per-framework default table — that would rot; absence of auto-detection is
  // the honest trigger.
  const customOutput =
    detection.build.outputDir !== null &&
    !AUTO_DETECTED.has(detection.framework);

  return { monorepo, customBuild, customOutput };
}

function anyReason(r: HintReasons): boolean {
  return r.monorepo || r.customBuild || r.customOutput;
}

/* -------------------------------------------------------------------------- */
/* vercel.json                                                                */
/* -------------------------------------------------------------------------- */

export function generateVercelJson(detection: StackDetection, ref: RepoRef): ConfigArtifact | null {
  // Never contradict a config the user already committed.
  if (detection.existing.vercel) return null;

  const reasons = reasonsToEmit(detection, ref);
  if (!anyReason(reasons)) return null;

  // Build a plain object → JSON.stringify guarantees valid JSON. We only set the
  // fields we actually have a signal for; we never invent a build command.
  const config: Record<string, unknown> = {
    $schema: 'https://openapi.vercel.sh/vercel.json',
  };

  if (reasons.customBuild && detection.build.buildCommand) {
    config.buildCommand = detection.build.buildCommand;
  }
  if (detection.build.installCommand && !AUTO_DETECTED.has(detection.framework)) {
    config.installCommand = detection.build.installCommand;
  }
  if (reasons.customOutput && detection.build.outputDir) {
    config.outputDirectory = stripDotSlash(detection.build.outputDir);
  }

  // For a monorepo with no other custom field, `vercel.json` alone cannot move
  // the build base (that's the dashboard "Root Directory" setting), so the JSON
  // would be empty but for the schema line. Still emit it, because the `why`
  // carries the instruction the user needs — but only if we also have at least
  // one real field to write OR it's purely a monorepo case we must explain.
  const hasRealField =
    'buildCommand' in config || 'installCommand' in config || 'outputDirectory' in config;

  if (!hasRealField && !reasons.monorepo) return null;

  const content = JSON.stringify(config, null, 2) + '\n';
  const why = vercelWhy(reasons);

  return configArtifactSchema.parse({
    provider: 'vercel',
    filename: 'vercel.json',
    language: 'json',
    content,
    why,
    required: false,
  } satisfies ConfigArtifact);
}

function vercelWhy(r: HintReasons): string {
  if (r.monorepo && (r.customBuild || r.customOutput)) {
    return "Your app lives in a subdirectory and uses a non-default build; set this project's Root Directory to that subdirectory in Vercel, and this file pins the build command/output Vercel wouldn't otherwise infer.";
  }
  if (r.monorepo) {
    return 'Your app lives in a subdirectory, so set this project\'s Root Directory to that subdirectory in the Vercel dashboard; this file records the build settings alongside it. Vercel builds from the repo root by default and would not find your app.';
  }
  return "Your build command/output directory isn't one Vercel auto-detects for this framework, so this file pins them; without it the deploy would run the wrong build.";
}

/* -------------------------------------------------------------------------- */
/* netlify.toml                                                               */
/* -------------------------------------------------------------------------- */

export function generateNetlifyToml(detection: StackDetection, ref: RepoRef): ConfigArtifact | null {
  if (detection.existing.netlify) return null;

  const reasons = reasonsToEmit(detection, ref);
  if (!anyReason(reasons)) return null;

  const lines: string[] = [];
  lines.push('# netlify.toml — generated by InfraGenie. Commit to the ROOT of your repo.');
  lines.push('[build]');

  // `base` = the directory Netlify cd's into before building (the monorepo
  // subdir). Unlike Vercel, Netlify DOES express this in the config file.
  if (reasons.monorepo && ref.subdir) {
    lines.push(`  base = ${tomlString(ref.subdir)}`);
  }

  if (reasons.customBuild && detection.build.buildCommand) {
    lines.push(`  command = ${tomlString(detection.build.buildCommand)}`);
  }

  if (reasons.customOutput && detection.build.outputDir) {
    // `publish` is relative to `base` when `base` is set — Netlify's docs are
    // explicit. We emit the detected dir as-is (no `./`); the user's build wrote
    // it relative to where the build ran, which is `base`.
    lines.push(`  publish = ${tomlString(stripDotSlash(detection.build.outputDir))}`);
  }

  // If the only reason was a monorepo base, the [build] table has exactly the
  // `base` line, which is a valid and useful TOML file. If somehow no line was
  // added under [build] (shouldn't happen given anyReason), bail rather than
  // emit an empty table.
  if (lines.length <= 2) return null;

  const content = lines.join('\n') + '\n';
  const why = netlifyWhy(reasons);

  return configArtifactSchema.parse({
    provider: 'netlify',
    filename: 'netlify.toml',
    language: 'toml',
    content,
    why,
    required: false,
  } satisfies ConfigArtifact);
}

function netlifyWhy(r: HintReasons): string {
  if (r.monorepo && (r.customBuild || r.customOutput)) {
    return 'Your app lives in a subdirectory with a non-default build; this file sets the `base` directory Netlify builds from plus the command/publish dir it wouldn\'t otherwise infer.';
  }
  if (r.monorepo) {
    return 'Your app lives in a subdirectory, so this file sets the `base` directory Netlify cd\'s into before building. Netlify builds from the repo root by default and would not find your app.';
  }
  return "Your build command/publish directory isn't one Netlify auto-detects for this framework, so this file pins them; without it the deploy would publish the wrong output.";
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** TOML basic string: double-quoted, backslash and double-quote escaped. */
function tomlString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Drop a leading `./` so `./dist` → `dist`; leave everything else alone. */
function stripDotSlash(dir: string): string {
  return dir.startsWith('./') ? dir.slice(2) : dir;
}
