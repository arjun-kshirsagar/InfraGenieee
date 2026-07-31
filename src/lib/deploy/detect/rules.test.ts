/**
 * Unit tests for the pure detection helpers in `rules.ts` (task B3).
 *
 * These target the logic-dense pieces the fixture matrix doesn't isolate:
 * verbatim excerpt slicing, tolerant package.json parsing, lockfile → package
 * manager, monorepo signals, node-version extraction, and build-hint
 * derivation. Every excerpt asserted here is checked to be a real substring of
 * the source text — the same anti-fabrication posture as the integration gate.
 */

import { describe, expect, it } from 'vitest';

import {
  citedSignal,
  depExcerpt,
  deriveBuildHints,
  detectMonorepo,
  detectNodeVersion,
  detectPackageManager,
  filePresent,
  parsePackageJson,
  type Probe,
} from '@/lib/deploy/detect/rules';

/** Build a minimal Probe over a flat file map + present-path set. */
function probeOf(files: Record<string, string>, extraPresent: string[] = []): Probe {
  const present = new Set([...Object.keys(files), ...extraPresent]);
  const pkgRaw = files['package.json'];
  return {
    pkg: pkgRaw !== undefined ? parsePackageJson(pkgRaw) : null,
    present: (p) => present.has(p),
    content: (p) => files[p],
  };
}

/* -------------------------------------------------------------------------- */

describe('parsePackageJson', () => {
  it('merges deps + devDeps + peer + optional, first-wins', () => {
    const pkg = parsePackageJson(
      JSON.stringify({
        dependencies: { next: '^15.0.0' },
        devDependencies: { vite: '^5.0.0', next: '^99' },
      }),
    );
    expect(pkg.deps.next).toBe('^15.0.0'); // dependencies win over devDependencies
    expect(pkg.deps.vite).toBe('^5.0.0');
  });

  it('never throws on truncated / invalid JSON', () => {
    const pkg = parsePackageJson('{ "dependencies": { "next": "^15');
    expect(pkg.deps).toEqual({});
    expect(pkg.scripts).toEqual({});
    expect(pkg.raw).toContain('next');
  });

  it('extracts engines.node, scripts, workspaces', () => {
    const pkg = parsePackageJson(
      JSON.stringify({
        engines: { node: '>=20' },
        scripts: { build: 'tsc' },
        workspaces: ['packages/*'],
      }),
    );
    expect(pkg.enginesNode).toBe('>=20');
    expect(pkg.scripts.build).toBe('tsc');
    expect(pkg.hasWorkspaces).toBe(true);
  });
});

describe('depExcerpt — verbatim slicing', () => {
  it('returns the pretty-printed pair when present verbatim', () => {
    const raw = JSON.stringify({ dependencies: { next: '^15.2.0' } }, null, 2);
    const pkg = parsePackageJson(raw);
    const ex = depExcerpt(pkg, 'next');
    expect(ex).not.toBeNull();
    expect(raw.includes(ex!)).toBe(true);
    expect(ex).toContain('next');
    expect(ex).toContain('15.2.0');
  });

  it('falls back to the compact pair', () => {
    const raw = '{"dependencies":{"next":"^15.2.0"}}';
    const pkg = parsePackageJson(raw);
    const ex = depExcerpt(pkg, 'next');
    expect(ex).not.toBeNull();
    expect(raw.includes(ex!)).toBe(true);
  });

  it('returns null for an absent dependency', () => {
    const pkg = parsePackageJson(JSON.stringify({ dependencies: { react: '^18' } }));
    expect(depExcerpt(pkg, 'next')).toBeNull();
  });
});

describe('citedSignal — cannot cite what is not there', () => {
  it('returns null when the needle is absent', () => {
    expect(citedSignal('file-content', 'x', 'f', 'hello world', 'nope', 'implies', 'weak')).toBeNull();
  });
  it('returns a signal whose excerpt is a real substring', () => {
    const s = citedSignal('file-content', 'x', 'Dockerfile', 'FROM node\nEXPOSE 3000', 'EXPOSE', 'serves a port', 'weak');
    expect(s).not.toBeNull();
    expect('FROM node\nEXPOSE 3000'.includes(s!.excerpt)).toBe(true);
  });
});

describe('filePresent', () => {
  it('uses the path as its own excerpt', () => {
    const s = filePresent('cfg', 'next.config.mjs', 'Next.js');
    expect(s.excerpt).toBe('next.config.mjs');
    expect(s.kind).toBe('file-present');
  });
});

describe('detectPackageManager — from lockfile presence', () => {
  it('pnpm-lock.yaml → pnpm (strong)', () => {
    const v = detectPackageManager(probeOf({}, ['pnpm-lock.yaml', 'package.json']));
    expect(v.packageManager).toBe('pnpm');
    expect(v.signal?.weight).toBe('strong');
  });
  it('yarn.lock → yarn, bun.lockb → bun, package-lock.json → npm', () => {
    expect(detectPackageManager(probeOf({}, ['yarn.lock'])).packageManager).toBe('yarn');
    expect(detectPackageManager(probeOf({}, ['bun.lockb'])).packageManager).toBe('bun');
    expect(detectPackageManager(probeOf({}, ['package-lock.json'])).packageManager).toBe('npm');
  });
  it('package.json but no lockfile → npm (weak)', () => {
    const v = detectPackageManager(probeOf({ 'package.json': '{}' }));
    expect(v.packageManager).toBe('npm');
    expect(v.signal?.weight).toBe('weak');
  });
  it('no package.json at all → none, no signal', () => {
    const v = detectPackageManager(probeOf({}));
    expect(v.packageManager).toBe('none');
    expect(v.signal).toBeNull();
  });
});

