# k6 性能测试框架设计文档

- **日期**: 2026-07-31
- **状态**: P0 + P1a 已实现（PR #1）。2026-08-01 修订：**执行层收敛为本机 runner**（k8s Job 路径、tag 批量筛选、Node 报告后处理整体移除，k8s 移入演进路径条件触发）；summary 改由 k6 handleSummary 直接写盘（§2、§9、§10、§13）。2026-08-02 P1b 需求评审修订：lifecycle 状态机（事件仅发生于 LIVE trade）、8 类事件清单、checker-task 独立审批 API、P1b/P1c 范围切分（§1、§5、§6、§10-§13）
- **被测系统**: 公司内部 FX Structured Products Trading System（trade 全生命周期管理）
- **技术栈**: k6 + 现有 Prometheus + 现有 Grafana + Kubernetes

## 1. 背景与目标

为交易系统的 HTTP API 服务端压测搭建一套工程化的性能测试框架（第一期），后续可演进为自助式 Web 平台（远期）。框架方法论沿用本仓库 `.claude/skills/performance-testing` 中已有的约定（测试类型、阈值优先、报告格式）。

**范围与优先级**：

| 优先级 | 内容 |
|---|---|
| P0 | `GET /trades` 查询、`POST /trades/create` booking 两个场景，跑通"触发 → 施压 → 指标入 Prometheus → Grafana 查看 → 出报告"全链路 |
| P1 | lifecycle：P1b trigger-event 单 API 事件场景 + seeding（PENDING 池）+ 基线对比；P1c checker-task 审批链客户端 + LIVE 池自动铺底 + E2E journey |
| P2 | 端到端混合场景（按流量配比）、WebSocket 支持、CI 集成 |
| 远期 | Web 平台化、分布式施压（迁移 k6-operator） |

**明确不做（第一期）**：Web UI、CI 流水线集成、自建 Prometheus/Grafana（复用项目现有监控栈）、分布式多节点施压。

## 2. 总体架构

```
开发者/QA ──run.sh──▶ 本机 k6 进程 ──HTTP──▶ Trading System 微服务
                          │                       │
                          │ Prometheus remote write │ 服务端指标（已有）
                          ▼                       ▼
                     现有 Prometheus ◀────────────┘
                          │
                          ▼
                     现有 Grafana ◀── 导入压测 Dashboard（JSON 进版本库）
```

- 一次压测 = 本机一个 k6 进程（`./run.sh`，Linux/macOS 直跑，Windows 用 Git Bash 跑同一份脚本；内部系统负载量级下单机足够）。除 k6 外零依赖。
- k6 客户端指标经内置 `experimental-prometheus-rw` 输出写入现有 Prometheus，与服务端指标同源，在 Grafana 中按时间轴对齐定位瓶颈。
- 执行层设计为可替换：施压机不足或需分布式时再引入 k8s Job / k6-operator（见 §12 演进路径），`src/` 脚本层零改动——2026-08-01 前曾实现 k8s Job 路径，因当前阶段用不到已整体移除（git 历史可找回）。

**外部依赖（唯一）**：现有 Prometheus 需开启 `--web.enable-remote-write-receiver`。若运维不允许，备选方案为 Pushgateway 中转（实现计划中先验证此依赖）。

## 3. 仓库结构

框架代码位于本仓库 `perf/` 目录：

```
perf/
├── config/
│   ├── environments/       # dev.json / uat.json：各微服务 baseUrl 映射、Prometheus RW 地址（不存在 prod 配置）
│   └── slas/               # API 级分位数 SLA，按 服务/模块/API 三级组织，集中管理
├── src/                    # 只存放会被 k6 引擎加载执行的 JavaScript 代码
│   ├── lib/                # 纯逻辑模块（config/users/data/rows/sla/report，Node 可加载）
│   │                       #   + k6 侧：http.js、errors.js（三分类引擎）、bootstrap.js（场景装配）
│   ├── api/                # API 客户端层，按 微服务/模块 分目录；<module>.js + <module>-data.js
│   │   └── trade-svc/
│   │       ├── trades.js           # createTrade / triggerEvent（P1b）（契约分类）
│   │       ├── trades-read.js      # queryTrades：读路径客户端，独立于 create 数据图（不 import trades-data.js）
│   │       └── trades-data.js      # 用例池实例化 + dat 预载
│   ├── setup/              # preflight（本地数据闸）
│   ├── scenarios/          # 单 API 场景入口（一次业务动作，SLA/容量结论的唯一来源）
│   ├── journeys/           # E2E 业务流入口（P1c：一个迭代串多 API，per-step 子指标）
│   └── mixed/              # 混合配比入口（P2：多 scenario 块并行按流量配比；届时再建目录）
├── profiles/               # 负载 profile（JSON 声明式，见 §4）
├── data/
│   ├── trade-svc/          # 每个 API 专属数据：<scenario>.json（一行=一个完整同源用例）
│   │   ├── trades-query.json    # { filters: [...] } 查询字段池
│   │   └── trades-create.json   # { productType, notionalCurrency, portfolioId, ... }（行内不写 dat 路径）
│   └── datfiles/           # dat 样本，同名约定：products/<productType>/<productType>.dat
├── seed/                   # 数据铺底脚本（P1b：PENDING 池；P1c：LIVE 池双身份流水线）
├── run.sh                  # 本机 runner（唯一执行入口，除 k6 外零依赖）
├── dashboards/             # Grafana dashboard JSON（见第 8 节）
├── baselines/              # 各场景性能基线（JSON）
├── results/                # 每次运行独立目录（整目录 gitignore；需长期保留的结果晋升为 baselines/ 基线）
└── docs/                   # 使用说明、环境准备 checklist
```

