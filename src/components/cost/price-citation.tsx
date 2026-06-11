'use client';

/**
 * Price citation — the feature's credibility surface. Every priced dimension
 * row exposes the exact provenance of its number behind this popover: the
 * vendor page it was fetched from (clickable), when we fetched it (absolute
 * date + relative age), and the verbatim `evidence` excerpt the evidence gate
 * proved the number appears inside. The user must be able to check us.
 *
 * 🔴 This is ONLY rendered for a priced row (a real `PriceSource`). Unpriced
 * dimensions render the "unpriced" affordance instead — they have no citation
 * to show, and showing an empty one would imply a source we don't have.
 */

import * as React from 'react';
import { BadgeCheck, ExternalLink } from 'lucide-react';

import type { PriceSource } from '@/types/cost';
import { formatFetchedDate, formatRelativeAge } from '@/lib/cost/f2/format';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';

export interface PriceCitationProps {
  source: PriceSource;
  /** Epoch-ms "now" for the relative-age label, passed in for stable render. */
  now: number;
  /** Accessible context, e.g. the dimension label ("Instance hours"). */
  label: string;
}

export function PriceCitation({ source, now, label }: PriceCitationProps) {
  const age = formatRelativeAge(source.fetchedAt, now);
  const date = formatFetchedDate(source.fetchedAt);

  return (
    <Popover>
      <PopoverTrigger
        className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label={`Show the price source for ${label}`}
      >
        <BadgeCheck className="size-3.5 text-emerald-600" aria-hidden />
        Source
      </PopoverTrigger>
      <PopoverContent className="flex flex-col gap-3 text-sm" side="top" align="end">
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Where this price comes from
          </div>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 break-all font-medium text-primary hover:underline"
          >
            {source.url}
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          </a>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Fetched
          </div>
          <div className="text-muted-foreground">
            {date}
            {age ? <span className="text-foreground/70"> · {age}</span> : null}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Evidence (verbatim from the page)
          </div>
          <blockquote className="rounded-md border-l-2 border-emerald-500/50 bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed text-foreground/80">
            {source.evidence}
          </blockquote>
        </div>

        <p className="text-xs text-muted-foreground">
          The number must appear verbatim on the vendor&rsquo;s page, or we drop it rather than
          guess.
        </p>
      </PopoverContent>
    </Popover>
  );
}
