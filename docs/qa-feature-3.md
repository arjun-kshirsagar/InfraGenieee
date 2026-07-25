# Feature 3 (One-click deploy) — adversarial review + LIVE QA

**Reviewer:** `reviewer` agent · **Task:** `t_5db233af` · **Date:** 2026-07-29
**Reviewed:** `main` @ `e696e99` · **Detection:** `DETECTION_VERSION=1.0.0`

Scope: the whole Feature 3 stack — `parseRepoUrl`, the GitHub `RepoSource` + snapshot
cache, `detectStack`/`needs`/`rules`, `recommendProviders`, the `render.yaml` /
`vercel.json` / `netlify.toml` generators, `buildDeployPlan`,
`POST /api/deploy/analyze`, and the `/deploy` UI.

Everything below was exercised against **real public repositories over the real
anonymous GitHub API**, against the **running production build** (`next start`), and
against the **providers' own live deploy flows in Chromium**. Nothing here is read off
the source alone. I deliberately chose repos the B8 live smoke test does *not* use, so
this exercises different paths rather than re-proving the same four.

---

## Verdict

### 🛑 DO NOT SHIP — 3 Blockers, 3 Majors

The honesty machinery in this feature is the best of the three. **I attacked the citation
invariant and could not break it:** across 19 real repos and 34 emitted signals, every
single `excerpt` was a genuine verbatim substring of the real file at its `path` — zero
fabrications, zero paraphrases. The `confidence: 'unknown'` path is genuinely excellent:
no framework named, no crown, all three providers offered with guidance. Every generated
`render.yaml` **validates against Render's own official JSON Schema**. All three deploy
URLs land on the correct provider's real project-creation flow with the right repo
pre-filled. No secret, no `NEXT_PUBLIC_*`, no server module in a client bundle, and a
hostile branch/subdir cannot escape a query parameter.

But the feature ships **two wrong-answer bugs that the 1144 green tests cannot see**,
both in the one impure module the pure-function testing strategy deliberately does not
cover:

1. **The snapshot cache serves one user's analysis to a different user's request.** The
   cache key is `<host>-<owner>-<repo>-<branch>` — **`subdir` is not in the key**, and
   `get()` does not compare it. `buildDeployPlan` then trusts `snapshot.ref` over the
   ref it just parsed. I reproduced this over real HTTP: a user who pasted the **repo
   root** was served a `render.yaml`, a detection, and **deploy URLs pointing into a
   `/prisma` subdirectory they never asked for**. The cache is a module-level singleton
   on the server, so this is cross-request and cross-user, not a local oddity.

2. **A real Next.js monorepo is reported as "we couldn't read this repository".** The
   2000-entry cap truncates GitHub's tree in *raw API order*, which is not root-first.
   In `shadcn-ui/ui` the root `package.json` sits at raw index **5059**, so it is dropped
   — the prober never reads it, and `entriesTruncated` stays **`false`**, so the user gets
   no caveat explaining why. Live, `shadcn-ui/ui` and `vercel/next.js` both render the
   amber "contained no file we recognise as a stack signal" panel.

And one honesty gap: when the PRD supplies a `database` need, the Render card says
*"Render offers managed Postgres… so it can host all of it"* while the `render.yaml` we
hand the user **has no `databases:` block at all**.

| Gate | Result |
|---|---|
| `npm run build` | ✅ exit 0 — 14 routes, `/api/deploy/analyze` + `/deploy` both `ƒ` dynamic |
| `npm run lint` | ✅ 0 errors (3 pre-existing warnings, none in `deploy/`) |
| `npm test` | ✅ **1144 passed / 13 skipped** across 58 files, 29.2s, offline |
| `npx tsc --noEmit` | ✅ exit 0 |
| LIVE smoke (`test:live:deploy`) | ✅ **genuinely ran, 4/4 — not skipped** |
| Citation invariant (attacked, 34 signals / 19 repos) | ✅ **could not break it** |
| `render.yaml` vs Render's official JSON Schema | ✅ 7/7 valid |
| Deploy URLs opened in Chromium (all 3 providers) | ✅ correct provider, repo pre-filled |
| Error paths (9 cases, real HTTP) | ✅ every one a clear, correct code |
| Rate-limit path (budget genuinely exhausted) | ✅ 503 `repo_unavailable` + `Retry-After` |
| Security sweep (secrets / bundle / XSS / URL injection) | ✅ clean |
| **Snapshot-cache correctness** | ❌ **serves the wrong repo scope across requests** |
| **Large-repo detection** | ❌ **false `unknown` on real monorepos, no caveat** |
| **PRD-supplied needs → generated config** | ❌ **card promises a DB the blueprint omits** |

