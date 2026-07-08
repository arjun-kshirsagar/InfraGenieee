'use client';

/**
 * `/deploy` — the empty/hero state: what this feature does, the paste field, an
 * example, and an OPTIONAL "planned it in InfraGenie?" PRD picker that attaches
 * `prdContext` to sharpen the analysis.
 *
 * The PRD picker reuses `CostPrdPicker`'s SHAPE (a list of `listDocuments()`
 * summaries) but is deliberately secondary here: pasting a URL is the primary
 * path, and the feature must work with **zero** PRDs — that's the common case
 * and must not look broken. So with no PRDs we show a single quiet line, not a
 * big "you need a PRD first" wall (the URL is enough).
 */

import * as React from 'react';
import Link from 'next/link';
import { Rocket, FileText, Check, Plus, ShieldCheck } from 'lucide-react';

import type { PrdDocumentSummary } from '@/lib/prd/store';
import { Card, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';

import { RepoUrlInput } from './repo-url-input';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export interface DeployEmptyStateProps {
  url: string;
  onUrlChange: (value: string) => void;
  onSubmit: (repoUrl: string) => void;
  analyzing: boolean;
  /** PRD summaries for the optional picker; `null` while reading localStorage. */
  summaries: PrdDocumentSummary[] | null;
  /** Id of the currently attached PRD, if any. */
  attachedPrdId: string | null;
  /** Attach (id) or detach (null) a PRD as context. */
  onAttachPrd: (id: string | null) => void;
}

export function DeployEmptyState({
  url,
  onUrlChange,
  onSubmit,
  analyzing,
  summaries,
  attachedPrdId,
  onAttachPrd,
}: DeployEmptyStateProps) {
  const hasPrds = summaries !== null && summaries.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <header className="flex flex-col items-center gap-3 text-center">
        <span className="rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
          Feature 3 · One-click deploy
        </span>
        <div className="flex items-center gap-2">
          <Rocket className="size-7 text-primary" aria-hidden />
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Ship your repo, the easy way
          </h1>
        </div>
        <p className="text-base text-muted-foreground text-pretty">
          Paste your repository URL. InfraGenie reads it, detects your stack, and tells you which of
          Vercel, Netlify and Render fits best — with a one-click button into each provider&apos;s
          own deploy flow. We never deploy anything ourselves.
        </p>
      </header>

      <Card>
        <CardContent className="py-5">
          <RepoUrlInput
            value={url}
            onChange={onUrlChange}
            onSubmit={onSubmit}
            analyzing={analyzing}
          />
        </CardContent>
      </Card>

      {/* Optional PRD context — secondary, must not dominate the URL path. */}
      <section className="flex flex-col gap-3" aria-labelledby="deploy-prd-heading">
        <div className="flex items-center justify-between gap-2">
          <h2
            id="deploy-prd-heading"
            className="flex items-center gap-2 text-sm font-medium text-muted-foreground"
          >
            <FileText className="size-4" aria-hidden />
            Planned it in InfraGenie? Attach a PRD to sharpen the fit
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal">optional</span>
          </h2>
        </div>

        {summaries === null ? (
          <p className="text-sm text-muted-foreground">Loading your PRDs…</p>
        ) : summaries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-balance">
            No saved PRDs yet — that&apos;s fine, the URL is all we need. If you{' '}
            <Link href="/prd/new" className="font-medium text-foreground underline underline-offset-4">
              generate a PRD
            </Link>{' '}
            first, we can use your budget and architecture to pick a better provider.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {summaries.map((doc) => {
              const attached = doc.id === attachedPrdId;
              return (
                <li key={doc.id}>
                  <Card className={attached ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'}>
                    <CardContent className="flex items-center justify-between gap-4 py-3">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium">{doc.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(doc.createdAt)}
                        </span>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={attached ? 'default' : 'outline'}
                        disabled={analyzing}
                        className="shrink-0 gap-1.5"
                        onClick={() => onAttachPrd(attached ? null : doc.id)}
                        aria-pressed={attached}
                      >
                        {attached ? (
                          <>
                            <Check className="size-4" aria-hidden />
                            Attached
                          </>
                        ) : (
                          <>
                            <Plus className="size-4" aria-hidden />
                            Attach
                          </>
                        )}
                      </Button>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}

        {hasPrds ? (
          <Link
            href="/prd/new"
            className={buttonVariants({ variant: 'ghost', size: 'sm' }) + ' self-start'}
          >
            <Plus className="size-4" />
            New PRD
          </Link>
        ) : null}
      </section>

      <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5" aria-hidden />
        We read public repositories only, and never hold a provider token or deploy on your behalf.
      </p>
    </div>
  );
}
