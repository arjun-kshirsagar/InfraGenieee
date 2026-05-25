# InfraGenie — API contracts

Authoritative HTTP contracts. Schemas live in `src/types/prd.ts`; this document
is the human-readable view. If the two disagree, the zod schema wins — fix the
doc.

Conventions:

- JSON in, JSON out. `Content-Type: application/json`.
- Request bodies are validated with zod. Invalid input → **400** with
  `validation_error` and a flattened `issues[]`.
- All errors use one envelope:

```json
{
  "error": {
    "code": "validation_error | not_found | generation_failed | bad_request | internal_error | llm_unavailable | llm_not_configured",
    "message": "human readable",
    "issues": [{ "path": "brief.idea", "message": "Too small: expected string to have >=30 characters" }]
  }
}
```

- Handlers live in `src/app/api/**/route.ts` and contain **no business logic** —
  parse, delegate, respond.
- Upstream LLM error text is logged server-side and **never** returned to the
  client (it can carry request/org ids).

| Code | Status | Meaning |
|---|---|---|
| `validation_error` | 400 | Body failed the request schema |
| `bad_request` | 400 | Body is not valid JSON |
| `not_found` | 404 | — |
| `generation_failed` | 500 | Model output failed validation after one retry |
| `internal_error` | 500 | Unexpected |
| `llm_unavailable` | 503 | Upstream 429/5xx/timeout — **retryable**, offer a retry |
| `llm_not_configured` | 500 | Server has no `ANTHROPIC_API_KEY` — deployment fault |
| `pricing_unavailable` | 503 | **Feature 2** — no price book at all (no `TAVILY_API_KEY`, or every source failed). **Retryable.** A PARTIAL failure is not this: it returns 200 with `gaps[]`. |

---

## Feature 1 — AI-generated PRD & Plan

Design rationale lives in `docs/feature-1-ai-prd.md`. Read that first.

### `POST /api/prd/clarify`

Asks the model what it still needs to know before it can write a good PRD.

**Request** — `clarifyRequestSchema`

```json
{
  "idea": "A marketplace where local bakeries list same-day surplus bread…",
  "context": {
    "userScale": "medium",
    "trafficPattern": "business-hours",
    "budgetBand": "startup",
    "timelineWeeks": 12,
    "constraints": "Must launch in the EU and be GDPR compliant."
  }
}
```

**Response** — `clarifyResponseSchema`

```json
{
  "questions": [
    {
      "id": "q1",
      "question": "Do bakeries manage their own listings, or does staff do it?",
      "why": "Determines whether we need a separate bakery-facing dashboard.",
      "suggestions": ["Bakeries self-serve", "Our staff do it"]
    }
  ]
}
```

**Zero questions is valid and common.** When `questions` is empty the frontend
must skip the clarifier step entirely — never render an empty screen. Hard cap
of **3**: this step fills genuine gaps, it does not reintroduce a questionnaire.

| Status | Body | When |
|---|---|---|
| `200` | `{ questions: ClarifyQuestion[] }` | success (may be empty) |
| `400` | `validation_error` / `bad_request` | bad body |
| `503` | `llm_unavailable` | upstream down — retryable |
| `500` | `llm_not_configured` | server misconfigured |

The clarifier is **best-effort**: if it fails, the frontend should let the user
proceed straight to generation rather than blocking. A PRD without clarifiers is
still a good PRD.

### `POST /api/prd/generate`

Runs the three-stage pipeline and returns a complete document. Takes **30–60s**;
clients must not use a short fetch timeout.

**Request** — `generateRequestSchema`

```json
{
  "brief": {
    "idea": "A marketplace where local bakeries list same-day surplus bread…",
    "context": { "userScale": "medium", "trafficPattern": "business-hours", "budgetBand": "startup", "timelineWeeks": 12, "constraints": "…" },
    "clarifications": [{ "question": "…", "answer": "…" }],
    "additionalNotes": "Pickup only for v1 — no delivery."
  }
}
```

