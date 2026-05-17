'use client';

/**
 * InfraGenie — saved PRD documents list.
 *
 * Reads `listDocuments()` from localStorage after mount (browser-only). Renders
 * a loading state, an empty state (no saved docs yet), and the list of saved
 * documents linking to `/prd/[id]`.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { listDocuments, type PrdDocumentSummary } from '@/lib/prd/store';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; docs: PrdDocumentSummary[] };

export function DocumentList() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: 'ready', docs: listDocuments() });
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Your PRDs</h1>
          <p className="text-sm text-muted-foreground">
            Documents you&apos;ve generated on this browser.
          </p>
        </div>
        <Link href="/prd/new" className={buttonVariants()}>
          <Plus />
          New PRD
        </Link>
      </div>

      {state.status === 'loading' ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : state.docs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <FileText className="size-9 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">No documents yet</p>
              <p className="text-sm text-muted-foreground">
                Describe your idea and the AI writes your first PRD, architecture, and plan.
              </p>
            </div>
            <Link href="/prd/new" className={buttonVariants({ variant: 'outline' })}>
              Start a new PRD
            </Link>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {state.docs.map((doc) => (
            <li key={doc.id}>
              <Link href={`/prd/${doc.id}`} className="block">
                <Card className="transition-colors hover:bg-muted/40">
                  <CardContent className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium">{doc.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">{doc.id}</span>
                    </div>
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {formatDate(doc.createdAt)}
                    </span>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
