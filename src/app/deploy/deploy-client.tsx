'use client';

/**
 * `/deploy` — Feature 3 client shell (this F3-F1 task: route frame, URL input,
 * PRD picker, loading/error states, and the result **seam** F2/F3 mount into).
 * The result cards themselves are NOT built here — `DeployResultView` exposes
 * named slots that downstream tasks fill.
 *
 * State machine:
 *
 *   input ──(paste + submit)──▶ analyzing ──▶ result
 *     │                            └──(error)──▶ error → Retry / edit URL
 *     └─(?prd=<id> attaches PRD context, stays on input)
 *
 * Design decisions, mirroring `/cost` (`cost-client.tsx`):
 *  - The optional PRD context lives in `localStorage`, so the picker reads
 *    `listDocuments()` / `loadDocument()` after mount — never on the server.
 *  - A `?prd=<id>` deep-link attaches that PRD's context and STAYS on input
 *    (unlike `/cost`, the URL — not the PRD — is what kicks off analysis).
 *  - The analysis is a few seconds (no LLM), but we still impose NO client
 *    timeout: the `AbortController` is the only cancellation (unmount / cancel /
 *    re-submit), per the F1/F2 lesson.
 *  - All fetch/mapping/error-copy logic lives in the PURE, unit-tested
 *    `@/lib/deploy/client`; this component is wiring + presentation.
 *  - A successful plan is persisted by canonical URL (`@/lib/deploy/store`) so a
 *    plain reload restores the last result without re-pasting.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import type { PrdDocument } from '@/types/prd';
import type { DeployPlan, DeployPrdContext } from '@/types/deploy';
import { listDocuments, loadDocument, type PrdDocumentSummary } from '@/lib/prd/store';
import {
  analyzeRepo,
  buildDeployPrdContext,
  type DeployErrorPresentation,
} from '@/lib/deploy/client';
import {
  saveDeployState,
  saveLastAnalyzed,
  loadLastAnalyzed,
  loadDeployState,
} from '@/lib/deploy/store';

import { DeployEmptyState } from '@/components/deploy/deploy-empty-state';
import { DeployLoadingView } from '@/components/deploy/deploy-loading-view';
import { DeployErrorView } from '@/components/deploy/deploy-error-view';
import { DeployResultView } from '@/components/deploy/deploy-result-view';
import { DetectedStackCard } from '@/components/deploy/detected-stack-card';

type Stage =
  | { name: 'input' }
  | { name: 'analyzing'; repoUrl: string }
  | { name: 'error'; repoUrl: string; presentation: DeployErrorPresentation }
  | { name: 'result'; plan: DeployPlan };

/** A short human label for the repo under analysis, before we have a parsed
 *  `RepoRef` back. Best-effort: last two path segments, else the raw URL. */
function labelForRawUrl(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return cleaned || raw;
}

