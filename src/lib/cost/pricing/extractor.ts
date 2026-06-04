/**
 * InfraGenie — the LLM price extractor for the Tavily-sourced providers
 * (GCP / Vercel / DigitalOcean), whose real markdown price tables Tavily returns
 * fine (docs §4). SERVER-ONLY.
 *
 * ## What it does
 *
 * Given ONE fetched page and the list of `{skuId, dimensionId, extractionHint}`
 * that the catalog says this page should price, it makes exactly ONE
 * `callStructured` call (reusing `src/lib/prd/llm/client.ts` — we do NOT open a
 * second Anthropic client) that forces a tool returning
 *
 *     { skuId, dimensionId, unitPriceUsd, includedQuantity?, evidence }[]
 *
 * Every candidate is then run through the SAME evidence gate as the feed path
 * (`assertEvidenceSupportsPrice`) by `build.ts` — this module only *proposes*
 * numbers; it never certifies them. A hallucinated price cannot survive the
 * gate's substring+number proof against the real page markdown, so a fast model
 * is the correct choice here (docs §5, `DEFAULT_PRICE_EXTRACTOR_MODEL` = haiku):
 * hallucination is caught by arithmetic, not by paying for a bigger model.
 *
 * ## The prompt's load-bearing instructions
 *
 * - `evidence` MUST be copied VERBATIM from the page. A paraphrase is rejected
 *   downstream (the gate does a literal substring test), so paraphrasing is not
 *   "close enough" — it is a discarded record. We say this explicitly.
 * - Emitting NOTHING for a dimension it cannot find is CORRECT and expected. A
 *   model that feels obliged to answer will invent, and the gate will discard it
 *   — a gap is more honest and cheaper. We say this explicitly too.
 * - `includedQuantity` is emitted ONLY when the page states a free allowance. An
 *   assumed free tier is a fabricated discount (docs §7).
 *
 * The extractor is deliberately page-scoped: one call per distinct pricing URL,
 * so a page that prices several SKUs is read once. `build.ts` owns the grouping.
 */

import { GenerationError } from '@/lib/prd/generation';
import { callStructured } from '@/lib/prd/llm/client';
import { z } from 'zod';

import { PricingError, DEFAULT_PRICE_EXTRACTOR_MODEL, type FetchedPage } from '../pricing-seam';

/** One dimension the caller wants a price for, as fed to the extractor. */
export interface ExtractionTarget {
  skuId: string;
  dimensionId: string;
  /** The catalog `PriceDimension.extractionHint` — pins the exact row. */
  extractionHint: string;
  /** Display unit, e.g. `USD / hour`. Given to the model as context only. */
  unit?: string;
}

/** A candidate price the model proposed. UNVERIFIED until the gate runs. */
export interface ExtractedCandidate {
  skuId: string;
  dimensionId: string;
  unitPriceUsd: number;
  /** Free allowance the page states, in the same unit. 0 when none stated. */
  includedQuantity: number;
  /** The model's claimed verbatim excerpt. The gate proves this downstream. */
  evidence: string;
}

/**
 * The tool schema the model must satisfy. Kept permissive on values (a negative
 * or absurd price is caught by the gate / the price-book schema, not here) but
 * strict on SHAPE so a malformed tool call fails `callStructured`'s own zod
 * check rather than producing junk we would then have to defend against.
 */
const extractedCandidateSchema = z.object({
  skuId: z.string().min(1),
  dimensionId: z.string().min(1),
  unitPriceUsd: z.number(),
  /** Optional — omitted unless the page states a free allowance. */
  includedQuantity: z.number().min(0).optional(),
  evidence: z.string().min(1).max(600),
});

const extractorOutputSchema = z.object({
  prices: z.array(extractedCandidateSchema),
});

type ExtractorOutput = z.infer<typeof extractorOutputSchema>;

