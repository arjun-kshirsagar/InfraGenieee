# Feature 2 (Deployment cost predictor) — adversarial review + live browser QA

**Reviewer:** `reviewer` agent · **Task:** `t_c918b224` · **Date:** 2026-07-26
**Reviewed:** `main` @ `6af2a21` · **Pipeline:** `PRICING_PIPELINE_VERSION=1.0.0` · **Models:** `claude-sonnet-5` (recommend), `claude-haiku-4-5` (extractor)

Scope: the complete Feature 2 stack — catalog, price pipeline + evidence gate, engine,
`/api/cost/{catalog,prices,estimate,recommend}`, and the `/cost` explorer / comparison /
charts UI. Everything below was exercised against the **running app with real keys and
real vendor fetches**, not read off the source.

---

## Verdict

### 🛑 DO NOT SHIP — 4 Blockers, 3 Majors

The architecture is right and the honesty machinery is genuinely good. The evidence gate
works: I attacked it and **could not get a fabricated price through it**. Citations are
real, verbatim, and clickable. Live interactivity is exactly as designed — I changed
sliders, units, toggles and tabs and counted **zero** network requests. No secret reaches
the client. The four UI states all render human copy.

But the feature's own headline promise — *"never show an invented number"* — is broken in
a way the evidence gate cannot catch, because the fabrication happens **after** the gate.
Every fetched price is correctly cited *and then multiplied by the wrong quantity*. The
gate proves `$0.0075 / 10,000 requests` is really on Google's page; the engine then bills
`5,000,000 × $0.0075 = $37,500` instead of `$3.75`. The number on screen is 10,000× wrong
while carrying a truthful-looking citation, which is worse than no citation at all.

Live, in a real browser, with a real PRD:

- **Google Cloud reads `$1,239,648/mo`** for a startup-band IoT app whose honest cost is
  roughly $200–300/mo.
- **Vercel read `$21,903,101/mo`** in the same session.
- **Microsoft Azure reads `at least $0.00/mo`**, sorts to the **front** of the
  side-by-side, wins **Best scaling + Simplest**, and draws **no bar at all** in the
  money-shot chart — the exact "zero reads as free" misreading the docs promise to
  prevent, in the one place a user looks first.
- **`POST /api/cost/recommend` returns HTTP 500 on every single live call** I made (7/7).
  The AI recommendation stage — a whole parent task — never succeeds in production.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `npm run lint` | ✅ 0 errors (2 pre-existing warnings in Feature-1 files) |
| `npm test` | ✅ **642 passed, 5 skipped** across 40 files, 15.4s, fully offline |
| `npm run build` | ✅ exit 0 — 12 routes, all 4 `/api/cost/*` correctly `ƒ` dynamic |
| LIVE smoke tests | ✅ both genuinely ran (real fetches, real Anthropic) — **not skipped** |
| Secret leakage | ✅ no key fragment in `.next/static/**`; no client import of pricing internals |
| Evidence gate (attacked) | ✅ could not be broken |
| Live interactivity | ✅ 0 network requests across ~15 interactions |
| **Cost arithmetic** | ❌ **wrong by 10³–10⁶× on 42 dimensions** |
| **`cheapest` / badge honesty** | ❌ Azure `$0.00` crowned Best-scaling + Simplest |
| **`POST /api/cost/recommend`** | ❌ 500 on 7/7 live calls |

---

## Price spot-check — 19 SKUs across 4 providers

Every `unitPriceUsd` was compared against the vendor page named in its own `source.url`,
which I fetched independently. **The fetched unit prices are correct.** The failure is in
what the engine does with them (BLOCKER-1/2), not in the fetch.

