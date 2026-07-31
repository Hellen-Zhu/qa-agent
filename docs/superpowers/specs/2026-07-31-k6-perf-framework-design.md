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
│   ├── environments/       # dev.json / uat.json：baseUrl、Prometheus RW 地址（不存在 prod 配置）
│   └── slas/               # 按 API 定义 SLA 阈值，集中管理
├── src/
│   ├── lib/                # 框架层：auth.js、http.js、data.js、metrics.js、checks.js
│   ├── api/                # API 客户端层：trades.js（queryTrades / createTrade / triggerEvent）
│   ├── payloads/           # FX 产品 payload 工厂（forward、vanilla option、TARF 等）
│   ├── profiles/           # 负载模型：smoke / load / stress / spike / soak
│   └── scenarios/          # 压测场景入口：trades-query.js、trades-create.js、
│                           #   lifecycle-events.js (P1)、mixed.js (P2)
├── data/                   # CSV 参数池：currency pairs、counterparties、查询条件组合
├── seed/                   # P1：数据铺底脚本
├── deploy/                 # Dockerfile、job.yaml 模板、run.sh
├── dashboards/             # Grafana dashboard JSON
├── baselines/              # 各场景性能基线（JSON）
├── reports/                # 报告归档（整目录 gitignore；需长期保留的结果晋升为 baselines/ 基线）
└── docs/                   # 使用说明、环境准备 checklist
```

**分层原则**：场景脚本中不出现 URL、token、阈值。业务动作编排在 `scenarios/`，接口细节在 `api/`，环境在 `config/`，负载形状在 `profiles/`。高频变更（换环境、换负载等级、加 API）各自只动一处。

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

## 5. 认证与 API 客户端层

- **认证模块（lib/auth.js）**：`setup()` 阶段登录获取 token；支持多用户 token 池（多个 trader/sales 身份轮换）；token 按过期时间自动刷新——soak 场景运行超过 token 有效期时必需。
- **API 封装（api/trades.js）**：每个 API 一个函数，统一设置 `tags.name`（如 `GET /trades`）；URL 中的动态 trade ID 必须归一化进 tag，避免 Prometheus 指标基数爆炸。
- **双层断言**：HTTP 状态码校验 + 业务响应体校验（HTTP 200 但 body 含业务错误码计为失败）。关键业务动作建独立自定义指标：`trade_booking_duration`（Trend）、`trade_booking_errors`（Counter），区分 HTTP 层与业务层健康度。

## 6. 测试数据管理

- **Payload 工厂（payloads/）**：booking 请求体由工厂函数生成，currency pair、notional、tenor、product type 从 `data/` CSV 参数池随机组合，避免单一 payload 只压中同一代码路径和缓存。
- **唯一性**：client trade reference 由 `VU编号-迭代号-时间戳` 生成，避免唯一键冲突。
- **查询多样性**：`/trades` 查询覆盖日期区间、状态、counterparty 等过滤条件组合（组合定义在 `data/` CSV），防止缓存热点造成虚假乐观结果。
- **压测数据标记**：压测产生的 trade 使用专用标识（如 counterparty/book 固定为 `PERF_TEST`，具体字段实现时与开发确认），用于压测后清理及下游系统（风控、结算、报表）排除。
- **数据铺底（P1，seed/）**：lifecycle 事件需要处于特定状态的 trade。seed 脚本预先 book 一批 trade 并通过 `trigger-event` 推进到目标状态，输出 trade ID 清单文件供压测场景消费。
- **环境准备 checklist（docs/）**：压测环境 trade 表存量数据需接近生产量级；数据库、下游依赖容量核对项以文档 checklist 形式维护，不写入代码。

## 7. SLA、熔断与安全防护

- **SLA 集中管理（config/slas/）**：按 API 定义阈值（p95/p99 延迟、错误率），场景加载对应 SLA 生成 k6 `thresholds`，运行结束自动判 PASS/FAIL（进程退出码体现，为 P2 接 CI 门禁打基础）。SLA 具体数值待业务方/现有监控水位确认（见第 11 节遗留问题）。
- **熔断止损**：错误率阈值配置 `abortOnFail: true`，被测环境劣化到阈值时自动停止施压，保护共享 UAT。
- **环境白名单**：`config/environments/` 中不存在 prod 配置；框架启动时校验目标域名在白名单内，否则拒绝执行。
- **资源防护**：Job 设置 CPU/内存 limit 与 `ttlSecondsAfterFinished` 自动回收；profile 内置 maxVUs 上限。

## 8. 可观测性与 Grafana

- k6 通过内置 `experimental-prometheus-rw` 输出指标至现有 Prometheus，Trend 指标配置 p95/p99 统计。
- **testid 约定**：每次运行生成唯一 `testid`（`<场景>-<YYYYMMDD-HHmmss>`）作为全局标签，Grafana 按 testid 下拉筛选任意一次历史压测。
- **压测 Dashboard（dashboards/*.json，版本管理）**：RPS、P95/P99 延迟、错误率、VU 数、checks 通过率、业务自定义指标；排障时与现有服务端 Dashboard 使用相同时间窗对照。

## 9. 报告与基线对比

- `handleSummary()` 每次运行产出 JSON 摘要 + HTML 报告，Job 结束后归档至 `reports/`（P0 用 `kubectl cp`/logs 取回，后续可挂 PVC）。
- **基线管理（baselines/）**：每场景保存基准 JSON；对比脚本输出本次 vs 基线的 P95/P99/错误率变化百分比，超容差标红——性能回归发现机制（P1）。
- 报告结构复用 `performance-testing` 技能模板：Question / Verdict / Environment / 分位数表 / Knee point / Bottleneck hypothesis / Recommendations。

## 10. 执行方式

```bash
# k8s 触发（渲染 job.yaml → kubectl apply → 输出 Grafana 链接与 testid）
./run.sh -s trades-query -p load -e uat [-r 50 -d 10m]

# 本地调试（同一套脚本，行为一致，打印请求/响应细节）
k6 run -e ENV=dev -e PROFILE=smoke src/scenarios/trades-query.js
```

- Dockerfile 基于 k6 官方镜像 COPY 脚本与配置；镜像 tag 与 git commit 关联保证可追溯。
- `run.sh` 负责参数校验、testid 生成、manifest 渲染（envsubst）、提交 Job、tail 日志。

## 11. 遗留问题（实现前需确认）

1. **Prometheus remote-write receiver 是否开启**——方案唯一外部依赖，实现计划第一步验证；不通则用 Pushgateway 备选。
2. **各 API 的 SLA 目标值**——需业务方给出或从现有监控水位推导（如 query p95 < 300ms、create p95 < 800ms 仅为占位示例，不作为默认值写入）。
3. **压测数据标记字段**——用 counterparty、book 还是自定义字段标记 `PERF_TEST`，需与开发确认对下游无副作用。
4. **认证方式细节**——token 获取端点与刷新机制，实现 `lib/auth.js` 时确认。
5. **混合场景流量配比（P2）**——真实交易日各操作比例，届时从生产访问日志/监控统计。

## 12. 演进路径

- **WebSocket（P2）**：k6 原生支持 ws 协议；在 `api/` 层新增 ws 客户端模块，`lib/metrics.js` 增加消息延迟指标，无架构变更。
- **CI 集成（P2）**：SLA 判定已体现在退出码，接入 CI 仅需增加流水线配置。
- **分布式/平台化（远期）**：替换 `deploy/` 为 k6-operator TestRun CRD（`parallelism: N` + 数据分片）；Web 平台后端通过 k8s API 创建 Job/TestRun，脚本层不变。