**src/ 的收纳规则**：`src/` 只放会被 k6 引擎加载执行的 JS 代码；`config/` 和 `data/` 是静态声明性资源，由代码通过 `open()` 读取。边界即"代码 vs 数据"——改参数池、调 SLA、换环境不需要碰任何逻辑代码，降低误改风险；镜像构建时数据层与代码层也可分层缓存。

**分层原则**：场景脚本中不出现 URL、请求头、阈值。业务动作编排在 `scenarios/`，接口细节在 `api/`，环境在 `config/`，负载形状在 `profiles/`。高频变更（换环境、换负载等级、加 API）各自只动一处。

**参数池格式**：统一用 JSON（k6 原生 `open()` + `JSON.parse` + `SharedArray`，零外部依赖）。k6 v0.53+ 虽有 `k6/experimental/csv` 模块，但仍属实验性；而 papaparse 等 jslib 需远程 import，在无外网的 k8s 集群内不可用。若源数据来自 Excel/CSV 导出，入库前转换为 JSON。

### 3.1 多微服务组织

系统含 5 个微服务，各服务下分模块，模块下多个 API。三级映射规则：

- **服务 → 目录**：`src/api/<service>/`，每个服务一个目录；
- **模块 → 文件**：`src/api/<service>/<module>.js`，模块内 API 是该文件导出的函数；
- **服务地址**：`config/environments/<env>.json` 中维护 `services` 映射（每个服务独立 host:port），api 层按服务名取 baseUrl，场景代码不感知地址。

所有指标统一附加 `service`、`module` 标签（与 `tags.name` 并列），Grafana 可按服务/模块下钻聚合。

### 3.2 API 优先级表达（catalog 治理已延后）

第一期不建 API catalog，优先级由场景文件头部注释标注（`P0`/`P1`/`P2`；2026-08-01 前曾以 `meta.tags` 导出配合 `--tags` 批量筛选，已随 k8s 执行层一并移除——场景数少时逐条运行即可，规模驱动再启用）。**定级标准**（满足任一升级为更高优先级）：

- **P0**：交易日高频路径、涉及资金/交易状态变更、生产监控 QPS 排名靠前；
- **P1**：常用查询与生命周期操作、有性能风险特征（复杂查询、大 payload）；
- **P2**：低频后台/管理类接口。

局限（接受）：tag 只能描述"已写的场景"，无法回答"系统还有哪些 API 没被覆盖"。当 API 规模增长到需要覆盖率治理时，再启用生成式 catalog 方案（清单由各服务 Swagger 自动同步、优先级人工定级、覆盖由场景元数据反向计算），设计已记录在第 12 节演进路径。

## 4. 负载模型（profiles）

> 2026-07-31 融合修订：形态由 JS 构建器改为 **JSON 声明式**，集合增补 baseline/ladder，阈值归属改为"profile 级 + API 级"叠加（机制取自内部 trade-performance 框架，评估记录见第 13 节）。

**形态**：`profiles/<name>.json`，其 `scenario` 块就是 k6 executor 配置原文（零翻译层，与 k6 文档 1:1 对照）；`_` 开头的键是注释，装配时剥除——每个 profile 的 rationale（形状为什么这样、样本量警告、模型局限）写在文件自身里，自描述。装配层（bootstrap）负责：读取 JSON、剥注释、应用 `RATE`/`DURATION`/`VUS`/`MAX_VUS` 命令行覆盖、施加 maxVUs 全局硬上限 500。

