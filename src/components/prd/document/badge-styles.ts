/**
 * Colour helpers for document badges. Kept out of the JSX so priority/method
 * colouring is consistent across the PRD, Architecture, and Plan tabs.
 *
 * The base `Badge` component has no semantic colour variants beyond
 * default/secondary/outline/destructive, so we layer Tailwind classes on top
 * via `className` for the domain-specific colourings (HTTP methods, priorities).
 */

import type { Priority } from '@/types/prd';

/** Tailwind classes for an HTTP method badge (GET/POST/…). */
export function methodBadgeClass(method: string): string {
  switch (method) {
    case 'GET':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'POST':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-300';
    case 'PATCH':
    case 'PUT':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'DELETE':
      return 'bg-rose-500/15 text-rose-700 dark:text-rose-300';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/** Tailwind classes for a priority / impact badge (p0/p1/p2). */
export function priorityBadgeClass(priority: Priority): string {
  switch (priority) {
    case 'p0':
      return 'bg-rose-500/15 text-rose-700 dark:text-rose-300';
    case 'p1':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'p2':
      return 'bg-slate-500/15 text-slate-700 dark:text-slate-300';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/** Human labels for priority levels, shown alongside the raw code. */
export const PRIORITY_LABEL: Record<Priority, string> = {
  p0: 'p0 · must have',
  p1: 'p1 · should have',
  p2: 'p2 · nice to have',
};