---

## What I actually ran

```
npm run build      → exit 0 (compiled 33.7s, tsc 20.6s)
npm run lint       → 0 errors, 3 warnings (all pre-existing, none in src/lib/deploy)
npm test           → Test Files 53 passed | 5 skipped (58)
                     Tests     1144 passed | 13 skipped (1157)   Duration 29.19s
npx tsc --noEmit   → exit 0
npm run test:live:deploy → Test Files 1 passed (1) / Tests 4 passed (4), 5.86s
```

The live smoke test really executed (not skipped) — its own console proof:

```
✅ Next.js app (vercel/next-learn)          framework=nextjs appShape=ssr runtime=node primary=vercel
✅ Static site (docker/welcome-to-docker)   framework=create-react-app appShape=static primary=netlify
✅ Full-stack + Postgres (digitalocean/…)   framework=django appShape=fullstack needs=[database] primary=render
✅ Dockerfile-only (crccheck/docker-hello…) framework=other appShape=fullstack runtime=docker primary=render
```

I independently checked two of its claims against the real repos rather than trusting them:
`digitalocean/sample-django/requirements.txt` really contains `Django==4.0.3` **and**
`psycopg2-binary==2.9.3`; `docker/welcome-to-docker/package.json` really declares
`"react-scripts": "5.0.1"`. Both expectations describe reality.

### The 19 repos I analysed live

Run through the **real** `GitHubRepoSource` + **real** `buildDeployPlan`. I then read each
repo's actual manifest/tree from GitHub myself and compared.

| Repo | Reality (verified by me) | InfraGenie said | ✓ |
|---|---|---|---|
| `vercel/ai-chatbot` | Next.js 16 + drizzle + redis + @vercel/blob, `vercel.json` committed | nextjs/fullstack/node, needs db+cache+object-storage, existing.vercel | ✅ |
| `render-examples/express-hello-world` | express ^5, `start: node app.js`, **`render.yaml` committed** | express/fullstack/node, `existing.render=true`, `requiresConfig=false`, **no render.yaml emitted** | ✅ |
| `gothinkster/node-express-realworld…` | express ~4.18, prisma, `nx.json`, Dockerfile | express/fullstack/node, needs=[database], monorepo=true | ✅ |
| `dockersamples/linux_tweet_app` | Dockerfile + index.html, **no** package.json, branch `master` | other/fullstack/docker, resolvedBranch=master | ✅ |
| `render-examples/flask-hello-world` | `requirements.txt` w/ Flask, no DB driver | flask/fullstack/python, needs=[] | ✅ |
| `jekyll/minima` | Gemfile w/ jekyll + `_config.yml`, branch `master` | jekyll/static/ruby, outputDir `_site` | ✅ |
| `withastro/docs` | astro ^7 + pnpm workspace, no SSR adapter | astro/**static**/node, monorepo=true | ✅ |
| `vitejs/vite-plugin-react` | vite ^8 dep, no lockfile at root | vite/static, confidence **medium** + "weak signals only" note | ✅ |
| `gohugoio/hugoBasicExample` | tree is **only** LICENSE + README (content lives in the theme) | unknown + "readable but no file we recognise" | ✅ correct |
| `jwasham/coding-interview-university` | 51 markdown files, no manifest | unknown + guidance | ✅ correct |
| `gitlab.com/gitlab-org/gitlab-runner` | GitLab host | unknown, primary null, 3 buttons, GitHub-only note | ✅ correct |
| `bitbucket.org/atlassian/atlassian-connect-express` | Bitbucket host | unknown, primary null, 3 buttons | ✅ correct |
| `theNewDynamic/gohugo-theme-ananke` | package.json + `netlify.toml` + `go.mod`, Hugo theme | other/node, confidence **low**, existing.netlify | ✅ honest |
| **`shadcn-ui/ui`** | **pnpm+turbo Next.js monorepo — `package.json`, `pnpm-workspace.yaml`, `turbo.json` all at root** | **unknown, "no file we recognise"** | ❌ **BLOCKER-2** |
| **`shadcn-ui/ui/tree/main/apps/v4`** | **real Next.js app: `package.json`, `next.config.mjs`, `.env.example`** | **unknown** | ❌ **BLOCKER-2** |
| **`vercel/next.js/tree/canary`** | **root `package.json`, `pnpm-workspace.yaml`** | **unknown** (read only `Cargo.toml`) | ❌ **BLOCKER-2** |
| `shadcn-ui/ui/tree/main/apps/www` | **`apps/www` does not exist** (it is `apps/v4`) | unknown, "listing was empty" | ⚠️ see MINOR-2 |
| `gitlabhq/gitlab-recipes` | config examples only, no manifest | unknown | ✅ correct |
| `github/github` (private) | private repo | see MINOR-1 (masked by rate limit at test time) | ⚠️ |

