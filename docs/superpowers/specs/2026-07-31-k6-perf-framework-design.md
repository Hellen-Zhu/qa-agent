# k6 性能测试框架设计文档

- **日期**: 2026-07-31
- **状态**: 已与需求方确认设计，待评审后进入实现计划
- **被测系统**: 公司内部 FX Structured Products Trading System（trade 全生命周期管理）
- **技术栈**: k6 + 现有 Prometheus + 现有 Grafana + Kubernetes

## 1. 背景与目标

为交易系统的 HTTP API 服务端压测搭建一套工程化的性能测试框架（第一期），后续可演进为自助式 Web 平台（远期）。框架方法论沿用本仓库 `.claude/skills/performance-testing` 中已有的约定（测试类型、阈值优先、报告格式）。

**范围与优先级**：

| 优先级 | 内容 |
|---|---|
| P0 | `GET /trades` 查询、`POST /trades/create` booking 两个场景，跑通"触发 → 施压 → 指标入 Prometheus → Grafana 查看 → 出报告"全链路 |
| P1 | 基于 `POST /trades/trigger-event` 的 lifecycle 事件场景 + 测试数据铺底（seeding）+ 基线对比 |
| P2 | 端到端混合场景（按流量配比）、WebSocket 支持、CI 集成 |
| 远期 | Web 平台化、分布式施压（迁移 k6-operator） |

**明确不做（第一期）**：Web UI、CI 流水线集成、自建 Prometheus/Grafana（复用项目现有监控栈）、分布式多节点施压。

## 2. 总体架构

```
开发者/QA ──run.sh──▶ k8s Job (单个 k6 Pod) ──HTTP──▶ Trading System 微服务
                          │                              │
                          │ Prometheus remote write       │ 服务端指标（已有）
                          ▼                              ▼
                     现有 Prometheus ◀───────────────────┘
                          │
                          ▼
                     现有 Grafana ◀── 导入压测 Dashboard（JSON 进版本库）
```

- 一次压测 = 一个 k8s Job，跑单个 k6 Pod（内部系统负载量级下单 Pod 足够）。
- k6 客户端指标经内置 `experimental-prometheus-rw` 输出写入现有 Prometheus，与服务端指标同源，在 Grafana 中按时间轴对齐定位瓶颈。
- 执行层设计为可替换：未来需要分布式时仅替换 `deploy/` 层为 k6-operator（TestRun CRD），`src/` 脚本层零改动。

**外部依赖（唯一）**：现有 Prometheus 需开启 `--web.enable-remote-write-receiver`。若运维不允许，备选方案为 Pushgateway 中转（实现计划中先验证此依赖）。

## 3. 仓库结构

框架代码位于本仓库 `perf/` 目录：

