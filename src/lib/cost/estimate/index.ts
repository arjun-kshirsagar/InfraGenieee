/**
 * InfraGenie — Feature 2 cost engine public surface.
 *
 * The three exported functions are PURE (no clock, no randomness, no env, no
 * I/O): `deriveQuantities` turns usage into billable quantities, `estimateProvider`
 * prices one provider selection, and `compare` awards the cheapest / bestScaling
 * / simplest badges across estimates. This module imports cleanly into a client
 * component so the UI can recompute totals live as the user toggles choices.
 *
 * The two derivation functions (PRD → roles, context → usage profile) live in
 * `./derive` and are re-exported here for a single import site.
 */

export { deriveQuantities, UNIT_EXEMPT_KEYS } from './quantities';
export {
  estimateProvider,
  compare,
  type EstimateProviderInput,
  type CompareInput,
} from './engine';
export { mapComponentsToRoles, deriveUsageProfile } from './derive';
