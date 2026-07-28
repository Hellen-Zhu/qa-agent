#!/usr/bin/env python3
"""
summarize.py —— 从 jtl 里读出**可以写进报告的那几个数**。

  ./scripts/summarize.py                          最近一次 run
  ./scripts/summarize.py results/<runId>/result.jtl
  ./scripts/summarize.py results/<runId>/result.jtl --phase all

══ 为什么不直接看 JMeter 的 HTML 报告 ═══════════════════════════════
HTML 报告是对的，但它回答的问题和我们要回答的不是同一个。三处口径差异，
每一处都会让结论偏乐观：

  1. **它把 setUp 的 preflight 和主循环算成同一行。**
     两者的 sampler 标签完全一样（`workers_trademgmt_create`），
     因为 preflight 就是 Include 了同一个 fragment。
     preflight 那一笔是**冷启动**样本（连接未建立、JIT 未热、缓存空），
     通常就是报告里那个 max。拿它当"最坏情况"去写结论是错的。
     → 本脚本按 jtl 里的 runPhase 列过滤，默认只算 main。

  2. **它把失败的样本一起算进百分位。**
     业务拒绝往往**很快**返回（校验没过，压根没进主流程），
     它们会把 P95 往下拽，让容量看起来比实际好。
     → 本脚本把"成功样本耗时"和"全样本耗时"分开列，两个都给。

  3. **它的 Total 行同时含 TX 行和 sampler 行。**
     TransactionController 的 parent=false 会额外产生一行样本，
     照 Total 行读 TPS 会**翻倍**。
     → 本脚本按 label 分组，从不合计。

══ 与 k6 的可比性 ═════════════════════════════════════════════════
输出形状刻意做成和 k6/lib/summary.js 一样（三类错误 + 成功样本耗时 +
P95/P50 比值 + 样本量警告），这样两套框架的结果可以逐行对照。

⚠ 但**百分位算法在各家实现里不同**（最近秩 / 线性插值 / R 的九种）。
  本脚本用最近秩法：idx = ceil(p/100 × n) - 1。
  样本量小于 ~200 时，不同算法能差出几个百分点。
  所以跨框架对比要看 **P50 和整体形状**，不要咬 P95 的第三位数字。
"""
import csv
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"

# 一个分位数 p 要可信，至少要有 ~10 个样本落在它之外 → n ≥ 10/(1-p)
#   P95 → 200 个     P99 → 1000 个
# ⚠ 这两个数必须与 k6/lib/summary.js 保持一致 —— 否则同一次跑，
#   两套工具会对"样本够不够"给出相反的结论，而没人知道该信哪个。
MIN_P95 = 200
MIN_P99 = 1000


def pct(sorted_vals, p):
    """最近秩法。sorted_vals 必须已排序且非空。"""
    if not sorted_vals:
        return None
    idx = math.ceil(p / 100.0 * len(sorted_vals)) - 1
    return sorted_vals[max(0, min(idx, len(sorted_vals) - 1))]


def fmt_ms(v):
    if v is None:
        return "   -   "
    return f"{v:>7.0f}" if v < 10000 else f"{v/1000:>6.1f}s"


def latest_jtl():
    runs = sorted((d for d in RESULTS.glob("*/result.jtl")), key=lambda p: p.stat().st_mtime)
    return runs[-1] if runs else None


def load(path):
    with path.open(newline="", encoding="utf-8", errors="replace") as fh:
        return list(csv.DictReader(fh))


def summarize_label(rows, label):
    """一个 label 的全部数字。rows 已经按 label 过滤过。"""
    classes = {}
    ok_ms, all_ms = [], []
    t_start, t_end = None, None

    for r in rows:
        cls = (r.get("errClass") or "").strip()
        if not cls:
            # 没有 errClass 列（没走 run.sh），退化成用 success 列
            cls = "ok" if (r.get("success") or "").lower() == "true" else "technical"
        classes[cls] = classes.get(cls, 0) + 1

        try:
            elapsed = float(r["elapsed"])
            ts = int(r["timeStamp"])
        except (KeyError, ValueError, TypeError):
            continue

        all_ms.append(elapsed)
        if cls == "ok":
            ok_ms.append(elapsed)
        t_start = ts if t_start is None else min(t_start, ts)
        t_end = ts + elapsed if t_end is None else max(t_end, ts + elapsed)

    ok_ms.sort()
    all_ms.sort()
    span_s = (t_end - t_start) / 1000.0 if t_start is not None and t_end > t_start else 0.0

    return {
        "label": label,
        "n": len(rows),
        "classes": classes,
        "ok_ms": ok_ms,
        "all_ms": all_ms,
        "span_s": span_s,
        # TPS 只数成功样本：把业务拒绝算进吞吐，等于把"快速失败"当成产能
        "tps": (len(ok_ms) / span_s) if span_s > 0 else 0.0,
    }