**集合**（七个，按方法论分工）：

| Profile | 回答的问题 | 模型/形状 |
|---|---|---|
| smoke | 脚本、数据、链路此刻通不通 | 低速 constant-arrival-rate，1 分钟 |
| baseline | 系统空闲时一笔要多久——**一切对比的分母**，并发目标的推导输入 | constant-vus，1 VU，注意样本量告警 |
| load | 预期流量下是否满足 SLA | ramping-arrival-rate 升-稳-降 |
| ladder | 容量拐点在哪（TPS 不再升、P95 陡升） | closed（ramping-vus 阶梯）；closed 模型会系统性低估过载后果，只用于找拐点 |
| stress | 拐点之后系统怎么塌 | open，阶梯倍增至劣化 |
| spike | 突发流量是否扛得住 | open，瞬间高位再回落 |
| soak | 长时间运行是否劣化（泄漏/资源耗尽） | open 中等负载 ≥2 小时 |

**阈值归属（两维叠加）**：
- **profile 级**（写在 profile JSON 的 `thresholds` 块）：业务成功率两级线与脚本零错误线——与被压的是哪个 API 无关，与"这轮想回答什么问题"有关（如 ladder 拐点之后的技术错误恰是要测的东西，刻意不熔断）；
- **API 级**（config/slas/，见第 7 节）：分位数延迟 SLA——装配时按场景所压 API 叠加进 thresholds。探索型 profile（ladder/stress/baseline）可在 profile JSON 顶层加 `"apiSla": false` 豁免这一层——拐点/崩塌形态或单用户基准下延迟分位数 SLA 无意义，仍强制校验 slaKey 存在（配错 key 快速失败，不因豁免被掩盖）；
- 速率档位应从生产真实流量推导（如生产 ~120 笔/天 → rate=1/s 已是生产峰值的数百倍），推导过程写进 profile 的 `_` 注释键，不拍脑袋。

## 5. 身份与 API 客户端层

- **身份模块（lib/users.js）**：系统无 token 认证，统一通过 `X-User-Id` 请求头传递身份（如 `maker@sc.com`）。身份池在 `config/` 中按角色维护（maker / checker 各若干），场景按业务动作选择角色——create/trigger-event 用 maker，审批走独立的 checker-task API（见 §6 状态机）用 checker；maker-checker 四眼原则下 LIVE 池自动铺底与 E2E journey（均 P1c）必须双角色协作。无 token 过期问题，soak 场景无需刷新逻辑。
- **HTTP 统一封装（lib/http.js）**：对 `k6/http` 的薄封装，对外只暴露三个动词——`get(service, path, opts)` / `postJson(service, path, body, opts)` / `postMultipart(service, path, formData, opts)`，三者收敛到同一个内部 `request()` 管道，集中处理：按服务名解析 baseUrl；注入默认请求头（`X-User-Id`、`Accept`）；强制要求规范化的 `tags.name` 并附加 `service`/`module` 标签（URL 中动态 trade ID 归一化进 tag，避免 Prometheus 指标基数爆炸）；统一记录自定义指标与通用断言。api 层因此保持一行一调用的薄结构，新增请求形态（如 put/delete）只在 http.js 加一个动词。
- **错误三分类引擎（lib/errors.js，2026-07-31 融合修订，取代原"双层断言"二值设计）**：本系统**业务失败也返回 HTTP 200**（业务状态在 body 的 code/status 字段），只看状态码的报告会显示"0% 错误"而实际一笔未成。所有响应经统一分类引擎归入三类，且必须分开呈现——混成一个错误率无法回答"12% 是开发问题还是数据问题"：
  - `technical`（连接失败/超时/5xx）→ 系统扛不住，**这才是性能结论**；
  - `business`（HTTP 200 但业务拒绝）→ 通常是测试数据失效，不是性能问题；
  - `script`（响应非 JSON/结构不符）→ 脚本缺陷，**本轮结果作废**。
  引擎为共享层（不认识任何具体 API），各 API 的业务契约（成功判据、拒绝归因模式表）经回调注入、定义在自己的 api 层文件里。配套机制：
  - **指标**：`perf_ok`/`perf_err_technical`/`perf_err_business`/`perf_err_script`（四计数器互斥、总和=请求数）、`perf_business_success`（Rate，verdict 与熔断都看它）、`perf_success_duration`（Trend，**只统计业务成功请求的耗时**——快速拒绝会拉低 P95 使容量虚高，分位数 SLA 必须以它为准）；
  - **reason 归因维度**：有界取值（模式表槽位 + 服务端 code 枚举 + HTTP 状态码），严禁把自由文本 msg 当 tag；
  - **限流现场日志**：每 VU 每 (errClass, reason) 组合只完整打印前 3 条，计数看指标、逐请求明细走结果文件——高并发大面积失败时日志 I/O 不反噬压力机。
  - create 的成功契约按 trade-performance 已校准版本采用：`code=200 + status='PENDING APPROVAL' + data.trade.id 匹配 TRD-\d+`（内网首跑仍需确认版本未变）。