describe('detectMonorepo', () => {
  it('pnpm-workspace.yaml → monorepo', () => {
    expect(detectMonorepo(probeOf({}, ['pnpm-workspace.yaml'])).monorepo).toBe(true);
  });
  it('turbo.json / nx.json / lerna.json → monorepo', () => {
    expect(detectMonorepo(probeOf({}, ['turbo.json'])).monorepo).toBe(true);
    expect(detectMonorepo(probeOf({}, ['nx.json'])).monorepo).toBe(true);
    expect(detectMonorepo(probeOf({}, ['lerna.json'])).monorepo).toBe(true);
  });
  it('workspaces field → monorepo, excerpt is real', () => {
    const raw = JSON.stringify({ workspaces: ['packages/*'] }, null, 2);
    const v = detectMonorepo(probeOf({ 'package.json': raw }));
    expect(v.monorepo).toBe(true);
    expect(raw.includes(v.signal!.excerpt)).toBe(true);
  });
  it('plain single package → not a monorepo', () => {
    expect(detectMonorepo(probeOf({ 'package.json': '{"name":"x"}' })).monorepo).toBe(false);
  });
});

describe('detectNodeVersion', () => {
  it('engines.node from package.json', () => {
    const raw = JSON.stringify({ engines: { node: '>=20' } }, null, 2);
    const v = detectNodeVersion(probeOf({ 'package.json': raw }));
    expect(v.nodeVersion).toBe('>=20');
    expect(raw.includes(v.signal!.excerpt)).toBe(true);
  });
  it('.nvmrc', () => {
    const v = detectNodeVersion(probeOf({ '.nvmrc': '20.11.0\n' }));
    expect(v.nodeVersion).toBe('20.11.0');
  });
  it('.nvmrc with a leading v is normalized (v18.17.1 → 18.17.1)', () => {
    const v = detectNodeVersion(probeOf({ '.nvmrc': 'v18.17.1\n' }));
    expect(v.nodeVersion).toBe('18.17.1');
    // The excerpt cites what the file actually said, verbatim.
    expect(v.signal!.excerpt).toBe('v18.17.1');
  });
  it('.nvmrc alias `node` (nvm "latest") is NOT surfaced as a version (MINOR-3)', () => {
    const v = detectNodeVersion(probeOf({ '.nvmrc': 'node\n' }));
    expect(v.nodeVersion).toBeNull();
    expect(v.signal).toBeNull();
  });
  it('.nvmrc alias `lts/*` is NOT surfaced as a version (MINOR-3)', () => {
    const v = detectNodeVersion(probeOf({ '.nvmrc': 'lts/*\n' }));
    expect(v.nodeVersion).toBeNull();
  });
  it('.nvmrc alias falls through to .tool-versions when both are present (MINOR-3)', () => {
    const v = detectNodeVersion(
      probeOf({ '.nvmrc': 'lts/hydrogen\n', '.tool-versions': 'nodejs 20.11.0\n' }),
    );
    expect(v.nodeVersion).toBe('20.11.0');
  });
  it('.tool-versions nodejs line', () => {
    const v = detectNodeVersion(probeOf({ '.tool-versions': 'nodejs 20.11.0\npython 3.12\n' }));
    expect(v.nodeVersion).toBe('20.11.0');
    expect('nodejs 20.11.0\npython 3.12\n'.includes(v.signal!.excerpt)).toBe(true);
  });
  it('null when unknown', () => {
    expect(detectNodeVersion(probeOf({ 'package.json': '{}' })).nodeVersion).toBeNull();
  });
});

describe('deriveBuildHints', () => {
  it('derives build/start/install from scripts + package manager', () => {
    const pkg = probeOf({
      'package.json': JSON.stringify({ scripts: { build: 'next build', start: 'next start' } }),
    });
    const b = deriveBuildHints(pkg, 'pnpm', null, '20');
    expect(b.installCommand).toBe('pnpm install');
    expect(b.buildCommand).toBe('pnpm run build');
    expect(b.startCommand).toBe('pnpm run start');
    expect(b.nodeVersion).toBe('20');
  });
  it('null build command when there is no build script', () => {
    const b = deriveBuildHints(probeOf({ 'package.json': '{}' }), 'npm', 'dist', null);
    expect(b.buildCommand).toBeNull();
    expect(b.outputDir).toBe('dist');
  });
  it('never guesses install when the package manager is unknown', () => {
    const b = deriveBuildHints(probeOf({}), 'none', null, null);
    expect(b.installCommand).toBeNull();
  });
});
