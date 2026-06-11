import { describe, it, expect } from 'vitest';

import {
  formatUsd,
  formatUnitPrice,
  formatQuantity,
  formatCompact,
  formatRelativeAge,
  formatFetchedDate,
} from './format';

describe('formatUsd', () => {
  it('shows cents below $10k (B7 worked-example totals read to the cent)', () => {
    expect(formatUsd(89.9)).toBe('$89.90');
    expect(formatUsd(660)).toBe('$660.00');
    expect(formatUsd(14.6)).toBe('$14.60');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('drops cents above $10k where they are noise', () => {
    expect(formatUsd(12_345.67)).toBe('$12,346');
  });

  it('never renders NaN/Infinity', () => {
    expect(formatUsd(NaN)).toBe('$0.00');
    expect(formatUsd(Infinity)).toBe('$0.00');
  });
});

describe('formatUnitPrice', () => {
  it('keeps tiny sub-cent rates intact (SQS $0.0000004/req)', () => {
    expect(formatUnitPrice(0.0000004)).toBe('$0.0000004');
  });

  it('renders normal rates with at least two decimals', () => {
    expect(formatUnitPrice(0.02)).toBe('$0.02');
    expect(formatUnitPrice(0.1)).toBe('$0.10');
    expect(formatUnitPrice(0.115)).toBe('$0.115');
    expect(formatUnitPrice(20)).toBe('$20.00');
  });

  it('renders a genuine zero as $0.00', () => {
    expect(formatUnitPrice(0)).toBe('$0.00');
  });
});

describe('formatQuantity', () => {
  it('groups whole numbers', () => {
    expect(formatQuantity(730)).toBe('730');
    expect(formatQuantity(5_000_000)).toBe('5,000,000');
  });
  it('keeps up to 2 decimals for fractional quantities', () => {
    expect(formatQuantity(20.5)).toBe('20.5');
    expect(formatQuantity(1.234)).toBe('1.23');
  });
});

describe('formatCompact', () => {
  it('passes small numbers through with grouping', () => {
    expect(formatCompact(730)).toBe('730');
  });
  it('compacts large numbers', () => {
    expect(formatCompact(1_200_000)).toBe('1.2M');
    expect(formatCompact(50_000)).toBe('50K');
  });
});

describe('formatRelativeAge', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  it('returns null for a missing or invalid timestamp', () => {
    expect(formatRelativeAge(null, now)).toBeNull();
    expect(formatRelativeAge('not-a-date', now)).toBeNull();
  });
  it('renders minutes / hours / days / months', () => {
    expect(formatRelativeAge('2026-07-26T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelativeAge('2026-07-26T11:30:00.000Z', now)).toBe('30 minutes ago');
    expect(formatRelativeAge('2026-07-26T09:00:00.000Z', now)).toBe('3 hours ago');
    expect(formatRelativeAge('2026-07-24T12:00:00.000Z', now)).toBe('2 days ago');
    expect(formatRelativeAge('2026-05-26T12:00:00.000Z', now)).toBe('2 months ago');
  });
  it('handles the singular', () => {
    expect(formatRelativeAge('2026-07-26T11:59:00.000Z', now)).toBe('1 minute ago');
  });
});

describe('formatFetchedDate', () => {
  it('renders a short date', () => {
    expect(formatFetchedDate('2026-07-26T12:00:00.000Z')).toBe('Jul 26, 2026');
  });
  it('echoes a bad input rather than "Invalid Date"', () => {
    expect(formatFetchedDate('nonsense')).toBe('nonsense');
  });
});
