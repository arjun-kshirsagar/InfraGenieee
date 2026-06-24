/**
 * InfraGenie — Feature 3 comparison markdown export. PURE, DOM-free.
 *
 * A cost estimate a user can't share or defend is half a feature. This builds a
 * copyable / downloadable markdown summary of the whole comparison that a user
 * can paste into a doc or a ticket and have someone else check.
 *
 * 🔴 Every priced line is defensible: the export includes each dimension's
 *    source URL and `fetchedAt`, so a reader can click through to the vendor
 *    page the number came from. Unpriced/incomplete lines are labelled a floor,
 *    never rendered as $0.00; a provider that can't run the app is stated as
 *    such and is not presented as cheap. These mirror the on-screen honesty
 *    rules exactly — the shared artefact must not soften them.
 *
 * `now` is passed in (not read from the clock) so the output is deterministic
 * and unit-testable to the byte.
 */

import { z } from 'zod';

import {
  INFRA_ROLE_LABEL,
  PROVIDER_LABEL,
  PRICED_REGION_LABEL,
  providerTradeoffSchema,
  type CloudProvider,
  type CostComparison,
  type ProviderEstimate,
} from '@/types/cost';

import { formatUsd, formatFetchedDate } from '@/lib/cost/f2/format';
import { isEntirelyUnpriced } from '@/lib/cost/estimate/engine';

/** Inferred from the contract's `providerTradeoffSchema` (no exported type in
 *  the architect-owned contract; inferred here rather than editing it). */
export type ProviderTradeoff = z.infer<typeof providerTradeoffSchema>;

export interface ExportMarkdownInput {
  /** PRD title, for the heading. */
  title: string;
  comparison: CostComparison;
  /** Trade-offs from the AI recommendation, keyed to providers in the compare. */
  tradeoffs: readonly ProviderTradeoff[];
  /** Epoch-ms when the export was produced, for the "generated" line. */
  now: number;
}

/** Cost cell: an unsupported provider is stated, a zero-priced provider is
 *  "not priced" (no $0.00), and a floor gets a "≥". */
function totalCell(e: ProviderEstimate): string {
  if (e.unsupportedRoles.length > 0) {
    const missing = e.unsupportedRoles.map((r) => INFRA_ROLE_LABEL[r]).join(', ');
    return `**cannot run this app** (missing: ${missing})`;
  }
  // 🔴 Services selected but zero priced dimensions → there is no floor to
  // state. "≥ $0.00/mo" is not meaningful (BLOCKER-3 / MINOR-1); say "not
  // priced" with no dollar figure.
  if (isEntirelyUnpriced(e)) {
    return '**not priced** *(no verified price \u2014 a gap, not a zero)*';
  }
  return `${e.incomplete ? '\u2265 ' : ''}${formatUsd(e.monthlyUsd)}/mo${
    e.incomplete ? ' *(floor \u2014 an unpriced required line)*' : ''
  }`;
}

function badgeLine(comparison: CostComparison): string {
  const parts: string[] = [];
  if (comparison.cheapest) parts.push(`**Cheapest:** ${PROVIDER_LABEL[comparison.cheapest]}`);
  if (comparison.bestScaling)
    parts.push(`**Best scaling:** ${PROVIDER_LABEL[comparison.bestScaling]}`);
  if (comparison.simplest) parts.push(`**Simplest:** ${PROVIDER_LABEL[comparison.simplest]}`);
  if (parts.length === 0) {
    return '_No single winner: with one provider (or every estimate a floor) there is no honest comparison._';
  }
  return parts.join(' \u00b7 ');
}

function tradeoffFor(
  provider: CloudProvider,
  tradeoffs: readonly ProviderTradeoff[],
): ProviderTradeoff | undefined {
  return tradeoffs.find((t) => t.provider === provider);
}

/**
 * Build the full comparison markdown. Structure:
 *
 *   # Deployment cost comparison — <title>
 *   Generated <date>. Prices fetched from each vendor's public pricing pages.
 *   <badge line>
 *   ## Summary  (a table: provider | region | total)
 *   ## <Provider>  (per-role lines with citations, then pros/cons)
 *   ...
 *   > honesty footnote
 */
export function buildComparisonMarkdown(input: ExportMarkdownInput): string {
  const { title, comparison, tradeoffs, now } = input;
  const lines: string[] = [];

  lines.push(`# Deployment cost comparison \u2014 ${title}`);
  lines.push('');
  lines.push(
    `Generated ${formatFetchedDate(new Date(now).toISOString())}. Prices are fetched from each vendor\u2019s public pricing pages and cited below.`,
  );
  lines.push('');
  lines.push(badgeLine(comparison));
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Provider | Region | Estimated monthly |');
  lines.push('| --- | --- | --- |');
  for (const e of comparison.estimates) {
    lines.push(`| ${PROVIDER_LABEL[e.provider]} | ${PRICED_REGION_LABEL[e.provider]} | ${totalCell(e)} |`);
  }
  lines.push('');

  // Per-provider detail
  for (const e of comparison.estimates) {
    lines.push(`## ${PROVIDER_LABEL[e.provider]}`);
    lines.push('');
    lines.push(`Priced region: ${PRICED_REGION_LABEL[e.provider]}`);
    lines.push('');

    if (e.unsupportedRoles.length > 0) {
      const missing = e.unsupportedRoles.map((r) => INFRA_ROLE_LABEL[r]).join(', ');
      lines.push(
        `> \u26a0\ufe0f **Cannot run this app on its own.** Missing capability: ${missing}. This total is not comparable to providers that can.`,
      );
      lines.push('');
    }

    if (e.items.length === 0) {
      lines.push('_No services selected._');
      lines.push('');
    } else {
      for (const item of e.items) {
        const floor = item.incomplete ? ' \u2014 *floor (unpriced required line)*' : '';
        lines.push(
          `- **${INFRA_ROLE_LABEL[item.role]}** \u2014 ${item.serviceName} (${item.skuName})${
            item.units > 1 ? ` \u00d7${item.units}` : ''
          }: ${item.incomplete ? '\u2265 ' : ''}${formatUsd(item.monthlyUsd)}/mo${floor}`,
        );
        // Citations per priced dimension.
        for (const dim of item.dimensions) {
          if (dim.unpriced || !dim.source) {
            lines.push(`  - ${dim.label}: _unpriced \u2014 no verified price (not free)_`);
          } else {
            lines.push(
              `  - ${dim.label}: ${formatUsd(dim.monthlyUsd)}/mo \u2014 source: ${dim.source.url} (fetched ${formatFetchedDate(
                dim.source.fetchedAt,
              )})`,
            );
          }
        }
      }
      lines.push('');
      lines.push(`**Total: ${totalCell(e)}**`);
      lines.push('');
    }

    const t = tradeoffFor(e.provider, tradeoffs);
    if (t) {
      lines.push('**Pros**');
      for (const p of t.pros) lines.push(`- ${p}`);
      lines.push('');
      lines.push('**Cons**');
      for (const c of t.cons) lines.push(`- ${c}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(
    '> Estimates price one US region per provider and flatten tiered pricing to the first paid tier. ' +
      'A line marked as a floor (\u2265) has an unpriced required dimension, so real cost is higher. ' +
      'Unpriced means we could not verify a price \u2014 never that it is free.',
  );
  lines.push('');

  return lines.join('\n');
}

/** Slugify a title into a safe filename stem (mirrors export-controls.tsx). */
export function comparisonFileStem(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base ? `${base}-cost-comparison` : 'cost-comparison';
}
