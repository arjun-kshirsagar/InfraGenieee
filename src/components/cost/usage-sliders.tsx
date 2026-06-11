'use client';

/**
 * Usage sliders — the traffic/storage drivers the whole estimate turns on.
 *
 * `HEADLINE_USAGE_KEYS` (MAU, requests, DB storage, CDN egress, compute nodes)
 * render as first-class sliders; every other numeric usage field lives behind
 * an "Advanced" disclosure so nothing is hidden but the common case stays calm.
 *
 * 🔴 Both the slider AND the number input funnel every change through
 * `clampUsageValue`, which enforces `usageProfileSchema`'s bounds — a fat finger
 * cannot type "1000000000" and render a $40bn estimate. The slider is bounded
 * by construction; the number input is the escape hatch that must be clamped.
 */

import * as React from 'react';
import { SlidersHorizontal } from 'lucide-react';

import type { UsageProfile } from '@/types/cost';
import {
  HEADLINE_USAGE_META,
  ADVANCED_USAGE_META,
  clampUsageValue,
  type UsageFieldMeta,
  type UsageKey,
} from '@/lib/cost/f2/usage';
import { formatCompact } from '@/lib/cost/f2/format';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';

export interface UsageSlidersProps {
  usage: UsageProfile;
  onChange: (key: UsageKey, value: number) => void;
}

function UsageSliderRow({
  meta,
  value,
  onChange,
}: {
  meta: UsageFieldMeta;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = `usage-${meta.key}`;
  // Local text state so a user can clear/retype a number without it snapping
  // mid-keystroke; committed (clamped) on blur / Enter.
  const [text, setText] = React.useState<string>(String(value));
  React.useEffect(() => {
    // Sync the local text buffer when the committed value changes externally
    // (seed load, slider drag). Legitimate React↔prop sync, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    const clamped = clampUsageValue(meta.key, Number.isNaN(parsed) ? meta.min : parsed);
    onChange(clamped);
    setText(String(clamped));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-sm">
          {meta.label}
          <span className="ml-1 text-xs font-normal text-muted-foreground">({meta.unit})</span>
        </Label>
        <Input
          id={`${id}-input`}
          type="number"
          inputMode="decimal"
          min={meta.min}
          max={meta.max}
          step={meta.step}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          }}
          aria-label={`${meta.label} in ${meta.unit}`}
          className="h-7 w-28 text-right text-sm tabular-nums"
        />
      </div>
      <Slider
        id={id}
        value={[Math.min(meta.max, Math.max(meta.min, value))]}
        min={meta.min}
        max={meta.max}
        step={meta.step}
        onValueChange={(v) => {
          const next = Array.isArray(v) ? v[0] : v;
          onChange(clampUsageValue(meta.key, next));
        }}
        aria-label={`${meta.label} slider`}
      />
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{formatCompact(meta.min)}</span>
        <span className="text-foreground/70">{meta.hint}</span>
        <span>{formatCompact(meta.max)}</span>
      </div>
    </div>
  );
}

export function UsageSliders({ usage, onChange }: UsageSlidersProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        {HEADLINE_USAGE_META.map((meta) => (
          <UsageSliderRow
            key={meta.key}
            meta={meta}
            value={usage[meta.key]}
            onChange={(v) => onChange(meta.key, v)}
          />
        ))}
      </div>

      <Accordion>
        <AccordionItem value="advanced">
          <AccordionTrigger className="text-sm">
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden />
              Advanced usage ({ADVANCED_USAGE_META.length} more drivers)
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <div className="grid grid-cols-1 gap-5 pt-2 sm:grid-cols-2">
              {ADVANCED_USAGE_META.map((meta) => (
                <UsageSliderRow
                  key={meta.key}
                  meta={meta}
                  value={usage[meta.key]}
                  onChange={(v) => onChange(meta.key, v)}
                />
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
