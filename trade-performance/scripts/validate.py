#!/usr/bin/env python3
"""
静态校验 JMeter 工程 —— 不需要 Java / JMeter。

检查项：
  1. 每个 .jmx 是合法 XML
  2. fragments/ 和 journeys/ 里不含 Thread Group（含了就无法被 Include）
  3. scenarios/ api/ suites/ ops/ 里至少有一个 Thread Group（没有就是空转）
  4. fragments/ journeys/ 的顶层是 TestFragmentController
  5. IncludeController 的路径存在（且不指向含 Thread Group 的文件）
  6. JSR223 引用的 .groovy 文件存在
  7. CSVDataSet 引用的 .csv 文件存在，且列数与 variableNames 一致
  8. element / hashTree 配对（JMeter 靠这个还原树形结构，错了会静默丢元件）
  9. CSV 中无 TBC 占位值（带着 TBC 能跑，但结果列全是 TBC，整轮白跑）

⚠ 它验证不了 JSONPath 是否匹配真实响应、断言是否成立、服务端是否接受请求。
   这些只能靠真跑一次 smoke。
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THREAD_GROUPS = {"ThreadGroup", "SetupThreadGroup", "PostThreadGroup",
                 "com.blazemeter.jmeter.threads.concurrency.ConcurrencyThreadGroup",
                 "kg.apc.jmeter.threads.SteppingThreadGroup"}

# fragments/ journeys/ 不可运行；其余目录必须可运行
NON_RUNNABLE = ("jmx/fragments", "jmx/journeys")

errors, warnings = [], []


def rel(p: Path) -> str:
    return str(p.relative_to(ROOT))


def resolve(raw: str) -> Path | None:
    """把 jmx 里的路径还原成磁盘路径。${__P(baseDir,.)} → 项目根。"""
    s = raw.strip()
    if not s:
        return None
    s = re.sub(r"\$\{__P\(baseDir,[^)]*\)\}", str(ROOT), s)
    if "${" in s:          # 仍含未知变量，无法静态解析
        return None
    p = Path(s)
    return p if p.is_absolute() else ROOT / p


def check_hashtree_pairing(path: Path, root: ET.Element) -> None:
    """
    JMeter 用 <element/><hashTree>children</hashTree> 表示树。
    每个非 hashTree 元素后面必须紧跟一个 hashTree（可以是空的 <hashTree/>）。
    配对错了 JMeter 不报错，只是**静默地把元件挂错位置或丢掉**。
    """
    for parent in root.iter("hashTree"):
        kids = list(parent)
        i = 0
        while i < len(kids):
            el = kids[i]
            if el.tag == "hashTree":
                errors.append(f"{rel(path)}: 多余的 <hashTree>（前面没有对应元件）")
                i += 1
                continue
            if i + 1 >= len(kids) or kids[i + 1].tag != "hashTree":
                name = el.get("testname", el.tag)
                errors.append(f"{rel(path)}: <{el.tag} testname='{name}'> 后面缺 <hashTree>")
                i += 1
            else:
                i += 2


def check(path: Path) -> None:
    try:
        tree = ET.parse(path)
    except ET.ParseError as e:
        errors.append(f"{rel(path)}: XML 解析失败 — {e}")
        return
    root = tree.getroot()
    r = rel(path)
    non_runnable = any(r.startswith(d) for d in NON_RUNNABLE)

    tgs = [e for e in root.iter() if e.tag in THREAD_GROUPS]
    frags = [e for e in root.iter() if e.tag == "TestFragmentController"]

    if non_runnable:
        if tgs:
            errors.append(
                f"{r}: fragment/journey 里出现了 {tgs[0].tag} —— "
                f"这会让它无法被 Include Controller 引用")
        if not frags:
            errors.append(f"{r}: fragment/journey 缺少 TestFragmentController")
    else:
        # setUp / postThread 不算 —— 只有它们的 plan 会正常跑完并产出一份 0 sample
        # 的报告，看起来"成功了"。这是最需要在静态阶段拦掉的一种假成功。
        main_tgs = [e for e in tgs if e.tag not in ("SetupThreadGroup", "PostThreadGroup")]
        if not main_tgs:
            errors.append(
                f"{r}: 可运行的 plan 里没有主 Thread Group"
                f"（只有 {[e.tag for e in tgs] or '无'}）—— 跑起来是空转")

    check_hashtree_pairing(path, root)

    # Include 路径
    for inc in root.iter("IncludeController"):
        sp = inc.find("stringProp[@name='IncludeController.includepath']")
        raw = (sp.text or "").strip() if sp is not None else ""
        if not raw:
            errors.append(f"{r}: IncludeController 路径为空")
            continue
        if "${" in raw:
            errors.append(
                f"{r}: IncludeController 路径含变量 '{raw}' —— "
                f"JMeter 不支持，必须写死")
            continue
        target = ROOT / raw
        if not target.exists():
            errors.append(f"{r}: Include 目标不存在 — {raw}")
            continue
        # 被 Include 的文件不能有 Thread Group
        try:
            sub = ET.parse(target).getroot()
            if any(e.tag in THREAD_GROUPS for e in sub.iter()):
                errors.append(f"{r}: Include 了含 Thread Group 的文件 — {raw}")
        except ET.ParseError:
            pass  # 目标文件自身的解析错误已单独报告

    # Groovy 脚本
    for tag in ("JSR223PreProcessor", "JSR223PostProcessor",
                "JSR223Assertion", "JSR223Sampler", "JSR223Listener"):
        for el in root.iter(tag):
            fn = el.find("stringProp[@name='filename']")
            inline = el.find("stringProp[@name='script']")
            raw = (fn.text or "").strip() if fn is not None else ""
            if not raw:
                if inline is not None and (inline.text or "").strip():
                    warnings.append(
                        f"{r}: <{tag} testname='{el.get('testname')}'> 用了内联脚本 —— "
                        f"约定是外置到 groovy/")
                else:
                    errors.append(f"{r}: <{tag} testname='{el.get('testname')}'> 既无脚本文件也无内联脚本")
                continue
            target = resolve(raw)
            if target is None:
                warnings.append(f"{r}: 无法静态解析脚本路径 '{raw}'")
            elif not target.exists():
                errors.append(f"{r}: Groovy 脚本不存在 — {raw}")

    # CSV
    for el in root.iter("CSVDataSet"):
        fn = el.find("stringProp[@name='filename']")
        raw = (fn.text or "").strip() if fn is not None else ""
        target = resolve(raw)
        if target is None:
            warnings.append(f"{r}: 无法静态解析 CSV 路径 '{raw}'")
            continue
        if not target.exists():
            errors.append(f"{r}: CSV 不存在 — {raw}")
            continue

        # 列数必须与 variableNames 一致。
        # 少一列 JMeter 不报错，只是把后面的值整体前移 —— 于是 datFile 拿到了 productType 的值，
        # 请求带着一个不存在的文件名发出去。这类错误在报告里表现为业务失败，极难倒推。
        vn = el.find("stringProp[@name='variableNames']")
        names = [n for n in (vn.text or "").split(",") if n.strip()] if vn is not None else []
        header = target.read_text(encoding="utf-8").splitlines()[0] if target.stat().st_size else ""
        ncols = len(header.split(",")) if header else 0
        if names and ncols and ncols != len(names):
            errors.append(
                f"{r}: CSV 列数不符 — {raw} 首行 {ncols} 列，"
                f"variableNames {len(names)} 个 ({','.join(names)})")

        # 末列可空的字段必须保留结尾逗号，否则 JMeter 解析成"缺列"而非空串
        if names and header:
            for i, line in enumerate(target.read_text(encoding="utf-8").splitlines()[1:], start=2):
                if line.strip() and len(line.split(",")) != len(names):
                    errors.append(
                        f"{r}: {raw} 第 {i} 行 {len(line.split(','))} 列，"
                        f"应为 {len(names)} 列（末列可空时别漏结尾逗号）")
                    break

        # TBC 占位值。这类字段（costTier / fixings）只进 jtl 的结果列，不影响请求能否发出——
        # 所以带着 TBC 跑不会报错，只会让"P95 对定盘次数"这条成本曲线整列变成 TBC，
        # 事后才发现整轮数据白跑。宁可在这里红。
        tbc_rows = [
            i for i, line in enumerate(target.read_text(encoding="utf-8").splitlines()[1:], start=2)
            if "TBC" in line
        ]
        if tbc_rows:
            shown = ", ".join(map(str, tbc_rows[:5])) + ("..." if len(tbc_rows) > 5 else "")
            errors.append(
                f"{r}: {raw} 有 {len(tbc_rows)} 行含 TBC 占位值（第 {shown} 行）—— "
                f"需填入真实值后才能出成本画像结论（见 docs/performance/"
                f"workload-modeling.zh.md §4.7）")


def check_groovy_orphans(referenced: set[Path]) -> None:
    for g in sorted((ROOT / "groovy").glob("*.groovy")):
        if g not in referenced:
            warnings.append(f"groovy/{g.name}: 没有任何 jmx 引用它")


def collect_referenced() -> set[Path]:
    out = set()
    for jmx in (ROOT / "jmx").rglob("*.jmx"):
        try:
            root = ET.parse(jmx).getroot()
        except ET.ParseError:
            continue
        for el in root.iter():
            if el.tag.startswith("JSR223"):
                fn = el.find("stringProp[@name='filename']")
                if fn is not None:
                    t = resolve(fn.text or "")
                    if t:
                        out.add(t)
    return out


def main() -> int:
    files = sorted((ROOT / "jmx").rglob("*.jmx"))
    if not files:
        print("没有找到任何 .jmx", file=sys.stderr)
        return 1

    for f in files:
        check(f)
    check_groovy_orphans(collect_referenced())

    print(f"检查了 {len(files)} 个 jmx 文件\n")
    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  FAIL  {e}")

    if errors:
        print(f"\n✗ {len(errors)} 个错误, {len(warnings)} 个告警")
        return 1
    print(f"✓ 静态校验通过（{len(warnings)} 个告警）")
    print("\n注意：静态校验验证不了 JSONPath 是否匹配真实响应、断言是否成立、")
    print("      服务端是否接受请求。这些只能靠真跑一次 smoke。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
