# Testing & Quality — Confluence 空间结构设计

> 本文档定义 Confluence 中 **Testing & Quality** 页面的完整结构：顶层模块、专项测试（Specialized Testing）子模块，以及性能测试（Performance Testing）的细化页面树。
> 设计目标：让这个页面成为团队质量工作的**单一入口**——新人能自助上手、老人能快速查规范、管理者能看到质量状态。

---

## 1. 顶层结构（Top-Level Structure）

```
Testing & Quality
├── 1. Test Strategy & Standards        测试策略与规范
├── 2. Test Planning & Release          测试计划与发布
├── 3. Test Cases & Scenarios           测试用例库
├── 4. Test Automation                  自动化测试
├── 5. Environments & Test Data         环境与测试数据
├── 6. Defect Management                缺陷管理
├── 7. Quality Metrics & Reports        质量度量与报告
├── 8. Specialized Testing              专项测试
├── 9. Tools & Infrastructure           工具与基础设施
└── 10. Retrospectives & Learnings      复盘与知识沉淀
```

### 各模块说明

| 模块 | 内容 | 价值 |
|---|---|---|
| **Test Strategy & Standards** | 整体测试策略（测试金字塔分层、自动化范围）、质量门禁（Quality Gates）、Definition of Done、各类测试准入准出标准 | 整个空间的"宪法"，让后续争论有依据 |
| **Test Planning & Release** | 按版本/迭代的测试计划、回归范围、发布 Checklist、Go/No-Go 标准与签核记录 | 用页面模板按版本复制，便于审计追溯 |
| **Test Cases & Scenarios** | 核心业务流程说明、场景设计思路、边界条件清单；**链接**到用例管理系统（TestRail / Xray / Zephyr） | Confluence 不做用例管理，避免两处维护 |
| **Test Automation** | 框架架构说明、本地与 CI 运行方式、新增用例规范、Flaky test 处理流程与黑名单 | 新人问得最多的模块，越"可操作"越好 |
| **Environments & Test Data** | 环境矩阵（环境↔分支/用途）、测试账号、Mock 服务说明、数据准备脚本入口 | 把散落在聊天记录里的信息集中，减少重复提问 |
| **Defect Management** | Bug 生命周期流程图、Severity/Priority 定义标准、提 Bug 模板、Triage 机制 | 级别定义写清楚，减少"这是不是 P1"的扯皮 |
| **Quality Metrics & Reports** | 指标定义（逃逸缺陷率、自动化覆盖率、回归通过率）+ Dashboard 链接、发布质量报告归档 | 给管理层和跨团队看的窗口 |
| **Specialized Testing** | 性能、安全、兼容性、稳定性等专项，详见第 2 节 | 方法论与常规功能测试差异大，单独成模块 |
| **Tools & Infrastructure** | 工具清单、权限申请方式、CI/CD 流水线说明 | 偏"运维手册"性质 |
| **Retrospectives & Learnings** | 线上事故的测试视角复盘、逃逸缺陷分析、Bug Bash 记录 | 决定团队是"重复踩坑"还是"持续进化" |

### 落地原则

- **不要一次性建 10 个空目录**——空页面比没有页面更伤害空间可信度。优先建日常被问最多的：Strategy、Automation、Environments、Defect Management。
- 每个模块首页放一段"这里有什么、什么时候来看"的导读。
- 配合 Confluence 页面模板维持结构：测试计划、质量报告、复盘各建一个模板。

---

## 2. Specialized Testing（专项测试）

每个子模块遵循统一骨架：**方案/方法论 → 基线与标准 → 执行指南 → 历史结果归档**。

```
Specialized Testing
├── 8.1 Performance Testing             性能测试（详见第 3 节）
├── 8.2 Security Testing                安全测试
├── 8.3 Compatibility Testing           兼容性测试
├── 8.4 Stability & Reliability         稳定性与可靠性测试
├── 8.5 Accessibility Testing           可访问性测试
├── 8.6 i18n / L10n Testing             国际化与本地化测试
└── 8.7 Migration & Upgrade Testing     数据迁移与升级测试
```

### 各子模块内容

**8.2 Security Testing**
- 安全测试 Checklist（OWASP Top 10 对照、鉴权/越权场景清单）
- 依赖漏洞扫描、SAST/DAST 工具接入说明
- 渗透测试排期与报告归档；漏洞定级标准与修复 SLA
- ⚠️ 涉及敏感信息（漏洞细节、未修复项），**对页面单独设置访问权限**

