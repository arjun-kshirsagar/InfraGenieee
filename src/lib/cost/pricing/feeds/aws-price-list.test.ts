/**
 * Tests for the AWS Price List Bulk API adapter (task B4).
 *
 * These run OFFLINE against a RECORDED REAL fixture — a trimmed capture of the
 * live `AWSQueueService` us-east-1 offer index (see `__fixtures__/`). Hand-
 * invented JSON would defeat the purpose: the point is that the same shape the
 * live feed returns joins correctly and survives the evidence gate.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  _priceAwsPriceListFromIndex,
  type AwsOfferIndex,
  type AwsPriceListQuery,
} from '@/lib/cost/pricing/feeds/aws-price-list';

const FIXTURE_URL = new URL('./__fixtures__/aws-price-list-sqs-useast1.json', import.meta.url);
const rawBody = readFileSync(fileURLToPath(FIXTURE_URL), 'utf-8');
const index = JSON.parse(rawBody) as AwsOfferIndex;
const FEED_URL = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSQueueService/current/us-east-1/index.json';
const AT = '2026-07-26T00:00:00.000Z';

const base = { offerCode: 'AWSQueueService', region: 'us-east-1' } as const;

describe('aws-price-list adapter — happy path against recorded real data', () => {
  it('joins products→terms and prices the FIFO first tier ($0.50/million → 0.0000005)', () => {
    const q: AwsPriceListQuery = {
      ...base,
      skuId: 'aws:sqs:standard',
      dimensionId: 'requests',
      attributes: { group: 'SQS-APIRequest-Tier1', queueType: 'FIFO (first-in, first-out)' },
      expectedUnit: 'Requests',
    };
    const [res] = _priceAwsPriceListFromIndex(index, FEED_URL, AT, [q]);
    expect(res.kind).toBe('record');
    if (res.kind !== 'record') return;
    // beginRange 0 is the first tier; USD 0.0000005000 → 0.0000005.
    expect(res.candidate.unitPriceUsd).toBe(0.0000005);
    expect(res.candidate.feedUrl).toBe(FEED_URL);
    // Evidence is the serialised priceDimensions entry and passed the gate.
    expect(res.candidate.evidence).toContain('0.0000005000');
  });

  it('picks the tier named by descriptionContains (Tier2 → 0.0000004)', () => {
    const q: AwsPriceListQuery = {
      ...base,
      skuId: 'aws:sqs:standard',
      dimensionId: 'requests',
      attributes: { queueType: 'FIFO (first-in, first-out)' },
      descriptionContains: 'Tier2',
    };
    const [res] = _priceAwsPriceListFromIndex(index, FEED_URL, AT, [q]);
    expect(res.kind).toBe('record');
    if (res.kind !== 'record') return;
    expect(res.candidate.unitPriceUsd).toBe(0.0000004);
  });
});

describe('aws-price-list adapter — 🔴 priceScale: per-single-unit feed → per-batch report', () => {
  it('scales the raw per-request price up to the catalog per-batch representation', () => {
    // The Price List quotes per single request (0.0000005); the SQS `requests`
    // dimension bills per million (pricePerUnits 1_000_000). With priceScale the
    // adapter reports 0.0000005 × 1_000_000 = 0.50, so the engine's
    // billable/pricePerUnits × unitPriceUsd lands the right total instead of
    // billing $0.0000005 for a million messages (the coordination bug).
    const q: AwsPriceListQuery = {
      ...base,
      skuId: 'aws:sqs:standard',
      dimensionId: 'requests',
      attributes: { group: 'SQS-APIRequest-Tier1', queueType: 'FIFO (first-in, first-out)' },
      expectedUnit: 'Requests',
      priceScale: 1_000_000,
    };
    const [res] = _priceAwsPriceListFromIndex(index, FEED_URL, AT, [q]);
    expect(res.kind).toBe('record');
    if (res.kind !== 'record') return;
    expect(res.candidate.unitPriceUsd).toBe(0.5); // 0.0000005 × 1e6
    // The note explains the scaling for provenance.
    expect(res.candidate.note).toMatch(/per-batch price/);
    // The evidence still carries the RAW per-unit value the gate proved.
    expect(res.candidate.evidence).toContain('0.0000005000');
  });

  it('a default scale of 1 is a no-op (per-hour / per-GB dimensions)', () => {
    const q: AwsPriceListQuery = {
      ...base,
      skuId: 'aws:sqs:standard',
      dimensionId: 'requests',
      attributes: { group: 'SQS-APIRequest-Tier1', queueType: 'FIFO (first-in, first-out)' },
      expectedUnit: 'Requests',
    };
    const [res] = _priceAwsPriceListFromIndex(index, FEED_URL, AT, [q]);
    expect(res.kind).toBe('record');
    if (res.kind !== 'record') return;
    expect(res.candidate.unitPriceUsd).toBe(0.0000005); // unscaled
  });
});

describe('aws-price-list adapter — ambiguity and misses are gaps, never guesses', () => {
  it('returns an ambiguous gap when the attribute filter matches >1 product', () => {
    // Both fixture products share group SQS-APIRequest-Tier1 (FIFO + Fair).
    const q: AwsPriceListQuery = {
      ...base,
      skuId: 'aws:sqs:standard',
      dimensionId: 'requests',
      attributes: { group: 'SQS-APIRequest-Tier1' },
    };
    const [res] = _priceAwsPriceListFromIndex(index, FEED_URL, AT, [q]);
    expect(res.kind).toBe('gap');
    if (res.kind !== 'gap') return;
    expect(res.gap.reason).toBe('ambiguous');
  });

  it('returns a not_found gap when nothing matches', () => {
    const q: AwsPriceListQuery = {
      ...base,
      skuId: 'aws:sqs:standard',
      dimensionId: 'requests',
      attributes: { queueType: 'does-not-exist' },
    };
    const [res] = _priceAwsPriceListFromIndex(index, FEED_URL, AT, [q]);
    expect(res.kind).toBe('gap');
    if (res.kind !== 'gap') return;
    expect(res.gap.reason).toBe('not_found_on_page');
  });
});
