/**
 * InfraGenie — Feature 3, the signal → framework/shape rule table (task B3).
 *
 * PURE. No `Date`, no network, no randomness. Everything here is a function of
 * the file paths and file contents already captured in a `RepoSnapshot`.
 *
 * ## The one invariant everything obeys
 *
 * A `DetectionSignal` cannot be minted without a real `path` and a **verbatim**
 * `excerpt` from that file (docs §2, `detectionSignalSchema`). So every helper
 * in here that emits a signal derives the excerpt by *slicing it out of the
 * actual file text* — never by reconstructing a plausible-looking string. If we
 * cannot find the substring in the file, we do not emit the signal. That is the
 * anti-fabrication gate, enforced again programmatically by the tests.
 *
 * The framework rows are ordered by specificity: a framework-specific config
 * file or the framework's own dependency is a `strong` signal that can decide
 * the framework alone; generic signals (a bare `vite`, a lockfile) are `weak`.
 */

import type {
  AppShape,
  DetectionSignal,
  Framework,
  PackageManager,
  Runtime,
} from '@/types/deploy';

/* -------------------------------------------------------------------------- */
/* Signal minting — the only place a signal is constructed                    */
/* -------------------------------------------------------------------------- */

/** Cap an excerpt at the schema's 300-char limit, on a char boundary. */
function clampExcerpt(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed;
}

/**
 * Build a `file-present` signal. The evidence *is* the path — the schema allows
 * the path itself as the excerpt for this kind, so a present file with no
 * readable body still cites honestly.
 */
export function filePresent(
  id: string,
  path: string,
  implies: string,
  weight: 'strong' | 'weak' = 'strong',
): DetectionSignal {
  return { id, kind: 'file-present', path, excerpt: path, implies, weight };
}

/**
 * Build a `file-content` / `dependency` / `script` signal ONLY if `needle` is a
 * genuine substring of `content`. Returns `null` otherwise, so a caller can
 * never accidentally cite a file for something the file does not contain.
 *
 * `excerpt` is the smallest window of the real file text that contains the
 * needle (the needle itself, clamped) — verbatim, never reconstructed.
 */
export function citedSignal(
  kind: 'file-content' | 'dependency' | 'script',
  id: string,
  path: string,
  content: string,
  needle: string,
  implies: string,
  weight: 'strong' | 'weak',
): DetectionSignal | null {
  const idx = content.indexOf(needle);
  if (idx === -1) return null;
  return { id, kind, path, excerpt: clampExcerpt(needle), implies, weight };
}

/* -------------------------------------------------------------------------- */
/* package.json parsing (tolerant — a truncated tail must not throw)          */
/* -------------------------------------------------------------------------- */

export interface ParsedPackageJson {
  /** The raw text, so callers can slice verbatim excerpts out of it. */
  raw: string;
  /** name → version-range string, merged deps + devDeps + peer + optional. */
  deps: Record<string, string>;
  scripts: Record<string, string>;
  /** `engines.node` verbatim, if present. */
  enginesNode: string | null;
  /** `true` when a top-level `workspaces` field exists (monorepo signal). */
  hasWorkspaces: boolean;
  /** `packageManager` field (`pnpm@8...`), if present. */
  packageManagerField: string | null;
}

/**
 * Parse package.json defensively. A probe body may be a truncated 64 KB head
 * (docs §files), so `JSON.parse` can fail — we return an empty-but-usable shape
 * rather than throwing, and detection degrades to file-presence signals.
 */
export function parsePackageJson(raw: string): ParsedPackageJson {
  const empty: ParsedPackageJson = {
    raw,
    deps: {},
    scripts: {},
    enginesNode: null,
    hasWorkspaces: false,
    packageManagerField: null,
  };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return empty;
  }
  if (obj === null || typeof obj !== 'object') return empty;

  const deps: Record<string, string> = {};
  for (const key of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const section = obj[key];
    if (section && typeof section === 'object') {
      for (const [name, version] of Object.entries(section as Record<string, unknown>)) {
        if (typeof version === 'string' && !(name in deps)) deps[name] = version;
      }
    }
  }

  const scripts: Record<string, string> = {};
  if (obj.scripts && typeof obj.scripts === 'object') {
    for (const [name, cmd] of Object.entries(obj.scripts as Record<string, unknown>)) {
      if (typeof cmd === 'string') scripts[name] = cmd;
    }
  }

  const engines = obj.engines;
  const enginesNode =
    engines && typeof engines === 'object' && typeof (engines as Record<string, unknown>).node === 'string'
      ? ((engines as Record<string, unknown>).node as string)
      : null;

  const hasWorkspaces =
    Array.isArray(obj.workspaces) ||
    (typeof obj.workspaces === 'object' && obj.workspaces !== null);

  const packageManagerField =
    typeof obj.packageManager === 'string' ? (obj.packageManager as string) : null;

  return { raw, deps, scripts, enginesNode, hasWorkspaces, packageManagerField };
}

