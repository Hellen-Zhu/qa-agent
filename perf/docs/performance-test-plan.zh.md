# 性能测试计划（公司模板版）

> `performance-test-plan.md` 的中文对照版（已脱敏：内部系统代号不出现）。与 `test-plan.md` 分工：那份跟踪阶段推进与 gap，本文对齐公司签核模板结构。按节粘贴进内部 Confluence 模板时自行恢复内部系统名。标记 **TBC** 的条目均带 Owner——它们是正式的输入请求，不是遗漏。

---

## 1. 引言（Introduction）

### 目的（Purpose）

本文档阐述本平台性能测试的范围、方法与计划。本计划一经签核，即作为干系人对本次发布性能测试方法与范围的最终确认与批准。

本次发布的性能测试针对平台的 **API 层**（HTTP，服务端），按三个场景层级递进：**单 API 轮次**——容量摸底、目标负载下的 SLA 达标验证与回归基线，每轮只压一个端点以保证归因清晰；**混合 API 负载（mixed-API workload）**——按生产流量配比并发注入 §6.1 的 workmix（请求相互独立、无步骤间依赖），测量跨端点资源争抢下的容量；**端到端业务旅程（E2E journey）**——按依赖顺序串联 API（create → approve → update → approve），测量整笔业务的时延与业务吞吐（§6.4 E2E Peak）。韧性特征测试（stress / spike / soak）叠加在上述各层级之上。UI 渲染与 WebSocket 通道不在本周期范围内（见 §5）。

### 项目 / 发布概述（Project / Release Overview）

（沿用模板中标准的平台描述与组件清单：Gateway、Workers Backend、User Center、Notification Service、Refdata Service、Ops Service、Risk Engine、Trade Composer UI。）

测试入口为平台 Gateway；主要被测系统（SUT）为 Workers Backend（交易组合、审批工作流），及其向下游的扇出：Risk Engine（gRPC）、Notification Service 与数据库层。

---

## 2. NFR 与业务量（NFR and Volumetrics）

### NFR

| # | NFR 描述 | 参考文档链接 | 备注 |
|---|---|---|---|
| 1 | 每个 API 的响应时间 SLA（p95/p99，仅统计业务成功样本） | 性能框架 `config/slas/`（git） | **当前值为工程占位值**——正式值需与业务方开 SLA 校准会确定。Owner：业务 / QA。TBC |
| 2 | 目标负载下业务成功率 ≥ 99%（剔除技术/环境类失败，按三分类判定口径测量） | 性能框架 spec §7 | 框架强制执行的判定线 |
| 3 | 持续峰值：峰值量下运行 8 小时无劣化（soak） | 本计划 §6.4 | 与公司耐久性要求对齐 |
| 4 | 目标负载下，网关按用户限流不得成为约束瓶颈 | 2026-08-04 实测（429 分析） | 需专用账号池扩容或限流策略决策二选一。Owner：平台 |

### 业务量与流量（Volumetrics and Flows）

| SN | 业务量 / 流量描述 | 类型 | 量级 | 信息来源 |
|---|---|---|---|---|
| 1 | 峰值小时建单量（maker create） | API | **TBC——需生产流量画像** | Owner：业务/架构。§6.1 workmix 的阻塞性输入 |
| 2 | 峰值小时改单量（update）——管理层已定调为未来高频操作 | API | **TBC** | 同上 |
| 3 | 峰值小时 checker 审批量 | API | **TBC**（≈ create + update 量之和） | 1–2 确定后可推导 |
| 4 | 峰值小时查询/详情浏览量 | API | **TBC** | 同上 |
| 5 | 实测容量参考（dev 性能环境）：40 VU 内线性扩展 ≈ 120 req/s，p95 ~330 ms（create），CPU < 10%——拐点尚未出现 | 实测 | n/a | 性能框架 ladder 轮次 2026-08-04/05 |

### API

