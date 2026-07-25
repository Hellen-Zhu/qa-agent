#!/usr/bin/env python3
"""Swagger 2.0 / OpenAPI 3.x → api-catalog.json

这一层完全不知道 JMeter 的存在。它的唯一职责是把两种规范的差异
吸收掉,向下游输出统一结构的接口清单。

用法:
    python3 parse_swagger.py http://host/v2/api-docs -o api-catalog.json
    python3 parse_swagger.py ./swagger.json -o api-catalog.json
    python3 parse_swagger.py ./swagger.json --filter '/orders' -o api-catalog.json
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request

MAX_DEPTH = 6
HTTP_METHODS = ("get", "post", "put", "delete", "patch", "head", "options")


def load_source(src: str) -> dict:
    """从 URL 或本地文件读取规范文档。"""
    if src.startswith(("http://", "https://")):
        req = urllib.request.Request(src, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    else:
        with open(src, encoding="utf-8") as fh:
            raw = fh.read()

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        try:
            import yaml
        except ImportError:
            raise SystemExit(
                f"{src} 不是合法 JSON,按 YAML 解析需要 PyYAML:\n  pip install pyyaml"
            )
        return yaml.safe_load(raw)


def resolve_ref(spec: dict, ref: str):
    """解析 $ref。

    Springfox 生成的定义名里含泛型符号 «»(U+00AB/BB),在 $ref 中常被
    百分号编码成 %C2%AB。不 unquote 的话这些引用一律解析失败,
    body 示例会全空——这是 Swagger 2.0 在 Java 项目里最常见的坑。
    """
    if not ref.startswith("#/"):
        return None
    node = spec
    for part in ref[2:].split("/"):
        part = urllib.parse.unquote(part).replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def schema_example(schema, spec: dict, seen: frozenset = frozenset(), depth: int = 0):
    """由 schema 推导一个示例值。

    seen 记录已展开的 $ref,防止自引用模型(Tree.children: [Tree])把递归打爆。
    """
    if schema is None or depth > MAX_DEPTH:
        return None
    if not isinstance(schema, dict):
        return None

    if "$ref" in schema:
        ref = schema["$ref"]
        if ref in seen:
            return {}
        target = resolve_ref(spec, ref)
        return schema_example(target, spec, seen | {ref}, depth + 1)

    # 组合类型:取第一个分支即可,压测不需要覆盖所有变体
    for key in ("allOf", "oneOf", "anyOf"):
        if key in schema and isinstance(schema[key], list) and schema[key]:
            if key == "allOf":
                merged = {}
                for sub in schema[key]:
                    part = schema_example(sub, spec, seen, depth + 1)
                    if isinstance(part, dict):
                        merged.update(part)
                return merged
            return schema_example(schema[key][0], spec, seen, depth + 1)

    if "example" in schema:
        return schema["example"]
    if "default" in schema:
        return schema["default"]
    if "enum" in schema and schema["enum"]:
        return schema["enum"][0]

    stype = schema.get("type")
    if stype == "object" or "properties" in schema:
        props = schema.get("properties") or {}
        return {
            name: schema_example(sub, spec, seen, depth + 1)
            for name, sub in props.items()
        }
    if stype == "array":
        item = schema_example(schema.get("items"), spec, seen, depth + 1)
        return [item] if item is not None else []
    if stype == "integer":
        return 0
    if stype == "number":
        return 0.0
    if stype == "boolean":
        return False
    if stype == "string":
        fmt = schema.get("format")
        if fmt in ("date-time",):
            return "2026-01-01T00:00:00Z"
        if fmt == "date":
            return "2026-01-01"
        return ""
    return None


def base_url_from_spec(spec: dict) -> str:
    """Swagger 2.0 用 schemes+host+basePath 三个字段;OpenAPI 3.x 用 servers[]。"""
    if "servers" in spec and spec["servers"]:
        return str(spec["servers"][0].get("url", "")).rstrip("/")
    scheme = (spec.get("schemes") or ["http"])[0]
    host = spec.get("host", "")
    base = spec.get("basePath", "") or ""
    if not host:
        return base.rstrip("/")
    return f"{scheme}://{host}{base}".rstrip("/")


def parse_operation_v2(op: dict, spec: dict) -> dict:
    """Swagger 2.0:参数全在 parameters[],body 是其中 in=body 的那一项。"""
    path_params, query, headers, body = [], {}, {}, None
    form = {}

    for p in op.get("parameters") or []:
        if "$ref" in p:
            p = resolve_ref(spec, p["$ref"]) or {}
        loc, name = p.get("in"), p.get("name")
        if not name:
            continue
        if loc == "path":
            path_params.append(name)
        elif loc == "query":
            query[name] = p.get("x-example", p.get("default", schema_example(p, spec)))
        elif loc == "header":
            headers[name] = p.get("x-example", p.get("default", ""))
        elif loc == "body":
            body = schema_example(p.get("schema"), spec)
        elif loc == "formData":
            form[name] = p.get("default", schema_example(p, spec))

    consumes = op.get("consumes") or spec.get("consumes") or []
    content_type = consumes[0] if consumes else ("application/json" if body is not None else "")
    if form and body is None:
        body = form
        content_type = content_type or "application/x-www-form-urlencoded"

    return {"path_params": path_params, "query": query, "headers": headers,
            "body": body, "content_type": content_type}


def parse_operation_v3(op: dict, spec: dict) -> dict:
    """OpenAPI 3.x:body 独立成 requestBody.content[媒体类型].schema。"""
    path_params, query, headers = [], {}, {}

    for p in op.get("parameters") or []:
        if "$ref" in p:
            p = resolve_ref(spec, p["$ref"]) or {}
        loc, name = p.get("in"), p.get("name")
        if not name:
            continue
        if loc == "path":
            path_params.append(name)
        elif loc == "query":
            query[name] = p.get("example", schema_example(p.get("schema"), spec))
        elif loc == "header":
            headers[name] = p.get("example", "")

    body, content_type = None, ""
    rb = op.get("requestBody")
    if rb:
        if "$ref" in rb:
            rb = resolve_ref(spec, rb["$ref"]) or {}
        content = rb.get("content") or {}
        for ct in ("application/json", *content.keys()):
            if ct in content:
                content_type = ct
                media = content[ct]
                body = media.get("example") or schema_example(media.get("schema"), spec)
                break

    return {"path_params": path_params, "query": query, "headers": headers,
            "body": body, "content_type": content_type}


def build_catalog(spec: dict, path_filter: str | None = None) -> dict:
    is_v3 = str(spec.get("openapi", "")).startswith("3")
    parse_op = parse_operation_v3 if is_v3 else parse_operation_v2

    apis = {}
    for path, item in (spec.get("paths") or {}).items():
        if path_filter and path_filter not in path:
            continue
        if not isinstance(item, dict):
            continue
        shared = [p for p in (item.get("parameters") or [])]
        for method, op in item.items():
            if method.lower() not in HTTP_METHODS or not isinstance(op, dict):
                continue
            merged = dict(op)
            merged["parameters"] = shared + list(op.get("parameters") or [])
            parsed = parse_op(merged, spec)
            key = f"{method.upper()} {path}"
            apis[key] = {
                "method": method.upper(),
                "path": path,
                "summary": op.get("summary") or op.get("operationId") or "",
                "origin": "swagger",
                **parsed,
            }

    return {
        "version": 1,
        "spec_version": spec.get("openapi") or spec.get("swagger") or "unknown",
        "base_url_hint": base_url_from_spec(spec),
        "apis": apis,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Swagger/OpenAPI → api-catalog.json")
    ap.add_argument("source", help="Swagger 文档 URL 或本地文件路径")
    ap.add_argument("-o", "--output", default="api-catalog.json")
    ap.add_argument("--filter", help="只保留 path 含该子串的接口")
    args = ap.parse_args()

    spec = load_source(args.source)
    catalog = build_catalog(spec, args.filter)

    if not catalog["apis"]:
        print("未解析出任何接口。检查文档格式或 --filter 条件。", file=sys.stderr)
        return 1

    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, indent=2)

    print(f"规范版本 : {catalog['spec_version']}")
    print(f"base_url : {catalog['base_url_hint'] or '(文档未声明)'}")
    print(f"接口数   : {len(catalog['apis'])}  →  {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
