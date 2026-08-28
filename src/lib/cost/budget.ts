import type { BudgetBand } from '@/types/prd';
import type { ProviderEstimate } from '@/types/cost';

export const BUDGET_MAX_USD: Record<BudgetBand, number | null> = {
  'free-tier': 0,
  hobby: 25,
  startup: 250,
  growth: 2_000,
  enterprise: null,
};

export type BudgetStatus =
  | { kind: 'within'; maxUsd: number }
  | { kind: 'over'; maxUsd: number; overByUsd: number }
  | { kind: 'unknown'; maxUsd: number }
  | { kind: 'unbounded' };

/**
 * Deterministically compare an estimate with the PRD budget band. A floor at
 * or above the cap is definitely over budget; a floor below it is unknown,
 * because missing required prices can still push the real total over.
 */
export function assessBudget(
  budgetBand: BudgetBand,
  estimate: ProviderEstimate,
): BudgetStatus {
  const maxUsd = BUDGET_MAX_USD[budgetBand];
  if (maxUsd === null) return { kind: 'unbounded' };
  const exceeds = budgetBand === 'free-tier' ? estimate.monthlyUsd > 0 : estimate.monthlyUsd >= maxUsd;
  if (exceeds) {
    return {
      kind: 'over',
      maxUsd,
      overByUsd: Math.round((estimate.monthlyUsd - maxUsd) * 100) / 100,
    };
  }
  if (estimate.incomplete) return { kind: 'unknown', maxUsd };
  return { kind: 'within', maxUsd };
}
