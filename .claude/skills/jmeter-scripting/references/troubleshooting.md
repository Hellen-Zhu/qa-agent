# 冒烟失败定位

冒烟的四条判定各自对应一类问题。按 `check_smoke.py` 输出的提示对号入座。

## 「步骤数不符:期望 N,实际 M」

- **实际 < 期望**:某个 flow 没被走到。检查冒烟脚本里 Throughput Controller 是否
  真的都是 `100.0`(`python3 scripts/dump_tree.py out/testplan.smoke.jmx` 看一眼)。
- **实际 > 期望**:控制器嵌套层级不对,某段被执行了多次。
- **实际 = 0**:JMeter 根本没跑起来,看 `out/smoke-jmeter.log`。最常见是
  CSV 路径不对——路径相对于 **JMeter 的运行目录**,不是 scenario.yaml 所在目录。

## 「关联提取失败:请求里出现了 `__EXTRACT_FAILED__`」

上游步骤的 JSONPath 在响应里没匹配到。排查顺序:

1. 该上游步骤本身是否成功?失败的请求提取不出东西——先修它。
2. JSONPath 写错了。用真实响应验证:
   ```bash
   curl -s <上游接口> | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=False, indent=2))"
   ```
   常见错误:漏了外层包装(`$.data.list[0].id` 写成 `$.list[0].id`)。
3. 响应是空列表。测试环境没数据 → 先造数据,或换一个有数据的查询条件。

## 「变量未解析,字面量被直接发出:`${xxx}`」

该变量既不在 CSV 列里,也不来自上游 extract。理论上 `gen_jmx.py` 的校验会提前拦下,
冒烟还能看到它通常意味着:

- 变量写在了校验覆盖不到的地方(比如 `defaults.headers` 里)
- 拼写不一致(`${productid}` vs `${productId}`,JMeter 变量名区分大小写)

## 「请求失败 rc=401」

- **登录步骤自己 401**:CSV 里的账号密码不对,或登录接口的 body 结构不对。
  看 `check_smoke.py` 打出的响应体。
- **登录成功但后续 401**:
  - `auth_header` 的格式不对。注意 `Bearer ` 后面有个空格。
  - token 提取到了但值不对——把 `$.data.accessToken` 与真实响应核对。
  - 服务端要的不是 `Authorization` 而是自定义头(如 `X-Token`)。

## 「请求失败 rc=400」

- 必填字段缺失或类型不对。Swagger 推导的 body 是**空壳**(字符串给 `""`,
  整数给 `0`),服务端多半不收。**用 curl 抓一条真实请求补进来**是最快的解法。
- 路径参数用了不存在的 ID。`path_var_examples` 里有 curl 抓到的真实值。

## 「请求失败 rc=404」

- `base_url` 的 basePath 漏了或多了。用 `dump_tree.py` 看 sampler 的实际路径。
- curl 与 Swagger 合并时路径没对齐——检查 catalog 里该接口的 `origin`,
  若是 `curl` 而非 `curl+swagger`,说明没匹配上,scenario 里要用 curl 的完整路径引用。

## 「断言失败:业务码」

HTTP 200 但业务码非成功值。这**不是脚本 bug,是真实的业务失败**,
说明请求参数在业务上不成立(库存不足、账号无权限、数据不存在)。

先在测试环境把这条链路手工走通,再压。

## 「jmeter 命令找不到」

```bash
brew install jmeter                    # macOS
# Linux: 下载 https://jmeter.apache.org/download_jmeter.cgi,把 bin/ 加进 PATH
```

冒烟不能跳过。跳过就等于交付一个从没跑过的脚本。

## 「.jmx GUI 打开后元件挂错位置」

结构问题,应该由 `tests/test_gen_jmx.py::test_hashtree_invariant` 拦下。
如果真的发生了,说明生成器有 bug——跑一遍测试:

```bash
python3 -m unittest discover -s tests
```

不要手改 .jmx 绕过去,手改会在下次生成时丢失。
