# Trade Performance Test Suite (JMeter)

以 **create-trade** 为样板搭起来的性能测试工程。一条业务链路（前端 E2E）+ 一个单接口容量测试，
其余 32 个 API 按同样的模式往里加。

设计依据：
- [`../docs/trade-api-perf-test-plan-v2-jmeter.md`](../docs/trade-api-perf-test-plan-v2-jmeter.md) —— 33 个 API 的总体方案
- [`../docs/trade-create-perf-testcases-jmeter.md`](../docs/trade-create-perf-testcases-jmeter.md) —— create 的 15 个用例与实操细节

---

## 快速开始

```bash
./scripts/run.sh s01-create-trade-e2e dev smoke     # E2E 链路，1 线程 1 轮
./scripts/run.sh p02-trade-create     dev smoke     # 单接口，1 线程 1 轮
./scripts/run.sh p02-trade-create     perf load     # 单接口，峰值负载 30 分钟
```

`run.sh` 不带参数会列出所有可用的 plan / env / profile。

---

## 目录结构

```
trade-performance/
├── jmx/
│   ├── fragments/       ← 不可运行（Test Fragment，无 Thread Group）
│   │   ├── setup/       ← 供 setUp Thread Group 引用
│   │   └── steps/       ← 原子步骤，被多个 journey 复用
│   ├── journeys/        ← 不可运行（Test Fragment，无 Thread Group）
│   ├── scenarios/       ← 可运行（薄壳：Thread Group + Include）
│   ├── api/             ← 可运行（单接口基线）
│   ├── suites/          ← 可运行（多 Thread Group 混合负载，本次未建）
│   └── ops/             ← 可运行（灌数、清理，本次未建）
├── groovy/              ← 脚本外置，绝不内联进 jmx
├── config/              ← 维度二：环境
├── profiles/            ← 维度三：负载模型
├── data/
├── scripts/run.sh       ← 唯一执行入口
└── results/  reports/
```

### 为什么分四层

**硬约束**：含 Thread Group 的 jmx 无法被 Include Controller 引用（JMeter 要求被引用文件用
Test Fragment）。这条约束**反向决定**了整个结构：

```
想复用 create-trade 这个步骤
  → 它必须能被 Include
    → 它的 jmx 就不能有 Thread Group
      → 它只能装在 Test Fragment 里
        → Thread Group 只能待在别的文件里
          → 那个文件就只剩一个壳
```

收益：`s01-create-trade-e2e` 和 `p02-trade-create` 引用的是**同一个**
`fragments/steps/create-trade.jmx`。接口改了只动一处，两边同时生效。

`journeys/` 里的文件技术上也是 Test Fragment，分目录分的是**复用层级**不是元件类型：
steps 被 journey 复用，journey 被 scenario 复用。真正的分界线在 `scenarios/`——那一层才有
Thread Group、才可运行。

### 三维正交

| 维度 | 载体 | 举例 |
|---|---|---|
| 场景 | `jmx/**.jmx` | 打哪条链路 |
| 环境 | `config/*.properties` | 打哪个环境、用哪个身份 |
| 负载 | `profiles/*.properties` | 多少线程、跑多久 |

线程数 / 时长 / ramp-up **一律不写进 jmx**，全部 `${__P()}`。
`-q` 可重复指定，后者覆盖前者：`config → profile → 命令行 -J`。

---

## 身份模型：无 login、无 token

所有 API 的权限由 **`X-User-Id`** 请求头决定。没有登录接口，没有 token 生命周期，
没有 401 重试——`fragments/setup/` 里因此**没有** `auth-login.jmx` 或 `token-refresh.jmx`。

但"用哪个用户"仍然是一个负载变量。若服务端按 maker 做过滤、计数或加锁，
20 个线程共用一个身份和分散到 20 个身份，压出来的数会显著不同。

| 属性 | 取值 | 用途 |
|---|---|---|
| `userMode` | `pool`（默认） | 从 `data/shared/accounts.csv` 轮换 |
| | `fixed` | 全部线程用 `fixedUserId`，测 per-user 竞争 |

身份解析在 `groovy/resolve-identity.groovy`，挂在 **Test Plan 层**。
挂在 create 上会导致同一次迭代里 refdata 查询和 create 用了不同身份——测了个不存在的场景。

