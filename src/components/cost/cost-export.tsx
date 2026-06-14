'use client';

/**
 * Comparison export — a copyable / downloadable markdown summary of the whole
 * cost comparison, including per-line source URLs + fetch timestamps. Mirrors
 * `prd/document/export-controls.tsx`: a "Copy as Markdown" button (reusing
 * `CopyButton`) and a "Download .md" button, both derived from the SAME pure
 * `buildComparisonMarkdown` serialiser so the copied text and the downloaded
 * file are byte-identical and both defensible (every price cites its source).
 *
 * `now` is captured once on mount (never in render → no hydration mismatch),
 * for the "generated" line in the export.
 */

import * as React from 'react';
import { Download } from 'lucide-react';

import type { CostComparison } from '@/types/cost';
import {
  buildComparisonMarkdown,
  comparisonFileStem,
  type ProviderTradeoff,
} from '@/lib/cost/f3/export-md';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/prd/document/copy-button';

export interface CostExportProps {
  title: string;
  comparison: CostComparison;
  tradeoffs: readonly ProviderTradeoff[];
}

export function CostExport({ title, comparison, tradeoffs }: CostExportProps) {
  // Capture "now" once on mount so the markdown is stable within a session and
  // the render body never reads the clock (SSR-safe).
  const [now] = React.useState(() => Date.now());

  const markdown = React.useMemo(
    () => buildComparisonMarkdown({ title, comparison, tradeoffs, now }),
    [title, comparison, tradeoffs, now],
  );

  const onDownload = React.useCallback(() => {
    try {
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${comparisonFileStem(title)}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      // Never crash the page over a download failure.
    }
  }, [markdown, title]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CopyButton value={markdown} label="Copy comparison" />
      <Button type="button" size="sm" variant="outline" onClick={onDownload}>
        <Download />
        Download .md
      </Button>
    </div>
  );
}
