# Trade Performance Test Suite (JMeter)

以 **create-trade** 为样板搭起来的性能测试工程。一条业务链路（前端 E2E）+ 一个单接口容量测试，
其余 32 个 API 按同样的模式往里加。

**两本实操手册**（本 README 只讲结构与约束）：

| 手册 | 回答 | 什么时候看 |
|---|---|---|
| [`PRACTICE.zh.md`](PRACTICE.zh.md) | **练手** —— 6 个练习在新目录重建一遍,含 12 个"故意犯错" | 第一次接手这套框架 |
| [`HANDBOOK-BUILD.zh.md`](HANDBOOK-BUILD.zh.md) | **怎么建** —— JMeter GUI 逐元件实操 | 从零搭工程 / 加新 API |
| [`HANDBOOK.zh.md`](HANDBOOK.zh.md) | **怎么跑** —— 分阶段执行,从采集真实 curl 到跑出容量拐点 | 工程已就绪,要出数据 |

设计依据：
- [`../docs/trade-api-perf-test-plan-v2-jmeter.md`](../docs/trade-api-perf-test-plan-v2-jmeter.md) —— 33 个 API 的总体方案
- [`../docs/trade-create-perf-testcases-jmeter.md`](../docs/trade-create-perf-testcases-jmeter.md) —— create 的 15 个用例与实操细节

---

## 快速开始

```bash
./scripts/run.sh s01-create-trade-e2e dev smoke     # E2E 链路，1 线程 1 轮
./scripts/run.sh p02-trade-create     dev smoke     # 单接口，1 线程 1 轮
./scripts/run.sh p02-trade-create     perf load     # 单接口，峰值负载 30 分钟

./scripts/run.sh s03-checker-approve-e2e  dev  smoke              # checker 链路
./scripts/run.sh p03-checker-bulk-approve perf load -JcheckerBatchSize=20
./scripts/run.sh p04-checker-bulk-reject  perf load -JcheckerBatchSize=20

./scripts/run.sh s02-blotter-browse-e2e   dev  smoke              # blotter 浏览
./scripts/run.sh s04-lifecycle-event-e2e  dev  smoke              # 生命周期事件
./scripts/run.sh p05-trades-list  perf load -JblotterPageSize=200 # S-09/S-10 被测对象
./scripts/run.sh p06-trigger-event perf load
```

⚠ checker 场景需要环境里**已有待审批任务**。先跑一轮 `s01-create-trade-e2e` 造数
（每笔 create 产生一个 checker task），否则 setUp 会报 `CHECKER TASK POOL TOO SMALL`。

`run.sh` 不带参数会列出所有可用的 plan / env / profile。

---

## 目录结构

```
trade-performance/
├── api-registry.csv     ← API 清单的单一事实源（哪些 API、实现在哪、谁维护）
├── jmx/
│   ├── fragments/       ← 不可运行（Test Fragment，无 Thread Group）
│   │   ├── setup/       ← 供 setUp Thread Group 引用（组合，只 Include）
│   │   └── steps/
│   │       ├── <svc>/<module>/   ← 原子 fragment：一个 API 一个文件
│   │       │   ├── refdata/                    portfolios-list · counterparties-list
│   │       │   └── workers/
│   │       │       ├── trade-management/       create-trade · trade-detail · trade-risk-metrics
│   │       │       │                           trades-list · trigger-event · calculate-risk
│   │       │       │                           calc-partial-novation-risk · calc-risk-for-new
│   │       │       └── checker-flow/           pending-tasks · approve-task · reject-task
│   │       │                                   bulk-approve · bulk-reject
│   │       └── _composites/      ← 组合 fragment：只 Include 原子，自己不定义 sampler
│   ├── journeys/        ← 不可运行（按**业务流程**组织，天然横跨多个 svc）
│   ├── scenarios/       ← 可运行（薄壳：Thread Group + Include）
│   ├── api/             ← 可运行（单接口基线）
│   ├── suites/          ← 可运行（多 Thread Group 混合负载，本次未建）
│   └── ops/             ← 可运行（灌数、清理，本次未建）
├── groovy/              ← 脚本外置，绝不内联进 jmx
├── config/              ← 维度二：环境（5 个 svc 各自寻址）
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

收益：`s01-create-trade-e2e`、`p02-trade-create` 与 setUp 前置校验引用的是**同一个**
`fragments/steps/workers/trade-management/create-trade.jmx`。接口改了只动一处，三边同时生效。

### 两套分类法，不要合并成一棵树

5 svc × N module × M api 规模下最容易犯的错，是想用一个目录树同时表达"系统架构"和"业务流程"：

| 目录 | 组织方式 | 理由 |
|---|---|---|
| `fragments/steps/<svc>/<module>/` | **按系统架构** | 镜像 5 个服务的模块划分，对应代码归属与 CODEOWNERS |
| `fragments/steps/_composites/` · `journeys/` | **按业务流程** | 一条 journey 天然横跨 refdata + workers + uc，放进任何一个 svc 目录都是错的 |

强行合并的结果就是有人开始复制 fragment。

### 原子 vs 组合：职责边界

| 层 | 内容 | 举例 |
|---|---|---|
| **原子** | 一个 API 的**请求契约** + 该 API 固有的响应契约 | `refdata/portfolios-list.jmx` |
| **组合** | 只 Include 原子，加事务边界与**调用方特有**的处理 | `_composites/refdata-load.jmx` |

关键在于**同一个 API 的不同用法不复制 fragment，而是由调用方挂不同的 PostProcessor**：

```
GET /refdata/portfolios  ← 只定义一次
   ├── setUp 前置：挂 refdata-pool-portfolios.groovy    → 取全部建全局池
   └── journey：  挂 refdata-pick-portfolio.groovy      → 随机挑一条当入参
