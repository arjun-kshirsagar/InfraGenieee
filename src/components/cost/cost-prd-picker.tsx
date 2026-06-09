'use client';

/**
 * The `/cost` PRD picker. PRDs live in `localStorage`, so the parent reads them
 * after mount and passes `summaries` (or `null` while still reading).
 *
 * Three states, no dead ends:
 *  - loading    → summaries === null
 *  - empty      → summaries === []  →  a clear path to `/prd/new`
 *  - list       → pick a PRD to cost out
 *
 * An unknown `?prd=<id>` deep-link surfaces a small "we couldn't find that PRD"
 * note above the list rather than a blank screen.
 */

import Link from 'next/link';
import { FileText, Plus, Wallet, AlertCircle } from 'lucide-react';

import type { PrdDocumentSummary } from '@/lib/prd/store';
import { Card, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export interface CostPrdPickerProps {
  summaries: PrdDocumentSummary[] | null;
  unknownDeepLinkId: string | null;
  onSelect: (id: string) => void;
}

export function CostPrdPicker({ summaries, unknownDeepLinkId, onSelect }: CostPrdPickerProps) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Wallet className="size-6 text-primary" aria-hidden />
          <h1 className="text-2xl font-semibold tracking-tight">Deployment cost predictor</h1>
        </div>
        <p className="text-sm text-muted-foreground text-balance">
          Pick a PRD and InfraGenie estimates what it costs to run across AWS, Google Cloud, Azure,
          Vercel and DigitalOcean — seeded from your architecture, with real, cited vendor prices.
        </p>
      </header>

      {unknownDeepLinkId ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <p>
            We couldn&apos;t find a saved PRD with id{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{unknownDeepLinkId}</code>. It
            may have been generated in a different browser or cleared from storage. Pick one below
            instead.
          </p>
        </div>
      ) : null}

      {summaries === null ? (
        <p className="text-sm text-muted-foreground">Loading your PRDs…</p>
      ) : summaries.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <FileText className="size-9 text-muted-foreground" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="font-medium">You need a PRD first</p>
              <p className="text-sm text-muted-foreground text-balance">
                The cost predictor reads your app&apos;s architecture from a generated PRD. Create
                one and it&apos;ll take about a minute.
              </p>
            </div>
            <Link href="/prd/new" className={buttonVariants()}>
              <Plus className="size-4" />
              Generate a PRD
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Choose a PRD to cost out</h2>
            <Link
              href="/prd/new"
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              <Plus className="size-4" />
              New PRD
            </Link>
          </div>
          <ul className="flex flex-col gap-3">
            {summaries.map((doc) => (
              <li key={doc.id}>
                <Card className="transition-colors hover:bg-muted/40">
                  <CardContent className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium">{doc.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">{doc.id}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="hidden text-sm text-muted-foreground sm:inline">
                        {formatDate(doc.createdAt)}
                      </span>
                      <Button type="button" size="sm" onClick={() => onSelect(doc.id)}>
                        Predict cost
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