/** JSON Schema mirror of `extractorOutputSchema` for the forced tool. */
const EXTRACTOR_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['prices'],
  properties: {
    prices: {
      type: 'array',
      description:
        'One entry per (skuId, dimensionId) you could find a real price for on the page. ' +
        'OMIT any dimension whose price you cannot find verbatim — do not guess.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['skuId', 'dimensionId', 'unitPriceUsd', 'evidence'],
        properties: {
          skuId: { type: 'string', description: 'Copy exactly from the requested target.' },
          dimensionId: {
            type: 'string',
            description: 'Copy exactly from the requested target.',
          },
          unitPriceUsd: {
            type: 'number',
            description:
              'The numeric USD price for this dimension. It MUST appear literally inside `evidence`.',
          },
          includedQuantity: {
            type: 'number',
            description:
              'ONLY if the page states a free allowance for this dimension (in the same unit as the price). ' +
              'Omit entirely if the page states no free allowance — an assumed free tier is a fabricated discount.',
          },
          evidence: {
            type: 'string',
            description:
              'A VERBATIM substring copied from the page that contains unitPriceUsd. ' +
              'A paraphrase or reconstruction will be rejected by a literal substring check. Max ~600 chars.',
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  'You extract vendor prices from a pricing page rendered as markdown.',
  '',
  'You will be given (1) the page markdown and (2) a list of price DIMENSIONS to find,',
  'each with a skuId, a dimensionId and an extractionHint that pins the exact row/plan/size.',
  '',
  'For each dimension you can find, return one entry with:',
  '  - skuId, dimensionId: copied EXACTLY from the requested target.',
  '  - unitPriceUsd: the numeric USD price for that dimension.',
  '  - evidence: a VERBATIM substring of the page markdown that contains that number.',
  '  - includedQuantity: ONLY if the page states a free allowance for this dimension.',
  '',
  'HARD RULES — these are enforced by a downstream machine check, not by trust:',
  '1. `evidence` MUST be copied verbatim from the page. A paraphrase, a reformatted',
  '   table row, or a reconstructed sentence WILL BE REJECTED by a literal substring',
  '   test and your work discarded. Copy the exact characters, including the $ and any',
  '   surrounding words/pipes from the table.',
  '2. `unitPriceUsd` MUST appear literally inside your `evidence` string. If the number',
  '   you want to report is not present verbatim in the excerpt you copy, you have the',
  '   wrong excerpt.',
  '3. Emitting NOTHING for a dimension you cannot confidently find is CORRECT and',
  '   expected. Do NOT invent, approximate, or infer a price. A gap is honest; a guess',
  '   is a bug. Under-answering is always better than answering wrong.',
  '4. includedQuantity: emit it ONLY when the page explicitly states a free/included',
  '   allowance. Never assume a free tier.',
  '5. Report the price in the unit the dimension asks for (per hour, per GB-month, per',
  '   million requests, etc.). Match the hint. Do not convert between units.',
].join('\n');

/**
 * Cap the page markdown we send to the model. Real vendor pricing pages are
 * 10–35 KB (docs §4); a hostile or unexpectedly huge page is truncated so one
 * bad URL cannot blow the token budget. The gate later checks evidence against
 * the FULL page (`build.ts` keeps the untruncated `FetchedPage`), so truncation
 * here can only cause a miss (honest gap), never a wrong acceptance.
 */
const MAX_PAGE_CHARS = 120_000;

/** Budget for the tool output. Enough for dozens of candidates on one page. */
const MAX_OUTPUT_TOKENS = 4096;

function buildUserMessage(page: FetchedPage, targets: ExtractionTarget[]): string {
  const targetLines = targets
    .map(
      (t) =>
        `- skuId: ${t.skuId}\n  dimensionId: ${t.dimensionId}${
          t.unit ? `\n  unit: ${t.unit}` : ''
        }\n  find: ${t.extractionHint}`,
    )
    .join('\n');

  const markdown =
    page.markdown.length > MAX_PAGE_CHARS
      ? `${page.markdown.slice(0, MAX_PAGE_CHARS)}\n\n[…page truncated…]`
      : page.markdown;

  return [
    `PAGE URL: ${page.url}`,
    '',
    'DIMENSIONS TO PRICE (omit any you cannot find verbatim):',
    targetLines,
    '',
    '--- BEGIN PAGE MARKDOWN ---',
    markdown,
    '--- END PAGE MARKDOWN ---',
  ].join('\n');
}

/**
 * Extract candidate prices for one page. Makes exactly one `callStructured`
 * call. Returns UNVERIFIED candidates — `build.ts` runs each through the
 * evidence gate. Candidates whose (skuId, dimensionId) was not requested are
 * dropped defensively (the model occasionally echoes a target it invented).
 *
 * @throws {PricingError} `not_configured` (no ANTHROPIC_API_KEY) or
 *   `unavailable` (upstream). A schema failure from the model surfaces as
 *   `invalid_output`. The caller (`build.ts`) catches these per-page and turns
 *   the page's dimensions into `fetch_failed`/gap results — one failing page
 *   never sinks the whole book.
 */
export async function extractPrices(
  page: FetchedPage,
  targets: ExtractionTarget[],
  options?: { model?: string; signal?: AbortSignal },
): Promise<ExtractedCandidate[]> {
  if (targets.length === 0) return [];

  const model = options?.model ?? DEFAULT_PRICE_EXTRACTOR_MODEL;

  let output: ExtractorOutput;
  try {
    output = await callStructured<ExtractorOutput>({
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(page, targets) }],
      toolName: 'report_prices',
      toolDescription:
        'Report the prices you found on the page, one per dimension. Omit dimensions you cannot find verbatim.',
      jsonSchema: EXTRACTOR_JSON_SCHEMA,
      schema: extractorOutputSchema,
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: options?.signal,
      // `stage` is a fixed union in the PRD generation taxonomy; we omit it so
      // `callStructured` labels logs with the toolName (`report_prices`) instead.
    });
  } catch (err) {
    // Map the PRD generation error taxonomy onto the pricing one so callers only
    // ever handle `PricingError`. The underlying cause is preserved for logs.
    if (err instanceof GenerationError) {
      const code =
        err.code === 'not_configured'
          ? 'not_configured'
          : err.code === 'invalid_output'
            ? 'invalid_output'
            : 'unavailable';
      throw new PricingError(code, `Price extractor failed: ${err.message}`, { cause: err });
    }
    throw new PricingError('unavailable', 'Price extractor failed with an unexpected error.', {
      cause: err,
    });
  }

  // Defensive: only keep candidates for dimensions we actually asked about. A
  // model that echoes an invented (skuId, dimensionId) would otherwise inject a
  // record the catalog has no home for.
  const requested = new Set(targets.map((t) => `${t.skuId}|${t.dimensionId}`));
  return output.prices
    .filter((p) => requested.has(`${p.skuId}|${p.dimensionId}`))
    .map((p) => ({
      skuId: p.skuId,
      dimensionId: p.dimensionId,
      unitPriceUsd: p.unitPriceUsd,
      includedQuantity: p.includedQuantity ?? 0,
      evidence: p.evidence,
    }));
}

export default extractPrices;

export const _internal = {
  SYSTEM_PROMPT,
  EXTRACTOR_JSON_SCHEMA,
  extractorOutputSchema,
  buildUserMessage,
  MAX_PAGE_CHARS,
};
