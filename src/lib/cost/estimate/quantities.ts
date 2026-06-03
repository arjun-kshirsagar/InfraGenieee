/**
 * InfraGenie — Feature 2 cost engine, step 1: usage → billable quantities.
 *
 *   deriveQuantities(usage, sku, units) → Record<QuantityKey, number>
 *
 * Turns a `UsageProfile` + a chosen `CatalogSku` + a unit count into the
 * billable quantity for every `QuantityKey` the engine knows about. The engine
 * (`engine.ts`) then looks up the ONE key each price dimension declares and does
 * the flat `max(0, quantity - included) * unitPrice` maths — no per-provider
 * arithmetic lives anywhere else. Keeping the whole usage→quantity translation
 * in this one file is what keeps `QuantityKey` a closed vocabulary (docs §7).
 *
 * PURE: no clock, no randomness, no env, no I/O. Same inputs → identical output.
 * This is a hard requirement, not a style preference — the engine runs in the
 * browser so the UI's live totals update without a fetch per toggle.
 *
 * 🔴 THE `units` RULE (docs §7, contract `roleChoice.units`):
 *   `units` multiplies PER-UNIT quantities (instance-hours, invocations, GB,
 *   requests, …) but NEVER `months` or `seats`. You do not pay the Vercel Pro
 *   plan fee twice for running two functions, and two web nodes do not mean two
 *   dev-team seats. That exemption lives here and is tested.
 *
 * Owned by: backend. Consumes `@/types/cost` (UsageProfile, CatalogSku,
 * QuantityKey, HOURS_PER_MONTH).
 */

import {
  HOURS_PER_MONTH,
  QUANTITY_KEYS,
  type CatalogSku,
  type QuantityKey,
  type UsageProfile,
} from '@/types/cost';

/**
 * The two flat-fee quantity keys that a `units` count must NOT multiply.
 * `months` is always 1 (a flat monthly charge); `seats` is the paid dev-team
 * seat count. Both are properties of the plan, not of how many boxes you run.
 * The engine and this module both treat these as the multiplier-exempt set;
 * exported so a test can assert the exemption without re-listing it.
 */
export const UNIT_EXEMPT_KEYS: readonly QuantityKey[] = ['months', 'seats'];

/** Seconds per hour — vCPU-seconds / GiB-seconds derivations quote per-second. */
const SECONDS_PER_HOUR = 3600;

/** Milliseconds per second — serverless duration is given in ms. */
const MS_PER_SECOND = 1000;

/** MiB per GiB — serverless memory is given in MB, GB-seconds want GiB. */
const MB_PER_GB = 1024;

/**
 * GiB-seconds of function execution:
 *   invocations × (durationMs / 1000) × (memoryMb / 1024)
 * The canonical Lambda / Cloud Functions billing metric. Kept in one place so
 * every serverless SKU derives it identically.
 */
function gbSecondsFromServerless(
  invocations: number,
  durationMs: number,
  memoryMb: number,
): number {
  return invocations * (durationMs / MS_PER_SECOND) * (memoryMb / MB_PER_GB);
}

/**
 * Per-unit quantities BEFORE the `units` multiplier is applied. A "unit" is one
 * copy of the chosen SKU (one web node, one function config, one DB instance).
 * The multiplier is applied to the whole of this record by the caller below.
 *
 * SKU specs (vcpu, memoryGb) refine metered-compute quantities where present;
 * where a SKU carries no specs the usage profile's per-node figures stand in, so
 * a queue (no vCPU) still derives sane per-unit numbers.
 */
