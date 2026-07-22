/**
 * InfraGenie — Feature 3, the PURE stack detector (task B3, docs §2–§3).
 *
 * `detectStack(snapshot)` is the credibility core of one-click deploy. Given a
 * `RepoSnapshot` (the only impure step already done, behind the `RepoSource`
 * seam) it returns a `StackDetection` in which **every claim cites a real
 * file**. The zod schema (`stackDetectionSchema`) enforces the invariant; this
 * module is written to satisfy it honestly, never to fight it.
 *
 * ## Purity
 *
 * No `Date`, no network, no randomness. Same snapshot in → identical detection
 * out (proven by `index.test.ts`'s determinism assertion). All timestamps are
 * already baked into the snapshot by the source.
 *
 * ## Confidence ladder (docs §2)
 *
 *   high    — ≥1 strong signal, no contradiction.
 *   medium  — only weak signals, OR two strong signals that disagree (recorded).
 *   low     — a runtime but no nameable framework.
 *   unknown — non-GitHub ref (contents unreadable in v1), or no probe files at
 *             all. Framework MUST be `unknown`, needs MUST be `[]`, and a note
 *             must say exactly what we could not read.
 */

import {
  stackDetectionSchema,
  type BuildHints,
  type DetectionSignal,
  type RepoSnapshot,
  type StackDetection,
} from '@/types/deploy';

import {
  deriveBuildHints,
  detectExisting,
  detectFramework,
  detectMonorepo,
  detectNodeVersion,
  detectPackageManager,
  parsePackageJson,
  type Probe,
} from './rules';
import { detectNeeds } from './needs';

/* -------------------------------------------------------------------------- */
/* Building the Probe view over a snapshot                                    */
/* -------------------------------------------------------------------------- */

/**
 * A file/dir is "present" when the tree listed it. `snapshot.files` only holds
 * the CONTENTS of probe files we actually read, so presence is decided by the
 * entries listing plus (redundantly) any file we have content for.
 */
function buildProbe(snapshot: RepoSnapshot): Probe {
  const entryPaths = new Set<string>();
  for (const e of snapshot.entries) entryPaths.add(e.path);
  const fileKeys = Object.keys(snapshot.files);
  for (const k of fileKeys) entryPaths.add(k);

  const pkgRaw = snapshot.files['package.json'];
  const pkg = pkgRaw !== undefined ? parsePackageJson(pkgRaw) : null;

  return {
    pkg,
    present: (path: string) => entryPaths.has(path),
    content: (path: string) => snapshot.files[path],
  };
}

/* -------------------------------------------------------------------------- */
/* The detector                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The note shown when a non-GitHub host is analysed. Exported so the plan
 * builder (`src/lib/deploy/plan.ts`), which skips the network fetch entirely for
 * non-GitHub hosts, produces the exact same honest wording without a snapshot.
 */
export const UNREADABLE_HOST_NOTE = (host: string) =>
  `We can read repository contents for GitHub only in v1; ${host} contents were not read, so this analysis is based on the URL alone. All three providers are offered with guidance.`;

/**
 * The `unknown`-confidence result: no framework, no needs, an explicit note.
 * Exported so the plan builder can construct the same schema-valid detection for
 * a non-GitHub host without fabricating a snapshot to feed `detectStack`.
 */
export function unknownDetection(notes: string[]): StackDetection {
  const detection: StackDetection = {
    framework: 'unknown',
    frameworkVersion: null,
    runtime: 'unknown',
    appShape: 'unknown',
    packageManager: 'unknown',
    needs: [],
    build: {
      installCommand: null,
      buildCommand: null,
      outputDir: null,
      startCommand: null,
      nodeVersion: null,
    },
    existing: { vercel: false, netlify: false, render: false, dockerfile: false },
    monorepo: false,
    signals: [],
    confidence: 'unknown',
    notes,
  };
  return stackDetectionSchema.parse(detection);
}

