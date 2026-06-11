/**
 * InfraGenie — Feature 2 usage-slider metadata. PURE, DOM-free.
 *
 * The usage sliders must respect `usageProfileSchema`'s bounds so a fat finger
 * cannot render a $40bn estimate (docs / contract note on `usageProfileSchema`).
 * Rather than hand-copy the min/max — which would drift from the contract — we
 * read them straight off the zod schema shape at module load. Each field also
 * carries UI-only metadata (label, unit, a sensible step, whether it's integer)
 * that is not expressible in the contract.
 *
 * `HEADLINE_USAGE_KEYS` render as first-class sliders; every OTHER numeric
 * usage field is exposed behind the "Advanced" disclosure so nothing is hidden,
 * yet the common case stays uncluttered.
 */

import {
  usageProfileSchema,
  HEADLINE_USAGE_KEYS,
  type UsageProfile,
} from '@/types/cost';

export type UsageKey = keyof UsageProfile;

export interface UsageFieldMeta {
  key: UsageKey;
  label: string;
  /** Short unit suffix shown next to the value, e.g. "req/mo", "GB". */
  unit: string;
  min: number;
  max: number;
  /** Slider step. Chosen per-field so the slider is usable across its range. */
  step: number;
  /** True → the value is a whole number (nodes, seats). */
  integer: boolean;
  /** One-line hint on what this driver affects. */
  hint: string;
}

/** UI copy for every usage field. Bounds are filled from the schema below. */
const FIELD_UI: Record<UsageKey, Omit<UsageFieldMeta, 'key' | 'min' | 'max'>> = {
  monthlyActiveUsers: { label: 'Monthly active users', unit: 'MAU', step: 1_000, integer: false, hint: 'Drives traffic, requests and storage sizing.' },
  monthlyRequests: { label: 'Monthly requests', unit: 'req/mo', step: 100_000, integer: false, hint: 'Total HTTP requests served across the app.' },
  avgResponseKb: { label: 'Avg response size', unit: 'KB', step: 1, integer: false, hint: 'Average payload per response — drives egress.' },
  computeNodes: { label: 'Always-on compute nodes', unit: 'nodes', step: 1, integer: true, hint: 'How many web/worker instances run continuously.' },
  computeHoursPerNode: { label: 'Compute hours / node', unit: 'hrs/mo', step: 1, integer: false, hint: '730 = always on; lower models scale-to-zero.' },
  computeVcpuPerNode: { label: 'vCPU per node', unit: 'vCPU', step: 0.25, integer: false, hint: 'Average vCPU consumed per node (metered platforms).' },
  computeMemoryGbPerNode: { label: 'Memory per node', unit: 'GB', step: 0.25, integer: false, hint: 'Average GiB RAM per node (metered platforms).' },
  serverlessInvocations: { label: 'Serverless invocations', unit: '/mo', step: 100_000, integer: false, hint: 'Function invocations per month.' },
  avgServerlessDurationMs: { label: 'Avg function duration', unit: 'ms', step: 10, integer: false, hint: 'Mean execution time per invocation.' },
  serverlessMemoryMb: { label: 'Function memory', unit: 'MB', step: 64, integer: false, hint: 'Memory allocated per function.' },
  dbStorageGb: { label: 'Database storage', unit: 'GB', step: 5, integer: false, hint: 'Provisioned relational DB storage.' },
  dbBackupGb: { label: 'DB backup storage', unit: 'GB', step: 5, integer: false, hint: 'Backup storage beyond the free allowance.' },
  nosqlReadsPerMonth: { label: 'NoSQL reads', unit: '/mo', step: 100_000, integer: false, hint: 'Read units / reads per month.' },
  nosqlWritesPerMonth: { label: 'NoSQL writes', unit: '/mo', step: 100_000, integer: false, hint: 'Write units / writes per month.' },
  nosqlStorageGb: { label: 'NoSQL storage', unit: 'GB', step: 5, integer: false, hint: 'Stored document/key-value data.' },
  cacheGb: { label: 'Cache memory', unit: 'GB', step: 1, integer: false, hint: 'Redis-compatible cache size.' },
  queueMessagesPerMonth: { label: 'Queue messages', unit: '/mo', step: 100_000, integer: false, hint: 'Messages / operations per month.' },
  objectStorageGb: { label: 'Object storage', unit: 'GB', step: 10, integer: false, hint: 'Blob / object storage stored.' },
  objectWriteOpsPerMonth: { label: 'Object write ops', unit: '/mo', step: 100_000, integer: false, hint: 'Class-A / PUT-style operations.' },
  objectReadOpsPerMonth: { label: 'Object read ops', unit: '/mo', step: 100_000, integer: false, hint: 'Class-B / GET-style operations.' },
  cdnEgressGb: { label: 'CDN egress', unit: 'GB', step: 100, integer: false, hint: 'Data transfer out through the CDN.' },
  cdnRequestsPerMonth: { label: 'CDN requests', unit: '/mo', step: 1_000_000, integer: false, hint: 'Requests served by the CDN.' },
  originEgressGb: { label: 'Origin egress', unit: 'GB', step: 10, integer: false, hint: 'Egress that bypasses the CDN (APIs, webhooks).' },
  searchIndexGb: { label: 'Search index size', unit: 'GB', step: 5, integer: false, hint: 'Full-text search index storage.' },
  buildMinutesPerMonth: { label: 'CI/CD build minutes', unit: 'min/mo', step: 10, integer: false, hint: 'Build minutes consumed per month.' },
  seats: { label: 'Paid seats', unit: 'seats', step: 1, integer: true, hint: 'Developer-team seats (not end users).' },
};