| SKU · dimension | Our `unitPriceUsd` | Vendor page value | Source URL | Match? |
|---|---|---|---|---|
| `aws:ec2:t3-small` · instance-hour | `0.0208` | `$0.0208`/hr, t3.small, US East (N. Virginia) — Price List feed, agrees with the human page | aws.amazon.com/ec2/pricing/ | ✅ |
| `aws:sqs:standard` · requests | `4e-07` | `$0.40 per million` = `$0.0000004`/req | aws.amazon.com/sqs/ | ✅ |
| `gcp:compute-engine:e2-small` · instance-hour | `0.016752855` | `$0.016752855 / 1 hour` | .../compute/pricing/general-purpose | ✅ |
| `gcp:cloud-run:1vcpu-1gib` · requests | `0.4` | `Requests (per 1,000,000) … $0.40` | cloud.google.com/run/pricing | ✅ price / ❌ unit |
| `gcp:cloud-sql:ent-1vcpu-3.75gb` · vcpu-hour | `0.0413` | `$0.0413 / 1 hour` | cloud.google.com/sql/pricing | ✅ |
| `gcp:cloud-sql:*` · storage-gib-**month** | `0.000232877` | `$0.000232877 / 1 gibibyte **hour**` | cloud.google.com/sql/pricing | ✅ price / ❌ unit |
| `gcp:memorystore:basic-m1` · capacity-gib-hour | `0.049` | `$0.049 / 1 gibibyte hour` | .../memorystore/docs/redis/pricing | ✅ |
| `gcp:cloud-cdn:standard` · egress-gib | `0.08` | `North America … $0.08 / 1 gibibyte` | cloud.google.com/cdn/pricing | ✅ |
| `gcp:cloud-cdn:standard` · cache-lookups | `0.0075` | `$0.0075 / 10,000 count` | cloud.google.com/cdn/pricing | ✅ price / ❌ unit |
| `gcp:cloud-storage:standard` · storage-gib-hour | `2.7397e-05` | `$0.000027397 / 1 gibibyte hour` | cloud.google.com/storage/pricing | ✅ |
| `gcp:managed-kafka:3dcu` · compute-hour | `0.09` | `$0.09 / 1 hour` | .../managed-service-for-apache-kafka/pricing | ✅ |
| `gcp:egress:internet` · egress-gib | `0.12` (incl `1`) | `1 GiB → 1,024 GiB $0.12 / 1 gibibyte`, first 1 GiB free | cloud.google.com/vpc/network-pricing | ✅ |
| `vercel:fluid-compute:pro` · plan-fee | `20` | `Pro $20/mo.` | vercel.com/pricing | ✅ |
| `vercel:static:edge` · data-transfer-gb | `0.15` | `Fast Data Transfer … $0.15 per 1 GB` | vercel.com/docs/pricing/networking | ✅ |
| `vercel:edge-network:standard` · edge-requests | `2` | `Edge Requests … $2.00 per 1,000,000 Requests` | vercel.com/docs/pricing/networking | ✅ price / ❌ unit |
| `vercel:blob:standard` · storage-gb-month | `0.023` | `Blob Storage Size … $0.023 per GB` | .../vercel-blob/usage-and-pricing | ✅ |
| `digitalocean:droplet:basic-1gb` · droplet-hour | `0.00893` | `1 GiB \| 1 vCPU \| 1,000 GiB \| 25 GiB \| $0.00893 \| $6.00` | digitalocean.com/pricing/droplets | ✅ |
| `digitalocean:managed-postgres:2gb` · node-hour | `0.04531` | `2 GiB \| 1 vCPU \| … \| $0.04531 \| $30.45` | .../pricing/managed-databases | ✅ |
| `digitalocean:managed-valkey:1gb` · node-hour | `0.02232` | `1 GiB \| 1 vCPU \| 10 GiB \| $0.02232 \| $15.00` | .../pricing/managed-databases | ✅ |
| `digitalocean:spaces:standard` · storage-gib-month | `0.02` | `$0.02/GiB additional storage` | .../pricing/spaces-object-storage | ✅ |

**19/19 unit prices match their cited page. 4 of them are then applied with the wrong
unit scale.** The `⚠ ✅ price / ❌ unit` rows are the BLOCKER-1 class caught in the act:
the number is real, the arithmetic that consumes it is not.

### Attacking the evidence gate — it held

I tried the three attacks the docs invite:

1. **A price with no citation.** Structurally impossible: `priceRecordSchema.source` is
   non-optional and `priceSourceSchema.evidence` is `min(3)`. No path to a `PriceRecord`
   without evidence.
2. **Evidence that doesn't contain the number.** Rejected — and there is a real
   counterexample test (`evidence.test.ts:44` `🔴 REJECTS a fabricated price`), plus
   token-boundary tests proving `0.032` is not satisfied by `0.32` and `6` is not
   satisfied by the `000` inside `1,000`. This is the mandatory test docs §5 demands, and
   it is genuinely present.
3. **Evidence not on the page.** Rejected by the whitespace-collapsed substring check.

I audited all 79 live records: **every one has a non-empty `evidence`, a real `url`, a
`fetchedAt`, and an `extractorModel`.** I spot-verified 19 evidence strings against the
independently-fetched page text; all were genuine verbatim excerpts. Two are *weak but
honest* (see MINOR-2). **The anti-fabrication invariant is intact. Ship the gate; it works.**

---

## BLOCKERS

