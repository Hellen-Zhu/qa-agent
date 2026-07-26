#!/usr/bin/env python3
"""生成器测试。从 skill 根目录运行:

    python3 -m unittest discover -s tests -v

核心是 test_hashtree_invariant:JMeter 要求每个元件后面紧跟一个 hashTree。
违反这条规则时 JMeter 打开文件【不会报错】,只是把后续元件挂到错误的父节点上,
然后静默地跑出错误结果。这一个测试能抓住绝大多数结构性错误。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
sys.path.insert(0, SCRIPTS)

from gen_jmx import build_tree, merge_catalogs, resolve_api, validate  # noqa: E402
from jmx_elements import render_document  # noqa: E402


def build_catalogs(tmpdir: str) -> dict:
    swagger_out = os.path.join(tmpdir, "swagger.json")
    curl_out = os.path.join(tmpdir, "curl.json")
    subprocess.run(
        [sys.executable, os.path.join(SCRIPTS, "parse_swagger.py"),
         os.path.join(FIXTURES, "swagger-v2.json"), "-o", swagger_out],
        check=True, capture_output=True,
    )
    subprocess.run(
        [sys.executable, os.path.join(SCRIPTS, "parse_curl.py"),
         os.path.join(FIXTURES, "curls.txt"), "-o", curl_out],
        check=True, capture_output=True,
    )
    catalogs = []
    for path in (swagger_out, curl_out):
        with open(path, encoding="utf-8") as fh:
            catalogs.append(json.load(fh))
    return merge_catalogs(catalogs)["apis"]


class GeneratorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp()
        cls.apis = build_catalogs(cls.tmpdir)
        with open(os.path.join(FIXTURES, "scenario.json"), encoding="utf-8") as fh:
            cls.scenario = json.load(fh)
        os.chdir(ROOT)  # scenario 里的 CSV 路径相对于 skill 根目录
        cls.main_xml = render_document(build_tree(cls.scenario, cls.apis, smoke=False))
        cls.smoke_xml = render_document(build_tree(cls.scenario, cls.apis, smoke=True))

    # ── 结构不变量 ────────────────────────────────────────────────────

    def _assert_alternating(self, xml_text: str, label: str):
        root = ET.fromstring(xml_text)
        for hash_tree in root.iter("hashTree"):
            children = list(hash_tree)
            for i, child in enumerate(children):
                if i % 2 == 0:
                    self.assertNotEqual(
                        child.tag, "hashTree",
                        f"[{label}] 位置 {i} 应是元件,却是 hashTree——元件缺失或多了一层")
                else:
                    self.assertEqual(
                        child.tag, "hashTree",
                        f"[{label}] 元件 <{children[i - 1].tag}> 后面没有紧跟 hashTree,"
                        "后续元件会被挂到错误的父节点")
            self.assertEqual(len(children) % 2, 0,
                             f"[{label}] 子节点数为奇数,最后一个元件缺 hashTree")

    def test_hashtree_invariant(self):
        """每个元件后必须紧跟一个 hashTree —— 这条规则由 render() 的递归结构保证。"""
        self._assert_alternating(self.main_xml, "正式")
        self._assert_alternating(self.smoke_xml, "冒烟")

    def test_xml_is_wellformed(self):
        for label, xml_text in (("正式", self.main_xml), ("冒烟", self.smoke_xml)):
            with self.subTest(label):
                root = ET.fromstring(xml_text)
                self.assertEqual(root.tag, "jmeterTestPlan")

    # ── 流量模型 ──────────────────────────────────────────────────────

    def test_throughput_weights(self):
        root = ET.fromstring(self.main_xml)
        percents = [
            c.findtext('stringProp[@name="ThroughputController.percentThroughput"]')
            for c in root.iter("ThroughputController")
        ]
        self.assertEqual(sorted(percents), ["30.0", "70.0"])

    def test_smoke_forces_full_coverage(self):
        """冒烟必须把所有 Throughput 百分比拉到 100,否则 70/30 下单次迭代只会命中一个 flow。"""
        root = ET.fromstring(self.smoke_xml)
        percents = [
            c.findtext('stringProp[@name="ThroughputController.percentThroughput"]')
            for c in root.iter("ThroughputController")
        ]
        self.assertEqual(percents, ["100.0", "100.0"])

    def test_smoke_is_single_iteration(self):
        root = ET.fromstring(self.smoke_xml)
        tg = next(root.iter("ThreadGroup"))
        self.assertEqual(tg.findtext('stringProp[@name="ThreadGroup.num_threads"]'), "1")
        self.assertEqual(tg.findtext('boolProp[@name="ThreadGroup.scheduler"]'), "false")
        loop = tg.find('elementProp[@name="ThreadGroup.main_controller"]')
        self.assertEqual(loop.findtext('stringProp[@name="LoopController.loops"]'), "1")

    def test_main_uses_property_overrides(self):
        """线程数走 __P(),让同一份 jmx 能被 CI 用不同参数复用。"""
        root = ET.fromstring(self.main_xml)
        tg = next(root.iter("ThreadGroup"))
        self.assertEqual(
            tg.findtext('stringProp[@name="ThreadGroup.num_threads"]'),
            "${__P(tg1.threads,500)}")

    # ── 鉴权与关联 ────────────────────────────────────────────────────

    def test_login_in_once_only_controller(self):
        root = ET.fromstring(self.main_xml)
        once = list(root.iter("OnceOnlyController"))
        self.assertEqual(len(once), 1, "登录必须且只能在一个 Once Only Controller 里")

    def test_auth_header_not_visible_to_login(self):
        """鉴权头必须挂在 Throughput Controller 层。

        挂到线程组层的话,登录请求自己也会带上一个还没提取出来的 ${token},
        字面量被发出去,而且会污染冒烟的变量泄漏检查。
        """
        root = ET.fromstring(self.main_xml)
        auth_managers = [
            hm for hm in root.iter("HeaderManager") if hm.get("testname") == "鉴权头"
        ]
        self.assertEqual(len(auth_managers), 2, "两个 flow 各自需要一份鉴权头")

        # 定位线程组的 hashTree:它是 ThreadGroup 元件的下一个兄弟节点。
        # 鉴权头若出现在这一层,就会作用于整个线程组(含登录)。
        for parent in root.iter():
            children = list(parent)
            for i, child in enumerate(children):
                if child.tag != "ThreadGroup":
                    continue
                tg_scope = children[i + 1]
                top_level = [
                    c.get("testname") for c in tg_scope if c.tag == "HeaderManager"
                ]
                self.assertNotIn(
                    "鉴权头", top_level,
                    "鉴权头挂在了线程组层——登录请求会带上还没提取出来的 ${token}")
                self.assertIn("公共请求头", top_level, "公共请求头本就该在线程组层")

    def test_extractor_uses_detectable_sentinel(self):
        """提取失败时写入可检测的哨兵,而不是留空让 ${var} 字面量漏出去。"""
        root = ET.fromstring(self.main_xml)
        extractors = list(root.iter("JSONPostProcessor"))
        self.assertTrue(extractors)
        for ex in extractors:
            self.assertEqual(
                ex.findtext('stringProp[@name="JSONPostProcessor.defaultValues"]'),
                "__EXTRACT_FAILED__")

    def test_curl_body_overrides_swagger(self):
        """curl 抓到的真实 body 必须覆盖 swagger 的空壳 schema。"""
        orders = resolve_api(self.apis, "POST /orders")
        self.assertEqual(orders["origin"], "curl+swagger")
        self.assertIn("channel", orders["body"], "swagger 里没有的真实字段应来自 curl")

    def test_curl_path_var_example_captured(self):
        detail = resolve_api(self.apis, "GET /products/{id}")
        self.assertEqual(detail["path_var_examples"]["id"], "SKU-8871")

    def test_volatile_auth_header_stripped(self):
        """curl 里的过期 token 必须被丢弃,否则会覆盖动态提取的 ${token}。"""
        detail = resolve_api(self.apis, "GET /products/{id}")
        self.assertNotIn("Authorization", detail["headers"])
        self.assertIn("X-Tenant", detail["headers"], "非凭据请求头应保留")

    def test_xml_escaping(self):
        """用户数据里的 & < > 必须转义,否则产出非法 XML。"""
        scenario = json.loads(json.dumps(self.scenario))
        scenario["flows"][1]["steps"][1]["body"]["remark"] = 'a & b <tag> "q"'
        xml_text = render_document(build_tree(scenario, self.apis, smoke=False))
        ET.fromstring(xml_text)  # 解析不炸即通过
        self.assertIn("&amp;", xml_text)


class ValidationTest(unittest.TestCase):
    """负向测试:坏场景必须在生成期被拦下,而不是产出一个坏脚本。"""

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp()
        cls.apis = build_catalogs(cls.tmpdir)
        os.chdir(ROOT)

    def base_scenario(self) -> dict:
        with open(os.path.join(FIXTURES, "scenario.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def assertRejects(self, scenario: dict, keyword: str):
        errors = validate(scenario, self.apis)
        self.assertTrue(errors, "本应报错却通过了校验")
        self.assertTrue(
            any(keyword in e for e in errors),
            f"错误信息里应包含「{keyword}」,实际为: {errors}")

    def test_clean_scenario_passes(self):
        self.assertEqual(validate(self.base_scenario(), self.apis), [])

    def test_weights_must_sum_to_100(self):
        s = self.base_scenario()
        s["thread_groups"][0]["mix"][0]["weight"] = 50
        self.assertRejects(s, "权重合计")

    def test_unknown_api_rejected(self):
        s = self.base_scenario()
        s["flows"][0]["steps"][0]["api"] = "GET /nope"
        self.assertRejects(s, "catalog 中不存在")

    def test_cross_flow_variable_rejected(self):
        """混合流量下 flow 之间没有执行顺序保证,跨 flow 引用变量必须拦下。"""
        s = self.base_scenario()
        s["flows"][1]["steps"][1]["body"]["productId"] = "${productId}"  # 属于「商品浏览」
        self.assertRejects(s, "没有执行顺序保证")

    def test_missing_path_var_rejected(self):
        s = self.base_scenario()
        del s["flows"][0]["steps"][1]["path_vars"]
        self.assertRejects(s, "路径参数未提供")

    def test_missing_base_url_rejected(self):
        s = self.base_scenario()
        del s["base_url"]
        self.assertRejects(s, "base_url")

    def test_missing_csv_file_rejected(self):
        s = self.base_scenario()
        s["data"]["file"] = "tests/fixtures/nope.csv"
        self.assertRejects(s, "CSV 文件不存在")

    def test_auth_header_var_must_come_from_login(self):
        s = self.base_scenario()
        s["thread_groups"][0]["auth_header"] = {"Authorization": "Bearer ${nosuch}"}
        self.assertRejects(s, "不来自 login.extract")


if __name__ == "__main__":
    unittest.main(verbosity=2)
