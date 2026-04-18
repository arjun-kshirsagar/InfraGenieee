import type { ArchitectureSection } from '@/types/prd';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { DocSection } from './doc-section';
import { EntityCard } from './entity-card';
import { MermaidDiagram } from './mermaid-diagram';
import { methodBadgeClass } from './badge-styles';

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function ArchitectureTab({ architecture: arch }: { architecture: ArchitectureSection }) {
  const componentKinds = Array.from(new Set(arch.components.map((c) => c.kind)));

  return (
    <div className="flex flex-col gap-10">
      {/* Summary + pattern */}
      <DocSection title="Summary">
        <Card>
          <CardContent className="flex flex-col gap-3">
            <p>{arch.summary}</p>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Pattern
              </span>
              <Badge variant="secondary">{arch.pattern}</Badge>
            </div>
          </CardContent>
        </Card>
      </DocSection>

      {/* Diagram */}
      <DocSection title="Architecture diagram">
        <MermaidDiagram source={arch.diagramMermaid} />
      </DocSection>

      {/* Components grouped by kind */}
      <DocSection title="Components" description={`${arch.components.length} components`}>
        {arch.components.length > 0 ? (
          <div className="flex flex-col gap-5">
            {componentKinds.map((kind) => (
              <div key={kind} className="flex flex-col gap-2">
                <h4 className="text-sm font-semibold capitalize">{kind}</h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  {arch.components
                    .filter((c) => c.kind === kind)
                    .map((c) => (
                      <Card key={c.name}>
                        <CardContent className="flex flex-col gap-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{c.name}</span>
                            <Badge variant="outline" className="font-mono">
                              {c.technology}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">{c.responsibility}</p>
                        </CardContent>
                      </Card>
                    ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No components generated.</Empty>
        )}
      </DocSection>

      {/* Data model */}
      <DocSection title="Data model">
        <div className="flex flex-col gap-4">
          {arch.dataModel.entities.length > 0 ? (
            arch.dataModel.entities.map((e) => <EntityCard key={e.name} entity={e} />)
          ) : (
            <Empty>No entities in the data model.</Empty>
          )}

          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">Relationships</h4>
            {arch.dataModel.relationships.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">From</th>
                      <th className="px-4 py-2 font-medium">To</th>
                      <th className="px-4 py-2 font-medium">Kind</th>
                      <th className="px-4 py-2 font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {arch.dataModel.relationships.map((r, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="px-4 py-2 font-medium">{r.from}</td>
                        <td className="px-4 py-2 font-medium">{r.to}</td>
                        <td className="px-4 py-2">
                          <Badge variant="secondary" className="font-mono">
                            {r.kind}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{r.description ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No relationships defined.</Empty>
            )}
          </div>
        </div>
      </DocSection>

      {/* API endpoints */}
      <DocSection title="API endpoints" description={`${arch.apiEndpoints.length} endpoints`}>
        {arch.apiEndpoints.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Method</th>
                  <th className="px-4 py-2 font-medium">Path</th>
                  <th className="px-4 py-2 font-medium">Purpose</th>
                  <th className="px-4 py-2 font-medium">Auth</th>
                </tr>
              </thead>
              <tbody>
                {arch.apiEndpoints.map((e, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <Badge className={`font-mono ${methodBadgeClass(e.method)}`}>
                        {e.method}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{e.path}</td>
                    <td className="px-4 py-2 text-muted-foreground">{e.purpose}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {e.authRequired ? 'required' : 'public'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No API endpoints generated.</Empty>
        )}
      </DocSection>

      {/* Infrastructure recommendation */}
      <DocSection title="Infrastructure recommendation">
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <Card>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="font-medium text-muted-foreground">Hosting</dt>
                <dd>{arch.infrastructure.hosting}</dd>
                <dt className="font-medium text-muted-foreground">Database</dt>
                <dd>{arch.infrastructure.database}</dd>
                <dt className="font-medium text-muted-foreground">Cache</dt>
                <dd>{arch.infrastructure.cache ?? '— (not needed)'}</dd>
                <dt className="font-medium text-muted-foreground">Storage</dt>
                <dd>{arch.infrastructure.storage ?? '— (not needed)'}</dd>
                <dt className="font-medium text-muted-foreground">CI/CD</dt>
                <dd>{arch.infrastructure.cicd}</dd>
                <dt className="font-medium text-muted-foreground">Environments</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {arch.infrastructure.environments.length > 0 ? (
                    arch.infrastructure.environments.map((env) => (
                      <Badge key={env} variant="outline">
                        {env}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Why this stack
              </span>
              {arch.infrastructure.rationale.length > 0 ? (
                <ul className="ml-4 list-disc space-y-1.5 text-sm">
                  {arch.infrastructure.rationale.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              ) : (
                <span className="text-sm text-muted-foreground">No rationale provided.</span>
              )}
            </CardContent>
          </Card>
        </div>
      </DocSection>
    </div>
  );
}