## 6. 测试数据管理

> 2026-07-31 融合修订：**写路径改用"用例行"模型**（取自 trade-performance，评估见第 13 节），读路径保留字段池模型。分界标准：字段间存在业务有效性关联（portfolio 归属、counterparty 开户关系、dat 产品定义）→ 用例行；字段间无关联约束（查询过滤条件）→ 字段池。

- **写路径：用例行模型（`data/trade-svc/trades-create.json`）**——一行 = 一个完整可跑用例：`productType` + `notionalCurrency` + 三个归属字段（portfolioId/counterpartyFmId/counterpartyName）内嵌同一行。核心纪律：**整行必须同源采集自同一份真实 curl**（DevTools 复制真实建单请求）——静态供数没有 live 查询兜底，任何手工拼装都可能造出现实中不存在的组合（portfolio 属于 A 台、counterparty 未在 A 台开户），服务端业务拒绝在报告里呈现为"错误率升高"，看起来像性能问题实际是数据问题。配套机制：
  - 行号 `__row` 装载时自动注入并作为指标 tag——"哪行数据坏了"直接从指标切出；
  - 数据经 SharedArray 共享（全 VU 一份），**全局游标轮换**（`exec.scenario.iterationInTest % 行数`）——均匀覆盖且可复现，取代 hash 取数；
  - 数据文件可经 `CREATE_DATA_FILE` 覆盖切换**变体池**（如锁竞争对照实验：全部行填同一组归属值），不改脚本；
  - dat 按**同名约定**定位：`data/datfiles/products/<productType>/<productType>.dat`——行内只写 productType，无路径字符串可打错；只预加载数据文件实际引用的产品；productType 装载时过字符集闸（进路径的值必须先验）。同一产品需多个 dat 样本时再加可选 datFile 覆盖列（当前 YAGNI）；
  - 数据内容随环境失效（id 不跨环境），换环境重新采集同一文件；采集时间与来源记在行的 `note` 字段。
- **preflight（setup 阶段本地数据闸）**：开跑前逐行校验用例池——占位符（TBC/TODO/N/A 类模式，注意**不含** PERF 前缀——专用 PERF portfolio 是合法真值）、缺字段、空池即 `exec.test.abort`，并报出具体行号。**不发探针请求**（只验第一行是抽样冒充证明，且污染请求计数）；"数据今天是否仍有效"由两层机制回答：大轮次前同会话先跑 smoke + 长跑 profile 的业务成功率宽松熔断线。
- **读路径：字段池模型（`data/trade-svc/trades-query.json`）**：查询过滤条件组合（日期区间、状态、counterparty），字段间无有效性关联，池内自由轮换即可；覆盖多样条件防缓存热点造成虚假乐观结果。
- **唯一性与标记**：payload **不接受额外自定义字段**（trade-performance 已实测——原设计的 clientRef 注入字段作废），客户端唯一标识机制列入 P1b（当前 payload 不接受额外字段，无逐请求标识落盘）；压测数据识别与清理依赖"专用 PERF portfolio + 状态 + 时间窗"组合，专用 portfolio 的真实值在环境启用时确认。
- **lifecycle 事件数据（P1b/P1c，2026-08-02 需求评审定稿）**：
  - **状态机前置**：`create（maker）→ PENDING APPROVAL → checker 审批通过 → LIVE`，全部 trigger-event 事件只能发生在 **LIVE** trade 上。审批是独立的 checker-task API（`GET /api/v1/checker/tasks/pending`、`POST /api/v1/checker/tasks/{taskId}/approve` 与 `.../reject`），**以 taskId 而非 tradeId 寻址**——自动化审批须先查 pending 清单做 tradeId→taskId 映射（P1c）。
  - **事件清单（8 类，语义与终态性待内网确认，§11-9）**：cancellation、partial termination、early termination、portfolio reassignment、partial novation remaining、novation remaining、stepout full、stepout partial。疑似非终态（事件后 trade 仍 LIVE → 可重复压测候选，soak 可用单 API 形态）：partial termination、portfolio reassignment、partial novation；疑似终态（消耗 LIVE 池）：cancellation、early termination、stepout full。
  - **LIVE 池获取（P1b，approve 客户端未实现前）**：查询圈定——`GET /trades` 按 `status=LIVE` + **专用 PERF portfolio** 过滤生成事件目标清单；池量不足时经系统 Web 界面人工批量审批补池。P1c 实现 checker-task 客户端后 seed 全自动：create（maker）→ 查 pending 映射 taskId → approve（checker）→ 输出 LIVE 清单。
  - **安全红线**：事件是破坏性操作（cancellation/termination 会终结 trade），比 create 危险一级——事件目标清单的生成与 preflight **双重校验目标 trade 属于专用 PERF portfolio，绝不对非 PERF 数据触发事件**。
  - **seed 参数化与规模**：`SEED_TARGET=PENDING|LIVE` 决定推进深度（P1b 仅 PENDING，纯 create 批量）；消耗性事件的单 API 场景要求 `SEED_COUNT ≥ rate × duration + 余量`，profile 与 seed 规模联动关系写入使用文档。seed 也是 k6 脚本、从 run.sh 触发，但不走 profile 装配——铺底语义是"完成 N 笔"（iterations 型 executor），不是维持压力形状。
