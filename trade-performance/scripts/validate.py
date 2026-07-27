#!/usr/bin/env python3
"""
静态校验 JMeter 工程 —— 不需要 Java / JMeter。

结构性检查：
  1. 每个 .jmx 是合法 XML
  2. fragments/ 和 journeys/ 里不含 Thread Group（含了就无法被 Include）
  3. scenarios/ api/ suites/ ops/ 里至少有一个**主** Thread Group（没有就是空转）
  4. fragments/ journeys/ 的顶层是 TestFragmentController
  5. IncludeController 的路径存在（且不指向含 Thread Group 的文件）
  6. JSR223 引用的 .groovy 文件存在
  7. CSVDataSet 引用的 .csv 存在，且列数与 variableNames 一致
  8. element / hashTree 配对（JMeter 靠这个还原树形结构，错了会静默丢元件）
  9. CSV 中无 TBC 占位值（带着 TBC 能跑，但结果列全是 TBC，整轮白跑）

"每个 API 只维护一份"的五条强制规则（5 svc × N module × M api 规模下，
约定守不住，只能靠机器）：
  R1 HTTPSampler 只允许出现在 fragments/ 下；其余目录只能 Include
  R2 同一 method + 规范化 path 不得在两个 fragment 中重复定义
  R3 steps/<svc>/ 下的 fragment 必须用 ${__P(<svc>.host)} 寻址
  R4 每个 fragment 必须被某个可运行 plan 间接引用（孤儿检测）
  R5 api-registry.csv 与磁盘一致：登记的实现存在、不重复、无未登记的 fragment

⚠ 它验证不了 JSONPath 是否匹配真实响应、断言是否成立、服务端是否接受请求。
   这些只能靠真跑一次 smoke。
"""
import csv
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THREAD_GROUPS = {"ThreadGroup", "SetupThreadGroup", "PostThreadGroup",
                 "com.blazemeter.jmeter.threads.concurrency.ConcurrencyThreadGroup",
                 "kg.apc.jmeter.threads.SteppingThreadGroup"}

NON_RUNNABLE = ("jmx/fragments", "jmx/journeys")
RUNNABLE_DIRS = ("jmx/scenarios", "jmx/api", "jmx/suites", "jmx/ops")

errors, warnings = [], []


def rel(p: Path) -> str:
    return str(p.relative_to(ROOT))


def resolve(raw: str) -> Path | None:
    """把 jmx 里的路径还原成磁盘路径。

    ${__P(name,default)} 一律取 default —— 那是不加 -J 覆盖时实际会跑的值，
    所以它是最该被检查的那一个。早期版本只特判了 baseDir，
    结果 ${__P(refdataFile,...)} 这类"可切换的数据文件"整个绕过了 TBC 检查：
    校验器打一条 WARN 就放过了，而放过的恰好是唯一带占位值的文件。
    静态检查跳过的东西，等于没检查。

    ${__P(name)}（无 default）仍然无法解析 —— 返回 None，由调用方降级成 WARN。
    """
    s = (raw or "").strip()
    if not s:
        return None
    s = re.sub(r"\$\{__P\([A-Za-z0-9_.]+,([^)]*)\)\}", lambda m: m.group(1), s)
    if "${" in s:          # 仍含未知变量或无默认值的属性，无法静态解析
        return None
    p = Path(s)
    return p if p.is_absolute() else ROOT / p


def norm_path(raw: str) -> str:
    """
    规范化 sampler path，用于 R2 查重。
      ${__P(workers.basePath,/api/v1)}/trades/${tradeId}/risk-metrics?x=1
        → /trades/{}/risk-metrics
    去掉 basePath 前缀、把所有 ${...} 变量归一为 {}、丢掉 query string。
    不归一化就查不出重复：同一个端点在两处可能写成不同的变量名。
    """
    s = (raw or "").strip()
    s = re.sub(r"\$\{__P\([A-Za-z0-9_.]*basePath[^)]*\)\}", "", s)
    s = s.split("?", 1)[0]
    s = re.sub(r"\$\{[^}]*\}", "{}", s)
    return s.rstrip("/") or "/"