### BLOCKER-1 — Bulk-priced dimensions are billed per-item: totals wrong by 1,000× to 1,000,000×

**Route to:** `backend` · **Files:** `src/lib/cost/estimate/engine.ts:149-150`,
`src/lib/cost/estimate/quantities.ts:97-154`, `src/types/cost.ts:300-311`

The engine's only arithmetic is `billable × unitPriceUsd` (`engine.ts:149-150`).
`deriveQuantities` emits quantities in **single items** (requests, ops, events). But many
vendors quote a price **per N items**, and `priceDimension` has no notion of that scale:
`priceDimensionSchema.unit` is explicitly *"Display-only"* (`cost.ts:310`), so
`USD / 10,000 requests` is a string the engine never reads.

**Live reproduction** (`POST /api/cost/estimate`, GCP Cloud Run, 10M requests):

```
dim requests  USD / million requests  qty 10000000  incl 0  unitPrice 0.4  =>  4000000
```

`$4,000,000/mo` for 10M Cloud Run requests. Google's own page: `Requests (per 1,000,000)
… $0.40` → 10M requests = **$4.00**. Overstated **1,000,000×**.

Same call, Vercel edge requests at 5M (`$2.00 per 1,000,000`):

```
edge-requests  USD / million requests  q=5e+06  incl=0  p=2  => 10000000
```

`$10,000,000` where the honest answer is **$10.00**.

**42 dimensions carry a bulk unit; 11 are currently priced and therefore actively wrong.**
Full audit (dimension `unit` vs the item-scale quantity its `quantityKey` produces):

| SKU · dimension | unit | billed at | should be | factor |
|---|---|---|---|---|
| `gcp:cloud-run:*` · requests | USD / million requests | $4,000,000 | $4.00 | 10⁶ |
| `vercel:edge-network:standard` · edge-requests | USD / million requests | $10,000,000 | $10.00 | 10⁶ |
| `vercel:static:edge` · edge-requests | USD / million requests | — | — | 10⁶ |
| `vercel:blob:standard` · advanced-ops | USD / million operations | $500,000 | $0.50 | 10⁶ |
| `vercel:blob:standard` · simple-ops | USD / million operations | $400,000 | $0.40 | 10⁶ |
| `aws:sqs:standard` · requests | USD / million requests | — | — | 10⁶ |
| `gcp:firestore:native` · reads / writes | USD / 100,000 documents | — | — | 10⁵ |
| `gcp:cloud-cdn:standard` · cache-lookups | USD / 10,000 requests | $37,500 | $3.75 | 10⁴ |
| `gcp:cloud-storage:standard` · class-a-ops | USD / 1,000 operations | $500 | $0.50 | 10³ |
| `gcp:cloud-storage:standard` · class-b-ops | USD / 1,000 operations | $400 | $0.40 | 10³ |
| `gcp:pubsub:standard` · throughput-tib | USD / TiB (incl 10 **GiB**) | — | — | unit mismatch |

Plus 31 unpriced dimensions with the same defect latent — they will produce wrong numbers
the moment their fetch starts succeeding (`aws:lambda:*` requests, `aws:s3:standard`
put/get-requests, `aws:cloudfront:payg` https-requests, `aws:dynamodb:on-demand` RRU/WRU,
`azure:*` executions/operations/events/ops/requests, `gcp:cloud-run-functions:*` requests,
`gcp:gcs-cdn:standard` cdn-lookups, `vercel:*` invocations).

This is the most dangerous class of bug in the feature, because the wrong number arrives
**wearing a valid citation**. The evidence gate certifies `$0.0075 / 10,000 count` is
really on Google's page, and the UI then shows `$37,500` next to a "Source" popover that
proves the rate. A user who clicks through to check finds the rate is right and concludes
the total is right.

**Fix direction (architect sign-off needed — this changes the contract):** make the scale
machine-readable. Add e.g. `pricePerUnits: z.number().positive().default(1)` to
`priceDimensionSchema`, set it per dimension in the catalog, and change the engine to
`monthly = billable / pricePerUnits × unitPriceUsd`. Not a per-provider special case —
one field, one multiplication, in the one place arithmetic lives. `catalog.test.ts`
should then assert every dimension whose `unit` matches `/per|\/\s*(million|[\d,]+)/`
declares a non-default `pricePerUnits`, so this class can't regress in silence.

---

### BLOCKER-2 — Per-hour rates billed as per-month: storage and cache understated 730×

**Route to:** `backend` · **Files:** `src/lib/cost/estimate/quantities.ts:117-151`, catalog GCP entries

The mirror image of BLOCKER-1. Several GCP dimensions are priced **per GiB-hour** but
their `quantityKey` yields a **GiB-month** quantity, and the engine never multiplies by
`HOURS_PER_MONTH`.

**Live reproduction** (GCP, 500 GiB object storage, 4 GiB cache):

```
object-storage  storage-gib-hour  [USD / GiB-hour]  q=500  p=2.7397e-05  => 0.0137
cache-redis     capacity-gib-hour [USD / GiB-hour]  q=4    p=0.049       => 0.196
```

- Cloud Storage 500 GiB: shown **$0.01/mo**. Correct: `500 × 0.000027397 × 730` = **$10.00/mo**.
- Memorystore 4 GiB: shown **$0.20/mo**. Correct: `4 × 0.049 × 730` = **$143.08/mo** — a
  715× *understatement* on a line a user would budget against.

Affected (all live-verified): `gcp:cloud-storage:standard` · storage-gib-hour,
`gcp:memorystore:{basic-m1,standard-m1,standard-m2}` · capacity-gib-hour,
`gcp:managed-kafka:{3dcu,6dcu}` · storage-gib-hour, `gcp:cloud-sql:*` ·
storage-gib-month (page says `/ 1 gibibyte hour`, key is `dbStorageGbMonth` → 100 GiB
billed as **$0.02/mo** instead of **$17.00/mo**), `gcp:gcs-cdn:standard` · storage-gib-hour.

Understatement is the worse direction for trust: the docs commit to erring high
("over-estimating slightly at high volume is the honest direction to err", §7), and this
does the opposite on the exact lines a cost-conscious user checks.

---

### BLOCKER-3 — Azure renders `$0.00/mo`, sorts first, and wins two badges, because a 600-char cap silently voids its whole price book

**Route to:** `backend` · **Files:** `src/types/cost.ts:495`, `src/lib/cost/pricing/build.ts`, `src/app/api/cost/prices/route.ts:108-120`

Live, in Chromium, with a real PRD and a freshly-built cache, the Azure tab reads:

```
Microsoft Azure   East US   ≥ $0.00      [Best scaling] [Simplest]
```

and in the "Side by side" comparison Azure is the **left-most / first** card, at
**`at least $0.00/mo`**, carrying both editorial badges. In "Monthly cost by provider"
Azure has **no bar at all** — a zero-height bar, which `chart-data.ts:7-15` names as
"the one misreading we cannot ship".

Server log, root cause:

```
[api/cost/prices] price book failed for provider "azure" Error [PricingError]:
Assembled price book for "azure" failed schema validation:
records.0.source.evidence: Too big: expected string to have <=600 characters;
records.1 … records.7  (all 8 records)
  provider: 'azure'