- **环境准备 checklist（docs/）**：压测环境 trade 表存量数据需接近生产量级；数据库、下游依赖容量核对项以文档 checklist 形式维护，不写入代码。

## 7. SLA、熔断与安全防护

- **SLA 集中管理（config/slas/）**：按 API 定义分位数阈值（p95/p99），场景装配时生成 k6 `thresholds` 并与 profile 级阈值叠加（见第 4 节），运行结束自动判 PASS/FAIL（进程退出码体现，为 P2 接 CI 门禁打基础）。**分位数阈值挂在 `perf_success_duration{name:<api>}` 上而非 http_req_duration**——失败请求（尤其快速拒绝）会拉低分位数使容量虚高，SLA 只对业务成功的请求有意义。SLA 具体数值待业务方/现有监控水位确认（见第 11 节遗留问题）。
- **两级熔断（2026-07-31 融合修订，取代单线设计）**：`perf_business_success` 上两条线各司其职——严格线（如 `rate>0.99`，无 abortOnFail）是**跑完后的 verdict**；宽松线（`rate>0.50` + `abortOnFail` + `delayAbortEval: '3m'`）是**熔断器**，只杀"整体性业务拒绝"的必死之局（数据失效，无论发生在启动时还是第 3 小时）。宽松是刻意的：低吞吐下零星合法瞬时失败不能中止长跑；delayAbortEval 先让样本量积起来。ladder 类探索型 profile 只挂熔断线不挂 verdict 线——拐点之后的技术错误恰是要测量的对象。**诚实说明**：`perf_business_success` 把技术性失败也计为失败（三分类中只有 `ok` 计入成功），因此宽松线在整体性技术崩塌（而非单纯数据失效）时同样会触发——对 ladder/stress 这类探索型 profile 而言，这条线的作用因此是"共享环境保护"（防止一次探索性压测把环境打死太久），而非验收意义上的 verdict。
- **环境白名单**：`config/environments/` 中不存在 prod 配置；框架启动时校验目标域名在白名单内，否则拒绝执行。
- **资源防护**：profile 内置 maxVUs 上限 + 装配层全局硬上限 500，防误配置打挂共享环境。

## 8. 可观测性与 Grafana

- k6 通过内置 `experimental-prometheus-rw` 输出指标至现有 Prometheus，Trend 指标配置 p95/p99 统计。**所有指标（含自定义业务指标）都会以 `k6_` 前缀写入**——remote write 不区分内置与自定义。
- **testid 约定**：每次运行生成唯一 `testid`（`<场景>_<环境>_<profile>_<UTC时间戳>`）作为全局标签，Grafana 按 testid 下拉筛选任意一次历史压测（官方 dashboard 自带 testid 变量，`run.sh` 生成的 testid 直接可用）。
- **dashboards/ 内容**（均为 JSON 进版本库）：
  1. **官方 k6 Prometheus dashboard（ID 19665，已在使用）**——展示 k6 内置指标（RPS、http_req_duration 分位数、错误率、VU 数），继续沿用，导出一份固定版本入库防漂移；
  2. **单板总览 dashboard（自建，`perf-trade-business.json`，日常主看板）**——同一块板上半为 HTTP 层（RPS、`k6_http_req_duration_p95/p99` 全请求延迟、VU 数、失败率），下半为业务层（三分类错误计数按 `reason` 下钻、`k6_perf_business_success_rate`、`k6_perf_success_duration_p95/p99`、按 `row` 定位坏行）——两类指标查的是同一 Prometheus 数据，单板即可对照，无需在两块板间切换；板顶带跳转链接（keepTime + includeVars）指向官方 19665 作深入参考。官方板保持原样以便随上游升级。