def svc_of(r: str) -> str | None:
    """steps/<svc>/... → svc；_composites 与 setup 不属于任何单一服务。"""
    parts = Path(r).parts
    if len(parts) >= 4 and parts[:3] == ("jmx", "fragments", "steps"):
        return None if parts[3] == "_composites" else parts[3]
    return None


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


def check(path: Path, endpoint_index: dict) -> None:
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
    samplers = list(root.iter("HTTPSamplerProxy"))

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

    # ── R1：HTTPSampler 只允许在 fragments/ 下定义 ──
    # 把"能定义 API 的地方"从 6 个目录收缩到 1 个，查重才只需要在一处查。
    if samplers and not r.startswith("jmx/fragments"):
        names = [s.get("testname") for s in samplers[:3]]
        errors.append(
            f"R1 {r}: 在 fragments/ 之外定义了 {len(samplers)} 个 HTTPSampler（{names}）—— "
            f"scenarios/journeys/api 只能 Include，不能自己定义接口")

    # ── R3：目录与服务寻址前缀必须一致 ──
    svc = svc_of(r)
    for s in samplers:
        dom = s.find("stringProp[@name='HTTPSampler.domain']")
        dom_txt = (dom.text or "").strip() if dom is not None else ""
        if not dom_txt:
            errors.append(
                f"R3 {r}: sampler '{s.get('testname')}' 没有显式 domain —— "
                f"会静默继承全局默认值并可能打到错误的服务")
        elif svc and f"__P({svc}." not in dom_txt:
            errors.append(
                f"R3 {r}: sampler '{s.get('testname')}' 位于 steps/{svc}/ 却使用 "
                f"'{dom_txt}' —— 应为 ${{__P({svc}.host,...)}}")

    # ── R2 索引：同一 method + 规范化 path 只允许定义一次 ──
    if r.startswith("jmx/fragments"):
        for s in samplers:
            m = s.find("stringProp[@name='HTTPSampler.method']")
            p_ = s.find("stringProp[@name='HTTPSampler.path']")
            key = ((m.text or "?").strip() if m is not None else "?",
                   norm_path(p_.text if p_ is not None else ""))
            endpoint_index[key].append(r)

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
                f"{r}: IncludeController 路径含变量 '{raw}' —— JMeter 不支持，必须写死")
            continue
        target = ROOT / raw
        if not target.exists():
            errors.append(f"{r}: Include 目标不存在 — {raw}")
            continue
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
                    errors.append(
                        f"{r}: <{tag} testname='{el.get('testname')}'> 既无脚本文件也无内联脚本")
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
        lines = target.read_text(encoding="utf-8").splitlines()
        header = lines[0] if lines else ""
        ncols = len(header.split(",")) if header else 0
        if names and ncols and ncols != len(names):
            errors.append(
                f"{r}: CSV 列数不符 — {raw} 首行 {ncols} 列，"
                f"variableNames {len(names)} 个 ({','.join(names)})")

        # 末列可空的字段必须保留结尾逗号，否则 JMeter 解析成"缺列"而非空串
        if names and header:
            for i, line in enumerate(lines[1:], start=2):
                if line.strip() and len(line.split(",")) != len(names):
                    errors.append(
                        f"{r}: {raw} 第 {i} 行 {len(line.split(','))} 列，"
                        f"应为 {len(names)} 列（末列可空时别漏结尾逗号）")
                    break

        # TBC 占位值。这类字段（costTier / fixings）只进 jtl 的结果列，不影响请求能否发出——
        # 所以带着 TBC 跑不会报错，只会让"P95 对定盘次数"这条成本曲线整列变成 TBC，
        # 事后才发现整轮数据白跑。宁可在这里红。
        #
        # 但**自由文本列除外**：notes 里写"split factor TBC"是合法的文档，不是占位符。
        # 不排除它就会产生误报，而误报是让一条好检查被人忽略的最快方式。
        FREE_TEXT = {"notes", "note", "comment", "comments", "description", "desc"}
        data_cols = [i for i, n in enumerate(names) if n.strip().lower() not in FREE_TEXT]
        tbc_rows = [
            i for i, line in enumerate(lines[1:], start=2)
            if any("TBC" in c for j, c in enumerate(line.split(",")) if j in data_cols)
        ]
        if tbc_rows:
            shown = ", ".join(map(str, tbc_rows[:5])) + ("..." if len(tbc_rows) > 5 else "")
            errors.append(
                f"{r}: {raw} 有 {len(tbc_rows)} 行含 TBC 占位值（第 {shown} 行）—— "
                f"需填入真实值后才能出成本画像结论（见 docs/performance/"
                f"workload-modeling.zh.md §4.7）")


