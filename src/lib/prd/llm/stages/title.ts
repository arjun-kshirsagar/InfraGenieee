/**
 * InfraGenie — the document title.
 *
 * SERVER-ONLY. The user never types a title, so we derive a short, human one
 * from the idea and the PRD overview. This is a cheap 4th call on the fast
 * clarify model — it's a handful of output tokens, not worth loading onto a
 * generation-stage prompt.
 */

import { z } from 'zod';

import { documentTitleSchema, type PrdSection, type ProjectBrief } from '@/types/prd';
import { DEFAULT_CLARIFY_MODEL } from '@/lib/prd/generation';
import { runStage } from '@/lib/prd/llm/shared';

const titleToolSchema = z.object({ title: documentTitleSchema });

const SYSTEM_PROMPT = `You name products. Given an idea and its PRD overview, produce a short, specific product title — 2 to 6 words, Title Case, no trailing punctuation, no quotes, no generic words like "App" or "Platform" unless they're genuinely the point. It should read like a real product name a team would put on a repo. Respond ONLY via the tool.`;

/**
 * Derive the title. Uses the fast/cheap model regardless of the generation
 * model, and never blocks the pipeline: on any failure the caller should fall
 * back to a deterministic title rather than fail the whole document over a name.
 */
export async function generateTitle(
  brief: ProjectBrief,
  prd: PrdSection,
  signal?: AbortSignal,
): Promise<string> {
  const { title } = await runStage<{ title: string }>({
    model: DEFAULT_CLARIFY_MODEL,
    stage: 'title',
    toolName: 'emit_title',
    toolDescription: 'Emit a short product title.',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          `Idea: ${brief.idea.trim()}`,
          '',
          `Problem: ${prd.overview.problem}`,
          `Solution: ${prd.overview.solution}`,
          '',
          'Name this product.',
        ].join('\n'),
      },
    ],
    schema: titleToolSchema,
    maxTokens: 100,
    signal,
  });

  return title.trim();
}

/**
 * A deterministic fallback title from the brief, used when the title call
 * fails. Never throws — naming must not sink a good document.
 */
export function fallbackTitle(brief: ProjectBrief): string {
  const words = brief.idea
    .trim()
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const candidate = words.join(' ').slice(0, 80).trim();
  return candidate.length >= 2 ? candidate : 'Untitled Project';
}