- **与服务端指标串联**（压测后排障的关键路径，三个机制递进）：
  1. **同源数据**：k6 指标与服务端指标写入同一个 Prometheus，天然可在任意 dashboard 混排——自建业务 dashboard 底部直接加一组服务端资源面板（CPU/内存/GC/线程池/DB 连接池，PromQL 与现有服务端 dashboard 一致，按 service 变量过滤），压测曲线与资源曲线上下对齐一屏看完；
  2. **带时间窗跳转**：压测 dashboard 顶部配置 dashboard link 到各服务端 dashboard，URL 携带 `?from=${__from}&to=${__to}`，点击即以当前压测时间窗打开服务端视图，无需手动对时间；
  3. **压测窗口标注（P1）**：`run.sh` 在压测开始/结束时调用 Grafana Annotation API，在服务端 dashboard 上打上 `testid` 标注带——事后翻服务端监控时能直接看到"这段异常发生在某次压测期间"。

## 9. 报告与基线对比

- **summary 双路输出，k6 直接写盘，runner 零后处理**（2026-08-01 修订，机制取自 trade-performance）：`handleSummary` 返回 `{路径: 内容}` 映射，k6 自己把文件写进 `results/<UTC日>/<runId>/`——`summary.txt`（stdout 同款文本摘要：三分类表、成功/全量双延迟分位对照、按 API 子指标行、业务 TPS、样本量纪律告警、阈值清单，判定权威）+ `summary.json`（机读，含 `verdict` 字段供 runner 用 sed 提取定退出码，也是基线对比的输入）。0 请求时合成 `no-samples(0-requests)` 失败项防假绿。时序曲线由 k6 web dashboard 导出的 `dashboard.html` 承担（不作判定——其错误率是 HTTP 层的 http_req_failed，本系统业务失败也返回 200；极短运行会跳过导出）。原"stdout 标记 → Node 提取 → HTML 渲染"管道是 k8s Pod 产物通道的产物，已随执行层收敛一并移除。
- **基线管理（baselines/）**：每场景保存基准 JSON；对比脚本输出本次 vs 基线的 P95/P99/错误率变化百分比，超容差标红——性能回归发现机制（P1）。
- 报告结构复用 `performance-testing` 技能模板：Question / Verdict / Environment / 分位数表 / Knee point / Bottleneck hypothesis / Recommendations。

## 10. 执行方式与运行形态

### 10.1 三种运行形态

压测的执行单位是**场景（scenario 脚本）**，不是单个 API。一次 k6 运行加载一个场景脚本，但场景内部可以压一个或多个 API：

| 形态 | 目录 | 说明 | 用途 |
|---|---|---|---|
| 单 API 场景 | `src/scenarios/` | 一个场景只压一个 API，一次业务动作 | 单 API 容量测定与 SLA 验证——变量隔离最干净，性能结论唯一来源 |
| E2E journey（P1c） | `src/journeys/` | 一个迭代内按业务顺序串多个 API（create → approve → event），失败短路，per-step 子指标分步计延迟 | 全链路演练；数据自给自足——消耗性数据下 soak 长跑的正确形态 |
| 混合配比（P2） | `src/mixed/` | k6 `options.scenarios` 多块并行，每块独立 executor/速率，可引用单 API 动作或 journey 函数 | 按生产流量配比模拟真实交易日负载 |

**方法论默认：单 API 场景 + 套件串行**。多个 API 同时压时共享资源（DB、网关、线程池）互相竞争，任一 API 的劣化都无法归因——"一次只变一个变量"。并行形态用于容量演练，而不是日常 SLA 验证。

**入口查找**：run.sh 按 `scenarios → journeys → mixed → seed` 顺序命中第一个同名文件（跨目录重名报错），命令用法与产物结构对三类入口完全一致。

### 10.2 批量执行（已延后，规模驱动）

2026-08-01 前曾实现 Cucumber 风格的 `--tags` 场景筛选与 PASS/FAIL 汇总表（场景导出 `meta.tags`，runner 扫描过滤），随 k8s 执行层一并移除——当前场景数量下逐条运行即可，git 历史可找回。届时仍须守住的边界：框架的用例选择参数与 k6 原生 `--tag`（指标标签，runner 注入 `--tag testid=`）同名不同物，不可混淆。

### 10.3 交付物

