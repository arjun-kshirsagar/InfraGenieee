import fs from 'node:fs';

const KEY = process.env.TAVILY_API_KEY;
if (!KEY) {
  console.error('TAVILY_API_KEY missing');
  process.exit(1);
}

const URLS = [
  // AWS
  'https://aws.amazon.com/ec2/pricing/on-demand/',
  'https://aws.amazon.com/fargate/pricing/',
  'https://aws.amazon.com/lambda/pricing/',
  'https://aws.amazon.com/rds/postgresql/pricing/',
  'https://aws.amazon.com/dynamodb/pricing/on-demand/',
  'https://aws.amazon.com/elasticache/pricing/',
  'https://aws.amazon.com/sqs/pricing/',
  'https://aws.amazon.com/msk/pricing/',
  'https://aws.amazon.com/s3/pricing/',
  'https://aws.amazon.com/cloudfront/pricing/',
  'https://aws.amazon.com/opensearch-service/pricing/',
  // GCP
  'https://cloud.google.com/compute/all-pricing',
  'https://cloud.google.com/run/pricing',
  'https://cloud.google.com/functions/pricing',
  'https://cloud.google.com/sql/pricing',
  'https://cloud.google.com/firestore/pricing',
  'https://cloud.google.com/memorystore/docs/redis/pricing',
  'https://cloud.google.com/pubsub/pricing',
  'https://cloud.google.com/storage/pricing',
  'https://cloud.google.com/cdn/pricing',
  // Azure
  'https://azure.microsoft.com/en-us/pricing/details/app-service/linux/',
  'https://azure.microsoft.com/en-us/pricing/details/container-apps/',
  'https://azure.microsoft.com/en-us/pricing/details/functions/',
  'https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/',
  'https://azure.microsoft.com/en-us/pricing/details/cosmos-db/autoscale-provisioned/',
  'https://azure.microsoft.com/en-us/pricing/details/cache/',
  'https://azure.microsoft.com/en-us/pricing/details/service-bus/',
  'https://azure.microsoft.com/en-us/pricing/details/event-hubs/',
  'https://azure.microsoft.com/en-us/pricing/details/storage/blobs/',
  'https://azure.microsoft.com/en-us/pricing/details/cdn/',
  // Vercel
  'https://vercel.com/docs/pricing',
  'https://vercel.com/docs/pricing/functions',
  'https://vercel.com/docs/pricing/networking',
  // DigitalOcean
  'https://www.digitalocean.com/pricing/droplets',
  'https://www.digitalocean.com/pricing/app-platform',
  'https://www.digitalocean.com/pricing/managed-databases',
  'https://www.digitalocean.com/pricing/spaces-object-storage',
  'https://www.digitalocean.com/pricing/functions',
];

const chunk = <T,>(a: T[], n: number): T[][] =>
  a.reduce<T[][]>((acc, x, i) => (i % n ? acc[acc.length - 1].push(x) : acc.push([x]), acc), []);

interface TavilyResult {
  url: string;
  title: string;
  raw_content: string;
}

const rows: string[] = [];

async function main(): Promise<void> {
  for (const batch of chunk(URLS, 5)) {
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ urls: batch, extract_depth: 'advanced' }),
    });
    if (!res.ok) {
      console.error('HTTP', res.status, await res.text());
      continue;
    }
    const json = (await res.json()) as {
      results: TavilyResult[];
      failed_results: { url: string; error?: string }[];
    };
    for (const r of json.results) {
      const money = (r.raw_content.match(/\$\s?\d/g) ?? []).length;
      const tables = (r.raw_content.match(/\n\|/g) ?? []).length;
      rows.push(
        `OK    ${String(r.raw_content.length).padStart(7)}  money=${String(money).padStart(4)}  tablerows=${String(tables).padStart(4)}  ${r.url}`,
      );
    }
    for (const f of json.failed_results ?? []) {
      rows.push(`FAIL                                              ${f.url}  ${f.error ?? ''}`);
    }
  }

  rows.sort();
  console.log(rows.join('\n'));
  console.log(`\n${rows.filter((r) => r.startsWith('OK')).length}/${URLS.length} pages extracted`);
  fs.writeFileSync('/tmp/pricing-url-probe.txt', rows.join('\n'));
}

void main();