def print_label(s):
    n, ok = s["n"], len(s["ok_ms"])
    print(f"\n── {s['label']} ──────────────────────────────────")
    print(f"  样本      {n}  (成功 {ok}，跨度 {s['span_s']:.0f}s)")

    order = ["ok", "technical", "business", "script"]
    meaning = {
        "ok": "",
        "technical": "← 这才是性能结论（连接失败/超时/5xx）",
        "business": "← 修数据，不是性能问题",
        "script": "← 脚本 bug，本轮结果作废",
    }
    print("  错误分类")
    for k in order + [k for k in s["classes"] if k not in order]:
        c = s["classes"].get(k, 0)
        if c == 0 and k not in ("ok",):
            continue
        rate = c / n * 100 if n else 0
        print(f"    {k:<10} {c:>6}  {rate:>5.1f}%  {meaning.get(k, '')}")

    print("  耗时 (ms)      P50      P90      P95      P99      max      avg")
    for name, vals in (("成功样本", s["ok_ms"]), ("全部样本", s["all_ms"])):
        if not vals:
            print(f"    {name}       （无）")
            continue
        avg = sum(vals) / len(vals)
        print(
            f"    {name}  {fmt_ms(pct(vals,50))} {fmt_ms(pct(vals,90))} "
            f"{fmt_ms(pct(vals,95))} {fmt_ms(pct(vals,99))} "
            f"{fmt_ms(vals[-1])} {fmt_ms(avg)}"
        )

    if s["ok_ms"]:
        p50, p95 = pct(s["ok_ms"], 50), pct(s["ok_ms"], 95)
        ratio = p95 / p50 if p50 else 0
        hint = "存在慢路径，值得单独拆" if ratio > 3 else "分布集中"
        print(f"  P95/P50   {ratio:.1f}×   （{hint}）")
    print(f"  TPS       {s['tps']:.2f}  /s   （只数成功样本）")

    # ── 样本量纪律 ──
    notes = []
    if 0 < ok < MIN_P95:
        need = s["span_s"] * MIN_P95 / ok
        notes.append(f"✗ P95 不可信 —— 需 ≥{MIN_P95} 个样本，当前 {ok}。这个并发下需跑约 {need:.0f} 秒")
    if 0 < ok < MIN_P99:
        need = s["span_s"] * MIN_P99 / ok
        notes.append(f"⚠ P99 不可信 —— 需 ≥{MIN_P99} 个样本，当前 {ok}。这个并发下需跑约 {need:.0f} 秒")
    if notes:
        for n in notes:
            print(f"  {n}")
        print("  精度要求应与余量挂钩：实测值与阈值相差一个数量级时，")
        print("  分位数不精确不影响判定 —— 但报告里必须写明样本量。")


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    phase = "all" if "--phase" in sys.argv and "all" in sys.argv else "main"

    path = Path(args[0]) if args else latest_jtl()
    if path is None:
        print("ERROR: results/ 下没有任何 result.jtl —— 先跑一次 run.sh", file=sys.stderr)
        return 2
    if not path.exists():
        print(f"ERROR: {path} 不存在", file=sys.stderr)
        return 2

    rows = load(path)
    if not rows:
        print(f"ERROR: {path} 是空的 —— 0 个样本。\n"
              "  最常见原因：没在项目根目录启动 JMeter，Include Controller 找不到 fragment。",
              file=sys.stderr)
        return 3

    print(f"jtl:      {path}")
    manifest = path.parent / "manifest.txt"
    if manifest.exists():
        for line in manifest.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith(("plan:", "profile:", "overrides:", "scriptCommit:", "scriptDirty:")):
                print(f"{line}")

    has_phase = "runPhase" in (rows[0].keys())
    if not has_phase:
        print("\n⚠ jtl 里没有 runPhase 列 —— 这一跑不是用 scripts/run.sh 启动的，\n"
              "  setUp 的 preflight 样本混在里面无法剔除。结论请标注此偏差。")
    phases = {}
    for r in rows:
        phases[(r.get("runPhase") or "?").strip()] = phases.get((r.get("runPhase") or "?").strip(), 0) + 1
    print(f"\n阶段分布  {', '.join(f'{k}={v}' for k, v in sorted(phases.items()))}")

    work = rows
    if has_phase and phase == "main":
        work = [r for r in rows if (r.get("runPhase") or "").strip() == "main"]
        print(f"          → 只统计 runPhase=main（{len(work)} 行）；"
              f"加 --phase all 可看全部")
        if not work:
            print("\n⚠ 没有任何 runPhase=main 的样本 —— 主线程组一条请求都没发出去。", file=sys.stderr)
            return 3

    labels = {}
    for r in work:
        labels.setdefault(r.get("label", "?"), []).append(r)

    # TX 行在前（它才是"一步业务"的耗时口径），sampler 行在后
    for label in sorted(labels, key=lambda x: (not x.startswith("TX_"), x)):
        print_label(summarize_label(labels[label], label))

    print("\n" + "─" * 58)
    print("⚠ 不要把 TX_* 行和 sampler 行相加 —— 它们是同一批请求的两种口径。")
    print("  TX_* = 一步业务的耗时（本例两者几乎相同，因为一步只含一个请求）")
    print("  报告里引用哪个都行，但全篇必须统一。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