`clarifications` may be `[]`. An individual `answer` may be `""` (user skipped
it) — the generator treats that as "infer it yourself".

**Responses**

| Status | Body | When |
|---|---|---|
| `200` | `{ "document": PrdDocument }` | success |
| `400` | `validation_error` | body fails `generateRequestSchema` |
| `400` | `bad_request` | body is not valid JSON |
| `500` | `generation_failed` | output failed validation after one retry |
| `503` | `llm_unavailable` | upstream 429/5xx/timeout |
| `500` | `llm_not_configured` | no API key on the server |

**`PrdDocument` shape** (`prdDocumentSchema`)

```ts
{
  id: string;                 // "prd_" + 12 base36 chars
  createdAt: string;          // ISO-8601
  generatorVersion: string;   // GENERATOR_VERSION
  model: string;              // which Anthropic model produced it
  title: string;              // AI-derived from the idea
  brief: ProjectBrief;        // echoed back verbatim
  prd: {
    overview: { problem, solution, targetUsers, valueProposition: string[] };
    goals: string[];
    nonGoals: string[];
    userStories: { id, asA, iWant, soThat, priority, acceptanceCriteria[] }[];
    functionalRequirements: { id, title, detail, priority }[];
    nonFunctionalRequirements: { id, category, requirement, rationale }[];
    successMetrics: string[];
    risks: { risk, impact, mitigation }[];
    openQuestions: string[];
    assumptions: string[];    // ⭐ what the AI decided on the user's behalf
  };
  architecture: {
    summary: string;
    pattern: string;
    components: { name, kind, responsibility, technology }[];
    dataModel: { entities: Entity[]; relationships: { from, to, kind, description? }[] };
    apiEndpoints: { method, path, purpose, authRequired }[];
    infrastructure: { hosting, database, cache, storage, cicd, environments[], rationale[] };
    diagramMermaid: string;   // DERIVED in TS, not from the model
  };
  plan: {
    milestones: { id, name, goal, tasks: PlanTask[] }[];
    criticalPath: string[];         // DERIVED
    totalEstimateHours: number;     // DERIVED
    estimatedCalendarWeeks: number; // DERIVED
  };
}
```

`assumptions` is new and required (≥1). The user never specified entities or
auth, so the document must be explicit about what it decided for them.

**Guarantees the backend must uphold**

1. **NOT deterministic** — unlike the old rules engine, the same brief may yield
   different documents. Do not write tests asserting byte-equality across runs.
2. `brief` is echoed back unchanged.
3. Every returned `PrdDocument` parses against `prdDocumentSchema` — the route
   parses its own output before responding.
4. **Min-volume floors are schema-enforced**, not just documented: ≥5 stories,
   ≥8 FRs, ≥5 NFRs, ≥3 entities, ≥3 components, ≥5 endpoints, ≥3 milestones,
   ≥12 plan tasks. An under-volume document cannot parse, so it cannot be
   returned. (The previous iteration stated these in prose only and shipped
   thin plans in 18 of 24 combos — hence the change.)
5. Every `PlanTask.dependsOn` id exists in the same document; no cycles, no
   self-edges, no duplicate task ids. Bad edges are repaired before validation.
6. Entity names are unique case-insensitively; field names unique within an
   entity; every relationship endpoint is a declared entity.
7. `diagramMermaid`, `criticalPath`, `totalEstimateHours` and
   `estimatedCalendarWeeks` are computed in TypeScript, never taken from the
   model.
8. The API key is server-side only and never appears in a response.

### Client-side persistence

There is no `GET /api/prd/:id` — documents are not stored server-side.

`src/lib/prd/store.ts` exposes:

