# Feature 1 (AI-generated PRD & Plan) — adversarial review + browser QA

**Reviewer:** `reviewer` agent · **Task:** `t_95c31f1f` · **Date:** 2026-07-26
**Reviewed:** `main` @ `8b5bc27` · **Generator:** `2.0.0` · **Model:** `claude-sonnet-5` (+ `claude-haiku-4-5` for clarify/title)

> This document replaces the previous QA report, which described the deleted 7-step
> questionnaire. The target is now non-deterministic LLM output, so no determinism or
> byte-equality assertion appears here — those would be wrong by construction.

---

## Verdict

### ⚠️ SHIP WITH ONE FIX — 1 Major, 4 Minors

**The re-scope worked.** The central question — *does the AI actually do the thinking?* —
is answered **yes**, with evidence. Entities are domain-specific, architectures genuinely
diverge across briefs, `infrastructure.rationale[]` quotes the actual brief, plans are
handable to a coding agent, and `assumptions[]` is honest about what the AI decided.
Both Majors from the previous review are structurally closed and I verified that by
construction, not by reading the claim.

One Major blocks a clean ship: a recoverable model-output shape (a JSON-stringified
array) is misclassified as terminal, so it discards a complete 4-minute paid generation
with no retry. I hit it **live, on the first pass, 1 in 5 runs** — and a second worker
(`t_70201242`) hit the same class independently. At ~$0.53 and ~4 minutes per document
that is a real user-facing failure with a real bill attached, and the fix is small.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `npx eslint` | ✅ exit 0 (0 errors, 2 pre-existing warnings in untouched files) |
| `npm run build` | ✅ exit 0 — 7 routes, `/api/prd/*` correctly `ƒ` dynamic |
| `npm test` | ✅ 207/207 across 12 files, **fully offline** (proven — see Cost safety) |
| Secret leakage | ✅ no key in client bundle, response bodies, or `NEXT_PUBLIC_*` |
| Contract conformance | ✅ every code/status pair verified against the real pipeline |
| Browser QA | ✅ full flow, both clarifier paths, all failure states, 0 console errors |

---

## Majors

### MAJOR-1 — A JSON-stringified array is treated as terminal, silently burning a full paid generation

**Routed to:** fix task (backend) · **Files:** `src/lib/prd/llm/shared.ts:313-323`, `src/lib/prd/llm/shared.ts:193-200`

**What happened, live.** One of my four adversarial briefs (`marketplace`) failed after
**242 seconds** — after stages 1 and 2 had already completed and been paid for:

```
[prd.llm] model=claude-sonnet-5 stage=prd          input_tokens=2927 output_tokens=7307  latency_ms=84013 attempt=0
[prd.llm] model=claude-sonnet-5 stage=architecture input_tokens=6798 output_tokens=7267  latency_ms=58850 attempt=0
[prd.llm] model=claude-sonnet-5 stage=plan         input_tokens=5485 output_tokens=10152 latency_ms=87802 attempt=0
[marketplace] FAILED after 242.2s code=invalid_output
  msg=Stage "plan" output failed schema validation: milestones: Invalid input: expected array, received string
```

The model emitted **10,152 output tokens of correct plan content**, but wrapped
`milestones` as a JSON *string* rather than an array. The user sees
`500 generation_failed`.

**Why it is a Major, not a Minor.**

1. **It is recoverable and we throw it away.** One `JSON.parse()` yields a fully valid
   plan. Proven deterministically in `scripts/qa-stringified-array-probe.ts`:
   ```
   PASS  stringified milestones fails the schema — Invalid input: expected array, received string
   PASS  isPurelyUnderVolume() says NOT retryable → runStage throws immediately
   PASS  JSON.parse()-ing the string yields a VALID plan (15 tasks, 3 milestones)
   PASS  NO retry was attempted (exactly 1 upstream call) — a retry would have been 2
   ```
2. **It gets no retry at all.** `isPurelyUnderVolume()` (`shared.ts:193`) only recognises
   `too_small`+`origin:'array'`. A stringified array is `invalid_type`, so `runStage`
   takes the terminal branch at `shared.ts:317` and throws immediately. The one retry the
   design allocates is unreachable for this failure.
3. **It is not a one-off.** I hit it on 1 of 5 live runs on the `plan` stage. Worker
   `t_70201242` independently hit the identical class on the `prd` stage
   (`functionalRequirements` returned as a string). Two stages, two workers, same root cause.