---

## 参考数据：Counterparty / Portfolio

这两类数据由 **sync batch job 从第三方同步进我们的数据库**，属于**测试无法控制的外部状态**。
硬编码会过期，且失效时的表现是 **HTTP 200 + 业务全拒**——只看状态码的报告会显示"0 错误率"。

**解法：setUp Thread Group 解析一次 + 归档快照。**

```
setUp Thread Group (1 线程 1 轮，不计入测量)
├── GET /refdata/portfolios      → 提取全部 id
├── GET /refdata/counterparties  → 提取全部 fmId + name（成对）
├── build-refdata-pools.groovy   → 写进全局 props（跨线程组唯一途径）
├── POST /trades/create          → 真实建一笔，验证数据"业务上可用"
│   └── preflight-policy.groovy  → abort / prune / warn
└── archive-refdata-snapshot.groovy → results/<runId>/resolved-refdata.csv
```

那次真实 create 是关键：refdata 查询返回 200 只能证明"数据存在"，
只有真的建一笔才能证明"数据可用"——counterparty 被第三方停用时，GET 照样查得到，是 create 才会拒。

**走 API 不走 DB 直连**：DB 里存在 ≠ API 能用（权限过滤、软删除、状态机），
而 create 的校验与查询 API 同源。仅当需要 API 提供不了的批量筛选时才申请 JDBC 只读权限。

---

## 第一次跑之前必须做的三件事

这套工程是按真实 curl 和真实 response 写的，但有三处**我无法从 curl 推断**、必须实测确认：

### 1. 校正 refdata 的 JSONPath

`fragments/setup/refdata-preflight.jmx` 和 `fragments/steps/refdata-load.jmx` 里假设了：

```
$.data[*].id      ← portfolio
$.data[*].fmId    ← counterparty
$.data[*].name    ← counterparty
```

这是**照 create 响应的 `{code, status, msg, data}` 结构推断的**，未经验证。
先手动 `curl` 一次两个 refdata 接口，对着真实响应改这三行。

改错的表现：池为空 → `REFDATA POOL TOO SMALL` → preflight 按策略中止。不会静默错。

### 2. 确认 `X-User-Id` / `X-User-ID` 实际发出去几个

真实 curl 同时带了 `X-User-ID: anonymous` 和 `X-User-Id: maker@sc.com`。
按 RFC 7230 §3.2 header 名大小写不敏感，**两者是同一个 header**。
JMeter 底层用 HttpClient，可能把它们合并或后者覆盖前者——**我没有环境验证这一点**。

首次 smoke 后检查实际发出的请求头：

```bash
# 用 View Results Tree（GUI）看 Request → Request Headers
# 或命令行：
./scripts/run.sh p02-trade-create dev smoke -Jjmeter.save.saveservice.requestHeaders=true
```

若确认服务端只认 `X-User-Id`，把两个 jmx 里 Header Manager 的 `X-User-ID` 那行删掉。

### 3. 放入真实 .dat 文件

`data/dat/` 目前是空的（只有 README）。没有文件时 create 会因文件不存在直接失败。
至少放一个 `small/fx_trf_01.dat`，与 `data/create-trade/create-trade-data.csv` 的路径对应。

---

## 静态校验

```bash
python3 scripts/validate.py
```

不需要 Java/JMeter，检查：XML 合法性、fragment 里是否混入 Thread Group、
可运行 plan 是否真的有 Thread Group、Include 路径是否存在、Groovy/CSV 文件是否存在。

**这不能替代真实运行。** 它验证不了 JSONPath 是否匹配、断言是否成立、服务端是否接受请求。

---

## 结果分析

`run.sh` 通过 `sample_variables` 把这些字段写进 jtl 的额外列：

```
caseId, tradeId, taskId, datFile, productType, costTier, fixings, datSize,
errClass, riskOk, riskFailCode, portfolioId, effectiveUserId
```

`costTier` 与 `fixings` 是**成本维度**标签：`.dat` 体积与解析成本由 productType 的结构
（定盘次数、schedule 长度）决定，所以成本画像要按这两列切分，而不是按 `datSize`。
见 [Workload Modeling §4.7](../docs/performance/workload-modeling.zh.md)。

**`errClass` 是最重要的一列**，它把错误分成三类（`groovy/assert-create-response.groovy`）：