| SN | API 端点 | 微服务 | NFR 量级 | SLA (p95/p99 ms) | 限流 | 信息来源 |
|---|---|---|---|---|---|---|
| 1 | GET /api/v1/trades | Workers Backend | TBC | 300 / 800 * | 网关按用户限流（阈值 TBC） | SLA：占位值，待校准 |
| 2 | GET /api/v1/trades/{id} | Workers Backend | TBC | 300 / 800 * | 同上 | 同上 |
| 3 | POST /api/v1/trades/create | Workers Backend | TBC | 800 / 2000 * | 同上 | 同上 |
| 4 | POST /api/v1/trades/{id}/update | Workers Backend | TBC | 800 / 2000 * | 同上 | 同上 |
| 5 | GET /api/v1/trades/{tradeId}/risk-metrics | Workers Backend (+ Risk Engine) | TBC | 500 / 1500 * | 同上 | 同上 |
| 6 | POST /api/v1/checker/tasks/{taskId}/approve | Workers Backend | TBC | 500 / 1500 * | 同上 | 同上 |
| 7 | POST /api/v1/checker/tasks/{taskId}/reject | Workers Backend | TBC | 500 / 1500 * | 同上 | 契约尚未校准 |
| 8 | GET /api/v1/notifications/unread-count | Notification Service | TBC | 200 / 500 * | 同上 | 同上 |
| 9 | POST /api/v1/trades/{id}/calculate-risk（+ partial-novation / for-new 变体） | Workers Backend + Risk Engine | TBC | TBC | 同上 | 契约待采集（P0 phase-W 剩余项） |
| 10 | POST /api/v1/trades/{id}/trigger-event | Workers Backend | TBC | TBC | 同上 | 生命周期事件阶段（P1） |

\* 工程占位值——正式 SLA 校准待定（NFR #1）。

---

## 3. 环境（Environment）

### 3.1 性能测试环境分析（Performance Test Environment Analysis）

| 环境属性 | 生产环境规格 | 性能环境规格 | 差异及其对结果有效性的影响 |
|---|---|---|---|
| 服务部署 | 多节点 / 高可用（TBC——与平台确认） | 平台全部服务共置于单台主机 | 共置导致服务间共享 CPU；按服务归因采用进程级（JVM）CPU；在获得类生产环境之前，绝对容量数字须标注"仅限性能环境" |
| 负载均衡 | Gateway + LB（TBC） | 单实例，无 LB | 无法测量水平扩展行为；结果刻画的是单节点容量 |
| 数据库 | 生产级规格（TBC） | 共享 dev 数据库实例 | 存量数据低于生产 ⇒ 查询结果偏乐观；用水位纪律缓解（向类生产量级增长、每轮记录水位、仅在同一水位带内比较） |
| 存量数据量 | 生产量级 | 目前远低于生产 | 同上——读路径容量结论在水位达标前打折扣 |
| 限流 | 网关按用户限流（策略 TBC） | 同一限流器生效 | 账号池过小时测到的是限流器而非系统；用 20 maker + 20 checker 专用账号缓解；豁免决策待定（RAID R2） |
| 监控 | Prometheus + Grafana + OTel 探针 | 同一套栈、同一实例 | 无差异——反而是优势：观测口径完全一致 |

### 3.2 端到端性能测试分析（End to End Performance Test Analysis）

**交易端到端流程**（状态机）：

```
create (maker) ──► PENDING APPROVAL ──► approve (checker) ──► LIVE ──► update (maker) ──► PENDING APPROVAL（改单循环）
                                                                └────► 生命周期事件（P1 范围）
```

负载下实测的组件扇出（后端看板）：Gateway → Workers Backend → Risk Engine（gRPC，风险路径约 5 倍请求放大）、Notification Service、数据库（各服务独立 HikariCP 连接池）。

