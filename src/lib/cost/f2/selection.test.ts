import { describe, it, expect } from 'vitest';

import { serviceCatalog } from '@/lib/cost/catalog';
import {
  costSelectionSchema,
  type CloudProvider,
  type CostRecommendation,
  type InfraRole,
} from '@/types/cost';
import {
  servicesFor,
  providerRoles,
  findSku,
  buildRoleRows,
  seedSelection,
  seedAllSelections,
  clampUnits,
  setService,
  setSku,
  setUnits,
  setEnabled,
} from './selection';

const CAT = serviceCatalog;

/** A minimal, valid recommendation with a seeded selection for one provider. */
function recWith(provider: CloudProvider, roles: InfraRole[]): CostRecommendation {
  const selections = ['aws', 'gcp', 'azure', 'vercel', 'digitalocean'].map((p) =>
    seedSelection(CAT, p as CloudProvider, roles, {
      // bootstrap seed uses catalog defaults directly (empty selections)
      recommendedProvider: provider,
      rationale: 'x'.repeat(50),
      usageProfile: {} as never,
      assumptions: ['seed'],
      selections: [],
      tradeoffs: [{ provider, pros: ['a'], cons: ['b'] }],
    }),
  );
  return {
    recommendedProvider: provider,
    rationale: 'x'.repeat(50),
    usageProfile: {} as never,
    assumptions: ['seed'],
    selections,
    tradeoffs: [{ provider, pros: ['a'], cons: ['b'] }],
  };
}

describe('catalog indexing helpers', () => {
  it('servicesFor returns only that provider+role in catalog order', () => {
    const svcs = servicesFor(CAT, 'aws', 'db-relational');
    expect(svcs.length).toBeGreaterThan(0);
    for (const s of svcs) {
      expect(s.provider).toBe('aws');
      expect(s.role).toBe('db-relational');
    }
  });

  it('providerRoles reflects the §9 coverage — Vercel cannot do db-relational', () => {
    const vercel = providerRoles(CAT, 'vercel');
    expect(vercel.has('compute-web')).toBe(true);
    expect(vercel.has('db-relational')).toBe(false);
    expect(vercel.has('queue-kafka')).toBe(false);
  });

  it('findSku resolves a SKU and its owning service', () => {
    const anyService = CAT.services[0];
    const anySku = anyService.skus[0];
    const resolved = findSku(CAT, anySku.id);
    expect(resolved?.service.id).toBe(anyService.id);
    expect(resolved?.sku.id).toBe(anySku.id);
  });
});

describe('seedSelection', () => {
  const roles: InfraRole[] = ['compute-web', 'db-relational', 'cache-redis', 'egress'];

  it('produces a contract-valid selection for a provider', () => {
    const sel = seedSelection(CAT, 'aws', roles, recWith('aws', roles));
    expect(() => costSelectionSchema.parse(sel)).not.toThrow();
  });

  it('omits roles the provider cannot fill (Vercel drops db-relational)', () => {
    const sel = seedSelection(CAT, 'vercel', roles, recWith('aws', roles));
    const seededRoles = sel.choices.map((c) => c.role);
    expect(seededRoles).not.toContain('db-relational');
    expect(seededRoles).not.toContain('cache-redis');
    expect(seededRoles).toContain('compute-web');
  });

  it('falls back to the catalog default when a seed references a bad id', () => {
    const bad = recWith('aws', roles);
    // Corrupt the aws seed's first choice with a non-existent SKU.
    const awsSel = bad.selections.find((s) => s.provider === 'aws')!;
    awsSel.choices[0] = {
      ...awsSel.choices[0],
      skuId: 'aws:nope:nope',
      serviceId: 'aws:nope',
    };
    const sel = seedSelection(CAT, 'aws', roles, bad);
    const web = sel.choices.find((c) => c.role === 'compute-web')!;
    // Repaired to a real catalog service/sku for aws compute-web.
    expect(findSku(CAT, web.skuId)?.service.provider).toBe('aws');
    expect(() => costSelectionSchema.parse(sel)).not.toThrow();
  });

  it('seedAllSelections covers every provider', () => {
    const all = seedAllSelections(CAT, ['aws', 'gcp', 'azure', 'vercel', 'digitalocean'], roles, recWith('aws', roles));
    expect(Object.keys(all).sort()).toEqual(['aws', 'azure', 'digitalocean', 'gcp', 'vercel']);
  });
});