```
perf/
├── config/
│   ├── environments/       # dev.json / uat.json：各微服务 baseUrl 映射、Prometheus RW 地址（不存在 prod 配置）
│   └── slas/               # SLA 阈值，按 服务/模块/API 三级组织，集中管理
├── src/                    # 只存放会被 k6 引擎加载执行的 JavaScript 代码
│   ├── lib/                # 框架层：users.js（身份池）、http.js、data.js、metrics.js、checks.js
│   ├── api/                # API 客户端层，按 微服务/模块 分目录（见 3.1）
│   │   └── trade-svc/
│   │       └── trades.js   # queryTrades / createTrade / triggerEvent
│   ├── payloads/           # multipart 组装工厂：参数化 trade JSON + 按产品选择 dat 模板
│   ├── profiles/           # 负载模型：smoke / load / stress / spike / soak
│   └── scenarios/          # 压测场景入口：trades-query.js、trades-create.js、
│                           #   lifecycle-events.js (P1)、mixed.js (P2)
├── data/
│   ├── params/             # JSON 参数池：counterparties、portfolio、查询条件组合
│   └── datfiles/           # 各产品类型的 dat 模板文件：FX_TRF.dat 等
├── seed/                   # P1：数据铺底脚本
├── deploy/                 # Dockerfile、job.yaml 模板、run.sh
├── tools/                  # 辅助脚本：基线对比等
├── dashboards/             # Grafana dashboard JSON（见第 8 节）
├── baselines/              # 各场景性能基线（JSON）
├── reports/                # 报告归档（整目录 gitignore；需长期保留的结果晋升为 baselines/ 基线）
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

第一期不建 API catalog，优先级直接由场景文件的 `meta.tags` 表达（`P0`/`P1`/`P2` tag），配合 10.2 的 `--tags` 筛选执行。**定级标准**（满足任一升级为更高优先级）：

- **P0**：交易日高频路径、涉及资金/交易状态变更、生产监控 QPS 排名靠前；
- **P1**：常用查询与生命周期操作、有性能风险特征（复杂查询、大 payload）；
- **P2**：低频后台/管理类接口。

局限（接受）：tag 只能描述"已写的场景"，无法回答"系统还有哪些 API 没被覆盖"。当 API 规模增长到需要覆盖率治理时，再启用生成式 catalog 方案（清单由各服务 Swagger 自动同步、优先级人工定级、覆盖由场景元数据反向计算），设计已记录在第 12 节演进路径。

## 4. 负载模型（profiles）

五种标准 profile，任意场景可组合任意 profile：

| Profile | 回答的问题 | 形状 |
|---|---|---|
| smoke | 脚本和链路通不通 | 1-2 iter/s，1 分钟 |
| load | 预期流量下是否满足 SLA | 阶梯升至目标 RPS，稳态 10-30 分钟 |
| stress | 容量拐点在哪 | 持续加压至错误率/延迟劣化 |
| spike | 突发流量是否扛得住 | 瞬间打至高位再回落 |
| soak | 长时间运行是否劣化（泄漏） | 中等负载 ≥2 小时 |

- 默认使用 open model（`constant-arrival-rate` / `ramping-arrival-rate`，固定 RPS）：被测系统变慢时压力不衰减，避免 coordinated omission 导致延迟失真。
- closed model（`ramping-vus`）作为备用，用于模拟固定 trader 人数的行为。
- 目标 RPS、时长、maxVUs 可通过环境变量在触发时覆盖；profile 内置 maxVUs 上限，防止误配置打挂共享环境。

## 5. 身份与 API 客户端层

- **身份模块（lib/users.js）**：系统无 token 认证，统一通过 `X-User-Id` 请求头传递身份（如 `maker@sc.com`）。身份池在 `config/` 中按角色维护（maker / checker 各若干），场景按业务动作选择角色——create 用 maker，approve/checker 类事件用 checker（maker-checker 四眼原则下 P1 lifecycle 场景必须双角色协作）。无 token 过期问题，soak 场景无需刷新逻辑。
- **HTTP 统一封装（lib/http.js）**：对 `k6/http` 的薄封装，对外只暴露三个动词——`get(service, path, opts)` / `postJson(service, path, body, opts)` / `postMultipart(service, path, formData, opts)`，三者收敛到同一个内部 `request()` 管道，集中处理：按服务名解析 baseUrl；注入默认请求头（`X-User-Id`、`Accept`）；强制要求规范化的 `tags.name` 并附加 `service`/`module` 标签（URL 中动态 trade ID 归一化进 tag，避免 Prometheus 指标基数爆炸）；统一记录自定义指标与通用断言。api 层因此保持一行一调用的薄结构，新增请求形态（如 put/delete）只在 http.js 加一个动词。
- **双层断言**：HTTP 状态码校验 + 业务响应体校验（HTTP 200 但 body 含业务错误码计为失败）。关键业务动作建独立自定义指标：`trade_booking_duration`（Trend）、`trade_booking_errors`（Counter），区分 HTTP 层与业务层健康度。

## 6. 测试数据管理

- **Multipart 组装工厂（payloads/）**：`trades/create` 实际为 multipart/form-data 请求，含两个 part：`trade`（JSON 字符串，portfolioId、counterpartyFmId 等字段参数化，取值来自 `data/params/` JSON 参数池）和 `datFile`（产品定义文件，`http.file()` 上传）。工厂函数职责：按产品类型从 `data/datfiles/` 选择 dat 模板（init 阶段 `open(..., 'b')` 预加载）+ 生成参数化的 trade JSON part。不同产品类型（TRF 等）各自维护 dat 模板，扩产品 = 加一个 dat 文件 + 注册到工厂。
- **唯一性**：trade JSON part 中可参数化的标识字段由 `VU编号-迭代号-时间戳` 生成，避免唯一键冲突。
- **查询多样性**：`/trades` 查询覆盖日期区间、状态、counterparty 等过滤条件组合（组合定义在 `data/params/` JSON），防止缓存热点造成虚假乐观结果。
- **压测数据标记**：压测产生的 trade 使用专用标识（如 counterparty/book 固定为 `PERF_TEST`，具体字段实现时与开发确认），用于压测后清理及下游系统（风控、结算、报表）排除。
- **数据铺底（P1，seed/）**：lifecycle 事件需要处于特定状态的 trade。seed 脚本预先 book 一批 trade 并通过 `trigger-event` 推进到目标状态，输出 trade ID 清单文件供压测场景消费。
- **环境准备 checklist（docs/）**：压测环境 trade 表存量数据需接近生产量级；数据库、下游依赖容量核对项以文档 checklist 形式维护，不写入代码。

## 7. SLA、熔断与安全防护

- **SLA 集中管理（config/slas/）**：按 API 定义阈值（p95/p99 延迟、错误率），场景加载对应 SLA 生成 k6 `thresholds`，运行结束自动判 PASS/FAIL（进程退出码体现，为 P2 接 CI 门禁打基础）。SLA 具体数值待业务方/现有监控水位确认（见第 11 节遗留问题）。
- **熔断止损**：错误率阈值配置 `abortOnFail: true`，被测环境劣化到阈值时自动停止施压，保护共享 UAT。
- **环境白名单**：`config/environments/` 中不存在 prod 配置；框架启动时校验目标域名在白名单内，否则拒绝执行。
- **资源防护**：Job 设置 CPU/内存 limit 与 `ttlSecondsAfterFinished` 自动回收；profile 内置 maxVUs 上限。

## 8. 可观测性与 Grafana

- k6 通过内置 `experimental-prometheus-rw` 输出指标至现有 Prometheus，Trend 指标配置 p95/p99 统计。**所有指标（含自定义业务指标）都会以 `k6_` 前缀写入**——remote write 不区分内置与自定义。
- **testid 约定**：每次运行生成唯一 `testid`（`<场景>-<YYYYMMDD-HHmmss>`）作为全局标签，Grafana 按 testid 下拉筛选任意一次历史压测（官方 dashboard 自带 testid 变量，`run.sh` 生成的 testid 直接可用）。
- **dashboards/ 内容**（均为 JSON 进版本库）：
  1. **官方 k6 Prometheus dashboard（ID 19665，已在使用）**——展示 k6 内置指标（RPS、http_req_duration 分位数、错误率、VU 数），继续沿用，导出一份固定版本入库防漂移；
  2. **业务指标 dashboard（自建）**——官方面板只覆盖内置指标，`k6_trade_booking_duration` 等自定义业务指标需要自建面板，并按 `service`/`module` 标签下钻。
- **与服务端指标串联**（压测后排障的关键路径，三个机制递进）：
  1. **同源数据**：k6 指标与服务端指标写入同一个 Prometheus，天然可在任意 dashboard 混排——自建业务 dashboard 底部直接加一组服务端资源面板（CPU/内存/GC/线程池/DB 连接池，PromQL 与现有服务端 dashboard 一致，按 service 变量过滤），压测曲线与资源曲线上下对齐一屏看完；
  2. **带时间窗跳转**：压测 dashboard 顶部配置 dashboard link 到各服务端 dashboard，URL 携带 `?from=${__from}&to=${__to}`，点击即以当前压测时间窗打开服务端视图，无需手动对时间；
  3. **压测窗口标注（P1）**：`run.sh` 在压测开始/结束时调用 Grafana Annotation API，在服务端 dashboard 上打上 `testid` 标注带——事后翻服务端监控时能直接看到"这段异常发生在某次压测期间"。

## 9. 报告与基线对比

- `handleSummary()` 每次运行产出 JSON 摘要 + HTML 报告，Job 结束后归档至 `reports/`（P0 用 `kubectl cp`/logs 取回，后续可挂 PVC）。
- **基线管理（baselines/）**：每场景保存基准 JSON；对比脚本输出本次 vs 基线的 P95/P99/错误率变化百分比，超容差标红——性能回归发现机制（P1）。
- 报告结构复用 `performance-testing` 技能模板：Question / Verdict / Environment / 分位数表 / Knee point / Bottleneck hypothesis / Recommendations。

## 10. 执行方式与运行形态

### 10.1 三种运行形态

压测的执行单位是**场景（scenario 脚本）**，不是单个 API。一次 k6 运行加载一个场景脚本，但场景内部可以压一个或多个 API：

| 形态 | 说明 | 用途 |
|---|---|---|
| 单 API 场景 | 一个场景只压一个 API（如 `trades-query.js`） | 单 API 容量测定与 SLA 验证——变量隔离最干净 |
| 多 API 并行 | 利用 k6 `options.scenarios` 在**同一次运行**中定义多个并行 scenario，每个 API 独立的 executor、速率与阈值 | 多接口同时施压的整体演练 |
| 混合业务流（P2） | 一个迭代内按业务顺序串多个 API（query → create → trigger-event），按流量配比编排 | 模拟真实交易日负载 |

**方法论默认：单 API 场景 + 套件串行**。多个 API 同时压时共享资源（DB、网关、线程池）互相竞争，任一 API 的劣化都无法归因——"一次只变一个变量"。并行形态用于容量演练，而不是日常 SLA 验证。

### 10.2 按 tag 筛选批量执行（Cucumber 风格）

k6 没有 Cucumber 式的用例选择 tag（k6 的 "tag" 是指标维度，用于结果分析过滤，不是用例选择；一次 `k6 run` 只认一个入口文件）。框架自行实现同等体验——每个场景文件导出元数据声明 tags，`run.sh` 扫描 `src/scenarios/` 过滤执行：

```js
// src/scenarios/trades-create.js
export const meta = { tags: ['P0', 'trade-svc', 'write'] };
```

```bash
# 单场景触发（渲染 job.yaml → kubectl apply → 输出 Grafana 链接与 testid）
./run.sh -s trades-query -p load -e uat [-r 50 -d 10m]