| E2E 组件 | 范围内/外 | 理由 | 缓解措施 |
|---|---|---|---|
| Gateway | 内 | 唯一入口；全部 API 负载经过 | — |
| Workers Backend | 内 | 核心编排层；主 SUT | — |
| Risk Engine | 内（间接） | 经 risk-metrics / calculate-risk 扇出触达 | 后端看板监控 gRPC 出入速率 |
| Notification Service | 内 | unread-count 为 P0 API + 交易写操作的下游 | — |
| User Center | 内（间接） | 每个请求都经身份解析（X-User-Id） | — |
| Refdata Service | 内（间接） | 交易流程内的参考数据查询 | 本周期不单独设定负载目标 |
| Ops Service | 外 | 本次发布无 P0 API | 若后续发布增加 ops 路径负载再评估 |
| Trade Composer UI | 外 | 本周期为 API 层测试；UI 增加的是浏览器渲染，不增加服务端负载 | 如有需要另行跟踪 UI 性能 |

---

## 4. RAID

### 风险与问题（Risk and Issues）

| # | 风险/问题描述 | 严重度 | 概率 | 缓解计划 | Owner |
|---|---|---|---|---|---|
| R1 | 生产流量画像（volumetrics）缺失——达标测试的目标负载无法定义 | 高 | 高 | 经本计划 §2 正式提出输入请求；过渡期继续容量摸底（"系统能做到多少"的数字） | 业务 / 架构 |
| R2 | 网关按用户限流封顶可施加的负载（已观察到 429） | 高 | 中 | 已申请 20+20 专用账号；请求决策：限流豁免 vs 保留端到端口径 | 平台 / QA lead |
| R3 | 专用 PERF portfolio 尚未创建——测试交易目前落入真实业务 portfolio，削弱清理键 | 中 | 高 | 优先创建 PERF portfolio；过渡期按时间窗 + counterparty 特征清理 | 环境组 |
| R4 | 无级联清理脚本——铺底数据持续累积，水位漂移破坏轮次间可比性 | 中 | 高 | 申请清理脚本（portfolio + 时间窗为键，级联至任务/审计表）；过渡期每轮记录水位 | 环境组 |
| R5 | checker 权限按 product 维度授予——账号缺某 productType 会对部分流量静默 403 | 中 | 中 | 账号申请明确覆盖用例池全部 productType；403 归因规则已文档化 | QA |
| R6 | 共享 dev 环境——其他用户的活动污染测量窗口 | 中 | 中 | 错峰执行窗口；熔断阈值保护环境；指标按 testid 隔离 | QA |
| R7 | SLA 为占位值——校准前判定仅具工程意义 | 中 | 高 | SLA 校准会（NFR #1）；校准后才晋升基线 | 业务 / QA |

### 关键假设与依赖（Key Assumptions and Dependencies）

| # | 假设/依赖 | 依据 | 影响 | Owner |
|---|---|---|---|---|
| A1 | 性能环境的鉴权模型维持 X-User-Id 头部身份（无 token 生命周期） | 实测行为 | soak 场景无需 token 刷新逻辑 | 平台 |
| A2 | 响应信封契约（code/status/msg/data）与 msg 内嵌 TaskId 格式跨版本保持稳定 | 2026-08-05/06 校准 | 契约漂移会破坏 seed 流水线与分类；每次发布跑一轮 smoke 可探测 | 开发 |
| A3 | 错误语义：权限 = HTTP 403、状态冲突 = HTTP 400、限流 = 429 | 2026-08-06 实测 | 失败归因规则依赖于此 | 开发 |
| A4 | k6 施压端与后端共用同一 Prometheus 实例 | 2026-08-04 确认 | 客户端与服务端指标可单屏关联 | 平台 |
| A5 | 专用账号（20 maker / 20 checker）将获批 | 待定 | 没有它们，被测对象就是限流器 | 平台 |

---

## 5. 范围（Scope）

### 接口（Interfaces）

| 接口 | 方向 | 范围内/外 | 不在范围的理由 |
|---|---|---|---|
| 经 Gateway 的 REST API | 入站 | 内 | — |
| 服务间 gRPC 调用 | 内部 | 内（观测，不直接注入） | 负载从 REST 进入；gRPC 作为扇出被监控 |
| WebSocket / 实时消息 | 入站 | 外 | 规划为下一阶段（P2）；本次发布无新增 WebSocket API |
| UI（Trade Composer） | 入站 | 外 | 本周期为 API 层测试；UI 不产生这些 API 之外的服务端负载 |
| 批处理接口 | — | N/A | 本平台无批处理流程；清算批处理属另一平台，有其独立性能报告 |