def includes_of(jmx: Path) -> list[str]:
    try:
        root = ET.parse(jmx).getroot()
    except ET.ParseError:
        return []
    out = []
    for inc in root.iter("IncludeController"):
        sp = inc.find("stringProp[@name='IncludeController.includepath']")
        raw = (sp.text or "").strip() if sp is not None else ""
        if raw and "${" not in raw:
            out.append(raw)
    return out


def check_r4_orphans(all_jmx: list[Path]) -> None:
    """R4：每个 fragment 必须被某个可运行 plan 间接引用。
    改名后忘记更新引用方 → fragment 变孤儿，改动它对结果毫无影响，
    而报告依然全绿。这是最容易长期无人察觉的一类腐化。"""
    reachable, stack = set(), []
    for j in all_jmx:
        if any(rel(j).startswith(d) for d in RUNNABLE_DIRS):
            stack.extend(includes_of(j))
    while stack:
        cur = stack.pop()
        if cur in reachable:
            continue
        reachable.add(cur)
        t = ROOT / cur
        if t.exists():
            stack.extend(includes_of(t))
    for j in all_jmx:
        r = rel(j)
        if r.startswith("jmx/fragments") and r not in reachable:
            errors.append(f"R4 {r}: 孤儿 fragment —— 没有任何可运行 plan 引用它")


def check_r5_registry(all_jmx: list[Path]) -> None:
    """R5：api-registry.csv 与磁盘一致。
    registry 是"哪些 API 存在、各自实现在哪"的单一事实源；
    没有它，覆盖率和归属都只能靠人记。"""
    reg = ROOT / "api-registry.csv"
    if not reg.exists():
        errors.append("R5 api-registry.csv 不存在 —— 它是 API 清单的单一事实源")
        return
    rows = list(csv.DictReader(reg.open(encoding="utf-8")))
    seen_id, seen_impl = {}, {}
    for i, row in enumerate(rows, start=2):
        aid = (row.get("apiId") or "").strip()
        if not aid:
            errors.append(f"R5 api-registry.csv 第 {i} 行缺 apiId")
            continue
        if aid in seen_id:
            errors.append(f"R5 api-registry.csv: apiId '{aid}' 重复（第 {seen_id[aid]} 与 {i} 行）")
        seen_id[aid] = i

        impl = (row.get("impl") or "").strip()
        if not impl:
            continue
        if not (ROOT / impl).exists():
            errors.append(f"R5 api-registry.csv 第 {i} 行 impl 不存在 — {impl}")
        if impl in seen_impl:
            errors.append(
                f"R5 api-registry.csv: impl '{impl}' 被两个 API 登记"
                f"（第 {seen_impl[impl]} 与 {i} 行）—— 一个 fragment 只能实现一个 API")
        seen_impl[impl] = i

    # 反向：有 sampler 的原子 fragment 必须在 registry 里登记
    for j in all_jmx:
        r = rel(j)
        if not r.startswith("jmx/fragments/steps/") or "/_composites/" in r:
            continue
        try:
            has_sampler = next(ET.parse(j).getroot().iter("HTTPSamplerProxy"), None) is not None
        except ET.ParseError:
            continue
        if has_sampler and r not in seen_impl:
            errors.append(f"R5 {r}: 定义了接口但未登记进 api-registry.csv")


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

    endpoint_index: dict = defaultdict(list)
    for f in files:
        check(f, endpoint_index)

    # ── R2：同一端点只允许定义一次 ──
    for (method, path), where in sorted(endpoint_index.items()):
        if len(where) > 1:
            errors.append(
                f"R2 端点 {method} {path} 在 {len(where)} 个 fragment 中重复定义："
                f"{', '.join(where)} —— 一个 API 只能有一份契约定义")

    check_r4_orphans(files)
    check_r5_registry(files)
    check_groovy_orphans(collect_referenced())

    print(f"检查了 {len(files)} 个 jmx 文件，"
          f"{len(endpoint_index)} 个不同端点\n")
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
