'use client';

/**
 * `/deploy` — the repository URL paste field.
 *
 * Design constraints from the task:
 *  - A real `<label>` bound to the input (accessibility).
 *  - **Client-side SHAPE validation only**, purely for instant feedback ("does
 *    this look like a git URL?"). The server owns the authoritative parser
 *    (docs §8), so we NEVER block a submit the server might accept — the hint is
 *    advisory and the submit button stays enabled for any non-empty value.
 *  - Enter submits.
 *  - Disabled + spinner while an analysis is in flight.
 *  - Shows an example URL.
 */

import * as React from 'react';
import { Loader2, Github, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export const EXAMPLE_REPO_URL = 'https://github.com/vercel/next-learn';

/**
 * A permissive "does this look like a git repo URL?" check for INSTANT UI
 * feedback only. It is intentionally loose — it must never reject something the
 * server's `parseRepoUrl` would accept. Returns `true` for anything that could
 * plausibly resolve to `<host>/<owner>/<repo>` on a git host, including the
 * `git@`, bare-host and `.git` forms.
 */
export function looksLikeRepoUrl(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 5) return false;
  // Strip a leading scheme (https://, ssh://, git://) or an `scp` user prefix.
  const withoutScheme = s
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/^[^@/\s]+@/, '')
    .replace(':', '/'); // git@host:owner/repo → host/owner/repo
  // Expect at least host/owner/repo — three slash-separated, non-empty segments.
  const segments = withoutScheme.split(/[/]/).filter((seg) => seg.length > 0);
  if (segments.length < 3) return false;
  // The first segment should look like a hostname (contains a dot).
  return segments[0].includes('.');
}

export interface RepoUrlInputProps {
  /** Controlled value so the parent can pre-fill from a restored analysis. */
  value: string;
  onChange: (value: string) => void;
  /** Fires on submit (Enter or the button) with the trimmed raw URL. */
  onSubmit: (repoUrl: string) => void;
  /** True while an analysis is in flight — disables the field + shows a spinner. */
  analyzing: boolean;
  /** Optional id override; defaults to `deploy-repo-url`. */
  id?: string;
}

export function RepoUrlInput({
  value,
  onChange,
  onSubmit,
  analyzing,
  id = 'deploy-repo-url',
}: RepoUrlInputProps) {
  const trimmed = value.trim();
  const hasValue = trimmed.length > 0;
  // Advisory only: shown when the user has typed something that clearly isn't a
  // URL yet. Never gates the submit.
  const showShapeHint = hasValue && !looksLikeRepoUrl(trimmed);

  const submit = React.useCallback(() => {
    if (analyzing || !hasValue) return;
    onSubmit(trimmed);
  }, [analyzing, hasValue, onSubmit, trimmed]);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Label htmlFor={id} className="text-sm font-medium">
        <Github className="size-4" aria-hidden />
        Your repository URL
      </Label>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={EXAMPLE_REPO_URL}
          value={value}
          disabled={analyzing}
          aria-invalid={showShapeHint || undefined}
          aria-describedby={`${id}-help`}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 flex-1 font-mono text-sm"
        />
        <Button type="submit" disabled={analyzing || !hasValue} className="h-10 gap-2 sm:w-auto">
          {analyzing ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Analyzing…
            </>
          ) : (
            <>
              <Search className="size-4" aria-hidden />
              Analyze
            </>
          )}
        </Button>
      </div>

      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {showShapeHint ? (
          <span className="text-destructive">
            That doesn&apos;t look like a repository URL yet — try something like{' '}
            <code className="rounded bg-muted px-1 py-0.5">{EXAMPLE_REPO_URL}</code>.
          </span>
        ) : (
          <>
            Paste a public GitHub, GitLab or Bitbucket URL — e.g.{' '}
            <code className="rounded bg-muted px-1 py-0.5">{EXAMPLE_REPO_URL}</code>. We read it, not
            deploy it.
          </>
        )}
      </p>
    </form>
  );
}