```ts
saveDocument(doc: PrdDocument): void         // localStorage "infragenie:prd:<id>"
loadDocument(id: string): PrdDocument | null // zod-validated on read
listDocuments(): { id: string; title: string; createdAt: string }[]
saveDraft(draft: ProjectBriefDraft): void    // "infragenie:brief-draft"
loadDraft(): ProjectBriefDraft | null
clearDraft(): void
```

Reads validate with zod and return `null` on mismatch, so a schema change can
never crash the app on stale data. `projectBriefDraftSchema` is `.strict()` —
without it zod would strip unknown keys and a foreign blob would masquerade as
a valid empty draft.

When server persistence arrives it lands as `GET /api/prd/:id` returning the
same `{ document }` envelope. Nothing else changes.

---

## Feature 2 — Deployment cost predictor

Design rationale lives in `docs/feature-2-cost-predictor.md`. Read that first.
Schemas live in `src/types/cost.ts`.

Four routes. Two are static-ish reads that feed the client's **pure** cost
engine; two are POSTs. The interactive UI calls `catalog` + `prices` **once** on
load and then recomputes locally on every toggle — it does NOT call
`/api/cost/estimate` per keystroke.

### `GET /api/cost/catalog`

The provider/service/SKU structure that populates the selectors. **Contains no
prices** — see the design doc for why that separation is load-bearing.

**Response** — `catalogResponseSchema`

```json
{
  "catalog": {
    "version": "1.0.0",
    "services": [
      {
        "id": "aws:rds-postgres",
        "provider": "aws",
        "role": "db-relational",
        "name": "Amazon RDS for PostgreSQL",
        "kind": "managed",
        "description": "Managed PostgreSQL with automated backups…",
        "pricingUrl": "https://aws.amazon.com/rds/postgresql/pricing/",
        "scalingScore": 5,
        "simplicityScore": 3,
        "tradeoff": "More knobs than a hobby project needs; you pay around the clock.",
        "freeTierNote": "750 hours of db.t4g.micro for 12 months on a new account.",
        "skus": [
          {
            "id": "aws:rds-postgres:small",
            "displayName": "db.t4g.small",
            "tier": "small",
            "specs": { "vcpu": 2, "memoryGb": 2, "summary": "2 vCPU · 2 GB · Single-AZ" },
            "defaultUnits": 1,
            "dimensions": [
              {
                "id": "instance-hour",
                "label": "Instance hour",
                "quantityKey": "dbInstanceHours",
                "unit": "USD / hour",
                "required": true,
                "extractionHint": "Single-AZ db.t4g.small On-Demand price in US East (N. Virginia)"
              }
            ]
          }
        ]
      }
    ]
  }
}
```

Cacheable and deterministic — no upstream calls, so it cannot 503.

| Status | Body | When |
|---|---|---|
| `200` | `{ catalog: ServiceCatalog }` | always |
| `500` | `internal_error` | the checked-in catalog fails its own schema (a bug) |

### `GET /api/cost/prices`

The price books the client needs to do the arithmetic locally.

**Query** — `?providers=aws,gcp` (optional; omit for all five).

**Response** — `pricesResponseSchema`

```json
{
  "books": [
    {
      "provider": "aws",
      "region": "us-east-1",
      "pipelineVersion": "1.0.0",
      "generatedAt": "2026-07-26T10:12:30.000Z",
      "records": [
        {
          "skuId": "aws:rds-postgres:small",
          "dimensionId": "instance-hour",
          "unitPriceUsd": 0.032,
          "includedQuantity": 0,
          "currency": "USD",
          "source": {
            "url": "https://aws.amazon.com/rds/postgresql/pricing/",
            "fetchedAt": "2026-07-26T10:12:04.000Z",
            "evidence": "| db.t4g.small | 2 | 2 GiB | $0.032 |",
            "extractorModel": "claude-haiku-4-5-20251001"
          }
        }
      ],
      "gaps": [
        { "skuId": "aws:msk:small", "dimensionId": "broker-hour", "reason": "not_found_on_page" }
      ]
    }
  ]
}
```