---

## The citation invariant — attacked, held

This is the feature's credibility, so I checked it programmatically rather than by eye.
For all 34 signals emitted across the readable repos I asserted, against **the real
snapshot fetched from GitHub**:

1. `signal.path` exists in `snapshot.entries` or `snapshot.files`;
2. for `kind: 'file-present'`, `excerpt === path`;
3. for every content-bearing kind, `snapshot.files[path].includes(excerpt)` — a genuine
   verbatim substring, not a paraphrase.

```
signals checked: 34
✅ every excerpt is a verbatim substring of the real file at `path`
```

Spot-check of the actual evidence for `render-examples/express-hello-world`, checked
against the file on GitHub:

| Signal | Cited excerpt | Really in the file? |
|---|---|---|
| `dep:express` | `"express": "^5.0.0"` | ✅ verbatim in `package.json` |
| `script:start` | `"start": "node app.js"` | ✅ verbatim |
| `lock:yarn` | `yarn.lock` | ✅ file exists (file-present) |
| `existing:render` | `render.yaml` | ✅ file exists |

The design deserves credit for *why* this holds: `citedSignal()` does
`content.indexOf(needle)` and returns `null` when absent, so a signal for something the
file does not contain **cannot be constructed**. `verbatimSlice()` matches
case-insensitively but slices the excerpt from the *original* text, so a
`Django`-vs-`django` mismatch still cites real bytes. That is the right shape.

**No secret leaked into any excerpt.** `apps/v4/.env.example` was in the snapshot's
entries and the `.env.example` scanner correctly cites KEY tokens only.

---

## `render.yaml` validity — against Render's own schema, not my opinion

I fetched Render's **official** Blueprint JSON Schema
(`https://render.com/schema/render.yaml.json`, the one SchemaStore serves to IDEs) and
validated every generated blueprint against it:

```
✅ astro-docs   ✅ dockerfile-only   ✅ existing-render-yaml   ✅ express-realworld
✅ jekyll-real  ✅ nextjs-ai-chatbot ✅ vite-spa               (7/7 valid)
```

Per-blueprint checks against the spec (`https://render.com/docs/blueprint-spec`):

- `autoDeploy: false` present as a **boolean** on every non-keyvalue service ✅
- `databases:` present **only** where a `database` need was genuinely detected ✅
  (absent for the Dockerfile, Flask, Jekyll, Astro and Vite cases — correct)
- static sites set the **required** `staticPublishPath` ✅
- the `keyvalue` service sets the **required** `ipAllowList` ✅
- **no env var carries a literal value** — only `fromDatabase` / `fromService`
  references ✅. Nothing from the repo's env files reached the file ✅
- `rootDir` for a monorepo: the emitter is correct (`emitRootDir` writes it whenever
  `ref.subdir` is set) but I **could not see it fire on a real repo**, because every
  monorepo-subdir case I tried hit BLOCKER-2 and produced no blueprint. See NOT VERIFIED.

The blueprint for `vercel/ai-chatbot`, exactly as the user would copy it:

```yaml
services:
  - type: 'web'
    runtime: node
    name: 'ai-chatbot'
    buildCommand: 'pnpm run build'
    startCommand: 'pnpm run start'
    plan: free
    autoDeploy: false
    envVars:
      - key: 'DATABASE_URL'
        fromDatabase:
          name: 'ai-chatbot-db'
          property: connectionString
      - key: 'REDIS_URL'
        fromService:
          type: 'keyvalue'
          name: 'ai-chatbot-cache'
          property: connectionString
  - type: 'keyvalue'
    name: 'ai-chatbot-cache'
    plan: free
    ipAllowList: []
databases:
  - name: 'ai-chatbot-db'
    plan: free
```

---

## Deploy URLs — opened for real in Chromium

Screenshots sent to the owner. **No account created, nothing signed in, nothing
deployed** (cost safety respected throughout).

| Provider | URL we generated | Where it actually landed |
|---|---|---|
| Vercel | `vercel.com/new/clone?repository-url=…express-hello-world` | Vercel's real **New Project** page: *"Cloning from GitHub — render-examples/express-hello-world"* ✅ |
| Netlify | `app.netlify.com/start/deploy?repository=…shadcn-ui/ui&branch=main&base=apps/v4` | Netlify's real **Deploy to Netlify** 3-step flow, "Connect to GitHub" wall, repo `ui` recognised ✅ |
| Render | `render.com/deploy?repo=…express-hello-world` | 302 → `dashboard.render.com/login?next=/blueprint/new%3Frepo%3D<our repo>` — **the repo is carried into the blueprint flow** ✅ |

Variants carry through correctly, matching each vendor's documented convention:

- **branch**, Vercel/Render (path-suffix): `…/next.js/tree/canary` ✅
- **branch**, Netlify (query): `repository=…/next.js&branch=canary` ✅
- **subdir**, Vercel (path-suffix): `…/ui/tree/main/apps/v4` ✅
- **subdir**, Netlify (query): `…&base=apps/v4` ✅
- **subdir**, Render: correctly **absent** from the URL (`subdirMode: 'unsupported'`) — it
  belongs in `render.yaml`'s `rootDir` ✅

In the live UI every button's DOM `href` was byte-identical to the API's `deployUrl`, with
`target="_blank" rel="noopener noreferrer"` on all three.

---

## Error paths — real HTTP against the running build

| Input | Status | Code | Verdict |
|---|---|---|---|
| `not a url at all` | 400 | `validation_error` | ✅ |
| `https://example.com/some/page` | 400 | `unsupported_host` — names GitHub/GitLab/Bitbucket | ✅ |
| `javascript:alert(1)//github.com/o/r` | 400 | `validation_error` | ✅ refused |
| `https://github.com/o/r&x=1?y=2` | 400 | `validation_error` | ✅ |
| body `this-is-not-json` | 400 | `bad_request` | ✅ |
| `{"repoUrl":""}` | 400 | `validation_error` + flattened issue | ✅ |
| rate-limited (budget genuinely 0/60) | 503 | `repo_unavailable` + **`Retry-After: 2111`** | ✅ |

**The 404 copy is right.** From `route.ts:63`, confirmed live earlier in the run:

> "We couldn't find that repository. It either doesn't exist **or is private** — InfraGenie
> reads public repositories anonymously, so a private repo looks the same as a missing one
> from here."

That names both possibilities instead of claiming knowledge it doesn't have. Good.

**Rate-limit behaviour is correct and was verified with a genuinely exhausted budget**
(I drained it to 0/60 doing this QA, which made this the real thing rather than a
simulated 403): a retryable 503 with the host's reset passed through as `Retry-After`,
rendered in the UI as *"GitHub is rate-limiting us"* with a retry — not a crash, and
**not a fabricated empty result**.

---

## Security sweep — clean

- **No credential anywhere in Feature 3.** `GitHubRepoSource` sends `Accept`,
  `X-GitHub-Api-Version` and `User-Agent` only — no `Authorization` header exists in the
  module. Confirmed by reading the source and by the fact that every live call I made was
  billed to the 60/hr **anonymous** budget.