function perUnitQuantities(usage: UsageProfile, sku: CatalogSku): Record<QuantityKey, number> {
  // Compute-node figures. Prefer the SKU's declared specs (the size the user
  // picked); fall back to the usage profile's per-node averages for SKUs that
  // declare none. `nodes` in specs is an internal packaging detail, NOT the
  // user-facing `units` count, so it is deliberately not read here.
  const hours = usage.computeHoursPerNode;
  const vcpuPerNode = sku.specs.vcpu ?? usage.computeVcpuPerNode;
  const memoryGbPerNode = sku.specs.memoryGb ?? usage.computeMemoryGbPerNode;

  // Metered-compute quantities. vCPU-hours = vCPU × hours; vCPU-seconds is the
  // same figure × 3600 (Cloud Run et al quote per-second). GiB-RAM variants
  // mirror that with memory.
  const vcpuHours = vcpuPerNode * hours;
  const gbRamHours = memoryGbPerNode * hours;

  const gbSeconds = gbSecondsFromServerless(
    usage.serverlessInvocations,
    usage.avgServerlessDurationMs,
    usage.serverlessMemoryMb,
  );

  return {
    // ---- flat-fee keys are handled separately (multiplier-exempt) ----------
    months: 1,
    seats: usage.seats,

    // ---- always-on compute -------------------------------------------------
    instanceHours: hours,
    vcpuHours,
    gbRamHours,
    vcpuSeconds: vcpuHours * SECONDS_PER_HOUR,
    gbRamSeconds: gbRamHours * SECONDS_PER_HOUR,

    // ---- request / serverless traffic -------------------------------------
    requests: usage.monthlyRequests,
    invocations: usage.serverlessInvocations,
    gbSeconds,
    activeCpuHours: vcpuHours,

    // ---- relational database ----------------------------------------------
    dbInstanceHours: hours,
    dbStorageGbMonth: usage.dbStorageGb,
    dbBackupGbMonth: usage.dbBackupGb,

    // ---- nosql -------------------------------------------------------------
    nosqlReads: usage.nosqlReadsPerMonth,
    nosqlWrites: usage.nosqlWritesPerMonth,
    nosqlStorageGbMonth: usage.nosqlStorageGb,

    // ---- cache -------------------------------------------------------------
    cacheInstanceHours: hours,
    cacheGbMonth: usage.cacheGb,

    // ---- queue -------------------------------------------------------------
    queueMessages: usage.queueMessagesPerMonth,

    // ---- kafka (broker-hours track always-on node-hours) ------------------
    kafkaBrokerHours: hours,
    kafkaStorageGbMonth: usage.nosqlStorageGb, // event-log storage; profile has no dedicated field, reuse the nosql storage seed as the closest driver

    // ---- object storage ----------------------------------------------------
    objectStorageGbMonth: usage.objectStorageGb,
    objectWriteOps: usage.objectWriteOpsPerMonth,
    objectReadOps: usage.objectReadOpsPerMonth,

    // ---- cdn ---------------------------------------------------------------
    cdnEgressGb: usage.cdnEgressGb,
    cdnRequests: usage.cdnRequestsPerMonth,

    // ---- origin / compute egress ------------------------------------------
    egressGb: usage.originEgressGb,

    // ---- search ------------------------------------------------------------
    searchInstanceHours: hours,
    searchStorageGbMonth: usage.searchIndexGb,

    // ---- ci/cd -------------------------------------------------------------
    buildMinutes: usage.buildMinutesPerMonth,
  };
}

/**
 * Turn a `UsageProfile` + chosen SKU + unit count into billable quantities,
 * one per `QuantityKey`.
 *
 * 🔴 `units` multiplies every PER-UNIT quantity but NOT `months` / `seats`
 * (`UNIT_EXEMPT_KEYS`). See the module header for why.
 *
 * `units` is clamped to a minimum of 1: a choice with zero units is not a
 * meaningful cost input, and the contract already floors `roleChoice.units` at
 * 1, but defending here keeps the function total for any caller.
 */
export function deriveQuantities(
  usage: UsageProfile,
  sku: CatalogSku,
  units: number,
): Record<QuantityKey, number> {
  const multiplier = Math.max(1, Math.floor(units));
  const perUnit = perUnitQuantities(usage, sku);

  const out = {} as Record<QuantityKey, number>;
  for (const key of QUANTITY_KEYS) {
    out[key] = UNIT_EXEMPT_KEYS.includes(key) ? perUnit[key] : perUnit[key] * multiplier;
  }
  return out;
}

export { HOURS_PER_MONTH };
