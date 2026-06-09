'use client';

/**
 * `/cost` — Feature 2 client shell (the F1 task: route frame, PRD picker, data
 * loading, AI recommendation hand-off). The interactive selectors (F2) and the
 * comparison/charts (F3) mount into the seam this shell exposes; they are NOT
 * built here.
 *
 * State machine:
 *
 *   pick ──(choose a PRD)──▶ loading ──▶ explorer
 *     │                         │
 *     │  (?prd=<id> deep-link skips straight to loading)
 *     │                         └─(catalog/prices error)─▶ error → Retry
 *     └─(no PRDs)─▶ empty state → /prd/new
 *
 * Design decisions, mirroring Feature 1:
 *  - PRDs live in `localStorage` (no server persistence), so the picker reads
 *    `listDocuments()` / `loadDocument()` after mount — never on the server.
 *  - The slow call is `GET /api/cost/prices` (a cold cache does real vendor
 *    fetches). We drive a staged-progress heuristic like `generating-step`,
 *    and impose NO client timeout — an `AbortController` cancels only on unmount.
 *  - The AI recommendation NEVER blocks the page: `fetchRecommendation` degrades
 *    to a catalog-default seed on any failure, and we surface a dismissible
 *    notice rather than an error wall.
 *  - All the fetch/mapping/fallback logic lives in the PURE, unit-tested
 *    `@/lib/cost/client`; this component is wiring + presentation.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import type { PrdDocument } from '@/types/prd';
import { listDocuments, loadDocument, type PrdDocumentSummary } from '@/lib/prd/store';
import type {
  CostErrorPresentation,
  RecommendOutcome,
} from '@/lib/cost/client';
import {
  fetchCatalog,
  fetchPrices,
  fetchRecommendation,
  buildCostContext,
} from '@/lib/cost/client';
import { mapComponentsToRoles } from '@/lib/cost/estimate';
import type { ServiceCatalog, PriceBook, InfraRole } from '@/types/cost';

import { CostPrdPicker } from '@/components/cost/cost-prd-picker';
import { CostLoadingView } from '@/components/cost/cost-loading-view';
import { CostErrorView } from '@/components/cost/cost-error-view';
import { CostExplorer } from '@/components/cost/cost-explorer';

/** Everything the explorer needs once loading resolves. */
export interface CostData {
  doc: PrdDocument;
  catalog: ServiceCatalog;
  books: PriceBook[];
  /** Required roles derived from the PRD (client-safe pure derivation). */
  requiredRoles: InfraRole[];
  recommendation: RecommendOutcome;
}

type Stage =
  | { name: 'pick' }
  | { name: 'loading'; doc: PrdDocument }
  | { name: 'error'; doc: PrdDocument; presentation: CostErrorPresentation }
  | { name: 'ready'; data: CostData };

export function CostClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get('prd');

  const [stage, setStage] = React.useState<Stage>({ name: 'pick' });
  // PRD summaries for the picker; `null` = still reading localStorage.
  const [summaries, setSummaries] = React.useState<PrdDocumentSummary[] | null>(null);

  // Cancel any in-flight load on unmount / re-load.
  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abortRef.current?.abort(), []);

  // ---- the load sequence: catalog + prices (blocking) then recommend ------
  const load = React.useCallback(async (doc: PrdDocument) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setStage({ name: 'loading', doc });

    const requiredRoles = mapComponentsToRoles(buildCostContext(doc)).roles;

    try {
      // Catalog is fast and deterministic; prices can be slow on a cold cache.
      // We need both before the explorer can render totals, so we await them
      // together. No client timeout — the signal is the only cancellation.
      const [catalogOut, pricesOut] = await Promise.all([
        fetchCatalog({ signal }),
        fetchPrices(undefined, { signal }),
      ]);

      if (catalogOut.kind === 'error') {
        setStage({ name: 'error', doc, presentation: catalogOut.presentation });
        return;
      }
      if (pricesOut.kind === 'error') {
        setStage({ name: 'error', doc, presentation: pricesOut.presentation });
        return;
      }

      // The recommendation is a SEED, not a gate: it never blocks the page.
      // `fetchRecommendation` degrades to a catalog-default fallback on any
      // failure, so we always get something to mount.
      const recommendation = await fetchRecommendation(buildCostContext(doc), catalogOut.catalog, {
        signal,
      });

      setStage({
        name: 'ready',
        data: {
          doc,
          catalog: catalogOut.catalog,
          books: pricesOut.books,
          requiredRoles,
          recommendation,
        },
      });
    } catch (err) {
      // The only rejection path is an abort (unmount / re-load). If we're still
      // mounted this is a no-op; otherwise the component is gone.
      if ((err as { name?: string })?.name === 'AbortError') return;
      setStage({
        name: 'error',
        doc,
        presentation: {
          code: 'network',
          message:
            "The request didn't complete — this is usually a connection hiccup. Please try again.",
          retryable: true,
          configFault: false,
        },
      });
    }
  }, []);

  // ---- read the PRD list + honour a ?prd= deep-link on mount --------------
  // Ref-guarded so it runs exactly once; the deep-link load kickoff goes
  // through `load` (declared above), which owns the stage transition from its
  // own async flow.
  const bootstrappedRef = React.useRef(false);
  React.useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    const docs = listDocuments();
    setSummaries(docs);
    if (deepLinkId) {
      const doc = loadDocument(deepLinkId);
      if (doc) {
        // Kick the load off the synchronous effect body (it calls setStage as
        // its first step) so we never set state synchronously inside the effect.
        queueMicrotask(() => void load(doc));
      }
      // An unknown deep-link id falls through to the picker, which shows a
      // "we couldn't find that PRD" note alongside the list.
    }
    // Run once on mount; deepLinkId + load are captured then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- render -------------------------------------------------------------
  if (stage.name === 'loading') {
    return <CostLoadingView title={stage.doc.title} onCancel={() => setStage({ name: 'pick' })} />;
  }

  if (stage.name === 'error') {
    return (
      <CostErrorView
        title={stage.doc.title}
        presentation={stage.presentation}
        onRetry={stage.presentation.retryable ? () => void load(stage.doc) : undefined}
        onChangePrd={() => setStage({ name: 'pick' })}
      />
    );
  }

  if (stage.name === 'ready') {
    return (
      <CostExplorer
        data={stage.data}
        onChangePrd={() => setStage({ name: 'pick' })}
        onRetryRecommendation={() => void load(stage.data.doc)}
      />
    );
  }

  // pick
  return (
    <CostPrdPicker
      summaries={summaries}
      unknownDeepLinkId={deepLinkId && summaries && !summaries.some((s) => s.id === deepLinkId) ? deepLinkId : null}
      onSelect={(id) => {
        const doc = loadDocument(id);
        if (doc) {
          // Keep the URL shareable/deep-linkable.
          router.replace(`/cost?prd=${encodeURIComponent(id)}`);
          void load(doc);
        }
      }}
    />
  );
}
