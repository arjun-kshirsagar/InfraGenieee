# InfraGenie — Architecture

Living document. Owned by the **architect** agent. Frontend and backend agents
treat it as binding; propose changes via a kanban comment rather than editing
contracts unilaterally.

## 1. What InfraGenie is

A **pre-build & deploy companion**. We do not build the customer's app. We help
them plan it and ship it:

| # | Feature | Status |
|---|---------|--------|
| 1 | PRD & Plan generator (questionnaire → PRD + architecture + task breakdown) | in progress |
| 2 | Deployment cost predictor (multi-vendor comparison, PRD-aware) | not started |
| 3 | One-click deploy (customer's app → Vercel first) | not started |

## 2. Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript strict**
- **Tailwind CSS v4** + **shadcn/ui** (`src/components/ui`, slate base)
- **zod** for all validation — schemas are the source of truth, TS types are inferred
- **react-hook-form** + `@hookform/resolvers` for form state
- **recharts** for charts (Feature 2)
- `.npmrc` sets `legacy-peer-deps=true` — React 19 `peerOptional` conflicts
  (`@hookform/resolvers` → valibot). Do not remove it; installs break.

## 3. Folder structure

```
src/
  app/
    api/                     # route handlers only — no business logic
      prd/generate/route.ts  # POST → PrdDocument
    prd/
      new/page.tsx           # questionnaire wizard
      [id]/page.tsx          # generated PRD view (reads client store)
    layout.tsx  page.tsx  globals.css
  components/
    ui/                      # shadcn primitives — generated, don't hand-edit
    prd/                     # Feature 1 components
  lib/
    prd/
      questionnaire.ts       # data-driven question metadata (architect-owned)
      generate/              # pure generation logic (backend-owned)
      store.ts               # client-side draft/document persistence
    utils.ts
  types/
    prd.ts                   # ⭐ Feature 1 contract: zod schemas + inferred types
docs/
  architecture.md            # this file
  api-contracts.md           # HTTP contracts
```

**Rules**

1. `src/types/*.ts` is the only place contracts live. Never hand-write a type
   that duplicates a zod schema — use `z.infer`.
2. Route handlers validate input with the request schema and return the
   response schema shape. No business logic in `route.ts`.
3. Generation logic under `src/lib/prd/generate/` must be **pure**: same
   answers in → same document out. No `Date.now()`/`Math.random()` outside the
   single id/timestamp injection point, so it stays unit-testable.
4. UI components never import from `src/lib/prd/generate/` — they consume the
   API. This keeps generation swappable (rules engine now, LLM later).

## 4. Feature 1 — PRD & Plan generator

### Flow

```
/prd/new  ──7-step wizard──▶  QuestionnaireAnswers
                                   │ POST /api/prd/generate
                                   ▼
                          deterministic rules engine
                                   │
                                   ▼
   PrdDocument { answers, prd, architecture, plan }  ──▶  /prd/[id]
```

### Data model (see `src/types/prd.ts`)

- `QuestionnaireAnswers` — 7 groups: `basics`, `scale`, `budget`, `stack`,
  `dataModel`, `auth`, `integrations`. Filled in that canonical order
  (`STEP_ORDER`).
- `QuestionnaireDraft` — the same shape, all groups optional, for autosave.
- `PrdDocument` — `{ id, createdAt, generatorVersion, title, answers, prd,
  architecture, plan }`.
  - `prd`: overview, goals, non-goals, user stories, functional +
    non-functional requirements, success metrics, risks, open questions.
  - `architecture`: summary, pattern, components, data model (entities +
    relationships), API endpoints, infrastructure recommendation with
    rationale, and a **Mermaid** flowchart source string.
  - `plan`: milestones → tasks (area, estimate, `dependsOn`, acceptance
    criteria), plus critical path and totals.

### Generation: deterministic rules, not an LLM (v1)

v1 is a **rules engine**. Rationale: no paid API dependency (cost-safety rule),
instant, deterministic, unit-testable, and the output is structured rather than
prose we'd have to parse. Inputs map to outputs via explicit heuristics, e.g.

- `stack.hosting = no-preference` → pick from `scale.userScale` +
  `budget.monthlyBudgetBand` (small/free-tier → Vercel + managed Postgres;
  very-large/enterprise → AWS ECS + RDS + CloudFront).
- `scale.userScale >= large` **or** `growthExpectation = aggressive` → add a
  cache component and a scalability NFR.
- `integrations` and the `needs*` booleans each add components, endpoints,
  plan tasks, and NFRs.
- Every `dataModel.entities[]` entry yields CRUD endpoints and a schema task.

An LLM-backed generator may be added later behind the same route contract. It
must be **opt-in and human-approved** — it would be a paid API call.

### Persistence (v1)

**Client-side only.** `PrdDocument`s live in `localStorage` under
`infragenie:prd:<id>`, drafts under `infragenie:prd-draft`. No database, no
accounts, nothing to provision — consistent with the cost-safety rule. The
`PrdDocument` shape is DB-ready when we add server persistence, and the
`/api/prd/generate` contract does not change when we do.

## 5. Cross-cutting decisions

| Decision | Choice | Why |
|---|---|---|
| ID format | `prd_` + 12 lowercase base36 chars | URL-safe, no dependency |
| Timestamps | ISO-8601 strings | JSON-safe, no serialisation edge cases |
| Errors | `{ error: { code, message, issues? } }` | one shape everywhere; codes are a zod enum |
| Validation | zod at every boundary | one definition, client + server |
| Enums vs free text | buckets for scale/budget | keeps Feature 2 cost math comparable |
| Diagrams | Mermaid source in the document | renderer-agnostic; frontend may render or show source |
| Secrets | server-side env only, never in `NEXT_PUBLIC_*` | Feature 3 will hold provider tokens |

## 6. Cost safety

The only paid service in play is the LLM key powering the agents. Anything else
that costs money — real deploys, provisioned databases, paid pricing APIs —
requires explicit human approval first. Feature 3 is built against mocks and
dry-runs until the human approves a real deployment. Vendor pricing used in
Feature 2 must be sourced from public pages with a citation in the code.

## 7. Verification bar

Every task is done only when:

```bash
npm run build   # must pass
npm run lint    # must pass
npx tsc --noEmit
```

…and, for UI work, the flow has been exercised in a real browser.