/**
 * Read `{ min, max }` for a numeric usage field straight off the zod schema, so
 * the slider bounds can never drift from the contract. Falls back to a wide
 * default only if introspection fails (it won't for the current schema shape).
 */
function boundsFor(key: UsageKey): { min: number; max: number } {
  const shape = usageProfileSchema.shape as Record<string, unknown>;
  const field = shape[key];
  let min = 0;
  let max = Number.MAX_SAFE_INTEGER;
  // zod v4 exposes checks via `_zod.def.checks`; be defensive across shapes.
  const def = (field as { _zod?: { def?: { checks?: unknown[] } } })?._zod?.def;
  const checks = (def?.checks ?? []) as Array<{
    _zod?: { def?: { check?: string; value?: number } };
  }>;
  for (const c of checks) {
    const cdef = c?._zod?.def;
    if (!cdef) continue;
    if (cdef.check === 'greater_than' && typeof cdef.value === 'number') min = cdef.value;
    if (cdef.check === 'less_than' && typeof cdef.value === 'number') max = cdef.value;
  }
  return { min, max };
}

/** Full metadata (UI copy + contract bounds) for one usage field. */
export function usageFieldMeta(key: UsageKey): UsageFieldMeta {
  const { min, max } = boundsFor(key);
  return { key, min, max, ...FIELD_UI[key] };
}

/** Headline sliders, in the contract's order. */
export const HEADLINE_USAGE_META: UsageFieldMeta[] = HEADLINE_USAGE_KEYS.map(usageFieldMeta);

/** Every non-headline numeric usage field, for the Advanced disclosure. */
export const ADVANCED_USAGE_META: UsageFieldMeta[] = (
  Object.keys(FIELD_UI) as UsageKey[]
)
  .filter((k) => !HEADLINE_USAGE_KEYS.includes(k))
  .map(usageFieldMeta);

/**
 * Clamp a raw numeric input to a field's contract bounds (and to an integer
 * where required). This is the guard that stops an out-of-range typed value
 * from ever entering the usage profile — the slider is already bounded, but a
 * number input is not, so both funnel through here.
 */
export function clampUsageValue(key: UsageKey, raw: number): number {
  const { min, max, integer } = usageFieldMeta(key);
  if (!Number.isFinite(raw)) return min;
  let v = Math.min(max, Math.max(min, raw));
  if (integer) v = Math.round(v);
  return v;
}
