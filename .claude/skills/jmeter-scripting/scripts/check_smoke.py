#!/usr/bin/env python3
"""冒烟门禁判定:解析 XML 格式的 .jtl,按四条规则判成败。

四条规则里最有价值的是第 3 条。JMeter 对未定义变量的处理是【原样发送
字面量】——不警告、不报错。${token} 没提取到,它就真的发出去一个
`Authorization: Bearer ${token}`,服务端回 401,你只会看到"401,大概是
账号问题吧"。这条检查把它变成一句明确的"第 2 步 token 提取失败"。
"""
from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET

EXTRACT_FAILED = "__EXTRACT_FAILED__"
SAMPLE_TAGS = ("httpSample", "sample")


def load_samples(jtl_path: str) -> list:
    tree = ET.parse(jtl_path)
    samples = []
    for tag in SAMPLE_TAGS:
        samples.extend(tree.getroot().iter(tag))
    # 按文档顺序还原(iter 分标签收集会打乱顺序)
    order = {id(el): i for i, el in enumerate(tree.getroot().iter())}
    return sorted(samples, key=lambda el: order[id(el)])


def text_of(sample, tag: str) -> str:
    node = sample.find(tag)
    return (node.text or "") if node is not None else ""


def request_payload(sample) -> str:
    """请求侧的全部文本:URL + samplerData(含请求体) + 请求头。"""
    return "\n".join([
        text_of(sample, "java.net.URL"),
        text_of(sample, "samplerData"),
        text_of(sample, "requestHeader"),
    ])


def failed_assertions(sample) -> list:
    out = []
    for ar in sample.iter("assertionResult"):
        failure = (ar.findtext("failure") or "false").lower() == "true"
        error = (ar.findtext("error") or "false").lower() == "true"
        if failure or error:
            out.append({
                "name": ar.findtext("name") or "",
                "message": (ar.findtext("failureMessage") or "").strip(),
            })
    return out


def main() -> int:
    if len(sys.argv) < 3:
        print("用法: check_smoke.py <smoke.jtl> <smoke-expect.json>", file=sys.stderr)
        return 2

    jtl_path, expect_path = sys.argv[1], sys.argv[2]
    with open(expect_path, encoding="utf-8") as fh:
        expect = json.load(fh)

    try:
        samples = load_samples(jtl_path)
    except (ET.ParseError, FileNotFoundError) as exc:
        print(f"无法解析 {jtl_path}: {exc}", file=sys.stderr)
        print("检查 JMeter 是否真的跑起来了(看 jmeter.log)。", file=sys.stderr)
        return 2

    problems = []

    # ── 规则 1:步骤全覆盖 ────────────────────────────────────────────
    expected_n = expect.get("expected_samplers", 0)
    if len(samples) != expected_n:
        problems.append(
            f"步骤数不符:期望执行 {expected_n} 个请求,实际执行 {len(samples)} 个。"
            "少了说明某个 flow 没被走到,多了说明控制器嵌套层级不对。"
        )

    print(f"{'步骤':<44}{'状态码':<8}{'耗时':<8}{'结果'}")
    print("─" * 72)

    for idx, sample in enumerate(samples, 1):
        label = sample.get("lb", "")[:42]
        code = sample.get("rc", "")
        elapsed = sample.get("t", "")
        success = sample.get("s", "false").lower() == "true"

        step_problems = []

        # ── 规则 2:全部 success ──────────────────────────────────────
        if not success:
            body = text_of(sample, "responseData")[:500]
            step_problems.append(
                f"请求失败 rc={code} {sample.get('rm', '')}\n"
                f"        响应体前 500 字符: {body or '(未记录)'}"
            )

        # ── 规则 3:无未解析变量 / 无提取失败哨兵 ─────────────────────
        payload = request_payload(sample)
        if EXTRACT_FAILED in payload:
            step_problems.append(
                f"关联提取失败:请求里出现了 {EXTRACT_FAILED}。"
                "上游步骤的 JSONPath 在响应中没匹配到——去 scenario.yaml 检查该步的 extract。"
            )
        if "${" in payload:
            leaked = {seg.split("}")[0] for seg in payload.split("${")[1:] if "}" in seg}
            names = ", ".join(sorted(f"${{{n}}}" for n in leaked if not n.startswith("__")))
            if names:
                step_problems.append(
                    f"变量未解析,字面量被直接发出: {names}。"
                    "该变量既不在 CSV 列里,也不来自上游 extract。"
                )

        # ── 规则 4:断言全通过 ────────────────────────────────────────
        for failure in failed_assertions(sample):
            step_problems.append(f'断言失败「{failure["name"]}」: {failure["message"]}')

        mark = "通过" if not step_problems else "失败"
        print(f"{label:<44}{code:<8}{elapsed + 'ms':<8}{mark}")
        for problem in step_problems:
            print(f"      → {problem}")
            problems.append(f"[第{idx}步 {label}] {problem}")

    print("─" * 72)
    if problems:
        print(f"\n冒烟未通过,共 {len(problems)} 个问题。")
        print("脚本还不能用于正式压测——现在压出来的是错误路径的性能数据。")
        return 1

    print(f"\n冒烟通过:{len(samples)} 个请求全部成功,关联提取生效,断言通过。")
    print("脚本可以用于正式压测了。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