| errClass | 含义 | 该找谁 |
|---|---|---|
| `technical` | 连接失败 / 超时 / 5xx | 性能结论，找开发 |
| `business` | HTTP 200 但业务拒绝 | 多半是测试数据失效，修数据 |
| `script` | 提取器拿不到值 / 解析异常 | 脚本 bug，本轮结果作废 |

混在一个"错误率"里的报告没法用：12% 错误率到底该找开发还是该修数据？

---

## 已知偏差与未实现

| 项 | 状态 | 影响 |
|---|---|---|
| `preflightPolicy=prune` | **未实现**，回退为 abort | 见 `groovy/preflight-policy.groovy` 的 TODO —— 需要团队决策，不是纯技术问题 |
| refdata 两个查询串行 | 已知偏差 | 真实前端并发拉取，串行会让 `TX_RefData_Load` 偏慢。装 bzm Parallel Controller 后改 `refdata-load.jmx` 一处即可 |
| `stress` 用普通 Thread Group | 已知偏差 | 阶梯加压需要 bzm Concurrency Thread Group；当前 `steps`/`holdPerStep` 两个属性是预留的，尚未生效 |
| WebSocket | 不在 scope | create 会触发 WebSocket 推送，当前完全未覆盖 |
| `suites/`、`ops/` | 空目录 | 混合负载与降级场景、灌数与清理脚本尚未建 |
| 其余 32 个 API | 未建 | 按 `p02-trade-create` 的模式扩展 |

---

## 待确认事项

| # | 问题 | 影响 | 找谁 |
|---|---|---|---|
| 1 | `GET /refdata/{portfolios,counterparties}` 的真实响应结构、是否支持 `status` 过滤与分页 | setUp 的 JSONPath 与查询参数 | 开发 |
| 2 | 服务端如何处理重复的 `X-User-ID` / `X-User-Id` | Header Manager 是否要删一行 | 开发 |
| 3 | 支持哪些产品类型、各类型典型 .dat 大小、生产分布占比 | `data/dat/` 分档与混合场景权重 | 业务/开发 |
| 4 | `X-Dyn-Run` 的语义 | 是否影响执行路径与耗时 | 开发 |
| 5 | payload 是否接受额外字段（如 `externalReference`） | 能否给压测数据打标记，决定清理策略 | 开发 |
| 6 | TaskId 能否作为结构化字段返回，而非埋在 `msg` 文案里 | 当前只能正则捞，文案一改就断 | 开发（improvement） |
| 7 | create 的 SLA（P95 目标） | 通过标准现在是空的 | 业务 |
| 8 | 专用 PERF Portfolio / Counterparty 能否创建；counterparty 若纯由第三方 sync 而来，是否只能从既有 ACTIVE 集合中挑 | 数据准备方式 | 业务/开发 |
| 9 | refdata sync job 的调度频率、单次时长、写入模式（upsert vs truncate-reload）、是否与 API 共用 DB 实例 | PT-CREATE-015 可行性与压测排期 | 开发/运维 |
| 10 | 后端是否校验 `counterpartyName` 与 `counterpartyFmId` 的一致性 | 决定 name 是否必须与 fmId 同源 | 开发 |
| 11 | preflight 校验失败时的处置策略（abort / prune / warn） | `preflight-policy.groovy` 的 TODO | 测试团队决策 |
| 12 | 压测环境的协议、域名、端口 | `config/*.properties` 现在填的是占位值 | 运维 |

---

## 加一个新 API 要做什么

以 `GET /trades/{id}` 为例：

1. `jmx/fragments/steps/trade-detail.jmx` —— Test Fragment + Transaction Controller + Sampler，
   顶部写清 fragment 契约（输入变量、输出变量、产出事务）
2. 需要它的 journey 里加一个 Include Controller
3. 要单独测容量，复制 `jmx/api/p02-trade-create.jmx` 改两处：testname、Include 的路径
4. 有新数据需求就加 CSV，**不要**把数据写进 jmx

**不要**为了"结构整齐"给只被一个 journey 用到的步骤建 fragment。
JMeter 过度拆分的代价（路径解析、GUI 跳转、调试困难）通常大于收益——
只有被 **2 个以上** journey 使用的步骤才值得抽出来。