describe('buildRoleRows', () => {
  const roles: InfraRole[] = ['compute-web', 'db-relational', 'queue-kafka', 'egress'];

  it('renders an unsupported row for a role the provider cannot fill', () => {
    const sel = seedSelection(CAT, 'vercel', roles, recWith('vercel', roles));
    const rows = buildRoleRows(CAT, 'vercel', roles, sel);
    const kafka = rows.find((r) => r.role === 'queue-kafka');
    expect(kafka?.kind).toBe('unsupported');
    const db = rows.find((r) => r.role === 'db-relational');
    expect(db?.kind).toBe('unsupported');
    const web = rows.find((r) => r.role === 'compute-web');
    expect(web?.kind).toBe('available');
  });

  it('rows are ordered by INFRA_ROLE_ORDER', () => {
    const sel = seedSelection(CAT, 'aws', roles, recWith('aws', roles));
    const rows = buildRoleRows(CAT, 'aws', roles, sel);
    // compute-web precedes db-relational precedes queue-kafka precedes egress.
    const order = rows.map((r) => r.role);
    expect(order.indexOf('compute-web')).toBeLessThan(order.indexOf('db-relational'));
    expect(order.indexOf('db-relational')).toBeLessThan(order.indexOf('queue-kafka'));
    expect(order.indexOf('queue-kafka')).toBeLessThan(order.indexOf('egress'));
  });

  it('available rows carry a resolved service + sku matching the choice', () => {
    const sel = seedSelection(CAT, 'aws', roles, recWith('aws', roles));
    const rows = buildRoleRows(CAT, 'aws', roles, sel);
    for (const row of rows) {
      if (row.kind !== 'available') continue;
      expect(row.service.id).toBe(row.choice.serviceId);
      expect(row.sku.id).toBe(row.choice.skuId);
      expect(row.services).toContainEqual(row.service);
    }
  });
});

describe('choice mutations (immutable reducers)', () => {
  const roles: InfraRole[] = ['compute-web', 'db-relational', 'egress'];
  const base = seedSelection(CAT, 'aws', roles, recWith('aws', roles));

  it('clampUnits enforces 1..200 integer', () => {
    expect(clampUnits(0)).toBe(1);
    expect(clampUnits(1000)).toBe(200);
    expect(clampUnits(3.9)).toBe(3);
    expect(clampUnits(NaN)).toBe(1);
  });

  it('setUnits updates only the target role and returns a new object', () => {
    const next = setUnits(base, 'compute-web', 5);
    expect(next).not.toBe(base);
    expect(next.choices.find((c) => c.role === 'compute-web')!.units).toBe(5);
    // db-relational untouched.
    expect(next.choices.find((c) => c.role === 'db-relational')!.units).toBe(
      base.choices.find((c) => c.role === 'db-relational')!.units,
    );
  });

  it('setUnits clamps out-of-range input', () => {
    expect(setUnits(base, 'compute-web', 99999).choices.find((c) => c.role === 'compute-web')!.units).toBe(200);
  });

  it('setEnabled toggles a role without removing it (stays visible)', () => {
    const off = setEnabled(base, 'db-relational', false);
    const choice = off.choices.find((c) => c.role === 'db-relational');
    expect(choice).toBeDefined();
    expect(choice!.enabled).toBe(false);
  });

  it('setService swaps to a valid alternative service and resets units to its default', () => {
    const webServices = servicesFor(CAT, 'aws', 'compute-web');
    if (webServices.length < 2) return; // only meaningful with >1 service
    const alt = webServices[1];
    const next = setService(CAT, base, 'compute-web', alt.id);
    const choice = next.choices.find((c) => c.role === 'compute-web')!;
    expect(choice.serviceId).toBe(alt.id);
    expect(choice.skuId).toBe(alt.skus[0].id);
    expect(choice.units).toBe(alt.skus[0].defaultUnits);
    expect(() => costSelectionSchema.parse(next)).not.toThrow();
  });

  it('setService is a no-op for a service that is not valid for the role', () => {
    const next = setService(CAT, base, 'compute-web', 'aws:rds-postgres');
    expect(next).toBe(base);
  });

  it('setSku swaps size within the same service', () => {
    const svc = findSku(CAT, base.choices.find((c) => c.role === 'compute-web')!.skuId)!.service;
    if (svc.skus.length < 2) return;
    const altSku = svc.skus[1];
    const next = setSku(CAT, base, 'compute-web', altSku.id);
    expect(next.choices.find((c) => c.role === 'compute-web')!.skuId).toBe(altSku.id);
    expect(() => costSelectionSchema.parse(next)).not.toThrow();
  });

  it('setSku is a no-op when the SKU belongs to a different service', () => {
    const foreign = servicesFor(CAT, 'aws', 'db-relational')[0].skus[0];
    const next = setSku(CAT, base, 'compute-web', foreign.id);
    expect(next).toBe(base);
  });
});
