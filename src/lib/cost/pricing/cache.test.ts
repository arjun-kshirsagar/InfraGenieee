/**
 * Tests for the filesystem price-book cache (`PriceBookCache`, task B5, docs §6).
 *
 * OFFLINE: these exercise the real `node:fs` cache against a temp directory,
 * injected via the constructor's `rootDir` option. We deliberately do NOT
 * `process.chdir` — mutating the global cwd corrupts other test files running
 * concurrently in the same vitest worker. We prove the four miss conditions and
 * the fresh hit, and that a corrupt or schema-mismatched file NEVER throws (same
 * posture as store.ts).
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PriceBookCache } from '@/lib/cost/pricing/cache';
import { PRICING_PIPELINE_VERSION, type PriceBook } from '@/types/cost';

let rootDir: string;

function newCache(now?: () => number): PriceBookCache {
  return new PriceBookCache({ rootDir, now });
}

function freshBook(overrides: Partial<PriceBook> = {}): PriceBook {
  return {
    provider: 'digitalocean',
    region: 'nyc3',
    pipelineVersion: PRICING_PIPELINE_VERSION,
    generatedAt: new Date().toISOString(),
    records: [
      {
        skuId: 'digitalocean:droplet:basic-1gb',
        dimensionId: 'droplet-hour',
        unitPriceUsd: 0.00893,
        includedQuantity: 0,
        currency: 'USD',
        source: {
          url: 'https://www.digitalocean.com/pricing/droplets',
          fetchedAt: new Date().toISOString(),
          evidence: '$0.00893',
          extractorModel: 'test',
        },
      },
    ],
    gaps: [],
    ...overrides,
  };
}

function cacheFile(provider: string): string {
  return path.join(rootDir, `${provider}.json`);
}

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'infragenie-cache-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('PriceBookCache — fresh hit', () => {
  it('round-trips a written book (write → read) as a hit', async () => {
    const cache = newCache();
    const book = freshBook();
    await cache.write(book);
    const read = await cache.read('digitalocean');
    expect(read).not.toBeNull();
    expect(read?.provider).toBe('digitalocean');
    expect(read?.records[0].unitPriceUsd).toBe(0.00893);
  });

  it('is a MISS when the file is absent', async () => {
    const cache = newCache();
    expect(await cache.read('aws')).toBeNull();
  });
});

describe('PriceBookCache — miss conditions', () => {
  it('is a MISS when the book is older than PRICE_MAX_AGE_DAYS (7d)', async () => {
    const cache = newCache();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await cache.write(freshBook({ generatedAt: eightDaysAgo }));
    expect(await cache.read('digitalocean')).toBeNull();
  });

  it('is a HIT when the book is fresh (6 days old)', async () => {
    const cache = newCache();
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    await cache.write(freshBook({ generatedAt: sixDaysAgo }));
    expect(await cache.read('digitalocean')).not.toBeNull();
  });

  it('is a MISS when pipelineVersion differs from the current PRICING_PIPELINE_VERSION', async () => {
    const cache = newCache();
    // Write a book with an old pipeline version directly to disk (bypass write's
    // re-validation, which would keep the value but the guard rejects on read).
    mkdirSync(rootDir, { recursive: true });
    const stale = freshBook({ pipelineVersion: '0.0.1-old' });
    writeFileSync(cacheFile('digitalocean'), JSON.stringify(stale), 'utf-8');
    expect(await cache.read('digitalocean')).toBeNull();
  });

  it('is a MISS (no crash) when the file is corrupt JSON', async () => {
    const cache = newCache();
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(cacheFile('digitalocean'), '{ this is not valid json ]', 'utf-8');
    await expect(cache.read('digitalocean')).resolves.toBeNull();
  });

  it('is a MISS (no crash) when the file is valid JSON but fails the schema', async () => {
    const cache = newCache();
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(cacheFile('digitalocean'), JSON.stringify({ provider: 'digitalocean' }), 'utf-8');
    await expect(cache.read('digitalocean')).resolves.toBeNull();
  });

  it('is a MISS when a provider file holds a book for a different provider', async () => {
    const cache = newCache();
    mkdirSync(rootDir, { recursive: true });
    const awsBook = freshBook({ provider: 'aws', region: 'us-east-1', records: [], gaps: [] });
    writeFileSync(cacheFile('digitalocean'), JSON.stringify(awsBook), 'utf-8');
    expect(await cache.read('digitalocean')).toBeNull();
  });
});

describe('PriceBookCache — write safety', () => {
  it('refuses to persist an invalid book (no throw, nothing readable back)', async () => {
    const cache = newCache();
    const bad = { provider: 'digitalocean' } as unknown as PriceBook;
    await expect(cache.write(bad)).resolves.toBeUndefined();
    expect(await cache.read('digitalocean')).toBeNull();
  });

  it('stores books per-provider (a DO write does not touch the AWS slot)', async () => {
    const cache = newCache();
    await cache.write(freshBook());
    expect(await cache.read('digitalocean')).not.toBeNull();
    expect(await cache.read('aws')).toBeNull();
  });
});

describe('PriceBookCache — injectable clock', () => {
  it('uses the injected now() for the age gate', async () => {
    // Write "now", then read with a clock 8 days in the future → stale miss.
    const writer = newCache();
    await writer.write(freshBook());

    const future = Date.now() + 8 * 24 * 60 * 60 * 1000;
    const reader = newCache(() => future);
    expect(await reader.read('digitalocean')).toBeNull();
  });
});
