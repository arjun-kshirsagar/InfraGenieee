'use client';

/**
 * `<ProviderFitCard>` — one provider's verdict + reasons + the big deploy button
 * (F3-F3). This is the payoff of Feature 3: the moment the user actually ships.
 *
 * Non-negotiables baked into this component (docs/feature-3-one-click-deploy.md
 * §4, §9(4)):
 *
 *  - **We never deploy anything.** The button is a plain anchor to `fit.deployUrl`
 *    — the URL the pure `buildDeployUrl` already produced — opened in a NEW TAB
 *    with `rel="noopener noreferrer"`. The component NEVER reconstructs a URL and
 *    NEVER performs a network request. It only emits a link into the provider's
 *    own hosted flow, and it says so in plain words so the user is never fooled
 *    into thinking InfraGenie is deploying for them.
 *  - **The reasoning is the product.** Every `reason` and every `caveat` is
 *    rendered — we do not truncate to two and hide the rest.
 *  - **`requiresConfig` is blocking-ish.** When a fit needs a committed config
 *    file (Render blueprints), a warning renders *before* the button, anchored
 *    down to the generated snippet. We never render a silent button that fails.
 *  - **`not-recommended` still deploys.** We inform; we do not lock the user out
 *    of their own choice. The button looks muted but stays clickable.
 *  - **`primary === null`** (uncertain detection): no card wears a crown.
 *
 * Purely presentational: props in, JSX out. No fetch, no localStorage.
 */

