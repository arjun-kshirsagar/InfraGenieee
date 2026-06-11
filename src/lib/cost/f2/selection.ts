/**
 * InfraGenie — Feature 2 interactive-selector state logic. PURE, DOM-free,
 * deterministic. The React component (`cost-selectors.tsx`) is a thin shell
 * over these functions: this is where the "given a catalog + a recommendation
 * seed, what does the user's editable selection look like, and how does a
 * toggle/pick change it" logic lives, so it can be unit-tested offline.
 *
 * Nothing here fetches, reads the clock, or touches `localStorage` (that is
 * `store.ts`). It consumes the catalog and the recommendation seed as plain
 * data and produces `CostSelection`s the pure engine (`estimateProvider`) can
 * price.
 */

import {
  INFRA_ROLE_ORDER,
  type CatalogService,
  type CatalogSku,
  type CloudProvider,
  type CostRecommendation,
  type CostSelection,
  type InfraRole,
  type RoleChoice,
  type ServiceCatalog,
} from '@/types/cost';

/* -------------------------------------------------------------------------- */
/* Catalog indexing                                                           */
/* -------------------------------------------------------------------------- */

/** Services a provider offers for a role, in catalog order (first = default). */
export function servicesFor(
  catalog: ServiceCatalog,
  provider: CloudProvider,
  role: InfraRole,
): CatalogService[] {
  return catalog.services.filter((s) => s.provider === provider && s.role === role);
}

/** Every role the provider offers ANY service for (used to detect real gaps). */
export function providerRoles(catalog: ServiceCatalog, provider: CloudProvider): Set<InfraRole> {
  const roles = new Set<InfraRole>();
  for (const s of catalog.services) if (s.provider === provider) roles.add(s.role);
  return roles;
}

/** Find a service by id (whole-catalog lookup). */
export function findService(catalog: ServiceCatalog, serviceId: string): CatalogService | undefined {
  return catalog.services.find((s) => s.id === serviceId);
}

