/**
 * InfraGenie — Stage 1: the PRD section.
 *
 * SERVER-ONLY. Reasons out the product requirements from the brief alone:
 * overview, goals, user stories, functional & non-functional requirements,
 * success metrics, risks, and — critically — the ASSUMPTIONS the model made
 * where the user was silent (entities, auth model, fulfilment, etc.).
 *
 * Prompt quality is the product. The system prompt below is the actual work of
 * this stage: it establishes the role, states every floor, and demands the
 * output be concrete enough to hand to a coding agent.
 */

import { prdDraftSchema, type PrdSection } from '@/types/prd';
import {
  MIN_GOALS,
  MIN_USER_STORIES,
  MIN_FUNCTIONAL_REQUIREMENTS,
  MIN_NON_FUNCTIONAL_REQUIREMENTS,
  MIN_SUCCESS_METRICS,
  MIN_RISKS,
} from '@/types/prd';
import type { StageContext } from '@/lib/prd/generation';
import { formatBrief, runStage } from '@/lib/prd/llm/shared';

/** Tokens for stage 1. The PRD section is prose-heavy and a large enterprise
 *  brief (many stories, FRs, NFRs, thorough assumptions) can exceed 8k output
 *  tokens — a truncation maps to invalid_output, so give it generous headroom.
 *  Verified: a very-large enterprise PRD truncated at 8k but completes under 16k. */
const PRD_MAX_TOKENS = 16000;

const SYSTEM_PROMPT = `You are a senior staff product engineer. You write Product Requirements Documents (PRDs) that another AI CODING AGENT will implement directly, with no human in the loop to fill gaps. Every sentence you write is an instruction that agent will follow, so it must be concrete, specific to THIS idea, and buildable — never generic filler, never "the system should be scalable" boilerplate.

You are given a short brief: an idea in the user's own words, plus a handful of context answers (scale, traffic, budget, timeline, constraints) and optionally some clarifying Q&A. The user has NOT enumerated entities, fields, auth, or integrations — inferring those is your job, and doing it well is the entire value of this document.

## Your task: produce the PRD section
Reason out the product from the idea. Be opinionated and decisive: where the brief is silent, DECIDE, then record that decision honestly in \`assumptions\`. A downstream reader must be able to see exactly what you invented on the user's behalf.

## Hard requirements — the document is rejected below any of these floors:
- overview: problem, solution, targetUsers, and at least one valueProposition point. Make the problem statement specific to the idea, not a restatement of it.
- goals: at least ${MIN_GOALS}. Concrete, outcome-oriented (what success looks like), not activities.
- nonGoals: at least 1. Name what this product deliberately will NOT do in v1.
- userStories: at least ${MIN_USER_STORIES}. Each: asA / iWant / soThat, a priority (p0/p1/p2), and at least one testable acceptanceCriteria. Cover the real primary flows of THIS product, not CRUD placeholders.
- functionalRequirements: at least ${MIN_FUNCTIONAL_REQUIREMENTS}. Each: id, title, detail, priority. Specific behaviours the system must exhibit.
- nonFunctionalRequirements: at least ${MIN_NON_FUNCTIONAL_REQUIREMENTS}. Each: a category (performance/scalability/security/availability/observability/compliance/cost), the requirement, and a rationale. Ground the rationale in the brief's scale/traffic/budget/constraints — e.g. if the brief says HIPAA, a compliance NFR is mandatory; if it's a free-tier prototype, don't over-engineer availability.
- successMetrics: at least ${MIN_SUCCESS_METRICS}. Measurable.
- risks: at least ${MIN_RISKS}. Each: risk, impact (p0/p1/p2), mitigation.
- openQuestions: things a human should decide later (may be empty, but prefer naming real ones).
- assumptions: at least 1, but be thorough. This is a FIRST-CLASS output. List the concrete decisions you made that the user did not specify: the core data entities you're assuming, the auth model, the fulfilment/interaction model, key third-party choices, and anything else you inferred. Later stages depend on these — the architecture stage will build the data model from the entities you assume here, so name them.

## Style
- Use ids that are short and stable (US-1, FR-1, NFR-1 …). Later stages and the reader will reference them.
- Prefer 6–10 user stories and 8–14 functional requirements for a real product; the minimums are floors, not targets.
- Never emit lorem-ipsum, "Item", "Thing", or "User/Entity" placeholder nouns. Use the real domain vocabulary of the idea.

Respond ONLY by calling the provided tool with the structured PRD. Do not write prose outside the tool call.`;

export async function generatePrdSection(ctx: StageContext): Promise<PrdSection> {
  const briefText = formatBrief(ctx.brief);

  return runStage<PrdSection>({
    model: ctx.model,
    stage: 'prd',
    toolName: 'emit_prd',
    toolDescription:
      'Emit the structured PRD section (overview, goals, stories, requirements, metrics, risks, assumptions).',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${briefText}\n\nProduce the PRD section for this product now, via the tool.`,
      },
    ],
    schema: prdDraftSchema,
    maxTokens: PRD_MAX_TOKENS,
    signal: ctx.signal,
  });
}
