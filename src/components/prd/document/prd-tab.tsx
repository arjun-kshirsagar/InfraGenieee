import type { PrdSection } from '@/types/prd';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { DocSection } from './doc-section';
import { priorityBadgeClass, PRIORITY_LABEL } from './badge-styles';

/** A dashed-border placeholder for a section that has no items. */
function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function PrdTab({ prd }: { prd: PrdSection }) {
  const nfrCategories = Array.from(new Set(prd.nonFunctionalRequirements.map((n) => n.category)));

  return (
    <div className="flex flex-col gap-10">
      {/* Overview */}
      <DocSection title="Overview">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardContent className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Problem
              </span>
              <p>{prd.overview.problem}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Solution
              </span>
              <p>{prd.overview.solution}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Target users
              </span>
              <p>{prd.overview.targetUsers}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Value proposition
              </span>
              {prd.overview.valueProposition.length > 0 ? (
                <ul className="ml-4 list-disc space-y-1">
                  {prd.overview.valueProposition.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
              ) : (
                <span className="text-sm text-muted-foreground">None specified.</span>
              )}
            </CardContent>
          </Card>
        </div>
      </DocSection>

      {/* Goals / Non-goals */}
      <div className="grid gap-8 md:grid-cols-2">
        <DocSection title="Goals">
          {prd.goals.length > 0 ? (
            <ul className="ml-4 list-disc space-y-1.5">
              {prd.goals.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          ) : (
            <Empty>No goals listed.</Empty>
          )}
        </DocSection>

        <DocSection title="Non-goals">
          {prd.nonGoals.length > 0 ? (
            <ul className="ml-4 list-disc space-y-1.5">
              {prd.nonGoals.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          ) : (
            <Empty>No non-goals listed.</Empty>
          )}
        </DocSection>
      </div>

      {/* User stories */}
      <DocSection title="User stories" description={`${prd.userStories.length} stories`}>
        {prd.userStories.length > 0 ? (
          <div className="flex flex-col gap-3">
            {prd.userStories.map((s) => (
              <Card key={s.id}>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono">
                      {s.id}
                    </Badge>
                    <Badge className={priorityBadgeClass(s.priority)}>
                      {PRIORITY_LABEL[s.priority]}
                    </Badge>
                  </div>
                  <p>
                    As a <strong>{s.asA}</strong>, I want <strong>{s.iWant}</strong>, so that{' '}
                    <strong>{s.soThat}</strong>.
                  </p>
                  <div>
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Acceptance criteria
                    </span>
                    <ul className="mt-1 ml-4 list-disc space-y-1 text-sm">
                      {s.acceptanceCriteria.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Empty>No user stories generated.</Empty>
        )}
      </DocSection>

      {/* Functional requirements */}
      <DocSection
        title="Functional requirements"
        description={`${prd.functionalRequirements.length} requirements`}
      >
        {prd.functionalRequirements.length > 0 ? (
          <div className="flex flex-col divide-y rounded-lg border">
            {prd.functionalRequirements.map((r) => (
              <div key={r.id} className="flex flex-col gap-1.5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {r.id}
                  </Badge>
                  <Badge className={priorityBadgeClass(r.priority)}>{r.priority}</Badge>
                  <span className="font-medium">{r.title}</span>
                </div>
                <p className="text-sm text-muted-foreground">{r.detail}</p>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No functional requirements generated.</Empty>
        )}
      </DocSection>

      {/* Non-functional requirements grouped by category */}
      <DocSection
        title="Non-functional requirements"
        description={`${prd.nonFunctionalRequirements.length} requirements across ${nfrCategories.length} categories`}
      >
        {prd.nonFunctionalRequirements.length > 0 ? (
          <div className="flex flex-col gap-5">
            {nfrCategories.map((cat) => (
              <div key={cat} className="flex flex-col gap-2">
                <h4 className="text-sm font-semibold capitalize">{cat}</h4>
                <div className="flex flex-col divide-y rounded-lg border">
                  {prd.nonFunctionalRequirements
                    .filter((n) => n.category === cat)
                    .map((n) => (
                      <div key={n.id} className="flex flex-col gap-1 p-4">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">
                            {n.id}
                          </Badge>
                          <span className="font-medium">{n.requirement}</span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium text-foreground">Why: </span>
                          {n.rationale}
                        </p>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No non-functional requirements generated.</Empty>
        )}
      </DocSection>

      {/* Success metrics */}
      <DocSection title="Success metrics">
        {prd.successMetrics.length > 0 ? (
          <ul className="ml-4 list-disc space-y-1.5">
            {prd.successMetrics.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        ) : (
          <Empty>No success metrics listed.</Empty>
        )}
      </DocSection>

      {/* Risks */}
      <DocSection title="Risks">
        {prd.risks.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Risk</th>
                  <th className="px-4 py-2 font-medium">Impact</th>
                  <th className="px-4 py-2 font-medium">Mitigation</th>
                </tr>
              </thead>
              <tbody>
                {prd.risks.map((r, i) => (
                  <tr key={i} className="border-b last:border-0 align-top">
                    <td className="px-4 py-2">{r.risk}</td>
                    <td className="px-4 py-2">
                      <Badge className={priorityBadgeClass(r.impact)}>{r.impact}</Badge>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{r.mitigation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No risks identified.</Empty>
        )}
      </DocSection>

      {/* Open questions */}
      <DocSection title="Open questions">
        {prd.openQuestions.length > 0 ? (
          <ul className="ml-4 list-disc space-y-1.5">
            {prd.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        ) : (
          <Empty>No open questions.</Empty>
        )}
      </DocSection>
    </div>
  );
}
