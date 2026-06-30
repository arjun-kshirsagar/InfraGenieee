/**
 * InfraGenie — the adaptive clarifier stage.
 *
 * SERVER-ONLY. Reached only through `generateClarifyingQuestions` in
 * `src/lib/prd/generation.ts`, which is called only from the `/api/prd/clarify`
 * route. Reads `ANTHROPIC_CLARIFY_MODEL` via `resolveClarifyModel`.
 *
 * ## The one job of this file: RESTRAINT
 *
 * We deleted a 7-step questionnaire because making the user enumerate entities,
 * fields, and auth methods is exactly backwards — the AI's value is that IT does
 * that reasoning. This stage must NOT quietly rebuild the questionnaire by
 * asking a pile of questions. The prompt below pushes hard toward asking *few or
 * zero* questions:
 *
 *   - Hard cap of 3 (also schema-enforced via `clarifyResponseSchema`). Typical
 *     is 0–2. Zero is a valid, common, *good* answer.
 *   - Ask only what (a) materially branches the PRD AND (b) cannot be reasonably
 *     inferred or assumed. If a sensible default exists, the model must assume it
 *     (and the generate stage records it in `assumptions[]`) — never ask.
 *   - Never re-ask what the brief already answers: scale, traffic, budget,
 *     timeline, and constraints are supplied inputs. Asking again is a bug.
 *   - Never ask the user to enumerate entities / fields / tables / endpoints.
 *     That is the AI's job; asking is a direct regression to the deleted design.
 *
 * Good question: "Do bakeries manage their own listings, or does your staff?"
 * — it branches the whole permission model, and the idea genuinely doesn't say.
 * Bad question: "What fields does the Order entity need?" — that's the AI's job.
 *
 * Structured output comes back through forced tool use (`callStructured`) and is
 * validated against `clarifyResponseSchema` before it leaves this module, so an
 * over-cap or malformed list can never escape.
 */

import {
  clarifyResponseSchema,
  type BriefContext,
  type ClarifyQuestion,
} from '@/types/prd';

import { z } from 'zod';

import { callStructured } from '@/lib/prd/llm/client';
import { clampStringsToSchema } from '@/lib/prd/llm/normalize';
import { DEFAULT_CLARIFY_MODEL, GenerationError } from '@/lib/prd/generation';

/* -------------------------------------------------------------------------- */
/* Model selection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the model for this stage: an explicit override wins, then the
 * `ANTHROPIC_CLARIFY_MODEL` env var, then the fast default. Kept tiny and pure
 * so tests can assert precedence without touching the network.
 */
export function resolveClarifyModel(override?: string): string {
  return override ?? process.env.ANTHROPIC_CLARIFY_MODEL ?? DEFAULT_CLARIFY_MODEL;
}

/* -------------------------------------------------------------------------- */
/* Tokens — this call is short; the ceiling only guards a runaway list.       */
/* -------------------------------------------------------------------------- */

/** At most 3 short questions; 1024 is generous headroom, not a target. */
const CLARIFY_MAX_TOKENS = 1024;

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = [
  'You are a senior product architect running the ADAPTIVE CLARIFIER step of an',
  'AI PRD generator. The user described a software idea and answered five fixed',
  'context questions (scale, traffic, budget, timeline, constraints). Your ONLY',
  'job now is to decide what — if anything — you still genuinely cannot infer',
  'before you write a full PRD, architecture, and task plan.',
  '',
  'THE DEFAULT ANSWER IS ZERO QUESTIONS. This step replaced a questionnaire we',
  'deliberately deleted. Do not rebuild it. Most ideas need 0–2 questions; asking',
  'the full three should be rare. When in doubt, ask nothing and assume a sensible',
  'default — the generator records every such assumption for the user to review.',
  '',
  'Ask a question ONLY when BOTH are true:',
  '  1. The answer would MATERIALLY BRANCH the PRD (a different answer produces a',
  '     meaningfully different data model, permission model, or architecture), and',
  '  2. You genuinely cannot reasonably infer or assume it from the idea.',
  '',
  'NEVER ask:',
  '  - Anything the brief already answers. Scale, traffic pattern, budget band,',
  '    timeline, and constraints are SUPPLIED. Re-asking them is a bug.',
  '  - The user to enumerate entities, fields, tables, columns, endpoints, or',
  '    data types. Inferring the data model IS your job — asking is forbidden.',
  '  - Which framework / language / database to use unless the constraints make',
  '    it a real fork; otherwise recommend one yourself later.',
  '  - Vague catch-alls like "any other requirements?" or "who are your users?"',
  '    that a competent architect would simply decide.',
  '',
  'A GOOD question branches the whole design and the idea is truly silent on it,',
  'e.g. "Do the bakeries manage their own listings, or does your staff do it?"',
  '(this forks the entire permission model). A BAD question asks for mechanical',
  'detail you should infer, e.g. "What fields does the Order entity need?".',
  '',
  'For each question you DO ask, give a short `why` (one sentence, shown to the',
  'user so the step feels purposeful) and up to 4 concrete `suggestions` rendered',
  'as one-tap chips — the two or three most likely answers, phrased as answers,',
  'not as more questions. Keep every `question` under one sentence.',
  '',
  'Emit your result ONLY through the `emit_clarifying_questions` tool. Return an',
  'empty `questions` array when the idea is already clear enough — that is a',
  'correct, expected, and common outcome.',
].join('\n');