**8.3 Compatibility Testing**
- 核心是一张**兼容性矩阵**：浏览器/版本、操作系统、移动端机型/分辨率、API 版本兼容承诺
- 矩阵取舍依据（如"覆盖 95% 活跃用户的机型"，来自用户数据）
- 真机/云真机平台（BrowserStack 等）使用指南；每轮兼容性回归结果
- 矩阵要写明**更新机制**（如每季度按用户数据重审），否则会一直测已没人用的机型

**8.4 Stability & Reliability**
- 长时间运行测试（soak test）方案、内存泄漏排查手册
- 故障注入/混沌工程实验记录（实验假设、爆炸半径控制、结果）
- 容灾演练（主备切换、降级预案验证）Runbook 与演练记录
- 与 SRE 团队交界，写清双方分工和联系人

**8.5 Accessibility Testing**
- 遵循标准（WCAG 2.1 AA 或当地法规）、检查清单（键盘可操作、屏幕阅读器、对比度）
- 自动化工具（axe、Lighthouse）接入 CI 的说明
- 人工测试操作指南（VoiceOver/NVDA 过核心流程）；合规审计报告归档

**8.6 i18n / L10n Testing**
- 支持的语言/地区清单
- i18n 通用缺陷 Checklist（文案截断、日期/货币/时区格式、RTL 布局、伪本地化测试方法）
- 翻译验收流程（语言质量责任人、翻译 Bug 的提法）

**8.7 Migration & Upgrade Testing**
- 升级路径矩阵（哪些旧版本可升到当前版本）
- 迁移测试数据集准备方法、回滚验证方案
- 每次大版本的迁移演练记录（频率低但风险极高，文档缺失时只能"考古"）

### 取舍原则

- **只建团队真的会做的专项**。纯内部 B 端工具可能不需要 8.5/8.6；纯 API 服务的 8.3 可简化为一页 API 版本兼容策略。
- 判断标准：未来三个月内不会写第二篇文档的子模块就先不建，在专项测试首页写一行"暂不覆盖 XX，原因……"。
- 每个子模块首页固定三样东西：**Owner（负责人）、Trigger（触发时机，如"涉及支付链路改动必须过安全 Checklist"）、最近一次执行记录链接**。专项测试最大的风险是"该做的时候没人想起来"，触发时机要挂到发布 Checklist 里。

---

## 3. Performance Testing（性能测试）细化结构

```
Performance Testing
├── 1. Strategy & Workload Model        方案与模型
│   ├── Performance Test Strategy
│   ├── Workload Modeling
│   └── KPI Definitions
├── 2. Tooling                          工具：选型、安装、使用
│   ├── Tool Comparison & Selection
│   ├── k6（主力：REST + WebSocket）
│   │   ├── Installation Guide
│   │   ├── Getting Started
│   │   ├── Scripting Standards
│   │   ├── Scenarios & Load Profiles
│   │   ├── CI Integration
│   │   └── FAQ & Troubleshooting
│   ├── JMeter（存量/备用）
│   │   ├── Installation Guide
│   │   ├── Getting Started
│   │   ├── Scripting Standards
│   │   ├── Distributed Testing & CI
│   │   └── FAQ & Troubleshooting
│   └── Monitoring & Profiling
├── 3. Environment & Data               压测环境与数据
│   ├── Load Test Environments
│   ├── Test Data Preparation
│   └── Load Testing Policy
├── 4. Performance Assets               资产建设
│   ├── Script Repository
│   ├── Scenario Library
│   ├── Reusable Components
│   └── Asset Maintenance Rules
├── 5. Baselines & SLOs                 基线与标准
│   ├── Performance Baselines
│   └── SLO & Pass/Fail Criteria
├── 6. Execution Runbook                执行指南
│   ├── Execution SOP
│   ├── Result Analysis Guide
│   └── Report Template
├── 7. Reports & Case Studies           报告归档与调优案例
│   ├── Release Performance Reports
│   └── Tuning Case Studies
└── 8. Frontend / Web Performance       前端性能（Playwright + CDP）
    ├── Strategy & Performance Budgets
    ├── Playwright Perf Testing Guide
    ├── Mock Market Data Feeder
    ├── Frontend Scenario Library
    ├── CI Tiers & Budget Gates
    └── RUM & Field Data
```

### 3.1 Strategy & Workload Model