**Guarantees the backend must uphold**

1. **Every price is cited.** `source.url`, `source.fetchedAt` and
   `source.evidence` are non-optional in `priceRecordSchema`, and `evidence` has
   passed `assertEvidenceSupportsPrice` — a verbatim substring of the fetched
   page that literally contains the number. A record that fails is **discarded**,
   never repaired.
2. **A partial book is a 200.** Four priced providers plus one gap is more useful
   than an error page. `pricing_unavailable` (503) is only for the total failure.
3. **Gaps are reported, not hidden.** Anything unpriced appears in `gaps[]` so the
   UI can render "unpriced" rather than `$0.00`.
4. Books are per provider, so one failing vendor cannot invalidate the others.
5. Served from `.cache/pricing/<provider>.json` when fresh
   (`PRICE_MAX_AGE_DAYS = 7`) and written by the current
   `PRICING_PIPELINE_VERSION`. A cold cache means a slow first call — the
   frontend must show a loading state, not a spinner-less blank.
6. No API key, and no raw upstream body, appears anywhere in the response.

| Status | Body | When |
|---|---|---|
| `200` | `{ books: PriceBook[] }` | success, possibly with gaps |
| `400` | `validation_error` | unknown provider in `?providers=` |
| `503` | `pricing_unavailable` | **no** book could be produced — retryable |
| `500` | `internal_error` | unexpected |

### `POST /api/cost/recommend`

Turns PRD context into a seeded, editable starting point. One Anthropic call;
expect **5–15s**.

PRDs live in `localStorage` (Feature 1 has no server persistence), so the client
POSTs the context slice rather than an id.

**Request** — `recommendRequestSchema`

```json
{
  "costContext": {
    "title": "Bakery surplus marketplace",
    "context": { "userScale": "medium", "trafficPattern": "business-hours", "budgetBand": "startup", "timelineWeeks": 12 },
    "components": [
      { "name": "Web app", "kind": "client", "responsibility": "Customer UI", "technology": "Next.js" },
      { "name": "API", "kind": "service", "responsibility": "Business logic", "technology": "Node.js" },
      { "name": "Primary DB", "kind": "datastore", "responsibility": "Orders", "technology": "PostgreSQL" }
    ],
    "infrastructure": { "hosting": "Vercel", "database": "Postgres", "cache": null, "storage": "S3", "cicd": "GitHub Actions", "environments": ["preview", "production"], "rationale": ["…"] },
    "summary": "Marketplace for same-day surplus bread."
  }
}
```

**Response** — `recommendResponseSchema`

```json
{
  "recommendation": {
    "recommendedProvider": "digitalocean",
    "rationale": "At 1k–50k MAU on a startup budget with business-hours traffic…",
    "usageProfile": { "monthlyActiveUsers": 10000, "monthlyRequests": 5000000, "…": 0 },
    "assumptions": ["No cache component was specified, so no cache is priced."],
    "selections": [
      { "provider": "digitalocean", "choices": [
        { "role": "compute-web", "serviceId": "digitalocean:app-platform", "skuId": "digitalocean:app-platform:basic-1gb", "units": 1, "enabled": true }
      ] }
    ],
    "tradeoffs": [
      { "provider": "digitalocean", "pros": ["Flat pricing fits a startup budget"], "cons": ["No managed Kafka"] }
    ]
  }
}
```

**Guarantees**

1. **`usageProfile` is derived in TypeScript**, then optionally nudged by the
   model — never invented by it. Same split as Feature 1's Mermaid/graph maths:
   the model reasons, TypeScript does arithmetic.
2. **Every returned `serviceId`/`skuId` is verified against the catalog** and must
   fill the role it claims. An invented id is dropped and the role falls back to
   the catalog default — the same "don't trust, verify" posture as the evidence
   gate.
