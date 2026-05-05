'use client';

/**
 * Client shell for `/prd/new` — the Feature 1 flow state machine.
 *
 *   form ──(Continue)──▶ clarify ──(Generate)──▶ done → onComplete(ProjectBrief)
 *          ◀──(Back)──────────┘
 *
 * F1 (`IdeaContextForm`) owns idea + context and hands off a validated
 * `Pick<ProjectBrief,'idea'|'context'>`. F2 (`ClarifierStep`, this task) layers
 * on the adaptive clarifier + "anything else?" notes and produces a complete,
 * `projectBriefSchema`-valid `ProjectBrief`.
 *
 * The `onComplete(ProjectBrief)` seam is where F3 (generate submit) takes over.
 * Until F3 lands here, we show a non-dead-end confirmation of the assembled
 * brief with a way back to edit — the same pattern F1 used for its seam.
 *
 * Going **Back** from the clarifier returns to F1 without data loss: F1 reads
 * the draft (which still holds idea/context) and offers Resume. We also keep
 * the last-captured step-1 result in memory so Back is instant.
 */

import * as React from 'react';
import { CheckCircle2 } from 'lucide-react';

import { IdeaContextForm } from '@/components/prd/new/idea-context-form';
import { ClarifierStep } from '@/components/prd/new/clarifier-step';
import type { BriefStepOneResult } from '@/lib/prd/brief-form';
import type { ClarifyInput } from '@/lib/prd/clarify-flow';
import type { Clarification, ProjectBrief } from '@/types/prd';
import {
  USER_SCALE_LABEL,
  TRAFFIC_PATTERN_LABEL,
  BUDGET_BAND_LABEL,
} from '@/types/prd';
import { loadDraft, saveDraft } from '@/lib/prd/store';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

type Stage =
  | { name: 'form' }
  | { name: 'clarify'; input: ClarifyInput }
  | { name: 'done'; brief: ProjectBrief };

export function NewPrdClient() {
  const [stage, setStage] = React.useState<Stage>({ name: 'form' });

  // ---- form → clarify ----------------------------------------------------
  function handleStepOne(result: BriefStepOneResult) {
    // Note: IdeaContextForm clears the draft on a valid submit. Re-persist
    // idea+context so Back can restore it and the clarifier autosave has a base
    // to merge into.
    saveDraft({ idea: result.idea, context: result.context });
    setStage({ name: 'clarify', input: result });
  }

  // ---- clarify → done ----------------------------------------------------
  function handleBriefComplete(brief: ProjectBrief) {
    setStage({ name: 'done', brief });
  }

  // ---- clarify autosave: merge clarifications + notes into the draft -----
  function handleClarifyAutosave(patch: {
    clarifications?: Clarification[];
    additionalNotes?: string;
  }) {
    if (stage.name !== 'clarify') return;
    const existing = loadDraft() ?? {};
    saveDraft({
      ...existing,
      idea: stage.input.idea,
      context: stage.input.context,
      ...(patch.clarifications ? { clarifications: patch.clarifications } : {}),
      ...(patch.additionalNotes ? { additionalNotes: patch.additionalNotes } : {}),
    });
  }

  if (stage.name === 'clarify') {
    const draft = loadDraft();
    return (
      <ClarifierStep
        input={stage.input}
        savedClarifications={draft?.clarifications}
        savedNotes={draft?.additionalNotes}
        onComplete={handleBriefComplete}
        onBack={() => setStage({ name: 'form' })}
        onAutosave={handleClarifyAutosave}
      />
    );
  }

  if (stage.name === 'done') {
    return <BriefCaptured brief={stage.brief} onEdit={() => setStage({ name: 'form' })} />;
  }

  return <IdeaContextForm onComplete={handleStepOne} />;
}

/* -------------------------------------------------------------------------- */
/* Confirmation seam (replaced by F3's generate submit)                       */
/* -------------------------------------------------------------------------- */

function BriefCaptured({ brief, onEdit }: { brief: ProjectBrief; onEdit: () => void }) {
  const answered = brief.clarifications.filter((c) => c.answer.trim().length > 0);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <CheckCircle2 className="size-10 text-primary" />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Brief ready</h1>
        <p className="text-muted-foreground text-sm">
          InfraGenie will now generate your PRD, architecture and plan from this. (Generation is
          being wired up next.)
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What InfraGenie will build from</CardTitle>
          <CardDescription>Review before generation.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <div>
            <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Idea</p>
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

          {answered.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Clarifications
              </p>
              <ul className="flex flex-col gap-2">
                {answered.map((c, i) => (
                  <li key={i} className="rounded-md bg-muted/40 p-2.5">
                    <p className="font-medium">{c.question}</p>
                    <p className="text-muted-foreground mt-0.5">{c.answer}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {brief.additionalNotes ? (
            <div>
              <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Additional notes
              </p>
              <p className="mt-1 whitespace-pre-wrap">{brief.additionalNotes}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex justify-start">
        <Button variant="outline" onClick={onEdit}>
          Edit brief
        </Button>
      </div>
    </div>
  );
}
