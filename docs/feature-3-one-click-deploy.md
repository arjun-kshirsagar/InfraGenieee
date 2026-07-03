# Feature 3 — One-click deploy

**Read this before touching Feature 3.** Owned by the **architect**. Contracts
live in `src/types/deploy.ts` (zod is the source of truth); this document is the
rationale and the task map. Propose changes via a kanban comment.

---

## 1. What we are building

The user has already built their app (using our PRD as a guide — we do **not**
build it for them). They paste their repo URL. InfraGenie:

```
paste repo URL
      │
      ▼
parseRepoUrl(raw)            pure   →  RepoRef
      │
      ▼
RepoSource.fetchSnapshot()   IMPURE →  RepoSnapshot     ← the only network step
      │
      ▼
detectStack(snapshot)        pure   →  StackDetection   (every claim cites a file)
      │
      ├── recommendProviders(detection, prdContext?)  pure → ProviderFit[] ×3
      ├── buildDeployUrl(ref, provider)               pure → the one-click URL
      └── generateConfigs(detection, ref)             pure → ConfigArtifact[]
      │
      ▼
DeployPlan   ──  POST /api/deploy/analyze  ──▶  /deploy UI
      │
      ▼
user clicks a button → the PROVIDER'S OWN hosted flow, in a new tab
```

**We never deploy anything.** No provider token, no provider API call, no
resource created. The deploy happens on the provider's site, under the user's
own account. That is simultaneously the product design (we're a companion, not a
CI system) and the cost-safety guarantee (`docs/architecture.md` §6).

Scope is **exactly three providers**: Vercel, Netlify, Render. No Railway, no
AWS, no Fly in v1.

---

## 2. The invariant that makes this honest

Feature 1's is "every AI decision lands in `assumptions`". Feature 2's is "every
price carries `source.evidence`". Feature 3's is:

> **Every claim about the user's stack must cite a real file.**

Encoded in the type system, not in prose:

- A `DetectionSignal` cannot exist without a non-empty `path` **and** a
  non-empty `excerpt` lifted verbatim from that file.
- `stackDetectionSchema` **rejects** a named framework with zero signals.
- `confidence: 'high'` **requires** at least one `weight: 'strong'` signal.
- `confidence: 'unknown'` **forbids** naming a framework or asserting needs —
  you cannot be certain about a repo you could not read.
- `deployPlanSchema` **rejects** a non-null `primary` when confidence is
  `unknown`: an unreadable repo gets all three providers plus guidance, never an
  invented winner.

Prose floors shipped broken in 18/24 combos in Feature 1. Anything that matters
goes in a zod refinement.

---

## 3. Module layout

```
src/types/deploy.ts                 ⭐ the contract — schemas + DEPLOY_PROVIDER_META
src/lib/deploy/
  repo-seam.ts                      ⭐ RepoSource / RepoSnapshotCache + RepoError (architect)
  repo-url.ts                       pure: parseRepoUrl                       (B1)
  deploy-url.ts                     ⭐ pure: the table-driven URL builder     (architect, done)
  source/
    github.ts                       server-only: RepoSource over the public GitHub API (B2)
    cache.ts                        server-only: 15-min snapshot cache        (B2)
  detect/
    index.ts                        pure: detectStack(snapshot)              (B3)
    rules.ts                        pure: the signal → framework/shape table (B3)
    needs.ts                        pure: database/cache/queue inference     (B4)
  recommend/
    index.ts                        pure: recommendProviders(detection, prd?) (B5)
  generate/
    render-yaml.ts                  pure: render.yaml blueprint              (B6)
    vercel-netlify.ts               pure: vercel.json / netlify.toml hints    (B6)
  plan.ts                           orchestrates 1→5 into a DeployPlan       (B7)
src/app/api/deploy/analyze/route.ts POST — parse, delegate, respond           (B7)
src/app/deploy/page.tsx             the /deploy route                        (F1)
src/components/deploy/*             UI                                        (F1–F3)
```

