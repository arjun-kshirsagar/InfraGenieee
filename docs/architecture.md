# InfraGenie — Architecture

Living document. Owned by the **architect** agent. Frontend and backend agents
treat it as binding; propose changes via a kanban comment rather than editing
contracts unilaterally.

## 1. What InfraGenie is

A **pre-build & deploy companion**. We do not build the customer's app. We help
them plan it and ship it:

| # | Feature | Status |
|---|---------|--------|
| 1 | PRD & Plan generator (**idea → AI-reasoned** PRD + architecture + task breakdown) | in progress (re-scoped to AI generation) |
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
      prd/clarify/route.ts   # POST → adaptive questions (0–3)
      prd/generate/route.ts  # POST → PrdDocument
    prd/
      new/page.tsx           # idea + context input flow
      [id]/page.tsx          # generated PRD view (reads client store)
    layout.tsx  page.tsx  globals.css
  components/
    ui/                      # shadcn primitives — generated, don't hand-edit
    prd/                     # Feature 1 components
  lib/
    prd/
      generation.ts          # ⭐ the LLM seam: interfaces + GenerationError
      derive/                # ⭐ pure: mermaid, topo sort, critical path
      llm/                   # Anthropic client + prompts + stages (backend-owned)
      markdown.ts            # document → markdown
      store.ts               # client-side draft/document persistence
    utils.ts
  types/
    prd.ts                   # ⭐ Feature 1 contract: zod schemas + inferred types
docs/
  architecture.md            # this file
  api-contracts.md           # HTTP contracts
  feature-1-ai-prd.md        # ⭐ Feature 1 design (read this first)
```

**Rules**

1. `src/types/*.ts` is the only place contracts live. Never hand-write a type
   that duplicates a zod schema — use `z.infer`.
2. Route handlers validate input with the request schema and return the
   response schema shape. No business logic in `route.ts`.
3. `src/lib/prd/derive/` must stay **pure**: same input → same output, no clock,
   no randomness, no I/O. It holds the mechanical work (Mermaid, graph maths)
   we deliberately do NOT trust the model with.
4. UI components never import from `src/lib/prd/llm/` or `generation.ts` — they
   consume the API. The API key must never be reachable from a client bundle.
5. Anything user-visible that the AI decided rather than the user must appear in
   `prd.assumptions`.

## 4. Feature 1 — AI-generated PRD & Plan

Full design: **`docs/feature-1-ai-prd.md`**. Summary:

```
/prd/new  ──idea + 5 context answers──▶  POST /api/prd/clarify  (0–3 questions)
                                                 │
                                         ProjectBrief
                                                 │ POST /api/prd/generate
                                                 ▼
                            3 staged Anthropic calls (prd → architecture → plan)
                                                 │
                                 + TS-derived mermaid / critical path / weeks
                                                 ▼
        PrdDocument { brief, prd, architecture, plan }  ──▶  /prd/[id]
```

The user supplies an **idea**, not a data model. The AI infers entities,
requirements, architecture and the task breakdown. The old 7-step questionnaire
and its ~2,900-line deterministic template engine were deleted in this re-scope.

**Key invariants**

- Generation is **non-deterministic** — never assert byte-equality across runs.
- Min-volume floors and integrity rules (unique entity names, acyclic
  `dependsOn`, valid relationship endpoints) are enforced by **zod**, so a bad
  document cannot be returned. Previously they lived in prose and shipped broken.
- `diagramMermaid`, `criticalPath`, `totalEstimateHours`,
  `estimatedCalendarWeeks` are derived in TypeScript, never requested from the
  model.
- `ANTHROPIC_API_KEY` is server-side only.

### Persistence (v1)

**Client-side only.** `PrdDocument`s live in `localStorage` under
`infragenie:prd:<id>`, the in-progress brief under `infragenie:brief-draft`. No
database, nothing to provision. The `PrdDocument` shape is DB-ready for when we
add server persistence, and the route contracts don't change when we do.

## 5. Cross-cutting decisions

| Decision | Choice | Why |
|---|---|---|
| ID format | `prd_` + 12 lowercase base36 chars | URL-safe, no dependency |
| Timestamps | ISO-8601 strings | JSON-safe, no serialisation edge cases |
| Errors | `{ error: { code, message, issues? } }` | one shape everywhere; codes are a zod enum |
| Validation | zod at every boundary | one definition, client + server |
| Enums vs free text | buckets for scale/budget | keeps Feature 2 cost math comparable |
| Diagrams | Mermaid source, **derived in TS** | models emit broken Mermaid; kinds are enum-constrained so ours is always valid |
| Diagram edge direction | caller → callee, chosen by component `kind` | every `client` points AT the service (not just the first) and a `cdn` points at every client; deriving direction from `kind` is what stops multi-UI products from getting backwards arrows |
| LLM output | forced tool use (`tool_choice`) | guaranteed schema-shaped JSON; we never parse prose |
| Quality floors | zod `.min()`, not prose | prose floors shipped broken in 18/24 combos |
| Secrets | server-side env only, never in `NEXT_PUBLIC_*` | Feature 3 will hold provider tokens |

## 6. Cost safety

The only paid service in play is our Anthropic key — which now powers the
product itself, not just the agents. Anything else
that costs money — real deploys, provisioned databases, paid pricing APIs —
requires explicit human approval first. Feature 3 is built against mocks and
dry-runs until the human approves a real deployment. Vendor pricing used in
Feature 2 must be sourced from public pages with a citation in the code.

## 7. Verification bar

Every task is done only when:

```bash
npm run build   # must pass — the real gate
npm run lint    # must pass
npm test        # must pass
npx tsc --noEmit
```

…and, for UI work, the flow has been exercised in a real browser.