| Page | 内容 |
|---|---|
| **Performance Test Strategy** | 什么类型的改动必须做性能测试（触发规则）；测试类型定义——Smoke / Load / Stress / Spike / Soak / Capacity 各自的适用时机与**递进关系**（先 Smoke 验证脚本与系统能跑，Load 通过后才做 Stress/Spike/Soak）；交易类 Web 系统的性能特殊性：看尾延迟与抖动而非均值、负载呈脉冲型（开盘/行情剧烈波动可达日常数十倍）、报撤单比例高（做市/量化客户可达 10:1）、行情推送与交易链路要先分压再合压 |
| **Workload Modeling** | API 清单与链路分级：P0 交易主链路（下单/撤单/回报推送 WS，延迟敏感）、P1 高频查询（持仓/资金/委托/行情快照）、P2 低频操作（登录/出入金/开销户），WebSocket 推送通道单独标注；全新系统无生产数据时用**假设驱动的 v0 模型**——客户数、日活比例、每户日均委托、报撤比、查询/交易比（通常 5~20 倍）、峰值系数（开盘按日常时段 10~30 倍），每条假设显式记录，上线后用真实数据修正；最终产出**目标容量表**（接口 → 目标 TPS + 延迟目标，如下单 P99 < 100ms） |
| **KPI Definitions** | 指标口径统一定义——TPS、RT P50/P95/P99、错误率、饱和度指标怎么算。只报分位数**不报平均值**（均值掩盖尾部，用户抱怨的正是尾部）；延迟必须与错误率并排呈现（快速失败的系统会"看起来更快"）；拐点（knee point）定义：延迟开始爬升而吞吐不再增长的位置，即实际容量。口径不统一，两份报告就无法对比 |

> 本组三页的初稿已在仓库中：[performance-test-strategy.md](performance/performance-test-strategy.md)、[workload-modeling.md](performance/workload-modeling.md)、[kpi-definitions.md](performance/kpi-definitions.md)，评审后搬入 Confluence。

### 3.2 Tooling

| Page | 内容 |
|---|---|
| **Tool Comparison & Selection** | JMeter vs k6 vs Locust vs Gatling 选型对比：脚本语言、协议支持、分布式能力、CI 集成、学习成本；**写明团队选型结论和理由**——让"为什么选它"只被回答一次。**当前结论：k6 为主力**——本系统是 REST + WebSocket 的 Web 系统，k6 脚本为 JS、原生支持 WS、`thresholds` 内置通过/失败判定、天然适合进 CI；JMeter 对 WS 和 CI 集成偏弱，保留用于存量脚本与图形化调试，不承担 WS 压测 |
| **k6 / Installation Guide** | 各平台安装方式（brew / choco / Docker）、团队统一 k6 版本号、xk6 扩展构建说明（需要自定义协议或特殊输出时）、常见安装问题 |
| **k6 / Getting Started** | 新人最小上手路径：第一个脚本（`options.stages` 阶梯加压 + `thresholds` 断言 + `check` 校验响应体）、`k6 run -e BASE_URL=... script.js` 运行方式、输出怎么读（P95/P99、`http_req_failed` 与 `checks` 失败分开看）。目标：新人半天内独立跑通一个冒烟压测（1~5 VU、1 分钟） |
| **k6 / Scripting Standards** | 环境地址、账号、token 一律走 `__ENV` 外置，禁止硬编码；**通过/失败标准写进脚本 `thresholds`**，随脚本执行自动判定，不靠人肉看报告；`check` 失败与 HTTP 失败分开统计（返回 200 但响应体错误也是错误）；用 `sleep` 模拟真实 think time（0 等待测的是错误的东西）；命名约定与目录结构、公共模块引用方式 |
| **k6 / Scenarios & Load Profiles** | scenarios/executors 用法：交易类接口用 `constant-arrival-rate` 按目标 TPS 恒定打量（固定 VU 在系统变慢时会"自动降压"，测出假容量）、`ramping-vus` 做爬坡与突发、多场景并行（REST 下单 + WS 行情订阅在同一脚本混压）的写法 |
| **k6 / CI Integration** | CI 性能冒烟：低负载 + `thresholds` 阈值断言，每次合码跑约 2 分钟，性能劣化即流水线变红；结果输出对接时序库/Grafana 做长期趋势曲线 |
| **k6 / FAQ & Troubleshooting** | 先标定压测机与工具自身容量，避免把工具极限当成系统极限；WS 大量长连接的 OS 参数（ulimit、临时端口范围）；其余按实际问题积累 |
| **JMeter / Installation Guide** | 各平台安装步骤（含 JDK 版本要求）、团队统一 JMeter 版本号、必装插件清单（Plugins Manager、PerfMon、Ultimate Thread Group）、常见安装报错解决办法 |
| **JMeter / Getting Started** | 新人最小上手路径：录制或手写第一个脚本、参数化（CSV Data Set）、断言、聚合报告怎么看。目标：新人半天内独立跑通一个压测 |
| **JMeter / Scripting Standards** | 脚本规范：命名约定、目录结构、参数必须外置（禁止硬编码环境地址）、公共组件引用方式。这是 Assets 模块能维护得住的前提 |
| **JMeter / Distributed Testing & CI** | 分布式压测（master/slave）搭建、命令行无 GUI 执行、CI 流水线接入说明 |
| **JMeter / FAQ & Troubleshooting** | OOM 的 JVM 参数调整、GUI 卡顿、证书问题等，按实际问题积累 |
| **Monitoring & Profiling** | 压测观测面：Grafana Dashboard 链接、APM 工具入口、服务端资源监控怎么看。压测不看服务端指标等于白压。附**可观测性需求清单**（系统开发期就作为正式需求提给开发，越晚补越贵）：全链路 trace id（网关→风控→报盘→回报）、关键环节时间戳打点（能拆出分段耗时）、Prometheus 格式指标暴露（接口延迟直方图、队列深度、连接数）、压测流量标识 header（便于压测数据隔离与清理） |