export function detectStack(snapshot: RepoSnapshot): StackDetection {
  // --- unknown #1: a host whose contents we cannot read in v1 ---
  if (snapshot.ref.host !== 'github') {
    return unknownDetection([UNREADABLE_HOST_NOTE(snapshot.ref.host)]);
  }

  const probe = buildProbe(snapshot);
  const hasAnyProbeFile = Object.keys(snapshot.files).length > 0;
  const hasAnyEntry = snapshot.entries.length > 0;

  // --- unknown #2: nothing to look at at all ---
  if (!hasAnyProbeFile && !hasAnyEntry) {
    return unknownDetection([
      'The repository listing was empty and no probe files could be read, so the stack could not be determined. All three providers are offered with guidance.',
    ]);
  }

  const notes: string[] = [];
  const allSignals: DetectionSignal[] = [];

  // --- package manager, monorepo, existing configs, node version ---
  const pmVerdict = detectPackageManager(probe);
  if (pmVerdict.signal) allSignals.push(pmVerdict.signal);
  if (pmVerdict.packageManager === 'npm' && pmVerdict.signal?.weight === 'weak') {
    notes.push('No lockfile found; assuming npm. Commit a lockfile for a reproducible install.');
  }

  const monoVerdict = detectMonorepo(probe);
  if (monoVerdict.signal) allSignals.push(monoVerdict.signal);
  if (monoVerdict.monorepo) {
    notes.push(
      'This looks like a monorepo/workspace root. Point the deploy at the specific app directory (subdirectory), not the repo root.',
    );
  }

  const existingVerdict = detectExisting(probe);
  for (const s of existingVerdict.signals) allSignals.push(s);
  const existingProviders = (['vercel', 'netlify', 'render'] as const).filter(
    (p) => existingVerdict.existing[p],
  );
  if (existingProviders.length > 0) {
    notes.push(
      `The repo already contains provider config for: ${existingProviders.join(', ')}. We will not tell you to add ${existingProviders.length > 1 ? 'those files' : 'that file'} again.`,
    );
  }

  const nodeVerdict = detectNodeVersion(probe);
  if (nodeVerdict.signal) allSignals.push(nodeVerdict.signal);

  // --- the framework ---
  const fw = detectFramework(probe);

  // --- needs (cited; only asserted when we can read the repo) ---
  const needsVerdict = detectNeeds(probe);

  if (!fw) {
    // A runtime hint but no nameable framework → `low` with `other`/`unknown`.
    // If we saw a package.json (JS project) but recognised nothing, that's a
    // JS app we can't name: framework `other`, runtime node, shape unknown.
    if (probe.pkg) {
      for (const s of needsVerdict.signals) allSignals.push(s);
      for (const n of needsVerdict.notes) notes.push(n);
      const buildHints = deriveBuildHints(probe, pmVerdict.packageManager, null, nodeVerdict.nodeVersion);
      notes.push(
        'Found a package.json but no framework we recognise. Detection is low-confidence; verify the build and start commands before deploying.',
      );
      const detection: StackDetection = {
        framework: 'other',
        frameworkVersion: null,
        runtime: 'node',
        appShape: 'unknown',
        packageManager: pmVerdict.packageManager,
        needs: needsVerdict.needs,
        build: buildHints as BuildHints,
        existing: existingVerdict.existing,
        monorepo: monoVerdict.monorepo,
        signals: dedupeSignals([
          filePresentPkg(),
          ...allSignals,
        ]),
        confidence: 'low',
        notes: capNotes(notes),
      };
      return stackDetectionSchema.parse(detection);
    }
    // No package.json and nothing recognised: we truly saw nothing nameable.
    // Emit `other`/`unknown` runtime at low confidence if we have ANY entry,
    // otherwise unknown. Since hasAnyEntry is true here, be honest: unknown.
    return unknownDetection([
      'The repository was readable but contained no file we recognise as a stack signal. All three providers are offered with guidance.',
    ]);
  }

  // We have a framework. Assemble.
  for (const s of fw.signals) allSignals.push(s);
  for (const s of needsVerdict.signals) allSignals.push(s);
  for (const n of fw.notes) notes.push(n);
  for (const n of needsVerdict.notes) notes.push(n);

  // Harden appShape: when torn between ssr and fullstack, or a server framework
  // has persistence needs, prefer fullstack + caveat (docs: a wrong `static`
  // sends the user to Vercel for an app that needs a server).
  let appShape = fw.appShape;
  if (
    (appShape === 'ssr' || appShape === 'api-only') &&
    needsVerdict.needs.some((n) => n === 'database' || n === 'queue' || n === 'background-worker')
  ) {
    if (appShape !== 'api-only') {
      notes.push(
        'A datastore/queue dependency was detected, so this is treated as full-stack (a long-lived server + persistence) rather than purely serverless.',
      );
      appShape = 'fullstack';
    }
  }

  // Build hints from the real scripts + the framework's conventional output dir.
  const buildHints = deriveBuildHints(
    probe,
    pmVerdict.packageManager,
    fw.conventionalOutputDir,
    nodeVerdict.nodeVersion,
  );

  // Truncation caveat.
  if (snapshot.entriesTruncated) {
    notes.push(
      'The repository tree was too large to list fully, so some signals may be missing. Detection is based on the portion we could read.',
    );
  }

  // Confidence: high iff ≥1 strong signal supporting THE FRAMEWORK and no
  // contradiction. A framework verdict always carries at least one strong
  // signal (its config file or its own dependency) EXCEPT the weak-only `vite`
  // fallback, which lands at medium.
  const frameworkStrong = fw.signals.some((s) => s.weight === 'strong');
  const confidence: StackDetection['confidence'] = frameworkStrong ? 'high' : 'medium';
  if (!frameworkStrong) {
    notes.push(
      `Framework "${fw.framework}" was inferred from weak signals only; verify before deploying.`,
    );
  }

  const detection: StackDetection = {
    framework: fw.framework,
    frameworkVersion: fw.frameworkVersion,
    runtime: fw.runtime,
    appShape,
    packageManager: pmVerdict.packageManager,
    needs: needsVerdict.needs,
    build: buildHints as BuildHints,
    existing: existingVerdict.existing,
    monorepo: monoVerdict.monorepo,
    signals: dedupeSignals(allSignals),
    confidence,
    notes: capNotes(notes),
  };

  return stackDetectionSchema.parse(detection);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A `file-present` citation for package.json, for the `other`-JS branch. */
function filePresentPkg(): DetectionSignal {
  return {
    id: 'file:package-json',
    kind: 'file-present',
    path: 'package.json',
    excerpt: 'package.json',
    implies: 'package.json present → a JavaScript/TypeScript project',
    weight: 'weak',
  };
}

/** De-dupe by signal id, preserving first occurrence, capped at the schema max. */
function dedupeSignals(signals: DetectionSignal[]): DetectionSignal[] {
  const seen = new Set<string>();
  const out: DetectionSignal[] = [];
  for (const s of signals) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
    if (out.length >= 60) break;
  }
  return out;
}

/** Cap notes at the schema's 10-entry / 300-char limits. */
function capNotes(notes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of notes) {
    const trimmed = n.length > 300 ? n.slice(0, 300) : n;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 10) break;
  }
  return out;
}