- `perf/run.sh` 为**唯一执行入口**（参考内部 trade-performance 框架的 runner 设计；Linux/macOS 直跑，Windows 用 Git Bash 跑同一份脚本；除 k6 外零依赖——无 Node/jq/python，配置读取用行级 sed，summary 由 k6 直接写盘）：位置参数 `<scenario>[.js] [env] [profile] [KEY=value ...]`（默认 local + smoke，KEY=value 任意透传为 k6 `-e`）。机制：全链路 TZ=UTC（与服务端日志对表）；每次运行独立目录 `results/<UTC日>/<runId>/`，内含 **manifest.txt**（时间戳/epoch/覆盖项/主机/k6 版本/git commit + 内联 env 与 profile 全文——"一次只变一个变量"的事后审计凭证）、k6.log、summary.txt/.json（三分类判定权威，见 §9）、dashboard.html（k6 内置 web dashboard 实时曲线导出，不作判定）、result.csv（逐请求明细）；结束打印带 from/to/var-testid 的 Grafana 直达链接（环境配置 `grafanaDashboard` 键或 GRAFANA_DASHBOARD_URL 覆盖）；Prometheus 输出带 stale markers 与完整 trend stats；PREFLIGHT FAILED 时摘要提示；K6_HTTP_DEBUG 原生直通。判定：k6 退出码非零优先，否则以 summary.json 的 verdict 定 PASS/FAIL。
- 仓库内一切主机地址与业务数据（counterparty、身份账号）使用占位符，真实值仅在公司内网填写。

## 11. 遗留问题（实现前需确认）

1. **Prometheus remote-write receiver 是否开启**——方案唯一外部依赖，实现计划第一步验证；不通则用 Pushgateway 备选。
2. **各 API 的 SLA 目标值**——需业务方给出或从现有监控水位推导（如 query p95 < 300ms、create p95 < 800ms 仅为占位示例，不作为默认值写入）。
3. **压测专用 portfolio**——payload 不接受额外字段（trade-performance 已实测，clientRef 方案作废），数据识别与清理只能依赖"专用 PERF portfolio + 状态 + 时间窗"；专用 portfolio 的真实值需与开发确认建立。
4. **dat 文件是否需要参数化**——同一 dat 高频重复提交是否触发幂等/去重或日期校验，实现时用真实文件验证。已知伏笔（trade-performance 实测发现）：服务端上传临时文件按时间戳命名，同一瞬间并发上传会互相删除临时文件（"dat not found"）——若撞上，其 DAT_NAME_MODE=unique 绕行开关与归因模式可直接借用。
4b. **用例池同源采集**——每行数据须整行来自同一份真实 curl（系统 Web 界面建单 + DevTools Copy as cURL），每换 productType/counterparty 采一次；采集样本含真实业务数据，放 gitignore 的 `_samples/`，不入库。
5. **混合场景流量配比（P2）**——真实交易日各操作比例，届时从生产访问日志/监控统计。
6. **5 个微服务的清单**——服务名、各自地址与核心模块，填充 `config/environments/` 时提供（仓库内保持 localhost 占位）。
7. ~~k8s Job 的脚本注入方式~~——2026-08-01 随 k8s 执行层移除而失效；将来重新引入 k8s 时再议（公司镜像流程或 ConfigMap 挂载）。
8. **trigger-event 各事件契约（P1b 实现前采集）**——8 类事件的请求 payload、成功判据、业务拒绝形态逐一真实采集（同源采集纪律同 create）；**关键未知：事件操作是否同样产生 checker 审批任务**——若是，事件"成功"的即时状态是 PENDING 而非生效，直接改写成功契约与消耗性模型。
9. **事件终态性**——哪些事件后 trade 仍为 LIVE（§6 的可重复候选逐一验证），决定 soak 能否用单 API 形态、seed 规模公式对哪些事件生效。
10. **checker 审批约束**——checker 能否审批自己 maker 身份创建的单（四眼原则的服务端强度，影响 journey 身份配对）；`checker/tasks/pending` 的过滤/分页参数（tradeId→taskId 映射依赖它，P1c）。

## 12. 演进路径

