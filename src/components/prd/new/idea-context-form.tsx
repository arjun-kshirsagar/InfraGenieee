'use client';

/**
 * Feature 1, step 1 — the single-screen "describe your idea + a little context"
 * form that replaces the deleted 7-step wizard.
 *
 * Scope (intentionally narrow): this component owns ONLY `idea` + the five
 * `context` answers. The adaptive clarifier step, `additionalNotes`, and the
 * network submit are downstream tasks (F3/F4). The clean seam is `onComplete`,
 * which receives a validated `Pick<ProjectBrief, 'idea' | 'context'>`.
 *
 * What it does NOT do (by design — re-adding these recreates what we deleted):
 * no entity list, no field editor, no auth-method checkboxes, no integration
 * matrix. Inferring those from the idea is the product.
 *
 * Rules / validation live in `@/lib/prd/brief-form` (pure, unit-tested). This
 * file is wiring: react-hook-form + zodResolver, debounced localStorage
 * autosave, a Resume/Start-fresh banner, and shadcn/ui rendering.
 */

import * as React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight } from 'lucide-react';

import {
  USER_SCALE_LABEL,
  TRAFFIC_PATTERN_LABEL,
  BUDGET_BAND_LABEL,
  userScaleSchema,
  trafficPatternSchema,
  budgetBandSchema,
  type UserScale,
  type TrafficPattern,
  type BudgetBand,
} from '@/types/prd';
import {
  ideaContextFormSchema,
  defaultFormValues,
  draftToFormValues,
  formValuesToDraft,
  draftHasContent,
  ideaGuidance,
  toStepOneResult,
  clampTimeline,
  IDEA_MAX,
  TIMELINE_SLIDER_MIN,
  TIMELINE_SLIDER_MAX,
  TIMELINE_HARD_MIN,
  TIMELINE_HARD_MAX,
  type IdeaContextFormValues,
  type BriefStepOneResult,
} from '@/lib/prd/brief-form';
import { loadDraft, saveDraft, clearDraft } from '@/lib/prd/store';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const AUTOSAVE_DEBOUNCE_MS = 600;

export interface IdeaContextFormProps {
  /** Called with the validated idea + context when the user clicks Continue. */
  onComplete: (brief: BriefStepOneResult) => void;
}