export function DeployClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get('prd');

  const [stage, setStage] = React.useState<Stage>({ name: 'input' });
  // Controlled URL value so a restored analysis / retry can pre-fill it.
  const [url, setUrl] = React.useState('');
  // PRD summaries for the optional picker; `null` = still reading localStorage.
  const [summaries, setSummaries] = React.useState<PrdDocumentSummary[] | null>(null);
  // The attached PRD (id + built context), or null.
  const [attachedPrdId, setAttachedPrdId] = React.useState<string | null>(null);
  const [prdContext, setPrdContext] = React.useState<DeployPrdContext | undefined>(undefined);

  // Cancel any in-flight analysis on unmount / re-submit.
  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abortRef.current?.abort(), []);

  // ---- the analyze sequence ------------------------------------------------
  const analyze = React.useCallback(
    async (repoUrl: string, context: DeployPrdContext | undefined) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      setUrl(repoUrl);
      setStage({ name: 'analyzing', repoUrl });

      try {
        const outcome = await analyzeRepo(repoUrl, context, { signal });
        if (outcome.kind === 'error') {
          setStage({ name: 'error', repoUrl, presentation: outcome.presentation });
          return;
        }
        // Persist by canonical URL so a reload restores it; record the pointer.
        saveDeployState(outcome.plan);
        saveLastAnalyzed(outcome.plan.repo.canonicalUrl);
        setStage({ name: 'result', plan: outcome.plan });
      } catch (err) {
        // The only rejection path is an abort (unmount / cancel / re-submit).
        if ((err as { name?: string })?.name === 'AbortError') return;
        setStage({
          name: 'error',
          repoUrl,
          presentation: {
            code: 'network',
            title: 'The request didn’t complete',
            message:
              'The analysis didn’t finish — this is usually a connection hiccup. Please try again.',
            retryable: true,
            changeUrl: false,
          },
        });
      }
    },
    [],
  );

  // ---- attach / detach a PRD as context ------------------------------------
  const attachPrd = React.useCallback((id: string | null) => {
    if (id === null) {
      setAttachedPrdId(null);
      setPrdContext(undefined);
      return;
    }
    const doc: PrdDocument | null = loadDocument(id);
    if (!doc) {
      // Stale/missing document — treat as a clean detach rather than crashing.
      setAttachedPrdId(null);
      setPrdContext(undefined);
      return;
    }
    try {
      setPrdContext(buildDeployPrdContext(doc));
      setAttachedPrdId(id);
    } catch {
      // A document that can't produce a valid context (e.g. too few components)
      // is simply not attachable; the URL path still works.
      setAttachedPrdId(null);
      setPrdContext(undefined);
    }
  }, []);

  // ---- bootstrap: read PRDs, honour ?prd=, restore last analysis -----------
  const bootstrappedRef = React.useRef(false);
  React.useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    const docs = listDocuments();

    // Read everything synchronously, then apply state in a microtask so we never
    // call setState synchronously in the effect body (avoids cascading renders).
    const wantAttach = deepLinkId && docs.some((d) => d.id === deepLinkId) ? deepLinkId : null;
    const lastUrl = loadLastAnalyzed();
    const restored = lastUrl ? loadDeployState(lastUrl) : null;

    queueMicrotask(() => {
      setSummaries(docs);
      // A `?prd=<id>` deep-link attaches that PRD's context and STAYS on input.
      if (wantAttach) attachPrd(wantAttach);
      // Restore the last successful analysis on a plain reload (no deep-link).
      if (restored) {
        setUrl(restored.repo.canonicalUrl);
        setStage({ name: 'result', plan: restored });
      }
    });
    // Run once on mount; deepLinkId, attachPrd captured then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- render --------------------------------------------------------------
  if (stage.name === 'analyzing') {
    return (
      <DeployLoadingView
        label={labelForRawUrl(stage.repoUrl)}
        onCancel={() => {
          abortRef.current?.abort();
          setStage({ name: 'input' });
        }}
      />
    );
  }

  if (stage.name === 'error') {
    return (
      <DeployErrorView
        repoUrl={stage.repoUrl}
        presentation={stage.presentation}
        onRetry={
          stage.presentation.retryable
            ? () => void analyze(stage.repoUrl, prdContext)
            : undefined
        }
        onChangeUrl={() => setStage({ name: 'input' })}
      />
    );
  }

  if (stage.name === 'result') {
    return (
      <DeployResultView
        plan={stage.plan}
        onAnalyzeAnother={() => {
          setUrl('');
          setStage({ name: 'input' });
        }}
        detectionSlot={
          <DetectedStackCard detection={stage.plan.detection} repo={stage.plan.repo} />
        }
      />
    );
  }

  // input
  return (
    <DeployEmptyState
      url={url}
      onUrlChange={setUrl}
      onSubmit={(repoUrl) => void analyze(repoUrl, prdContext)}
      analyzing={false}
      summaries={summaries}
      attachedPrdId={attachedPrdId}
      onAttachPrd={(id) => {
        attachPrd(id);
        // Keep the URL shareable/deep-linkable with the attached PRD.
        if (id) {
          router.replace(`/deploy?prd=${encodeURIComponent(id)}`);
        } else {
          router.replace('/deploy');
        }
      }}
    />
  );
}