> k6 与 JMeter 两组结构互为模板；未来引入其他工具时，在 Tooling 下平行再建一组。

### 3.3 Environment & Data

| Page | 内容 |
|---|---|
| **Load Test Environments** | 压测专用环境清单、与生产的配置差异（缩容比例）、申请和预约流程。**当前阶段（无独立压测环境）**：在功能测试环境跑低负载相对基线与 CI 性能冒烟——结论只用于趋势对比和暴露实现级问题，不外推生产容量；压测环境到位后补齐与生产的差异折算说明并在报告中声明 |
| **Test Data Preparation** | 铺底数据构造（脚本入口、数据量级标准）、账号池管理。**造数工厂**：幂等、规模参数化（100 户调试 / 10 万户压测）的批量开户、注资、建持仓、合约生成脚本，功能测试同样可复用；空库压测没有意义——很多问题（执行计划劣化、内存占用）只在生产级数据量下出现，铺底量级要贴近业务量模型的假设 |
| **Load Testing Policy** | 压测纪律：哪些环境禁止压、压测前通知谁、限流和熔断的处理。做成必读页并附审批模板——避免把共享环境打挂 |

### 3.4 Performance Assets（资产建设）

让性能测试从"一次性项目"变成"可复用能力"的模块。

| Page | 内容 |
|---|---|
| **Script Repository** | 脚本仓库（Git）入口与目录结构说明；场景索引表：场景 → 脚本路径 → 维护人 → 最后验证日期 |
| **Scenario Library** | 可复用压测场景库，每个场景用**统一规格模板**描述：场景名、负载模型（各接口 TPS 配比）、加压方式、数据前提、通过标准。优先建六类：①单接口基准 ②混合日常负载 ③开盘突发（spike）④行情洪峰下的交易延迟（WS 满载 + 下单）⑤稳定性（soak ≥ 4h）⑥查询风暴（大量客户同时刷持仓）。另建**高负载下的 E2E 用户体验场景**：API 层压测进行的同时，用 5~10 个 Playwright 会话测量真实用户的页面体验（首屏、行情刷新延迟、下单到回报的界面响应）——API 层出容量数据，E2E 层出体验数据；在 Test Automation 模块放链接指向此页，避免两处维护 |
| **Reusable Components** | 公共函数（k6 共享 JS 模块、JMeter JSR223 片段）、通用参数化文件、登录鉴权/加密/签名等前置处理的封装、数据关联套路（下单返回 orderId 供撤单用） |
| **Asset Maintenance Rules** | 资产保鲜机制：接口变更时谁负责更新脚本、每季度对场景库做有效性验证。没有这页，资产库半年后就是废墟 |

### 3.5 Baselines & SLOs

