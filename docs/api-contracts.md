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
    "code": "validation_error | not_found | generation_failed | bad_request | internal_error",
    "message": "human readable",
    "issues": [{ "path": "answers.scale.regions", "message": "Required" }]
  }
}
```

- Handlers live in `src/app/api/**/route.ts` and contain **no business logic** —
  parse, delegate, respond.

---

## Feature 1 — PRD & Plan generator

### `POST /api/prd/generate`

Turns a completed questionnaire into a PRD document. Pure and synchronous — no
external calls, no persistence server-side.

**Request** — `generateRequestSchema`

```json
{
  "answers": {
    "basics":       { "projectName": "…", "oneLiner": "…", "productType": "saas", "targetAudience": "…", "problemStatement": "…" },
    "scale":        { "userScale": "medium", "peakRequestsPerSecond": 50, "dataVolumeGb": 20, "growthExpectation": "steady", "regions": ["eu-west"], "uptimeTargetPercent": 99.9 },
    "budget":       { "monthlyBudgetBand": "startup", "budgetIsHardLimit": true, "teamSize": 3, "timelineWeeks": 10 },
    "stack":        { "frontend": "nextjs", "backend": "next-api-routes", "database": "postgres", "hosting": "no-preference", "mustUse": ["Stripe"], "mustAvoid": [] },
    "dataModel":    { "entities": [{ "name": "Invoice", "description": "…", "fields": [{ "name": "amount", "type": "number", "required": true }] }], "relationshipNotes": "…" },
    "auth":         { "authRequired": true, "authMethods": ["email-password"], "roles": ["admin","member"], "multiTenant": true, "compliance": ["gdpr"] },
    "integrations": { "integrations": ["payments"], "needsRealtime": false, "needsBackgroundJobs": true, "needsFileUploads": false, "notes": "…" }
  }
}
```

**Responses**

| Status | Body | When |
|---|---|---|
| `200` | `{ "document": PrdDocument }` | success |
| `400` | `error.code = "validation_error"` | body fails `generateRequestSchema` |
| `400` | `error.code = "bad_request"` | body is not valid JSON |
| `500` | `error.code = "generation_failed"` | the rules engine threw |

**`PrdDocument` shape** (`prdDocumentSchema`)

```ts
{
  id: string;                 // "prd_" + 12 base36 chars
  createdAt: string;          // ISO-8601
  generatorVersion: string;   // GENERATOR_VERSION
  title: string;              // derived from basics.projectName
  answers: QuestionnaireAnswers;   // echoed back verbatim
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
  };
  architecture: {
    summary: string;
    pattern: string;
    components: { name, kind, responsibility, technology }[];
    dataModel: { entities: Entity[]; relationships: { from, to, kind, description? }[] };
    apiEndpoints: { method, path, purpose, authRequired }[];
    infrastructure: { hosting, database, cache, storage, cicd, environments[], rationale[] };
    diagramMermaid: string;   // `flowchart TD …`
  };
  plan: {
    milestones: { id, name, goal, tasks: PlanTask[] }[];
    criticalPath: string[];         // PlanTask ids
    totalEstimateHours: number;
    estimatedCalendarWeeks: number;
  };
}
```

**Guarantees the backend must uphold**

1. **Deterministic** — identical `answers` produce an identical document apart
   from `id` and `createdAt`.
2. `answers` is echoed back unchanged (the PRD view re-renders the inputs).
3. Every `PrdDocument` returned parses against `prdDocumentSchema` — the route
   parses its own output before responding.
4. Minimum useful volume, so the UI is never empty: **≥ 5** user stories,
   **≥ 8** functional requirements, **≥ 5** non-functional requirements,
   **≥ 3** milestones, **≥ 12** plan tasks, **≥ 1** component per entity.
5. Every `PlanTask.dependsOn` id exists in the same document. No cycles.
6. No network calls. No secrets. No paid APIs.

### Client-side persistence

There is no `GET /api/prd/:id` in v1 — documents are not stored server-side.

`src/lib/prd/store.ts` (frontend-owned) exposes:

```ts
saveDocument(doc: PrdDocument): void        // localStorage "infragenie:prd:<id>"
loadDocument(id: string): PrdDocument | null // zod-validated on read
listDocuments(): { id: string; title: string; createdAt: string }[]
saveDraft(draft: QuestionnaireDraft): void  // "infragenie:prd-draft"
loadDraft(): QuestionnaireDraft | null
clearDraft(): void
```

Reads validate with zod and return `null` on mismatch, so a schema change can
never crash the app on stale data.

When server persistence arrives it lands as `GET /api/prd/:id` returning the
same `{ document }` envelope. Nothing else changes.
