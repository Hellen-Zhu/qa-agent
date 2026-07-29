#!/usr/bin/env python3
"""
data-sync.py —— data/ 下 JSON（源）与 CSV（JMeter 侧生成物）的同步与对账。

  ./scripts/data-sync.py                       检查 JSON 与 CSV 是否一致（提交前跑）
  ./scripts/data-sync.py --write               JSON → CSV 重新生成
  ./scripts/data-sync.py --from-csv --write    CSV → JSON（一次性迁移：把手上的
                                               真值 CSV 搬进 JSON，保留 JSON 里的 _comment）

══ 为什么要有这个脚本 ═══════════════════════════════════════════════
"k6 与 JMeter 读同一份数据"是选型论证里的一条卖点。k6 主格式换成 JSON 后，
这个性质只能靠**单一源 + 生成物**保住：JSON 是唯一手改的文件，JMeter 读的
CSV 由本脚本生成。没有对账的双格式必然漂移——而数据漂移的表现是两套工具
的数字对不上，会被误读成工具差异。

══ 规则 ═══════════════════════════════════════════════════════════
- 对账对象：data/**/ 下每个 .json 与同名 .csv。
- JSON 契约与 k6/lib/rows.js 一致：顶层 rows 数组（或裸数组）、_ 开头键是注释、
  值转字符串。列序取字段首次出现的顺序。
- 无 JSON 源的 CSV：JMeter 专用（尚未迁移），列入 JMETER_ONLY 白名单，
  不对账；不在白名单的会告警。
"""
import csv
import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# JMeter 专用、尚无 JSON 源的 CSV（p06 迁 k6 时移出名单并建 JSON）
JMETER_ONLY = {
    "data/lifecycle-events/lifecycle-event-data.csv",
}


def die(msg: str) -> None:
    print(f"  FAIL  {msg}")
    sys.exit(1)


def rows_from_json(path: Path):
    """与 k6/lib/rows.js 同一契约；改这里必须同步改那边。"""
    doc = json.loads(path.read_text(encoding="utf-8"))
    rows = doc if isinstance(doc, list) else doc.get("rows") if isinstance(doc, dict) else None
    if not isinstance(rows, list):
        die(f"{path.relative_to(ROOT)} 结构不对：顶层应为数组或含 rows 数组的对象")
    out = []
    for i, r in enumerate(rows, 1):
        if not isinstance(r, dict):
            die(f"{path.relative_to(ROOT)} 第 {i} 条不是对象")
        out.append({
            k: ("" if v is None else str(v).strip())
            for k, v in r.items() if not k.startswith("_")
        })
    return out


def columns_of(rows):
    cols = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    return cols


def csv_text(rows) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=columns_of(rows), restval="", lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


def json_pairs():
    """(json_path, csv_path) 对；csv 可能尚不存在。"""
    return [(p, p.with_suffix(".csv")) for p in sorted(DATA.rglob("*.json"))]


def check() -> int:
    drift, ok = 0, 0
    for jp, cp in json_pairs():
        rel_j, rel_c = jp.relative_to(ROOT), cp.relative_to(ROOT)
        expected = csv_text(rows_from_json(jp))
        if not cp.exists():
            print(f"  DRIFT {rel_c} 不存在 —— 跑 --write 生成")
            drift += 1
            continue
        actual = cp.read_text(encoding="utf-8")
        # 按行比较：对行尾（\r\n vs \n）与末尾换行宽容，对内容严格
        if expected.splitlines() != actual.splitlines():
            print(f"  DRIFT {rel_c} 与 {rel_j} 不一致 —— JSON 是源，跑 --write 重新生成；")
            print(f"        若真值改在了 CSV 侧，用 --from-csv --write 先搬回 JSON")
            drift += 1
        else:
            ok += 1

    json_stems = {p.with_suffix("") for p, _ in json_pairs()}
    for cp in sorted(DATA.rglob("*.csv")):
        rel = cp.relative_to(ROOT).as_posix()
        if cp.with_suffix("") not in json_stems and rel not in JMETER_ONLY:
            print(f"  WARN  {rel} 没有 JSON 源也不在 JMETER_ONLY 白名单 —— 谁在维护它？")

    print(f"\n{ok} 对一致，{drift} 处漂移")
    return 1 if drift else 0


def write_csv() -> int:
    for jp, cp in json_pairs():
        cp.write_text(csv_text(rows_from_json(jp)), encoding="utf-8")
        print(f"  ✎ {cp.relative_to(ROOT)}  ← {jp.relative_to(ROOT)}")
    return 0


def write_json_from_csv() -> int:
    """迁移方向：CSV → JSON。保留目标 JSON 里已有的顶层 _ 注释键。"""
    n = 0
    for jp, cp in json_pairs():
        if not cp.exists():
            print(f"  SKIP  {cp.relative_to(ROOT)} 不存在")
            continue
        rows = [dict(r) for r in csv.DictReader(cp.open(encoding="utf-8"))]
        obj = {}
        if jp.exists():
            old = json.loads(jp.read_text(encoding="utf-8"))
            if isinstance(old, dict):
                obj = {k: v for k, v in old.items() if k.startswith("_")}
        obj["rows"] = rows
        jp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"  ✎ {jp.relative_to(ROOT)}  ← {cp.relative_to(ROOT)}")
        n += 1
    if n:
        print("\n⚠ 迁移完成后 JSON 是源：之后只改 JSON，用 --write 生成 CSV")
    return 0


def main() -> int:
    write = "--write" in sys.argv
    from_csv = "--from-csv" in sys.argv
    if from_csv and not write:
        print("--from-csv 会覆盖 JSON 的 rows，必须显式加 --write")
        return 2
    if from_csv:
        return write_json_from_csv()
    if write:
        return write_csv()
    return check()


sys.exit(main())
