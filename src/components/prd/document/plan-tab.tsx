import type { PlanSection, PlanTask } from '@/types/prd';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Zap } from 'lucide-react';
import { DocSection } from './doc-section';

const AREA_LABEL: Record<PlanTask['area'], string> = {
  frontend: 'frontend',
  backend: 'backend',
  database: 'database',
  infra: 'infra',
  design: 'design',
  qa: 'qa',
};

function TaskCard({
  task,
  isCritical,
  titleOf,
}: {
  task: PlanTask;
  isCritical: boolean;
  titleOf: (id: string) => string;
}) {
  return (
    <Card className={isCritical ? 'ring-2 ring-amber-400/60' : undefined}>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">
            {task.id}
          </Badge>
          <Badge variant="secondary">{AREA_LABEL[task.area]}</Badge>
          <Badge variant="outline">{task.estimateHours} h</Badge>
          {isCritical ? (
            <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
              <Zap className="size-3" />
              critical path
            </Badge>
          ) : null}
          <span className="font-medium">{task.title}</span>
        </div>

        <p className="text-sm text-muted-foreground">{task.description}</p>

        {task.dependsOn.length > 0 ? (
          <p className="text-sm">
            <span className="font-medium text-muted-foreground">Depends on: </span>
            {task.dependsOn.map((id, i) => (
              <span key={id}>
                {i > 0 ? ', ' : ''}
                {titleOf(id)}
              </span>
            ))}
          </p>
        ) : null}

        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Acceptance criteria
          </span>
          <ul className="mt-1 ml-4 list-disc space-y-1 text-sm">
            {task.acceptanceCriteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

export function PlanTab({ plan }: { plan: PlanSection }) {
  // id → title for dependsOn / critical-path rendering.
  const titleById = new Map<string, string>();
  for (const m of plan.milestones) for (const t of m.tasks) titleById.set(t.id, t.title);
  const titleOf = (id: string): string => titleById.get(id) ?? id;
  const critical = new Set(plan.criticalPath);

  return (
    <div className="flex flex-col gap-8">
      {/* Header totals */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Total estimate
            </span>
            <span className="text-2xl font-semibold">{plan.totalEstimateHours} h</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Calendar estimate
            </span>
            <span className="text-2xl font-semibold">
              {plan.estimatedCalendarWeeks} weeks
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Milestones
            </span>
            <span className="text-2xl font-semibold">{plan.milestones.length}</span>
          </CardContent>
        </Card>
      </div>

      {/* Milestones */}
      {plan.milestones.length > 0 ? (
        plan.milestones.map((m, mi) => (
          <DocSection key={m.id} title={`${mi + 1}. ${m.name}`} description={m.goal}>
            {m.tasks.length > 0 ? (
              <div className="flex flex-col gap-3">
                {m.tasks.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    isCritical={critical.has(t.id)}
                    titleOf={titleOf}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
                No tasks in this milestone.
              </p>
            )}
          </DocSection>
        ))
      ) : (
        <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
          No milestones generated.
        </p>
      )}

      {/* Critical path summary */}
      <DocSection
        title="Critical path"
        description="Tasks whose slippage pushes the whole timeline."
      >
        {plan.criticalPath.length > 0 ? (
          <ol className="ml-5 list-decimal space-y-1">
            {plan.criticalPath.map((id) => (
              <li key={id}>{titleOf(id)}</li>
            ))}
          </ol>
        ) : (
          <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
            No critical path computed.
          </p>
        )}
      </DocSection>
    </div>
  );
}
