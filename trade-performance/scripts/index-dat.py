#!/usr/bin/env python3
"""
index-dat.py —— 把 data/dat/ 的实际内容与 create-trade 数据文件对账。

  ./scripts/index-dat.py            只报告，不改文件
  ./scripts/index-dat.py --write    把 datSizeBytes 填成实测字节数

数据源：data/create-trade/*.json（k6 主格式，rows 键下）；
检出里若还没有 JSON（真值仍在 CSV 的机器），自动退回 *.csv。
--write 写回 JSON 后，记得跑 ./scripts/data-sync.py --write 同步 JMeter 侧 CSV。

══ 为什么体积必须是实测值，不能手写 ═════════════════════════════════
早期版本用 data/dat/{small,medium,large}/ 三个目录 + 数据里一个 datSize 标签。
那个结构隐含了一个错误前提：**体积是可以自由选择的自变量**。

它不是。体积是**产品结构的结果** —— 一笔 TARF 文件大，是因为它有 24 个定盘；
现实中不存在"TARF × small"这种组合。当时的数据就长成了 5 行全是 FX_TRF、
只有体积不同的样子，那是一组现实中不存在的用例。

现在目录按 productType 分，体积由本脚本实测填入。手写不了，就编不出来。

══ 它检查三件事 ═══════════════════════════════════════════════════
  1. 数据引用的 .dat 在磁盘上存在        —— 缺文件会在压测中期才炸，且报错含糊
  2. 磁盘上的 .dat 都被某一条数据引用    —— 采集了却没进数据文件 = 白采集
  3. datSizeBytes 与实际字节数一致       —— 防止文件换了而标签没跟着换
"""
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAT_DIR = ROOT / "data" / "dat"
CASE_DIR = ROOT / "data" / "create-trade"

# 体积分档只用于报告分组，是**从实测值派生**的，不是输入。
# 阈值待真实样本到位后按分布调整（见 data/dat/README.md）。
TIERS = [(64 * 1024, "small"), (1024 * 1024, "medium"), (float("inf"), "large")]


def tier_of(n: int) -> str:
    return next(name for limit, name in TIERS if n < limit)


def load_sources():
    """优先 JSON（主格式）；一个 JSON 都没有时退回 CSV（未迁移的检出）。"""
    srcs = []
    for p in sorted(CASE_DIR.glob("*.json")):
        doc = json.loads(p.read_text(encoding="utf-8"))
        rows = doc["rows"] if isinstance(doc, dict) else doc
        srcs.append({"path": p, "doc": doc, "rows": rows, "fmt": "json"})
    if srcs:
        return srcs
    for p in sorted(CASE_DIR.glob("*.csv")):
        srcs.append({"path": p, "doc": None,
                     "rows": list(csv.DictReader(p.open(encoding="utf-8"))), "fmt": "csv"})
    return srcs


def save(src) -> None:
    if src["fmt"] == "json":
        # rows 是 doc 的引用，改动已在 doc 里；保留顶层 _ 注释键与键序
        src["path"].write_text(
            json.dumps(src["doc"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        with src["path"].open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=src["rows"][0].keys(), lineterminator="\n")
            w.writeheader()
            w.writerows(src["rows"])


def main() -> int:
    write = "--write" in sys.argv
    errors, warnings, updated = [], [], 0
    wrote_json = False

    on_disk = {
        p.relative_to(DAT_DIR).as_posix()
        for p in DAT_DIR.rglob("*")
        if p.is_file() and p.suffix == ".dat"
    }
    referenced = set()
    sources = load_sources()

    for src in sources:
        rows, rel = src["rows"], src["path"].relative_to(ROOT)
        if not rows:
            continue
        changed = False
        pos = "行" if src["fmt"] == "csv" else "条"

        for i, row in enumerate(rows, start=2 if src["fmt"] == "csv" else 1):
            dat = str(row.get("datFile") or "").strip()
            if not dat:
                errors.append(f"{rel} 第 {i} {pos} datFile 为空")
                continue
            referenced.add(dat)

            full = DAT_DIR / dat
            if not full.is_file():
                errors.append(
                    f"{rel} 第 {i} {pos}引用的 .dat 不存在 — data/dat/{dat}  "
                    f"(caseId={row.get('caseId')})"
                )
                continue

            actual = full.stat().st_size
            declared = str(row.get("datSizeBytes") or "").strip()

            if declared in ("AUTO", "", "TBC"):
                row["datSizeBytes"] = str(actual)
                changed = True
                updated += 1
                print(f"  填入 {rel}:{i}  {dat}  → {actual} bytes ({tier_of(actual)})")
            elif declared.isdigit() and int(declared) != actual:
                errors.append(
                    f"{rel} 第 {i} {pos} datSizeBytes={declared} 与实际 {actual} 不符 — "
                    f"文件换过了？重跑 --write 或确认是不是换错了文件"
                )
            elif not declared.isdigit():
                errors.append(
                    f"{rel} 第 {i} {pos} datSizeBytes='{declared}' 不是数字 — "
                    f"体积是实测值，写 AUTO 让本脚本填"
                )

        if changed and write:
            save(src)
            wrote_json = wrote_json or src["fmt"] == "json"
            print(f"  ✎ 已写回 {rel}")
        elif changed:
            print(f"  （--write 才会写回 {rel}）")

    for orphan in sorted(on_disk - referenced):
        warnings.append(
            f"data/dat/{orphan} 在磁盘上但没有任何数据条目引用它 —— "
            f"采集了却没进数据文件，等于没采集"
        )

    # ── 成本画像覆盖度 ──
    # 只有一个 productType 时，"P95 对定盘次数"这条曲线只有一个点，
    # 画不出斜率 —— 而斜率才是容量规划要的东西（见 Workload Modeling §4.7.2）。
    types = set()
    for src in sources:
        if "invalid" in src["path"].name:
            continue
        for row in src["rows"]:
            t = str(row.get("productType") or "").strip()
            if t and t != "TBC":
                types.add(t)
    if len(types) < 3:
        warnings.append(
            f"正常路径只覆盖 {len(types)} 个 productType ({', '.join(sorted(types)) or '无'}) —— "
            f"成本画像至少需要 3 个代表：最便宜 / 最贵 / 最常见。"
            f"只有 1 个点画不出成本曲线的斜率，容量结论无法外推到其它产品"
        )

    print()
    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  FAIL  {e}")
    print(
        f"\n{len(on_disk)} 个 .dat 在磁盘，{len(referenced)} 个被引用，"
        f"填入 {updated} 处；{len(errors)} 个错误，{len(warnings)} 个告警"
    )
    if wrote_json:
        print("⚠ JSON 已改 —— 跑 ./scripts/data-sync.py --write 同步 JMeter 侧 CSV")
    return 1 if errors else 0


sys.exit(main())
