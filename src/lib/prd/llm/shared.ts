/**
 * InfraGenie — shared helpers for the three LLM generation stages.
 *
 * SERVER-ONLY (imports the Anthropic client). Not for client components.
 *
 * Three concerns live here so the stage modules stay focused on prompts:
 *
 *   1. `toInputSchema()`  — turn a zod `*Draft` schema into the JSON Schema the
 *      forced-tool-use call needs. Verified against the live API: Anthropic
 *      accepts `z.toJSONSchema()` draft-7 output (incl. `anyOf` for nullables
 *      and `additionalProperties:false`). No `$ref`/`$defs` appear for our
 *      schemas, which is what keeps it acceptable.
 *
 *   2. `formatBrief()`    — render the full ProjectBrief into the prompt text
 *      every stage sees. Blank clarifier answers are skipped (the schema allows
 *      `answer: ''` to mean "the user declined — infer it").
 *
 *   3. Under-volume retry — `describeVolumeShortfalls()` inspects a zod error
 *      and returns human-readable "you returned N, the minimum is M" lines for
 *      the ONE targeted retry each stage is allowed. Only *min-count* breaches
 *      are treated as retryable-by-extension; every other validation failure is
 *      a hard `invalid_output`.
 */

import { z } from 'zod';

import type { ProjectBrief } from '@/types/prd';
import {
  USER_SCALE_LABEL,
  TRAFFIC_PATTERN_LABEL,
  BUDGET_BAND_LABEL,
} from '@/types/prd';
import { callStructured } from '@/lib/prd/llm/client';
import { clampStringsToSchema } from '@/lib/prd/llm/normalize';
import { GenerationError, type GenerationError as GenerationErrorType } from '@/lib/prd/generation';

/* -------------------------------------------------------------------------- */
/* JSON Schema for forced tool use                                            */
/* -------------------------------------------------------------------------- */

/**
 * Derive the tool `input_schema` from a zod draft schema.
 *
 * We use `z.toJSONSchema` (zod v4) targeting draft-7. This was verified to be
 * accepted by Anthropic's `tools[].input_schema` with a real call — the output
 * contains only `type`/`properties`/`required`/`enum`/`anyOf`/`items` and
 * `additionalProperties`, none of the constructs Anthropic rejects.
 *
 * `superRefine`-based schemas (dataModel, plan) reduce to their base object
 * shape in JSON Schema — the refinements are semantic and can't be expressed in
 * JSON Schema anyway; they're enforced by the zod parse in `callStructured`,
 * not by the model-facing schema. That's fine: the schema guides the model, the
 * zod parse is the gate.
 */
export function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  // draft-7 is the target we verified against the live API. The option-object
  // typings drift across zod minor versions, so we cast the options only.
  return z.toJSONSchema(schema, {
    target: 'draft-7',
  } as Parameters<typeof z.toJSONSchema>[1]) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Brief → prompt text                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Render the full brief as prompt text. Every stage receives this verbatim so
 * the model always reasons from the same complete context. Empty optional
 * fields are omitted rather than rendered as "none", to keep the prompt tight
 * and avoid the model treating "(none)" as a meaningful signal.
 */