```

Azure's structured feed **worked** — it returned 8 real, evidence-backed prices. But
`priceSourceSchema.evidence` is capped at `max(600)` (`cost.ts:495`) and a serialised
Azure retail-feed record exceeds that, so **every** record fails, the whole book throws,
and `/api/cost/prices` omits Azure entirely (`route.ts:108-120` logs and drops it).
`GET /api/cost/prices` returned books for only `['aws','gcp','vercel','digitalocean']`.

Two independent defects behind one symptom:

1. **The cap voids valid data.** Docs §5 says feed `evidence` *is* "the serialised matched
   record" — so the cap is set below what the design requires. Raise it for feed-sourced
   evidence, or store a bounded excerpt around the matched value.
2. **One bad record kills the book (fail-closed at the wrong granularity).** Docs §6
   promises books are per-provider "so one failing vendor cannot invalidate the other
   four" — but *within* a provider, one over-long evidence string invalidates all 8 good
   records. A record failing validation should become a `PriceGap`, exactly like an
   evidence-gate rejection, not take the book down.

**The badge bug is separate and must be fixed even after the cap is raised.** `compare()`
correctly excludes incomplete estimates from `cheapest` (`engine.ts:421-425`) — that part
works, `cheapest` was `null`. But `bestScaling` / `simplest` are computed over **all**
estimates (`engine.ts:426-431`) with no completeness filter, so a provider whose price
book is 100% missing wins both. Docs §8 is explicit: editorial scores "are **not**
permitted to stand in for a missing price". And `buildComparisonRows`
(`comparison.ts:126-135`) sorts runnable-and-incomplete purely by `monthlyUsd`, so a
`$0.00` floor sorts ahead of every real estimate — presenting the least-known provider as
the most attractive.

**Repro:** delete `.cache/pricing/azure.json`, `GET /api/cost/prices`, open
`/cost?prd=<id>`, scroll to "Compare all providers".

---

### BLOCKER-4 — `POST /api/cost/recommend` fails on every live call (7/7): the AI recommendation never works in the product

**Route to:** `backend` · **Files:** `src/lib/cost/llm/recommend.ts:386` (`MAX_OUTPUT_TOKENS`), `:389-420` (permissive schema / `coerceDraft`)

Every live call I made to the deployed endpoint returned **HTTP 500**. Two distinct
failure modes, both reproducible, both deterministic per input size:

**Mode A — output truncated at `max_tokens` (large PRD, 3/3 calls):**

```
[prd.llm] model=claude-sonnet-5 stage=emit_cost_recommendation input_tokens=9836 output_tokens=4096 latency_ms=34030 attempt=0
[api/cost/recommend] recommendation failed Error [PricingError]: Cost recommendation failed:
  Output truncated at max_tokens (4096); the structured JSON is incomplete.
  Raise maxTokens for this stage or reduce what it must emit.
  code: 'invalid_output'