4. **It costs money every time.** ~$0.53 and ~4 minutes discarded per occurrence.

**Repro (deterministic, zero API calls):**
```bash
npx tsx scripts/qa-stringified-array-probe.ts
```

**Suggested fix (backend's call, but the shape is clear).** Coerce-then-validate before
declaring terminal: if a field fails with `invalid_type` "expected array, received
string", try `JSON.parse()` on that field once and re-validate. Failing that, treat
`invalid_type` on a container field as **extend-retryable** so the existing single retry
applies. Either way keep the hard one-retry cap — do not loop.

**Status: FIXED** — `coerceStringifiedArrays()` in `shared.ts` parses the offending
path(s) once and re-validates with zero extra calls. See MAJOR-1 tests in `shared.test.ts`.

### MAJOR-2 — Live PRD generation fails schema validation on relationship `kind` enum

**Routed to:** fix task (backend) · **Files:** `src/lib/prd/llm/normalize.ts`, `src/lib/prd/llm/stages/architecture.ts`, `src/lib/prd/llm/shared.ts` (runStage `repair` hook)

**What happened, live.** On a real generation (`claude-haiku-4-5`, gym-booking brief),
stages 1 and 2 both completed and were paid for (prd=6885, architecture=5250 out tokens),
then zod rejected the architecture output:

```
invalid_output: Stage "architecture" output failed schema validation:
dataModel.relationships[1..6].kind: Invalid option:
expected one of "one-to-one" | "one-to-many" | "many-to-many"
```

**Root cause.** The model returned natural relationship phrasings (`belongs-to`,
`has-many`, `references`, `1:N`, …) instead of the exact zod enum values. The mocked unit
tests always used valid enum values, so this passed CI green but failed **~half of live
runs** on the architecture stage — burning a paid call each time.

**Fix (tighten, don't loosen).**
1. Tightened the architecture prompt: the relationship `kind` field is called out as
   EXACTLY the three literal enum strings, with an explicit mapping guide + examples, and
   an explicit "do NOT emit belongs-to/has-many/1:N/m2m" instruction.
2. Added a deterministic normalization/repair layer (`normalize.ts`) that maps common
   model synonyms onto the strict enum BEFORE zod validation. Wired into `runStage` via a
   generic `repair` hook applied to raw output before every `safeParse` (first attempt AND
   the extend-retry). Unmappable values are left to fail → the existing one re-ask fires
   rather than a silent wrong guess. Zero extra calls.

**Verify.** New `src/lib/prd/llm/pipeline.live.test.ts` runs the FULL 3-stage pipeline
end-to-end against real Anthropic (guarded on `ANTHROPIC_API_KEY`, fast model) over 3
varied ideas (gym booking / link-in-bio / internal CRM) and asserts
`prdDocumentSchema.safeParse(doc).success`. Confirmed passing live on the gym-booking repro
(architecture stage no longer dies). Offline: `normalize.test.ts` + runStage `repair` tests
cover the map and the hook.

**Status: FIXED.**

### MAJOR-3 — Plan stage truncates at max_tokens (16000) on large plans, burning the paid prd + architecture

**Routed to:** fix task (backend, `t_10066d39`) · **Files:** `src/lib/prd/llm/stages/plan.ts:39`

**What happened, live.** The guarded 3-stage live smoke (`pipeline.live.test.ts`), added
for MAJOR-2, exercises the "link-in-bio" brief end to end. On that idea the prd and
architecture stages both completed and were **paid for** (prd=8441, architecture=12219 out
tokens), then the plan stage died:

```
GenerationError: Output truncated at max_tokens (16000); the structured JSON is incomplete.
  at extractAndValidate src/lib/prd/llm/client.ts:244
```

Observed **twice** for this idea — the plan stage emitted exactly 16000 output tokens and
truncated mid-JSON. `client.ts` maps `stop_reason: 'max_tokens'` to `invalid_output`, which
is terminal (no retry), so the two already-paid upstream stages are discarded — the same
waste pattern as MAJOR-1/MAJOR-2.

**Root cause.** `PLAN_MAX_TOKENS = 16000` is not enough headroom for a rich plan. Plan is
the largest stage: many milestones × well over a dozen tasks, each with title +
description + acceptanceCriteria + dependsOn. The link-in-bio plan simply needs more than
16000 output tokens and gets cut off before the tool_use JSON closes.

**Fix.** Raised `PLAN_MAX_TOKENS` to **32000** — ~2× the observed truncation point.
Verified safe against the **official Anthropic model docs** (fetched 2026-07-26,
`platform.claude.com/docs/en/about-claude/models/overview`): `claude-haiku-4-5` max output
is **64k tokens**; Sonnet 5 / Opus 4.8 are 128k. So 32000 leaves large headroom on the fast
model we run in the smoke and is a non-issue on the larger models. The source is cited in a
code comment on the constant. Kept the one-retry cap untouched — no loop was introduced.

**Verify.** The link-in-bio idea in `pipeline.live.test.ts` now passes the full pipeline
(previously it failed *only* on this plan truncation; gym-booking already passed fully).
`npm run build` + `npm run lint` + `npm test` all green offline; live smoke confirmed
against real Anthropic.

**Status: FIXED.**

### MINOR-1 — Stale "questionnaire" copy in two user-facing places

The questionnaire was deleted in this re-scope, but two user-visible strings still sell it.

- `src/components/prd/document/document-list.tsx:60` — the `/prd` empty state reads
  *"Answer the questionnaire to generate your first PRD, architecture, and plan."*
  This is the **first thing a new user reads**, and it describes a flow that no longer
  exists. Suggested: *"Describe your idea and the AI writes your first PRD, architecture, and plan."*
- `src/app/layout.tsx:19` — the site `<meta description>` reads *"InfraGenie turns a
  short **questionnaire** into a PRD…"*. This is what search engines and link previews show.

(`entity-card.tsx:6` also mentions it, but only in a code comment — not user-facing, not worth a round trip.)

### MINOR-2 — "Edit brief" after a failed generation lands on the resume prompt, not the populated form

**Repro:** generate → force a failure → click **Edit brief**. You get the *"Resume your
draft / Start fresh"* interstitial instead of your filled-in form; one extra click on
**Resume** to get back to your text.

No data is lost (I verified the idea, all 5 context answers and the constraints all come
back intact), so this is cosmetic. But the whole point of the error copy — *"Your brief is
safe — nothing you typed was lost"* — is undercut by immediately showing a screen that
implies it might be. The in-app edit path should skip the resume gate, since the brief is
already in memory.

### MINOR-3 — Derived Mermaid draws backwards edges for secondary clients/datastores

`buildArchitectureMermaid()` (`src/lib/prd/derive/index.ts:104-112`) connects any
otherwise-orphaned component *from* the anchor service. For a second or third `client`
that inverts the real direction. From the HIPAA document's actual output:

```
  Core_API_Service --> Patient_Portal_Web_App     # backwards: the portal calls the API
  Core_API_Service --> Admin_Compliance_Console   # backwards: the console calls the API
  Core_API_Service --> Connection_Pooler          # backwards-ish: API talks *through* the pooler
```

The diagram is syntactically valid and renders (verified: 15 nodes / 15 edges, zero
errors), so nothing is broken — but an architecture diagram with reversed arrows is
misleading to the coding agent that reads it. Suggested: for `kind === 'client'`, emit
`client --> anchor`; keep the current direction for everything else.

### MINOR-4 — `estimatedCalendarWeeks` is hardcoded to a 3-person team with no provenance in the document

`DEFAULT_TEAM_SIZE = 3` (`src/lib/prd/llm/pipeline.ts:50`) drives every
`estimatedCalendarWeeks`, but the number is never surfaced. The Plan tab shows
"6.5 weeks" as if it were a property of the plan; it is really "6.5 weeks *for 3 people*."
A solo founder reading the `vague` document's "3.5 weeks" will be wrong by ~3x. The
critical-path floor is correctly applied (verified below), so this is presentation, not maths.

---

## Evidence: does the AI actually do the thinking?

Four materially different briefs, run live (`scripts/qa-live-generate.ts`).

| | `crud` | `marketplace` | `compliance` | `vague` |
|---|---|---|---|---|
| Brief | 6-person law office file tracker | scuba-trip marketplace, 3 countries | HIPAA + 42 CFR Part 2 group therapy | "Airbnb but for gear", deliberately vague |
| Scale / budget | prototype / free-tier | large / growth | medium / enterprise | small / hobby |
| Entities | 4 | 9 | 12 | 10 |
| Components | 5 | — | 15 | 9 |
| Stories/FR/NFR | 7/12/7 | 10/14/8 | 9/14/9 | 9/12/7 |
| Milestones/tasks | 3/27 | 3/40 | 3/43 | 4/38 |
| Assumptions | 10 | 12 | 12 | 12 |
| Hours / weeks | 80.5h / 1.5w | 312h / 5w | 423h / 6.5w | 226h / 3.5w |
| Latency | 166s | 242s | 256s | 222s |

### Entities are idea-specific, not filler

Verbatim from `crud` — note these are the *nouns of the actual problem*, with descriptions
that show the AI understood the domain (physical folders, not case content):

```
File           — A physical case folder tracked by barcode; represents its current location/status, not case content.
StaffMember    — A fixed, short list of office staff selectable during checkout; no login/credentials.
CheckoutRecord — One row per checkout/check-in cycle for a file; forms the audit trail and history panel.
Setting        — Single global configuration row for overdue threshold.
```

`marketplace`: `User, DiverProfile, Certification, Instructor, TripListing, Booking, Refund, Payout, AuditLogEntry`
`compliance`:  `Clinic, User, SessionSeries, SessionInstance, Enrollment, Attendance, SOAPNote, NoteAddendum, CountersignatureRequest, BreakGlassAccess, AuditLogEntry, Notification`

`SOAPNote`, `CountersignatureRequest` and `BreakGlassAccess` are exactly the entities a
HIPAA/Part-2 group-therapy product needs and could not come from a template. The only
generic noun anywhere is `User` (in 3 of 4 docs) — and in the compliance doc it carries 8
domain fields including `supervisingPsychiatristId`, so it is a real modelled entity, not
filler. **Not a Major.**

### Two briefs do not produce the same skeleton

Pairwise Jaccard similarity on entity and component names:

```
crud       vs compliance   entities J=0.00  components J=0.00
crud       vs vague        entities J=0.00  components J=0.08
compliance vs vague        entities J=0.05  components J=0.00
```

Architectures diverge structurally, not just lexically — component *kinds* differ:

```
crud        5 comps  {client:1, service:1, datastore:1, external:2}                             1 env  (production)
vague       9 comps  {client:1, service:2, datastore:2, external:4}                             3 envs
compliance 15 comps  {client:3, service:4, queue:1, datastore:2, cache:1, external:3, cdn:1}     3 envs
```

`crud` gets no cache, no queue, no CDN, one environment. `compliance` gets a queue, a
cache, a CDN, a connection pooler and 3 environments. That is the brief driving the
architecture, which is the entire thesis of the re-scope.

### `infrastructure.rationale[]` cites the brief, not best practice

Verbatim, and each names the specific constraint it is responding to:

> **crud:** "Budget is explicitly $0/month, so hosting and DB must both be free-tier
> (Render free web service + Neon free Postgres), ruling out any always-on paid instance
> or multi-service architecture."

> **compliance:** "Team constraint 'only knows Python and Postgres' drives the modular
> Django/DRF monolith + Celery choice over a polyglot microservices split… All chosen
> vendors (AWS, Daily.co, Twilio SendGrid) are selected specifically because they offer
> BAAs and US-region-only data residency, directly satisfying the brief's non-negotiable
> HIPAA/42 CFR Part 2 requirements."

> **marketplace:** "Growth-tier budget of $250-2000/month rules out dedicated
> microservices, Kubernetes clusters, or over-provisioned fixed capacity — a modular
> monolith on autoscaling containers with scale-to-near-zero off-season keeps steady-state
> cost low while still absorbing [seasonal peaks]."

The compliance doc also correctly refused to over-engineer, quoting scale back at itself:
*"not microservices, since medium scale (≤50k users) and a 36-week Python/Postgres-only
team make a single well-bounded, audit-hardened service faster to build and easier to
certify."* This is reasoning, not recitation.

### The plan is genuinely handable to a coding agent

`crud`: 27 tasks, median 3h, min 1.5h, max 6h — small tasks, as the prompt demands.
`compliance`: 43 tasks, median 10h. Every task across all four docs has ≥2 acceptance
criteria (avg 2.9-3.1). Verbatim:

```
[T3] (database, 3h, deps=['T2']) Define Prisma schema for File, StaffMember, CheckoutRecord, Setting
  desc: Model all four entities per the architecture: File(id, caseName, barcode unique-when-active,
        status, createdAt), StaffMember(id, name, active), CheckoutRecord(id, fileId, staffName,
        checkoutAt, checkInAt nullable, note n…
  AC: schema.prisma includes all four models with specified fields and types
  AC: Foreign key relation between CheckoutRecord and File exists
  AC: Migration generated and applied successfully creating all tables
```

Dependency ordering is real (infra → schema → endpoints → frontend → QA), and only 1-2
tasks per plan have no prerequisites. I would hand these to a coding agent as-is.

### `assumptions[]` is honest about what the AI decided

`crud` volunteers the uncomfortable ones rather than hiding them:

> - "Data entities: File (id, caseName, barcode, status[in_cabinet|checked_out|archived], createdAt), StaffMember…"
> - "**No authentication/login system is implemented**; staff are selected from a fixed dropdown of names rather than logging in, per the non-technical constraint and small trusted team size."
> - "The /admin page **is access-controlled only by being an unlisted URL, not a real permission system**, given the 6-person trusted-office context."

Naming "your admin page is protected by obscurity" is exactly the disclosure this field
exists for. The `vague` brief — where the user skipped a clarifier — produced 12
assumptions, so the skipped-question path genuinely routes into disclosure.

---

## Regression checks on the two old Majors

Both verified by construction, not by reading the claim.
Probe: `scripts/qa-schema-probe.ts` (offline, 0 API calls) — **all 38 checks pass**.

### 1. Min-volume floors — genuinely un-parseable when breached

I built a valid document, breached one floor at a time, and confirmed each is rejected:

```
PASS  rejected: userStories < 5                      — issue at prd.userStories
PASS  rejected: functionalRequirements < 8           — issue at prd.functionalRequirements
PASS  rejected: nonFunctionalRequirements < 5        — issue at prd.nonFunctionalRequirements
PASS  rejected: goals < 3                            — issue at prd.goals
PASS  rejected: successMetrics < 3                   — issue at prd.successMetrics
PASS  rejected: risks < 3                            — issue at prd.risks
PASS  rejected: assumptions empty                    — issue at prd.assumptions
PASS  rejected: entities < 3                         — issue at architecture.dataModel.entities
PASS  rejected: entity with 0 fields                 — issue at architecture.dataModel.entities.0.fields
PASS  rejected: components < 3                       — issue at architecture.components
PASS  rejected: apiEndpoints < 5                     — issue at architecture.apiEndpoints
PASS  rejected: infrastructure.rationale empty       — issue at architecture.infrastructure.rationale
PASS  rejected: milestones < 3                       — issue at plan.milestones
PASS  rejected: plan tasks < 12 (the ORIGINAL Major) — issue at plan.milestones
```

The original bug is closed at the level that matters: I constructed the exact old shape
(3 milestones satisfying the milestone floor, but only 6 flattened tasks) and it **cannot
parse**. I then posted a thin document through the live route:

```
PASS  under-volume document is NOT returned (route self-validation) — 500 generation_failed
PASS  no document returned on under-volume
```

The route's self-validation is now structurally capable of catching a breach, which is
precisely what it could not do before. ✅ **Closed.**

### 2. Duplicate entities / fields / relationship endpoints — parse errors

```
PASS  rejected: duplicate entity name (exact)                          — Duplicate entity name "Bakery"
PASS  rejected: duplicate entity name (case-insensitive: Tenant/tenant) — Duplicate entity name "tenant"
PASS  rejected: duplicate entity name (trimmed: "Tenant "/"Tenant")     — Duplicate entity name "Tenant"
PASS  rejected: duplicate field within an entity (email/Email)          — Duplicate field "Email" on entity "Bakery"
PASS  rejected: relationship endpoint is not a declared entity          — Relationship to "Ghost" is not a declared entity
PASS  rejected: duplicate plan task id                                  — Duplicate plan task id "T-1"
PASS  rejected: self dependency                                         — Task "T-1" depends on itself
PASS  rejected: dangling dependsOn                                      — Task "T-1" depends on unknown task "NOPE"
PASS  rejected: criticalPath references unknown task                    — criticalPath references unknown task "GHOST"
```

Case-insensitivity and trimming both confirmed. ✅ **Closed.**

---

## Contract conformance

`scripts/qa-contract-probe.ts` drives the **real route handlers over the real pipeline**,
stubbing only `globalThis.fetch` to impersonate Anthropic. This exercises `client.ts`'s
actual error taxonomy rather than mocking the seam. Zero real API calls. **All 39 checks pass.**

### Error envelope + status for every code

| Condition | Expected | Result |
|---|---|---|
| malformed JSON | 400 `bad_request` | ✅ |
| invalid brief | 400 `validation_error` + `issues[]` | ✅ (5 issues, each `{path,message}`) |
| missing `ANTHROPIC_API_KEY` | 500 `llm_not_configured` | ✅ |
| upstream 401 | 500 `llm_not_configured` | ✅ |
| upstream 429 | 503 `llm_unavailable` | ✅ |
| upstream 5xx | 503 `llm_unavailable` | ✅ |
| network failure | 503 `llm_unavailable` | ✅ |
| no `tool_use` block (prose) | 500 `generation_failed` | ✅ |
| `stop_reason: max_tokens` | 500 `generation_failed` | ✅ |
| under-volume output | 500 `generation_failed` | ✅ |
| clarify: >3 questions | 500 `generation_failed` | ✅ |
| **clarify: empty `questions[]`** | **200 `{questions: []}`** | ✅ never 204/error |

Both routes map identically via `GENERATION_ERROR_CODE` / `ERROR_STATUS`.

### No secret leakage — the biggest new risk

I planted the key, a request id, an org id and an `x-api-key` header string in the
**upstream** error body and asserted none reach the client. Clean on **all 13** error paths:

```
PASS  no upstream/secret leak in llm_not_configured  — {"error":{"code":"llm_not_configured","message":"The PRD generator is not configured on this server."}}
PASS  no upstream/secret leak in llm_unavailable     — {"error":{"code":"llm_unavailable","message":"The AI service is temporarily unavailable. Please try again."}}
PASS  no upstream/secret leak in generation_failed   — {"error":{"code":"generation_failed","message":"PRD generation failed."}}
```

Confirmed live from the other side, too — the server log holds the detail the client never sees:

```
[api/prd/generate] generation failed Error [GenerationError]: Anthropic rejected the API key (HTTP 401).
  code: 'not_configured', stage: 'prd',
  [cause]: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},
             "request_id":"req_011CdPkiL77Pvw2YMq8yLtfq"}'
```
…while the browser received only `{"error":{"code":"llm_not_configured","message":"The PRD generator is not configured on this server."}}`.

Static and bundle audit:

```
key literal in .next/static (client bundle) ....... NONE ✓
'sk-ant' prefix in .next/static .................. NONE ✓
api.anthropic.com in .next/static ................ NONE ✓
ANTHROPIC_API_KEY string in .next/static ......... NONE ✓
server-only SYSTEM_PROMPT text in .next/static ... NONE ✓
grep -rn NEXT_PUBLIC src/ ........................ NONE ✓
key in any git-tracked file ...................... NONE ✓
.env* / .next tracked by git ..................... NEITHER ✓
```

**Client/server boundary:** nothing under `src/lib/prd/llm/` is imported by any client
component. The only importers of `@/lib/prd/generation` are the two route handlers and
`llm/` internals; both public entry points use `await import()` so the LLM graph never
enters a client chunk. Verified against all 17 `'use client'` files — none reach `llm/`.
(The key does appear in `.next/dev/cache/turbopack/*.sst`, a local dev cache that is
gitignored and never served. Not a finding.)

### Derived fields are genuinely derived

Mutation testing on the deriver, plus recomputation against all four real documents:

```
PASS  criticalPath follows the chain (6 chained tasks)              — ["C-1"..."C-6"]
PASS  mutating dependsOn changes criticalPath (broken at C-4)       — [C-1..C-6] -> [C-1,C-2,C-3]
PASS  extending dependsOn extends criticalPath                      — [C-1..C-6,W-1]
PASS  totalEstimateHours sums all tasks                             — 246
```

On the real documents `criticalPath` is a **genuine dependency chain** (each consecutive
pair satisfies "b dependsOn a") and `totalEstimateHours` recomputes exactly:

```
crud:        reported=80.5  recomputed=80.5  OK | chain=True | cp=31.5h  floor=1.05w  weeks=1.5 OK
marketplace: reported=312   recomputed=312   OK | chain=True
compliance:  reported=423   recomputed=423.0 OK | chain=True | cp=192h   floor=6.40w  weeks=6.5 OK
vague:       reported=226   recomputed=226.0 OK | chain=True | cp=98h    floor=3.27w  weeks=3.5 OK
```

**The old `teamSize` minor is fixed.** The critical-path floor holds at every team size —
a 240h chain never collapses below 8 weeks no matter how many people you add:

```
PASS  teamSize=1   — 8.5 weeks (floor 8)
PASS  teamSize=3   — 8 weeks   (floor 8)
PASS  teamSize=10  — 8 weeks   (floor 8)
PASS  teamSize=40  — 8 weeks   (floor 8)   ← the old bug reported ~1 week
PASS  teamSize=400 — 8 weeks   (floor 8)
```

### `diagramMermaid` is valid and renders

Adversarial component names (embedded quotes, brackets, pipes, braces, duplicate names,
`'!!!'`, empty string) all produce valid syntax with unique node ids:

```
PASS  mermaid starts with flowchart TD
PASS  no raw double quotes inside labels
PASS  no unescaped [ or ] inside a label body
PASS  all node ids unique — Web_App_beta,API_Gateway_v2,Postgres_Neon,Redis,Stripe,Stripe_2,node,node_2
PASS  every component got a node — 8/8
```

**Renders in a real browser** (the old renderer is unchanged, so this was the regression
risk). Architecture tab, HIPAA document — Mermaid's own DOM confirms a real flowchart:

```
mermaidSvgFound: true   ariaRole: "flowchart-v2"   nodeCount: 15   edgeCount: 15
svgWidth: 942   svgHeight: 200.8   errorText: null
```

Arrow *direction* for secondary clients is wrong — see MINOR-3.

### Other contract guarantees

- `brief` echoed back **verbatim** — byte-identical on all four live documents ✅
- `model` populated (`claude-sonnet-5`) ✅
- Every returned document parses `prdDocumentSchema` — all 4 real documents ✅
- Graph repair: dangling edge dropped, tasks kept, logged
  (`graph repair removed 1 edge(s): T-1->DOES-NOT-EXIST(unknown)`) ✅
- No dup ids / dangling deps / self deps in any real document ✅

---

## Browser QA

Production build (`npm run build` → `next start`), real Chromium.

| Check | Result |
|---|---|
| `/prd/new` step 1 — idea + context, 1280px | ✅ live char counter, inline validation, Continue gated on 30 chars |
| Draft autosave | ✅ `infragenie:brief-draft` written with idea + all 5 context answers |
| Draft resume after reload | ✅ Resume restored idea, scale, traffic, budget, timeline, constraints |
| **Clarifier — 0-question path** | ✅ skips straight to "Looks clear — ready to generate". No empty screen. |
| **Clarifier — N-question path** | ✅ 1 branching question returned (permission model), with `why` + 2 chips |
| Clarifier question quality | ✅ never asked the user to enumerate entities/fields/endpoints |
| **Clarify failure does NOT block generation** | ✅ 500 → unobtrusive note, Generate still available |
| Notes step → complete brief | ✅ |
| Generate — confirm gate | ✅ explicit "Generate my PRD & plan" step before any paid call |
| Staged progress | ✅ "Writing requirements…" → real heading changes, no dead spinner |
| **Double-submit impossible** | ✅ **5 clicks in one tick + 3 after re-render = exactly 1 request** |
| `llm_not_configured` (500) | ✅ honest "setup problem on our end", **no retry button** (correct dead end) |
| `llm_unavailable` (503) | ✅ "Try again" + "Your brief is safe"; retry re-sent the **identical brief**, zero retyping |
| `/prd` list | ✅ 4 real documents, AI-derived titles, dates |
| Document view — PRD tab | ✅ overview, goals, 9 stories with ACs, 14 FRs, 9 NFRs, risks, open questions, assumptions |
| Document view — Architecture tab | ✅ summary, 15 components, 12 entities w/ field tables, relationships, 19 endpoints, infra + rationale, Mermaid renders |
| Document view — Plan tab | ✅ 423h / 6.5 weeks / 3 milestones / 43 tasks, critical path highlighted |
| Markdown export | ✅ "Copy as Markdown" → "Copied"; "Download .md" present |
| Corrupt / non-JSON localStorage blob | ✅ filtered from list, clean "Document not found", no crash |
| Unknown document id | ✅ clean "Document not found" |
| 1280px layout | ✅ `scrollWidth == clientWidth`, zero overflowing elements |
| 375px layout | ✅ zero elements exceeding the viewport (tables/diagram/code blocks all contained) |
| **Console errors** | ✅ **zero** across the entire flow, every step |

### Markdown export fidelity

`scripts/qa-markdown-probe.ts` against all four real documents — **40/40 checks pass**:

```
crud:        44,105 chars / 535 lines — all 27 task ids, all entities, all 10 assumptions present
marketplace: 67,418 chars / 817 lines — all 40 task ids, all entities, all 12 assumptions present
compliance:  72,912 chars / 860 lines — all 43 task ids, all entities, all 12 assumptions present
vague:       58,696 chars / 791 lines — all 38 task ids, all entities, all 12 assumptions present
```

Every document: title, brief echoed, ```` ```mermaid ```` fence with `flowchart TD` body,
infra rationale, totals rendered, and **no** `undefined` / `[object Object]` /
unresolved `{{` markers.

---

## Cost safety audit

✅ **Our Anthropic key is the only paid dependency.**

- `grep` for outbound hosts in `src/`: only `api.anthropic.com`. No other external host.
- No deploy/provision code paths (`api.vercel`, `createDeployment`, provisioning) anywhere.
- No resources created, no accounts, no databases, no domains. Nothing billable outside the key.

✅ **`npm test` is fully offline — proven, not assumed.** I ran the suite under a network
guard that throws on any non-localhost `fetch` and on raw `http(s).request`:

```bash
NODE_OPTIONS="--import file:///tmp/net-guard.mjs" npx vitest run
→ Test Files 12 passed (12) · Tests 207 passed (207) · Duration 4.97s
```

Zero guard trips. `ANTHROPIC_API_KEY` is not even set in the test shell. A test run costs $0.

✅ **Generation is not gratuitously expensive.** Measured from real usage logs:

| brief | input tok | output tok | est. cost |
|---|---|---|---|
| crud | 13,797 | 16,624 | $0.291 |
| vague | 16,610 | 25,906 | $0.438 |
| compliance | 17,951 | 25,518 | $0.437 |
| marketplace | 15,210 | 24,726 | $0.417 |

**~$0.53 per successful document.** Reasonable for the output volume.

- **No retry storm.** Every live stage logged `attempt=0` — 12 stages across 4 briefs, zero
  mechanical retries. Retry bounds verified: persistent 429 = 3 calls max (1 + 2 backoff);
  `no tool_use` and `max_tokens` are terminal at **1** call; under-volume gets **exactly 1**
  extend-retry. No unbounded loop anywhere.
- **`max_tokens: 16000` ×3 is justified, not absurd.** An 8k ceiling was observed to
  truncate real enterprise output into `invalid_output`, which costs a whole generation.
  Clarify is correctly capped at 1024, title at 100.
- **Brief re-send across the 3 stages is by design and cheap.** The brief is ~500-900
  input tokens against 3-8k stage inputs — a small fraction, and each stage genuinely
  needs full context. Not worth optimising.
- **Double-submit guard is the real cost protection and it holds** (5 same-tick clicks → 1 request).

⛔ Nothing in this review required a paid action beyond our own key. No approval needed.

---

## What I did not test

- **Real deploys / provisioned resources** — out of scope by the cost-safety rule.
- **Long-run reliability of the MAJOR-1 failure rate.** I observed 1 in 5 live plan-stage
  runs; a proper rate estimate would need a sweep, which is not worth the spend. Two
  independent sightings across two stages is sufficient to route it.
- **Cross-browser** — Chromium only.
- **`ANTHROPIC_MODEL` / `ANTHROPIC_CLARIFY_MODEL` overrides at the route level** — covered
  by unit tests; I verified the defaults live.

## Reviewer probes added

All offline and free unless noted:

| Script | What it proves | API calls |
|---|---|---|
| `scripts/qa-schema-probe.ts` | both old Majors closed; derived fields; mermaid safety (38 checks) | 0 |
| `scripts/qa-contract-probe.ts` | every error code/status, leak suppression, retry bounds (39 checks) | 0 |
| `scripts/qa-stringified-array-probe.ts` | **MAJOR-1 repro, deterministic** | 0 |
| `scripts/qa-markdown-probe.ts` | export fidelity on real documents (40 checks) | 0 |
| `scripts/qa-live-generate.ts` | 4 adversarial briefs end to end | ~16 (real) |
