'use client';

/**
 * `/deploy` error view. Every contract error `code` maps to distinct,
 * non-technical copy via `mapDeployError` (in the pure client module, so it's
 * testable). No dead ends: every state offers a way forward.
 *
 *  - `changeUrl` codes (repo_not_found, unsupported_host, validation_error,
 *    bad_request) → the primary affordance is "Try another URL", which focuses
 *    the input; a bare retry of the same URL would be pointless.
 *  - `retryable` codes (repo_unavailable, generation_failed, internal_error,
 *    not_found, network) → a one-click Retry of the same URL.
 *  - `validation_error` additionally lists the flattened `issues`.
 *
 * The message uses `role="alert"` so a screen reader announces it on entry.
 */

import { AlertTriangle, RefreshCw, Pencil } from 'lucide-react';

import type { DeployErrorPresentation } from '@/lib/deploy/client';
import { Button } from '@/components/ui/button';

export interface DeployErrorViewProps {
  /** The URL the user tried, for context. */
  repoUrl: string;
  presentation: DeployErrorPresentation;
  /** Retry the SAME url. Present only for retryable codes. */
  onRetry?: () => void;
  /** Return to the input so the user can edit / paste a different URL. */
  onChangeUrl: () => void;
}

export function DeployErrorView({
  repoUrl,
  presentation,
  onRetry,
  onChangeUrl,
}: DeployErrorViewProps) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <AlertTriangle className="size-8 text-destructive" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">{presentation.title}</h1>
        <p className="text-sm text-muted-foreground text-balance" role="alert">
          {presentation.message}
        </p>
        {repoUrl ? (
          <p className="max-w-full truncate font-mono text-xs text-muted-foreground">{repoUrl}</p>
        ) : null}
      </div>

      {presentation.issues && presentation.issues.length > 0 ? (
        <ul className="mx-auto flex w-full max-w-md list-disc flex-col gap-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 pl-7 text-sm">
          {presentation.issues.map((issue, i) => (
            <li key={`${issue.path}-${i}`}>
              {issue.path ? (
                <span className="font-mono text-xs text-muted-foreground">{issue.path}: </span>
              ) : null}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:justify-center">
        <Button
          type="button"
          variant={presentation.retryable ? 'outline' : 'default'}
          onClick={onChangeUrl}
          className="gap-2"
        >
          <Pencil className="size-4" />
          Try another URL
        </Button>
        {presentation.retryable && onRetry ? (
          <Button type="button" onClick={onRetry} className="gap-2">
            <RefreshCw className="size-4" />
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
