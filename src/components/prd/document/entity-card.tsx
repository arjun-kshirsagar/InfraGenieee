import type { Entity } from '@/types/prd';
import { Badge } from '@/components/ui/badge';

/**
 * Compact table rendering of an entity's fields. Shared by the Architecture
 * data-model view and the questionnaire-answers echo.
 */
export function EntityCard({ entity }: { entity: Entity }) {
  return (
    <div className="rounded-lg border">
      <div className="flex flex-col gap-1 border-b bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">{entity.name}</span>
          <Badge variant="outline" className="font-mono">
            {entity.fields.length} field{entity.fields.length === 1 ? '' : 's'}
          </Badge>
        </div>
        {entity.description ? (
          <p className="text-sm text-muted-foreground">{entity.description}</p>
        ) : null}
      </div>

      {entity.fields.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">No fields defined.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Field</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Required</th>
                <th className="px-4 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {entity.fields.map((f) => (
                <tr key={f.name} className="border-b last:border-0">
                  <td className="px-4 py-2 font-mono text-xs">{f.name}</td>
                  <td className="px-4 py-2">
                    <Badge variant="secondary" className="font-mono">
                      {f.type}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {f.required ? 'required' : 'optional'}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{f.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
