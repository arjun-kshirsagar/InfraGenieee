/**
 * MANUAL SMOKE TEST — not part of the automated suite. Makes ONE real Anthropic
 * call to prove `callStructured` works end-to-end against the live API.
 *
 * Cost safety: this hits our paid Anthropic key. Keep it to a single call — do
 * NOT loop or sweep. The unit suite (`src/lib/prd/llm/client.test.ts`) is fully
 * mocked and free; use that for iteration. Run this only to verify the wire
 * format after changing the client.
 *
 * Usage (loads .env.local automatically):
 *   npx tsx --env-file=.env.local scripts/smoke-llm-client.ts
 * or, if tsx isn't installed:
 *   node --env-file=.env.local --experimental-strip-types scripts/smoke-llm-client.ts
 */

import { z } from 'zod';

import { callStructured } from '../src/lib/prd/llm/client';
import { DEFAULT_CLARIFY_MODEL, GenerationError } from '../src/lib/prd/generation';

const schema = z.object({
  entities: z.array(z.string()).min(3),
  primaryUserAction: z.string(),
});

const jsonSchema = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: { type: 'string' },
      description: 'Core data entities you would model for this product.',
    },
    primaryUserAction: {
      type: 'string',
      description: 'The single most important thing a user does in this product.',
    },
  },
  required: ['entities', 'primaryUserAction'],
  additionalProperties: false,
};

async function main() {
  const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_CLARIFY_MODEL;
  console.log(`[smoke] one real call to ${model} …`);

  const result = await callStructured({
    model,
    system:
      'You are a product architect. Infer the data model for the described idea. ' +
      'Respond only through the provided tool.',
    messages: [
      {
        role: 'user',
        content:
          'Idea: a marketplace where local bakeries sell their end-of-day surplus at a discount.',
      },
    ],
    toolName: 'emit_analysis',
    toolDescription: 'Emit the inferred entities and the primary user action.',
    jsonSchema,
    schema,
    maxTokens: 512,
    stage: 'clarify',
  });

  console.log('[smoke] OK — schema-valid structured output:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  if (err instanceof GenerationError) {
    console.error(`[smoke] GenerationError(${err.code}, stage=${err.stage}): ${err.message}`);
  } else {
    console.error('[smoke] unexpected error:', err);
  }
  process.exit(1);
});
