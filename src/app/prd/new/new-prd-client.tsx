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
 * The `done` stage renders `GeneratingStep`, which submits the brief to
 * `POST /api/prd/generate`, drives the long-wait progress UI, persists the
 * result and navigates to `/prd/[id]`. On a validation error it calls
 * `onEditBrief` to return here to the form (idea/context are restored from the
 * draft, so nothing is retyped).
 *
 * Going **Back** from the clarifier returns to F1 without data loss: F1 reads
 * the draft (which still holds idea/context) and offers Resume. We also keep
 * the last-captured step-1 result in memory so Back is instant.
 */

import * as React from 'react';

import { IdeaContextForm } from '@/components/prd/new/idea-context-form';
import { ClarifierStep } from '@/components/prd/new/clarifier-step';
import { GeneratingStep } from '@/components/prd/new/generating-step';
import type { BriefStepOneResult } from '@/lib/prd/brief-form';
import type { ClarifyInput } from '@/lib/prd/clarify-flow';
import type { Clarification, ProjectBrief } from '@/types/prd';
import { loadDraft, saveDraft } from '@/lib/prd/store';

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
    return (
      <GeneratingStep
        brief={stage.brief}
        onEditBrief={() => setStage({ name: 'form' })}
      />
    );
  }

  return <IdeaContextForm onComplete={handleStepOne} />;
}

