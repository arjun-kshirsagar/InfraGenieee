import { describe, it, expect, beforeEach, vi } from 'vitest';

import { CATALOG_VERSION, usageProfileSchema, type UsageProfile } from '@/types/cost';
import { saveCostState, loadCostState, clearCostState, costStateSchema } from './store';

/** A minimal in-memory localStorage stub for the node test environment. */
function installStorage(): Record<string, string> {
  const backing: Record<string, string> = {};
  const storage = {
    getItem: (k: string) => (k in backing ? backing[k] : null),
    setItem: (k: string, v: string) => {
      backing[k] = v;
    },
    removeItem: (k: string) => {
      delete backing[k];
    },
  } as unknown as Storage;
  vi.stubGlobal('window', { localStorage: storage });
  return backing;
}

/** A valid usage profile, parsed from a complete literal shape. */
const USAGE: UsageProfile = usageProfileSchema.parse({
  monthlyActiveUsers: 20_000,
  monthlyRequests: 3_000_000,
  avgResponseKb: 50,
  computeNodes: 2,
  computeHoursPerNode: 730,
  computeVcpuPerNode: 1,
  computeMemoryGbPerNode: 2,
  serverlessInvocations: 0,
  avgServerlessDurationMs: 100,
  serverlessMemoryMb: 128,
  dbStorageGb: 20,
  dbBackupGb: 20,
  nosqlReadsPerMonth: 0,
  nosqlWritesPerMonth: 0,
  nosqlStorageGb: 0,
  cacheGb: 0,
  queueMessagesPerMonth: 0,
  objectStorageGb: 0,
  objectWriteOpsPerMonth: 0,
  objectReadOpsPerMonth: 0,
  cdnEgressGb: 0,
  cdnRequestsPerMonth: 0,
  originEgressGb: 50,
  searchIndexGb: 0,
  buildMinutesPerMonth: 0,
  seats: 3,
});

const PRD_ID = 'prd_test';

const SELECTION = {
  provider: 'aws' as const,
  choices: [{ role: 'egress' as const, serviceId: 'aws:data-transfer', skuId: 'aws:data-transfer:out', units: 1, enabled: true }],
};

describe('cost state persistence', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips a valid state', () => {
    installStorage();
    saveCostState(PRD_ID, { usage: USAGE, activeProvider: 'aws', selections: { aws: SELECTION } });
    const loaded = loadCostState(PRD_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.activeProvider).toBe('aws');
    expect(loaded!.version).toBe(CATALOG_VERSION);
    expect(loaded!.usage.monthlyActiveUsers).toBe(USAGE.monthlyActiveUsers);
  });

  it('returns null (does not throw) for a corrupt blob', () => {
    const backing = installStorage();
    backing[`infragenie:cost:${PRD_ID}`] = '{"totally":"corrupt","version":42}';
    expect(loadCostState(PRD_ID)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const backing = installStorage();
    backing[`infragenie:cost:${PRD_ID}`] = 'not json{';
    expect(loadCostState(PRD_ID)).toBeNull();
  });

  it('discards a blob written for a different catalog version', () => {
    const backing = installStorage();
    const valid = costStateSchema.parse({
      version: CATALOG_VERSION,
      usage: USAGE,
      activeProvider: 'aws',
      selections: { aws: SELECTION },
    });
    // Rewrite with a stale version — must be treated as absent.
    backing[`infragenie:cost:${PRD_ID}`] = JSON.stringify({ ...valid, version: '0.0.0-old' });
    expect(loadCostState(PRD_ID)).toBeNull();
  });

  it('returns null on the server (no window)', () => {
    vi.unstubAllGlobals();
    expect(loadCostState(PRD_ID)).toBeNull();
  });

  it('save is a no-op (does not throw) when storage is unavailable', () => {
    vi.unstubAllGlobals();
    expect(() =>
      saveCostState(PRD_ID, { usage: USAGE, activeProvider: 'aws', selections: {} }),
    ).not.toThrow();
  });

  it('clear removes the state', () => {
    installStorage();
    saveCostState(PRD_ID, { usage: USAGE, activeProvider: 'aws', selections: { aws: SELECTION } });
    clearCostState(PRD_ID);
    expect(loadCostState(PRD_ID)).toBeNull();
  });
});
