'use client';

/**
 * Per-service cost breakdown — expandable to per-dimension rows.
 *
 * Each `CostLineItem` is a service the user selected; expanding it reveals the
 * exact §7 arithmetic per dimension:
 *
 *     quantity → included (free allowance) → billable → unit price → monthly
 *
 * so the maths matches B7's worked example to the cent and is fully auditable.
 *
 * 🔴 The three honesty rules, enforced visually:
 *  - an `unpriced` dimension shows the word "unpriced", NEVER `$0.00`, and its
 *    contribution is a floor — it is styled distinctly (amber), not as free;
 *  - a line with an unpriced *required* dimension is flagged `incomplete` and
 *    its total is labelled a floor ("≥");
 *  - every PRICED row exposes its citation via <PriceCitation> so the user can
 *    check the number against the vendor's page.
 */

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';

import type { CostLineItem, CostDimensionResult } from '@/types/cost';
import { INFRA_ROLE_LABEL } from '@/types/cost';
import { formatUsd, formatUnitPrice, formatQuantity } from '@/lib/cost/f2/format';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { PriceCitation } from './price-citation';

/** A single dimension row inside an expanded line item. */
function DimensionRow({ dim, now }: { dim: CostDimensionResult; now: number }) {
  return (
    <div className="grid grid-cols-2 items-center gap-x-3 gap-y-1 border-t py-2 text-xs sm:grid-cols-6">
      <div className="col-span-2 flex flex-col sm:col-span-2">
        <span className="font-medium text-foreground">{dim.label}</span>
        <span className="text-muted-foreground">{dim.unit}</span>
      </div>

      {dim.unpriced ? (
        <div className="col-span-2 flex items-center gap-1.5 sm:col-span-3">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-600" aria-hidden />
          <span className="font-medium text-amber-700 dark:text-amber-400">
            Unpriced — we couldn&rsquo;t verify this rate, so it&rsquo;s not counted (the real cost is
            higher).
          </span>
        </div>
      ) : (
        <>
          <div className="flex flex-col sm:items-end" title="Quantity before free allowance">
            <span className="text-[10px] uppercase text-muted-foreground sm:hidden">Quantity</span>
            <span className="tabular-nums">{formatQuantity(dim.quantity)}</span>
          </div>
          <div className="flex flex-col sm:items-end" title="Included free allowance">
            <span className="text-[10px] uppercase text-muted-foreground sm:hidden">Included</span>
            <span className="tabular-nums text-muted-foreground">
              {dim.includedQuantity > 0 ? `−${formatQuantity(dim.includedQuantity)}` : '—'}
            </span>
          </div>
          <div className="flex flex-col sm:items-end" title="Billable × unit price">
            <span className="text-[10px] uppercase text-muted-foreground sm:hidden">Billable</span>
            <span className="tabular-nums">
              {formatQuantity(dim.billableQuantity)} × {formatUnitPrice(dim.unitPriceUsd)}
            </span>
          </div>
        </>
      )}

      <div className="col-span-2 flex items-center justify-between gap-2 sm:col-span-6">
        {dim.source ? (
          <PriceCitation source={dim.source} now={now} label={dim.label} />
        ) : (
          <span className="text-[10px] text-muted-foreground">No verified source</span>
        )}
        <span
          className={
            dim.unpriced
              ? 'text-xs font-medium text-amber-700 dark:text-amber-400'
              : 'text-sm font-semibold tabular-nums'
          }
        >
          {dim.unpriced ? 'floor: not counted' : formatUsd(dim.monthlyUsd)}
        </span>
      </div>
    </div>
  );
}

function LineItem({ item, now }: { item: CostLineItem; now: number }) {
  return (
    <AccordionItem value={item.skuId} className="rounded-lg border px-3">
      <AccordionTrigger className="py-3">
        <div className="flex flex-1 flex-col gap-0.5 pr-2 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{item.serviceName}</span>
            <Badge variant="outline" className="text-[10px]">
              {INFRA_ROLE_LABEL[item.role]}
            </Badge>
            {item.units > 1 ? (
              <Badge variant="secondary" className="text-[10px]">
                ×{item.units}
              </Badge>
            ) : null}
            {item.incomplete ? (
              <Badge className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400">
                floor
              </Badge>
            ) : null}
          </div>
          <span className="text-xs text-muted-foreground">{item.skuName}</span>
        </div>
        <span className="mr-2 shrink-0 text-sm font-semibold tabular-nums">
          {item.incomplete ? '≥ ' : ''}
          {formatUsd(item.monthlyUsd)}
        </span>
      </AccordionTrigger>
      <AccordionContent className="pb-3">
        <div className="hidden grid-cols-6 gap-x-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
          <span className="col-span-2">Dimension</span>
          <span className="text-right">Quantity</span>
          <span className="text-right">Included</span>
          <span className="text-right">Billable × price</span>
          <span className="text-right">Monthly</span>
        </div>
        {item.dimensions.map((dim) => (
          <DimensionRow key={dim.dimensionId} dim={dim} now={now} />
        ))}
      </AccordionContent>
    </AccordionItem>
  );
}

export interface CostBreakdownProps {
  items: CostLineItem[];
  now: number;
}

export function CostBreakdown({ items, now }: CostBreakdownProps) {
  const priced = items.filter((i) => i.dimensions.length > 0);
  if (priced.length === 0) {
    return (
      <p className="rounded-md bg-muted/40 p-4 text-center text-sm text-muted-foreground">
        No services are enabled — turn a role on above to see its cost.
      </p>
    );
  }
  return (
    <Accordion className="flex flex-col gap-2">
      {priced.map((item) => (
        <LineItem key={item.skuId} item={item} now={now} />
      ))}
    </Accordion>
  );
}
