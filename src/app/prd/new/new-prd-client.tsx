'use client';

/**
 * Client shell for `/prd/new`.
 *
 * F1's scope is the idea + context step only. The clarifier step and the
 * `POST /api/prd/clarify` → `POST /api/prd/generate` submit are F3/F4. So this
 * shell provides the clean seam (`onComplete`) and a non-dead-end confirmation
 * state: when the user clicks Continue with a valid brief, we hold the captured
 * `idea` + `context` in memory and show what comes next, with a way back to
 * edit. F3 replaces this confirmation with the real clarifier + generation.
 */

import * as React from 'react';
import { CheckCircle2 } from 'lucide-react';

import { IdeaContextForm } from '@/components/prd/new/idea-context-form';
import type { BriefStepOneResult } from '@/lib/prd/brief-form';
import {
  USER_SCALE_LABEL,
  TRAFFIC_PATTERN_LABEL,
  BUDGET_BAND_LABEL,
} from '@/types/prd';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export function NewPrdClient() {
  const [brief, setBrief] = React.useState<BriefStepOneResult | null>(null);

  if (brief) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <CheckCircle2 className="size-10 text-primary" />
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Brief captured</h1>
          <p className="text-muted-foreground text-sm">
            Next, InfraGenie will ask any clarifying questions it needs, then generate your PRD,
            architecture and plan. (That step is being wired up.)
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>What you told us</CardTitle>
            <CardDescription>Review before generation.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Idea
              </p>
              <p className="mt-1 whitespace-pre-wrap">{brief.idea}</p>
            </div>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Scale
                </dt>
                <dd className="mt-0.5">{USER_SCALE_LABEL[brief.context.userScale]}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Traffic
                </dt>
                <dd className="mt-0.5">{TRAFFIC_PATTERN_LABEL[brief.context.trafficPattern]}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Budget
                </dt>
                <dd className="mt-0.5">{BUDGET_BAND_LABEL[brief.context.budgetBand]}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Timeline
                </dt>
                <dd className="mt-0.5">
                  {brief.context.timelineWeeks} week{brief.context.timelineWeeks === 1 ? '' : 's'}
                </dd>
              </div>
              {brief.context.constraints ? (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Constraints
                  </dt>
                  <dd className="mt-0.5">{brief.context.constraints}</dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <div className="flex justify-start">
          <Button variant="outline" onClick={() => setBrief(null)}>
            Edit brief
          </Button>
        </div>
      </div>
    );
  }

  return <IdeaContextForm onComplete={setBrief} />;
}