```

`MAX_OUTPUT_TOKENS = 4096` (`recommend.ts:386`) is simply too small: a
5-provider recommendation with rationale, 5 assumptions, 5 selections and 5 trade-offs
(3 pros + 3 cons each) does not fit. The comment claims "a few KB of JSON" — the model
hits the ceiling exactly at 4096 every time. Note the retry does **not** help: truncation
is deterministic for a given input, so all 3 bounded attempts truncate identically and
burn 3 paid calls (~100s) before failing.

**Mode B — serialisation drift survives all 3 attempts (small PRD, 4/4 calls):**

```
[cost.recommend] retrying after invalid_output (serialisation drift), attempt=1
[cost.recommend] retrying after invalid_output (serialisation drift), attempt=2
[api/cost/recommend] recommendation failed Error [PricingError]: Model recommendation failed schema validation:
  assumptions.0: Too big: expected string to have <=300 characters;
  selections: Invalid input: expected array, received string;
  selections: Too big: expected string to have <=5 characters;
  tradeoffs: Invalid input: expected array, received string;
  tradeoffs: Too big: expected string to have <=5 characters
```

Two separate problems here: (a) `assumptions[]` entries exceed the 300-char cap and
`coerceDraft` truncates nothing, and (b) `selections`/`tradeoffs` arrive as JSON strings
that `coerceDraft` fails to decode in this shape. 87 seconds and 3 paid Anthropic calls
per request, then 500.

**Notably the live smoke test PASSES** (`recommend.live.test.ts`, run with real keys:
1 passed, 63.9s, retried once then succeeded). So this is not "the model is broken" — it
is that the production request builds a larger prompt than the test's, and the failure
mode the test tolerates via retry becomes deterministic at production size. **This is the
Feature-1 lesson repeating in a new costume:** a green test on a smaller input hid a
100%-failure path on the real one.

**Impact is partly mitigated and that mitigation is good work:** `fetchRecommendation`
degrades to `kind: 'fallback'` with a catalog-default seed
(`client.ts:389-431`), and the UI shows a dismissible notice —
*"The AI didn't produce a usable recommendation… start from the defaults"* — with a
**Retry AI seed** button. I verified this live: the explorer mounted fine and stayed
fully usable. So it is not a dead page. But parent task `t_6c79a039` shipped this
endpoint as working, and in the product it never works: users always get the neutral
seed, and every page load burns 3 sonnet calls (~35–90s) to produce nothing.

---

## MAJORS

### MAJOR-1 — `includedQuantity` is fetched but not unit-normalised, so a real free tier is applied in the wrong unit

**Route to:** `backend` · **File:** catalog GCP/DO entries + `engine.ts:149`

Docs §7 insists `includedQuantity` must be *fetched* — and it genuinely is; I verified all
4 non-zero allowances trace to real page text. But the fetched number keeps the **page's**
unit while the engine subtracts it from a quantity in a **different** unit:

| record | `includedQuantity` | evidence (verbatim, real) | problem |
|---|---|---|---|
| `gcp:pubsub:standard` · throughput-tib | `10` | *"the first 10 **GiB** of throughput … is free"* | 10 **GiB** subtracted from a **TiB** quantity → 1024× too generous |
| `digitalocean:app-platform-static:starter` · site-month | `3` | *"3 apps with static sites"* | 3 **apps** subtracted from a **months** quantity (always 1) → free forever |
| `digitalocean:functions:standard` · gib-second | `90000` | *"$0.0000185 per GiB-seconds for additional…"* | 90,000 is from a different sentence than the cited excerpt |
| `gcp:egress:internet` · egress-gib | `1` | *"0 gibibyte to 1 gibibyte $0.00 (Free)"* | ✅ correct |

Whichever direction the error runs, a mis-united allowance is exactly the "fabricated
discount" §7 forbids — it just launders the fabrication through a real number.

### MAJOR-2 — AWS is 8% priced (4/53 dimensions) with a self-defeating gap reason, so the biggest provider is a wall of floors

**Route to:** `backend` · **File:** `src/lib/cost/pricing/feeds/descriptors.ts`

Live `GET /api/cost/prices` coverage, freshly built:

| provider | dimensions | priced | gaps | coverage |
|---|---|---|---|---|
| aws | 53 | 4 | 49 | **8%** |
| gcp | 51 | 46 | 5 | 90% |
| vercel | 15 | 11 | 4 | 73% |
| digitalocean | 19 | 18 | 1 | 95% |
| azure | 33 | 0 | 33 | **0%** (BLOCKER-3) |
| **total** | **171** | **79** | | **46%** |

49 of AWS's 53 gaps carry `detail: "no verified price-feed descriptor is wired for this
dimension yet"` — i.e. not a fetch failure, just unwired. AWS has **zero** priced
dimensions for `db-relational`, `cache-redis`, `object-storage`, `cdn`, `egress`,
`queue-kafka`, `static-hosting`, `compute-serverless`, `compute-worker`, `db-nosql`,
`search`. The result on screen: AWS totals `≥ $15.18/mo` for the whole ColdWatch stack —
EC2 only, with eight `≥ $0.00` floor lines. Technically honest, practically useless, and
it makes AWS look 10× cheaper than it is at a glance.