- **No `NEXT_PUBLIC_*` anywhere in the repo** (grep: zero hits).
- **No secret in the client bundle.** Grepped `.next/static/**` for `sk-ant`,
  `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `tvly-`, `GITHUB_TOKEN` → zero. (A loose `sk-`
  regex matched only CSS `mask-radial` fragments.)
- **No server-only module reachable from the client.** `source/github.ts` and
  `source/cache.ts` (which uses `node:fs`) are imported **only** by
  `app/api/deploy/analyze/route.ts`. No component imports them.
- **No raw HTML from user input.** The single `dangerouslySetInnerHTML` in the codebase is
  in `prd/document/mermaid-diagram.tsx` (Feature 1, mermaid-rendered SVG) — nothing in
  Feature 3. Signal `path`/`excerpt` render as React text nodes in `<code>`/`<pre>`.
- **A hostile repo name cannot break out of a generated URL.** I fed
  `branch = 'main&repository-url=https://evil.example/x#"><script>alert(1)</script>'` and
  `subdir = '../../etc/passwd?x=1&y=2'` through `buildAllDeployUrls`. Every value came back
  percent-encoded inside its own parameter; host stayed `vercel.com` / `app.netlify.com` /
  `render.com`; no second `repository-url` was smuggled in; no literal `<script>` in the
  output. `URLSearchParams` is doing its job.
- `parseRepoUrl` rejects `..`/`.` path-traversal segments **before** URL normalisation,
  which is the right order (the URL parser would otherwise silently collapse them).

---

# Findings

## 🛑 BLOCKER-1 — The snapshot cache serves one user's repo scope to another user's request

**File:** `src/lib/deploy/source/cache.ts:81-86` (`filePath`), `:94-129` (`get`);
`src/lib/deploy/plan.ts:127-139`.

The cache filename is `<host>-<owner>-<repo>-<branch>.json`. **`subdir` is not part of the
key**, and `get()`'s mis-filing guard compares only `host`, `owner`, `repo` and
`resolvedBranch` — never `subdir`. So every ref that shares repo+branch shares one file.
`buildDeployPlan` then hands `snapshot.ref` (line 139) — the *cached* ref — to `assemble`,
so the plan describes the scope of whoever wrote the cache file, not what this user pasted.
`repoSnapshotCache` is a module-level singleton, so this crosses requests and users.

**Repro (real HTTP, running production build):** write a subdir-scoped snapshot under the
branch key (exactly what analysing `…/tree/master/prisma` does), then have a second user
paste the plain repo root:

```
POST /api/deploy/analyze {"repoUrl":"https://github.com/gothinkster/node-express-realworld-example-app/tree/master"}

  they pasted the ROOT, they got:  repo.subdir = 'prisma'   framework = unknown   confidence = unknown
  vercel  URL served to them: https://vercel.com/new/clone?repository-url=…%2Ftree%2Fmaster%2Fprisma
  netlify URL served to them: https://app.netlify.com/start/deploy?repository=…&base=prisma
```

**Observed:** the user is handed deploy buttons that will build **a subdirectory they
never asked for**, plus a detection for that subdirectory.
**Expected:** pasting the repo root analyses the repo root.

Also reproduced in the opposite direction with a fetch counter (stub source, real cache):

```
user1 paste .../tree/main/apps/web  → subdir=apps/web fw=nextjs
user2 paste .../tree/main           → subdir=apps/web fw=nextjs primary=vercel   ← WRONG
network fetches actually made: ["acme/mono@main/apps/web"]                       ← 0 for user2
```

**Root cause:** two things, both needed for the fix — (a) `subdir` must be in the cache key
*and* in `get()`'s guard; (b) `plan.ts` should use the **parsed** ref for the plan's
`repo`/URLs, treating the snapshot as *contents* rather than as identity (or assert the
snapshot's ref matches the parsed one and treat a mismatch as a miss).

**Why 1144 tests missed it:** `cache.test.ts` only ever exercises one ref shape per key, and
`plan.test.ts` injects a stub cache. The collision only appears when two *different* refs
of the same repo meet the same real cache — i.e. in production.

## 🛑 BLOCKER-2 — Real monorepos are reported as "we couldn't read this repository"

**File:** `src/lib/deploy/source/github.ts:506` (`if (entries.length >= 2000) break;`) and
`:365` (`entriesTruncated` comes only from GitHub's own `truncated` flag).

`scopeEntries` truncates at the schema's 2000-entry cap **in GitHub's raw tree order**,
which is not root-first. In a large repo the root manifests fall past index 2000 and are
dropped from `entries`/`existingPaths`, so `probeFiles` — which only reads what the tree
proves exists — **never reads `package.json`**. And because GitHub itself did not set
`truncated`, `entriesTruncated` stays `false`, so the "tree was too large to list fully"
caveat never fires and the user is told the repo had nothing recognisable in it.

**Real evidence (`shadcn-ui/ui`, fetched from GitHub myself):**

```
total tree entries = 6326, github truncated = False
   package.json          raw_index= 5059  → DROPPED
   pnpm-workspace.yaml   raw_index= 5928  → DROPPED
   turbo.json            raw_index= 6323  → DROPPED
   .nvmrc                raw_index=   40  → kept
