/**
 * Tests for the LLM price extractor (`extractPrices`, task B5).
 *
 * OFFLINE and FREE: `callStructured` is fully mocked, so no real Anthropic call
 * is made and the suite bills nothing. We prove the extractor makes exactly one
 * call per page, forwards the model/signal, drops candidates for dimensions it
 * was not asked about, defaults `includedQuantity` to 0, and maps the PRD
 * generation error taxonomy onto `PricingError`. The evidence GATE is not
 * exercised here — that is `build.test.ts`'s job (the extractor only proposes).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationError } from '@/lib/prd/generation';

// Mock the client before importing the extractor so it picks up the mock.
vi.mock('@/lib/prd/llm/client', () => ({
  callStructured: vi.fn(),
}));

import { callStructured } from '@/lib/prd/llm/client';
import { extractPrices, _internal, type ExtractionTarget } from '@/lib/cost/pricing/extractor';
import { DEFAULT_PRICE_EXTRACTOR_MODEL, type FetchedPage } from '@/lib/cost/pricing-seam';

const mockCall = vi.mocked(callStructured);

const page: FetchedPage = {
  url: 'https://www.digitalocean.com/pricing/droplets',
  title: 'Droplets',
  markdown: '| 1 GiB | 1 vCPU | $0.00893 | $6.00 |',
  fetchedAt: '2026-07-26T00:00:00.000Z',
};

const targets: ExtractionTarget[] = [
  { skuId: 'digitalocean:droplet:basic-1gb', dimensionId: 'droplet-hour', extractionHint: 'Basic 1 GiB hourly', unit: 'USD / hour' },
  { skuId: 'digitalocean:droplet:basic-2gb', dimensionId: 'droplet-hour', extractionHint: 'Basic 2 GiB hourly', unit: 'USD / hour' },
];

beforeEach(() => mockCall.mockReset());

describe('extractPrices — one call per page, faithful passthrough', () => {
  it('returns candidates and makes exactly ONE callStructured call', async () => {
    mockCall.mockResolvedValue({
      prices: [
        {
          skuId: 'digitalocean:droplet:basic-1gb',
          dimensionId: 'droplet-hour',
          unitPriceUsd: 0.00893,
          evidence: '$0.00893',
        },
      ],
    });

    const out = await extractPrices(page, targets);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      {
        skuId: 'digitalocean:droplet:basic-1gb',
        dimensionId: 'droplet-hour',
        unitPriceUsd: 0.00893,
        includedQuantity: 0, // defaulted when the model omits it
        includedQuantityEvidence: '', // defaulted when the model omits it
        evidence: '$0.00893',
      },
    ]);
  });

  it('short-circuits with no call when there are no targets', async () => {
    const out = await extractPrices(page, []);
    expect(out).toEqual([]);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('forwards a model override and the abort signal', async () => {
    mockCall.mockResolvedValue({ prices: [] });
    const controller = new AbortController();
    await extractPrices(page, targets, { model: 'claude-test', signal: controller.signal });
    expect(mockCall).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-test', signal: controller.signal }),
    );
  });

  it('uses the default extractor model when none is given', async () => {
    mockCall.mockResolvedValue({ prices: [] });
    await extractPrices(page, targets);
    expect(mockCall).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_PRICE_EXTRACTOR_MODEL }),
    );
  });

  it('carries includedQuantity through when the model reports a free allowance', async () => {
    mockCall.mockResolvedValue({
      prices: [
        {
          skuId: 'digitalocean:droplet:basic-1gb',
          dimensionId: 'droplet-hour',
          unitPriceUsd: 0.00893,
          includedQuantity: 100,
          evidence: '$0.00893 with 100 GiB free',
        },
      ],
    });
    const [c] = await extractPrices(page, targets);
    expect(c.includedQuantity).toBe(100);
  });
});

describe('extractPrices — defensive filtering', () => {
  it('drops candidates for (skuId, dimensionId) pairs that were not requested', async () => {
    mockCall.mockResolvedValue({
      prices: [
        // Not in `targets` — an invented pair the model echoed. Must be dropped.
        { skuId: 'digitalocean:droplet:INVENTED', dimensionId: 'droplet-hour', unitPriceUsd: 9.99, evidence: '$9.99' },
        { skuId: 'digitalocean:droplet:basic-2gb', dimensionId: 'droplet-hour', unitPriceUsd: 0.0119, evidence: '$0.0119' },
      ],
    });
    const out = await extractPrices(page, targets);
    expect(out).toHaveLength(1);
    expect(out[0].skuId).toBe('digitalocean:droplet:basic-2gb');
  });
});

describe('extractPrices — error taxonomy mapping', () => {
  async function codeOf(err: unknown): Promise<{ name?: string; code?: string }> {
    mockCall.mockRejectedValueOnce(err);
    return (await extractPrices(page, targets).catch((e) => e)) as { name?: string; code?: string };
  }

  it('maps not_configured GenerationError → PricingError not_configured', async () => {
    const e = await codeOf(new GenerationError('not_configured', 'no key'));
    expect(e.name).toBe('PricingError');
    expect(e.code).toBe('not_configured');
  });

  it('maps invalid_output → invalid_output', async () => {
    const e = await codeOf(new GenerationError('invalid_output', 'bad schema'));
    expect(e.code).toBe('invalid_output');
  });

  it('maps unavailable → unavailable', async () => {
    const e = await codeOf(new GenerationError('unavailable', 'HTTP 503'));
    expect(e.code).toBe('unavailable');
  });

  it('maps a non-GenerationError throw → unavailable', async () => {
    const e = await codeOf(new Error('boom'));
    expect(e.name).toBe('PricingError');
    expect(e.code).toBe('unavailable');
  });
});

describe('extractPrices — prompt discipline (the anti-fabrication framing)', () => {
  it('the system prompt tells the model that a gap is correct and evidence must be verbatim', () => {
    const sys = _internal.SYSTEM_PROMPT;
    expect(sys.toLowerCase()).toContain('verbatim');
    expect(sys.toLowerCase()).toMatch(/nothing|gap|omit/);
    expect(sys.toLowerCase()).toContain('never assume a free tier');
  });

  it('truncates an oversized page but keeps the targets in the user message', () => {
    const huge: FetchedPage = { ...page, markdown: 'x'.repeat(_internal.MAX_PAGE_CHARS + 5000) };
    const msg = _internal.buildUserMessage(huge, targets);
    expect(msg).toContain('…page truncated…');
    expect(msg).toContain('digitalocean:droplet:basic-1gb');
  });
});
