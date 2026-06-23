#!/usr/bin/env python3
"""
Insert pricePerUnits into every affected catalog price dimension.

Scale rule (per BLOCKER-1/2), derived from (unit, quantityKey):
  BULK unit:  "USD / million ..."   -> 1_000_000
              "USD / 100,000 ..."   -> 100_000
              "USD / 10,000 ..."    -> 10_000
              "USD / 1,000 ..."     ->   1_000
  PER-HOUR rate vs PER-MONTH qty:
    unit contains 'hour' AND quantityKey ends with 'Month'  -> '1 / HOURS_PER_MONTH'
  CLOUD-SQL storage lie: unit says 'GiB-month' but the vendor page prices it
    per GiB-HOUR (cloud.google.com/sql/pricing: "$0.000465753 / 1 gibibyte hour").
    quantityKey dbStorageGbMonth -> ALSO '1 / HOURS_PER_MONTH', and we correct the
    display unit to 'USD / GiB-hour' so it reads honestly and the guard catches it.

Only these dimensions get a pricePerUnits; everything else keeps the schema
default of 1. Idempotent: skips a dimension that already declares it.
"""
import re
import sys
from pathlib import Path

FILES = ["aws", "azure", "digitalocean", "gcp", "vercel"]
BASE = Path("src/lib/cost/catalog")

BULK_RE = re.compile(r"per\s*(million|billion|thousand|[\d,]{4,})|/\s*(million|billion|thousand|[\d,]{4,})", re.I)
UNIT_RE = re.compile(r"unit:\s*'([^']*)'")
QK_RE = re.compile(r"quantityKey:\s*'([^']*)'")

# Cloud SQL storage: unit lies "GiB-month" but priced per GiB-hour on the page.
CLOUD_SQL_STORAGE = ("gcp:cloud-sql", "dbStorageGbMonth")


def bulk_scale(unit: str) -> str | None:
    m = BULK_RE.search(unit)
    if not m:
        return None
    tok = (m.group(1) or m.group(2)).lower().replace(",", "")
    if tok == "thousand":
        return "1_000"
    if tok == "million":
        return "1_000_000"
    if tok == "billion":
        return "1_000_000_000"
    if tok.isdigit():
        n = int(tok)
        # pretty underscore grouping
        return f"{n:_}"
    return None


def split_dimensions(text: str):
    """Yield (start, end) spans of each dimension object literal.

    A dimension object is a brace-balanced block that contains a `quantityKey:`
    and a `unit:` line. We find each `{` that begins such a block by scanning for
    the `id:` ... `quantityKey:` ... `unit:` signature and balancing braces.
    """
    spans = []
    i = 0
    n = len(text)
    while True:
        # find next 'quantityKey:' occurrence, then walk back to its opening brace
        qk = text.find("quantityKey:", i)
        if qk == -1:
            break
        # walk back to the nearest '{' that opens this object
        depth = 0
        j = qk
        open_brace = -1
        while j >= 0:
            c = text[j]
            if c == "}":
                depth += 1
            elif c == "{":
                if depth == 0:
                    open_brace = j
                    break
                depth -= 1
            j -= 1
        # walk forward to the matching close brace
        depth = 0
        k = open_brace
        close_brace = -1
        while k < n:
            c = text[k]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    close_brace = k
                    break
            k += 1
        if open_brace != -1 and close_brace != -1:
            spans.append((open_brace, close_brace))
            i = close_brace + 1
        else:
            i = qk + len("quantityKey:")
    return spans


def process(text: str, service_prefix_guess: str):
    changed = 0
    # Process spans back-to-front so offsets stay valid.
    spans = split_dimensions(text)
    for (s, e) in reversed(spans):
        block = text[s:e + 1]
        if "pricePerUnits" in block:
            continue
        um = UNIT_RE.search(block)
        qm = QK_RE.search(block)
        if not um or not qm:
            continue
        unit = um.group(1)
        qk = qm.group(1)

        scale = None
        new_block = block

        b = bulk_scale(unit)
        if b is not None:
            scale = b
        elif "hour" in unit.lower() and qk.endswith("Month"):
            scale = "1 / HOURS_PER_MONTH"
        elif qk == "dbStorageGbMonth" and service_prefix_guess == "gcp":
            # Cloud SQL storage lie — priced per GiB-hour on the page.
            scale = "1 / HOURS_PER_MONTH"
            # correct the display unit so it reads honestly & guard catches it
            new_block = new_block.replace(
                f"unit: '{unit}'", "unit: 'USD / GiB-hour'"
            )
            # tighten the extraction hint to pin the per-hour storage row
            new_block = new_block.replace(
                "SSD storage price per GiB-month for PostgreSQL in Iowa (us-central1).",
                "SSD storage capacity price per gibibyte hour for PostgreSQL in Iowa (us-central1) "
                "(the page lists storage per 'gibibyte hour').",
            )

        if scale is None:
            continue

        # Insert `pricePerUnits: <scale>,` immediately after the unit: line,
        # preserving the unit line's indentation.
        um2 = UNIT_RE.search(new_block)
        line_start = new_block.rfind("\n", 0, um2.start()) + 1
        indent = new_block[line_start:um2.start()]
        unit_line_end = new_block.find("\n", um2.end())
        insertion = f"\n{indent}pricePerUnits: {scale},"
        new_block = new_block[:unit_line_end] + insertion + new_block[unit_line_end:]

        text = text[:s] + new_block + text[e + 1:]
        changed += 1
    return text, changed


def main():
    total = 0
    for name in FILES:
        p = BASE / f"{name}.ts"
        src = p.read_text()
        out, changed = process(src, name)
        if changed:
            p.write_text(out)
        print(f"{name}.ts: {changed} dimensions updated")
        total += changed
    print(f"TOTAL: {total}")


if __name__ == "__main__":
    main()