This is *disclosed* (floors, gap counts, "at least") rather than hidden, which is why it's
a Major and not a Blocker. But "compare deployment costs across vendors" with the largest
vendor at 8% coverage is not a shippable comparison.

### MAJOR-3 — `bestScaling` / `simplest` have no completeness filter

**Route to:** `backend` · **File:** `src/lib/cost/estimate/engine.ts:426-431`

Called out inside BLOCKER-3 but it is an independent one-line defect worth its own fix:
`argmax` runs over `estimates` unfiltered, so an estimate that is 100% unpriced can win
both editorial badges — which is how a `$0.00` Azure ended up labelled the best-scaling,
simplest choice. Contradicts docs §8 directly. `cheapest` already does this correctly
(`engine.ts:421-425`); apply the same filter, or at minimum exclude estimates with no
priced records at all.

---

## MINORS

### MINOR-1 — `formatUsd(0)` on an unpriced provider prints `$0.00` in the headline and export

`monthly-total.tsx` / `export-md.ts:53` render `≥ $0.00` when an estimate has no priced
records. The `≥` and the amber "floor" note do real work, and the export is careful
(*"unpriced — no verified price (not free)"* per line). But the headline number a user
reads and screenshots is still `$0.00`. When an estimate has **zero** priced records
there is no floor to state — the honest render is "not priced" with no dollar figure at
all. Same for the chart: prefer omitting the bar with an explicit "couldn't price"
marker over a zero-height rectangle.

### MINOR-2 — Two evidence strings are technically valid but weak

`digitalocean:app-platform:basic-{512mb,1gb}` cite a table row whose visible text is
`| Shared (Fixed) … | 1 vCPU | 512 MiB | 50 GiB | No | [$5.00](…) |`. The `$5.00` is
inside a markdown **link target**, so the gate passes on a number a human reading the
rendered page sees in a button, not a price cell. Correct value (I checked the page), but
the evidence is one page-restructure away from silently matching the wrong thing. Prefer
stripping markdown link syntax before the substring test, or require the number to appear
outside `[...](...)`.

### MINOR-3 — `kafkaStorageGbMonth` reuses the NoSQL storage field

`quantities.ts:134`: `kafkaStorageGbMonth: usage.nosqlStorageGb` with a candid comment
("profile has no dedicated field, reuse the nosql storage seed as the closest driver").
The honesty is appreciated but the consequence is invisible to the user: on a
Kafka-and-NoSQL PRD, dialling NoSQL storage silently moves the Kafka bill. Either add a
`kafkaStorageGb` field or surface the coupling in the UI.

### MINOR-4 — `avgResponseKb` is required with no default, so a hand-built estimate request 400s