```

The snapshot our source actually produced: `entries=2000, entriesTruncated=false,
files=['.nvmrc']` — 21 of 33 root entries present, every manifest missing.

**Live UI result** (screenshot sent): `shadcn-ui/ui` →
*"We couldn't read this repository's contents… The repository was readable but contained
no file we recognise as a stack signal."* Also hits `vercel/next.js/tree/canary` (read only
`Cargo.toml`) and `shadcn-ui/ui/tree/main/apps/v4` (a real Next.js app).

**Isolated repro** (`scopeEntries` directly, 2500 nested blobs then a root `package.json`):

```
tree given: 2503 entries (root manifests at index 2500-2502)
entries kept: 2000
package.json present in existingPaths?  false
→ the prober will therefore NEVER read package.json for this repo.
```

**Root cause:** the cap is applied in arrival order rather than by relevance. Two
independent fixes are needed: (a) prioritise the entries that matter — always retain
root-level entries and anything in `PROBE_FILES` before applying the cap (e.g. partition,
or collect `existingPaths` over the *full* tree and only cap the `entries` array); (b) set
`entriesTruncated = true` whenever **we** truncate, not just when GitHub does, so the
existing caveat fires.

This is the exact class of bug the brief warns about: the repo is perfectly readable, and
we tell the user we couldn't read it.

## 🛑 BLOCKER-3 — The Render card promises a managed database the generated blueprint omits

**File:** `src/lib/deploy/plan.ts:155-161`.

`recommendProviders` computes `effectiveNeeds` (repo needs **+** PRD-supplied needs) and
reasons from it, but `generateConfigs(detection, ref)` on line 161 receives the **raw**
`detection`, whose `needs` do not include the PRD-supplied ones. The two outputs in the
same plan therefore disagree.

**Repro (real HTTP):** `jekyll/minima` + a PRD carrying a `datastore` component:

```
usedPrdContext: true
render reason : "This app needs database (from your PRD, not the repo); Render offers
                 managed Postgres and Redis alongside the service, so it can host all of it."
render.yaml has a databases: block?  False
render fit requiresConfig: True     ← so the user IS told to commit this file
```

**Observed:** the user is told Render will host their database, told to commit our
blueprint, and the blueprint contains no database. Following our own instructions produces
a deploy with no DB.
**Expected:** either the blueprint includes the `databases:` entry (and the
`DATABASE_URL` `fromDatabase` wiring), or the reason must not promise it.

**Root cause:** `assemble` must pass the same effective-needs detection to
`generateConfigs` that `recommendProviders` reasoned from — `recommendProviders` already
does exactly this internally for the config gate (`index.ts:601-604`), so the fix is to
surface `effectiveNeeds` from `RecommendResult` and feed it to the generator.

## ⚠️ MAJOR-1 — A branchless paste poisons a later branch-pinned paste (same key bug, different symptom)

**File:** `src/lib/deploy/source/cache.ts:82` + `plan.ts:139`.

Analysing `github.com/acme/app` (no branch) resolves to `main` and writes
`…-app-main.json` whose `ref.branch` is `null`. A later paste of
`github.com/acme/app/tree/main` hits that file, and because the plan uses `snapshot.ref`,
the explicitly-pinned branch is **silently dropped**:

```
pinned paste .../tree/main → plan.repo.branch = null
vercel URL: https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Facme%2Fapp
                                                                  ↑ no /tree/main