/** Small inline field-error line. Renders nothing when there's no message. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive" role="alert">
      {message}
    </p>
  );
}

export function IdeaContextForm({ onComplete }: IdeaContextFormProps) {
  // Resume/Start-fresh state. We read the draft once on mount (client-only) so
  // SSR markup matches the initial defaults and we avoid a hydration mismatch.
  const [resumePrompt, setResumePrompt] = React.useState<IdeaContextFormValues | null>(null);
  const [hydrated, setHydrated] = React.useState(false);

  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<IdeaContextFormValues>({
    resolver: zodResolver(ideaContextFormSchema),
    defaultValues: defaultFormValues(),
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  // ---- Resume detection (runs once, client-side) --------------------------
  React.useEffect(() => {
    const draft = loadDraft();
    if (draftHasContent(draft)) {
      setResumePrompt(draftToFormValues(draft));
    }
    setHydrated(true);
  }, []);

  // ---- Autofocus the idea once we know we're not showing the resume banner -
  React.useEffect(() => {
    if (hydrated && !resumePrompt) {
      setFocus('idea');
    }
  }, [hydrated, resumePrompt, setFocus]);

  // ---- Debounced autosave --------------------------------------------------
  const values = watch();
  React.useEffect(() => {
    // Don't autosave until the user has dismissed/decided the resume banner,
    // otherwise we'd overwrite the saved draft with the defaults on mount.
    if (!hydrated || resumePrompt) return;
    const handle = window.setTimeout(() => {
      saveDraft(formValuesToDraft(values));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
    // watch() returns a fresh object each render; stringify keeps the effect
    // stable and only re-fires when the content actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(values), hydrated, resumePrompt]);

  const ideaValue = watch('idea') ?? '';
  const guidance = ideaGuidance(ideaValue.trim().length);

  const onValid = (data: IdeaContextFormValues) => {
    const result = toStepOneResult(data);
    clearDraft();
    onComplete(result);
  };

  // Focus the first invalid field on a failed submit.
  const onInvalid = (formErrors: typeof errors) => {
    if (formErrors.idea) {
      setFocus('idea');
    } else if (formErrors.context?.timelineWeeks) {
      setFocus('context.timelineWeeks');
    }
  };

  function handleResume() {
    if (resumePrompt) reset(resumePrompt);
    setResumePrompt(null);
  }

  function handleStartFresh() {
    clearDraft();
    reset(defaultFormValues());
    setResumePrompt(null);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          Describe your idea
        </h1>
        <p className="text-muted-foreground text-sm">
          A sentence or two is enough. InfraGenie reasons out the entities, requirements,
          architecture and task plan for you — you don&apos;t fill in a long form.
        </p>
      </header>

      {resumePrompt ? (
        <div
          className="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between"
          role="region"
          aria-label="Resume your draft"
        >
          <p className="text-sm">
            <span className="font-medium">You have an unsaved draft.</span> Pick up where you left
            off?
          </p>
          <div className="flex shrink-0 gap-2">
            <Button type="button" size="sm" onClick={handleResume}>
              Resume
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={handleStartFresh}>
              Start fresh
            </Button>
          </div>
        </div>
      ) : null}

      <form
        noValidate
        onSubmit={handleSubmit(onValid, onInvalid)}
        className="flex flex-col gap-6"
        aria-hidden={resumePrompt ? true : undefined}
      >
        {/* ---- Idea ---------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Your idea</CardTitle>
            <CardDescription>What do you want to build?</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Label htmlFor="idea" className="sr-only">
              Describe your idea
            </Label>
            <Textarea
              id="idea"
              rows={5}
              placeholder="e.g. A marketplace where local bakeries sell surplus bread at day-end discounts…"
              aria-invalid={errors.idea ? true : undefined}
              aria-describedby="idea-guidance"
              className="min-h-32 resize-y"
              {...register('idea')}
            />
            <div className="flex items-start justify-between gap-3">
              <p
                id="idea-guidance"
                className={
                  errors.idea || guidance.tone === 'error'
                    ? 'text-sm text-destructive'
                    : 'text-sm text-muted-foreground'
                }
              >
                {errors.idea?.message ?? guidance.message}
              </p>
              <span
                className={
                  ideaValue.length > IDEA_MAX
                    ? 'shrink-0 text-xs tabular-nums text-destructive'
                    : 'shrink-0 text-xs tabular-nums text-muted-foreground'
                }
                aria-hidden
              >
                {ideaValue.length.toLocaleString()}/{IDEA_MAX.toLocaleString()}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* ---- Context ------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>A few quick questions</CardTitle>
            <CardDescription>
              We&apos;ve picked sensible defaults — change only what you know. Everything else, the
              AI infers.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {/* Scale */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="userScale">Expected scale</Label>
              <Controller
                control={control}
                name="context.userScale"
                render={({ field }) => (
                  <Select
                    items={USER_SCALE_LABEL}
                    value={field.value}
                    onValueChange={(v) => {
                      if (v) field.onChange(v as UserScale);
                    }}
                  >
                    <SelectTrigger id="userScale" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {userScaleSchema.options.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {USER_SCALE_LABEL[opt]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {/* Traffic */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="trafficPattern">Traffic pattern</Label>
              <Controller
                control={control}
                name="context.trafficPattern"
                render={({ field }) => (
                  <Select
                    items={TRAFFIC_PATTERN_LABEL}
                    value={field.value}
                    onValueChange={(v) => {
                      if (v) field.onChange(v as TrafficPattern);
                    }}
                  >
                    <SelectTrigger id="trafficPattern" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {trafficPatternSchema.options.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {TRAFFIC_PATTERN_LABEL[opt]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {/* Budget */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="budgetBand">Monthly budget</Label>
              <Controller
                control={control}
                name="context.budgetBand"
                render={({ field }) => (
                  <Select
                    items={BUDGET_BAND_LABEL}
                    value={field.value}
                    onValueChange={(v) => {
                      if (v) field.onChange(v as BudgetBand);
                    }}
                  >
                    <SelectTrigger id="budgetBand" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {budgetBandSchema.options.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {BUDGET_BAND_LABEL[opt]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {/* Timeline */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="timelineWeeks">Timeline</Label>
                <Controller
                  control={control}
                  name="context.timelineWeeks"
                  render={({ field }) => (
                    <div className="flex items-center gap-1.5">
                      <Input
                        id="timelineWeeks"
                        type="number"
                        inputMode="numeric"
                        min={TIMELINE_HARD_MIN}
                        max={TIMELINE_HARD_MAX}
                        value={field.value}
                        onChange={(e) => {
                          const raw = e.target.valueAsNumber;
                          field.onChange(Number.isNaN(raw) ? '' : clampTimeline(raw));
                        }}
                        onBlur={() => {
                          field.onChange(clampTimeline(Number(field.value)));
                          field.onBlur();
                        }}
                        className="w-20 text-right tabular-nums"
                        aria-invalid={errors.context?.timelineWeeks ? true : undefined}
                      />
                      <span className="text-muted-foreground text-sm">weeks</span>
                    </div>
                  )}
                />
              </div>
              <Controller
                control={control}
                name="context.timelineWeeks"
                render={({ field }) => (
                  <Slider
                    aria-label="Timeline in weeks"
                    min={TIMELINE_SLIDER_MIN}
                    max={TIMELINE_SLIDER_MAX}
                    step={1}
                    value={Math.min(
                      TIMELINE_SLIDER_MAX,
                      Math.max(TIMELINE_SLIDER_MIN, Number(field.value) || TIMELINE_SLIDER_MIN),
                    )}
                    onValueChange={(v) => field.onChange(clampTimeline(Array.isArray(v) ? v[0] : v))}
                    className="py-1"
                  />
                )}
              />
              <FieldError
                id="timeline-error"
                message={errors.context?.timelineWeeks?.message}
              />
            </div>

            {/* Constraints (optional) */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="constraints">
                Hard constraints{' '}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="constraints"
                placeholder="e.g. must be HIPAA compliant, team only knows Python, no vendor lock-in"
                {...register('context.constraints')}
              />
              <FieldError
                id="constraints-error"
                message={errors.context?.constraints?.message}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" size="lg" disabled={isSubmitting} className="gap-2">
            Continue
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

export default IdeaContextForm;