`POST /api/cost/estimate` rejects a body missing `usage.avgResponseKb`
(`cost.ts:590`, no `.default()`), while nearly every other numeric driver has an obvious
zero-ish default. The UI always sends it, so this only bites the documented
"shareable links / tests" use case the route exists for. A `.default()` would make the
endpoint usable by hand.

### NIT-1 — `formatUnitPrice` shows 8 significant digits in the breakdown

`730 × $0.016752855` is correct and auditable, but `$0.0168` with the full precision in
the citation popover would read better. Deliberate trade-off; noting it only because the
breakdown is the "check our maths" surface.

---

## What I verified working (evidence)

**Live interactivity — zero network requests.** I patched `window.fetch` and
`XMLHttpRequest.prototype.open` to log every call, then drove the UI: typed
`monthlyRequests` 3,000,000 → 9,000,000, stepped compute units 1 → 2 (total `$15.18` →
`$30.37`), toggled Kafka off (row stayed visible, dimmed, "Turned off" badge), switched
tabs AWS ↔ GCP ↔ Azure, and set CDN egress 10,000 → 2,000 (GCP CDN line `$36,800` →
`$36,160`, total `$39,648` → `$39,008`). **`window.__qaFetches.length === 0` throughout.**
Totals updated on every interaction. This is exactly the design intent and it is correctly
implemented.

**Secret safety — clean.** Grepped `.next/static/**` for a 14-char prefix and 12-char
suffix of the real `ANTHROPIC_API_KEY`, the same for `TAVILY_API_KEY`, plus `sk-ant`,
`tvly-`, and the literal env-var names: **0 files**. No client component imports
`src/lib/cost/pricing/**` or `pricing-seam.ts` — the only importers are the three server
routes and `recommend.ts` (server-only). `client.ts` imports only `@/types/cost`,
`@/lib/cost/catalog` and `@/lib/cost/estimate`, exactly as its header claims.

**Citation popover — real and verbatim.** Opened on GCP Compute Engine:

```
WHERE THIS PRICE COMES FROM
https://cloud.google.com/products/compute/pricing/general-purpose
FETCHED   Jul 26, 2026 · 2 hours ago
EVIDENCE (VERBATIM FROM THE PAGE)
| e2-small | 2 | 2 GiB | $0.016752855 / 1 hour |
```

I independently fetched that page: the row is present, exactly as quoted. The breakdown
below it shows `730 × $0.016752855 = $12.23` — auditable to the cent.

**Both live smoke tests genuinely ran** (not silently skipped), invoked deliberately with
inline env vars per the task rules:

```
✓ recommend.live.test.ts  (real Anthropic, sonnet-5, 63.9s, 1 retry then success)
✓ build.live.test.ts      (real Tavily + haiku: records=18 gaps=1 region=nyc3)
Test Files  2 passed (2)   Duration 84.99s
```

`npm test` stays offline and fast (15.4s) — the live files skip without keys, and I did
**not** `source .env.local`.

**Error states — human, retryable, no stack traces.**
- `pricing_unavailable` (forced 503): *"We couldn't load the cost data … We couldn't
  fetch live prices from the cloud providers just now. This is usually temporary — try
  again in a moment."* with **Try again** + **Choose a different PRD**.
- `llm_not_configured`: with `ANTHROPIC_API_KEY` unset the endpoint returned
  `500 llm_not_configured` (matches the contract table, `api.ts:45`) and the UI degraded
  to the catalog-default seed with a **Retry AI seed** button. No key name, no upstream
  text, no stack trace leaked to the client.
- With **no keys and no cache**, `GET /api/cost/prices` correctly returned **200 with
  `gaps[]`** (`detail: "TAVILY_API_KEY is not set in the server environment."`) rather
  than 503 — a partial failure is not a total one, exactly as docs §5 / the contract say.

**Responsive + console.** 375 / 768 / 1440 all render with **no horizontal overflow**
(`document.scrollWidth === window.innerWidth` at each) and **zero JS page errors**. Mobile
375 stacks the provider tabs into a readable list and keeps the headline legible. The only
console error anywhere is the `500` from `/api/cost/recommend` (BLOCKER-4). Keyboard: all
selectors are real `<Select>`/`<Checkbox>`/`<input type=number>` with `aria-label`s and
Tab reaches them; the units stepper correctly disables at the 1/200 bounds.

**Region + staleness + gaps are surfaced.** Each tab shows its priced region
("US East (N. Virginia)", "Iowa (us-central1)", …), the caveats block reports
*"All prices were fetched within the last 7 days"* and flags per-provider staleness off
`PRICE_MAX_AGE_DAYS`, and gap counts are shown per provider (AWS 49, Azure 33, GCP 12,
DO 3, Vercel 4).