### API

| 接口 | 范围内/外 | 不在范围的理由 |
|---|---|---|
| GET /api/v1/trades；GET /api/v1/trades/{id}；GET .../risk-metrics；GET /api/v1/notifications/unread-count | 内 | — |
| POST /api/v1/trades/create；POST /api/v1/trades/{id}/update | 内 | — |
| POST /api/v1/checker/tasks/{taskId}/approve、/reject | 内 | — |
| POST calculate-risk ×3 变体 | 内（phase-W 剩余项，契约待采集） | — |
| POST /api/v1/trades/{id}/trigger-event | 内（生命周期阶段 P1） | — |
| POST /api/v1/checker/tasks/bulk-approve、/bulk-reject | 不作为测量对象 | 运维/工具类端点（仅作铺底加速器）；非用户侧峰值负载；且非本次发布新增 |
| GET /api/v1/checker/tasks/pending | 不作为测量对象 | 已降级为运维工具——TaskId 随写响应 msg 返回，热路径从不调用它 |

---

## 6. 测试方法（Test Approach）

### 6.1 API/UI/实时消息工作配比（Workmix）

**用户/注入线程拆分**（速率待业务量校准——当前值为容量摸底设置，每小时迭代数 = 速率 × 3600）：

| 场景流 | 用户/线程数 | 每小时迭代数 |
|---|---|---|
| trades-query（读混合） | open 模型，目标 2–20 req/s（摸底） | 7,200–72,000 |
| trades-create（maker） | open 模型，目标速率 TBC，待对齐业务量 | TBC |
| trades-update（maker，消耗型 LIVE 池） | open 模型，目标速率 TBC——管理层定调的高频路径 | TBC |
| checker-approve（checker，消耗型任务池） | open 模型，≈ create+update 速率之和 | TBC |
| 容量摸底（ladder） | closed 模型，10→20→40→80 VU 阶梯 | n/a（找拐点） |

**场景流描述**

| 场景 | 动作 | 动作 | 动作 | 动作 |
|---|---|---|---|---|
| 交易生命周期（E2E，P1） | Create（Maker） | Approve（Checker） | Update（Maker） | Approve（Checker） |
| 单 API 轮次 | 每场景单一动作（隔离以保证归因） | | | |

### 6.2 数据需求（Data Requirements）

| 数据需求 | 数据来源 | Owner |
|---|---|---|
| 建单用例行（productType + 归属三字段）——从真实 curl 同源采集；2026-08-06 已按真实响应校准结构 | 系统 UI + DevTools 抓取；仓库内放占位值，真实值仅存性能环境 | QA |
| update 用的消耗型 LIVE trade 池（每请求消耗一个 id） | seed 流水线：create→approve，exactly-once 游标，量级 preflight ≥ 计划量 ×1.2 | QA（框架自动化） |
| approve 用的消耗型待审任务池 | seed 流水线（仅 create，TaskId 从响应 msg 收割） | QA |
| 读场景（detail / risk-metrics）用的 trade ID 池 | 复用铺底交易（读也可用真实存量数据） | QA |
| 身份池：20 maker + 20 checker 账号，checker 覆盖全部 productType | 账号开通申请 | 平台 |
| 存量数据水位接近生产量级，达标后维持在水位带内；每轮记录水位 | 环境 + 数据工厂（未来）；清理脚本（RAID R4） | 环境组 |
| 数据不是生产切片 | 经业务 API 合成（构造上即全保真） | — |

### 6.3 峰值批处理测试流（Peak Batch Test Flows）

**N/A。** 本平台无批处理流程；清算批处理位于另一平台，由其独立性能报告覆盖。没有批处理交互与被测 API 路径重叠。

### 6.4 API/UI/实时消息测试类型（Test Types）

