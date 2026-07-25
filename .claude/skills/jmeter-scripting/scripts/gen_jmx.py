#!/usr/bin/env python3
"""scenario.yaml + api-catalog.json → testplan.jmx + testplan.smoke.jmx

这一层完全不知道 Swagger 的存在,只认识 JMeter 和 scenario 契约。

两份产物由【同一棵元件树】生成,只改线程数和 Throughput 百分比。
必须同源,否则冒烟验证的不是要交付的那个东西。

用法:
    python3 gen_jmx.py -s scenario.yaml -c api-catalog.json -c curl-catalog.json -o out/
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse

from jmx_elements import (
    EXTRACT_FAILED, TEST_TYPE_EQUALS, TEST_TYPE_SUBSTRING, Node, constant_timer,
    csv_data_set, header_manager, http_defaults, http_sampler, json_assertion,
    json_extractor, once_only_controller, render_document, response_assertion,
    test_plan, thread_group, throughput_controller,
)

VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class ScenarioError(Exception):
    """场景定义有问题。所有错误一次性收集后抛出,不让用户挤牙膏式修。"""


# --------------------------------------------------------------------------
# 载入与合并
# --------------------------------------------------------------------------

def load_scenario(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if path.endswith((".yaml", ".yml")):
        try:
            import yaml
        except ImportError:
            raise SystemExit(
                "解析 .yaml 需要 PyYAML:\n"
                "  pip install pyyaml\n"
                "或把 scenario 改写成等价的 .json(本工具同样支持)"
            )
        return yaml.safe_load(text)
    return json.loads(text)


def merge_catalogs(catalogs: list) -> dict:
    """合并多份 catalog。curl 条目永远覆盖 swagger 条目,与传参顺序无关。"""
    apis, base_hint = {}, ""
    for cat in catalogs:
        base_hint = base_hint or cat.get("base_url_hint", "")
        for key, entry in (cat.get("apis") or {}).items():
            existing = apis.get(key)
            if existing and existing.get("origin", "").startswith("curl") \
                    and not entry.get("origin", "").startswith("curl"):
                continue
            apis[key] = entry
    return {"base_url_hint": base_hint, "apis": reconcile(apis)}


def _segments_match(a: str, b: str) -> bool:
    sa, sb = a.strip("/").split("/"), b.strip("/").split("/")
    if len(sa) != len(sb):
        return False
    return all(x == y or x.startswith("{") or y.startswith("{") for x, y in zip(sa, sb))


def reconcile(apis: dict) -> dict:
    """把 curl 抓到的真实数据,合并进对应的 swagger 模板化条目。

    curl 给的是 `/products/123`,swagger 给的是 `/products/{id}`——两者
    key 不同,不做这一步的话 scenario 里引用模板路径就拿不到 curl 的
    真实 header 和 body。这里按路径段做模式匹配,把 curl 的事实数据
    覆盖进 swagger 条目,并顺带把具体值提取成 path_var 示例。
    """
    curl_keys = [k for k, v in apis.items() if v.get("origin", "").startswith("curl")]
    for ck in curl_keys:
        centry = apis[ck]
        targets = [
            k for k, v in apis.items()
            if k != ck and not v.get("origin", "").startswith("curl")
            and v["method"] == centry["method"] and _segments_match(v["path"], centry["path"])
        ]
        if len(targets) != 1:
            continue  # 无对应模板 或 多个候选歧义 → 保留 curl 条目独立存在
        target = apis[targets[0]]

        examples = {}
        for tseg, cseg in zip(target["path"].strip("/").split("/"),
                              centry["path"].strip("/").split("/")):
            if tseg.startswith("{") and tseg.endswith("}"):
                examples[tseg[1:-1]] = cseg

        target["headers"] = {**target.get("headers", {}), **centry.get("headers", {})}
        target["query"] = {**target.get("query", {}), **centry.get("query", {})}
        if centry.get("body") is not None or centry.get("body_raw"):
            target["body"] = centry.get("body")
            target["body_raw"] = centry.get("body_raw")
        if centry.get("content_type"):
            target["content_type"] = centry["content_type"]
        target["path_var_examples"] = examples
        target["origin"] = "curl+swagger"
        del apis[ck]
    return apis


def resolve_api(apis: dict, key: str):
    """先精确匹配,再按路径段模式匹配。歧义时报错而不是猜。"""
    if key in apis:
        return apis[key]
    method, _, path = key.partition(" ")
    matches = [
        v for v in apis.values()
        if v["method"] == method.upper().strip() and _segments_match(v["path"], path.strip())
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ScenarioError(f'api "{key}" 匹配到多个接口,请写完整路径消除歧义')
    return None


# --------------------------------------------------------------------------
# 校验:所有问题在生成期暴露,而不是压测跑起来才发现
# --------------------------------------------------------------------------

def collect_vars(obj) -> set:
    """递归收集结构里所有 ${var} 引用。忽略 ${__fn(...)} 这类 JMeter 内置函数。"""
    found = set()
    if isinstance(obj, str):
        found |= {m for m in VAR_RE.findall(obj) if not m.startswith("__")}
    elif isinstance(obj, dict):
        for k, v in obj.items():
            found |= collect_vars(k) | collect_vars(v)
    elif isinstance(obj, (list, tuple)):
        for item in obj:
            found |= collect_vars(item)
    return found


def validate(scenario: dict, apis: dict) -> list:
    errors = []

    if not scenario.get("base_url"):
        errors.append("缺少 base_url。Swagger 里的 host 通常是文档服务器地址,不能直接用。")

    flows = {f["name"]: f for f in scenario.get("flows") or []}
    csv_vars = set((scenario.get("data") or {}).get("vars") or [])
    tgs = scenario.get("thread_groups") or []
    if not tgs:
        errors.append("缺少 thread_groups。")

    for tg in tgs:
        tg_name = tg.get("name", "<未命名>")
        login_vars = set()

        login = tg.get("login")
        if login:
            if not resolve_api(apis, login.get("api", "")):
                errors.append(f'[{tg_name}] login 的 api "{login.get("api")}" 在 catalog 中不存在')
            login_vars = set((login.get("extract") or {}).keys())
            undefined = collect_vars(login.get("body")) | collect_vars(login.get("query"))
            for var in sorted(undefined - csv_vars):
                errors.append(f'[{tg_name}] login 引用了未定义的变量 ${{{var}}}(CSV 列里没有)')
            for var in sorted(collect_vars(tg.get("auth_header")) - login_vars):
                errors.append(f'[{tg_name}] auth_header 引用的 ${{{var}}} 不来自 login.extract')

        mix = tg.get("mix") or []
        if not mix:
            errors.append(f"[{tg_name}] 缺少 mix,至少要有一个 flow")
        total = sum(float(m.get("weight", 0)) for m in mix)
        if mix and abs(total - 100.0) > 0.01:
            errors.append(f"[{tg_name}] mix 权重合计为 {total},必须等于 100")

        for entry in mix:
            fname = entry.get("flow")
            if fname not in flows:
                errors.append(f'[{tg_name}] mix 引用了不存在的 flow "{fname}"')
                continue

            # flow 必须自给自足:混合比例下 flow 之间没有执行顺序保证,
            # 跨 flow 引用变量在运行期不会报错,只会把字面量发出去。
            available = set(csv_vars) | login_vars
            for idx, step in enumerate(flows[fname].get("steps") or [], 1):
                api_key = step.get("api", "")
                api = None
                try:
                    api = resolve_api(apis, api_key)
                except ScenarioError as exc:
                    errors.append(f"[{fname} 第{idx}步] {exc}")
                if api is None:
                    errors.append(f'[{fname} 第{idx}步] api "{api_key}" 在 catalog 中不存在')
                else:
                    missing = [
                        p for p in api.get("path_params") or []
                        if p not in (step.get("path_vars") or {})
                    ]
                    if missing:
                        errors.append(
                            f'[{fname} 第{idx}步] 路径参数未提供: {", ".join(missing)}'
                            f'(需在 path_vars 中给出)'
                        )

                used = (collect_vars(step.get("body")) | collect_vars(step.get("query"))
                        | collect_vars(step.get("path_vars")) | collect_vars(step.get("headers")))
                for var in sorted(used - available):
                    errors.append(
                        f'[{fname} 第{idx}步] 引用了 ${{{var}}},但它不来自 CSV、'
                        f"login.extract 或本 flow 更早的步骤——混合流量下 flow 之间没有执行顺序保证"
                    )
                available |= set((step.get("extract") or {}).keys())

    data = scenario.get("data")
    if data and data.get("file") and not os.path.exists(data["file"]):
        errors.append(f'CSV 文件不存在: {data["file"]}(JMeter 运行时找不到会导致所有线程立即失败)')

    return errors


# --------------------------------------------------------------------------
# 断言策略
# --------------------------------------------------------------------------

def default_assertions(step: dict, api: dict) -> list:
    """步骤未显式声明 assert 时,自动加什么断言。

    这里只放了一条普适安全的规则:HTTP 状态码必须是 2xx。

    ┌─ TODO(交给你写) ─────────────────────────────────────────────────┐
    │ 业务码断言策略。国内后端普遍是 HTTP 200 + body 里带业务码:      │
    │   {"code":"0"}  /  {"code":200}  /  {"success":true}            │
    │ 不断言业务码的后果:一个返回 {"code":"500001","msg":"库存不足"} │
    │ 的 HTTP 200 会被计为成功——压测报告显示 0% 错误率,实际业务全败。│
    │                                                                  │
    │ 但也别无脑全加:每个 JSON Assertion 都要解析响应体,500 并发下   │
    │ 压测机自己的 CPU 可能先被断言吃满,测出来的 p95 混着压测机开销。│
    │                                                                  │
    │ 在下面追加你们团队的约定,例如:                                  │
    │   nodes.append(json_assertion("业务码", "$.code", "0"))          │
    └──────────────────────────────────────────────────────────────────┘
    """
    nodes = [response_assertion("HTTP 2xx", ["^2\\d\\d$"], "Assertion.response_code")]
    return nodes


def build_assertions(step: dict, api: dict) -> list:
    spec = step.get("assert")
    if not spec:
        return default_assertions(step, api)

    nodes = []
    if "status" in spec:
        codes = spec["status"] if isinstance(spec["status"], list) else [spec["status"]]
        nodes.append(response_assertion(
            "状态码", [str(c) for c in codes], "Assertion.response_code", TEST_TYPE_EQUALS))
    if "jsonpath" in spec:
        expected = spec.get("equals")
        nodes.append(json_assertion(
            f'{spec["jsonpath"]} == {expected}' if expected is not None else spec["jsonpath"],
            spec["jsonpath"], None if expected is None else str(expected)))
    if "contains" in spec:
        nodes.append(response_assertion(
            "响应包含", [str(spec["contains"])], "Assertion.response_data", TEST_TYPE_SUBSTRING))
    return nodes or default_assertions(step, api)


# --------------------------------------------------------------------------
# 元件树构建
# --------------------------------------------------------------------------

def split_base_url(base_url: str):
    parts = urllib.parse.urlsplit(base_url)
    protocol = parts.scheme or "http"
    domain = parts.hostname or ""
    port = str(parts.port) if parts.port else ""
    base_path = (parts.path or "").rstrip("/")
    return protocol, domain, port, base_path


def resolve_path(api: dict, step: dict, base_path: str) -> str:
    path = api["path"]
    for name, value in (step.get("path_vars") or {}).items():
        path = path.replace("{" + name + "}", str(value))
    return base_path + path


def build_step(step: dict, api: dict, base_path: str, defaults: dict) -> Node:
    """一个业务步骤 → HTTP Sampler + 提取器 + 断言 + 定时器。"""
    path = resolve_path(api, step, base_path)
    name = step.get("name") or f'{api["method"]} {api["path"]}'

    query = {**(api.get("query") or {}), **(step.get("query") or {})}
    if "body" in step:
        body = step["body"]
    elif api.get("body_raw"):
        body = api["body_raw"]
    else:
        body = api.get("body")
    if body is not None and query and api["method"].upper() in ("POST", "PUT", "PATCH"):
        # body 与 query 同时存在时,query 拼进 URL,body 走 raw
        path = f"{path}?{urllib.parse.urlencode(query)}"
        query = {}

    node = http_sampler(name, api["method"], path, query, body)

    step_headers = {**(step.get("headers") or {})}
    if step_headers:
        node.add(header_manager(step_headers, f"{name} 专属请求头"))

    for var, json_path in (step.get("extract") or {}).items():
        node.add(json_extractor(var, json_path))

    node.extend(build_assertions(step, api))

    think = step.get("think_time", defaults.get("think_time", 0))
    if think:
        node.add(constant_timer(int(think)))
    return node


def build_login(login: dict, apis: dict, base_path: str) -> Node:
    api = resolve_api(apis, login["api"])
    ctrl = once_only_controller("登录(每个虚拟用户一次)")
    sampler = build_step({**login, "think_time": 0, "name": login.get("name", "登录")},
                         api, base_path, {})
    ctrl.add(sampler)
    return ctrl


def build_thread_group(tg: dict, index: int, scenario: dict, apis: dict, smoke: bool) -> Node:
    name = tg.get("name", f"线程组{index}")
    load = tg.get("load") or {}
    prefix = f"tg{index}"
    node = thread_group(
        name,
        threads=f'${{__P({prefix}.threads,{load.get("threads", 1)})}}',
        ramp_up=f'${{__P({prefix}.rampup,{load.get("ramp_up", 1)})}}',
        hold=f'${{__P({prefix}.hold,{load.get("hold", 60)})}}',
        smoke=smoke,
    )

    protocol, domain, port, base_path = split_base_url(scenario["base_url"])
    node.add(http_defaults(protocol, domain, port,
                           scenario.get("connect_timeout", 10000),
                           scenario.get("response_timeout", 60000)))

    defaults = scenario.get("defaults") or {}
    if defaults.get("headers"):
        node.add(header_manager(defaults["headers"], "公共请求头"))

    data = scenario.get("data")
    if data:
        node.add(csv_data_set(data["file"], data["vars"], data.get("recycle", True)))

    if tg.get("login"):
        node.add(build_login(tg["login"], apis, base_path))

    flows = {f["name"]: f for f in scenario.get("flows") or []}
    for entry in tg.get("mix") or []:
        flow = flows[entry["flow"]]
        weight = 100.0 if smoke else float(entry["weight"])
        ctrl = throughput_controller(f'{entry["flow"]} {entry["weight"]}%', weight)
        # 鉴权头挂在控制器层而非线程组层:登录请求本身不该带上还没提取出来的 token
        if tg.get("auth_header"):
            ctrl.add(header_manager(tg["auth_header"], "鉴权头"))
        for step in flow.get("steps") or []:
            api = resolve_api(apis, step["api"])
            ctrl.add(build_step(step, api, base_path, defaults))
        node.add(ctrl)

    return node


def build_tree(scenario: dict, apis: dict, smoke: bool) -> Node:
    plan_name = scenario.get("name", "压测计划")
    suffix = " [冒烟]" if smoke else ""
    plan = test_plan(
        plan_name + suffix,
        "由 jmeter-scripting skill 生成,请勿直接手改——改 scenario.yaml 后重新生成。",
    )
    for i, tg in enumerate(scenario.get("thread_groups") or [], 1):
        plan.add(build_thread_group(tg, i, scenario, apis, smoke))
    return plan


def count_steps(scenario: dict) -> int:
    """冒烟时应该被执行到的 sampler 总数,用于步骤全覆盖判定。"""
    flows = {f["name"]: f for f in scenario.get("flows") or []}
    total = 0
    for tg in scenario.get("thread_groups") or []:
        if tg.get("login"):
            total += 1
        for entry in tg.get("mix") or []:
            total += len(flows.get(entry["flow"], {}).get("steps") or [])
    return total


def main() -> int:
    ap = argparse.ArgumentParser(description="scenario + api-catalog → .jmx")
    ap.add_argument("-s", "--scenario", required=True)
    ap.add_argument("-c", "--catalog", action="append", required=True,
                    help="可重复传入;curl 条目总是覆盖 swagger 条目")
    ap.add_argument("-o", "--outdir", default=".")
    args = ap.parse_args()

    scenario = load_scenario(args.scenario)
    catalogs = [json.load(open(p, encoding="utf-8")) for p in args.catalog]
    merged = merge_catalogs(catalogs)
    apis = merged["apis"]

    try:
        errors = validate(scenario, apis)
    except ScenarioError as exc:
        errors = [str(exc)]

    if errors:
        print(f"\n场景校验未通过,共 {len(errors)} 个问题:\n", file=sys.stderr)
        for err in errors:
            print(f"  ✗ {err}", file=sys.stderr)
        print("\n这些问题如果不在这里拦下,会变成压测跑起来后满屏 400/401。", file=sys.stderr)
        return 1

    os.makedirs(args.outdir, exist_ok=True)
    main_path = os.path.join(args.outdir, "testplan.jmx")
    smoke_path = os.path.join(args.outdir, "testplan.smoke.jmx")

    with open(main_path, "w", encoding="utf-8") as fh:
        fh.write(render_document(build_tree(scenario, apis, smoke=False)))
    with open(smoke_path, "w", encoding="utf-8") as fh:
        fh.write(render_document(build_tree(scenario, apis, smoke=True)))

    meta = {"expected_samplers": count_steps(scenario), "extract_failed_token": EXTRACT_FAILED}
    with open(os.path.join(args.outdir, "smoke-expect.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    print(f"已生成 {main_path}")
    print(f"已生成 {smoke_path}(1 线程 1 循环,所有 Throughput 强制 100%)")
    print("\n下一步 —— 先冒烟自验:")
    print(f"  bash {os.path.dirname(os.path.abspath(__file__))}/smoke.sh {args.outdir}")
    print("\n冒烟通过后跑正式压测:")
    overrides = " ".join(
        f'-J tg{i}.threads={ (tg.get("load") or {}).get("threads", 1) }'
        for i, tg in enumerate(scenario.get("thread_groups") or [], 1)
    )
    print(f"  jmeter -n -t {main_path} -l result.jtl -e -o report/ {overrides}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