export function formatBrief(brief: ProjectBrief): string {
  const { context } = brief;
  const lines: string[] = [];

  lines.push('# Project brief');
  lines.push('');
  lines.push('## Idea (the user, in their own words)');
  lines.push(brief.idea.trim());
  lines.push('');
  lines.push('## Context');
  lines.push(`- Expected scale: ${USER_SCALE_LABEL[context.userScale]}`);
  lines.push(`- Traffic pattern: ${TRAFFIC_PATTERN_LABEL[context.trafficPattern]}`);
  lines.push(`- Budget: ${BUDGET_BAND_LABEL[context.budgetBand]}`);
  lines.push(`- Timeline: ${context.timelineWeeks} week(s) to first ship`);
  if (context.constraints && context.constraints.trim()) {
    lines.push(`- Hard constraints (override defaults): ${context.constraints.trim()}`);
  }

  const answered = brief.clarifications.filter((c) => c.answer.trim().length > 0);
  if (answered.length > 0) {
    lines.push('');
    lines.push('## Clarifying Q&A (the user answered these)');
    for (const c of answered) {
      lines.push(`- Q: ${c.question.trim()}`);
      lines.push(`  A: ${c.answer.trim()}`);
    }
  }

  // Note the questions the user was asked but skipped — the model should infer
  // these itself and record the decision in `assumptions`.
  const skipped = brief.clarifications.filter((c) => c.answer.trim().length === 0);
  if (skipped.length > 0) {
    lines.push('');
    lines.push('## Clarifiers the user SKIPPED (infer these yourself, and record the assumption)');
    for (const c of skipped) {
      lines.push(`- ${c.question.trim()}`);
    }
  }

  if (brief.additionalNotes && brief.additionalNotes.trim()) {
    lines.push('');
    lines.push('## Additional notes from the user');
    lines.push(brief.additionalNotes.trim());
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Under-volume detection for the single targeted retry                       */
/* -------------------------------------------------------------------------- */

/**
 * A human-readable description of one min-count shortfall in the model output.
 * `path` is the dotted zod path (e.g. `functionalRequirements`); `have`/`need`
 * are the counts; `label` is a friendly noun for the prompt.
 */
export interface VolumeShortfall {
  path: string;
  have: number;
  need: number;
  label: string;
  /** The zod issue's own message, used verbatim when it's more precise than
   *  the derived have/need (e.g. the plan's total-task floor, whose count is
   *  not simply the length of the array at `path`). */
  note?: string;
}

/**
 * Inspect a failed zod parse and extract *only* array-min-length shortfalls —
 * the class of failure that a targeted "return the full set" retry can fix.
 *
 * Zod emits `too_small` issues with `type: 'array'`, `minimum: M`, and
 * (in v4) `origin: 'array'`. We read the actual array length from `value` at
 * the issue's path so the retry can say "you returned 6, the minimum is 8".
 *
 * If this returns an empty array, the failure was NOT a simple under-volume
 * one (a bad enum, a missing field, a duplicate id, a dangling edge …) and the
 * caller must treat it as a hard `invalid_output` with NO retry — extending a
 * list won't fix a structural error.
 */
export function describeVolumeShortfalls(
  error: z.ZodError,
  value: unknown,
): VolumeShortfall[] {
  const shortfalls: VolumeShortfall[] = [];

  for (const issue of error.issues) {
    // Only array-cardinality floors are extend-retryable.
    const isArrayTooSmall =
      issue.code === 'too_small' &&
      // zod v4 uses `origin`; be liberal and also accept the older `type`.
      ((issue as { origin?: string }).origin === 'array' ||
        (issue as { type?: string }).type === 'array');
    if (!isArrayTooSmall) continue;

    const need = Number((issue as { minimum?: number }).minimum ?? 0);
    const path = issue.path.map(String).join('.');
    const arr = getAtPath(value, issue.path);
    const have = Array.isArray(arr) ? arr.length : 0;

    // Normally the array at `path` IS the counted collection, so `have`/`need`
    // are accurate and we build a friendly "you returned N, the minimum is M"
    // line. But the plan stage reports its FLATTENED task floor on the
    // `milestones` path — there, the array length (milestone count) disagrees
    // with `need` (task count), so we carry the issue's own message verbatim.
    const arrLen = Array.isArray(arr) ? arr.length : 0;
    const lengthMismatch = arrLen !== need && arrLen === have && path === 'milestones';
    const note = lengthMismatch ? issue.message : undefined;

    shortfalls.push({ path, have, need, label: friendlyLabel(path), note });
  }

  return shortfalls;
}

/**
 * True when EVERY issue in the error is an extend-retryable array shortfall.
 * A mixed error (one shortfall + one structural problem) is NOT retryable,
 * because the retry prompt only asks the model to lengthen lists.
 */
export function isPurelyUnderVolume(error: z.ZodError): boolean {
  return error.issues.every(
    (issue) =>
      issue.code === 'too_small' &&
      ((issue as { origin?: string }).origin === 'array' ||
        (issue as { type?: string }).type === 'array'),
  );
}

/* -------------------------------------------------------------------------- */
/* Stringified-array coercion (recover a paid generation, zero extra calls)    */
/* -------------------------------------------------------------------------- */

/**
 * Some model runs return a container field as a JSON-**stringified** array
 * (e.g. `milestones: "[{...}]"`) instead of a real array. The content is
 * correct — only the envelope is wrong — so the whole generation is fully
 * recoverable with a single `JSON.parse()` at the offending path. Zod reports
 * this as an `invalid_type` issue with `expected: 'array'` on a value that is a
 * string, which the under-volume detector (rightly) does NOT classify as
 * retryable. Rather than discard a complete, already-paid-for generation, we
 * repair it in place before declaring the stage terminal.
 *
 * Observed live twice on real generations (plan.milestones, prd.functional-
 * Requirements); see MAJOR-1 in docs/qa-feature-1.md.
 *
 * This is a single, bounded, deterministic repair — NOT a retry. It makes no
 * upstream call and never loops: each candidate path is parsed at most once.
 */
export interface CoercionResult {
  /** A shallow-cloned copy of `value` with parseable string arrays replaced. */
  coerced: unknown;
  /** Dotted paths that were successfully JSON.parse()'d into arrays. */
  paths: string[];
}

/**
 * Detect and repair JSON-stringified arrays reported by a failed zod parse.
 *
 * For every issue that is `invalid_type` expecting an `array` where the value
 * at that path is actually a `string`, attempt exactly one `JSON.parse()`. If
 * it yields an array, set it back on a cloned copy of `value`. Returns the
 * repaired copy and the list of repaired paths, or `null` when nothing was
 * coercible (so the caller falls through to its normal terminal handling).
 *
 * The parse is defensive: a string that doesn't parse, or parses to a non-array,
 * is left untouched — we never fabricate structure the model didn't emit.
 */
export function coerceStringifiedArrays(
  error: z.ZodError,
  value: unknown,
): CoercionResult | null {
  const candidates: PropertyKey[][] = [];
  for (const issue of error.issues) {
    const isArrayTypeMiss =
      issue.code === 'invalid_type' &&
      (issue as { expected?: string }).expected === 'array';
    if (!isArrayTypeMiss) continue;
    const at = getAtPath(value, issue.path);
    if (typeof at !== 'string') continue;
    candidates.push(issue.path);
  }
  if (candidates.length === 0) return null;

  let working = value;
  const paths: string[] = [];
  for (const path of candidates) {
    const raw = getAtPath(working, path);
    if (typeof raw !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // not valid JSON — leave it, this path stays broken
    }
    if (!Array.isArray(parsed)) continue; // parsed to something else — don't touch
    working = setAtPath(working, path, parsed);
    paths.push(path.map(String).join('.'));
  }

  if (paths.length === 0) return null;
  return { coerced: working, paths };
}

/** Build the targeted retry instruction the stage appends as a follow-up. */
export function buildRetryInstruction(shortfalls: VolumeShortfall[]): string {
  const lines = shortfalls.map((s) =>
    s.note
      ? `- ${s.note} Return the FULL set of at least ${s.need}, keeping what you already wrote and adding genuinely new, non-duplicate items.`
      : `- You returned ${s.have} ${s.label}; the minimum is ${s.need}. ` +
        `Return the FULL set of at least ${s.need}, keeping the ones you already wrote and adding genuinely new, non-duplicate items.`,
  );
  return (
    'Your previous response was under the required minimum on one or more lists. ' +
    'Fix ONLY the counts below — keep everything else identical in spirit, and do not ' +
    'pad with filler; each new item must be specific and buildable:\n' +
    lines.join('\n')
  );
}

/* -------------------------------------------------------------------------- */
/* internals                                                                  */
/* -------------------------------------------------------------------------- */

function getAtPath(root: unknown, path: PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

/**
 * Return a copy of `root` with the value at `path` replaced by `next`, cloning
 * only the objects/arrays along the path (structural sharing elsewhere). Never
 * mutates the input. Used by `coerceStringifiedArrays` so the raw model output
 * is left intact for logging while a repaired copy is re-validated.
 */
function setAtPath(root: unknown, path: PropertyKey[], next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  const child =
    root != null && typeof root === 'object'
      ? (root as Record<PropertyKey, unknown>)[head]
      : undefined;
  const nextChild = setAtPath(child, rest, next);
  if (Array.isArray(root)) {
    const clone = [...(root as unknown[])] as unknown[];
    clone[head as number] = nextChild;
    return clone;
  }
  const clone: Record<PropertyKey, unknown> = { ...(root as Record<PropertyKey, unknown>) };
  clone[head] = nextChild;
  return clone;
}

/** Map a dotted zod path to a readable noun for the retry prompt. */
function friendlyLabel(path: string): string {
  const leaf = path.split('.').pop() ?? path;
  const map: Record<string, string> = {
    goals: 'goals',
    nonGoals: 'non-goals',
    userStories: 'user stories',
    functionalRequirements: 'functional requirements',
    nonFunctionalRequirements: 'non-functional requirements',
    successMetrics: 'success metrics',
    risks: 'risks',
    assumptions: 'assumptions',
    components: 'architecture components',
    entities: 'data-model entities',
    apiEndpoints: 'API endpoints',
    milestones: 'milestones',
    tasks: 'plan tasks',
    valueProposition: 'value-proposition points',
    acceptanceCriteria: 'acceptance criteria',
    rationale: 'infrastructure rationale points',
  };
  return map[leaf] ?? leaf;
}

/* -------------------------------------------------------------------------- */
/* runStage — one call, validate, exactly one under-volume retry, then fail    */
/* -------------------------------------------------------------------------- */

type StageName = NonNullable<GenerationErrorType['stage']>;

export interface RunStageOptions<T> {
  model: string;
  stage: StageName;
  toolName: string;
  toolDescription: string;
  system: string;
  /** The initial user turn(s) for the call. */
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Zod schema that both validates output and derives the tool input_schema. */
  schema: z.ZodType<T>;
  maxTokens: number;
  signal?: AbortSignal;
  /**
   * Optional deterministic repair applied to the RAW model output BEFORE every
   * `schema.safeParse` (first attempt AND the extend-retry). Use it to map
   * common model synonyms onto strict enum values without loosening the schema
   * — e.g. the architecture stage rewrites relationship `kind` values like
   * "belongs-to"/"has-many" to the one-to-one|one-to-many|many-to-many enum.
   *
   * Contract: PURE and bounded (no network, no loop). Must return a value of
   * the same shape (a shallow-cloned copy is expected; never mutate the input).
   * It should leave already-valid and genuinely-unmappable values untouched so
   * that a truly bad value still fails validation and triggers the single
   * re-ask rather than being silently guessed. Defaults to identity.
   */
  repair?: (raw: unknown) => unknown;
}

/**
 * Run one generation stage with the project's retry policy:
 *
 *   1. Call the model once via forced tool use, validating the result with
 *      `schema`.
 *   2. If it fails and the failure is PURELY an array-min-count shortfall,
 *      issue exactly ONE targeted "extend this" retry — re-sending the same
 *      system prompt, the model's previous (invalid) output as an assistant
 *      turn, and a follow-up user turn naming the exact shortfalls.
 *   3. If the retry also fails, or the first failure was structural (bad enum,
 *      missing field, duplicate id, dangling edge …), throw `invalid_output`.
 *
 * There is EXACTLY one retry. This never loops.
 *
 * `callStructured` already validates internally and throws `invalid_output` on
 * a schema failure — but it doesn't distinguish under-volume from structural,
 * and it can't do a semantic retry. So here we ask it for the RAW model output
 * (via an always-passing pass-through schema) and run our own zod parse, which
 * lets us inspect the error and decide whether to extend-retry.
 */
export async function runStage<T>(opts: RunStageOptions<T>): Promise<T> {
  const jsonSchema = toInputSchema(opts.schema);
  // Deterministic pre-validation repair, applied to the RAW model output before
  // every safeParse. TWO layers, composed:
  //   1. Schema-driven length clamp (ALWAYS on) — truncate any model-generated
  //      free-text string that overflowed its `.max()` cap, so a verbose but
  //      otherwise-good generation isn't discarded over a few extra characters.
  //      Covers every capped field in every stage automatically (t_fd71a759).
  //   2. The stage's own optional repair (e.g. relationship-kind enum mapping).
  // Clamp first, then the stage repair, then validate.
  const stageRepair = opts.repair ?? ((raw: unknown) => raw);
  const repair = (raw: unknown): unknown =>
    stageRepair(clampStringsToSchema(opts.schema, raw));

  // First attempt — get the raw tool_use.input without letting callStructured's
  // own zod gate collapse under-volume and structural failures together.
  const raw1 = repair(
    await callStructured<unknown>({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      toolName: opts.toolName,
      toolDescription: opts.toolDescription,
      jsonSchema,
      schema: z.unknown(),
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      stage: opts.stage,
    }),
  );

  const parsed1 = opts.schema.safeParse(raw1);
  if (parsed1.success) return parsed1.data;

  // Recover a JSON-stringified container field WITHOUT a second call. A model
  // that returned e.g. `milestones: "[...]"` produced correct content in a
  // wrong envelope; JSON.parse()-ing the offending path(s) once and re-
  // validating salvages the whole (already-paid-for) generation. Bounded and
  // non-looping: each path is parsed at most once, no upstream call is made.
  //
  // If the coerced value validates, we're done in one call. If it still fails,
  // the envelope was fixed but the content is genuinely off (e.g. also under-
  // volume) — we adopt the coerced value + its error as the basis for the
  // normal under-volume/terminal handling, so the single retry (if any) feeds
  // back an envelope-correct assistant turn rather than the stringified one.
  let effectiveOutput: unknown = raw1;
  let effectiveError: z.ZodError = parsed1.error;
  const coercion = coerceStringifiedArrays(parsed1.error, raw1);
  if (coercion) {
    const reparsed = opts.schema.safeParse(coercion.coerced);
    if (reparsed.success) {
      console.info(
        '[prd.llm] stage=%s recovered stringified-array field(s) via JSON.parse (no retry): %s',
        opts.stage,
        coercion.paths.join(', '),
      );
      return reparsed.data;
    }
    console.info(
      '[prd.llm] stage=%s coerced stringified-array field(s) but content still invalid; ' +
        'continuing with the repaired envelope: %s',
      opts.stage,
      coercion.paths.join(', '),
    );
    effectiveOutput = coercion.coerced;
    effectiveError = reparsed.error;
  }

  // Only extend-retry a pure under-volume miss. Anything structural is terminal.
  if (!isPurelyUnderVolume(effectiveError)) {
    throw new GenerationError(
      'invalid_output',
      `Stage "${opts.stage}" output failed schema validation: ${summarizeIssues(effectiveError)}`,
      { stage: opts.stage },
    );
  }

  const shortfalls = describeVolumeShortfalls(effectiveError, effectiveOutput);
  console.info(
    '[prd.llm] stage=%s under-volume on first attempt (%s); issuing exactly one extend-retry',
    opts.stage,
    shortfalls.map((s) => `${s.path}:${s.have}<${s.need}`).join(', '),
  );

  // Second (and final) attempt — feed the previous output back and ask for the
  // full set. We include the previous JSON as an assistant turn so the model
  // extends rather than regenerates from scratch.
  const raw2 = repair(
      await callStructured<unknown>({
        model: opts.model,
        messages: [
          ...opts.messages,
          { role: 'assistant', content: JSON.stringify(effectiveOutput) },
          { role: 'user', content: buildRetryInstruction(shortfalls) },
        ],
        system: opts.system,
        toolName: opts.toolName,
        toolDescription: opts.toolDescription,
        jsonSchema,
        schema: z.unknown(),
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        stage: opts.stage,
      }),
    );

  const parsed2 = opts.schema.safeParse(raw2);
  if (parsed2.success) return parsed2.data;

  // The retry can also fumble the envelope — recover a stringified array here
  // too. Still zero extra calls; still not a second retry.
  const coercion2 = coerceStringifiedArrays(parsed2.error, raw2);
  if (coercion2) {
    const reparsed2 = opts.schema.safeParse(coercion2.coerced);
    if (reparsed2.success) {
      console.info(
        '[prd.llm] stage=%s recovered stringified-array field(s) via JSON.parse on retry (no further call): %s',
        opts.stage,
        coercion2.paths.join(', '),
      );
      return reparsed2.data;
    }
  }

  // One retry, and it still failed. Stop — do not loop.
  throw new GenerationError(
    'invalid_output',
    `Stage "${opts.stage}" still failed schema validation after one extend-retry: ${summarizeIssues(parsed2.error)}`,
    { stage: opts.stage },
  );
}

/** Compact, log-safe summary of a zod error (shape only, never user data). */
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}
