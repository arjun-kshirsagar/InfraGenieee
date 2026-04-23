'use client';

/**
 * InfraGenie — read-only review summary before Generate (F3).
 *
 * Renders a compact, per-step view of every answer the user gave, with an
 * "Edit" link per step that jumps the wizard back to that step. Purely
 * presentational: it reads the draft via the same dot-path helpers as the shell
 * and never mutates state. Labels come from the data-driven `QUESTIONNAIRE`, so
 * adding a question needs no change here.
 */

import { QUESTIONNAIRE } from '@/lib/prd/questionnaire';
import { getAnswer } from '@/lib/prd/draft';
import { isQuestionVisible } from '@/components/prd/field-logic';
import { formatAnswerValue } from '@/components/prd/format-answer';
import type { QuestionnaireDraft, QuestionDef } from '@/types/prd';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export interface ReviewSummaryProps {
  draft: QuestionnaireDraft;
  /** Jump the wizard to the given step index (used by per-step "Edit"). */
  onEditStep: (stepIndex: number) => void;
}

export function ReviewSummary({ draft, onEditStep }: ReviewSummaryProps) {
  const read = (path: string) => getAnswer(draft, path);

  return (
    <div className="flex flex-col gap-4" data-slot="review-summary">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Review your answers</h2>
        <p className="text-sm text-muted-foreground">
          Check everything below, then generate your PRD. You can edit any step.
        </p>
      </div>

      {QUESTIONNAIRE.steps.map((step, stepIndex) => {
        const visible = step.questions.filter((q) => isQuestionVisible(q, read));
        return (
          <Card key={step.key} data-step-key={step.key}>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
              <CardTitle className="text-base">{step.title}</CardTitle>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onEditStep(stepIndex)}
                aria-label={`Edit ${step.title}`}
              >
                Edit
              </Button>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {visible.map((q: QuestionDef) => (
                  <div key={q.path} className="flex flex-col gap-0.5">
                    <dt className="text-xs font-medium text-muted-foreground">{q.label}</dt>
                    <dd className="text-sm break-words">
                      {formatAnswerValue(q, read(q.path))}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
