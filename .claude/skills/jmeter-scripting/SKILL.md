---
name: jmeter-scripting
description: This skill should be used when the user asks to "generate a JMeter script", "write a .jmx", "基于 swagger 生成压测脚本", "把这些 curl 变成 JMeter 脚本", or needs a JMeter test plan built from API definitions with mixed-traffic scenarios, login correlation, and CSV parameterization.
---

# 基于 API 定义生成 JMeter 脚本

从 Swagger / curl 生成结构正确、关联可用、跑得通的 `.jmx`。

这个 skill 只做生成,不做压测方法论。它不判断你该压多少并发、阈值定多少——
那些由你给出,它负责把决定变成脚本。

**产物是 `.jmx`,GUI 能打开、CI 能无头跑。** 交付前必须通过 1VU 冒烟自验。

## 何时用

- 有 Swagger/OpenAPI 文档,要压其中若干接口组成的业务链路
- 手上有几条能跑通的 curl,想变成压测脚本
- 需要按比例混合的流量模型(70% 浏览 + 30% 下单)
- 需要 CSV 多账号 + 脚本内登录 + token 关联传递

## 六步工作流

```
① 取 API 定义  → api-catalog.json
② 场景澄清     → 补全 5 项必需信息(硬门禁,缺一项不许生成)
③ 写 scenario  → scenario.yaml,给用户 review
④ 生成         → testplan.jmx + testplan.smoke.jmx
⑤ 冒烟         → 1VU 跑一遍,四条判定
⑥ 交付         → 结构预览 + 正式压测命令
```

### ① 取 API 定义

```bash
# Swagger 2.0 / OpenAPI 3.x,URL 或文件都行
python3 scripts/parse_swagger.py http://host/v2/api-docs -o api-catalog.json
python3 scripts/parse_swagger.py ./swagger.json --filter /orders -o api-catalog.json

# curl(文件或 stdin)。浏览器 F12 → 右键 → Copy as cURL 就是合法输入
python3 scripts/parse_curl.py curls.txt -o curl-catalog.json
```

两者可同时使用,**curl 永远覆盖 Swagger**:Swagger 是文档,可能过期、可能不准;
curl 是事实,带着真实的 header、真实的 body、真实存在的参数值。

接口多时先 `--filter` 收窄,不要把几百个接口全塞进上下文。

### ② 场景澄清 —— 硬门禁

Swagger 里**没有的信息**恰恰决定脚本能不能用。这 5 项缺任何一项,**不要生成,先问**:

| 必需信息 | Swagger 为什么给不了 | 缺了会怎样 |
|---|---|---|
| 测试环境 `base_url` | 文档里的 `host` 通常是文档服务器地址 | 压到错误环境甚至生产 |
| 登录接口 + token 提取路径 | `securityDefinitions` 只说要个 Authorization 头,不说去哪拿 | 全部 401 |
| CSV 账号文件 | 规范里不存在测试数据的概念 | 单账号撞限流,压的是限流器 |
| 步骤顺序与数据流转 | Swagger 是接口的无序集合,没有业务链路概念 | 一堆孤立请求,不构成场景 |
| 并发 / ramp-up / 持续时间 | 纯业务决策 | 无法生成线程组 |

问的时候优先给选项,别开放式追问。`path_var_examples` 里有 curl 抓到的真实 ID,
可以直接拿来做默认值。

### ③ 写 scenario

字段契约见 `references/scenario-schema.md`,完整示例见 `examples/scenario.yaml`。
两层模型:

- **flow** = 有序步骤 + 数据关联,可复用,不含并发配置
- **thread_group** = 一组 flow 按权重混合 + 并发配置 + 共享登录

写完先给用户 review 再生成。scenario.yaml 是可 diff、可进 git 的资产,
压测脚本靠它从一次性产物变成可维护资产。

### ④ 生成

```bash
python3 scripts/gen_jmx.py -s scenario.yaml \
  -c api-catalog.json -c curl-catalog.json -o out/
```

校验不通过会一次性列出所有问题并拒绝生成。**不要绕过校验**——
这些问题不在这里拦下,就会变成压测跑起来后满屏 400/401。

看结构:`python3 scripts/dump_tree.py out/testplan.jmx`

### ⑤ 冒烟自验 —— 不可跳过

```bash
bash scripts/smoke.sh out/
```

1 线程 1 循环,所有 Throughput 控制器强制 100%(否则 70/30 下单次迭代只会命中一个 flow)。
四条判定:步骤全覆盖 / 全部 success / 无未解析变量 / 断言全通过。

**没跑过冒烟的脚本不算交付物。** 未通过时按 `references/troubleshooting.md` 定位。

### ⑥ 交付

给出:`.jmx` 路径、`scenario.yaml`、结构预览、正式压测命令(`gen_jmx.py` 会打印)。

## 硬约束

- **不加 Listener。** GUI Listener 在无头压测里是性能杀手,结果走 `-l result.jtl`。
- **不手改生成的 .jmx。** 改 `scenario.yaml` 重新生成。手改会在下次生成时丢失。
- **正式压测不要开 samplerData 保存**,那是冒烟专用;开着会让 .jtl 体积爆炸并拖慢压测机。
- **绝不压生产环境或第三方服务**,除非用户明确说明已获授权并完成协调。
- curl 里的 `Authorization`/`Cookie` 会被自动丢弃——抓包瞬间的凭据必然过期,
  留着会覆盖登录动态提取的 token。

## 参考资料

| 文件 | 内容 |
|---|---|
| `references/scenario-schema.md` | scenario 完整字段契约 |
| `references/jmeter-elements.md` | 元件选型与陷阱(Throughput Controller 不控吞吐量等) |
| `references/swagger-parsing.md` | Swagger 2.0 vs 3.x 差异、Springfox 泛型名坑 |
| `references/troubleshooting.md` | 冒烟失败逐条定位 |

## 依赖

- Python 3.8+;`scenario.yaml` 需要 `pip install pyyaml`(改用等价的 `.json` 可免)
- 冒烟步骤需要 `jmeter` 在 PATH 中

## 自测

```bash
python3 -m unittest discover -s tests
```