```

⚠ 这类 PostProcessor 必须包在 Simple Controller 里与 Include 同级。直接挂在 Transaction
Controller 下会按 JMeter 作用域规则作用到该 TX 内**全部** sampler——于是 pick-portfolio 会去
解析 counterparties 的响应，静默出错。

### 事务命名即寻址

```
TX_<svc>_<module>_<api>    原子事务，与 NFR 的 PERF-xx 一一对应
TX_flow_<name>             组合事务，横跨多个原子
```

收益：JMeter 报告按 label 聚合，`TX_workers_.*` 就能过滤出 workers 服务的全部事务，
**不需要额外埋点就能回答"哪个服务慢"**。

⚠ **统计口径**：`TX_flow_*` 包含其内部的 `TX_<svc>_*`。算 TPS 时二选一，不可相加。

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
├── Include portfolios-list      → 提取全部 id（与主链路同一份 fragment）
├── Include counterparties-list  → 提取全部 fmId + name（成对）
├── refdata-pool-*.groovy        → 写进全局 props（跨线程组唯一途径）
├── Include create-trade         → 真实建一笔，验证数据"业务上可用"
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

`fragments/steps/refdata/{portfolios,counterparties}-list.jmx` 的调用方脚本
（`groovy/refdata-pool-*.groovy` 与 `groovy/refdata-pick-*.groovy`）里假设了：

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

不需要 Java/JMeter。除结构性检查（XML 合法性、Thread Group 归属、Include 路径、
Groovy/CSV 存在性与列数、TBC 占位值——自由文本列如 `notes` 除外）外，还强制**五条"每个 API 只维护一份"的规则**：

| 规则 | 内容 | 拦住什么 |
|---|---|---|
| **R1** | HTTPSampler 只允许在 `fragments/` 下定义 | 有人图省事直接在 scenario 里塞 sampler。把"能定义 API 的地方"收缩到一处，查重才只需查一处 |
| **R2** | 同一 `method + 规范化 path` 不得在两个 fragment 中重复 | 复制粘贴出第二份契约。path 里的 `${...}` 会归一为 `{}` 再比对，换个变量名也躲不掉 |
| **R3** | `steps/<svc>/` 下的 fragment 必须用 `${__P(<svc>.host)}` | 放错服务目录；以及 sampler 漏写 domain 后**静默继承**全局默认值、打到别的服务上 |
| **R4** | 每个 fragment 必须被某个可运行 plan 间接引用 | 改名后 fragment 成孤儿，改它对结果毫无影响而报告依然全绿 |
| **R5** | `api-registry.csv` 与磁盘一致 | 登记的实现不存在 / 一个 fragment 被两个 API 登记 / 新增 fragment 忘记登记 |

在 5 svc × N module × M api 的规模上，"每个 API 只维护一份"靠约定守不住——
本工程在只有 4 个 fragment 时就已经出现过 3 个端点各存在两份。所以它必须是校验规则。

**这不能替代真实运行。** 它验证不了 JSONPath 是否匹配、断言是否成立、服务端是否接受请求。

---

## 结果分析

`run.sh` 通过 `sample_variables` 把这些字段写进 jtl 的额外列：

```
runPhase, caseId, tradeId, taskId, datFile, productType, costTier, fixings, datSize,
errClass, riskOk, riskFailCode, portfolioId, effectiveUserId
```

**`runPhase` 必须先用来过滤。** setUp 前置校验 Include 的是与主链路**同一份** create
fragment，所以它产生的样本事务名完全相同。不按 `runPhase=main` 过滤，preflight 的那一笔
create 会混进容量统计——量小的时候尤其致命：0.1 TPS 的场景里多一笔就是百分之几的偏差。

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
| refdata 两个查询串行 | 已知偏差 | 真实前端并发拉取，串行会让 `TX_flow_refdata_load` 偏慢。装 bzm Parallel Controller 后改 `_composites/refdata-load.jmx` 一处即可 |
| `stress` 用普通 Thread Group | 已知偏差 | 阶梯加压需要 bzm Concurrency Thread Group；当前 `steps`/`holdPerStep` 两个属性是预留的，尚未生效 |
| WebSocket | 不在 scope | create 会触发 WebSocket 推送，当前完全未覆盖 |
| `suites/`、`ops/` | 空目录 | 混合负载与降级场景、灌数与清理脚本尚未建 |
| 其余 18 个 API | 未建 | 见 `api-registry.csv` 的 `status=todo` 行 |
| blotter **自动刷新**负载 | 未建 | `s02` 只模拟用户主动打开页面（0.14 TPS）。真正的大头是自动刷新（4.13 TPS 恒定），需要独立常驻线程组，见 `suites/` |
| `trigger-event` / risk 接口的 payload | **推断值** | 集中在 `build-trigger-event-payload.groovy` 与 `build-risk-payload.groovy` 两处 |
| checker 接口的 payload 形状 | **推断值** | 只有 create 有真实 curl。approve/reject/bulk-* 的 body 是推断的，集中在 `groovy/checker-claim-{task,batch}.groovy` 两处，确认后只改那里 |
| 批量接口的部分失败 | 依赖服务端返回逐项结果 | 若不返回 `successCount`，`bulkOutcome` 会标 `unverifiable` —— 批量接口的有效 TPS 在原理上就无法准确统计 |
| 5 个 svc 的真实 host | 占位值 | `config/*.properties` 里 5 组 `<svc>.host` 全指向同一个占位地址，待运维提供 |

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

以 `POST /checker/tasks/{taskId}/approve` 为例：

1. **先在 `api-registry.csv` 登记一行**（apiId / svc / module / method / path / mode / owner）。
   registry 是清单的单一事实源，先登记才知道这个 API 是否已经有人实现过。
2. 判断形态：
   - **专用 fragment** —— multipart 上传 / 复杂 payload / 响应要关联给后续步骤 / 定制断言
   - **数据驱动行** —— 只是 GET + 参数 + 状态码断言，则 mode 填 `datadriven`，不建 jmx
3. 专用 fragment 建在 `jmx/fragments/steps/workers/checker-flow/approve.jmx`：
   - 一个 sampler，事务名 `TX_workers_checkerflow_approve`
   - domain 必须写 `${__P(workers.host,localhost)}`（R3 会检查目录与前缀一致）
   - 顶部写清 fragment 契约（输入变量、输出变量、产出事务）
   - **只放该 API 固有的响应处理**；调用方特有的处理挂在 Include 外层
4. 把 registry 那行的 `impl` 填成这个路径（R5 会检查存在且唯一）
5. 需要它的 journey / composite 里加 Include Controller（R4 要求至少被引用一次）
6. 要单独测容量，复制 `jmx/api/p02-trade-create.jmx` 改两处：testname、Include 的路径
7. 有新数据需求就加 CSV，**不要**把数据写进 jmx
8. `python3 scripts/validate.py` —— 上面每一步漏做都会在这里红

**不要**为了"结构整齐"给只被一个 journey 用到的步骤建组合 fragment。
JMeter 过度拆分的代价（路径解析、GUI 跳转、调试困难）通常大于收益——
组合层只有被 **2 个以上** journey 使用时才值得抽出来。原子层不受此限：
一个 API 一个文件是 R2 的前提。

**不要**为了"结构整齐"给只被一个 journey 用到的步骤建 fragment。
JMeter 过度拆分的代价（路径解析、GUI 跳转、调试困难）通常大于收益——
只有被 **2 个以上** journey 使用的步骤才值得抽出来。