/** Find a SKU by id, returning the SKU and its owning service. */
export function findSku(
  catalog: ServiceCatalog,
  skuId: string,
): { sku: CatalogSku; service: CatalogService } | undefined {
  for (const service of catalog.services) {
    const sku = service.skus.find((s) => s.id === skuId);
    if (sku) return { sku, service };
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* The per-role row model the UI renders                                      */
/* -------------------------------------------------------------------------- */

/**
 * One row in the selector grid: a role the PRD requires, resolved against a
 * provider. Either the provider can fill it (`available`, carrying the current
 * choice + the pickable services/SKUs) or it genuinely cannot (`unsupported` —
 * rendered as an explicit "not available on this provider" gap, NEVER as free).
 */
export type RoleRow =
  | {
      kind: 'available';
      role: InfraRole;
      choice: RoleChoice;
      /** Services the provider offers for this role — the service picker. */
      services: CatalogService[];
      /** The currently-selected service + SKU (resolved from `choice`). */
      service: CatalogService;
      sku: CatalogSku;
    }
  | {
      kind: 'unsupported';
      role: InfraRole;
    };

/**
 * Build the ordered list of role rows for one provider from a selection.
 *
 * - `requiredRoles` are shown in `INFRA_ROLE_ORDER`.
 * - A required role the provider offers no service for → `unsupported` row.
 * - A required role the provider CAN serve but the selection has no choice for
 *   → a default choice is synthesised (disabled off? no — enabled default) so
 *   the row is always operable. In practice `seedSelection` already fills these.
 * - A choice whose service/SKU id no longer resolves in the catalog is treated
 *   as unsupported-shaped by falling back to the provider default, so a stale
 *   persisted blob can never render a broken row.
 */
export function buildRoleRows(
  catalog: ServiceCatalog,
  provider: CloudProvider,
  requiredRoles: readonly InfraRole[],
  selection: CostSelection,
): RoleRow[] {
  const offered = providerRoles(catalog, provider);
  const byRole = new Map<InfraRole, RoleChoice>();
  for (const c of selection.choices) byRole.set(c.role, c);

  const ordered = INFRA_ROLE_ORDER.filter((r) => requiredRoles.includes(r));

  return ordered.map((role): RoleRow => {
    if (!offered.has(role)) return { kind: 'unsupported', role };

    const services = servicesFor(catalog, provider, role);
    // Resolve the current choice; fall back to the provider's default service/
    // SKU if the choice is missing or references an id the catalog dropped.
    const existing = byRole.get(role);
    let resolved = existing ? findSku(catalog, existing.skuId) : undefined;
    let choice = existing;

    if (!resolved || resolved.service.provider !== provider || resolved.service.role !== role) {
      const service = services[0];
      const sku = service?.skus[0];
      if (!service || !sku) return { kind: 'unsupported', role };
      choice = {
        role,
        serviceId: service.id,
        skuId: sku.id,
        units: existing?.units ?? sku.defaultUnits,
        enabled: existing?.enabled ?? true,
      };
      resolved = { sku, service };
    }

    return {
      kind: 'available',
      role,
      choice: choice!,
      services,
      service: resolved.service,
      sku: resolved.sku,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Seeding — merge the recommendation into a full, valid selection            */
/* -------------------------------------------------------------------------- */

/**
 * Produce a complete, catalog-valid `CostSelection` for one provider by taking
 * the recommendation's seed for that provider (if any) and filling every
 * *supported* required role the seed omitted with the catalog default. Roles
 * the provider cannot fill are left out entirely (they surface as unsupported).
 *
 * The result satisfies `costSelectionSchema`: one choice per role, every
 * service/SKU prefixed correctly, because it only ever emits ids drawn from the
 * catalog for this exact provider+role.
 */
export function seedSelection(
  catalog: ServiceCatalog,
  provider: CloudProvider,
  requiredRoles: readonly InfraRole[],
  recommendation: CostRecommendation,
): CostSelection {
  const offered = providerRoles(catalog, provider);
  const seed = recommendation.selections.find((s) => s.provider === provider);
  const seedByRole = new Map<InfraRole, RoleChoice>();
  if (seed) for (const c of seed.choices) seedByRole.set(c.role, c);

  const ordered = INFRA_ROLE_ORDER.filter((r) => requiredRoles.includes(r) && offered.has(r));

  const choices: RoleChoice[] = [];
  for (const role of ordered) {
    const seeded = seedByRole.get(role);
    // Trust the seed only if its ids resolve to this provider+role; otherwise
    // fall back to the catalog default (don't trust, verify).
    if (seeded) {
      const resolved = findSku(catalog, seeded.skuId);
      if (
        resolved &&
        resolved.service.id === seeded.serviceId &&
        resolved.service.provider === provider &&
        resolved.service.role === role
      ) {
        choices.push({
          role,
          serviceId: seeded.serviceId,
          skuId: seeded.skuId,
          units: clampUnits(seeded.units),
          enabled: seeded.enabled,
        });
        continue;
      }
    }
    const service = servicesFor(catalog, provider, role)[0];
    const sku = service?.skus[0];
    if (service && sku) {
      choices.push({
        role,
        serviceId: service.id,
        skuId: sku.id,
        units: sku.defaultUnits,
        enabled: true,
      });
    }
  }

  return { provider, choices };
}

/** Seed selections for EVERY provider (the initial state of the explorer). */
export function seedAllSelections(
  catalog: ServiceCatalog,
  providers: readonly CloudProvider[],
  requiredRoles: readonly InfraRole[],
  recommendation: CostRecommendation,
): Record<string, CostSelection> {
  const out: Record<string, CostSelection> = {};
  for (const provider of providers) {
    out[provider] = seedSelection(catalog, provider, requiredRoles, recommendation);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Choice mutations (immutable) — the selector reducers                       */
/* -------------------------------------------------------------------------- */

/** Clamp a units value to the contract bounds (1–200, integer). */
export function clampUnits(units: number): number {
  if (!Number.isFinite(units)) return 1;
  return Math.min(200, Math.max(1, Math.floor(units)));
}

/** Replace the choice for `role` in a selection, returning a NEW selection. */
function withChoice(selection: CostSelection, role: InfraRole, next: RoleChoice): CostSelection {
  const choices = selection.choices.map((c) => (c.role === role ? next : c));
  // If the role wasn't present (shouldn't happen post-seed), append it.
  if (!selection.choices.some((c) => c.role === role)) choices.push(next);
  return { ...selection, choices };
}

/**
 * Change the SERVICE for a role. Picks the service's first SKU (the user then
 * refines the size). Resets `units` to the new SKU's default because unit
 * counts are not comparable across services. No-op if the service id is not a
 * valid choice for this provider+role.
 */
export function setService(
  catalog: ServiceCatalog,
  selection: CostSelection,
  role: InfraRole,
  serviceId: string,
): CostSelection {
  const service = findService(catalog, serviceId);
  if (!service || service.provider !== selection.provider || service.role !== role) return selection;
  const sku = service.skus[0];
  if (!sku) return selection;
  const current = selection.choices.find((c) => c.role === role);
  return withChoice(selection, role, {
    role,
    serviceId: service.id,
    skuId: sku.id,
    units: sku.defaultUnits,
    enabled: current?.enabled ?? true,
  });
}

/**
 * Change the SKU (size) for a role, keeping the same service. Resets units to
 * the new SKU's default. No-op if the SKU does not belong to the role's current
 * service.
 */
export function setSku(
  catalog: ServiceCatalog,
  selection: CostSelection,
  role: InfraRole,
  skuId: string,
): CostSelection {
  const current = selection.choices.find((c) => c.role === role);
  if (!current) return selection;
  const resolved = findSku(catalog, skuId);
  if (!resolved || resolved.service.id !== current.serviceId) return selection;
  return withChoice(selection, role, {
    ...current,
    skuId,
    units: resolved.sku.defaultUnits,
  });
}

/** Set the unit count for a role (clamped to 1–200). No-op if role absent. */
export function setUnits(selection: CostSelection, role: InfraRole, units: number): CostSelection {
  const current = selection.choices.find((c) => c.role === role);
  if (!current) return selection;
  return withChoice(selection, role, { ...current, units: clampUnits(units) });
}

/** Enable/disable a role's contribution (the row stays visible upstream). */
export function setEnabled(
  selection: CostSelection,
  role: InfraRole,
  enabled: boolean,
): CostSelection {
  const current = selection.choices.find((c) => c.role === role);
  if (!current) return selection;
  return withChoice(selection, role, { ...current, enabled });
}