**Kafka-heavy PRD handled end to end.** The ColdWatch PRD (Kafka + Postgres + Redis +
object storage + CDN + egress) mapped to 9 roles and the predictor handled all of them.
**Vercel correctly refused to look cheap**: `unsupportedRoles: [db-relational,
cache-redis, queue-kafka]`, tab badged **"Cannot run this app"**, excluded from `cheapest`,
sorted to the bottom, and the export says *"**cannot run this app** (missing: Relational
database, Cache (Redis), Kafka / event streaming)"*. DigitalOcean likewise for
`queue-kafka`. Per-role "not available on this provider … This is a gap, **not** a $0
saving" renders as a destructive-styled warning row. **This mechanism is correct and is
the best part of the feature.**

---

## NOT VERIFIED — honest gaps in this review

1. **Azure prices were never spot-checked against a vendor page**, because no Azure price
   ever reaches the app (BLOCKER-3). The 8 records the feed produced were destroyed by the
   600-char cap before I could see their values. Azure price *correctness* is unverified —
   only that the feed returns 8 evidence-backed records.
2. **AWS: only 2 of 53 dimensions spot-checked** (EC2 t3.small, SQS). The other 2 priced
   records are EC2 sizes from the same feed row-set. 49 dimensions are unpriced, so there
   was nothing to check.
3. **I did not verify the AWS/Azure structured-feed parsers against a live feed response**
   — the feed tests use checked-in fixtures, and the one live pricing smoke test covers
   DigitalOcean (Tavily) only. There is **no live smoke test for the AWS Price List or
   Azure retail feed**, which is precisely where BLOCKER-3 was hiding. I recommend adding
   one; a green fixture test did not catch a 100% real-world failure.
4. **Tiered pricing is flattened to the first paid tier** (a declared v1 limitation, docs
   §7). I confirmed the flattening happens but did not quantify the error at high volume.
5. **`POST /api/cost/estimate` cross-checked against the client engine on one shape only.**
   I did not systematically assert client and server totals agree for every provider; the
   numbers I compared matched.
6. **No real deployment or paid provider call was made** (cost safety). Only free public
   pricing reads, plus our own Anthropic + Tavily keys.
7. **I emptied `.cache/pricing` mid-review** while testing the no-key error path, and the
   no-key server wrote empty books over it. I rebuilt it with real fetches
   (`GET /api/cost/prices`, HTTP 200, 42,337 bytes) and re-ran the affected checks, so
   every number quoted above comes from a genuine post-rebuild fetch. Flagging it because
   it means the coverage table is a single point-in-time sample, and it also demonstrates
   that a cache written under a degraded environment silently persists as though healthy —
   worth a `pipelineVersion`-style guard.

---

## Recommended order of fixes

Fix tasks created (all `parents=[t_c918b224]`):

| Task | Assignee | Covers |
|---|---|---|
| `t_e2022194` | backend | BLOCKER-1 + BLOCKER-2 — the missing unit scale |
| `t_a45a359a` | backend | BLOCKER-3 + MAJOR-3 + MINOR-1 — Azure `$0.00`, evidence cap, badge filter |
| `t_f65432ed` | backend | BLOCKER-4 — `/api/cost/recommend` 500s |
| `t_a3d3dcc7` | backend | MAJOR-1 + MAJOR-2 — AWS coverage, `includedQuantity` units |

1. **`t_e2022194` (BLOCKER-1 + BLOCKER-2)** first — both are the same missing concept (a
   machine-readable unit scale on `priceDimension`) and both need architect sign-off on
   the contract change. Nothing else matters until the arithmetic is right.
2. **`t_a45a359a` (BLOCKER-3)** — raise/rework the `evidence` cap, downgrade per-record
   validation failure to a `PriceGap`, filter `bestScaling`/`simplest` by completeness.
   Add a live smoke test for the Azure retail feed.
3. **`t_f65432ed` (BLOCKER-4)** — raise `MAX_OUTPUT_TOKENS`, harden `coerceDraft`, add a
   live test at **production prompt size**.
4. **`t_a3d3dcc7` (MAJOR-2)** — wire the remaining AWS feed descriptors; AWS at 8% is not
   a comparison. Then MAJOR-1's allowance units.
5. Remaining Minors / NIT.

Re-review needed after 1–3. The evidence gate, the unsupported-role machinery, the pure
client-side engine and the secret boundary all pass and should not be touched.

