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
│   ├── JMeter
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
└── 7. Reports & Case Studies           报告归档与调优案例
    ├── Release Performance Reports
    └── Tuning Case Studies
```

### 3.1 Strategy & Workload Model

| Page | 内容 |
|---|---|
| **Performance Test Strategy** | 什么类型的改动必须做性能测试（触发规则）；测试类型定义——Load / Stress / Spike / Soak / Capacity 各自的适用时机 |
| **Workload Modeling** | 业务流量模型：核心接口清单、各接口流量占比（来源于生产监控数据）、峰值场景（大促/月底结算等）构造方法 |
| **KPI Definitions** | 指标口径统一定义——TPS、RT P95/P99、错误率、饱和度指标怎么算。口径不统一，两份报告就无法对比 |

### 3.2 Tooling

| Page | 内容 |
|---|---|
| **Tool Comparison & Selection** | JMeter vs k6 vs Locust vs Gatling 选型对比：脚本语言、协议支持、分布式能力、CI 集成、学习成本；**写明团队选型结论和理由**——让"为什么用 JMeter"只被回答一次 |
| **JMeter / Installation Guide** | 各平台安装步骤（含 JDK 版本要求）、团队统一 JMeter 版本号、必装插件清单（Plugins Manager、PerfMon、Ultimate Thread Group）、常见安装报错解决办法 |
| **JMeter / Getting Started** | 新人最小上手路径：录制或手写第一个脚本、参数化（CSV Data Set）、断言、聚合报告怎么看。目标：新人半天内独立跑通一个压测 |
| **JMeter / Scripting Standards** | 脚本规范：命名约定、目录结构、参数必须外置（禁止硬编码环境地址）、公共组件引用方式。这是 Assets 模块能维护得住的前提 |
| **JMeter / Distributed Testing & CI** | 分布式压测（master/slave）搭建、命令行无 GUI 执行、CI 流水线接入说明 |
| **JMeter / FAQ & Troubleshooting** | OOM 的 JVM 参数调整、GUI 卡顿、证书问题等，按实际问题积累 |
| **Monitoring & Profiling** | 压测观测面：Grafana Dashboard 链接、APM 工具入口、服务端资源监控怎么看。压测不看服务端指标等于白压 |

> 未来引入第二个工具（如 k6）时，在 Tooling 下平行建一组，结构复用 JMeter 的模板。

### 3.3 Environment & Data

| Page | 内容 |
|---|---|
| **Load Test Environments** | 压测专用环境清单、与生产的配置差异（缩容比例）、申请和预约流程 |
| **Test Data Preparation** | 铺底数据构造（脚本入口、数据量级标准）、账号池管理 |
| **Load Testing Policy** | 压测纪律：哪些环境禁止压、压测前通知谁、限流和熔断的处理。做成必读页并附审批模板——避免把共享环境打挂 |

### 3.4 Performance Assets（资产建设）

让性能测试从"一次性项目"变成"可复用能力"的模块。

| Page | 内容 |
|---|---|
| **Script Repository** | 脚本仓库（Git）入口与目录结构说明；场景索引表：场景 → 脚本路径 → 维护人 → 最后验证日期 |
| **Scenario Library** | 可复用压测场景库：单接口基准场景、核心链路混合场景、峰值场景，每个场景写清流量模型和适用版本 |
| **Reusable Components** | 公共函数（JSR223 脚本片段）、通用参数化文件、加密/签名等前置处理器的封装 |
| **Asset Maintenance Rules** | 资产保鲜机制：接口变更时谁负责更新脚本、每季度对场景库做有效性验证。没有这页，资产库半年后就是废墟 |

### 3.5 Baselines & SLOs

| Page | 内容 |
|---|---|
| **Performance Baselines** | 核心接口/链路基线表（版本、TPS、P95/P99、资源水位），每次大版本刷新。没有基线，压测报告就没有"变好还是变坏"的结论 |
| **SLO & Pass/Fail Criteria** | 性能验收标准：比什么（对比基线还是对比 SLO）、劣化多少算不通过（如 P95 劣化 >10% 需审批） |

### 3.6 Execution Runbook

| Page | 内容 |
|---|---|
| **Execution SOP** | 一次完整压测的标准流程 Checklist：压前检查（环境、数据、通知）、压中观测、压后恢复 |
| **Result Analysis Guide** | 从聚合报告和监控定位瓶颈：应用/数据库/中间件；常见瓶颈模式（连接池打满、慢 SQL、GC 频繁）的判断特征 |
| **Report Template** | 统一压测报告模板：结论先行（通过/不通过）、与基线对比、瓶颈分析、遗留风险 |

### 3.7 Reports & Case Studies

| Page | 内容 |
|---|---|
| **Release Performance Reports** | 按版本归档的正式压测报告（用 3.6 的模板生成） |
| **Tuning Case Studies** | 调优案例沉淀：慢 SQL 发现过程、JVM 参数调整前后对比等。团队性能能力真正的复利来源 |

### 建设顺序建议

不按编号顺序建，按"解决最急的问题"排序：

1. **Tooling**（Installation + Getting Started + Scripting Standards）+ **Load Testing Policy** —— 解决"新人能不能跑起来、会不会闯祸"
2. **Baselines** + **Report Template** —— 让每次压测的产出可对比、可归档
3. **Strategy & Workload Model** + **Performance Assets** —— 慢功夫，随场景积累逐步填充
4. **Tool Comparison** 如果选型已定，一页纸记录结论即可，不必展开
