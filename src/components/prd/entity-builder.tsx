'use client';

/**
 * InfraGenie — data-model entity builder (F2).
 *
 * The `dataModel.entities` editor: the hardest questionnaire field, hence its
 * own file. Add/remove entities; per entity add/remove typed fields. Enforces
 * the contract limits (≥ 1 entity, ≤ 25 entities, ≤ 30 fields/entity) and
 * surfaces case-insensitive duplicate entity names, which B2's relationship
 * inference depends on.
 *
 * Fully driven by the schema: field types come from `fieldTypeSchema`, limits
 * from the helpers in `field-logic.ts`. No question-specific branching.
 */

import { useId } from 'react';
import { XIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { fieldTypeSchema } from '@/types/prd';
import {
  type DraftEntity,
  emptyEntity,
  emptyField,
  duplicateEntityNames,
  validateEntities,
  MAX_ENTITIES,
  MAX_FIELDS_PER_ENTITY,
} from '@/components/prd/field-logic';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const FIELD_TYPES = fieldTypeSchema.options;

export interface EntityBuilderProps {
  /** Current entities value (unknown until the user has added any). */
  value: unknown;
  onChange: (value: DraftEntity[]) => void;
  /** Wires the field-level error region + aria-describedby from the parent. */
  errorId?: string;
}

/** Coerce whatever is in the draft into a workable entities array. */
function toEntities(value: unknown): DraftEntity[] {
  if (!Array.isArray(value)) return [];
  return value as DraftEntity[];
}

export function EntityBuilder({ value, onChange, errorId }: EntityBuilderProps) {
  const baseId = useId();
  const entities = toEntities(value);
  const dupNames = duplicateEntityNames(entities);
  const error = validateEntities(entities);
  const atEntityLimit = entities.length >= MAX_ENTITIES;

  /* --- immutable updates -------------------------------------------------- */
  const update = (next: DraftEntity[]) => onChange(next);

  const addEntity = () => {
    if (atEntityLimit) return;
    update([...entities, emptyEntity()]);
  };

  const removeEntity = (index: number) =>
    update(entities.filter((_, i) => i !== index));

  const patchEntity = (index: number, patch: Partial<DraftEntity>) =>
    update(entities.map((e, i) => (i === index ? { ...e, ...patch } : e)));

  const addField = (entityIndex: number) => {
    const entity = entities[entityIndex];
    if (entity.fields.length >= MAX_FIELDS_PER_ENTITY) return;
    patchEntity(entityIndex, { fields: [...entity.fields, emptyField()] });
  };

  const removeField = (entityIndex: number, fieldIndex: number) => {
    const entity = entities[entityIndex];
    patchEntity(entityIndex, {
      fields: entity.fields.filter((_, i) => i !== fieldIndex),
    });
  };

  const patchField = (
    entityIndex: number,
    fieldIndex: number,
    patch: Partial<DraftEntity['fields'][number]>,
  ) => {
    const entity = entities[entityIndex];
    patchEntity(entityIndex, {
      fields: entity.fields.map((f, i) =>
        i === fieldIndex ? { ...f, ...patch } : f,
      ),
    });
  };

  return (
    <div className="flex flex-col gap-4" data-slot="entity-builder">
      {entities.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-input px-4 py-6 text-sm text-muted-foreground">
          <p>No entities yet. Add the core things your product stores — e.g. User, Invoice, LineItem.</p>
          <Button type="button" size="sm" onClick={addEntity}>
            <PlusIcon /> Add your first entity
          </Button>
        </div>
      ) : (
        entities.map((entity, ei) => {
          const isDup =
            entity.name.trim() !== '' &&
            dupNames.has(entity.name.trim().toLowerCase());
          const nameId = `${baseId}-entity-${ei}-name`;
          const descId = `${baseId}-entity-${ei}-desc`;
          const atFieldLimit = entity.fields.length >= MAX_FIELDS_PER_ENTITY;

          return (
            <div
              key={ei}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card/40 p-4"
            >
              <div className="flex items-start gap-3">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor={nameId}>Entity name</Label>
                  <Input
                    id={nameId}
                    value={entity.name}
                    placeholder="Invoice"
                    aria-invalid={isDup || undefined}
                    onChange={(e) => patchEntity(ei, { name: e.target.value })}
                  />
                  {isDup ? (
                    <p className="text-xs text-destructive">
                      Duplicate name — entity names must be unique.
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mt-6 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove entity ${entity.name || ei + 1}`}
                  onClick={() => removeEntity(ei)}
                >
                  <Trash2Icon />
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={descId}>Description (optional)</Label>
                <Input
                  id={descId}
                  value={entity.description ?? ''}
                  placeholder="A bill sent to a customer"
                  onChange={(e) => patchEntity(ei, { description: e.target.value })}
                />
              </div>

              {/* Fields */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Fields
                  </span>
                  <Badge variant="secondary">
                    {entity.fields.length} / {MAX_FIELDS_PER_ENTITY}
                  </Badge>
                </div>

                {entity.fields.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No fields yet — add at least the ones you already know.
                  </p>
                ) : (
                  entity.fields.map((field, fi) => {
                    const fNameId = `${baseId}-e${ei}-f${fi}-name`;
                    const fReqId = `${baseId}-e${ei}-f${fi}-req`;
                    return (
                      <div
                        key={fi}
                        className="flex flex-wrap items-end gap-2 rounded-lg border border-border/60 bg-background/50 p-2"
                      >
                        <div className="flex min-w-[8rem] flex-1 flex-col gap-1">
                          <Label htmlFor={fNameId} className="text-xs">
                            Name
                          </Label>
                          <Input
                            id={fNameId}
                            value={field.name}
                            placeholder="amountCents"
                            onChange={(e) =>
                              patchField(ei, fi, { name: e.target.value })
                            }
                          />
                        </div>

                        <div className="flex min-w-[7rem] flex-col gap-1">
                          <Label className="text-xs">Type</Label>
                          <Select
                            value={field.type}
                            onValueChange={(v) =>
                              patchField(ei, fi, {
                                type: v as DraftEntity['fields'][number]['type'],
                              })
                            }
                          >
                            <SelectTrigger className="w-full" aria-label="Field type">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {FIELD_TYPES.map((t) => (
                                <SelectItem key={t} value={t}>
                                  {t}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <label
                          htmlFor={fReqId}
                          className="flex items-center gap-1.5 pb-2 text-xs font-medium"
                        >
                          <Checkbox
                            id={fReqId}
                            checked={field.required}
                            onCheckedChange={(checked) =>
                              patchField(ei, fi, { required: checked })
                            }
                          />
                          Required
                        </label>

                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Remove field ${field.name || fi + 1}`}
                          onClick={() => removeField(ei, fi)}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    );
                  })
                )}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={atFieldLimit}
                  onClick={() => addField(ei)}
                >
                  <PlusIcon /> Add field
                </Button>
                {atFieldLimit ? (
                  <p className="text-xs text-muted-foreground">
                    Field limit reached ({MAX_FIELDS_PER_ENTITY}).
                  </p>
                ) : null}
              </div>
            </div>
          );
        })
      )}

      {entities.length > 0 ? (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={atEntityLimit}
            onClick={addEntity}
          >
            <PlusIcon /> Add entity
          </Button>
          <span className="text-xs text-muted-foreground">
            {entities.length} / {MAX_ENTITIES} entities
          </span>
        </div>
      ) : null}
      {atEntityLimit ? (
        <p className="text-xs text-muted-foreground">
          Entity limit reached ({MAX_ENTITIES}).
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