| Page | 内容 |
|---|---|
| **Performance Baselines** | 核心接口/链路基线表（版本、TPS、P95/P99、资源水位），每次大版本刷新。没有基线，压测报告就没有"变好还是变坏"的结论。**当前阶段先建 CI 低负载相对基线**（功能环境、小并发下各 P0 接口的延迟与单机吞吐）：价值不在预测生产容量，而在暴露实现级问题（N+1 查询、缺索引、同步阻塞）并防止性能在开发期悄悄劣化——避免第一次正式压测才发现延迟是目标的 50 倍 |
| **SLO & Pass/Fail Criteria** | 性能验收标准：比什么（对比基线还是对比 SLO）、劣化多少算不通过（如 P95 劣化 >10% 需审批）。标准同时落进 k6 脚本的 `thresholds`，每次执行自动判定——**没有通过/失败标准的压测是演示，不是测试** |

### 3.6 Execution Runbook

| Page | 内容 |
|---|---|
| **Execution SOP** | 一次完整压测的标准流程 Checklist：压前检查（环境、数据、通知）、压中观测、压后恢复。**首轮执行顺序**（压测环境到位后）：压测工具自身容量标定 → Smoke → 单接口基准 → 单链路（下单全链路）→ 混合负载 → 突发/行情洪峰 → 稳定性 → 故障场景（主备切换），每轮之间预留瓶颈分析与调优时间——性能测试是"测试-分析-调优"的循环，不是一次性验收。方法纪律：单次只改一个变量；先预热（缓存/JIT/连接池）再测量；关键结果复跑一遍确认可重复 |
| **Result Analysis Guide** | 从聚合报告和监控定位瓶颈：应用/数据库/中间件；常见瓶颈模式（连接池打满、慢 SQL、GC 频繁）的判断特征；结合分段打点把端到端延迟拆到具体环节 |
| **Report Template** | 统一压测报告模板，结构固定：本次要回答的问题 → 结论（PASS/FAIL 一句话）→ 环境与数据量级（含缩容折算说明）→ 分阶段指标表（VU / RPS / P50 / P95 / P99 / 错误率）→ 拐点位置 → 瓶颈假设 → 建议与遗留风险 |

### 3.7 Reports & Case Studies

| Page | 内容 |
|---|---|
| **Release Performance Reports** | 按版本归档的正式压测报告（用 3.6 的模板生成） |
| **Tuning Case Studies** | 调优案例沉淀：慢 SQL 发现过程、JVM 参数调整前后对比等。团队性能能力真正的复利来源 |

### 3.8 Frontend / Web Performance（前端性能）

> 与 API 压测回答的是不同的问题：API 压测测"服务器能扛多少并发"，前端性能测"单个用户的浏览器里页面有多快"——变量是资源体积、JS 执行、渲染管线、设备性能，与并发无关。交易 Web 还有第三类独有问题：**高频行情推送下的持续渲染性能**（掉帧、内存泄漏），这是本模块的重心。前端"压测"= 单浏览器 + 高数据速率 + 长时间 + 弱设备模拟，不是开 1000 个浏览器。

