'use client';

/**
 * `<ConfigSnippet>` — one generated config artifact the user can copy or
 * download into THEIR OWN repo so a deploy button actually works (F3-F3,
 * docs/feature-3-one-click-deploy.md §7, §9(5)).
 *
 * We generate; we never commit — it is their repo, and we hold no write access.
 * So each artifact offers:
 *   - **Copy** — `navigator.clipboard.writeText`, with a `document.execCommand`
 *     fallback for older/insecure contexts; a `sonner` toast confirms.
 *   - **Download** — a real file named exactly `artifact.filename`, produced with
 *     a `Blob` + `URL.createObjectURL`, and the object URL is revoked afterwards.
 *
 * `required: true` artifacts (the button won't work without them) are visually
 * distinct from `required: false` hints. Long content scrolls INSIDE the block
 * so it never blows out the page width.
 *
 * The block carries `id={configSnippetAnchorId(provider)}` so a
 * `requiresConfig` provider card can anchor straight to it.
 */

import * as React from 'react';
import { Check, Copy, Download, FileWarning, FileText } from 'lucide-react';
import { toast } from 'sonner';

import type { ConfigArtifact } from '@/types/deploy';
import { DEPLOY_PROVIDER_META } from '@/types/deploy';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { configSnippetAnchorId } from './provider-fit-card';

/** MIME type per artifact language, for a well-formed download. */
const LANGUAGE_MIME: Record<ConfigArtifact['language'], string> = {
  yaml: 'text/yaml',
  json: 'application/json',
  toml: 'text/plain',
};

/**
 * Copy `text` to the clipboard. Prefers the async Clipboard API; falls back to a
 * hidden `<textarea>` + `execCommand('copy')` for non-secure contexts where
 * `navigator.clipboard` is undefined. Returns whether it succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Trigger a browser download of `content` as a file named exactly `filename`.
 * Creates an object URL, clicks a transient anchor, and revokes the URL. Pure
 * side-effect on the DOM — extracted so the handler is unit-testable with the
 * Blob/URL APIs mocked.
 */
export function downloadArtifact(
  filename: string,
  content: string,
  mime: string,
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ConfigSnippetProps {
  artifact: ConfigArtifact;
}

export function ConfigSnippet({ artifact }: ConfigSnippetProps) {
  const [copied, setCopied] = React.useState(false);
  const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const meta = DEPLOY_PROVIDER_META[artifact.provider];
  const RequiredIcon = artifact.required ? FileWarning : FileText;

  const onCopy = React.useCallback(async () => {
    const ok = await copyToClipboard(artifact.content);
    if (ok) {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      toast.success(`Copied ${artifact.filename}`);
    } else {
      toast.error("Couldn't copy — select the text and copy it manually.");
    }
  }, [artifact.content, artifact.filename]);

  const onDownload = React.useCallback(() => {
    try {
      downloadArtifact(
        artifact.filename,
        artifact.content,
        LANGUAGE_MIME[artifact.language],
      );
      toast.success(`Downloaded ${artifact.filename}`);
    } catch {
      toast.error("Couldn't start the download.");
    }
  }, [artifact.filename, artifact.content, artifact.language]);

  return (
    <Card
      id={configSnippetAnchorId(artifact.provider)}
      className={cn(
        'scroll-mt-4 overflow-hidden',
        artifact.required && 'border-amber-500/50',
      )}
      aria-label={`${artifact.filename} config for ${meta.label}`}
    >
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <RequiredIcon
              className={cn(
                'size-4 shrink-0',
                artifact.required
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground',
              )}
              aria-hidden
            />
            <code className="truncate font-mono text-sm font-semibold text-foreground">
              {artifact.filename}
            </code>
            <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
              {artifact.language}
            </Badge>
          </div>
          <Badge
            variant={artifact.required ? 'default' : 'secondary'}
            className={cn(
              'shrink-0',
              artifact.required &&
                'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
            )}
          >
            {artifact.required ? 'Required' : 'Optional'}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground text-pretty">{artifact.why}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCopy} className="gap-1.5">
            {copied ? (
              <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onDownload} className="gap-1.5">
            <Download className="size-3.5" />
            Download
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {/* Long content scrolls inside the block — never blows out the page. */}
        <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground/90">
          <code>{artifact.content}</code>
        </pre>
      </CardContent>
    </Card>
  );
}

export interface ConfigSnippetListProps {
  configs: readonly ConfigArtifact[];
}

export function ConfigSnippetList({ configs }: ConfigSnippetListProps) {
  if (configs.length === 0) return null;
  return (
    <section className="flex flex-col gap-4" aria-label="Generated config files">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold tracking-tight">Config to add to your repo</h2>
        <p className="text-sm text-muted-foreground text-pretty">
          Copy or download these into your own repository. We generate them — we never
          commit to your repo.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {configs.map((artifact) => (
          <ConfigSnippet key={`${artifact.provider}:${artifact.filename}`} artifact={artifact} />
        ))}
      </div>
    </section>
  );
}