```

**Observed:** the branch the user explicitly asked for vanishes from all three deploy URLs
(silently correct today only because it happened to equal the default branch — pin a
non-default branch and the button deploys the wrong code).
**Expected:** `plan.repo.branch === 'main'` and the URL carries `/tree/main`.
Fixed by the same change as BLOCKER-1.

## ⚠️ MAJOR-2 — The 15-minute cache never hits for the ordinary paste, so every re-analysis burns another GitHub budget

**File:** `src/lib/deploy/source/cache.ts:95-96`.

`get()` does `const branch = options?.branch ?? ref.branch ?? null; if (branch === null)
return null;` — and `plan.ts:127` passes `{ branch: ref.branch ?? undefined }`. For the
**normal** paste (`github.com/o/r`, no `/tree/…`) `ref.branch` is `null`, so the read
returns `null` **before touching the disk**. `set()` meanwhile files the snapshot under
`resolvedBranch`, so a file is written that can never be read by the same input.

**Repro** (fetch counter, real cache, 3 analyses of the same URL):

```
https://github.com/acme/store        →  3 network fetch(es) for 3 analyses   ← cache never hits
https://github.com/acme/store/tree/main →  0 network fetch(es) for 3 analyses
```

**Observed:** the docs' promise — *"re-analysing the same URL twice must not cost two
budgets"* (§5) — is false for the shape users actually paste. At ~3 core requests each,
the anonymous 60/hr budget is gone after ~20 analyses. I hit exactly this during QA: the
budget drained to 0/60 and the feature went to 503 for 35 minutes.
**Expected:** the second analysis of the same pasted URL makes no network call.

**Root cause:** the read is keyed on the *requested* branch while the write is keyed on the
*resolved* branch. Resolving the default branch costs the cheap metadata request; the
expensive tree+probe work is what should be cached. Options: cache the default-branch
resolution too, or write an additional pointer entry under a `(host,owner,repo,'@default')`
key.

## ⚠️ MAJOR-3 — `astro-docs` and other static monorepos get a `render.yaml` with a placeholder build command

**File:** `src/lib/deploy/generate/render-yaml.ts:265-279`.

For `jekyll/minima` (a genuine static site) the emitted blueprint is:

```yaml
  - type: 'web'
    runtime: static
    name: 'minima'
    # TODO: set the command that builds your static output (e.g. npm run build).
    buildCommand: 'echo "TODO: set your build command"'
    staticPublishPath: './_site'
    autoDeploy: false
```

The blueprint is schema-valid and the TODO is honestly marked, but it is offered with
`required: true` and the Render card's `requiresConfig: true` tells the user to commit it.
Committing this file and clicking the button produces a **successful deploy of an empty
site** (`echo` succeeds, `_site` is never built) — a silent wrong result rather than a
visible failure.

**Observed:** `required: true` on an artifact we know is incomplete.
**Expected:** when `buildCommand` is a placeholder, either mark the artifact
`required: false` with a "you must fill this in" `why`, or have the fit copy say the
blueprint needs a build command before it will work. A deploy that succeeds and serves
nothing is the worst outcome for the user.

## ℹ️ MINOR-1 — I could not confirm the private-repo message end to end in this session

`https://github.com/github/github` (a real private repo) returned **503
`repo_unavailable`** rather than 404 `repo_not_found`, because my GitHub budget was
exhausted at that moment and the 403 rate-limit response preempted the 404. The 404 copy
itself is correct and was observed live earlier in the run (and by the F1 reviewer on
`t_588b9a87`), and `apiErrorFor` handles 404 before the rate-limit branch
(`github.ts:189-200`), so I have no reason to doubt it. But the specific private-repo →
404 path is **not** something I personally confirmed live in this session. Listed here for
honesty rather than as a defect.

## ℹ️ MINOR-2 — A nonexistent subdirectory reports "the repository listing was empty"

`https://github.com/shadcn-ui/ui/tree/main/apps/www` (that path does not exist; the app is
`apps/v4`) yields *"The repository listing was empty and no probe files could be read"* —
technically true of the scoped root, but it reads as "your repo is empty" when the real
answer is "that subdirectory does not exist in this repo". A note naming the subdir would
turn a confusing message into an actionable one. `detect/index.ts:123-127`.

## ℹ️ MINOR-3 — `theNewDynamic/gohugo-theme-ananke` reports `nodeVersion: 'node'`

