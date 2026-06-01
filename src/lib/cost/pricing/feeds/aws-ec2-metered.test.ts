/**
 * Tests for the AWS EC2 metered-unit feed adapter (task B4).
 *
 * The headline test proves a GZIPPED body parses — this is the failure actually
 * hit in the field (the feed is gzip-encoded but not declared, so a naive
 * `res.text()` throws). The fixture `aws-ec2-metered-useast1.json.gz` is a
 * REAL, trimmed capture re-gzipped, so `decodeMeteredBody` is exercised on true
 * gzip bytes, not a hand-rolled string.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  _priceEc2MeteredFromFeed,
  decodeMeteredBody,
  ec2MeteredUrl,
  type Ec2MeteredFeed,
  type Ec2MeteredQuery,
} from '@/lib/cost/pricing/feeds/aws-ec2-metered';

const GZ_URL = new URL('./__fixtures__/aws-ec2-metered-useast1.json.gz', import.meta.url);
const gzBytes = readFileSync(fileURLToPath(GZ_URL));
const rawBody = decodeMeteredBody(gzBytes.buffer.slice(gzBytes.byteOffset, gzBytes.byteOffset + gzBytes.byteLength));
const feed = JSON.parse(rawBody) as Ec2MeteredFeed;
const FEED_URL = ec2MeteredUrl();
const AT = '2026-07-26T00:00:00.000Z';

describe('aws-ec2-metered adapter — gzip handling (the failure actually hit)', () => {
  it('🔴 decompresses a gzipped body that has the 1f8b magic', () => {
    // The fixture bytes are real gzip; decoding must yield valid JSON.
    expect(gzBytes[0]).toBe(0x1f);
    expect(gzBytes[1]).toBe(0x8b);
    expect(() => JSON.parse(rawBody)).not.toThrow();
    expect(feed.regions?.['US East (N. Virginia)']).toBeTruthy();
  });

  it('passes through a NON-gzipped (already-decoded) body unchanged', () => {
    const plain = '{"hello":"world"}';
    const buf = new TextEncoder().encode(plain).buffer;
    expect(decodeMeteredBody(buf)).toBe(plain);
  });
});

describe('aws-ec2-metered adapter — pricing against recorded real data', () => {
  it('prices t3.small by instance type (0.0208/hr)', () => {
    const q: Ec2MeteredQuery = {
      skuId: 'aws:ec2:t3-small',
      dimensionId: 'instance-hour',
      instanceType: 't3.small',
    };
    const [res] = _priceEc2MeteredFromFeed(feed, FEED_URL, AT, [q]);
    expect(res.kind).toBe('record');
    if (res.kind !== 'record') return;
    expect(res.candidate.unitPriceUsd).toBe(0.0208);
    expect(res.candidate.evidence).toContain('t3.small');
  });

  it('returns a not_found gap for an instance type not in the feed', () => {
    const q: Ec2MeteredQuery = {
      skuId: 'aws:ec2:nope',
      dimensionId: 'instance-hour',
      instanceType: 'zz9.mega',
    };
    const [res] = _priceEc2MeteredFromFeed(feed, FEED_URL, AT, [q]);
    expect(res.kind).toBe('gap');
    if (res.kind !== 'gap') return;
    expect(res.gap.reason).toBe('not_found_on_page');
  });
});

describe('aws-ec2-metered adapter — URL construction encodes spaces/parens', () => {
  it('encodes the region label and OS path segments', () => {
    const url = ec2MeteredUrl('US East (N. Virginia)', 'Linux');
    expect(url).toContain('US%20East%20(N.%20Virginia)');
    expect(url.endsWith('/Linux/index.json')).toBe(true);
  });
});
