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
