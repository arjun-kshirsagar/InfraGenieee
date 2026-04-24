# QA report — Feature 1 (PRD & Plan generator)

Reviewer: `reviewer` profile · Task `t_63741569` · Reviewed commit `ced25b9`
Method: contract audit against `docs/api-contracts.md` + `docs/architecture.md`, live `curl`/HTTP probing of
`POST /api/prd/generate` (production build on `:3199`), and Playwright/Chromium browser QA of the full flow.
Nothing paid was touched — no deploys, no external APIs, local build + local Chromium only.

## Verdict

**DO NOT SHIP — 2 Majors must be fixed first.** Everything else is genuinely solid.

The generator is *not* a template with the project name swapped in — that was the thing most likely to be
faked here, and it holds up under adversarial comparison (see §3). The build/lint/typecheck/test gates all
pass, the flow works end to end in a real browser with zero console errors, and the error envelope matches
the contract exactly. Two real defects block: a **documented contract guarantee that is violated in 18 of 24
product-type/stack combinations** (min-volume ≥12 plan tasks) and a **missing UI gate on duplicate entity
names** that lets provably-corrupt output be generated.

## Findings

| # | Sev | Area | Finding | Reproduction | Evidence |
|---|-----|------|---------|--------------|----------|
| 1 | **Major** | backend / engine | Contract guarantee #4 (`≥ 12` plan tasks) is violated for any project with **no frontend** or **no database**. Emitted 10–11 tasks. Also `milestones` lands at 4 not 3, so only the task floor breaks. There is **no floor enforcement anywhere** — no `MIN_*` constant exists in `src/lib/prd/generate/**`, and `planSectionSchema` has no `.min()`, so the route's self-validation (guarantee #3) cannot catch it. | `POST /api/prd/generate` with `stack.frontend:'none'`, `stack.database:'none'`, 1 entity, no auth, no integrations → 10 tasks. Answer set (d) from this review (`api-service`, frontend `none`, db `none`) → **11 tasks**. | Swept 24 combos of `productType × frontend × database`: **18 fail the ≥12 bar** (all 6 product types × `frontend:'none'` → 10–11; × `database:'none'` → 11). Full output in §5. |
| 2 | **Major** | frontend | Duplicate entity names are **warned but not gated**. The entity builder shows "Duplicate name — entity names must be unique." yet **Next advances anyway**, and the resulting document is provably corrupt: 5 duplicate API endpoints, duplicate user stories, duplicate plan tasks. `entitySchema` has no cross-entity uniqueness rule so the server accepts it too (200). | `/prd/new` → fill steps 1–4 → step 5: add entity "Tenant", add entity "Tenant" again → duplicate warning appears → click **Next** → **advances to Auth & compliance**. Generate → 200. | `src/components/prd/entity-builder.tsx:115-119` computes `isDup` for display only; `wizard-validation.ts`'s `validateStep('dataModel', …)` only runs `dataModelAnswersSchema`, which has no uniqueness check. Live endpoint with two `Tenant` entities returns endpoints `GET /api/tenants` ×2, `POST /api/tenants` ×2, `GET|PATCH|DELETE /api/tenants/:id` ×2; stories `"to create and manage Tenant records"` ×2; tasks `Tenant: schema & migration` ×2, `Tenant: read API` ×2, `Tenant: write API` ×2, `Tenant: UI` ×2. Screenshots `T1-duplicate-entities.png`, `T1-advanced-despite-duplicates.png`. |
| 3 | Minor | backend / engine | `plan.estimatedCalendarWeeks` is pure `totalHours / (teamSize × hoursPerWeek)` with **no dependency/critical-path floor**, so it produces physically impossible schedules. `teamSize: 40` → **0.3 weeks** for 330 h of work whose critical path alone is 71 h across 10 sequential tasks (≈1.8 weeks minimum for one person, and the path can't be parallelised). `teamSize: 500` → **0 weeks**. | `POST` answer set (c) (`teamSize: 40`) → `estimatedCalendarWeeks: 0.3`. Set `teamSize: 500` on any answers → `0`. | `src/lib/prd/generate/plan.ts:683-684`: `capacityPerWeek = budget.teamSize * PRODUCTIVE_HOURS_PER_PERSON_WEEK`. Should be floored by critical-path hours ÷ hours-per-week. |
| 4 | Minor | backend / engine | `diagramMermaid` prefixes a `%%` comment line **before** the `flowchart TD` header. Mermaid tolerates this (it renders — verified in-browser), but it means the string does not start with the declaration the contract documents (`diagramMermaid: string; // 'flowchart TD …'`) and will break any naive consumer that checks the prefix. Node ids are correctly sanitised (`Web_Client`, `File_storage_external`) and labels are quoted — no injection or parse risk found. | Any generate call; inspect `architecture.diagramMermaid[0..2]`. | All 4 answer sets start `%% InfraGenie architecture diagram for <name>\nflowchart TD`. |
| 5 | Minor | frontend | Multi-select/checkbox DOM ids are derived from the **error** id: `q-scale-regions-error-opt-eu-west`. Functional and label-linked, but a checkbox whose id says `-error-` is confusing and brittle for tests/automation. | Inspect any multi-select on `/prd/new`. | `src/components/prd/question-field.tsx:267` — `const id = \`${errorId}-opt-${o.value}\`;` should derive from `inputId`. |
| 6 | Minor | repo hygiene | create-next-app scaffolding SVGs are still committed and referenced by nothing: `public/next.svg`, `public/vercel.svg`, `public/window.svg`, `public/globe.svg`, `public/file.svg`. | `grep -rn "next.svg\|vercel.svg\|window.svg\|globe.svg\|file.svg" src` → no matches. | Dead files; the landing page itself is fully rewritten (boilerplate copy is gone). |

### Deliberately **not** raised

- **"Stuck after Resume"** — I initially flagged this and it is a **false alarm**. Resuming a *partial* draft
  correctly blocks at the first incomplete step. Seeding a complete draft then resuming walks all 7 steps →
  Review without a single block. Correct behaviour, verified separately.
- **Synthetic `User` / `Organization` entities** appearing in `architecture.dataModel.entities` but not in
  `answers.dataModel.entities` — this is intentional and documented (`architecture.ts:130-138`), auth-derived,
  and every relationship endpoint is a name present in the *architecture* entity list. My first automated
  check compared against the *answers* list and produced a false positive.
- `eslint-disable-next-line react-hooks/set-state-in-effect` ×3 — legitimate hydration-from-localStorage
  pattern, narrowly scoped, not blanket disables.

## Contract conformance (§1)

| Guarantee | Result | Evidence |
|---|---|---|
| #1 Deterministic (same answers → identical apart from `id`/`createdAt`) | **PASS** | All 4 answer sets posted twice; JSON identical after stripping `id`/`createdAt`. |
| #2 `answers` echoed verbatim | **PASS** | Recursive field-by-field diff of every submitted key against `document.answers` — 0 discrepancies on all 4 sets (zod defaults fill omitted optionals only). |
| #3 Route self-validates output before responding | **PASS (code)** | `route.ts:55-62` parses through `prdDocumentSchema` and returns `generation_failed` on mismatch. Ineffective against finding #1 because the schema encodes no minimums. |
| #4 Min volume ≥5 stories / ≥8 FRs / ≥5 NFRs / ≥3 milestones / ≥12 tasks / ≥1 component per entity | **FAIL** | Finding #1. Stories/FRs/NFRs/milestones/components hold everywhere tested; **tasks** fail in 18/24 combos. |
| #5 Every `dependsOn` id exists; no cycles | **PASS** | Graph built and DFS-cycle-checked for all 4 sets + the duplicate-entity case: 0 dangling refs, 0 cycles. |
| #6 No network calls / secrets / paid APIs | **PASS** | No `process.env` anywhere in `src`, no `NEXT_PUBLIC_*`, no tracked `.env`/key/credential files, `.env*` gitignored. |
| Error envelope exactly `{ error: { code, message, issues? } }` | **PASS** | Malformed JSON → 400 `bad_request`; missing `scale.regions` → 400 `validation_error` with `issues[0].path = "answers.scale.regions"`; empty body → 400 `validation_error`; out-of-range uptime → 400 with `"Too small: expected number to be >=90"`. No stack traces leaked. |
| `criticalPath` is a genuine path | **PASS** | Every consecutive pair is `dependsOn`-linked; all ids exist. |
| Relationship endpoints are real entity names | **PASS** | 0 phantom endpoints across all sets (checked against the architecture entity list, which includes the documented synthetic auth entities). |
| `mustAvoid` never appears in the recommendation | **PASS** | `mustAvoid: ['Vercel','SQLite']` on a free-tier prototype (whose default pick *is* Vercel Hobby) → hosting flips to `Render (free/starter)`, CI/CD flips to Render auto-deploy, and rationale states `'"Vercel Hobby" is on your must-avoid list → picked Render (free/starter) instead.'` (`SQLite` survives only because the user *explicitly chose* `database: 'sqlite'` — explicit choice correctly beats avoid-list, and the rationale says so.) |
| Architecture §3 rule 4 — no UI import from `src/lib/prd/generate/**` | **PASS** | Only matches are comments and the endpoint string constant. Zero real imports. |
| Architecture §3 rule 1 — no hand-written type duplicating a zod schema | **PASS** | All 44 exported types in `src/types/prd.ts` are `z.infer<…>`. |
| Engine purity — no `Math.random()`/`Date.now()` | **PASS** | Only matches are doc comments asserting the rule. `id`/`createdAt` are injected by the route (`route.ts:51-52`) — the single documented injection point. |

## Generation quality — four answer sets side by side (§2)

The question was: *is the output derived from the inputs, or a template?* **It is genuinely derived.**

| | (a) TinyLinks — prototype, free tier, no auth, 1 entity | (b) DeskPilot — medium SaaS, multi-tenant, GDPR, payments+email, jobs | (c) VitalStream — very-large, aggressive, HIPAA+SOC2, 7 entities, realtime+uploads | (d) GeoPing API — `api-service`, `frontend: none`, `database: none` |
|---|---|---|---|---|
| Hosting | Vercel Hobby | Vercel **Pro** | **AWS (ECS/Fargate + RDS + CloudFront)** | Vercel Hobby |
| Database | SQLite | PostgreSQL | PostgreSQL | **None** |
| Cache | None | None | **Redis (ElastiCache)** | None |
| Storage | None | None | **Amazon S3** | None |
| CI/CD | Vercel Git integration | Vercel Git integration | **GitHub Actions** | Vercel Git integration |
| Environments | dev/preview/prod | + **staging** (team 4) | + **staging** (team 40) | dev/preview/prod |
| Pattern | Monolithic Next.js (driver: prototype scale) | Monolithic Next.js (driver: medium scale) | **Containerised services behind a load balancer** (driver: very-large user scale) | **Standalone API service** (driver: productType "api-service") |
| Components | 3 | 6 (+ Job Queue, Stripe, Resend/Postmark) | **9** (+ Cache, Job Queue, CDN, S3, PostHog, webhooks) | **3, no Web Client** |
| API endpoints | 5 | 24 | 49 | 13 |
| User stories | 5 | 9 | **16** | 5 |
| FRs / NFRs | 8 / 5 | 10 / 6 (**+compliance**) | 17 / **7** (**+compliance ×2**) | 8 / 5 |
| Milestones / tasks | 4 / 12 | 5 / 27 | 5 / **49** | 5 / **11 ⚠ (<12)** |
| Frontend/design tasks | present | present | present | **none — correct** |
| `dependsOn` dangling / cycles | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Mermaid valid | yes | yes | yes | yes (3 nodes, no Web Client) |

Concrete evidence it is input-derived, not templated:

- **(a) vs (c) diverge on every infrastructure axis** — different hosting family, different pattern, cache/storage/CDN
  appear only where scale and uploads justify them, and the `rationale[]` array names the actual driver for each
  choice (`'very-large user scale → Redis (Amazon ElastiCache) added up front for hot-path caching.'`,
  `'team size 40 (> 5) → dedicated staging environment'`).
- **(d) correctly suppresses all frontend work** — no Web Client component, zero `frontend`/`design`-area tasks,
  and the one nominally-UI task is re-areaed to `backend` (`plan.ts:606-608`).
- **NFR sets differ by input**, not by boilerplate: compliance NFRs appear once for GDPR (b) and twice for
  HIPAA+SOC2 (c), and not at all for (a)/(d). Uptime NFRs quote the user's own target (`99.5%` for (d)).
- **Goals/open questions are answer-aware**: (a) gets *"The budget is free-tier only — is there any headroom…"*
  and *"No relationship notes were provided…"*; (c) instead gets *"Which region should be primary for launch, and
  is multi-region needed on day one?"*.
- **Stories reflect auth config**: (a) *"to use the product without creating an account"*; (c) *"to sign up and
  sign in using enterprise SSO (SAML)"* and *"to switch between the organisations I belong to"*.

**Blunt assessment: this is real rules-engine output, not a mail-merge.** The one place it degrades is
*volume floors* (finding #1) — the engine derives honestly, but nothing guarantees the minimum the contract
promises when the inputs are thin.

## Browser QA (§3)

35 automated assertions via Playwright + local Chromium against the production build. **32 pass, 2 fail
(both finding #2), 1 was a false alarm I retracted.**

Passing:
- Full happy path `/` → `/prd/new` → 7 steps → Generate → `/prd/prd_v479fby003ra`, **zero console errors**.
- Validation gating: empty step 1 blocks with 6 visible `role="alert"` messages; number field **rejects text
  entirely** (`type=number`, value stays `''`); uptime `50` blocks with `"Too small: expected number to be >=90"`;
  zero entities blocks with `"Too small: expected array to have >=1 items"`.
- `visibleWhen`: sign-in methods / roles / multi-tenant absent before `authRequired` is answered, absent with
  auth = **No**, all three revealed on **Yes**.
- Draft autosave: 3 steps filled → reload → Resume prompt → values intact (`projectName` = `DeskPilot`);
  **Start fresh** removes the localStorage key and clears the fields.
- Entity builder: add/remove entities and fields; **field cap enforced at exactly 30** (Add field disabled +
  "Field limit reached (30)"); entity cap surfaced at 25.
- PRD view: all 3 tabs render; **Mermaid renders a real SVG**; Copy-as-Markdown → 20,013 chars on the clipboard;
  Download → `deskpilot-product-requirements-document.md`, 20,152 B.
- `/prd` list shows the saved doc; garbage id `/prd/prd_zzzzzzzzzzzz` → clean *"Document not found"* empty
  state, no crash, no console errors.
- Direct reload of `/prd/<id>` → no hydration or console errors.
- 375 px and 1280 px: `scrollWidth == clientWidth` on landing, wizard, and document — no horizontal overflow.

Failing: duplicate entity names advance past step 5 and generate corrupt output (finding #2).

## Repo hygiene (§4)

```
$ npm run build   → exit 0   ✓ Compiled successfully in 27.0s · TypeScript 12.4s · 5/5 static pages
                              routes: / · /_not-found · ƒ /api/prd/generate · ƒ /prd · ƒ /prd/[id] · /prd/new
$ npm run lint    → exit 0   (eslint, no output)
$ npx tsc --noEmit → exit 0
$ npm test        → 12 files, 326 tests, 326 passed (4.72s)
```

- Committed secrets: **none**. No `process.env` in `src`, no `NEXT_PUBLIC_*` at all, `.env*` gitignored, no
  tracked key/credential/pem files.
- `console.log`/`console.debug`: **none** outside tests.
- `: any` / `as any` / `@ts-ignore` / `@ts-nocheck`: **none**. Three narrow
  `eslint-disable-next-line react-hooks/set-state-in-effect` for localStorage hydration — acceptable.
- Skipped / `.only` / `.todo` tests: **none**.
- create-next-app boilerplate: landing page fully rewritten, but 5 scaffolding SVGs remain in `public/` (finding #6).
- `tsconfig.tsbuildinfo` is untracked. ✓

## Reproduction assets

Probe harness (committed for the fix authors to re-run): `scripts/qa-probe.mjs`
— `node scripts/qa-probe.mjs http://127.0.0.1:<port>` posts all four answer sets plus every error path and
prints determinism / echo / min-volume / dependency-graph / mermaid analysis.

Screenshots (this run): `/tmp/qa/shots/` — key screens sent to the human on Telegram.