/**
 * The verbatim `"name": "version"` substring as it actually appears in the
 * package.json text, so a `dependency` signal's excerpt is a real slice of the
 * file. Returns `null` if the dep is absent OR (rarely) the pretty-printed pair
 * isn't found verbatim (e.g. exotic whitespace), in which case the caller falls
 * back to a bare-name substring.
 */
export function depExcerpt(pkg: ParsedPackageJson, name: string): string | null {
  if (!(name in pkg.deps)) return null;
  const version = pkg.deps[name];
  // Try the exact pretty-printed pair first (npm writes `"name": "version"`).
  const pretty = `"${name}": "${version}"`;
  if (pkg.raw.includes(pretty)) return pretty;
  // Fall back to any run of chars containing name + version on the raw text.
  const compact = `"${name}":"${version}"`;
  if (pkg.raw.includes(compact)) return compact;
  // Last resort: cite just the quoted key, which is definitely in the file.
  const key = `"${name}"`;
  if (pkg.raw.includes(key)) return key;
  return null;
}

/* -------------------------------------------------------------------------- */
/* The framework rule table                                                   */
/* -------------------------------------------------------------------------- */

export type Probe = {
  /** package.json parsed once (or null when absent/unreadable). */
  pkg: ParsedPackageJson | null;
  /** analysed-root-relative file path → true when present in the tree. */
  present: (path: string) => boolean;
  /** file contents by path, when we read them. */
  content: (path: string) => string | undefined;
};

export interface FrameworkVerdict {
  framework: Framework;
  runtime: Runtime;
  /** The shape we lean to; `index.ts` may harden ssr→fullstack on server signals. */
  appShape: AppShape;
  signals: DetectionSignal[];
  frameworkVersion: string | null;
  /** Conventional output dir when the framework fixes one; else null. */
  conventionalOutputDir: string | null;
  notes: string[];
}

/** Does the repo have any config file matching one of the given names? */
function firstPresent(probe: Probe, names: readonly string[]): string | null {
  for (const n of names) if (probe.present(n)) return n;
  return null;
}

/** Emit a dependency signal for `dep` if package.json actually declares it. */
function depSignal(
  probe: Probe,
  id: string,
  dep: string,
  implies: string,
  weight: 'strong' | 'weak' = 'strong',
): DetectionSignal | null {
  if (!probe.pkg) return null;
  const excerpt = depExcerpt(probe.pkg, dep);
  if (!excerpt) return null;
  return { id, kind: 'dependency', path: 'package.json', excerpt: clampExcerpt(excerpt), implies, weight };
}

/**
 * Detect the framework from the strongest available signal. Ordered most- to
 * least-specific. Returns `null` when nothing recognised matched, so `index.ts`
 * can decide between `other` (a runtime but no framework) and `unknown`.
 */
