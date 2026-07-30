#!/usr/bin/env python3
"""
index-dat.py —— 把 create 路径 dat/ 目录的实际内容与数据文件对账（只读，不改文件）。

  ./scripts/index-dat.py

数据源：data/workers/trade-management/*.json（用例池，不含 lifecycle-events）（契约见 lib/rows.js：rows 键下，_ 开头的键是注释）。

══ 它检查两件事 ═══════════════════════════════════════════════════
  1. 数据引用的 .dat 在磁盘上存在        —— 缺文件会在压测中期才炸，且报错含糊
  2. 磁盘上的 .dat 都被某一条数据引用    —— 采集了却没进数据文件 = 白采集

另有一条覆盖度告警：productType 少于 3 个时提示补齐
（成本画像需要 最便宜 / 最贵 / 最常见 三个代表，见 dat/ 目录 README.md）。
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
                errors.append(f"{rel} 第 {i} 条 datFile 为空")
                continue
            referenced.add(dat)
            if not (DAT_DIR / dat).is_file():
                errors.append(
                    f"{rel} 第 {i} 条引用的 .dat 不存在 — {DAT_DIR.relative_to(ROOT)}/{dat}"
                )

    for orphan in sorted(on_disk - referenced):
        warnings.append(
            f"{DAT_DIR.relative_to(ROOT)}/{orphan} 在磁盘上但没有任何数据条目引用它 —— "
            f"采集了却没进数据文件，等于没采集"
        )

    # ── 成本画像覆盖度 ──
    # 只有一个 productType 时，"P95 对产品复杂度"这条曲线只有一个点，
    # 画不出斜率 —— 而斜率才是容量规划要的东西（见 Workload Modeling §4.7.2）。
    types = set()
    for src in sources:
        for row in src["rows"]:
            t = str(row.get("productType") or "").strip()
            if t and t != "TBC":
                types.add(t)
    if len(types) < 3:
        warnings.append(
            f"只覆盖 {len(types)} 个 productType ({', '.join(sorted(types)) or '无'}) —— "
            f"成本画像至少需要 3 个代表：最便宜 / 最贵 / 最常见。"
            f"只有 1 个点画不出成本曲线的斜率，容量结论无法外推到其它产品"
        )

    print()
    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  FAIL  {e}")
    print(
        f"\n{len(on_disk)} 个 .dat 在磁盘，{len(referenced)} 个被引用；"
        f"{len(errors)} 个错误，{len(warnings)} 个告警"
    )
    return 1 if errors else 0


sys.exit(main())
