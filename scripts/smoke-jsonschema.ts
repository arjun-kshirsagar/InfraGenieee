/**
 * MANUAL SMOKE TEST — verifies z.toJSONSchema() output is accepted by Anthropic
 * as a tool input_schema, and that callStructured returns schema-valid data.
 *
 * ONE real call. Cost safety: hits our paid key. Do NOT loop.
 *   npx tsx --env-file=.env.local scripts/smoke-jsonschema.ts
 */
import { z } from 'zod';
import { callStructured } from '../src/lib/prd/llm/client';
import { planDraftSchema } from '../src/types/prd';
import { DEFAULT_CLARIFY_MODEL, GenerationError } from '../src/lib/prd/generation';

async function main() {
  const jsonSchema = z.toJSONSchema(planDraftSchema as unknown as z.ZodType, {
    target: 'draft-7',
  } as never) as Record<string, unknown>;

  const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_CLARIFY_MODEL;
  console.log(`[smoke] one real call to ${model} with a z.toJSONSchema-derived tool schema …`);

  const result = await callStructured({
    model,
    system:
      'You are a senior engineer. Emit a tiny task plan through the tool. ' +
      'At least 3 milestones, each with at least 1 task. Keep it minimal — this is a wire test.',
    messages: [
      { role: 'user', content: 'Idea: a URL shortener. Emit a minimal milestone/task plan.' },
    ],
    toolName: 'emit_plan',
    toolDescription: 'Emit the milestones and tasks for the plan.',
    jsonSchema,
    schema: planDraftSchema,
    maxTokens: 2000,
    stage: 'plan',
  });

  console.log('[smoke] OK — schema-valid. milestones:', result.milestones.length);
  console.log(
    '[smoke] first milestone:',
    result.milestones[0].name,
    '— tasks:',
    result.milestones[0].tasks.length,
  );
}

main().catch((err) => {
  if (err instanceof GenerationError) {
    console.error('[smoke] GenerationError:', err.code, '-', err.message);
  } else {
    console.error('[smoke] unexpected error:', err);
  }
  process.exitCode = 1;
});