# tag 筛选：所有标 P0 的场景串行执行，输出 PASS/FAIL 汇总表
./run.sh --tags P0 -p load -e uat
./run.sh --tags P0,trade-svc -p smoke -e dev   # 多 tag 取交集

# 本地调试（同一套脚本，行为一致，打印请求/响应细节）
k6 run -e ENV=dev -e PROFILE=smoke src/scenarios/trades-query.js
```

每个命中的场景仍是独立 k6 运行（独立 testid、独立报告），默认串行执行（见 10.1 方法论）。

**与 k6 原生 `--tag` 的边界（防混淆）**：`run.sh` 的 `--tags` 是框架自己的参数，由 run.sh 解析消费，**不会传给 k6**；k6 原生的 `--tag`（单数，指标标签）仅由框架内部使用——run.sh 组装 k6 命令时注入 `--tag testid=<testid>`，用户永远不手写它。场景里的 `export const meta` 对 k6 引擎只是一个未被引用的导出常量，运行时零副作用。若有人绕过 run.sh 直接执行 `k6 run --tags P0` 会得到未知参数报错——这本身就是"请走 run.sh"的提示。


### 10.3 交付物

- Dockerfile 基于 k6 官方镜像 COPY 脚本与配置；镜像 tag 与 git commit 关联保证可追溯。
- `run.sh` 负责参数校验、testid 生成、manifest 渲染（envsubst）、提交 Job、tail 日志；`--tags` 模式追加场景元数据扫描与 PASS/FAIL 汇总表输出。

## 11. 遗留问题（实现前需确认）

1. **Prometheus remote-write receiver 是否开启**——方案唯一外部依赖，实现计划第一步验证；不通则用 Pushgateway 备选。
2. **各 API 的 SLA 目标值**——需业务方给出或从现有监控水位推导（如 query p95 < 300ms、create p95 < 800ms 仅为占位示例，不作为默认值写入）。
3. **压测数据标记字段**——用 counterparty、portfolio 还是自定义字段标记 `PERF_TEST`，需与开发确认对下游无副作用。
4. **dat 文件是否需要参数化**——同一 dat 模板高频重复提交是否会触发幂等/去重逻辑或字段校验（如交易日期过期）；若 dat 为文本格式，可做模板变量替换，实现时用真实文件验证。
5. **混合场景流量配比（P2）**——真实交易日各操作比例，届时从生产访问日志/监控统计。
6. **5 个微服务的清单**——服务名、各自地址与核心模块，填充 `config/environments/` 时提供。

## 12. 演进路径

- **API catalog 治理（延后，规模驱动）**：当 API 数量增长到需要覆盖率治理时启用生成式 catalog——清单由各服务 Swagger/OpenAPI 自动同步（可复用本仓库 `parse_swagger.py` 经验），优先级为唯一人工列（Prometheus QPS 排名输出建议值辅助），覆盖列由场景元数据反向计算；届时场景 `meta` 增加 `covers` 字段声明所覆盖端点。
- **WebSocket（P2）**：k6 原生支持 ws 协议；在 `api/` 层新增 ws 客户端模块，`lib/metrics.js` 增加消息延迟指标，无架构变更。
- **CI 集成（P2）**：SLA 判定已体现在退出码，接入 CI 仅需增加流水线配置。
- **分布式/平台化（远期）**：替换 `deploy/` 为 k6-operator TestRun CRD（`parallelism: N` + 数据分片）；Web 平台后端通过 k8s API 创建 Job/TestRun，脚本层不变。
