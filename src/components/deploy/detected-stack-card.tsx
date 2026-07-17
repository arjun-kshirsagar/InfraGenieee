'use client';

/**
 * `<DetectedStackCard>` — the "here's what we found in your repo" card (F3-F2).
 *
 * **This card is the product's credibility.** Anyone can print "Next.js"; what
 * makes InfraGenie trustworthy is showing *the line in the file* that says so.
 * So every claim on this card is backed by an expandable, one-click-reachable
 * "How we know" panel that lists each {@link DetectionSignal} with its `path`
 * and its **verbatim `excerpt`** — a signal we don't render is evidence we're
 * hiding (docs/feature-3-one-click-deploy.md §2, §9(3)).
 *
 * It is a **pure presentational component**: props in, JSX out. No fetching, no
 * `localStorage`, no side effects. It renders from a fixture `StackDetection`
 * exactly as it renders from a live one — that is what makes it testable.
 *
 * The `confidence: 'unknown'` state is a **first-class design, not an error**:
 * we could not read the repo, we say so plainly, we name no framework, and we
 * point the user at the fact that all three providers are still offered below.
 * It must not look like a failure.
 */

import * as React from 'react';
import {
  Boxes,
  CircleHelp,
  Clock,
  Cpu,
  Database,
  ExternalLink,
  FileCode,
  FileText,
  GitBranch,
  HardDrive,
  Info,
  Layers,
  ListOrdered,
  Package,
  Radio,
  Server,
  ShieldQuestion,
  TriangleAlert,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';

import type {
  AppShape,
  DetectionConfidence,
  DetectionSignal,
  RepoRef,
  ServiceNeed,
  StackDetection,
} from '@/types/deploy';
import { formatRepoLabel } from '@/lib/deploy/repo-url';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';

/* -------------------------------------------------------------------------- */
/* Presentation lookups (verbatim data stays untouched — these only gloss)    */
/* -------------------------------------------------------------------------- */

/**
 * Confidence badge copy + variant. Meaning is carried by TEXT (and an icon),
 * never by colour alone, so the badge is legible to colour-blind users and in
 * both themes.
 */
const CONFIDENCE_META: Record<
  DetectionConfidence,
  {
    label: string;
    hint: string | null;
    variant: 'default' | 'secondary' | 'outline' | 'destructive';
    icon: LucideIcon;
    /** Extra classes for the amber "unknown" treatment (warning, not error). */
    className?: string;
  }
> = {
  high: {
    label: 'High confidence',
    hint: null,
    variant: 'default',
    icon: ShieldQuestion,
  },
  medium: {
    label: 'Medium confidence',
    hint: 'some guesswork',
    variant: 'outline',
    icon: ShieldQuestion,
  },
  low: {
    label: 'Low confidence',
    hint: 'mostly guesswork',
    variant: 'secondary',
    icon: ShieldQuestion,
  },
  unknown: {
    label: "We couldn\u2019t read this repo",
    hint: null,
    variant: 'outline',
    icon: TriangleAlert,
    className:
      'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
};

/** Plain-English gloss for the app shape — the jargon plus what it means. */
const APP_SHAPE_META: Record<AppShape, { label: string; gloss: string }> = {
  static: { label: 'Static', gloss: 'static site — prebuilt files, no server' },
  ssr: { label: 'SSR', gloss: 'server-rendered per request' },
  fullstack: {
    label: 'Full-stack',
    gloss: 'full-stack app with its own server',
  },
  'api-only': { label: 'API only', gloss: 'a server with no UI' },
  unknown: { label: 'Unknown', gloss: 'we couldn\u2019t tell the app shape' },
};

/** Icon + label for each managed-service need. */
const SERVICE_NEED_META: Record<ServiceNeed, { label: string; icon: LucideIcon }> = {
  database: { label: 'Database', icon: Database },
  cache: { label: 'Cache', icon: HardDrive },
  queue: { label: 'Queue', icon: ListOrdered },
  'object-storage': { label: 'Object storage', icon: Package },
  cron: { label: 'Cron', icon: Clock },
  websockets: { label: 'WebSockets', icon: Radio },
  'background-worker': { label: 'Background worker', icon: Cpu },
};

/** Group header for each signal kind in the "how we know" panel. */
const SIGNAL_KIND_META: Record<
  DetectionSignal['kind'],
  { label: string; icon: LucideIcon }
> = {
  'file-present': { label: 'Files present', icon: FileCode },
  dependency: { label: 'Dependencies', icon: Package },
  script: { label: 'Scripts', icon: Waypoints },
  'file-content': { label: 'File contents', icon: FileText },
  metadata: { label: 'Repository metadata', icon: Info },
};

/** Stable render order for the signal groups. */
const SIGNAL_KIND_ORDER: readonly DetectionSignal['kind'][] = [
  'file-present',
  'dependency',
  'script',
  'file-content',
  'metadata',
] as const;

/* -------------------------------------------------------------------------- */
/* Small presentational pieces                                                */
/* -------------------------------------------------------------------------- */

/** One labelled cell in the summary grid. `value` is rendered verbatim. */
function SummaryCell({
  icon: Icon,
  label,
  value,
  gloss,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  gloss?: string | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </span>
      <span className="text-sm font-medium text-foreground">{value}</span>
      {gloss ? <span className="text-xs text-muted-foreground">{gloss}</span> : null}
    </div>
  );
}

/** A single cited signal: path (inline code), verbatim excerpt, and `implies`. */
function SignalRow({ signal }: { signal: DetectionSignal }) {
  const strong = signal.weight === 'strong';
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
          {signal.path}
        </code>
        <Badge
          variant={strong ? 'default' : 'outline'}
          className="shrink-0 gap-1 text-[10px]"
        >
          {strong ? (
            <ShieldQuestion className="size-3" aria-hidden />
          ) : (
            <CircleHelp className="size-3" aria-hidden />
          )}
          {strong ? 'strong signal' : 'weak signal'}
        </Badge>
      </div>

      {/* Verbatim evidence — never truncated to the point it stops being
          evidence; it wraps and scrolls instead. */}
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border-l-2 border-primary/40 bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed text-foreground/80">
        {signal.excerpt}
      </pre>

      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Implies:</span> {signal.implies}
      </p>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* The card                                                                   */
/* -------------------------------------------------------------------------- */

export interface DetectedStackCardProps {
  detection: StackDetection;
  /** The repo we analysed — powers the header label + outbound link. */
  repo: RepoRef;
}

export function DetectedStackCard({ detection, repo }: DetectedStackCardProps) {
  const conf = CONFIDENCE_META[detection.confidence];
  const ConfIcon = conf.icon;
  const isUnknown = detection.confidence === 'unknown';
  const shape = APP_SHAPE_META[detection.appShape];

  // Signals grouped by kind, in a stable display order. Empty groups drop out.
  const grouped = SIGNAL_KIND_ORDER.map((kind) => ({
    kind,
    signals: detection.signals.filter((s) => s.kind === kind),
  })).filter((g) => g.signals.length > 0);

  return (
    <Card aria-labelledby="detected-stack-title">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle id="detected-stack-title" className="text-sm text-muted-foreground">
              What we found in your repo
            </CardTitle>
            <a
              href={repo.canonicalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1.5 font-mono text-base font-semibold tracking-tight text-foreground hover:underline"
            >
              <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{formatRepoLabel(repo)}</span>
              <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </a>
          </div>

          <Badge
            variant={conf.variant}
            className={['shrink-0 gap-1', conf.className].filter(Boolean).join(' ')}
          >
            <ConfIcon className="size-3" aria-hidden />
            {conf.label}
            {conf.hint ? <span className="font-normal opacity-80">· {conf.hint}</span> : null}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {isUnknown ? (
          /* -------- unknown: a designed state, not a failure -------- */
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              We couldn&rsquo;t read this repository&rsquo;s contents
            </div>
            <p className="text-sm text-amber-800/90 dark:text-amber-200/80 text-pretty">
              So we&rsquo;re not going to guess your stack. Content reading is GitHub-only for now,
              and the repo may be private, empty, or on another host. See the specifics under{' '}
              <span className="font-medium">why below</span>. All three providers — Vercel, Netlify
              and Render — are still offered underneath, with guidance so you can pick the right one
              yourself.
            </p>
          </div>
        ) : (
          <>
            {/* -------- summary grid -------- */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <SummaryCell
                icon={Boxes}
                label="Framework"
                value={
                  detection.framework === 'unknown' ? (
                    <span className="text-muted-foreground">Not identified</span>
                  ) : detection.framework === 'other' ? (
                    'Other (unrecognised)'
                  ) : (
                    detection.framework
                  )
                }
                gloss={detection.frameworkVersion}
              />
              <SummaryCell
                icon={Server}
                label="Runtime"
                value={
                  detection.runtime === 'unknown' ? (
                    <span className="text-muted-foreground">Unknown</span>
                  ) : (
                    detection.runtime
                  )
                }
              />
              <SummaryCell
                icon={Layers}
                label="App shape"
                value={shape.label}
                gloss={shape.gloss}
              />
              <SummaryCell
                icon={Package}
                label="Package manager"
                value={
                  detection.packageManager === 'unknown' ? (
                    <span className="text-muted-foreground">Unknown</span>
                  ) : detection.packageManager === 'none' ? (
                    'None'
                  ) : (
                    detection.packageManager
                  )
                }
              />
              <SummaryCell
                icon={Boxes}
                label="Monorepo"
                value={detection.monorepo ? 'Yes' : 'No'}
                gloss={detection.monorepo ? 'workspace root detected' : null}
              />
            </div>

            <Separator />

            {/* -------- managed-service needs -------- */}
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Managed services needed
              </span>
              {detection.needs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No managed services needed — this app can deploy on its own.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {detection.needs.map((need) => {
                    const meta = SERVICE_NEED_META[need];
                    const NeedIcon = meta.icon;
                    return (
                      <li key={need}>
                        <Badge variant="secondary" className="gap-1.5">
                          <NeedIcon className="size-3" aria-hidden />
                          {meta.label}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}

        {/* -------- notes / caveats (both states) -------- */}
        {detection.notes.length > 0 ? (
          <div
            className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3"
            role="note"
            aria-label="Detection caveats"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <Info className="size-3.5" aria-hidden />
              Things to know
            </span>
            <ul className="flex flex-col gap-1.5">
              {detection.notes.map((note, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-foreground/90">
                  <TriangleAlert
                    className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                    aria-hidden
                  />
                  <span className="text-pretty">{note}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* -------- "how we know" — cited evidence, one click away -------- */}
        {detection.signals.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Accordion className="rounded-lg border">
              <AccordionItem value="how-we-know" className="border-b-0 px-3">
                <AccordionTrigger className="py-3">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <FileCode className="size-4 text-muted-foreground" aria-hidden />
                    How we know
                    <Badge variant="outline" className="text-[10px]">
                      {detection.signals.length} cited{' '}
                      {detection.signals.length === 1 ? 'signal' : 'signals'}
                    </Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-3">
                  <p className="pb-3 text-xs text-muted-foreground text-pretty">
                    Every claim above is backed by a real line in your repo. Here is each one, with
                    the file it came from and the exact text we read.
                  </p>
                  <div className="flex flex-col gap-4">
                    {grouped.map((group) => {
                      const meta = SIGNAL_KIND_META[group.kind];
                      const GroupIcon = meta.icon;
                      return (
                        <section key={group.kind} className="flex flex-col gap-2">
                          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            <GroupIcon className="size-3.5" aria-hidden />
                            {meta.label}
                          </h4>
                          <ul className="flex flex-col gap-2">
                            {group.signals.map((signal) => (
                              <SignalRow key={signal.id} signal={signal} />
                            ))}
                          </ul>
                        </section>
                      );
                    })}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