3. It is a **seed, not a verdict** — the UI lets the user change everything.
4. `assumptions` (≥1) states whatever was decided on the user's behalf.
5. **Not deterministic.** Do not assert byte-equality across runs.

| Status | Body | When |
|---|---|---|
| `200` | `{ recommendation: CostRecommendation }` | success |
| `400` | `validation_error` / `bad_request` | bad body |
| `500` | `generation_failed` | model output failed validation after one retry |
| `503` | `llm_unavailable` | upstream 429/5xx/timeout — retryable |
| `500` | `llm_not_configured` | no `ANTHROPIC_API_KEY` |

### `POST /api/cost/estimate`

Server-side evaluation of the same pure engine the client runs. Exists for tests,
shareable links, and as the authority if the two ever disagree. No LLM call, no
upstream fetch beyond the (cached) price books.

**Request** — `estimateRequestSchema`

```json
{
  "usage": { "monthlyActiveUsers": 10000, "…": 0 },
  "selections": [{ "provider": "aws", "choices": [{ "role": "db-relational", "serviceId": "aws:rds-postgres", "skuId": "aws:rds-postgres:small" }] }],
  "requiredRoles": ["compute-web", "db-relational", "cdn"]
}
```

**Response** — `estimateResponseSchema`

```json
{
  "comparison": {
    "generatedAt": "2026-07-26T10:20:00.000Z",
    "estimates": [
      {
        "provider": "aws",
        "region": "us-east-1",
        "items": [
          {
            "role": "db-relational",
            "serviceId": "aws:rds-postgres",
            "serviceName": "Amazon RDS for PostgreSQL",
            "skuId": "aws:rds-postgres:small",
            "skuName": "db.t4g.small",
            "units": 1,
            "monthlyUsd": 23.36,
            "incomplete": false,
            "dimensions": [
              {
                "dimensionId": "instance-hour",
                "label": "Instance hour",
                "unit": "USD / hour",
                "quantityKey": "dbInstanceHours",
                "quantity": 730,
                "includedQuantity": 0,
                "billableQuantity": 730,
                "unitPriceUsd": 0.032,
                "monthlyUsd": 23.36,
                "unpriced": false,
                "source": { "url": "…", "fetchedAt": "…", "evidence": "…", "extractorModel": "…" }
              }
            ]
          }
        ],
        "monthlyUsd": 23.36,
        "unsupportedRoles": [],
        "incomplete": false,
        "oldestPriceAt": "2026-07-26T10:12:04.000Z",
        "warnings": []
      }
    ],
    "cheapest": "aws",
    "bestScaling": "aws",
    "simplest": "aws"
  }
}
```

**Guarantees**

1. **Deterministic and pure** — same inputs always give the same output, given
   the same price books. Safe to assert byte-equality on in tests (unlike
   Feature 1).
2. `billableQuantity = max(0, quantity - includedQuantity)`;
   `monthlyUsd = billableQuantity × unitPriceUsd`. Nothing else.
3. **`unpriced: true` never means free.** `monthlyUsd` is `0` because we have no
   number, and the UI must say so. A `required` unpriced dimension sets
   `incomplete` on the line and on the provider estimate.
4. **`cheapest` only considers complete estimates**, and never a provider with
   `unsupportedRoles`. A provider is not cheaper for being unable to run the app.
5. Badges are `nullable` — with one provider, or all estimates incomplete, there
   is no honest winner and the UI shows none.
6. `choice.units` multiplies per-unit quantities but **not** `months`/`seats`:
   you do not pay a plan fee twice for running two functions.

| Status | Body | When |
|---|---|---|
| `200` | `{ comparison: CostComparison }` | success |
| `400` | `validation_error` / `bad_request` | bad body, unknown SKU id, or role/provider mismatch |
| `503` | `pricing_unavailable` | no price book at all — retryable |
| `500` | `internal_error` | unexpected |
