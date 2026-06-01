/**
 * MANUAL LIVE SMOKE — not part of the automated suite. Hits ALL THREE real,
 * free, public, unauthenticated price feeds ONCE each and prints the matched
 * price + evidence for one SKU per feed, proving the adapters + the shared
 * evidence gate work end-to-end against live data.
 *
 * COST SAFETY (docs §4/§10): every endpoint here is a plain public HTTPS GET —
 * no account, no auth, no billing, no SDK. AWS Price List, the EC2 metered-unit
 * map, and the Azure Retail Prices API are all documented public reads. This
 * makes ONE call per feed. Do NOT loop or sweep; the unit suite
 * (`src/lib/cost/pricing/feeds/*.test.ts`) is fully offline and free — iterate
 * there. No API key is needed (these feeds are unauthenticated).
 *
 * Usage (tsx compiles to CJS, so the body is wrapped in an async main):
 *   npx tsx scripts/smoke-price-feeds.ts
 */

import { fetchAwsPriceList } from '../src/lib/cost/pricing/feeds/aws-price-list';
import { fetchEc2Metered } from '../src/lib/cost/pricing/feeds/aws-ec2-metered';
import { fetchAzureRetail } from '../src/lib/cost/pricing/feeds/azure-retail';
import type { FeedResult } from '../src/lib/cost/pricing/feeds/types';

function report(label: string, res: FeedResult): boolean {
  if (res.kind === 'record') {
    const c = res.candidate;
    console.log(`[smoke] ${label}: MATCHED ✅`);
    console.log(`   skuId=${c.skuId} dimension=${c.dimensionId}`);
    console.log(`   unitPriceUsd=${c.unitPriceUsd}`);
    console.log(`   feedUrl=${c.feedUrl}`);
    console.log(`   evidence=${c.evidence.slice(0, 240)}${c.evidence.length > 240 ? '…' : ''}`);
    return true;
  }
  console.log(`[smoke] ${label}: GAP ❌ reason=${res.gap.reason} detail=${res.gap.detail ?? ''}`);
  return false;
}

async function main(): Promise<void> {
  let ok = true;

  console.log('[smoke] === AWS Price List (SQS Standard requests, us-east-1) ===');
  const [aws] = await fetchAwsPriceList([
    {
      skuId: 'aws:sqs:standard',
      dimensionId: 'requests',
      offerCode: 'AWSQueueService',
      region: 'us-east-1',
      attributes: { queueType: 'Standard', group: 'SQS-APIRequest-Tier1' },
      expectedUnit: 'Requests',
    },
  ]);
  ok = report('AWS Price List', aws) && ok;

  console.log('[smoke] === AWS EC2 metered (t3.small on-demand Linux, us-east-1) ===');
  const [ec2] = await fetchEc2Metered([
    { skuId: 'aws:ec2:t3-small', dimensionId: 'instance-hour', instanceType: 't3.small' },
  ]);
  ok = report('AWS EC2 metered', ec2) && ok;

  console.log('[smoke] === Azure Retail (PostgreSQL Flexible Server vCore, eastus) ===');
  // PostgreSQL has many compute series (Burstable / General Purpose / Memory
  // Optimized, several generations) that all carry a "2 vCore" skuName at
  // different prices — exactly the ambiguity docs §4 warns about. The adapter
  // correctly refuses to guess; we pin productName (the series) to get ONE row.
  const azureQuery = {
    skuId: 'azure:postgres-flex:gp-ddsv5-2vcore',
    dimensionId: 'vcore-hour',
    armRegionName: 'eastus',
    filterClause: "contains(productName,'PostgreSQL')",
    match: {
      meterName: 'vCore',
      skuName: '2 vCore',
      productName: 'Azure Database for PostgreSQL Flexible Server General Purpose Ddsv5 Series Compute',
    },
    expectedUnit: '1 Hour',
  } as const;
  const [azure] = await fetchAzureRetail([azureQuery]);
  ok = report('Azure Retail', azure) && ok;

  if (!ok) {
    console.error('[smoke] FAIL — at least one feed did not return a matched price.');
    process.exit(1);
  }
  console.log('[smoke] OK — all three live feeds returned evidence-backed prices.');
}

void main().catch((err) => {
  console.error('[smoke] unexpected error:', err);
  process.exit(1);
});