| Page | 内容 |
|---|---|
| **Strategy & Performance Budgets** | 三层测试模型：①加载性能（Core Web Vitals：LCP / INP / CLS + TTFB + bundle 体积）②运行时性能（行情推送渲染、交互延迟、大列表、挂机 soak）③高负载下的真实体验（与 3.4 的 E2E 场景联动）。关键用户旅程清单：登录→工作台首屏、订阅行情、下单→回报确认显示、切换合约、打开 K 线。**性能预算表 v0**（示例：工作台 LCP < 2.5s @ 4x CPU 节流、下单点击→界面确认 P95 < 200ms、行情 20 msg/s 掉帧率 < 5% 且无 >200ms 长任务、8h 挂机 JS 堆增长 < 50MB、首屏 bundle < 300KB gzip）——数值先拍 v0 并显式记录假设，上线后用 RUM 数据修正；所有 lab 测试统一在 CPU 4x 节流下跑，否则开发机上永远是绿的 |
| **Playwright Perf Testing Guide** | **选型结论：前端性能统一用 Playwright + CDP**——登录后 SPA 场景 Lighthouse 覆盖不了，且可复用 ui-automation 的 fixtures、页面对象与 `storageState` 登录态，不另引入 Lighthouse CI / Sitespeed，少一套工具栈。采集方法：CDP tracing 拿帧率与 Long Task、`performance.memory` 拿堆内存、PerformanceObserver 拿 LCP/INP/CLS、自定义打点（下单点击→回报确认渲染完成）。工程约定：性能场景放**独立 Playwright project**（固定 workers=1 + CPU/网络节流配置，与功能回归的并行策略冲突，不能混跑）；断言即预算——超预算测试失败，与 k6 `thresholds` 同一哲学 |
| **Mock Market Data Feeder** | 可控速率 WS 行情推送器：阶梯速率（5 / 20 / 50 msg/s）、录制数据回放、随机与突发模式；让前端性能测试完全不依赖后端进度，是前端运行时测试的**核心资产**。本页写使用方式、参数说明与维护人 |
| **Frontend Scenario Library** | ①工作台首屏加载（节流条件下）②行情阶梯推送下的帧率与长任务 ③下单交互延迟 ④大列表渲染与滚动（验证虚拟滚动真的生效）⑤挂机 soak（4~8h 内存增长曲线与帧率趋势）⑥高负载下的体验（与 3.4 Scenario Library 的 E2E 场景同源，互相链接）。每个场景同样用统一规格模板：前置数据、推送速率、观测指标、预算阈值 |
| **CI Tiers & Budget Gates** | 合码级（分钟）：bundle 体积预算（size-limit，最便宜的性能门禁，第一个上）+ 首屏加载与关键交互延迟断言；nightly（小时）：行情阶梯推送 + 2~4h 挂机 soak；趋势数据入时序库/Grafana，与 API 侧共用看板 |
| **RUM & Field Data** | 上线前接入 web-vitals 上报（Sentry / Datadog / Grafana Faro 或自建）；lab 是假设、field 是校准——用真实用户的设备与网络分布回头修正性能预算和节流参数；RUM 指标同时是 Quality Metrics 模块的数据源之一 |

### 3.9 模块首页导读 — 当前阶段 Roadmap（资产建设期）

> 放在 Performance Testing 模块首页。这是**有时效的阶段性计划**，不是长期规范：压测环境到位、首轮压测完成后归档（可移入 Reports & Case Studies）。

**背景**：系统全新开发中，暂无独立压测环境。当前目标是**资产建设**——性能测试约 70% 的工作量（建模、场景、脚本、数据、可观测性）不需要压测环境，做到"环境到位第一天就能开跑"，而不是环境到位后再花一个月准备。

| 步骤 | 做什么 | 产出落到哪页 |
|---|---|---|
| 1 | API 清单与链路分级（P0/P1/P2 + WS 推送通道） | Workload Modeling |
| 2 | 假设驱动的业务量模型 v0 + 目标容量表（假设显式记录，上线后修正） | Workload Modeling / KPI Definitions |
| 3 | 场景规格文档（六类优先场景 + E2E 体验场景） | Scenario Library |
| 4 | k6 脚本开发，在功能环境用 1 并发验证正确性（鉴权、参数化、数据关联） | Script Repository / k6 子树 |
| 5 | 测试数据工厂（幂等、规模参数化的造数脚本） | Test Data Preparation |
| 6 | 可观测性需求提给开发（trace id、分段打点、指标暴露、压测流量标识） | Monitoring & Profiling |
| 7 | CI 性能冒烟 + 低负载相对基线 | k6 / CI Integration、Performance Baselines |
| 8 | 前端关键旅程清单 + 性能预算 v0 | Frontend / Strategy & Performance Budgets |
| 9 | bundle 体积预算进 CI + Mock 行情推送器开发 | Frontend / CI Tiers & Budget Gates、Mock Market Data Feeder |
| 10 | Playwright + CDP 首个运行时场景（行情帧率 + 下单交互延迟），随后 nightly 挂机 soak | Frontend Scenario Library |

前端部分（8~10）完全不依赖压测环境，可与 API 侧并行推进；环境到位后，按 Execution SOP 的首轮执行顺序开跑。

### 建设顺序建议

不按编号顺序建，按"解决最急的问题"排序：

1. **Tooling**（Installation + Getting Started + Scripting Standards）+ **Load Testing Policy** —— 解决"新人能不能跑起来、会不会闯祸"
2. **Baselines** + **Report Template** —— 让每次压测的产出可对比、可归档
3. **Strategy & Workload Model** + **Performance Assets** —— 慢功夫，随场景积累逐步填充
4. **Tool Comparison** 如果选型已定，一页纸记录结论即可，不必展开
5. **Frontend / Web Performance** 与 API 侧并行：先建 Strategy & Performance Budgets + Mock Market Data Feeder——前端性能测试不依赖压测环境，是当前阶段就能全速建设的部分
