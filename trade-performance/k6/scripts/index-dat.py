#!/usr/bin/env python3
"""
index-dat.py — reconcile the actual contents of the create path's dat/ directory
against the data files (read-only, changes nothing).

  ./scripts/index-dat.py

Data source: data/workers/trade-management/*.json (the case pool, excluding
lifecycle-events) (contract in lib/rows.js: under the rows key, keys starting
with _ are comments).

══ It checks two things ═══════════════════════════════════════════════
  1. Every .dat referenced by the data exists on disk    — a missing file blows up
     mid-run with a vague error
  2. Every .dat on disk is referenced by some data row   — captured but never added
     to a data file = captured for nothing

Plus one coverage warning: fewer than 3 productTypes prompts for more
(the cost profile needs three representatives: cheapest / most expensive / most common).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # k6/
DAT_DIR = ROOT / "data" / "dat"
CASE_DIR = ROOT / "data" / "workers" / "trade-management"


def load_sources():
    srcs = []
    for p in sorted(CASE_DIR.glob("create-trade*.json")):
        doc = json.loads(p.read_text(encoding="utf-8"))
        rows = doc["rows"] if isinstance(doc, dict) else doc
        srcs.append({"path": p, "rows": rows})
    return srcs


def main() -> int:
    errors, warnings = [], []

    on_disk = {
        p.relative_to(DAT_DIR).as_posix()
        for p in DAT_DIR.rglob("*")
        if p.is_file() and p.suffix == ".dat"
    }
    referenced = set()
    sources = load_sources()

    for src in sources:
        rows, rel = src["rows"], src["path"].relative_to(ROOT)
        for i, row in enumerate(rows, start=1):
            dat = str(row.get("datFile") or "").strip()
            if not dat:
                errors.append(f"{rel} row {i} has an empty datFile")
                continue
            referenced.add(dat)
            if not (DAT_DIR / dat).is_file():
                errors.append(
                    f"{rel} row {i} references a .dat that does not exist — {DAT_DIR.relative_to(ROOT)}/{dat}"
                )

    for orphan in sorted(on_disk - referenced):
        warnings.append(
            f"{DAT_DIR.relative_to(ROOT)}/{orphan} is on disk but no data row references it — "
            f"captured but never added to a data file, same as never captured"
        )

    # ── Cost profile coverage ──
    # With only one productType, the "P95 vs product complexity" curve has a single
    # point and no slope can be drawn — and the slope is what capacity planning
    # needs (see Workload Modeling §4.7.2).
    types = set()
    for src in sources:
        for row in src["rows"]:
            t = str(row.get("productType") or "").strip()
            if t and t != "TBC":
                types.add(t)
    if len(types) < 3:
        warnings.append(
            f"only {len(types)} productType(s) covered ({', '.join(sorted(types)) or 'none'}) — "
            f"the cost profile needs at least 3 representatives: cheapest / most expensive / most common. "
            f"A single point gives the cost curve no slope, and the capacity conclusion "
            f"cannot be extrapolated to other products"
        )

    print()
    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  FAIL  {e}")
    print(
        f"\n{len(on_disk)} .dat file(s) on disk, {len(referenced)} referenced; "
        f"{len(errors)} error(s), {len(warnings)} warning(s)"
    )
    return 1 if errors else 0


sys.exit(main())
