'use client';

/**
 * The honest-caveats panel — non-negotiable for Feature 2 (docs §5). A price is
 * a real, fetched, cited number, but it is NOT a global truth, it can go stale,
 * and some things simply couldn't be priced. This panel surfaces all three so a
 * number is never silently mistaken for more than it is:
 *
 *  - **Priced region per provider** (`PRICED_REGION_LABEL`) — v1 prices exactly
 *    one US region per provider.
 *  - **Staleness** — when a book's oldest price is older than
 *    `PRICE_MAX_AGE_DAYS`, we flag it. We do NOT hide the number: a stale real
 *    price beats no price.
 *  - **Gaps** — `PriceBook.gaps` are shown, per provider, with a plain-language
 *    reason. 🔴 An unpriced item is "couldn't price", never `$0.00`.
 *
 * All the maths (oldest price, staleness) is done by pure helpers in
 * `@/lib/cost/client`; this component only renders.
 */

import * as React from 'react';
import { MapPin, Clock, CircleAlert, CircleCheck } from 'lucide-react';

import type { PriceBook, PriceGap } from '@/types/cost';
import { PROVIDER_LABEL, PRICED_REGION_LABEL, PRICE_MAX_AGE_DAYS } from '@/types/cost';
import { oldestPriceAt, isBookStale, totalGapCount } from '@/lib/cost/client';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';

const GAP_REASON_LABEL: Record<PriceGap['reason'], string> = {
  fetch_failed: 'the vendor\u2019s pricing page couldn\u2019t be fetched',
  not_found_on_page: 'no matching price was found on the page',
  evidence_rejected: 'the price failed our source-match check and was dropped',
  ambiguous: 'the page had conflicting prices',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface CostCaveatsProps {
  books: PriceBook[];
  /** Injectable for deterministic rendering/tests. When omitted, `now` is
   *  captured once on mount (kept out of the parameter default so it stays a
   *  pure render). */
  now?: number;
}

export function CostCaveats({ books, now: nowProp }: CostCaveatsProps) {
  // Capture "now" once, in a state initializer (a pure render never calls
  // Date.now() inline). A prop override wins, for tests / SSR determinism.
  const [mountedNow] = React.useState(() => Date.now());
  const now = nowProp ?? mountedNow;
  const gapTotal = totalGapCount(books);
  const staleCount = books.filter((b) => isBookStale(b, now)).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">How to read these numbers</CardTitle>
        <CardDescription>
          Prices are real, fetched from each vendor&apos;s public pricing page and cited — but they
          have limits worth knowing.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {/* Priced region per provider */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <MapPin className="size-3.5" aria-hidden />
            Priced region
          </div>
          <p className="text-muted-foreground">
            v1 prices one US region per provider. Costs in other regions differ.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {books.map((book) => (
              <li key={book.provider}>
                <Badge variant="outline" className="gap-1">
                  <span className="font-medium">{PROVIDER_LABEL[book.provider]}</span>
                  <span className="text-muted-foreground">{PRICED_REGION_LABEL[book.provider]}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </div>

        {/* Staleness */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Clock className="size-3.5" aria-hidden />
            Freshness
          </div>
          {staleCount === 0 ? (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <CircleCheck className="size-4 text-emerald-600" aria-hidden />
              All prices were fetched within the last {PRICE_MAX_AGE_DAYS} days.
            </p>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
              <Clock className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              <span className="text-balance">
                {staleCount} provider{staleCount === 1 ? '\u2019s' : 's\u2019'} prices are older than{' '}
                {PRICE_MAX_AGE_DAYS} days and may be out of date. We still show them — a stale real
                price beats no price — but double-check the vendor before committing.
              </span>
            </div>
          )}
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {books.map((book) => {
              const oldest = oldestPriceAt(book);
              const stale = isBookStale(book, now);
              return (
                <li key={book.provider} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 font-medium text-foreground">
                    {PROVIDER_LABEL[book.provider]}
                  </span>
                  <span>
                    {oldest ? `updated ${formatDate(oldest)}` : 'no prices fetched'}
                    {stale ? (
                      <span className="ml-1.5 text-amber-600">(may be stale)</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Gaps — never render unpriced as $0.00 */}
        <div className="flex flex-col gap-2 border-t pt-4">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <CircleAlert className="size-3.5" aria-hidden />
            Couldn&apos;t price {gapTotal > 0 ? `(${gapTotal})` : ''}
          </div>
          {gapTotal === 0 ? (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <CircleCheck className="size-4 text-emerald-600" aria-hidden />
              Every service we needed had a price.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground text-balance">
                We couldn&apos;t get a real price for the items below, so they show as
                &ldquo;unpriced&rdquo; — never as free. Any total that includes one is a floor, not a
                full estimate.
              </p>
              <Accordion>
                {books
                  .filter((b) => b.gaps.length > 0)
                  .map((book) => (
                    <AccordionItem key={book.provider} value={book.provider}>
                      <AccordionTrigger className="text-sm">
                        {PROVIDER_LABEL[book.provider]}
                        <Badge variant="secondary" className="ml-2">
                          {book.gaps.length}
                        </Badge>
                      </AccordionTrigger>
                      <AccordionContent>
                        <ul className="flex flex-col gap-1.5 text-xs">
                          {book.gaps.map((gap, i) => (
                            <li key={i} className="flex flex-col">
                              <code className="text-muted-foreground">
                                {gap.skuId} · {gap.dimensionId}
                              </code>
                              <span>{GAP_REASON_LABEL[gap.reason]}</span>
                            </li>
                          ))}
                        </ul>
                      </AccordionContent>
                    </AccordionItem>
                  ))}
              </Accordion>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
