/**
 * InfraGenie — Feature 2 (interactive selectors) pure formatting helpers.
 *
 * DOM-free, deterministic, no clock (callers pass `now` where relative time is
 * needed). Every function here is unit-tested. Keeping the formatting out of
 * the components means the live totals render identically on server and client
 * (no hydration mismatch) and the numbers can be asserted in a node test.
 */

/**
 * Format a USD amount as a compact money string. Cents are shown below $10k so
 * a $89.90 total reads to the cent (matching B7's worked example); above that
 * the cents are noise and are dropped. Never returns `NaN`/`Infinity` — a
 * non-finite input renders as `$0.00` (defensive; the engine never emits one).
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '$0.00';
  const abs = Math.abs(amount);
  const fractionDigits = abs < 10_000 ? 2 : 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

/**
 * A precise USD string for unit prices, which are frequently tiny (e.g.
 * `$0.0000004` per SQS request). Uses up to 8 significant fraction digits and
 * strips trailing zeros so `$0.02` doesn't render as `$0.02000000`, while
 * `$0.0000004` survives intact. `$0.00` is reserved for a genuine zero.
 */
export function formatUnitPrice(amount: number): string {
  if (!Number.isFinite(amount)) return '$0.00';
  if (amount === 0) return '$0.00';
  // Show enough precision for sub-cent rates without scientific notation.
  const fixed = amount.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  // Guarantee at least two decimals for readable "normal" prices.
  const [, decimals = ''] = fixed.split('.');
  const padded = decimals.length < 2 ? amount.toFixed(2) : fixed;
  return `$${padded}`;
}

/**
 * Format a raw quantity for the breakdown (requests, GB, hours). Whole numbers
 * get thousands separators; fractional quantities keep up to 2 decimals. Large
 * counts stay legible via grouping rather than switching to scientific form,
 * because a user checking our maths wants to see the actual number.
 */
export function formatQuantity(qty: number): string {
  if (!Number.isFinite(qty)) return '0';
  const isInt = Number.isInteger(qty);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: isInt ? 0 : 2,
  }).format(qty);
}

/**
 * Compact form for the big headline slider values (e.g. 1.2M MAU). Keeps the
 * total readable while still being an honest order of magnitude. Whole small
 * numbers pass through with grouping.
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) < 10_000) return formatQuantity(value);
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * A human "how old is this price" string from an ISO-8601 timestamp and a `now`
 * epoch-ms (passed in — pure). Returns `null` for an absent/invalid timestamp
 * so the caller can omit the affordance entirely rather than print "Invalid
 * Date".
 */
export function formatRelativeAge(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Math.max(0, now - then);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/** A short, locale-stable date label (e.g. "Jul 26, 2026") for a citation. */
export function formatFetchedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
}
