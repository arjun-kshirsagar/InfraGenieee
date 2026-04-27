# Feature 1 — AI-generated PRD & Plan

Owned by the **architect** agent. This document replaces the questionnaire-centric
design; if it disagrees with an older doc, this one wins.

## 1. What changed, and why

The first implementation was a **7-step questionnaire**: the user typed in every
entity, every field, every auth method, every integration — and deterministic
template functions stitched those answers into a document. The human did all the
thinking and the app did the formatting. That is backwards.

InfraGenie's value is that **the AI does the thinking**. The user describes an
idea; the AI reasons out the entities, requirements, architecture, and task plan.
The output is detailed enough to hand to a coding agent.

| | Old (deleted) | New |
|---|---|---|
| Input | 7 steps, ~40 fields, user-entered entities | Idea + 5 context answers + optional AI clarifiers |
| Engine | Deterministic templates (`src/lib/prd/generate/`, ~2,900 LOC) | Anthropic API, 3 staged calls |
| Who infers the data model | The user | The AI |
| Output shape | `PrdDocument` | `PrdDocument` (kept — it was good) |

## 2. The input: `ProjectBrief`

```ts
{
  idea: string,                      // 30–4000 chars, free text
  context: {
    userScale, trafficPattern, budgetBand, timelineWeeks,
    constraints?: string,            // free text: "must be HIPAA", "team is Python-only"
  },
  clarifications: { question, answer }[],   // 0–5, from the adaptive step
  additionalNotes?: string,          // "anything else to add?"
}
```

Note what is **absent**: no entity list, no field types, no auth checkboxes, no
integration matrix. Asking for those is what we just deleted. If you find
yourself adding a field here, ask whether the AI could infer it instead.

**Why these five context answers survive.** They are the things the AI genuinely
cannot guess from an idea, and they materially change the output: scale and
traffic drive the architecture; budget drives the hosting recommendation;
timeline drives the milestone breakdown; constraints override everything.

`userScale` and `budgetBand` stay **enum buckets** rather than free numbers.
Feature 2 (cost predictor) compares estimates across documents, and that only
works if the scale/budget axes are comparable.

## 3. The flow

```
/prd/new
   │
   │  1. User writes their idea + answers 5 context questions
   ▼
POST /api/prd/clarify ──▶ 0–3 adaptive questions ("what does the AI still need?")
   │                       ZERO questions is valid and common — skip the step
   │  2. User answers (or skips) them
   │  3. Free-text "anything else?"
   ▼
POST /api/prd/generate ──▶ 3 staged LLM calls ──▶ PrdDocument ──▶ /prd/[id]
```

## 4. The engine: 3 staged LLM calls

```
brief ──▶ Stage 1  prd            overview, goals, stories, FRs, NFRs, risks
      ──▶ Stage 2  architecture   entities, components, endpoints, infra   [sees 1]
      ──▶ Stage 3  plan           milestones, tasks, dependsOn             [sees 1+2]
```

**Why staged, not one call.** Measured throughput on our key is **~140 output
tok/s**. A full document is 10–15k output tokens ⇒ ~85s single-shot, which is a
bad spinner and a serverless-timeout risk. Staging gives per-stage progress,
individually retryable failures, and better output — each call reasons about one
thing with the previous stages as context.

**Structured output via forced tool use.** Every call uses:

```ts
tools: [{ name: 'emit_prd', input_schema: <JSON Schema> }],
tool_choice: { type: 'tool', name: 'emit_prd' }
```

The model must respond with a `tool_use` block matching the schema. **We never
parse prose or fenced JSON out of a text response.** Verified working on our key:
`stop_reason: tool_use`, valid JSON first try.

### What the model does NOT produce

LLMs reason well about substance and badly about mechanical syntax. So these are
**derived in TypeScript** (`src/lib/prd/derive/`), never requested from the model:

| Field | How it's derived |
|---|---|
| `architecture.diagramMermaid` | Built from `components` + kinds. Models emit broken Mermaid often enough to break the diagram tab. |
| `plan.criticalPath` | Longest path by summed hours through the `dependsOn` DAG. |
| `plan.totalEstimateHours` | Sum of task estimates. |
| `plan.estimatedCalendarWeeks` | `max(throughput, critical-path)` — the critical-path floor stops a plan claiming 40 people finish a 6-week chain in 1 week. |

### Graph repair

A model asked for `dependsOn` edges will occasionally reference a nonexistent
task or close a cycle. Failing an otherwise-excellent 60-second generation over
one bad edge is the wrong trade, so `repairDependencyGraph()` **drops the
offending edges and keeps the tasks**, reporting what it removed. Self-edges,
unknown targets, and cycle-closing edges are all handled.

## 5. Quality floors are schema-enforced

The old implementation documented "≥12 plan tasks" **in prose only**, while
`planSectionSchema` had no `.min()` anywhere — so the route's self-validation
was structurally incapable of catching a breach, and 18 of 24 stack combos
shipped thin plans. That class of bug is now impossible: the floors are zod
constraints, so an under-volume document **cannot parse and therefore cannot be
returned**.

| Floor | Value |
|---|---|
| User stories | ≥ 5 |
| Functional requirements | ≥ 8 |
| Non-functional requirements | ≥ 5 |
| Entities | ≥ 3 (each with ≥ 1 field) |
| Components | ≥ 3 |
| API endpoints | ≥ 5 |
| Milestones | ≥ 3 |
| Plan tasks | ≥ 12 |
| Goals / metrics / risks | ≥ 3 each |

Prompts state the floors. If a stage returns under-volume output, the backend
issues **one** targeted "extend this" retry, then fails cleanly with
`generation_failed`. Never loop.

Integrity rules enforced the same way: entity names unique (case-insensitive,
trimmed), field names unique within an entity, relationship endpoints must be
declared entities, task ids unique, no dangling or self `dependsOn`.

## 6. Server-side only

`ANTHROPIC_API_KEY` is read **only** in server code (`src/lib/prd/llm/`), reached
only through route handlers. It must never appear in a client component, a
`NEXT_PUBLIC_*` var, or a response body. `.env.local` is gitignored.

Error codes reaching the client:

| Code | Status | Meaning |
|---|---|---|
| `llm_not_configured` | 500 | Server has no API key. Deployment fault. |
| `llm_unavailable` | 503 | Upstream 429/5xx/timeout. Retryable — offer a retry. |
| `generation_failed` | 500 | Output failed validation after the retry. |
| `validation_error` | 400 | The brief failed `projectBriefSchema`. |

Upstream error text is logged server-side and **never** returned — it can carry
request/org ids.

## 7. Models

Verified available on our key (`GET /v1/models`, 2026-07-25):
`claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-sonnet-4-6`,
`claude-haiku-4-5`, and others.

- **Generation**: `claude-sonnet-5` (default). Quality matters most here.
- **Clarify**: `claude-haiku-4-5` (default). Short, latency-sensitive.

Override with `ANTHROPIC_MODEL` / `ANTHROPIC_CLARIFY_MODEL`.

## 8. Cost safety

Our own Anthropic key is the **only** paid dependency — that is the product.
Everything else (real deploys, provisioned databases, paid pricing APIs) needs
explicit human approval first. Keep prompt-iteration loops small; don't run a
100-document sweep to tune wording.

## 9. Files

```
src/types/prd.ts              ⭐ contract: brief in, document out, floors, integrity
src/lib/prd/generation.ts     ⭐ the LLM seam: interfaces + GenerationError
src/lib/prd/derive/index.ts   ⭐ pure: mermaid, topo sort, critical path, weeks
src/lib/prd/llm/              backend: Anthropic client, prompts, 3 stages
src/lib/prd/markdown.ts       document → markdown (kept)
src/lib/prd/store.ts          localStorage persistence (kept)
src/app/api/prd/clarify/      POST — adaptive questions
src/app/api/prd/generate/     POST — full document
src/app/prd/new/              the idea + context flow (frontend rebuild)
src/app/prd/[id]/             document view (kept, unchanged)
```

⭐ = architect-owned. Changes need an architect sign-off comment on the board.