- **P1a：测量正确性融合改造（先于 lifecycle 场景）**——本次修订新增的机制落地：写路径用例行数据模型 + preflight、错误三分类引擎（含 perf_success_duration 与 SLA 指标源切换）、全局游标轮换、profile JSON 化与 baseline/ladder 增补、两级熔断。**排在 P1b 之前的理由：lifecycle 场景建立在这些机制之上，先建场景再改机制等于返工。**
- **P1b：trigger-event 单 API 场景 + 基线对比**——`triggerEvent(cfg, tradeId, eventType, user)` 参数化客户端（8 类事件共用契约骨架、按事件微分）；seed 铺 PENDING 池（纯 create 批量，`SEED_TARGET=PENDING`）；LIVE 池查询圈定 + 事件目标清单 preflight（含 PERF portfolio 硬闸，§6）；基线对比脚本消费 summary.json（§9）。首个压测事件选终态性明确、数据供给成本最低者（§11-8/9 确认后定）。checker-task 审批 API 本期**不实现**。
- **P1c：checker-task 审批链 + E2E journey**——checker-tasks 客户端（`src/api/trade-svc/checker-tasks.js`：pending / approve / reject，taskId 寻址）；LIVE 池全自动 seed（create→查 pending 映射 taskId→approve 双身份流水线）；`src/journeys/trade-lifecycle.js`（create → approve → event 三步双角色、失败短路防 404 洪水，journey 机制借用 trade-performance 实现按需裁剪）；run.sh 入口查找扩展多目录（§10.1）。
- **P2 混合配比场景**（`src/mixed/`）：多 scenario 块并行按生产流量配比，可复用 journey 函数；think time、软依赖降级届时按需引入。
- **API catalog 治理（延后，规模驱动）**：当 API 数量增长到需要覆盖率治理时启用生成式 catalog——清单由各服务 Swagger/OpenAPI 自动同步（可复用本仓库 `parse_swagger.py` 经验），优先级为唯一人工列（Prometheus QPS 排名输出建议值辅助），覆盖列由场景元数据反向计算；届时场景 `meta` 增加 `covers` 字段声明所覆盖端点。
- **WebSocket（P2）**：k6 原生支持 ws 协议；在 `api/` 层新增 ws 客户端模块，`lib/errors.js` 增加消息延迟指标，无架构变更。
- **CI 集成（P2）**：SLA 判定已体现在退出码，接入 CI 仅需增加流水线配置。
- **k8s 执行层（条件触发）**：单机施压能力不足（内网实测撞到 runner 机器瓶颈）时重新引入 k8s Job 路径——2026-08-01 前的实现（job.yaml 模板、提交/轮询/汇总、stdout 标记报告通道）在 git 历史中可整体找回。
- **分布式/平台化（远期）**：k6-operator TestRun CRD（`parallelism: N` + 数据分片）；Web 平台后端通过 k8s API 创建 Job/TestRun，脚本层不变。

## 13. 与 trade-performance 框架的融合评估（2026-07-31）

对内部另一套 k6 框架（trade-performance，纯本机执行、针对同一交易系统、按真实接口校准）做了逐文件评估，结论：**它强在"测得对"（数据有效性、错误归因、成功样本分离、方法论 profile），本框架强在"跑得动"（调度、批量、k8s、报告管道、防护）**。融合取舍：

**采纳（已并入上文各节）**：写路径用例行数据模型与同源采集纪律（§6）、preflight 数据闸（§6）、全局游标轮换（§6）、错误三分类引擎 + reason 归因 + success-only duration + 限流日志（§5）、profile JSON 声明式 + baseline/ladder + 两级熔断（§4、§7）、SLA 指标源切至 perf_success_duration（§7）、create 成功契约校准值（§5）、payload 不接受额外字段的实测结论（§6、§11）。

**保留本框架（不因融合退化）**：per-API 分位数 SLA（对方完全没有延迟阈值）、`--tags` 批量执行与汇总表、k8s Job 双路径执行层、stdout 标记→JSON/HTML 报告归档管道、环境白名单、maxVUs 全局硬上限、`meta.tags` 语义化命名（对方为编号命名）。

**暂不采纳（YAGNI，条件触发再启用）**：journey 层（原定 P2，2026-08-02 起提前至 P1c——lifecycle 状态机使 E2E 链成为消耗性数据下长跑的必要形态）、DAT_NAME_MODE 缺陷绕行开关（撞上服务端临时文件竞态再借用，见 §11-4）。

**2026-08-01 补记（执行层收敛后翻案两项）**：原"暂不采纳"的自研终端 summary 与 handleSummary 直接写盘机制均已采纳——当时不采纳的理由是"与本框架报告管道重复"，报告管道（stdout 标记 → Node 提取 → HTML）随 k8s 执行层删除后前提反转：文本摘要成为三分类唯一的人读视图（导出 handleSummary 后 k6 不打默认摘要），k6 写盘取代全部 Node 后处理（见 §9）。反向地，本框架当时"保留不退化"的 `--tags` 批量执行与 k8s 双路径也已按 YAGNI 移除（§10.2、§12）。
