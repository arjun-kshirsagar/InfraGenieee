'use client';

/**
 * InfraGenie — client-rendered PRD document view.
 *
 * Documents live in localStorage (there is no `GET /api/prd/:id` in v1), so
 * loading MUST happen on the client after mount. Until then we render a loading
 * state; if the id is unknown or the stored data fails validation we render a
 * clear empty state with a route back to the wizard — never a blank screen or a
 * crash.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, FileWarning } from 'lucide-react';
import type { PrdDocument } from '@/types/prd';
import { loadDocument } from '@/lib/prd/store';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PrdTab } from './prd-tab';
import { ArchitectureTab } from './architecture-tab';
import { PlanTab } from './plan-tab';
import { ExportControls } from './export-controls';

type LoadState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'ready'; doc: PrdDocument };

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

export function DocumentView({ id }: { id: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const doc = loadDocument(id);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(doc ? { status: 'ready', doc } : { status: 'not-found' });
  }, [id]);

  if (state.status === 'loading') {
    return (
      <div className="mx-auto flex min-h-[50vh] w-full max-w-5xl items-center justify-center px-6 text-sm text-muted-foreground">
        Loading document…
      </div>
    );
  }

  if (state.status === 'not-found') {
    return (
      <div className="mx-auto flex min-h-[50vh] w-full max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
        <FileWarning className="size-10 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Document not found</h1>
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t find a saved PRD with id{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{id}</code>. It may have been
            generated in a different browser, cleared from storage, or the link is wrong.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/prd" className={buttonVariants({ variant: 'outline' })}>
            All documents
          </Link>
          <Link href="/prd/new" className={buttonVariants()}>
            Start a new PRD
          </Link>
        </div>
      </div>
    );
  }

  const { doc } = state;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      {/* Header */}
      <header className="flex flex-col gap-4">
        <Link
          href="/prd"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          All documents
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{doc.title}</h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="font-mono">
                {doc.id}
              </Badge>
              <span>Created {formatDate(doc.createdAt)}</span>
              <span>·</span>
              <span>Generator v{doc.generatorVersion}</span>
            </div>
          </div>
          <ExportControls doc={doc} />
        </div>
      </header>

      {/* Tabs */}
      <Tabs defaultValue="prd" className="gap-6">
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="prd">PRD</TabsTrigger>
          <TabsTrigger value="architecture">Architecture</TabsTrigger>
          <TabsTrigger value="plan">Plan</TabsTrigger>
        </TabsList>

        <TabsContent value="prd">
          <PrdTab prd={doc.prd} />
        </TabsContent>
        <TabsContent value="architecture">
          <ArchitectureTab architecture={doc.architecture} />
        </TabsContent>
        <TabsContent value="plan">
          <PlanTab plan={doc.plan} />
        </TabsContent>
      </Tabs>

      {/* Footer export (long docs — repeat the action at the bottom) */}
      <div className="flex justify-end border-t pt-4">
        <ExportControls doc={doc} />
      </div>
    </div>
  );
}
