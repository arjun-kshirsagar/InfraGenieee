/**
 * InfraGenie — the evidence gate. The single most important function in
 * Feature 2 and the anti-fabrication invariant made mechanical.
 *
 * PURE. No I/O, no clock, no `process.env`, no randomness. Same inputs → same
 * output, so it runs identically on the server and (in tests) anywhere. It
 * implements `AssertEvidenceSupportsPrice` from `../pricing-seam`.
 *
 * The extractor (a Haiku call, or a JSON-feed lookup) emits a candidate
 * `unitPriceUsd` and an `evidence` string it claims is a verbatim excerpt of the
 * fetched page containing that number. This function refuses to take that on
 * faith. It asserts, with arithmetic rather than judgement:
 *
 *   1. `evidence` really is a substring of `page.markdown`. Whitespace runs may
 *      be collapsed on BOTH sides before comparing (real markdown tables have
 *      irregular column padding) — but NOTHING else is normalised. No
 *      case-folding, no punctuation stripping, no fuzzy matching.
 *
 *   2. The numeric value of `unitPriceUsd` literally appears inside `evidence`,
 *      tolerating formatting only: a leading `$`, thousands separators
 *      (`1,234`), and trailing zeros (`0.032` matches `$0.0320`). It matches on
 *      whole numeric TOKENS, so `0.032` is NOT satisfied by evidence that only
 *      contains `0.32` or `32`, and `6.00` is NOT satisfied by the `6` inside
 *      `1,000`.
 *
 * On any failure the record is DISCARDED by the caller (recorded as
 * `PriceGap{reason:'evidence_rejected'}`) — never repaired, never defaulted,
 * never averaged. Returning `null` means "accepted".
 */

import type { AssertEvidenceSupportsPrice } from '../pricing-seam';

/** Collapse every run of whitespace to a single space, and trim the ends. Used
 *  on BOTH the evidence and the page before the substring test — this is the
 *  ONLY normalisation permitted, and it is applied to nothing else. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Render a finite number as a plain decimal string with NO scientific notation
 * and NO thousands separators — e.g. `0.000018`, not `1.8e-5`, and `1000`, not
 * `1,000`. `Number.prototype.toString` switches to exponential form for very
 * small magnitudes (`1e-7`), which would never appear on a pricing page, so we
 * detect that and expand it by hand. Trailing zeros are already absent from a
 * JS number's canonical string, which is exactly what we want as the target.
 */
function toPlainDecimal(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;

  // Expand exponential form (only happens for |n| < 1e-6 or >= 1e21 here).
  const [mantissa, expPart] = s.split(/e/i);
  const exp = Number(expPart);
  const sign = mantissa.startsWith('-') ? '-' : '';
  const digits = mantissa.replace('-', '');
  const [intPart, fracPart = ''] = digits.split('.');
  const allDigits = intPart + fracPart;

  if (exp < 0) {
    // Shift the decimal point left. The point currently sits after `intPart`.
    const pointPos = intPart.length + exp;
    if (pointPos <= 0) {
      return `${sign}0.${'0'.repeat(-pointPos)}${allDigits}`.replace(/0+$/, '') || `${sign}0`;
    }
    const out = `${allDigits.slice(0, pointPos)}.${allDigits.slice(pointPos)}`;
    return `${sign}${out}`.replace(/\.?0+$/, '');
  }

  // exp >= 0: shift right, padding with zeros as needed.
  const pointPos = intPart.length + exp;
  const padded = allDigits.padEnd(pointPos, '0');
  const out =
    pointPos >= padded.length ? padded : `${padded.slice(0, pointPos)}.${padded.slice(pointPos)}`;
  return `${sign}${out}`;
}

/**
 * Canonicalise ONE numeric token for value comparison. Strips a leading `$`,
 * removes thousands separators, and drops insignificant trailing zeros after a
 * decimal point (`0.0320` → `0.032`, `6.00` → `6`, `6.` → `6`). Returns null if
 * the token is not a well-formed number after that.
 *
 * Note it does NOT strip a trailing `0` that is significant — `0` stays `0`,
 * `10` stays `10`. Only zeros *after a decimal point* are insignificant.
 */
function canonicalizeNumericToken(token: string): string | null {
  let t = token.trim();
  if (t.startsWith('$')) t = t.slice(1).trim();

  // Reject anything that still carries non-numeric characters. Allow a single
  // leading sign, digits, thousands-separator commas, and one decimal point.
  if (!/^[+-]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(t) || t === '' || t === '.') {
    return null;
  }

  const sign = t.startsWith('-') ? '-' : '';
  t = t.replace(/^[+-]/, '').replace(/,/g, '');

  if (t.includes('.')) {
    t = t.replace(/0+$/, ''); // drop trailing zeros in the fraction
    t = t.replace(/\.$/, ''); // drop a now-bare decimal point
  }
  if (t === '' || t === '.') return null;

  // Normalise `-0` and `00007` style leading zeros to a canonical form via
  // Number, but ONLY after we have already string-matched formatting — the
  // token is now a clean plain decimal so this cannot introduce float error for
  // the magnitudes on a pricing page. Guard non-finite just in case.
  const asNum = Number(`${sign}${t}`);
  if (!Number.isFinite(asNum)) return null;
  return toPlainDecimal(asNum);
}

/**
 * Extract candidate numeric tokens from a string. A token is a maximal run of
 * digits, commas and dots optionally preceded by `$`. We deliberately capture
 * the WHOLE run so that `1,000` is one token (not `1` then `000`) and `0.32` is
 * one token (not `0` then `32`) — this is what stops the substring-of-a-number
 * false positive. Bounded token count keeps this from being a DoS on a huge
 * evidence blob.
 */
function numericTokens(s: string): string[] {
  const matches = s.match(/\$?\d[\d,]*(?:\.\d+)?/g);
  return matches ? matches.slice(0, 5000) : [];
}

export const assertEvidenceSupportsPrice: AssertEvidenceSupportsPrice = ({
  page,
  evidence,
  unitPriceUsd,
}) => {
  // Guard: a NaN/Infinity price is never acceptable — it cannot appear on a page.
  if (!Number.isFinite(unitPriceUsd)) {
    return `unitPriceUsd is not a finite number (${String(unitPriceUsd)}).`;
  }

  const trimmedEvidence = evidence.trim();
  if (trimmedEvidence.length === 0) {
    return 'evidence is empty.';
  }

  // (1) evidence must be a verbatim substring of the page, whitespace collapsed
  //     on both sides and nothing else changed.
  const haystack = collapseWhitespace(page.markdown);
  const needle = collapseWhitespace(evidence);
  if (!haystack.includes(needle)) {
    return 'evidence is not a verbatim substring of the fetched page (after whitespace collapse).';
  }

  // (2) the price value must appear as a whole numeric token inside evidence,
  //     tolerating only $, thousands separators, and trailing zeros.
  const target = toPlainDecimal(unitPriceUsd);
  const tokens = numericTokens(needle);
  const found = tokens.some((tok) => canonicalizeNumericToken(tok) === target);

  if (!found) {
    return (
      `price ${target} (from unitPriceUsd=${unitPriceUsd}) does not appear as a numeric ` +
      `token in the evidence; a substring of a larger number does not count.`
    );
  }

  return null;
};

export default assertEvidenceSupportsPrice;
