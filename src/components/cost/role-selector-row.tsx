'use client';

/**
 * One role's selector row. For a role the provider can fill it offers:
 *  - a service picker (the provider's services for this role),
 *  - a SKU/size picker showing `specs.summary`,
 *  - a units stepper,
 *  - an enable/disable toggle — 🔴 a disabled row STAYS VISIBLE (dimmed) so the
 *    user can see exactly what they turned off,
 *  - the service's honest `tradeoff` line and `freeTierNote` where present.
 *
 * 🔴 A role the provider genuinely cannot fill renders as an explicit
 * "not available on this provider" gap. It must be impossible to read that as
 * "free" — that is the exact misreading the whole feature guards against — so
 * it is styled as a warning, carries no price, and says so in words.
 */

import * as React from 'react';
import { Ban, Info, Minus, Plus } from 'lucide-react';

import type { InfraRole } from '@/types/cost';
import { INFRA_ROLE_LABEL } from '@/types/cost';
import type { RoleRow } from '@/lib/cost/f2/selection';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface RoleSelectorRowProps {
  row: RoleRow;
  onServiceChange: (role: InfraRole, serviceId: string) => void;
  onSkuChange: (role: InfraRole, skuId: string) => void;
  onUnitsChange: (role: InfraRole, units: number) => void;
  onEnabledChange: (role: InfraRole, enabled: boolean) => void;
}

export function RoleSelectorRow({
  row,
  onServiceChange,
  onSkuChange,
  onUnitsChange,
  onEnabledChange,
}: RoleSelectorRowProps) {
  if (row.kind === 'unsupported') {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <Ban className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{INFRA_ROLE_LABEL[row.role]}</span>
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              Not available on this provider
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            This provider doesn&rsquo;t offer a service for this capability, so it can&rsquo;t run
            your app on its own. This is a gap, <strong>not</strong> a $0 saving.
          </p>
        </div>
      </div>
    );
  }

  const { role, choice, services, service, sku } = row;
  const enabled = choice.enabled;
  const rowId = `role-${role}`;

  return (
    <div
      className={
        'flex flex-col gap-3 rounded-lg border p-4 transition-opacity ' +
        (enabled ? '' : 'opacity-60')
      }
    >
      {/* Header: role + enable toggle */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{INFRA_ROLE_LABEL[role]}</span>
          {!enabled ? (
            <Badge variant="secondary" className="text-[10px]">
              Turned off
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${rowId}-enabled`}
            checked={enabled}
            onCheckedChange={(v) => onEnabledChange(role, v === true)}
            aria-label={`Include ${INFRA_ROLE_LABEL[role]} in the estimate`}
          />
          <Label htmlFor={`${rowId}-enabled`} className="text-xs text-muted-foreground">
            Include
          </Label>
        </div>
      </div>

      {/* Pickers: service + SKU + units */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${rowId}-service`} className="text-xs text-muted-foreground">
            Service
          </Label>
          <Select
            value={service.id}
            onValueChange={(v) => onServiceChange(role, String(v))}
            disabled={!enabled}
          >
            <SelectTrigger id={`${rowId}-service`} className="w-full" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {services.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`${rowId}-sku`} className="text-xs text-muted-foreground">
            Size
          </Label>
          <Select
            value={sku.id}
            onValueChange={(v) => onSkuChange(role, String(v))}
            disabled={!enabled}
          >
            <SelectTrigger id={`${rowId}-sku`} className="w-full" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {service.skus.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Units</Label>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7"
              disabled={!enabled || choice.units <= 1}
              onClick={() => onUnitsChange(role, choice.units - 1)}
              aria-label={`Decrease ${INFRA_ROLE_LABEL[role]} units`}
            >
              <Minus className="size-3.5" />
            </Button>
            <input
              type="number"
              min={1}
              max={200}
              value={choice.units}
              disabled={!enabled}
              onChange={(e) => onUnitsChange(role, Number(e.target.value))}
              aria-label={`${INFRA_ROLE_LABEL[role]} units`}
              className="h-7 w-12 rounded-md border border-input bg-transparent text-center text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7"
              disabled={!enabled || choice.units >= 200}
              onClick={() => onUnitsChange(role, choice.units + 1)}
              aria-label={`Increase ${INFRA_ROLE_LABEL[role]} units`}
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Specs summary */}
      {sku.specs.summary ? (
        <p className="text-xs text-muted-foreground">{sku.specs.summary}</p>
      ) : null}

      {/* Tradeoff + free-tier note */}
      <div className="flex flex-col gap-1.5 border-t pt-2">
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{service.tradeoff}</span>
        </p>
        {service.freeTierNote ? (
          <p className="pl-5 text-xs text-emerald-700 dark:text-emerald-400">
            Free tier: {service.freeTierNote}
          </p>
        ) : null}
      </div>
    </div>
  );
}