| 测试类型 | 描述 | 用户/线程设置 |
|---|---|---|
| Peak（峰值） | 生产峰值 × 1.5–2 安全系数下的 SLA 达标验证（目标待业务量确定）；连续 3 轮稳定为基线晋升门槛 | open 模型（恒定到达率），速率 = 目标值；每轮约 10 分钟 |
| E2E Peak（端到端峰值） | 峰值配比下的完整生命周期旅程（create→approve→update→approve） | P1 阶段；双身份旅程场景 |
| Stress（压力） | 越过拐点后的行为：失效模式、错误起始点、卸载后恢复 | open 模型爬坡越过实测拐点；熔断器保护共享环境 |
| Soak（浸泡） | 峰值量运行 8 小时；p95 无漂移、无泄漏（heap/GC 趋势平稳） | open 模型按峰值速率；消耗池按全时长备足 |
| 容量摸底（附加） | Peak 目标确定前，用阶梯式 closed 模型定位拐点 | ramping-vus 10/20/40/80，每台阶 5 分钟 |

公司要求的四种类型全部执行——无需"省略理由"说明。本次发布的新增 API 按 API 治理要求覆盖接口、soak 与 stress 三个层级。

### 6.5 工具与监控（Tooling and Monitoring）

| 工具/监控 | 用途 | 覆盖 |
|---|---|---|
| k6（+ 零依赖 runner） | 负载注入；三分类判定（technical/business/script）+ 业务口径成功率；精确的整轮终值统计 | 全部场景；每轮 PASS/FAIL |
| Prometheus（共享实例） | k6 remote-write（5s 窗口）+ 后端 OTel 指标 | 客户端与服务端序列，同一实例 |
| Grafana — Perf Trade Overview 看板 | 对账卡（精确计数 = summary）、趋势、容量行（负载/吞吐/响应时间 + XY 图）、服务端利用率/饱和度、运行历史 | 按 testid；env/profile 过滤 |
| Grafana — 官方 k6 看板（19665） | k6 原生细节，含 HTTP 分阶段耗时（blocked/connect/TLS/wait/receive） | 深挖诊断 |
| 后端 OTel 看板 | 各服务 HTTP RED、gRPC 出入、JVM CPU/heap/线程、**GC**、HikariCP 连接池（active/pending/timeouts） | **CPU ✓ 内存 ✓ GC ✓**；**IO：缺口**——主机级 IO 尚未接入（已标记；已申请 DB 主机指标） |
| k6 web dashboard | 运行中实时观察（:5665） | 非权威口径 |
| report.html（每轮） | 面向业务/领导的单文件分享报告，精确口径 | 每轮 |
| 产物归档 | summary.txt/json（判定权威）、CSV 逐请求明细、k6 日志（UTC）、环境 manifest、每轮水位 | 每轮，全程可追溯 |

### 6.6 执行检查清单（Execution Checklist）

**执行前后检查清单**

| 活动 | 描述 | Owner |
|---|---|---|
| 环境清单全绿 | 账号有效、服务可达、契约经 smoke 核验 | QA |
| 铺底消耗池 | seed 流水线 → 收割 → 激活池文件；量级 ≥ 计划量 ×1.2 | QA |
| 记录水位 | 存量数据量写入运行 manifest；仅在同一水位带内比较 | QA |
| Smoke（单发） | 1 VU、1 次迭代；三分类干净后才允许大轮次 | QA |
| 执行 + 实时观察 | 按 profile 执行；熔断阈值保护共享环境 | QA |
| 对账 | summary 与 Grafana 对账卡必须逐项精确一致 | QA |
| 判定 + 基线 | 连续 3 轮 PASS 稳定 → 取中位轮晋升为基线；此后回归自动标红 | QA |
| 清理 / 重铺 | 已消耗的池即为脏池——重跑前必须重铺；按 portfolio + 时间窗清理（脚本待建，RAID R4） | QA / 环境 |
| 缺陷跟踪 | 问题录入 JIRA 项目（链接），附运行产物 | QA |