import * as React from 'react';
import {
  ArrowDown,
  Check,
  Crown,
  ExternalLink,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

import type { DeployProvider, FitVerdict, ProviderFit } from '@/types/deploy';
import { DEPLOY_PROVIDER_META } from '@/types/deploy';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

/* -------------------------------------------------------------------------- */
/* Presentation lookups                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Verdict badge copy + variant. Meaning is carried by TEXT and an icon, never by
 * colour alone (a11y + both themes).
 */
const VERDICT_META: Record<
  FitVerdict,
  {
    label: string;
    variant: 'default' | 'secondary' | 'outline' | 'destructive';
    className?: string;
  }
> = {
  recommended: {
    label: 'Recommended',
    variant: 'default',
    className:
      'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  possible: { label: 'Possible', variant: 'secondary' },
  'not-recommended': {
    label: 'Not recommended',
    variant: 'outline',
    className: 'border-destructive/40 text-destructive',
  },
};

/**
 * A stable DOM id for a provider's generated config snippet, so a
 * `requiresConfig` warning can anchor straight to it. Shared with
 * `<ConfigSnippet>` via {@link configSnippetAnchorId}.
 */
export function configSnippetAnchorId(provider: DeployProvider): string {
  return `config-snippet-${provider}`;
}

/* -------------------------------------------------------------------------- */
/* The card                                                                   */
/* -------------------------------------------------------------------------- */

export interface ProviderFitCardProps {
  fit: ProviderFit;
  /** True when THIS provider is the plan's single best fit (crowned). Never
   *  true when `plan.primary` is null. */
  isPrimary: boolean;
}

export function ProviderFitCard({ fit, isPrimary }: ProviderFitCardProps) {
  const meta = DEPLOY_PROVIDER_META[fit.provider];
  const verdict = VERDICT_META[fit.verdict];
  const notRecommended = fit.verdict === 'not-recommended';
  // The provider's public site, for the honest "opens <provider>.com" line.
  const providerHostname = new URL(meta.deployBase).hostname.replace(/^www\./, '');

  return (
    <Card
      className={cn(
        'transition-colors',
        isPrimary && 'border-primary ring-1 ring-primary/30',
      )}
      aria-label={`${meta.label} deployment fit`}
    >
      <CardHeader className="gap-3">
        {isPrimary ? (
          <div className="flex w-fit items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
            <Crown className="size-3.5" aria-hidden />
            Best fit for your app
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold tracking-tight">{meta.label}</h3>
          <Badge
            variant={verdict.variant}
            className={cn('shrink-0', verdict.className)}
          >
            {verdict.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* -------- reasons: ALL of them, never truncated -------- */}
        {fit.reasons.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {fit.reasons.map((reason, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-foreground/90">
                <Check
                  className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden
                />
                <span className="text-pretty">{reason}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {/* -------- caveats: warning-toned, all shown -------- */}
        {fit.caveats.length > 0 ? (
          <ul className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            {fit.caveats.map((caveat, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm text-amber-800/90 dark:text-amber-200/80"
              >
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden
                />
                <span className="text-pretty">{caveat}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {/* -------- requiresConfig: BLOCKING warning BEFORE the button -------- */}
        {fit.requiresConfig ? (
          <div
            role="note"
            className="flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3"
          >
            <div className="flex items-start gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="text-pretty">
                Add the{' '}
                <code className="rounded bg-amber-500/20 px-1 py-0.5 font-mono text-xs">
                  {meta.configFile}
                </code>{' '}
                below to your repo first, or this button won&rsquo;t know what to build.
              </span>
            </div>
            <a
              href={`#${configSnippetAnchorId(fit.provider)}`}
              className="inline-flex w-fit items-center gap-1 text-xs font-medium text-amber-800 underline underline-offset-2 hover:opacity-80 dark:text-amber-300"
            >
              <ArrowDown className="size-3.5" aria-hidden />
              Jump to the {meta.configFile} snippet
            </a>
          </div>
        ) : null}

        {/* -------- the deploy button — a plain anchor to fit.deployUrl -------- */}
        <div className="flex flex-col gap-1.5">
          <a
            href={fit.deployUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`deploy-button-${fit.provider}`}
            className={cn(
              buttonVariants({ variant: notRecommended ? 'outline' : 'default', size: 'lg' }),
              'h-11 w-full gap-2 text-sm font-semibold',
              notRecommended && 'text-muted-foreground',
            )}
          >
            <ExternalLink className="size-4" aria-hidden />
            Deploy to {meta.label}
          </a>
          <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
            <ExternalLink className="size-3" aria-hidden />
            Opens {providerHostname} in a new tab — you deploy on their site, under your
            own account.
          </p>
          {notRecommended ? (
            <p className="text-center text-xs text-muted-foreground text-pretty">
              We advise against this one (see above), but it&rsquo;s your call — the button
              still works.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* The list — renders fits in the exact order they arrive (already sorted)    */
/* -------------------------------------------------------------------------- */

export interface ProviderFitListProps {
  fits: readonly ProviderFit[];
  /** The plan's single best fit, or null when detection was too weak to pick. */
  primary: DeployProvider | null;
}

/** Icon-free lead-in copy for the `primary === null` case. */
const UNCERTAIN_LEAD: { icon: LucideIcon; text: string } = {
  icon: TriangleAlert,
  text:
    "We couldn't read enough of your repo to crown a single best fit, so here are all three with guidance — pick the one that matches how your app runs.",
};

export function ProviderFitList({ fits, primary }: ProviderFitListProps) {
  const UncertainIcon = UNCERTAIN_LEAD.icon;
  return (
    <section className="flex flex-col gap-4" aria-label="Provider deployment options">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold tracking-tight">Where to deploy</h2>
        {primary === null ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground text-pretty">
            <UncertainIcon
              className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden
            />
            {UNCERTAIN_LEAD.text}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground text-pretty">
            All three providers are shown, in order of fit — including the ones we
            advise against, so you can see the reasoning.
          </p>
        )}
      </div>

      {/* Render in the order fits arrive — the plan already score-sorted them.
          Do NOT re-sort. */}
      <div className="flex flex-col gap-4">
        {fits.map((fit) => (
          <ProviderFitCard
            key={fit.provider}
            fit={fit}
            isPrimary={primary !== null && fit.provider === primary}
          />
        ))}
      </div>
    </section>
  );
}
