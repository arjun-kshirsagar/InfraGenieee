'use client';

/**
 * `<DeployResult>` — the assembled answer for one analysed repo (F3-F3).
 *
 * It composes, in reading order:
 *   1. the F2 detected-stack card ("what we found" + cited "how we know"),
 *   2. the three provider-fit cards in score order (`<ProviderFitList>`),
 *   3. an **assumptions** block — "what we assumed" — given the same first-class
 *      treatment as Feature 1's `prd.assumptions` and Feature 2's
 *      `recommendation.assumptions`,
 *   4. the copyable/downloadable config snippets (`<ConfigSnippetList>`),
 *   5. a "start over / analyse another repo" affordance (no dead ends).
 *
 * The seam `<DeployResultView>` (F1) still owns the repo header + confidence
 * chrome; this component is what fills its `detectionSlot` / `fitsSlot` /
 * `configsSlot`. `<DeployResultView>` renders the "analyze another" button, so
 * the standalone `onAnalyzeAnother` here is optional — used only when
 * `<DeployResult>` is rendered on its own (e.g. a story/fixture page).
 *
 * Purely presentational: props in, JSX out.
 */

import * as React from 'react';
import { Lightbulb, RotateCcw } from 'lucide-react';

import type { DeployPlan } from '@/types/deploy';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DetectedStackCard } from './detected-stack-card';
import { ProviderFitList } from './provider-fit-card';
import { ConfigSnippetList } from './config-snippet';

/**
 * "What we assumed" — the first-class assumptions block, matching F1/F2. Only
 * rendered when the plan actually carries assumptions.
 */
export function DeployAssumptions({ assumptions }: { assumptions: readonly string[] }) {
  if (assumptions.length === 0) return null;
  return (
    <Card aria-labelledby="deploy-assumptions-title">
      <CardHeader>
        <CardTitle
          id="deploy-assumptions-title"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Lightbulb className="size-4" aria-hidden />
          What we assumed
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          {assumptions.map((a, i) => (
            <li key={i} className="text-pretty">
              {a}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export interface DeployResultProps {
  plan: DeployPlan;
  /** Optional standalone "analyse another repo" affordance. When
   *  `<DeployResult>` fills `<DeployResultView>`'s slots, that view supplies its
   *  own button and this is omitted. */
  onAnalyzeAnother?: () => void;
}

export function DeployResult({ plan, onAnalyzeAnother }: DeployResultProps) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <DetectedStackCard detection={plan.detection} repo={plan.repo} />
      <ProviderFitList fits={plan.fits} primary={plan.primary} />
      <DeployAssumptions assumptions={plan.assumptions} />
      <ConfigSnippetList configs={plan.configs} />

      {onAnalyzeAnother ? (
        <div className="flex justify-center pt-2">
          <Button type="button" variant="outline" onClick={onAnalyzeAnother} className="gap-2">
            <RotateCcw className="size-4" />
            Analyze another repo
          </Button>
        </div>
      ) : null}
    </div>
  );
}
