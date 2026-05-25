import fs from 'node:fs';

const KEY = process.env.TAVILY_API_KEY;
if (!KEY) {
  console.error('TAVILY_API_KEY missing');
  process.exit(1);
}

/** Pages whose first probe showed money=0 or suspiciously few prices, plus
 *  candidate replacements. We keep whichever variant actually carries numbers. */
const URLS = process.argv.slice(2);
if (URLS.length === 0) {
  console.error('usage: probe-page.ts <url> [url...]');
  process.exit(1);
}

interface TavilyResult {
  url: string;
  title: string;
  raw_content: string;
}

async function main(): Promise<void> {
  const res = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ urls: URLS.slice(0, 5), extract_depth: 'advanced' }),
  });
  if (!res.ok) {
    console.error('HTTP', res.status, await res.text());
    process.exit(1);
  }
  const json = (await res.json()) as {
    results: TavilyResult[];
    failed_results: { url: string; error?: string }[];
  };
  for (const r of json.results) {
    const money = (r.raw_content.match(/\$\s?\d/g) ?? []).length;
    console.log(`\n${'='.repeat(90)}\n${r.url}\nlen=${r.raw_content.length} money=${money}`);
    const lines = r.raw_content.split('\n');
    const hits = lines.filter((l) => /\$\s?\d|\d+\.\d{3,}/.test(l));
    console.log(
      (hits.length ? hits : lines.filter((l) => l.trim())).slice(0, 14).map((l) => `  ${l.slice(0, 190)}`).join('\n'),
    );
    fs.writeFileSync(
      `/tmp/page-${r.url.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.md`,
      r.raw_content,
    );
  }
  for (const f of json.failed_results ?? []) console.log(`FAIL ${f.url} ${f.error ?? ''}`);
}

void main();