export function detectFramework(probe: Probe): FrameworkVerdict | null {
  // ---- JS/TS: SSR / hybrid frameworks (config file OR own dependency) ----

  // Next.js
  {
    const cfg = firstPresent(probe, ['next.config.js', 'next.config.mjs', 'next.config.ts']);
    const dep = depSignal(probe, 'dep:next', 'next', '`next` dependency → Next.js');
    if (cfg || dep) {
      const signals: DetectionSignal[] = [];
      if (dep) signals.push(dep);
      if (cfg) signals.push(filePresent('cfg:next', cfg, `${cfg} → Next.js`));
      return {
        framework: 'nextjs',
        runtime: 'node',
        appShape: 'ssr',
        signals,
        frameworkVersion: probe.pkg?.deps['next'] ?? null,
        conventionalOutputDir: null, // .next is managed by the platform for SSR
        notes: [],
      };
    }
  }

  // Nuxt
  {
    const cfg = firstPresent(probe, ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']);
    const dep =
      depSignal(probe, 'dep:nuxt', 'nuxt', '`nuxt` dependency → Nuxt') ??
      depSignal(probe, 'dep:nuxt3', 'nuxt3', '`nuxt3` dependency → Nuxt');
    if (cfg || dep) {
      const signals: DetectionSignal[] = [];
      if (dep) signals.push(dep);
      if (cfg) signals.push(filePresent('cfg:nuxt', cfg, `${cfg} → Nuxt`));
      return {
        framework: 'nuxt',
        runtime: 'node',
        appShape: 'ssr',
        signals,
        frameworkVersion: probe.pkg?.deps['nuxt'] ?? probe.pkg?.deps['nuxt3'] ?? null,
        conventionalOutputDir: null,
        notes: [],
      };
    }
  }

  // Remix (own dep, or react-router with a server entry)
  {
    const dep =
      depSignal(probe, 'dep:remix', '@remix-run/react', '`@remix-run/*` dependency → Remix') ??
      depSignal(probe, 'dep:remix-node', '@remix-run/node', '`@remix-run/node` → Remix (Node)') ??
      depSignal(probe, 'dep:remix-serve', '@remix-run/serve', '`@remix-run/serve` → Remix');
    const cfg = firstPresent(probe, ['remix.config.js', 'remix.config.mjs']);
    if (dep || cfg) {
      const signals: DetectionSignal[] = [];
      if (dep) signals.push(dep);
      if (cfg) signals.push(filePresent('cfg:remix', cfg, `${cfg} → Remix`));
      return {
        framework: 'remix',
        runtime: 'node',
        appShape: 'ssr',
        signals,
        frameworkVersion: probe.pkg?.deps['@remix-run/react'] ?? null,
        conventionalOutputDir: null,
        notes: [],
      };
    }
  }

  // SvelteKit
  {
    const cfg = firstPresent(probe, ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts']);
    const dep = depSignal(probe, 'dep:sveltekit', '@sveltejs/kit', '`@sveltejs/kit` → SvelteKit');
    // A bare svelte.config.js can also be a plain Svelte SPA, so require the kit
    // dep OR treat the config as strong only if @sveltejs/kit is present.
    if (dep) {
      const signals: DetectionSignal[] = [dep];
      if (cfg) signals.push(filePresent('cfg:svelte', cfg, `${cfg} → SvelteKit`));
      return {
        framework: 'sveltekit',
        runtime: 'node',
        appShape: 'ssr',
        signals,
        frameworkVersion: probe.pkg?.deps['@sveltejs/kit'] ?? null,
        conventionalOutputDir: null,
        notes: [],
      };
    }
  }

  // Astro — static UNLESS an SSR adapter dependency is present.
  {
    const cfg = firstPresent(probe, ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']);
    const dep = depSignal(probe, 'dep:astro', 'astro', '`astro` dependency → Astro');
    if (cfg || dep) {
      const signals: DetectionSignal[] = [];
      if (dep) signals.push(dep);
      if (cfg) signals.push(filePresent('cfg:astro', cfg, `${cfg} → Astro`));
      const adapters: Array<[string, string]> = [
        ['@astrojs/node', 'dep:astro-node'],
        ['@astrojs/vercel', 'dep:astro-vercel'],
        ['@astrojs/netlify', 'dep:astro-netlify'],
        ['@astrojs/cloudflare', 'dep:astro-cf'],
      ];
      let ssr = false;
      for (const [adapterDep, id] of adapters) {
        const s = depSignal(probe, id, adapterDep, `${adapterDep} → Astro SSR adapter`);
        if (s) {
          signals.push(s);
          ssr = true;
        }
      }
      return {
        framework: 'astro',
        runtime: 'node',
        appShape: ssr ? 'ssr' : 'static',
        signals,
        frameworkVersion: probe.pkg?.deps['astro'] ?? null,
        conventionalOutputDir: ssr ? null : 'dist',
        notes: [],
      };
    }
  }

  // Angular — static unless @angular/ssr present.
  {
    const cfg = firstPresent(probe, ['angular.json']);
    const dep = depSignal(probe, 'dep:angular', '@angular/core', '`@angular/core` → Angular');
    if (cfg || dep) {
      const signals: DetectionSignal[] = [];
      if (dep) signals.push(dep);
      if (cfg) signals.push(filePresent('cfg:angular', cfg, `${cfg} → Angular`));
      const ssrSignal = depSignal(probe, 'dep:angular-ssr', '@angular/ssr', '`@angular/ssr` → Angular SSR');
      if (ssrSignal) signals.push(ssrSignal);
      return {
        framework: 'angular',
        runtime: ssrSignal ? 'node' : 'static',
        appShape: ssrSignal ? 'ssr' : 'static',
        signals,
        frameworkVersion: probe.pkg?.deps['@angular/core'] ?? null,
        conventionalOutputDir: ssrSignal ? null : 'dist',
        notes: [],
      };
    }
  }

  // Gatsby
  {
    const dep = depSignal(probe, 'dep:gatsby', 'gatsby', '`gatsby` dependency → Gatsby');
    const cfg = firstPresent(probe, ['gatsby-config.js', 'gatsby-config.ts']);
    if (dep || cfg) {
      const signals: DetectionSignal[] = [];
      if (dep) signals.push(dep);
      if (cfg) signals.push(filePresent('cfg:gatsby', cfg, `${cfg} → Gatsby`));
      return {
        framework: 'gatsby',
        runtime: 'static',
        appShape: 'static',
        signals,
        frameworkVersion: probe.pkg?.deps['gatsby'] ?? null,
        conventionalOutputDir: 'public',
        notes: [],
      };
    }
  }

  // Docusaurus
  {
    const dep = depSignal(probe, 'dep:docusaurus', '@docusaurus/core', '`@docusaurus/core` → Docusaurus');
    if (dep) {
      return {
        framework: 'docusaurus',
        runtime: 'static',
        appShape: 'static',
        signals: [dep],
        frameworkVersion: probe.pkg?.deps['@docusaurus/core'] ?? null,
        conventionalOutputDir: 'build',
        notes: [],
      };
    }
  }

  // Eleventy
  {
    const dep = depSignal(probe, 'dep:eleventy', '@11ty/eleventy', '`@11ty/eleventy` → Eleventy');
    if (dep) {
      return {
        framework: 'eleventy',
        runtime: 'static',
        appShape: 'static',
        signals: [dep],
        frameworkVersion: probe.pkg?.deps['@11ty/eleventy'] ?? null,
        conventionalOutputDir: '_site',
        notes: [],
      };
    }
  }

  // create-react-app
  {
    const dep = depSignal(probe, 'dep:cra', 'react-scripts', '`react-scripts` → create-react-app');
    if (dep) {
      return {
        framework: 'create-react-app',
        runtime: 'static',
        appShape: 'static',
        signals: [dep],
        frameworkVersion: probe.pkg?.deps['react-scripts'] ?? null,
        conventionalOutputDir: 'build',
        notes: [],
      };
    }
  }

  // ---- JS/TS servers (Express/Fastify/Nest/Hono) with a start script ----
  {
    const servers: Array<[Framework, string, string]> = [
      ['nestjs', '@nestjs/core', '`@nestjs/core` → NestJS server'],
      ['express', 'express', '`express` → Express server'],
      ['fastify', 'fastify', '`fastify` → Fastify server'],
      ['hono', 'hono', '`hono` → Hono server'],
    ];
    for (const [framework, dep, implies] of servers) {
      const s = depSignal(probe, `dep:${framework}`, dep, implies);
      if (s) {
        const signals: DetectionSignal[] = [s];
        // A start script confirms a long-lived server → fullstack; otherwise
        // it may be a library import, so lean api-only but weaker.
        const start = probe.pkg?.scripts['start'];
        let appShape: AppShape = 'api-only';
        if (start && probe.pkg) {
          const startExcerpt = depExcerptForScript(probe.pkg, 'start');
          if (startExcerpt) {
            signals.push({
              id: 'script:start',
              kind: 'script',
              path: 'package.json',
              excerpt: clampExcerpt(startExcerpt),
              implies: '`start` script → long-lived server → fullstack',
              weight: 'strong',
            });
            appShape = 'fullstack';
          }
        }
        return {
          framework,
          runtime: 'node',
          appShape,
          signals,
          frameworkVersion: probe.pkg?.deps[dep] ?? null,
          conventionalOutputDir: null,
          notes: [],
        };
      }
    }
  }

  // ---- Vite SPA (only when no SSR framework matched above) ----
  {
    const cfg = firstPresent(probe, ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']);
    const dep = depSignal(probe, 'dep:vite', 'vite', '`vite` (no SSR framework) → Vite SPA', 'weak');
    if (cfg || dep) {
      const signals: DetectionSignal[] = [];
      if (cfg) signals.push(filePresent('cfg:vite', cfg, `${cfg} → Vite`));
      if (dep) signals.push(dep);
      return {
        framework: 'vite',
        runtime: 'static',
        appShape: 'static',
        signals,
        frameworkVersion: probe.pkg?.deps['vite'] ?? null,
        conventionalOutputDir: 'dist',
        notes: [],
      };
    }
  }

  // ---- Python ----
  {
    // Django
    const managePresent = probe.present('manage.py');
    const reqs = probe.content('requirements.txt');
    const pyproject = probe.content('pyproject.toml');
    const pipfile = probe.content('Pipfile');
    const pyText = [reqs, pyproject, pipfile].filter(Boolean).join('\n');

    const djangoCited =
      (reqs && citedSignal('dependency', 'py:django', 'requirements.txt', reqs, 'Django', 'Django in requirements → Django', 'strong')) ||
      (reqs && citedSignal('dependency', 'py:django', 'requirements.txt', reqs, 'django', 'django in requirements → Django', 'strong')) ||
      (pyproject && citedSignal('dependency', 'py:django', 'pyproject.toml', pyproject, 'django', 'django in pyproject → Django', 'strong'));
    if (managePresent || djangoCited) {
      const signals: DetectionSignal[] = [];
      if (managePresent) signals.push(filePresent('py:manage', 'manage.py', 'manage.py → Django'));
      if (djangoCited) signals.push(djangoCited);
      return {
        framework: 'django',
        runtime: 'python',
        appShape: 'fullstack',
        signals,
        frameworkVersion: null,
        conventionalOutputDir: null,
        notes: [],
      };
    }

    // FastAPI / Flask
    const fastapiCited =
      (reqs && citedSignal('dependency', 'py:fastapi', 'requirements.txt', reqs, 'fastapi', 'fastapi in requirements → FastAPI', 'strong')) ||
      (pyproject && citedSignal('dependency', 'py:fastapi', 'pyproject.toml', pyproject, 'fastapi', 'fastapi in pyproject → FastAPI', 'strong'));
    if (fastapiCited) {
      return {
        framework: 'fastapi',
        runtime: 'python',
        appShape: 'api-only',
        signals: [fastapiCited],
        frameworkVersion: null,
        conventionalOutputDir: null,
        notes: [],
      };
    }
    const flaskCited =
      (reqs && citedSignal('dependency', 'py:flask', 'requirements.txt', reqs, 'Flask', 'Flask in requirements → Flask', 'strong')) ||
      (reqs && citedSignal('dependency', 'py:flask', 'requirements.txt', reqs, 'flask', 'flask in requirements → Flask', 'strong')) ||
      (pyproject && citedSignal('dependency', 'py:flask', 'pyproject.toml', pyproject, 'flask', 'flask in pyproject → Flask', 'strong'));
    if (flaskCited) {
      return {
        framework: 'flask',
        runtime: 'python',
        appShape: 'fullstack',
        signals: [flaskCited],
        frameworkVersion: null,
        conventionalOutputDir: null,
        notes: [],
      };
    }
    // Some python signal but no framework named → let index.ts mark low/other.
    if (pyText.length > 0 || managePresent) {
      // fallthrough handled by index.ts via runtimeOnly()
    }
  }

  // ---- Ruby (Rails / Jekyll) ----
  {
    const gemfile = probe.content('Gemfile');
    if (gemfile) {
      const railsCited = citedSignal('dependency', 'rb:rails', 'Gemfile', gemfile, 'rails', "gem 'rails' → Rails", 'strong');
      if (railsCited) {
        return {
          framework: 'rails',
          runtime: 'ruby',
          appShape: 'fullstack',
          signals: [railsCited],
          frameworkVersion: null,
          conventionalOutputDir: null,
          notes: [],
        };
      }
      const jekyllCited = citedSignal('dependency', 'rb:jekyll', 'Gemfile', gemfile, 'jekyll', "gem 'jekyll' → Jekyll", 'strong');
      if (jekyllCited && probe.present('_config.yml')) {
        return {
          framework: 'jekyll',
          runtime: 'ruby',
          appShape: 'static',
          signals: [jekyllCited, filePresent('cfg:jekyll', '_config.yml', '_config.yml → Jekyll')],
          frameworkVersion: null,
          conventionalOutputDir: '_site',
          notes: [],
        };
      }
    }
  }

  // ---- PHP (Laravel) ----
  {
    const composer = probe.content('composer.json');
    if (composer) {
      const laravelCited = citedSignal('dependency', 'php:laravel', 'composer.json', composer, 'laravel/framework', 'laravel/framework → Laravel', 'strong');
      if (laravelCited) {
        return {
          framework: 'laravel',
          runtime: 'php',
          appShape: 'fullstack',
          signals: [laravelCited],
          frameworkVersion: null,
          conventionalOutputDir: null,
          notes: [],
        };
      }
    }
  }

  // ---- Elixir (Phoenix) ----
  {
    const mix = probe.content('mix.exs');
    if (mix) {
      const phoenixCited = citedSignal('dependency', 'ex:phoenix', 'mix.exs', mix, 'phoenix', ':phoenix → Phoenix', 'strong');
      if (phoenixCited) {
        return {
          framework: 'phoenix',
          runtime: 'elixir',
          appShape: 'fullstack',
          signals: [phoenixCited],
          frameworkVersion: null,
          conventionalOutputDir: null,
          notes: [],
        };
      }
    }
  }

  // ---- Go (Gin) ----
  {
    const gomod = probe.content('go.mod');
    if (gomod) {
      const ginCited = citedSignal('dependency', 'go:gin', 'go.mod', gomod, 'gin-gonic/gin', 'gin-gonic/gin → Gin', 'strong');
      if (ginCited) {
        return {
          framework: 'gin',
          runtime: 'go',
          appShape: 'api-only',
          signals: [ginCited],
          frameworkVersion: null,
          conventionalOutputDir: null,
          notes: [],
        };
      }
    }
  }

  // ---- Java (Spring Boot) ----
  {
    const pom = probe.content('pom.xml');
    const gradle = probe.content('build.gradle');
    const springCited =
      (pom && citedSignal('dependency', 'java:spring', 'pom.xml', pom, 'spring-boot', 'spring-boot in pom.xml → Spring Boot', 'strong')) ||
      (gradle && citedSignal('dependency', 'java:spring', 'build.gradle', gradle, 'spring-boot', 'spring-boot in build.gradle → Spring Boot', 'strong'));
    if (springCited) {
      return {
        framework: 'spring-boot',
        runtime: 'java',
        appShape: 'fullstack',
        signals: [springCited],
        frameworkVersion: null,
        conventionalOutputDir: null,
        notes: [],
      };
    }
  }

  // ---- Static site generators (non-JS): Hugo ----
  {
    const hugoCfg = firstPresent(probe, ['hugo.toml', 'config.toml']);
    if (hugoCfg && probe.present('content')) {
      return {
        framework: 'hugo',
        runtime: 'static',
        appShape: 'static',
        signals: [
          filePresent('cfg:hugo', hugoCfg, `${hugoCfg} + content/ → Hugo`),
          filePresent('dir:content', 'content', 'content/ directory → Hugo'),
        ],
        frameworkVersion: null,
        conventionalOutputDir: 'public',
        notes: [],
      };
    }
  }

  // ---- Dockerfile and nothing else recognised → other/docker ----
  {
    if (probe.present('Dockerfile')) {
      const df = probe.content('Dockerfile');
      const signals: DetectionSignal[] = [filePresent('cfg:dockerfile', 'Dockerfile', 'Dockerfile → containerised app')];
      // A Dockerfile ships its own server → fullstack; EXPOSE/CMD corroborates.
      const appShape: AppShape = 'fullstack';
      if (df) {
        const exposeSig =
          citedSignal('file-content', 'df:expose', 'Dockerfile', df, 'EXPOSE', 'EXPOSE → the container serves a port', 'weak') ??
          citedSignal('file-content', 'df:cmd', 'Dockerfile', df, 'CMD', 'CMD → container entrypoint', 'weak');
        if (exposeSig) signals.push(exposeSig);
      }
      return {
        framework: 'other',
        runtime: 'docker',
        appShape,
        signals,
        frameworkVersion: null,
        conventionalOutputDir: null,
        notes: [],
      };
    }
  }

  // ---- Bare index.html at root, no manifest → static-html ----
  {
    if (probe.present('index.html') && !probe.present('package.json')) {
      return {
        framework: 'static-html',
        runtime: 'static',
        appShape: 'static',
        signals: [filePresent('file:index-html', 'index.html', 'root index.html, no manifest → static HTML')],
        frameworkVersion: null,
        conventionalOutputDir: '.',
        notes: [],
      };
    }
  }

  return null;
}

/** Verbatim excerpt of a script entry (`"start": "node server.js"`). */
function depExcerptForScript(pkg: ParsedPackageJson, script: string): string | null {
  const cmd = pkg.scripts[script];
  if (cmd === undefined) return null;
  const pretty = `"${script}": "${cmd}"`;
  if (pkg.raw.includes(pretty)) return pretty;
  const compact = `"${script}":"${cmd}"`;
  if (pkg.raw.includes(compact)) return compact;
  const key = `"${script}"`;
  if (pkg.raw.includes(key)) return key;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Package manager (from lockfile PRESENCE)                                   */
/* -------------------------------------------------------------------------- */

export interface PackageManagerVerdict {
  packageManager: PackageManager;
  signal: DetectionSignal | null;
}

/**
 * Determine the package manager from lockfile presence. A concrete lockfile is
 * a strong signal; a bare package.json with no lockfile is `npm` as a WEAK
 * signal (npm is the default, but we didn't see the lock, so we say so).
 */
export function detectPackageManager(probe: Probe): PackageManagerVerdict {
  const locks: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, pm] of locks) {
    if (probe.present(file)) {
      return {
        packageManager: pm,
        signal: filePresent(`lock:${pm}`, file, `${file} → ${pm}`),
      };
    }
  }
  if (probe.present('package.json')) {
    return {
      packageManager: 'npm',
      signal: filePresent('lock:none', 'package.json', 'package.json, no lockfile → npm (assumed)', 'weak'),
    };
  }
  return { packageManager: 'none', signal: null };
}

/* -------------------------------------------------------------------------- */
/* Monorepo detection                                                         */
/* -------------------------------------------------------------------------- */

export interface MonorepoVerdict {
  monorepo: boolean;
  signal: DetectionSignal | null;
}

export function detectMonorepo(probe: Probe): MonorepoVerdict {
  const files: Array<[string, string]> = [
    ['pnpm-workspace.yaml', 'pnpm-workspace.yaml → monorepo workspace root'],
    ['turbo.json', 'turbo.json → Turborepo monorepo'],
    ['nx.json', 'nx.json → Nx monorepo'],
    ['lerna.json', 'lerna.json → Lerna monorepo'],
  ];
  for (const [file, implies] of files) {
    if (probe.present(file)) {
      return { monorepo: true, signal: filePresent(`mono:${file}`, file, implies) };
    }
  }
  if (probe.pkg?.hasWorkspaces) {
    const key = '"workspaces"';
    if (probe.pkg.raw.includes(key)) {
      return {
        monorepo: true,
        signal: {
          id: 'mono:workspaces',
          kind: 'file-content',
          path: 'package.json',
          excerpt: key,
          implies: '`workspaces` field → monorepo',
          weight: 'strong',
        },
      };
    }
  }
  return { monorepo: false, signal: null };
}

/* -------------------------------------------------------------------------- */
/* Existing provider configs                                                  */
/* -------------------------------------------------------------------------- */

export function detectExisting(probe: Probe): {
  existing: { vercel: boolean; netlify: boolean; render: boolean; dockerfile: boolean };
  signals: DetectionSignal[];
} {
  const signals: DetectionSignal[] = [];
  const vercel = probe.present('vercel.json');
  const netlify = probe.present('netlify.toml');
  const render = probe.present('render.yaml');
  const dockerfile = probe.present('Dockerfile');
  if (vercel) signals.push(filePresent('existing:vercel', 'vercel.json', 'vercel.json already committed', 'weak'));
  if (netlify) signals.push(filePresent('existing:netlify', 'netlify.toml', 'netlify.toml already committed', 'weak'));
  if (render) signals.push(filePresent('existing:render', 'render.yaml', 'render.yaml already committed', 'weak'));
  // Dockerfile presence is already cited by framework detection when relevant;
  // record it here only for the `existing` struct.
  return { existing: { vercel, netlify, render, dockerfile }, signals };
}

/* -------------------------------------------------------------------------- */
/* Node version                                                               */
/* -------------------------------------------------------------------------- */

export function detectNodeVersion(probe: Probe): { nodeVersion: string | null; signal: DetectionSignal | null } {
  // engines.node in package.json
  if (probe.pkg?.enginesNode) {
    const v = probe.pkg.enginesNode;
    const pretty = `"node": "${v}"`;
    if (probe.pkg.raw.includes(pretty)) {
      return {
        nodeVersion: v,
        signal: {
          id: 'node:engines',
          kind: 'file-content',
          path: 'package.json',
          excerpt: pretty,
          implies: '`engines.node` → Node version constraint',
          weight: 'weak',
        },
      };
    }
    return { nodeVersion: v, signal: null };
  }
  // .nvmrc
  const nvmrc = probe.content('.nvmrc');
  if (nvmrc !== undefined && nvmrc.trim().length > 0) {
    const raw = nvmrc.trim();
    // MINOR-3: nvm accepts non-version ALIASES in .nvmrc — `node` (latest),
    // `lts/*`, `lts/hydrogen`, `iojs`, `stable`, `system`, `default`, `unstable`.
    // Those are not version strings; passing e.g. `node` through as
    // `nodeVersion` would be an invalid value if it ever reached a provider
    // hint. Accept only something that starts with a digit (with an optional
    // leading `v`), e.g. `20`, `v18.17.1`, `18.17`. Anything else is a
    // resolvable alias we deliberately do not surface as a concrete version.
    const versionLike = /^v?\d/.test(raw);
    if (versionLike) {
      const v = raw.replace(/^v/, '');
      return {
        nodeVersion: v,
        signal: {
          id: 'node:nvmrc',
          kind: 'file-content',
          path: '.nvmrc',
          excerpt: raw.slice(0, 40),
          implies: '.nvmrc → Node version',
          weight: 'weak',
        },
      };
    }
    // A non-version alias: fall through to the other sources rather than
    // reporting the alias itself as a version.
  }
  // .tool-versions (asdf) — a line like `nodejs 20.11.0`
  const toolVersions = probe.content('.tool-versions');
  if (toolVersions) {
    const m = /nodejs\s+([^\s]+)/.exec(toolVersions);
    if (m) {
      return {
        nodeVersion: m[1],
        signal: {
          id: 'node:tool-versions',
          kind: 'file-content',
          path: '.tool-versions',
          excerpt: m[0],
          implies: '.tool-versions → Node version',
          weight: 'weak',
        },
      };
    }
  }
  return { nodeVersion: null, signal: null };
}

/* -------------------------------------------------------------------------- */
/* Build hints                                                                */
/* -------------------------------------------------------------------------- */

export interface BuildHintsResult {
  installCommand: string | null;
  buildCommand: string | null;
  outputDir: string | null;
  startCommand: string | null;
  nodeVersion: string | null;
}

/**
 * Derive build hints from the real package.json scripts and the framework's
 * conventional output dir. Everything is `null` when we cannot tell — never a
 * guess (docs §types/deploy `build`).
 */
export function deriveBuildHints(
  probe: Probe,
  packageManager: PackageManager,
  conventionalOutputDir: string | null,
  nodeVersion: string | null,
): BuildHintsResult {
  const scripts = probe.pkg?.scripts ?? {};
  const build = typeof scripts['build'] === 'string' ? scripts['build'] : null;
  const start = typeof scripts['start'] === 'string' ? scripts['start'] : null;

  // Install command follows the package manager when we know it; else null.
  const installByPm: Record<PackageManager, string | null> = {
    npm: 'npm install',
    pnpm: 'pnpm install',
    yarn: 'yarn install',
    bun: 'bun install',
    none: null,
    unknown: null,
  };

  const buildCommand = build
    ? packageManager === 'none' || packageManager === 'unknown'
      ? `${runScriptPrefix(packageManager)} build`.trim()
      : `${runScriptPrefix(packageManager)} build`
    : null;

  const startCommand = start ? `${runScriptPrefix(packageManager)} start` : null;

  return {
    installCommand: installByPm[packageManager],
    buildCommand,
    outputDir: conventionalOutputDir,
    startCommand,
    nodeVersion,
  };
}

function runScriptPrefix(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm run';
    case 'yarn':
      return 'yarn';
    case 'bun':
      return 'bun run';
    case 'npm':
    default:
      return 'npm run';
  }
}

/* -------------------------------------------------------------------------- */
/* Service needs                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The full, cited service-need inference lives in `./needs.ts` (task B4).
 * It is re-exported here so existing importers of `detectNeeds` from `rules`
 * keep working, but the source of truth is `needs.ts`.
 */
export { detectNeeds } from './needs';
export type { NeedsVerdict } from './needs';
