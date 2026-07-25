#!/usr/bin/env python3
"""JMeter .jmx 元件构造层。

本模块只负责一件事：把参数变成合法的 JMeter XML 片段。
它不认识 Swagger、不认识 scenario.yaml，只认识 JMeter。

核心是 Node + render():JMeter 要求每个元件后面紧跟一个 <hashTree>,
哪怕没有子元件也要写 <hashTree/>。漏一个,后面所有元件的父子关系
集体错位,而 JMeter 打开时不会报错。这条规则被编码进 render() 的递归里,
物理上不可能漏写。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from xml.sax.saxutils import escape as _xml_escape

JMETER_VERSION = "5.6.3"

# 提取失败时写入变量的哨兵值。用可检测的字面量而不是留空,
# 冒烟阶段 grep 这个值就能定位到具体哪一步的关联提取失败了。
EXTRACT_FAILED = "__EXTRACT_FAILED__"


def esc(value) -> str:
    """XML 文本转义。所有进入 XML 的用户数据都必须过这里。"""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if not isinstance(value, str):
        value = str(value)
    return _xml_escape(value, {'"': "&quot;", "'": "&apos;"})


def java_hash(s: str) -> int:
    """Java String.hashCode()。JMeter 用它给 collectionProp 里的元素命名。

    功能上 JMeter 不校验这个名字,但生成与 GUI 一致的值可以让
    「GUI 打开后另存」的 diff 保持干净。
    """
    h = 0
    for ch in s:
        h = (31 * h + ord(ch)) & 0xFFFFFFFF
    return h - 2**32 if h >= 2**31 else h


@dataclass
class Node:
    """一个 JMeter 元件及其子元件。"""

    xml: str
    children: list["Node"] = field(default_factory=list)

    def add(self, child: "Node | None") -> "Node":
        if child is not None:
            self.children.append(child)
        return self

    def extend(self, children) -> "Node":
        for c in children:
            self.add(c)
        return self


def render(node: Node, indent: int = 0) -> str:
    """递归序列化。hashTree 配对由这个函数的结构保证。"""
    pad = "  " * indent
    body = "".join(render(c, indent + 1) for c in node.children)
    element = "\n".join(pad + line for line in node.xml.strip().splitlines())
    if not node.children:
        return f"{element}\n{pad}<hashTree/>\n"
    return f"{element}\n{pad}<hashTree>\n{body}{pad}</hashTree>\n"


def render_document(testplan: Node) -> str:
    inner = render(testplan, 2)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<jmeterTestPlan version="1.2" properties="5.0" jmeter="{JMETER_VERSION}">\n'
        "  <hashTree>\n"
        f"{inner}"
        "  </hashTree>\n"
        "</jmeterTestPlan>\n"
    )


# --------------------------------------------------------------------------
# 元件构造函数
# --------------------------------------------------------------------------


def test_plan(name: str, comments: str = "") -> Node:
    return Node(
        f'<TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="{esc(name)}" enabled="true">\n'
        f'  <stringProp name="TestPlan.comments">{esc(comments)}</stringProp>\n'
        '  <boolProp name="TestPlan.functional_mode">false</boolProp>\n'
        '  <boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>\n'
        '  <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>\n'
        '  <elementProp name="TestPlan.user_defined_variables" elementType="Arguments"'
        ' guiclass="ArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">\n'
        '    <collectionProp name="Arguments.arguments"/>\n'
        "  </elementProp>\n"
        '  <stringProp name="TestPlan.user_define_classpath"></stringProp>\n'
        "</TestPlan>"
    )


def thread_group(name: str, threads: str, ramp_up: str, hold: str, smoke: bool = False) -> Node:
    """线程组。

    正式模式:loops=-1 + scheduler=true,由 duration 控制时长。
    冒烟模式:loops=1 + scheduler=false,跑完一轮就退出。
    """
    if smoke:
        loop_xml = (
            '    <boolProp name="LoopController.continue_forever">false</boolProp>\n'
            '    <stringProp name="LoopController.loops">1</stringProp>\n'
        )
        scheduler, duration = "false", "0"
        threads, ramp_up = "1", "1"
    else:
        loop_xml = (
            '    <boolProp name="LoopController.continue_forever">false</boolProp>\n'
            '    <stringProp name="LoopController.loops">-1</stringProp>\n'
        )
        scheduler, duration = "true", hold

    return Node(
        f'<ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="{esc(name)}" enabled="true">\n'
        '  <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>\n'
        '  <elementProp name="ThreadGroup.main_controller" elementType="LoopController"'
        ' guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true">\n'
        f"{loop_xml}"
        "  </elementProp>\n"
        f'  <stringProp name="ThreadGroup.num_threads">{esc(threads)}</stringProp>\n'
        f'  <stringProp name="ThreadGroup.ramp_time">{esc(ramp_up)}</stringProp>\n'
        f'  <boolProp name="ThreadGroup.scheduler">{scheduler}</boolProp>\n'
        f'  <stringProp name="ThreadGroup.duration">{esc(duration)}</stringProp>\n'
        '  <stringProp name="ThreadGroup.delay">0</stringProp>\n'
        '  <boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>\n'
        "</ThreadGroup>"
    )


def http_defaults(protocol: str, domain: str, port: str, connect_timeout: int = 10000,
                  response_timeout: int = 60000) -> Node:
    return Node(
        '<ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement"'
        ' testname="HTTP Request Defaults" enabled="true">\n'
        '  <elementProp name="HTTPsampler.Arguments" elementType="Arguments"'
        ' guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">\n'
        '    <collectionProp name="Arguments.arguments"/>\n'
        "  </elementProp>\n"
        f'  <stringProp name="HTTPSampler.domain">{esc(domain)}</stringProp>\n'
        f'  <stringProp name="HTTPSampler.port">{esc(port)}</stringProp>\n'
        f'  <stringProp name="HTTPSampler.protocol">{esc(protocol)}</stringProp>\n'
        '  <stringProp name="HTTPSampler.contentEncoding">UTF-8</stringProp>\n'
        '  <stringProp name="HTTPSampler.path"></stringProp>\n'
        f'  <stringProp name="HTTPSampler.connect_timeout">{connect_timeout}</stringProp>\n'
        f'  <stringProp name="HTTPSampler.response_timeout">{response_timeout}</stringProp>\n'
        "</ConfigTestElement>"
    )


def header_manager(headers: dict, name: str = "HTTP Header Manager") -> Node:
    rows = "".join(
        '    <elementProp name="" elementType="Header">\n'
        f'      <stringProp name="Header.name">{esc(k)}</stringProp>\n'
        f'      <stringProp name="Header.value">{esc(v)}</stringProp>\n'
        "    </elementProp>\n"
        for k, v in headers.items()
    )
    return Node(
        f'<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="{esc(name)}" enabled="true">\n'
        '  <collectionProp name="HeaderManager.headers">\n'
        f"{rows}"
        "  </collectionProp>\n"
        "</HeaderManager>"
    )


def csv_data_set(filename: str, variables: list, recycle: bool = True,
                 delimiter: str = ",", share_mode: str = "shareMode.all") -> Node:
    """CSV Data Set Config。

    ignoreFirstLine=true 假定 CSV 带表头行。variableNames 显式给出,
    不依赖表头解析,避免表头有 BOM 或空格时变量名带脏字符。
    """
    return Node(
        '<CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet"'
        ' testname="CSV Data Set Config" enabled="true">\n'
        f'  <stringProp name="filename">{esc(filename)}</stringProp>\n'
        '  <stringProp name="fileEncoding">UTF-8</stringProp>\n'
        f'  <stringProp name="variableNames">{esc(",".join(variables))}</stringProp>\n'
        '  <boolProp name="ignoreFirstLine">true</boolProp>\n'
        f'  <stringProp name="delimiter">{esc(delimiter)}</stringProp>\n'
        '  <boolProp name="quotedData">true</boolProp>\n'
        f'  <boolProp name="recycle">{esc(recycle)}</boolProp>\n'
        '  <boolProp name="stopThread">false</boolProp>\n'
        f'  <stringProp name="shareMode">{esc(share_mode)}</stringProp>\n'
        "</CSVDataSet>"
    )


def once_only_controller(name: str) -> Node:
    """每个线程只在第一次迭代执行。用于「每个虚拟用户登录一次」。"""
    return Node(
        '<OnceOnlyController guiclass="OnceOnlyControllerGui" testclass="OnceOnlyController"'
        f' testname="{esc(name)}" enabled="true"/>'
    )


def throughput_controller(name: str, percent: float, per_user: bool = False) -> Node:
    """按百分比随机执行子元件。

    警告:这个元件不控制吞吐量(RPS),只控制执行比例。控制 RPS 的是
    Constant Throughput Timer。JMeter 的命名在这里是误导性的。

    style=1 → Percent Executions;per_user=false → 百分比在全局收敛,
    这符合「流量构成比例」的语义。
    """
    return Node(
        '<ThroughputController guiclass="ThroughputControllerGui" testclass="ThroughputController"'
        f' testname="{esc(name)}" enabled="true">\n'
        '  <intProp name="ThroughputController.style">1</intProp>\n'
        f'  <boolProp name="ThroughputController.perThread">{esc(per_user)}</boolProp>\n'
        '  <intProp name="ThroughputController.maxThroughput">1</intProp>\n'
        f'  <stringProp name="ThroughputController.percentThroughput">{percent:.1f}</stringProp>\n'
        "</ThroughputController>"
    )


def _raw_body_args(body: str) -> str:
    return (
        '  <elementProp name="HTTPsampler.Arguments" elementType="Arguments">\n'
        '    <collectionProp name="Arguments.arguments">\n'
        '      <elementProp name="" elementType="HTTPArgument">\n'
        '        <boolProp name="HTTPArgument.always_encode">false</boolProp>\n'
        f'        <stringProp name="Argument.value">{esc(body)}</stringProp>\n'
        '        <stringProp name="Argument.metadata">=</stringProp>\n'
        "      </elementProp>\n"
        "    </collectionProp>\n"
        "  </elementProp>\n"
    )


def _query_args(params: dict) -> str:
    rows = "".join(
        '      <elementProp name="" elementType="HTTPArgument">\n'
        '        <boolProp name="HTTPArgument.always_encode">true</boolProp>\n'
        f'        <stringProp name="Argument.value">{esc(v)}</stringProp>\n'
        '        <stringProp name="Argument.metadata">=</stringProp>\n'
        '        <boolProp name="HTTPArgument.use_equals">true</boolProp>\n'
        f'        <stringProp name="Argument.name">{esc(k)}</stringProp>\n'
        "      </elementProp>\n"
        for k, v in params.items()
    )
    return (
        '  <elementProp name="HTTPsampler.Arguments" elementType="Arguments">\n'
        '    <collectionProp name="Arguments.arguments">\n'
        f"{rows}"
        "    </collectionProp>\n"
        "  </elementProp>\n"
    )


def http_sampler(name: str, method: str, path: str, query: dict | None = None,
                 body=None, follow_redirects: bool = True) -> Node:
    """HTTP 请求。

    body 非空 → postBodyRaw 模式(整个 body 作为一个无名参数原样发送)。
    body 为空 → query 参数走 Arguments 列表(GET 自动拼到 URL,POST 走 form)。
    两者互斥:JMeter 的 postBodyRaw 打开后会忽略具名参数。
    """
    if body is not None and body != "":
        if not isinstance(body, str):
            body = json.dumps(body, ensure_ascii=False)
        args_xml = _raw_body_args(body)
        raw = '  <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>\n'
    else:
        args_xml = _query_args(query or {})
        raw = ""

    return Node(
        '<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy"'
        f' testname="{esc(name)}" enabled="true">\n'
        f"{args_xml}{raw}"
        f'  <stringProp name="HTTPSampler.path">{esc(path)}</stringProp>\n'
        f'  <stringProp name="HTTPSampler.method">{esc(method.upper())}</stringProp>\n'
        f'  <boolProp name="HTTPSampler.follow_redirects">{esc(follow_redirects)}</boolProp>\n'
        '  <boolProp name="HTTPSampler.auto_redirects">false</boolProp>\n'
        '  <boolProp name="HTTPSampler.use_keepalive">true</boolProp>\n'
        '  <boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>\n'
        '  <stringProp name="HTTPSampler.embedded_url_re"></stringProp>\n'
        "</HTTPSamplerProxy>"
    )


def json_extractor(var_name: str, json_path: str, match_no: int = 1) -> Node:
    """JSON 提取器。

    defaultValues 写成可检测的哨兵而不是留空:提取失败时变量会是
    __EXTRACT_FAILED__,冒烟阶段一 grep 就能定位。留空的话 JMeter
    会把字面量 ${var} 原样发出去,更难排查。
    """
    return Node(
        '<JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor"'
        f' testname="提取 {esc(var_name)}" enabled="true">\n'
        f'  <stringProp name="JSONPostProcessor.referenceNames">{esc(var_name)}</stringProp>\n'
        f'  <stringProp name="JSONPostProcessor.jsonPathExprs">{esc(json_path)}</stringProp>\n'
        f'  <stringProp name="JSONPostProcessor.match_numbers">{match_no}</stringProp>\n'
        f'  <stringProp name="JSONPostProcessor.defaultValues">{EXTRACT_FAILED}</stringProp>\n'
        "</JSONPostProcessor>"
    )


# Assertion.test_type 位标志
TEST_TYPE_MATCHES = 1     # 整体正则匹配
TEST_TYPE_CONTAINS = 2    # 正则子串匹配
TEST_TYPE_EQUALS = 8
TEST_TYPE_SUBSTRING = 16


def response_assertion(name: str, patterns: list, field_: str = "Assertion.response_code",
                       test_type: int = TEST_TYPE_MATCHES) -> Node:
    rows = "".join(
        f'    <stringProp name="{java_hash(p)}">{esc(p)}</stringProp>\n' for p in patterns
    )
    return Node(
        '<ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion"'
        f' testname="{esc(name)}" enabled="true">\n'
        # 注:collectionProp 名字里的 "Asserion" 拼写错误是 JMeter 自身格式的既有缺陷,
        # 必须照抄,改成正确拼写 JMeter 反而读不到。
        '  <collectionProp name="Asserion.test_strings">\n'
        f"{rows}"
        "  </collectionProp>\n"
        '  <stringProp name="Assertion.custom_message"></stringProp>\n'
        f'  <stringProp name="Assertion.test_field">{field_}</stringProp>\n'
        '  <boolProp name="Assertion.assume_success">false</boolProp>\n'
        f'  <intProp name="Assertion.test_type">{test_type}</intProp>\n'
        "</ResponseAssertion>"
    )


def json_assertion(name: str, json_path: str, expected: str | None = None,
                   is_regex: bool = False) -> Node:
    validate = expected is not None
    return Node(
        '<JSONPathAssertion guiclass="JSONPathAssertionGui" testclass="JSONPathAssertion"'
        f' testname="{esc(name)}" enabled="true">\n'
        f'  <stringProp name="JSON_PATH">{esc(json_path)}</stringProp>\n'
        f'  <stringProp name="EXPECTED_VALUE">{esc(expected if expected is not None else "")}</stringProp>\n'
        f'  <boolProp name="JSONVALIDATION">{esc(validate)}</boolProp>\n'
        '  <boolProp name="EXPECT_NULL">false</boolProp>\n'
        '  <boolProp name="INVERT">false</boolProp>\n'
        f'  <boolProp name="ISREGEX">{esc(is_regex)}</boolProp>\n'
        "</JSONPathAssertion>"
    )


def constant_timer(delay_ms: int, name: str = "思考时间") -> Node:
    """固定定时器。

    JMeter 的定时器在其作用域内的 sampler 执行【之前】生效,
    所以挂在某个 step 下 = 执行该 step 前先等待 delay_ms。
    """
    return Node(
        '<ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer"'
        f' testname="{esc(name)}" enabled="true">\n'
        f'  <stringProp name="ConstantTimer.delay">{int(delay_ms)}</stringProp>\n'
        "</ConstantTimer>"
    )
