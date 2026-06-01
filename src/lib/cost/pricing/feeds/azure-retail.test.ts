/**
 * Tests for the Azure Retail Prices API adapter (task B4).
 *
 * Fixtures are RECORDED REAL captures of the live Retail API (PostgreSQL in
 * eastus), split into two pages to exercise `NextPageLink` pagination against
 * true response shapes rather than invented JSON.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _priceAzureFromItems,
  azureRetailUrl,
  buildAzureFilter,
  fetchAzureRetail,
  type AzureRetailItem,
  type AzureRetailQuery,
} from '@/lib/cost/pricing/feeds/azure-retail';

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf-8');
}

const page1Raw = loadFixture('azure-retail-postgres-page1.json');
const page2Raw = loadFixture('azure-retail-postgres-page2.json');
const page1Items = (JSON.parse(page1Raw).Items ?? []) as AzureRetailItem[];
const page2Items = (JSON.parse(page2Raw).Items ?? []) as AzureRetailItem[];
const AT = '2026-07-26T00:00:00.000Z';

describe('azure-retail adapter — the mandatory filter pins (region + Consumption)', () => {
  it('buildAzureFilter ALWAYS contains armRegionName and type eq Consumption', () => {
    const filter = buildAzureFilter('eastus', "contains(productName,'PostgreSQL')");
    expect(filter).toContain("armRegionName eq 'eastus'");
    expect(filter).toContain("type eq 'Consumption'");
    expect(filter).toContain("contains(productName,'PostgreSQL')");
  });

  it('pins both even when the caller passes an empty clause', () => {
    const filter = buildAzureFilter('eastus', '');
    expect(filter).toContain("armRegionName eq 'eastus'");
    expect(filter).toContain("type eq 'Consumption'");
  });

  it('the request URL carries the pinned filter', () => {
    const url = azureRetailUrl({
      skuId: 'azure:pg:x',
      dimensionId: 'vcore-hour',
      armRegionName: 'eastus',
      filterClause: "meterName eq 'vCore'",
    });
    const decoded = decodeURIComponent(url).replace(/\+/g, ' ');
    expect(decoded).toContain("armRegionName eq 'eastus'");
    expect(decoded).toContain("type eq 'Consumption'");
    expect(url).toContain('api-version=2023-01-01-preview');
    expect(url).toContain('currencyCode=USD');
  });
});

describe('azure-retail adapter — pricing against recorded real data', () => {
  it('prices the 64 vCore meter (retailPrice 8.0) and passes the evidence gate', () => {
    const q: AzureRetailQuery = {
      skuId: 'azure:postgres-flex:memory-64',
      dimensionId: 'vcore-hour',
      armRegionName: 'eastus',
      filterClause: "contains(productName,'PostgreSQL')",
      match: { meterName: 'vCore', skuName: '64 vCore' },
      expectedUnit: '1 Hour',
    };
    const [res] = _priceAzureFromItems(page1Items, 'https://prices.azure.com/x', AT, [q]);
    expect(res.kind).toBe('record');
    if (res.kind !== 'record') return;
    expect(res.candidate.unitPriceUsd).toBe(8.0);
    expect(res.candidate.evidence).toContain('vCore');
  });

  it('returns an ambiguous gap when survivors have distinct prices', () => {
    const both = [...page1Items, ...page2Items]; // 64 vCore @8.0 and 32 vCore @4.0
    const q: AzureRetailQuery = {
      skuId: 'azure:postgres-flex:memory',
      dimensionId: 'vcore-hour',
      armRegionName: 'eastus',
      filterClause: "contains(productName,'PostgreSQL')",
      match: { meterName: 'vCore' }, // matches both, different prices
    };
    const [res] = _priceAzureFromItems(both, 'https://x', AT, [q]);
    expect(res.kind).toBe('gap');
    if (res.kind !== 'gap') return;
    expect(res.gap.reason).toBe('ambiguous');
  });

  it('returns a not_found gap when the match narrows to nothing', () => {
    const q: AzureRetailQuery = {
      skuId: 'azure:postgres-flex:x',
      dimensionId: 'vcore-hour',
      armRegionName: 'eastus',
      filterClause: '',
      match: { meterName: 'DoesNotExist' },
    };
    const [res] = _priceAzureFromItems(page1Items, 'https://x', AT, [q]);
    expect(res.kind).toBe('gap');
    if (res.kind !== 'gap') return;
    expect(res.gap.reason).toBe('not_found_on_page');
  });
});

describe('azure-retail adapter — NextPageLink pagination', () => {
  afterEach(() => vi.restoreAllMocks());

  it('follows NextPageLink and accumulates items across pages', async () => {
    // page1 fixture has NextPageLink → page2 fixture (which ends pagination).
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      const body = u.includes('PAGE=2') ? page2Raw : page1Raw;
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const q: AzureRetailQuery = {
      skuId: 'azure:postgres-flex:memory-32',
      dimensionId: 'vcore-hour',
      armRegionName: 'eastus',
      filterClause: "contains(productName,'PostgreSQL')",
      match: { meterName: 'vCore', skuName: '32 vCore' }, // only exists on page 2
      expectedUnit: '1 Hour',
    };
    const [res] = await fetchAzureRetail([q]);
    // Two HTTP calls: page 1, then NextPageLink page 2.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.kind).toBe('record');
    if (res.kind !== 'record') return;
    // The 32 vCore row lives only on page 2 — proves we followed the link.
    expect(res.candidate.unitPriceUsd).toBe(4.0);
  });
});
