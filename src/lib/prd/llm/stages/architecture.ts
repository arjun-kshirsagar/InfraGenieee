/**
 * InfraGenie — Stage 2: the architecture section (draft).
 *
 * SERVER-ONLY. Sees the brief AND stage 1's PRD, then infers the data model
 * (entities + relationships), the runtime components, the API surface, and the
 * infrastructure — with rationale grounded in the brief's scale/budget/
 * constraints.
 *
 * Returns an `ArchitectureDraft` (everything EXCEPT the derived Mermaid
 * diagram). Assembly derives `diagramMermaid` in TypeScript — the model never
 * writes Mermaid.
 */

import { architectureDraftSchema, type ArchitectureDraft, type PrdSection } from '@/types/prd';
import {
  MIN_ENTITIES,
  MIN_COMPONENTS,
  MIN_API_ENDPOINTS,
} from '@/types/prd';
import type { StageContext } from '@/lib/prd/generation';
import { formatBrief, runStage } from '@/lib/prd/llm/shared';
import { repairArchitectureRelationshipKinds } from '@/lib/prd/llm/normalize';

/** Architecture carries the data model + endpoints — the heaviest stage. An
 *  enterprise data model with many entities/fields/endpoints can be large, so
 *  keep headroom well above the free-tier case to avoid a max_tokens truncation. */
const ARCHITECTURE_MAX_TOKENS = 16000;

const SYSTEM_PROMPT = `You are a senior staff software architect. You are designing the architecture for a product whose PRD has already been written (you are given it below, along with the original brief). Another AI coding agent will implement exactly what you specify, so your data model, components, endpoints, and infrastructure must be concrete, internally consistent, and buildable.

## Ground every decision in the brief
The brief's scale, traffic pattern, budget, timeline, and hard constraints are the whole reason this stage isn't generic. A free-tier prototype and a very-large enterprise app with compliance constraints must produce VISIBLY DIFFERENT architectures. Your \`infrastructure.rationale\` MUST cite the actual brief — the specific scale bucket, budget band, traffic pattern, or a named constraint — NOT recite best practice. "Chose serverless Postgres (Neon) because the free-tier budget rules out a always-on managed instance and prototype scale never exceeds its free row cap" is right; "Postgres is a robust, scalable database" is wrong and will be rejected in review.

## Hard requirements — rejected below any of these floors:
- summary: a short paragraph describing the overall architecture in this product's terms.
- pattern: the architectural pattern chosen (e.g. "modular monolith on serverless", "event-driven microservices"), justified by the brief's scale — don't reach for microservices at prototype scale.
- components: at least ${MIN_COMPONENTS}. Each: name, kind, responsibility, technology. Include the real moving parts of THIS system. The 'kind' field drives the derived diagram and MUST be EXACTLY one of these seven values — no others, no made-up kinds: "client", "service", "datastore", "cache", "queue", "external", "cdn". Map every real component onto the closest of these: an identity provider, payment gateway, EHR/third-party API, email/SMS provider, or any managed SaaS you call is "external"; an object/file store or database is "datastore"; a search index or read-model store is also "datastore"; a background worker or scheduler is "service"; a message broker/event bus is "queue"; a browser/mobile/admin UI is "client". Classify accurately but NEVER emit a kind outside the seven.
- dataModel.entities: at least ${MIN_ENTITIES}, each with at least one field (name, type, required, optional notes). Entities MUST be specific to the idea — a bakery-surplus marketplace has Bakery/SurplusListing/Reservation, NOT User/Item/Order placeholders. Draw the entities from the assumptions stage 1 recorded, and extend as needed. Entity names must be unique. Field names must be unique within an entity. Field type is one of: string, text, number, boolean, date, json, enum, relation.
- dataModel.relationships: the edges between entities. Each relationship has: from, to, kind, and an optional description. The 'kind' field MUST be EXACTLY one of these three literal strings — no others, no natural-language phrasings: "one-to-one", "one-to-many", "many-to-many". Do NOT emit "belongs-to", "has-many", "has-one", "references", "1:N", "m2m" or any variant — map every relationship onto exactly one of the three allowed values. Mapping guide: a parent that owns many children (User→Orders, Bakery→Listings) is "one-to-many"; a foreign-key / "belongs-to" edge is expressed from the parent's side as "one-to-many"; a strict 1:1 pairing (User→Profile) is "one-to-one"; a join across a link table (Student↔Course, Order↔Product) is "many-to-many". BOTH endpoints of every relationship MUST be names of entities you declared above — a relationship to an undeclared entity is a fatal error.
- apiEndpoints: at least ${MIN_API_ENDPOINTS}. Each: method (GET/POST/PATCH/PUT/DELETE), path, purpose, authRequired. Cover the real operations implied by the user stories and entities.
- infrastructure: hosting, database, cache (or null), storage (or null), cicd, environments (at least one), and rationale (at least one point, MUST reference the brief as described above).

## Consistency with stage 1
Honour the assumptions and requirements in the PRD you were given. If stage 1 assumed an auth model, reflect it in an auth-related component and in \`authRequired\` on endpoints. If an NFR demands compliance, the infrastructure choices must be compatible with it (e.g. don't pick a host with no BAA for a HIPAA product).

Do NOT produce a Mermaid diagram or any diagram field — that is derived downstream from your components. Respond ONLY by calling the provided tool.`;

export async function generateArchitectureSection(
  ctx: StageContext & { prd: PrdSection },
): Promise<ArchitectureDraft> {
  const briefText = formatBrief(ctx.brief);
  const prdContext = summarizePrdForArchitecture(ctx.prd);

  return runStage<ArchitectureDraft>({
    model: ctx.model,
    stage: 'architecture',
    toolName: 'emit_architecture',
    toolDescription:
      'Emit the structured architecture (summary, pattern, components, data model, endpoints, infrastructure).',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${briefText}\n\n${prdContext}\n\nDesign the architecture for this product now, via the tool.`,
      },
    ],
    schema: architectureDraftSchema,
    maxTokens: ARCHITECTURE_MAX_TOKENS,
    signal: ctx.signal,
    // Safety net: map natural relationship phrasings ("belongs-to", "has-many",
    // "1:N", …) onto the strict one-to-one|one-to-many|many-to-many enum BEFORE
    // zod validation, so a live generation isn't discarded over cosmetic enum
    // drift. Unmappable values are left to fail-and-re-ask, never guessed.
    repair: repairArchitectureRelationshipKinds,
  });
}

/**
 * Distil the PRD into the context the architecture stage most needs: the
 * overview, the assumptions (which name the entities), the FRs, and the NFRs
 * (which drive infra). We pass the JSON rather than re-prosing it so the model
 * sees the exact requirement text.
 */
function summarizePrdForArchitecture(prd: PrdSection): string {
  return [
    '# PRD from stage 1 (honour this)',
    '',
    '## Overview',
    JSON.stringify(prd.overview, null, 2),
    '',
    '## Assumptions the PRD stage recorded (these name the entities to model)',
    prd.assumptions.map((a) => `- ${a}`).join('\n'),
    '',
    '## Functional requirements',
    prd.functionalRequirements.map((r) => `- [${r.id}] ${r.title}: ${r.detail}`).join('\n'),
    '',
    '## Non-functional requirements (drive infrastructure choices)',
    prd.nonFunctionalRequirements
      .map((r) => `- [${r.category}] ${r.requirement} (why: ${r.rationale})`)
      .join('\n'),
  ].join('\n');
}
