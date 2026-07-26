#!/usr/bin/env python3
"""把 .jmx 打印成元件树,不用开 GUI 就能确认结构。

交付前用它跟用户对一遍结构,比让对方打开 JMeter 快得多;
排查「元件挂错父节点」时它也是最直接的工具。

用法: python3 dump_tree.py testplan.jmx
"""
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET

# 只显示对理解结构有用的属性
INTERESTING = {
    "ThreadGroup": [
        ("线程", 'stringProp[@name="ThreadGroup.num_threads"]'),
        ("ramp", 'stringProp[@name="ThreadGroup.ramp_time"]'),
        ("时长", 'stringProp[@name="ThreadGroup.duration"]'),
    ],
    "ThroughputController": [
        ("占比", 'stringProp[@name="ThroughputController.percentThroughput"]'),
    ],
    "HTTPSamplerProxy": [
        ("方法", 'stringProp[@name="HTTPSampler.method"]'),
        ("路径", 'stringProp[@name="HTTPSampler.path"]'),
    ],
    "JSONPostProcessor": [
        ("变量", 'stringProp[@name="JSONPostProcessor.referenceNames"]'),
        ("路径", 'stringProp[@name="JSONPostProcessor.jsonPathExprs"]'),
    ],
    "ConstantTimer": [("延迟ms", 'stringProp[@name="ConstantTimer.delay"]')],
    "CSVDataSet": [("文件", 'stringProp[@name="filename"]'),
                   ("变量", 'stringProp[@name="variableNames"]')],
}


def describe(element) -> str:
    parts = []
    for label, xpath in INTERESTING.get(element.tag, []):
        value = element.findtext(xpath)
        if value:
            parts.append(f"{label}={value}")
    return ("  " + ", ".join(parts)) if parts else ""


def walk(hash_tree, depth: int = 0) -> None:
    """hashTree 的子节点严格交替: 元件, hashTree, 元件, hashTree, ...

    按这个约定成对遍历。如果结构被破坏,这里会自然地错位或抛异常,
    所以它同时也是一个粗粒度的结构检查。
    """
    children = list(hash_tree)
    for i in range(0, len(children), 2):
        element = children[i]
        subtree = children[i + 1] if i + 1 < len(children) else None
        name = element.get("testname", "")
        print(f"{'  ' * depth}{element.tag:<22} {name}{describe(element)}")
        if subtree is not None and subtree.tag == "hashTree":
            walk(subtree, depth + 1)


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: dump_tree.py <testplan.jmx>", file=sys.stderr)
        return 2
    root = ET.parse(sys.argv[1]).getroot()
    top = root.find("hashTree")
    if top is None:
        print("这不是一个合法的 .jmx(缺少顶层 hashTree)", file=sys.stderr)
        return 1
    walk(top)
    return 0


if __name__ == "__main__":
    sys.exit(main())
