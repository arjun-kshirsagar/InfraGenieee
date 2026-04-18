'use client';

import { useCallback } from 'react';
import { Download } from 'lucide-react';
import type { PrdDocument } from '@/types/prd';
import { toMarkdown } from '@/lib/prd/markdown';
import { Button } from '@/components/ui/button';
import { CopyButton } from './copy-button';

/** Slugify a title into a safe filename stem. */
function fileStem(doc: PrdDocument): string {
  const base = doc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || doc.id;
}

/**
 * Export controls for the document view: "Copy as Markdown" and "Download .md".
 * Both derive from the single pure `toMarkdown` serialiser so the copied text
 * and the downloaded file are byte-identical.
 */
export function ExportControls({ doc }: { doc: PrdDocument }) {
  const markdown = toMarkdown(doc);

  const onDownload = useCallback(() => {
    try {
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileStem(doc)}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke on the next tick so the download has grabbed the blob.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      // Never crash the page over a download failure.
    }
  }, [markdown, doc]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CopyButton value={markdown} label="Copy as Markdown" />
      <Button type="button" size="sm" variant="outline" onClick={onDownload}>
        <Download />
        Download .md
      </Button>
    </div>
  );
}
