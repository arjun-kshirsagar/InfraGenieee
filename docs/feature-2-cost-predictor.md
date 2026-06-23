# Feature 2 — Deployment cost predictor

Owned by the **architect**. Backend and frontend treat this as binding; propose
changes via a kanban comment rather than editing contracts unilaterally.

Contract: **`src/types/cost.ts`** (zod is authoritative).
Seam: **`src/lib/cost/pricing-seam.ts`**.
HTTP: **`docs/api-contracts.md`** § Feature 2.

---

## 1. The problem, stated honestly

A PRD from Feature 1 says *"you need a Postgres database, a Redis cache, a
worker, and a CDN."* It does not say what that costs. Feature 2 answers that,
for five providers, live, as the user changes their mind.

Two things make this hard, and both are addressed structurally rather than by
being careful:

1. **Comparing providers requires a common vocabulary.** RDS and Cloud SQL are
   comparable; "AWS" and "GCP" are not. We introduce **`InfraRole`** as the join
   key — a capability the app needs, independent of who sells it.
2. **It is trivially easy to produce a plausible wrong number.** An LLM asked
   "what does db.t4g.small cost?" will answer confidently and sometimes wrongly,
   and a wrong price is worse than no price because the user cannot tell. The
   **evidence gate** (§5) makes fabrication mechanically impossible rather than
   discouraged.

---

## 2. Three layers, and the pipeline

```
PrdDocument (localStorage, client)
   │  costContextSchema  ← the minimum slice: context + components + infrastructure
   ▼
POST /api/cost/recommend ──▶ deriveUsageProfile()  (pure TS, deterministic)
   │                          + 1 Anthropic call → provider/service picks
   │                          + catalog verification of every returned id
   ▼
CostRecommendation { recommendedProvider, usageProfile, selections[], tradeoffs[] }
   │
   │  seeds
   ▼
/cost  ── the interactive explorer ────────────────────────────────┐
   │                                                              │
   │  GET /api/cost/catalog  → ServiceCatalog   (structure, NO prices)
   │  GET /api/cost/prices   → PriceBook[]      (numbers, all cited)
   │                                                              │
   ▼                                                              ▼
estimate(usage, selection, catalog, book)   ← PURE. Runs in the browser.
   │                                          No round-trip per toggle.
   ▼
CostComparison { estimates[], cheapest, bestScaling, simplest }
```

| Layer | Path | Contains | Purity |
|---|---|---|---|
| **Catalog** | `src/lib/cost/catalog/` | which services/SKUs/dimensions exist, and the URL to price them from | pure data, **no prices** |
| **Price book** | `src/lib/cost/pricing/` | fetched numbers + citations | server-only, I/O |
| **Engine** | `src/lib/cost/estimate/` | the arithmetic | **pure** — no clock, no I/O, no env |

**Why the catalog holds no prices.** If a price could live in a checked-in
TypeScript file, someone would eventually type one in, and it would be
indistinguishable from a fetched one. Structure and numbers are separated so
that "every price has a citation" is a *type-level* guarantee: the only way a
number reaches the engine is as a `PriceRecord`, and `priceRecordSchema` makes
`source` (with `evidence`) non-optional.

**Why the engine is pure.** The centerpiece is live-updating totals. A pure
engine runs unchanged in the browser, so toggling a SKU is a re-render, not a
network request. `POST /api/cost/estimate` runs the same function server-side for
tests and shareable links; the interactive UI does not call it per keystroke.

---

## 3. PRD → InfraRole mapping

`architecture.components[].kind` is a 7-value enum (`client`, `service`,
`datastore`, `cache`, `queue`, `external`, `cdn`). It is too coarse on its own —
`datastore` covers both Postgres and DynamoDB — so `mapComponentsToRoles` reads
`kind` **and** matches keywords in `technology` + `name`.

