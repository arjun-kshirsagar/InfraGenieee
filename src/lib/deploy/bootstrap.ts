/**
 * A PRD deep-link expresses intent to start a new, context-aware analysis.
 * Only a plain visit may restore the previous repository result.
 */
export function shouldRestoreLastAnalysis(attachedPrdId: string | null): boolean {
  return attachedPrdId === null;
}