/** Human-readable labels for the enum buckets, so the model sees words not codes. */
const SCALE_LABEL: Record<BriefContext['userScale'], string> = {
  prototype: 'prototype (<100 monthly active users)',
  small: 'small (100–1k MAU)',
  medium: 'medium (1k–50k MAU)',
  large: 'large (50k–500k MAU)',
  'very-large': 'very large (>500k MAU)',
};

const TRAFFIC_LABEL: Record<BriefContext['trafficPattern'], string> = {
  steady: 'steady around the clock',
  'business-hours': 'weekday business-hours peaks',
  spiky: 'unpredictable bursts / spiky',
  seasonal: 'predictable seasonal peaks',
  unknown: 'unknown (assume a reasonable pattern and say so)',
};

const BUDGET_LABEL: Record<BriefContext['budgetBand'], string> = {
  'free-tier': 'free tier ($0/mo)',
  hobby: 'hobby (<$25/mo)',
  startup: 'startup ($25–$250/mo)',
  growth: 'growth ($250–$2k/mo)',
  enterprise: 'enterprise (>$2k/mo)',
};

/**
 * Compose the user message. Everything the model is given about the brief is
 * spelled out here so the prompt can truthfully say "these are already answered
 * — do not re-ask them".
 */
export function buildClarifyUserMessage(idea: string, context: BriefContext): string {
  const lines = [
    'IDEA (the user, in their own words):',
    idea.trim(),
    '',
    'CONTEXT ALREADY PROVIDED — treat every line below as answered. Re-asking any',
    'of it is a bug:',
    `  - Scale: ${SCALE_LABEL[context.userScale]}`,
    `  - Traffic: ${TRAFFIC_LABEL[context.trafficPattern]}`,
    `  - Budget: ${BUDGET_LABEL[context.budgetBand]}`,
    `  - Timeline: ${context.timelineWeeks} week(s) to first launch`,
  ];
  const constraints = context.constraints?.trim();
  lines.push(
    `  - Constraints: ${constraints && constraints.length > 0 ? constraints : '(none stated)'}`,
  );
  lines.push(
    '',
    'Decide what — if anything — you still genuinely cannot infer, and emit it via',
    'the tool. Prefer zero questions.',
  );
  return lines.join('\n');
}

/**
 * JSON Schema for the forced tool. Mirrors `clarifyResponseSchema` (max 3
 * questions, `id`/`question`/`why` required, ≤4 suggestions) so the model is
 * constrained at the wire and the zod parse afterwards is a belt-and-braces
 * check rather than the only line of defence.
 */
export const CLARIFY_TOOL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description:
        'The adaptive questions. Prefer an EMPTY array. At most 3, and only ' +
        'questions that materially branch the PRD and cannot be inferred.',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'A short stable id, e.g. "q1", "q2".',
          },
          question: {
            type: 'string',
            description: 'One concise question. Never asks the user to enumerate entities or fields.',
            maxLength: 300,
          },
          why: {
            type: 'string',
            description:
              'One sentence: why this materially changes the PRD. Shown to the user.',
            maxLength: 200,
          },
          suggestions: {
            type: 'array',
            description:
              'Up to 4 likely answers, phrased as answers, rendered as one-tap chips.',
            maxItems: 4,
            items: { type: 'string', maxLength: 120 },
          },
        },
        required: ['id', 'question', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run the clarifier stage. Returns 0–3 questions; an empty array is valid and
 * common. Delegates all HTTP/error-taxonomy concerns to `callStructured`, which
 * throws `GenerationError` on every failure mode — this function does not catch
 * or reshape those, so the route's mapping stays the single source of truth.
 *
 * The returned array is validated against `clarifyResponseSchema` inside
 * `callStructured` (we pass that schema), so it is guaranteed ≤3 and well-formed.
 */
export async function runClarifyStage(
  idea: string,
  context: BriefContext,
  options?: { model?: string; signal?: AbortSignal },
): Promise<ClarifyQuestion[]> {
  const model = resolveClarifyModel(options?.model);

  // Get the RAW model output (validate only the wire shape via callStructured's
  // internal parse, using an always-pass schema), then clamp any free-text field
  // the model wrote over its `.max()` cap (`why` max 200, `suggestions` items max
  // 120) to the cap BEFORE the real zod parse. Without this a slightly-verbose
  // `why` discards the whole clarify call — the same overflow bug the generation
  // stages hit (t_fd71a759). Clamp is schema-driven, so it stays correct if the
  // caps change.
  const raw = await callStructured<unknown>({
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildClarifyUserMessage(idea, context) }],
    toolName: 'emit_clarifying_questions',
    toolDescription:
      'Emit the adaptive clarifying questions (an empty array is valid and preferred).',
    jsonSchema: CLARIFY_TOOL_JSON_SCHEMA,
    schema: z.unknown(),
    maxTokens: CLARIFY_MAX_TOKENS,
    stage: 'clarify',
    signal: options?.signal,
  });

  const clamped = clampStringsToSchema(clarifyResponseSchema, raw);
  const parsed = clarifyResponseSchema.safeParse(clamped);
  if (!parsed.success) {
    throw new GenerationError(
      'invalid_output',
      `Clarify stage output failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
      { stage: 'clarify' },
    );
  }

  return parsed.data.questions;
}
