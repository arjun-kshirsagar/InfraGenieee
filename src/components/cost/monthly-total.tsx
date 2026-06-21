'use client';

/**
 * The big live monthly total — the delight moment. When the target changes
 * (a toggle, a slider, a SKU swap), the displayed figure TWEENS to the new
 * value with requestAnimationFrame so the number feels alive rather than
 * snapping. It respects `prefers-reduced-motion` (snaps instantly) and always
 * lands EXACTLY on the target so what the user reads is the real total, never a
 * mid-tween approximation.
 *
 * 🔴 Honesty affordances live here too:
 *  - an `incomplete` estimate (a required dimension is unpriced) is flagged and
 *    the figure is labelled a FLOOR ("at least"), never a clean estimate;
 *  - `unsupportedRoles` are surfaced as an explicit "can't run N roles" note so
 *    a provider is never read as cheap for being unable to run the app.
 */

import * as React from 'react';
import { AlertTriangle, TriangleAlert } from 'lucide-react';

import type { ProviderEstimate } from '@/types/cost';
import { INFRA_ROLE_LABEL } from '@/types/cost';
import { formatUsd } from '@/lib/cost/f2/format';
import { isEntirelyUnpriced } from '@/lib/cost/estimate/engine';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Syncing React state from an external system (the media query) — the exact
    // sanctioned use of an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Tween a number toward `target` over ~450ms with an ease-out curve. */
function useAnimatedNumber(target: number, disabled: boolean): number {
  const [display, setDisplay] = React.useState(target);
  const fromRef = React.useRef(target);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (disabled) {
      // Reduced-motion: snap straight to the real total, no tween.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplay(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    const duration = 450;
    const start = performance.now();

    const tick = (t: number) => {
      const elapsed = t - start;
      const p = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      const value = from + (target - from) * eased;
      if (p >= 1) {
        setDisplay(target); // land exactly on the real total
        fromRef.current = target;
        rafRef.current = null;
      } else {
        setDisplay(value);
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, disabled]);

  return display;
}

export interface MonthlyTotalProps {
  estimate: ProviderEstimate;
  regionLabel: string;
}

export function MonthlyTotal({ estimate, regionLabel }: MonthlyTotalProps) {
  const reduced = usePrefersReducedMotion();
  const animated = useAnimatedNumber(estimate.monthlyUsd, reduced);
  const incomplete = estimate.incomplete;
  const hasUnsupported = estimate.unsupportedRoles.length > 0;
  // 🔴 Services selected but zero priced dimensions → there is no floor to
  // state. "≥ $0.00" is not meaningful (BLOCKER-3 / MINOR-1); render "not
  // priced" with no dollar figure.
  const notPriced = isEntirelyUnpriced(estimate);

  if (notPriced) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span
            className="text-3xl font-semibold tracking-tight text-muted-foreground sm:text-4xl"
            aria-live="polite"
            aria-label="Monthly cost not priced — no price could be verified for this provider"
          >
            Not priced
          </span>
        </div>

        <p className="text-xs text-muted-foreground">
          For {regionLabel}. We couldn&rsquo;t verify a single price for this provider, so there is no
          cost to show — not $0.00. See the breakdown for which lines are unpriced.
        </p>

        {hasUnsupported ? (
          <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              This provider can&rsquo;t run{' '}
              {estimate.unsupportedRoles.map((r) => INFRA_ROLE_LABEL[r]).join(', ')} — it cannot run
              this app on its own, so this total is not comparable.
            </span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        {incomplete ? (
          <span className="text-sm font-medium text-amber-600" aria-hidden>
            at least
          </span>
        ) : null}
        <span
          className="text-4xl font-semibold tabular-nums tracking-tight sm:text-5xl"
          aria-live="polite"
          aria-label={`Estimated monthly cost ${incomplete ? 'at least ' : ''}${formatUsd(
            estimate.monthlyUsd,
          )}`}
        >
          {formatUsd(animated)}
        </span>
        <span className="text-sm text-muted-foreground">/mo</span>
      </div>

      <p className="text-xs text-muted-foreground">
        Estimated for {regionLabel}. Prices are fetched from each vendor&rsquo;s public pages.
      </p>

      {incomplete ? (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            This is a <strong>floor</strong>, not a full estimate — at least one required price
            couldn&rsquo;t be verified, so real cost is higher. See the breakdown for which line.
          </span>
        </div>
      ) : null}

      {hasUnsupported ? (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            This provider can&rsquo;t run{' '}
            {estimate.unsupportedRoles.map((r) => INFRA_ROLE_LABEL[r]).join(', ')} — it cannot run
            this app on its own, so this total is not comparable.
          </span>
        </div>
      ) : null}
    </div>
  );
}
