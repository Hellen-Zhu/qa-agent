#!/usr/bin/env python3
"""curl 命令 → api-catalog.json

Swagger 是文档,可能过期、可能不准(Springfox 生成的 body schema 经常是
空的或泛型乱码);一条能跑通的 curl 是事实——真实的 header、真实的 body、
真实存在的参数值。

所以合并时 curl 永远覆盖 swagger,这条规则在 gen_jmx.py 里强制执行,
与命令行参数顺序无关。

用法:
    python3 parse_curl.py curls.txt -o curl-catalog.json
    pbpaste | python3 parse_curl.py - -o curl-catalog.json
"""
from __future__ import annotations

import argparse
import json
import shlex
import sys
import urllib.parse

# 不影响请求语义的 curl 开关,直接丢弃
FLAGS_IGNORED = {
    "--compressed", "-k", "--insecure", "-s", "--silent", "-i", "--include",
    "-v", "--verbose", "-L", "--location", "-g", "--globoff", "--http1.1",
    "--http2", "-f", "--fail", "-#", "--progress-bar",
}
# 带一个参数、但对压测无意义的开关
FLAGS_WITH_ARG_IGNORED = {
    "-o", "--output", "--connect-timeout", "-m", "--max-time",
    "--retry", "--cacert", "--cert", "--key", "-w", "--write-out",
}
BODY_FLAGS = {"-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"}


def split_commands(text: str) -> list[str]:
    """把一段文本切成多条独立的 curl 命令。"""
    text = text.replace("\\\n", " ").replace("^\n", " ")
    commands, current = [], []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("curl") and current:
            commands.append(" ".join(current))
            current = [stripped]
        else:
            current.append(stripped)
    if current:
        commands.append(" ".join(current))
    return commands


def parse_one(command: str) -> dict | None:
    """解析单条 curl,返回 catalog 条目(不含 key)。"""
    tokens = shlex.split(command)
    if tokens and tokens[0] == "curl":
        tokens = tokens[1:]

    method, url, headers, body_parts, forms = None, None, {}, [], {}
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in FLAGS_IGNORED:
            i += 1
        elif tok in FLAGS_WITH_ARG_IGNORED:
            i += 2
        elif tok in ("-X", "--request"):
            method = tokens[i + 1].upper()
            i += 2
        elif tok in ("-H", "--header"):
            name, _, value = tokens[i + 1].partition(":")
            headers[name.strip()] = value.strip()
            i += 2
        elif tok in BODY_FLAGS:
            body_parts.append(tokens[i + 1])
            i += 2
        elif tok in ("-F", "--form"):
            name, _, value = tokens[i + 1].partition("=")
            forms[name] = value
            i += 2
        elif tok in ("-b", "--cookie"):
            headers["Cookie"] = tokens[i + 1]
            i += 2
        elif tok in ("-A", "--user-agent"):
            headers["User-Agent"] = tokens[i + 1]
            i += 2
        elif tok in ("-u", "--user"):
            import base64
            token = base64.b64encode(tokens[i + 1].encode()).decode()
            headers["Authorization"] = f"Basic {token}"
            i += 2
        elif tok == "--url":
            url = tokens[i + 1]
            i += 2
        elif tok.startswith("-"):
            # 未知开关:保守跳过它和可能的参数
            i += 2 if (i + 1 < len(tokens) and not tokens[i + 1].startswith("-")) else 1
        else:
            url = url or tok
            i += 1

    if not url:
        return None

    parsed = urllib.parse.urlsplit(url)
    query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
    path = parsed.path or "/"

    body_raw = "&".join(body_parts) if body_parts else None
    if forms and not body_raw:
        body_raw = urllib.parse.urlencode(forms)
        headers.setdefault("Content-Type", "application/x-www-form-urlencoded")

    # curl 的既定行为:带 -d 而未显式 -X 时方法是 POST
    if not method:
        method = "POST" if body_raw else "GET"

    content_type = next(
        (v for k, v in headers.items() if k.lower() == "content-type"), ""
    )

    body = None
    if body_raw:
        try:
            body = json.loads(body_raw)
        except (json.JSONDecodeError, TypeError):
            body = None  # 非 JSON body 走 body_raw 原样透传

    base_url = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme else ""

    return {
        "method": method,
        "path": path,
        "summary": "",
        "origin": "curl",
        "path_params": [],
        "query": query,
        "headers": headers,
        "body": body,
        "body_raw": body_raw,
        "content_type": content_type,
        "_base_url": base_url,
    }


def build_catalog(text: str) -> dict:
    apis, base_hint = {}, ""
    for command in split_commands(text):
        entry = parse_one(command)
        if not entry:
            continue
        base_hint = base_hint or entry.pop("_base_url", "")
        entry.pop("_base_url", None)
        apis[f"{entry['method']} {entry['path']}"] = entry
    return {"version": 1, "spec_version": "curl", "base_url_hint": base_hint, "apis": apis}


def main() -> int:
    ap = argparse.ArgumentParser(description="curl 命令 → api-catalog.json")
    ap.add_argument("source", help="含 curl 命令的文件,或 - 表示 stdin")
    ap.add_argument("-o", "--output", default="curl-catalog.json")
    args = ap.parse_args()

    text = sys.stdin.read() if args.source == "-" else open(args.source, encoding="utf-8").read()
    catalog = build_catalog(text)

    if not catalog["apis"]:
        print("未解析出任何 curl 命令。", file=sys.stderr)
        return 1

    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, indent=2)

    print(f"base_url : {catalog['base_url_hint'] or '(未识别)'}")
    print(f"接口数   : {len(catalog['apis'])}  →  {args.output}")
    for key in catalog["apis"]:
        print(f"  {key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