`detectNodeVersion` reads `.nvmrc` verbatim (`rules.ts:872-886`); this repo's `.nvmrc`
contains the literal string `node` (nvm's alias for "latest"). We then surface
`nodeVersion: 'node'`, which is not a version. Harmless today (nothing consumes it), but
if it ever reaches a `render.yaml` or a provider hint it would be an invalid value. Worth a
sanity check that the value looks like a version or a known alias.

## ℹ️ NIT-1 — `render.yaml`'s single-quoted enum-ish values are noisier than needed

The serializer quotes `type: 'web'`, `name: 'ai-chatbot'` but leaves `runtime: node`,
`plan: free` bare. Both parse identically and validate against Render's schema, so this is
purely cosmetic — but the inconsistency makes the snippet look machine-generated in a place
where we're asking the user to trust and commit it.

---

## What is genuinely good (worth protecting through the fixes)

- **The citation invariant is real and enforced structurally, not by convention.**
  `citedSignal` cannot mint a signal for absent text. 34/34 real excerpts verbatim.
- **`confidence: 'unknown'` is a designed state, not an error state.** No framework named,
  no crown, all three providers, explicit "here's what we couldn't read". Best honesty
  surface of the three features.
- **`existing.render` is respected.** `render-examples/express-hello-world` already has a
  blueprint → `requiresConfig: false`, no `render.yaml` emitted, and the reason says so.
  Exactly the "don't tell them to add a file they have" rule.
- **`vercel/ai-chatbot` hardening works.** An SSR Next.js app with drizzle+redis is
  correctly promoted `ssr → fullstack` with a note explaining why, and Render wins.
- **Confidence honesty.** `vitejs/vite-plugin-react` lands at `medium` with *"inferred from
  weak signals only; verify before deploying"*, and the no-lockfile note fires too.
- **The route leaks nothing.** Upstream bodies/URLs are logged server-side only; every
  client-facing message is a fixed string per code.
- **The B8 live smoke test is a real test.** It ran, it wasn't skipped, and its
  expectations match the repos' actual contents (I checked two independently).

---

## Fix tasks filed

| Task | Assignee | Finding |
|---|---|---|
| `t_9833d2aa` | `backend` | BLOCKER-1 + MAJOR-1 + MAJOR-2 — cache key/guard must include `subdir`, plan must trust the parsed ref, branchless pastes must hit the cache |
| `t_e9c8d690` | `backend` | BLOCKER-2 — entry cap drops root manifests; must prioritise root/probe files and set `entriesTruncated` when we truncate |
| `t_45de23e1` | `backend` | BLOCKER-3 — pass effective (PRD-folded) needs to `generateConfigs` |
| `t_9238bb55` | `backend` | MAJOR-3 — a placeholder `buildCommand` must not ship as `required: true` (also carries MINOR-3) |

---

## NOT VERIFIED — what I could not check, and why

1. **`rootDir` in a real monorepo `render.yaml`.** The emitter code is correct, but every
   real monorepo-subdir repo I tried hit BLOCKER-2 and produced `confidence: 'unknown'`,
   which emits no blueprint. So I confirmed `rootDir` only by reading
   `render-yaml.ts:430-435`, never in a live artifact. **Re-verify after BLOCKER-2 is
   fixed.**
2. **Private repo → 404 `repo_not_found` live.** See MINOR-1: masked by an exhausted rate
   limit at the moment I tested it. The copy and the code path are right; I did not
   personally see the 404 in this session.
3. **A completed deployment on any provider.** Deliberately out of scope — cost safety. I
   opened each generated URL and confirmed the landing page and pre-filled repo, then
   stopped at the sign-in wall. No account created, nothing provisioned, nothing billable.
4. **`entriesTruncated: true` from GitHub's own flag.** Every repo I analysed (up to 6326
   entries) returned `truncated: false` from GitHub, so the pre-existing truncation caveat
   never fired for me. I verified our own over-cap truncation instead (BLOCKER-2).
5. **A repo whose `.env.example` contains real-looking secrets.** The `looksLikeRealSecret`
   guard is unit-tested and I read it closely, but I did not find a real public repo that
   trips it, so the refuse-and-note path is not live-verified. (No secret leaked in any
   excerpt I did observe.)
6. **Concurrency.** I tested the cache collision sequentially. I did not test two
   simultaneous in-flight analyses of the same repo racing on the same cache file.