| component `kind` | signal in `technology` / `name` | → `InfraRole` |
|---|---|---|
| `client` | "next", "react", "ssr", "server-side" | `static-hosting` + `compute-web` |
| `client` | "static", "spa", "vite", "mobile", "ios", "android" | `static-hosting` (mobile → nothing hosted) |
| `service` | "lambda", "serverless", "function", "edge" | `compute-serverless` |
| `service` | "worker", "cron", "job", "queue consumer", "batch" | `compute-worker` |
| `service` | anything else (API, monolith, gateway) | `compute-web` |
| `datastore` | "postgres", "mysql", "sql", "rds", "aurora", "prisma" | `db-relational` |
| `datastore` | "dynamo", "firestore", "mongo", "cosmos", "nosql", "document" | `db-nosql` |
| `datastore` | "s3", "blob", "bucket", "object", "file storage", "upload" | `object-storage` |
| `datastore` | "elastic", "opensearch", "algolia", "search", "typesense" | `search` |
| `datastore` | unclear | `db-relational` (the safe default; recorded as an assumption) |
| `cache` | any | `cache-redis` |
| `queue` | "kafka", "msk", "confluent", "event stream", "kinesis" | `queue-kafka` |
| `queue` | anything else | `queue-basic` |
| `cdn` | any | `cdn` |
| `external` | — | **no role** (third-party SaaS the customer already pays for; we must not invent a price for someone else's Stripe bill) |

Plus two roles that are never a component but are always a cost:

- **`egress`** — always added. On AWS/GCP/Azure data transfer out is routinely a
  top-three line item, and it is invisible if you only price the boxes.
- **`object-storage`** — added whenever the PRD has file/image/upload entities
  even without an explicit component, since an app that stores user uploads
  always pays for storage.

Rules:

1. Roles are **deduplicated**. Three `service` components that all map to
   `compute-web` produce ONE role, and `UsageProfile.computeNodes` carries the
   multiplicity. Otherwise a chatty microservice diagram triples the bill.
2. Every inference from a *default* (the unclear-`datastore` case) MUST appear in
   `CostRecommendation.assumptions`. Same rule as Feature 1's `prd.assumptions`:
   anything we decided on the user's behalf is stated out loud.
3. A role with no provider service (`queue-kafka` on Vercel) surfaces as
   `ProviderEstimate.unsupportedRoles`. **A provider is not cheaper because it
   is missing a component the app requires** — the UI must show the gap, and
   `cheapest` must not crown a provider that cannot run the app.

---

## 4. Sourcing strategy — measured, not assumed

I probed **38 real vendor pricing pages** through Tavily `/extract`
(`extract_depth: 'advanced'`) on 2026-07-26. Harness:
`scripts/probe-pricing-urls.ts`, `scripts/probe-page.ts`. All 38 fetched
successfully — but fetching is not the same as *carrying numbers*:

| Provider | Tavily result | Verdict |
|---|---|---|
| **DigitalOcean** | clean markdown tables — `\| 1 GiB \| 1 vCPU \| 1,000 GiB \| 25 GiB \| $0.00893 \| $6.00 \|` | ✅ Tavily |
| **GCP** | real per-unit rows — `\| CPU (per vCPU-second) \| $0.000018 \|` | ✅ Tavily |
| **Vercel** | plan + overage tables on `/pricing` and `/docs/pricing` | ✅ Tavily |
| **AWS** | mixed. Some pages good (Fargate, CloudFront, S3, Lambda); **`/sqs/pricing/` and `/ec2/pricing/on-demand/` render prices client-side** — extract returns 0 and 7 `$`-matches respectively | ⚠️ needs a feed |
| **Azure** | **every** page renders literally `$-` in the price column (values injected by JS after load) | ❌ Tavily cannot work |

The Azure finding is decisive: `azure.microsoft.com/.../postgresql/flexible-server/`
returns a complete 213-row markdown table in which every price cell is `$-`. An
extractor pointed at that page can only fail — or hallucinate. So:

### Rule: prefer a provider's own structured public price feed; use Tavily where there is none.

All of these are **free, public, unauthenticated, read-only** — no account, no
billing, no cost-safety question. Verified live:

| Provider | Primary source | Verified |
|---|---|---|
| **AWS** | `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<OfferCode>/current/<region>/index.json` (Price List Bulk API). Discover regions via `.../current/region_index.json`. | ✅ `AWSQueueService` us-east-1 → `$0.40 per million Amazon SQS standard requests`, `pricePerUnit.USD = 0.0000004` |
| **AWS EC2** | `https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json` — the feed the AWS pricing page itself consumes. **gzip-encoded**; decompress before parsing. | ✅ 1,322 SKUs, e.g. `m9g.large` → `0.09784`/hr, 2 vCPU, 8 GiB |
| **Azure** | `https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&currencyCode=USD&$filter=…` | ✅ `eastus` + `contains(productName,'PostgreSQL')` → 168 items with `retailPrice`, `unitOfMeasure`, `meterName` |
| **GCP** | Tavily on `cloud.google.com/**/pricing` | ✅ |
| **Vercel** | Tavily on `vercel.com/pricing`, `/docs/pricing`, `/docs/pricing/networking` | ✅ |
| **DigitalOcean** | Tavily on `digitalocean.com/pricing/*` | ✅ |

Tavily therefore does real work for **three of five providers** and remains the
fallback everywhere. Where a structured feed is primary, the human pricing page
still goes in `CatalogService.pricingUrl` — that is the URL a user clicks to
check us, and it is what `PriceSource.url` cites.

**Azure `$filter` cookbook** (`armRegionName eq 'eastus'`, then narrow):

- Postgres: `contains(productName,'PostgreSQL')`, `type eq 'Consumption'`,
  `meterName eq 'vCore'`
- Redis: `serviceName eq 'Redis Cache'`
- Blob: `serviceName eq 'Storage' and contains(meterName,'Data Stored')`
- Service Bus: `serviceName eq 'Service Bus'`
- Container Apps: `serviceName eq 'Azure Container Apps'`
- Functions: `serviceName eq 'Functions'`

Pin `armRegionName` and `type eq 'Consumption'` on every query, or reserved-
instance and other-region rows will silently outbid the on-demand price.

### Known-bad URLs — do not point a SKU at these

| URL | Why |
|---|---|
| `azure.microsoft.com/en-us/pricing/details/**` | prices render as `$-` |
| `aws.amazon.com/sqs/pricing/` | JS-rendered, 0 prices in extract |
| `aws.amazon.com/ec2/pricing/on-demand/` | table is JS-rendered |
| `vercel.com/docs/pricing/functions` | 0 prices; use `vercel.com/docs/pricing` |
| `cloud.google.com/functions/pricing` | nav-only extract; Cloud Run is the current product — use `cloud.google.com/run/pricing` |
| `cloud.google.com/compute/all-pricing` | index page, no prices; use `cloud.google.com/products/compute/pricing/general-purpose` (✅ verified: `c4-standard-2 … $0.096866 / 1 hour`) |

---

## 5. The evidence gate — the anti-fabrication invariant

**This is the most important mechanism in the feature.**

The extractor (a Haiku call over the fetched markdown, or a JSON-feed record
lookup) emits candidate prices. Alongside each, it must emit **`evidence`**: a
verbatim substring of the fetched text containing the number. Then a *pure
TypeScript* function — `assertEvidenceSupportsPrice` — asserts:

1. `evidence` is a verbatim substring of `page.markdown`
   (whitespace may be collapsed on **both** sides; nothing else normalised), and
2. the numeric value of `unitPriceUsd` literally appears inside `evidence`,
   tolerating only formatting: `$`, thousands separators, trailing zeros.

Records failing either check are **DISCARDED** and recorded as
`PriceGap{reason: 'evidence_rejected'}`. Never repaired. Never defaulted. Never
averaged with a neighbour.

A model cannot invent a price that survives a substring check against the real
page. Judgement is replaced with arithmetic.

The same gate covers structured feeds: `evidence` is the serialised matched
record and the check runs against the raw response body. One code path, one
invariant, both sources.

### Mandatory test

`assertEvidenceSupportsPrice` **must** have a unit test in which a *fabricated*
price is REJECTED. A suite that only proves the happy path does not test this
function at all. Feature 1 shipped a real bug behind mocked-only tests; the
counterexample test is the fix for that class of failure.

### Unpriced ≠ free

`CostDimensionResult.unpriced` and `CostLineItem.incomplete` exist so the UI can
say *"we could not price this"*. Rendering an unpriced dimension as `$0.00` would
make a provider look cheap because our fetch failed. Consequences:

- an incomplete `ProviderEstimate` is **excluded from `cheapest`**;
- the line total is presented as a **floor**, not an estimate;
- `PriceBook.gaps` is surfaced in the UI, not swallowed.

---

## 6. Caching

Filesystem cache at `.cache/pricing/<provider>.json`, gitignored.

Prices move on a scale of months (`PRICE_MAX_AGE_DAYS = 7`), the payload is small
and non-secret, and a file survives dev-server restarts where an in-process `Map`
does not — which is exactly what stops the Tavily quota being burned on every hot
reload. No database, nothing to provision.

A cached book is a **MISS** when it is absent, older than `PRICE_MAX_AGE_DAYS`,
or written by a different `PRICING_PIPELINE_VERSION`. Reads validate with
`priceBookSchema` and treat a mismatch as a miss, so a schema change can never
crash the app on a stale file (same posture as Feature 1's `store.ts`).

Books are stored **per provider** so one failing vendor cannot invalidate the
other four.

---

## 7. Cost model

Per dimension, the engine does exactly this and nothing else:

```
quantity = deriveQuantities(usage, sku, choice.units)[dimension.quantityKey]
billable = max(0, quantity - record.includedQuantity)
monthly  = (billable / dimension.pricePerUnits) * record.unitPriceUsd
```

- `dimension.pricePerUnits` (catalog field, default `1`) is how many
  `quantityKey` units one `unitPriceUsd` buys — the machine-readable price
  SCALE. It reconciles the vendor's quoted unit with our single-item / per-month
  quantity vocabulary so the ONE arithmetic site above stays vendor-agnostic:
  a bulk price (`USD / million requests` → `1_000_000`, `/ 10,000 …` → `10_000`)
  divides billable down to the priced batch size, and a per-hour rate billed
  against a per-month quantity (`USD / GiB-hour` on a `*GbMonth` key →
  `1 / HOURS_PER_MONTH`) is multiplied up across all 730 hours. Leaving it at the
  default `1` (per-hour node-hours, per-GB egress, per-month plan fees) is a
  no-op. `catalog.test.ts` fails the build if a bulk/hour dimension omits it.
- `HOURS_PER_MONTH = 730` (= 365×24/12), the figure every vendor calculator uses.
- `choice.units` multiplies per-unit quantities. It does **not** multiply
  `months` or `seats` — you do not pay the Vercel Pro plan fee twice for running
  two functions. `deriveQuantities` owns that exemption.
- `includedQuantity` is a **fetched** free allowance. An assumed free tier is a
  fabricated discount.
- **Tiered pricing is flattened to the first paid tier in v1** and the SKU note
  says so. Modelling AWS's graduated S3 tiers correctly needs a tier ladder in
  the price record; that is a deliberate v2 item, and over-estimating slightly at
  high volume is the honest direction to err.

`QuantityKey` is a closed enum. If a provider bills on something not in it, **add
a key** (architect sign-off) rather than smuggling arithmetic into the catalog —
that is what keeps the engine free of per-provider special cases.

---

## 8. Badges

- **cheapest** — lowest `monthlyUsd` among **complete** estimates only.
- **best-scaling** — highest sum of `scalingScore` over selected services.
- **simplest** — highest sum of `simplicityScore`.

All three are `nullable`: with one provider selected, or with every estimate
incomplete, there is no honest winner and the UI shows none. `scalingScore` /
`simplicityScore` are editorial judgements justified in each service's
`tradeoff` line — they are **not** permitted to stand in for a missing price.

---

## 9. Provider × role coverage target

`✓` = must exist in the v1 catalog. `—` = the provider genuinely does not offer
it, and a PRD needing that role yields an honest `unsupportedRoles` gap.

| Role | AWS | GCP | Azure | Vercel | DO |
|---|---|---|---|---|---|
| `compute-web` | EC2, Fargate | GCE, Cloud Run | App Service, Container Apps | ✓ (Fluid compute) | Droplet, App Platform |
| `compute-worker` | EC2, Fargate | GCE, Cloud Run jobs | Container Apps | — (no always-on worker) | Droplet, App Platform worker |
| `compute-serverless` | Lambda | Cloud Run functions | Functions | Vercel Functions | DO Functions |
| `static-hosting` | S3 + CloudFront | Cloud Storage + CDN | Static Web Apps | ✓ | App Platform static |
| `db-relational` | RDS Postgres, Aurora Serverless v2 | Cloud SQL | Postgres Flexible Server | — (partner only) | Managed Postgres |
| `db-nosql` | DynamoDB | Firestore | Cosmos DB | — | — |
| `cache-redis` | ElastiCache | Memorystore | Azure Cache for Redis | — | Managed Valkey/Redis |
| `queue-basic` | SQS | Pub/Sub | Service Bus | — | — |
| `queue-kafka` | MSK | Managed Kafka | Event Hubs (Kafka API) | — | — |
| `object-storage` | S3 | Cloud Storage | Blob Storage | Blob | Spaces |
| `cdn` | CloudFront | Cloud CDN | Azure Front Door / CDN | Edge Network | DO CDN |
| `search` | OpenSearch | — (self-host) | AI Search | — | — |
| `egress` | ✓ | ✓ | ✓ | ✓ | ✓ (pooled) |

Vercel's gaps are real and are the point: a PRD needing Postgres + Kafka gets an
honest *"Vercel cannot run this alone"* rather than a misleadingly cheap total.

---

## 10. Cost safety

Only our own **Anthropic** and **Tavily** keys are used. Every pricing source in
§4 is a public read: no account, no auth, no billing. We provision nothing and
deploy nothing. Real deployment is Feature 3 and needs owner approval.

Both keys are server-side only. The client receives `ServiceCatalog`,
`PriceBook[]` and `CostRecommendation` — never a key, never a raw upstream body.

---

## 11. Verification bar

```bash
npm run build   # the real gate
npm run lint
npm test
npx tsc --noEmit
```

Plus a **live smoke test**, guarded on keys being present, that proves
fetch → extract → evidence gate → cost calc end to end against a real vendor
page. Mocked-only tests hid a real bug in Feature 1. Not repeating that.