**Purity rule.** Everything except `source/` is pure — same input, same output,
no clock, no network, no randomness. This is what lets the whole detection matrix
be tested from fixtures, and what lets the live smoke test run the *same*
functions against real repos.

`generatedAt` / `fetchedAt` are injected by the caller, never read from `Date`
inside a pure module.

---

## 4. The provider URL table (verified 2026-07-28)

`DEPLOY_PROVIDER_META` in `src/types/deploy.ts` is the **only** place a deploy
URL is defined. Each row cites its docs URL. Do not hardcode a query parameter
anywhere else.

| Provider | URL | Branch | Subdirectory | Config file |
|---|---|---|---|---|
| Vercel | `https://vercel.com/new/clone?repository-url=<enc>` | inside the value: `/tree/<branch>` | inside the value: `/tree/<branch>/<subdir>` | `vercel.json` |
| Netlify | `https://app.netlify.com/start/deploy?repository=<enc>` | `&branch=<branch>` | `&base=<path>` (or `&create_from_path=` to clone just it) | `netlify.toml` |
| Render | `https://render.com/deploy?repo=<enc>` | inside the value: `/tree/<branch>` | **not in the URL** — `rootDir` in `render.yaml` | `render.yaml` |

Sources:
[Vercel](https://vercel.com/docs/deploy-button/source),
[Netlify](https://docs.netlify.com/deploy/create-deploys),
[Render](https://render.com/docs/deploy-to-render).

Notes that came out of reading the actual docs:

- **A subdirectory needs a branch anchor.** `/tree/<subdir>` would be read as a
  branch name, so `buildRepoValue` requires a branch when path-suffixing a
  subdir. If none is known it emits the bare repo URL rather than a broken one —
  **we never guess `main`.** The snapshot's `defaultBranch` supplies it.
- **Render blueprints should set `autoDeploy: false`.** Render's docs say so
  explicitly for repos deployed via the button, otherwise every push to the
  template repo redeploys every instance created from it. The generator must
  emit it.
- **Render reads `render.yaml` from the repo.** So for a full-stack/DB app the
  Render button does not work properly until the user commits the blueprint we
  generate → that fit gets `requiresConfig: true` and the UI must say so.
- All values go through `URLSearchParams`. The encoding *is* the injection
  defence; there is no separate sanitiser.

---

## 5. Reading the repo (the seam)

`RepoSource` (`src/lib/deploy/repo-seam.ts`) is the only thing that touches the
network. Implementation constraints, measured not assumed:

- **Anonymous.** No token. Measured 2026-07-28: `api.github.com` returns
  `x-ratelimit-limit: 60` per hour per IP for unauthenticated core requests.
  `raw.githubusercontent.com` is not part of that budget.
- **Bounded fan-out.** `MAX_PROBE_FILES = 16` content reads per analysis,
  each capped at `MAX_PROBE_FILE_BYTES = 64 KB`. Probe only files the root
  listing proves exist — blind probing is not affordable at 60/hr.
- **404 conflates absent and private.** Verified: a nonexistent repo returns
  404 anonymously, and so does a private one. We surface `repo_not_found` and a
  message naming *both* possibilities. Claiming to know which would be a
  fabrication.
- **A missing file is ABSENT from `snapshot.files`, never present-and-empty.**
  Detection distinguishes "no such file" from "empty file"; an empty string
  would be a fabricated signal.
- **GitHub-only content reads in v1.** GitLab/Bitbucket URLs still parse and
  still get all three buttons (all three providers accept those hosts), but
  detection returns `confidence: 'unknown'` with an explicit note. Honest beats
  broad.
- **15-minute snapshot cache** (`SNAPSHOT_MAX_AGE_MINUTES`). The user is
  actively pushing to this repo, so a long TTL would lie; but re-analysing the
  same URL twice must not cost two budgets. Reads never throw — a corrupt entry
  is a miss, same posture as `src/lib/cost/pricing/cache.ts`.

Errors: throw `RepoError`, never a raw fetch error. The route maps
`RepoError.code` → the API error codes added to `apiErrorSchema`:
`repo_not_found` (404), `repo_unavailable` (503, retryable), `unsupported_host`
(400).

---

## 6. Provider fit

`recommendProviders(detection, prdContext?)` is **pure and deterministic — no
LLM.** Provider fit is a small, stable, explainable rule set; a model would add
latency and non-determinism to a decision we can write down. (Contrast Feature
2, where the model reasons about *sizing*, which genuinely varies.)

Every fit carries `reasons` (min 1 — a verdict with no reason is untrustworthy)
and `caveats`. **All three providers always appear**, including the ones we
advise against, with the reason why. Hiding a provider hides the reasoning, and
the reasoning is the product.

Shape of the rules (B5 owns the exact weights):

| Detected | Vercel | Netlify | Render |
|---|---|---|---|
| `static` (Hugo, Jekyll, Vite SPA, Astro static) | recommended | recommended | possible |
| `ssr` Next.js | **recommended** (first-party) | possible (adapter/plugin) | possible |
| `ssr` Nuxt/SvelteKit/Remix/Astro-SSR | recommended | recommended | possible |
| `fullstack` / `api-only`, long-lived server | not-recommended | not-recommended | **recommended** |
| needs `database` / `cache` / `queue` | possible + caveat (external add-on) | possible + caveat | **recommended** (managed Postgres/Redis) |
| needs `background-worker` / `cron` / `websockets` | not-recommended | not-recommended | **recommended** |
| `runtime: docker` | not-recommended | not-recommended | **recommended** |
| non-Node runtime (python/ruby/go/…) with a server | not-recommended | not-recommended | **recommended** |
| `confidence: 'unknown'` | possible | possible | possible — **`primary: null`**, all three + guidance |

PRD context (optional, `DeployPrdContext`) sharpens but never overrides a file
signal:

- `budgetBand: 'free-tier' | 'hobby'` → favour the provider with the workable
  free tier for this shape; add a caveat where a managed DB breaks it.
- `userScale: 'large' | 'very-large'` + `trafficPattern: 'spiky'` → favour
  serverless/edge for `static`/`ssr`; note cold-start/instance sizing for Render.
- A `datastore`/`queue`/`cache` component in `architecture.components` corroborates
  the corresponding `ServiceNeed` — and, notably, can supply it when the repo is
  quiet (a note must say the signal came from the PRD, not the repo).
- Set `usedPrdContext: true` whenever it changed anything, and record what it
  changed in `assumptions`.

Anything we decided that the user did not tell us goes in `plan.assumptions` —
same first-class treatment as `prd.assumptions` and
`recommendation.assumptions`.

---

## 7. Generated configs

We generate files the user can copy or download into **their own** repo. We
never commit to their repo (we have no write access and want none).

- **`render.yaml`** — required whenever the app is `fullstack`/`api-only` or has
  any `ServiceNeed`, because the Render button reads the blueprint from the repo.
  Must set `autoDeploy: false` (Render's own recommendation for button repos),
  the right `env`/runtime, `rootDir` for a monorepo, and a `databases:` entry
  only when a `database` need was actually detected. Every env var the app needs
  goes in as `sync: false` — **never a literal value**, and never a secret.
- **`vercel.json` / `netlify.toml`** — usually *not* required (both providers
  auto-detect the common frameworks). Emit one only when detection found
  something the provider won't infer: a monorepo base directory, a non-standard
  build command, a publish directory that isn't the framework default. Mark
  `required: false` and say why.
- `ConfigArtifact.content` must be **valid** YAML/JSON/TOML — the reviewer
  parses it. A snippet that doesn't parse is worse than no snippet.

---

## 8. Route contract

`POST /api/deploy/analyze` → `{ plan: DeployPlan }`. Request: `{ repoUrl, prdContext? }`.

`repoUrl` is **whatever the user pasted, unnormalised**. The server parses it so
that one parser and one set of error messages are authoritative; the client must
not canonicalise first.

| Status | Code | When |
|---|---|---|
| 200 | — | `{ plan }` (may carry `confidence: 'unknown'`, `primary: null`) |
| 400 | `validation_error` / `bad_request` | body failed the schema / not JSON |
| 400 | `unsupported_host` | not a git repository URL we support |
| 404 | `repo_not_found` | repo absent **or** private — message names both |
| 503 | `repo_unavailable` | rate-limited / 5xx / timeout — **retryable** |
| 500 | `generation_failed` | the assembled plan failed self-validation |

The handler contains no business logic: parse → delegate to `buildDeployPlan` →
self-validate the output against `analyzeResponseSchema` → respond. Full detail
goes in `docs/api-contracts.md` (B7 updates it).

No LLM call, so no `llm_*` codes and no 60s `maxDuration` — the whole analysis
is a handful of GitHub reads plus pure functions.

---

## 9. UI (`/deploy`)

Reuses the Feature 1/2 design language (shadcn `Card`, `Badge`, the `/cost`
loading/error view patterns). States, none of them dead ends:

1. **empty** — paste-a-URL hero, an example URL, and a "planned it in
   InfraGenie?" PRD picker (reuse `CostPrdPicker`'s shape) that attaches
   `prdContext`.
2. **loading** — a real progress narrative ("reading the repo…", "detecting the
   stack…"), not a bare spinner. The whole call is a few seconds, not F1's 30–60s.
3. **detected** — a stack summary card (framework, runtime, shape, needs,
   confidence badge) with an expandable **"how we know"** listing each signal's
   `path` + `excerpt`. This is the product's credibility; do not hide it behind a
   modal.
4. **fits** — three cards in score order. Verdict badge, `reasons`, `caveats`,
   and the big deploy button (`target="_blank" rel="noopener noreferrer"`). A
   `requiresConfig` fit must visibly say "add `render.yaml` first" *before* the
   button.
5. **configs** — copyable snippet blocks (copy button + downloadable file), each
   with its `why`.
6. **error** — per-code copy. `repo_not_found` explains public-vs-private and
   offers a retry with a corrected URL; `repo_unavailable` offers a retry.
7. **unknown confidence** — all three providers, no crowned winner, and a plain
   statement of what we couldn't read.

Client-side persistence only, keyed by canonical repo URL, same posture as
`src/lib/prd/store.ts`: SSR-safe, try/catch'd, zod-validated on read, stale blob
treated as absent.

---

## 10. Verification bar

Same as Features 1 and 2, plus one thing those two learned the hard way:

```bash
npm run build   # the real gate
npm run lint
npm test
npx tsc --noEmit
```

**A LIVE smoke test is mandatory** (`*.live.test.ts`, guarded by an env flag so
CI without network still passes — follow
`src/lib/cost/pricing/build.live.test.ts`). It must run the real `RepoSource`
plus the real pure pipeline against **4 real public repos** of different shapes
and assert the detected framework/shape and a well-formed deploy URL per
provider:

| Repo | Expect |
|---|---|
| a Next.js app | `framework: 'nextjs'`, `appShape: 'ssr'`, Vercel recommended |
| a static site (Hugo/Jekyll/Vite) | `appShape: 'static'`, Vercel + Netlify recommended |
| a full-stack app w/ Postgres (e.g. a Django/Rails/Express+Prisma repo) | `needs` includes `database`, Render recommended, `render.yaml` generated |
| a Dockerfile-only / non-Node service | `runtime: 'docker'` or non-Node, Render recommended |

Mocked-only tests hid real bugs in both previous features. Mocks prove the
matrix; the live test proves the matrix is pointed at reality.

**Cost safety in tests:** the live test only *reads* public repos and *builds*
URL strings. It must never open a deploy URL programmatically, never create a
provider account, never deploy. If a task appears to need a real deployment,
`kanban_block` and ask the owner.
