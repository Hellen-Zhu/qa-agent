# OREO 性能测试计划（Performance Test Plan）

> **Confluence 位置**：Testing & Quality → Specialized Testing → Performance Testing → 3. Test Plan & Scenario Library
> **系统**：OREO — Optimized Real-time Execution Orchestrator（FX 结构化产品全生命周期系统）
> **状态**：Draft v0.2（2026-07-29：工具主线切换为 k6；融入 p02 首轮实测与服务端监控现状） · **Owner**：待指定 · **评审人**：架构 / 后端 / 前端 / 业务运营
> **更新触发**：场景增删、NFR 变更、工程实现进度变化
> **English**：[oreo-performance-test-plan.en.md](oreo-performance-test-plan.en.md)

---

## 1. 本计划的边界

性能测试相关文档共五份，各管一层。**本页只回答"怎么证明"**，不重复定义其他层的内容：

| 文档 | 回答的问题 | 本页与它的关系 |
|---|---|---|
| [Performance Test Strategy](performance-test-strategy.zh.md) | 何时测、测什么类型、通过原则 | 本页的场景按它的类型分类与优先级排序 |
| [Workload Modeling](workload-modeling.zh.md) | 打多少量 | 本页每个场景的负载值引用它，**不自行定义** |
| [OREO NFR](oreo-nfr.zh.md) | 什么算通过 | 本页每个场景标注它验证哪些 NFR 编号 |
| [KPI Definitions](kpi-definitions.zh.md) | 怎么量 | 本页每个场景标注该报哪些指标 |
| [k6 工程 README](../../trade-performance/k6/README.zh.md) / [实操手册](../../trade-performance/k6/HANDBOOK.zh.md) | k6 怎么实现 | 本页场景落地为它的四层结构（scenarios / steps / profiles / lib） |
| [Trade API 方案 v2](../trade-api-perf-test-plan-v2-jmeter.md) | JMeter 存量实现 + API 依赖矩阵 | 依赖矩阵（§2.2）仍是 RESIL 场景的依据；JMeter 工程按 §1.1 降为交叉验证 |

**工程在 `qa/trade-performance/`：`k6/` 为主线，`jmx/` 为存量交叉验证。**

### 1.1 工具选型：k6 为主线，JMeter 存量作交叉验证

**结论**：场景库自本版起以 k6 为主线实现；已有 JMeter 资产冻结（只修不增），降为交叉验证与迁移源。

选型依据不是"哪个工具快"——p02 双实现读同一份数据源对照，量级一致（见 §3.2 首轮实测）——而是五点工程性差异：

| # | 差异 | 对 OREO 的意义 |
|---|---|---|
| 1 | **配置即代码，git diff 可评审** | JMeter 的关键行为（CSV 游标共享、作用域继承、setUp 抢行）藏在 GUI 属性里，p02 阶段踩过的坑多数源于"配置归 GUI 所有"；k6 里同类问题是显式代码，code review 可拦 |
| 2 | **开放模型原生**（`constant-arrival-rate`） | [Workload Modeling](workload-modeling.zh.md) 的负载口径就是到达率（λ = 0.0133/s 起）。JMeter 默认 Thread Group 是闭合模型——服务端劣化时压力自动踩刹车，会系统性掩盖过载后果；开放模型需 jpgc 插件 |
| 3 | **多 scenario 单文件** | PERF-19 要求全部设计容量**同时**达标——k6 一个 options 里 N 个 scenario 各自独立到达率与起始时间，正是 S-16 / S-15 需要的形态；JMeter 需多 Thread Group + 插件拼装 |
| 4 | **thresholds 内建 SLA 判定** | 判定写进 profile，进程退出码即结论，可直接进 CI；JMeter 需自建 jtl 解析脚本 |
| 5 | **Prometheus remote-write 原生** | 压测指标与服务端指标同库同时间轴（见 [GRAFANA.zh.md](../../trade-performance/GRAFANA.zh.md) §7）；JMeter 对应插件是 pull 模型，需改 Prometheus 抓取配置——行内多一道审批 |

**如实记录 k6 的代价**：二进制 `.dat` 进不了 `SharedArray`，大文件高 VU 时每个 VU 复制一份（S-14 用最贵产品打并发前要预算压测机内存）；团队 k6 经验为零（缓解见 §8 风险 9）；CSV / 多环境参数化开箱不如 JMeter 顺手——但这份"不顺手"换来的正是显式作用域，见第 1 条。

**JMeter 资产迁移清单**（按场景优先级排序，迁一个冻一个）：

| 顺序 | 迁什么 | 服务的场景 | 状态 |
|---|---|---|:---:|
| ① | `p05-trades-list` | S-09 · S-10 | ✅ 2026-07-29（分页参数名待真实响应核实） |
| ② | `checker-task-pool` 逻辑进 `setup()` + `p03`/`p04` | S-15 · S-04 | ⬜ |
| ③ | `s01-create-trade-e2e`（含 journey 与 5 个 step） | S-03 | ✅ 2026-07-29（refdata 地址确认前以 `REFDATA_MODE=csv` 跑） |
| ④ | `p06-trigger-event` | S-15 submit 侧 · S-05 | ⬜ |

迁移完成前，对应场景可先用 JMeter 存量出数——但**两套工具的数字不混报**：计时定义有差（JMeter `elapsed` 含连接建立，k6 `http_req_duration` 不含），口径按 [KPI Definitions](kpi-definitions.zh.md) 标注工具来源。

---

## 2. 测试对象与优先级

### 2.1 业务入口（而非 API 清单）

OREO 的测试对象按**用户入口**组织，而不是按 33 个 API 平铺。理由：一次前端操作往往触发多个 API，单独测每个 API 会漏掉它们之间的资源竞争与顺序依赖。

| 入口 | 页面 | 涉及路径 | 优先级 |
|---|---|---|---|
| **Blotter 列表浏览 + 自动刷新** | Trade Portal | `GET /trades` + UC 富化 | **P0** — 请求量占比最高 |
| **New Trade（含 `.dat` 上传）** | Trade Portal | refdata → dat-to-json → calc-risk-for-new → create | **P0** — 单请求成本最高 |
| **右键生命周期事件提交** | Trade Portal | `trigger-event` / 各事件接口 | **P0** — 两阶段写路径起点 |
| **Checker 审批 / 拒绝** | Trade Portal | pending → approve / reject / bulk-* | **P0** — 两阶段写路径终点 |
| **通知轮询** | 全局 | `unread-count` / `inbox` | **P0** — 恒定负载，占比第二 |
| **View Details + risk-metrics** | Trade Portal | `GET /trades/{id}` + risk-metrics | P1 |
| **Composer 产品管理** | Composer | `/products*` / `product-field-configs` | P2 — 低频，但配置缓存影响热路径 |
| **批处理** | 无页面 | trade-aging / sync-cashflows / refdata sync | P1 — 互扰风险 |

### 2.2 不在本计划范围内

| 项 | 原因 | 处置 |
|---|---|---|
| WebSocket 推送通道 | 工具与口径均未就绪 | 缺口登记，见 [KPI Definitions](kpi-definitions.zh.md) §7 |
| UC / risk-engine / notification 内部性能 | 非本系统职责 | 只测其降级对 OREO 的影响（S-11） |
| 第三方 refdata 同步源 | 无授权压测 | 只测同步作业运行期的互扰（S-13） |
| 前端渲染细节 | 由 Frontend Performance 页覆盖 | 仅在 S-08 做联动验证 |

---

## 3. 场景库

### 3.1 场景总表

**实现状态**：✅ 已实现 · 🟨 部分实现 · ⬜ 未实现。**k6 列是主线**；JMeter 列是存量资产，按 §1.1 清单迁移，迁移前可作交叉验证出数。

| ID | 场景 | 类型 | 优先级 | 验证的 NFR | k6 | JMeter |
|---|---|---|:---:|---|:---:|:---:|
| **S-01** | **`.dat` 单请求成本画像** | Cost Profile | **1** | PERF-07~10, RES-01 | 🟨 | 🟨 |
| **S-09** | **Fan-out Audit（扇出审计）** | Fan-out | **1** | PERF-02, OBS-01, SCALE-01 | 🟨 | 🟨 |
| **S-18** | **审计完整性核对** | Integrity | **1** | AUDIT-02 | ⬜ | ⬜ |
| **S-05** | **同笔 trade 并发争用** | Contention | **2** | INTEG-03, INTEG-07, AVAIL-02 | ⬜ | ⬜ |
| **S-10** | **数据量伸缩性** | Volume Scaling | **2** | SCALE-01, PERF-02 | 🟨 | 🟨 |
| **S-14** | **并发解析上限与背压** | Resource | **2** | RES-01, RES-02 | 🟨 | ⬜ |
| **S-15** | **两阶段审批链路（maker → checker）** | Load | **2** | PERF-12~14, PERF-17, SCALE-02 | ⬜ | 🟨 |
| S-03 | Create Trade E2E（前端链路） | Load | 3 | PERF-07, PERF-11, PERF-19 | 🟨 | ✅ |
| S-11 | 下游降级隔离（UC / risk / notification） | Interference | 3 | RESIL-01, 02, 05, 06 | ⬜ | ⬜ |
| S-12 | DAT 解析 CPU / 内存竞争 | Interference | 3 | RESIL-03 | ⬜ | ⬜ |
| S-02 | Booking cutoff 峰值 | Load | 4 | PERF-07, PERF-19 | ⬜ | ⬜ |
| S-13 | 批处理与在线并行 | Interference | 4 | RESIL-04, SCALE-05 | ⬜ | ⬜ |
| S-04 | Checker 批量清队列 | Spike | 5 | PERF-15, PERF-16 | ⬜ | 🟨 |
| S-16 | 全容量混合负载 | Load | 5 | **PERF-19**, PERF-01~18 | ⬜ | ⬜ |
| S-07 | 月末 / 季末 roll | Load | 6 | PERF-20 | ⬜ | ⬜ |
| S-17 | Soak — 长交易日 | Soak | 6 | AVAIL-01, MAINT-04 | ⬜ | ⬜ |
| S-06 | 市场波动事件激增 | Spike | 7 | PERF-12, PERF-19 | ⬜ | ⬜ |
| S-08 | 联动层（后端负载 + 真实浏览器） | Combined | 8 | 前端指标 | ⬜ | ⬜ |

备注：S-18 是压测收尾的核对脚本（SQL 对账），与压测工具无关，两列同置 ⬜。S-14 的 k6 🟨 指负载形态已备（`ladder` / `arrival` profile），缺的是最贵产品数据与内存观测。

**k6 主线现有三个载体：`p02-trade-create`（S-01）、`p05-trades-list`（S-09/S-10）、`s01-create-trade-e2e`（S-03）。** 优先级 1~2 场景未完成的主因不是迁移进度，而是 [NFR](oreo-nfr.zh.md) §12.2 的能力缺口（内存打点、造数、故障注入——与工具无关）。见 §8。

### 3.2 优先级 1 — 必须先做的三个

#### S-01 `.dat` 单请求成本画像

| 项 | 内容 |
|---|---|
| **目标** | 回答"**一次** create / dat-to-json 消耗多少时间、CPU、内存"，得出并发目标与成本信封的推导依据 |
| **负载形态** | **1 并发**，遍历 **productType 代表产品**（[Workload Modeling](workload-modeling.zh.md) A26：最便宜 / 最贵 / 最常见），各 30 次取分布 |
| **变量** | **productType**。文件体积、定盘次数、schedule 长度都是 productType 的**结果**，不是独立变量 |
| **关键指标** | 单次耗时（按 productType）· **单次内存峰值** · 内存放大系数 · CPU 时间 · **耗时对成本驱动因子（定盘次数 / 文件体积）的函数形态** |
| **通过标准** | PERF-07/08/09/10 达标；**耗时随成本驱动因子呈线性或次线性** |
| **产出** | ① 各代表产品单笔耗时 → 查 [Workload Modeling](workload-modeling.zh.md) §4.7.4 表得出**并发目标**（S-14 的输入）<br>② **成本信封 A28**（各驱动因子上限）→ 新产品重测触发规则的基线 |
| **实现** | 🟨 k6 主线：`k6/scenarios/p02-trade-create.js` + `smoke` / `baseline` profile；JMeter 对照：`jmx/api/p02-trade-create.jmx`。**数据池（`create-trade-data.json`）目前只有一个 productType（FX_TRF），需按 A26 补齐代表产品**；**内存指标缺采集手段** |
| **首轮实测** | **FX_TRF（2026-07 下旬，本地 dev，k6 n=1,045）：P50 287 / P95 298 / P99 312 ms**；JMeter 同数据源对照为同一量级（P50 257~319）。按 [Workload Modeling](workload-modeling.zh.md) §4.7.4 取值规则得**并发目标 k = 2**（升到 3 的边界在单笔均值 ≈ 3.4 s）。⚠ 本地环境数字只作量级参照与回归基线起点，不外推生产 |
| **阻塞** | **OBS-02**（解析内存峰值不可观测；JVM heap 面板可在 1 并发下给粗结论）· **A24 Composer 产品目录未确认** · A26 代表产品 `.dat` 样本缺失（本地仅 FX_TRF 一份，真实样本不入库）。当前只能出 FX_TRF 的耗时结论 |

**为什么扫描维度是 productType 而不是文件档位**：文件体积是产品结构的**结果**。
现实中不存在"TARF × small"这种组合，把 productType 与 datSize 当成正交维度会生成不存在的用例。
详见 [Workload Modeling](workload-modeling.zh.md) §4.7。

**本场景的产出决定了另外两个场景怎么设计**：S-14 的并发档位来自这里的耗时实测，
S-16 的退化配比来自这里认定的"最贵产品"。**它不出结果，后面两个都设计不出来。**

**为什么它是第 1 优先级**：[Strategy](performance-test-strategy.zh.md) §4 的递进规则要求 Cost Profile 先于 Load。在不知道单次解析要 3 秒 + 2GB 的情况下打并发，得到的崩溃无法归因——你不知道是并发问题还是单请求就已经超限。首轮实测已把 FX_TRF 从这个未知里拿掉（~0.3 s）；"以秒计"的前提目前只对未测的代表产品成立——这正是 A26 扫描仍是本场景闸门的原因。

**超线性是设计缺陷信号**：若 large 档（20MB）耗时是 small 档（假设 200KB）的 100 倍以上，说明解析算法存在超线性成本，这是架构问题而非容量问题。

#### S-09 Fan-out Audit（扇出审计）

| 项 | 内容 |
|---|---|
| **目标** | 回答"1 次 blotter 列表请求触发多少次 UC gRPC 调用" |
| **负载形态** | **单请求**，遍历返回行数：50 / 200 / 500 行 |
| **关键指标** | UC gRPC 调用数 · risk-engine 调用数 · DB 查询数（各按返回行数） |
| **通过标准** | **扇出 = O(1)**，即调用数不随返回行数增长 |
| **实现** | 🟨 k6 主线已建（`k6/scenarios/p05-trades-list.js`，行数进 `oreo_trades_rows` 指标；⚠ 分页参数名沿用推断值，首次 smoke 须核对返回行数）；JMeter 对照：`jmx/api/p05-trades-list.jmx`（行数进 jtl 的 `tradesRowCount` 列）。**精确扇出计数仍缺，但粗测手段已有**（见下） |
| **阻塞** | **OBS-01**（精确扇出不可观测）——**已可降级绕过**：服务端 Prometheus 现成的 `rpc_client_duration_milliseconds_count` 按窗口取差值即得 gRPC 出站次数（见 [GRAFANA.zh.md](../../trade-performance/GRAFANA.zh.md) §5） |

**这是全计划中信息密度最高的一个场景**，成本极低（3 次请求）而结论极重：

```
若扇出 = O(1)：blotter 33 TPS → UC 33 QPS      → 无容量风险
若扇出 = O(n)：blotter 33 TPS → UC 6,600 QPS   → 首要瓶颈，需架构改造
```

两个结论对应完全不同的容量规划与优化方向。**在这个结论出来之前，[NFR](oreo-nfr.zh.md) PERF-02 的 1,500ms 阈值只是一个数字**——我们不知道它背后是 1 次还是 200 次下游调用，因此也不知道它在负载下会怎么变化。

**替代方案（OBS-01 落地前即可执行）**：安静窗口发 1 次 blotter 请求（50 / 200 / 500 行各一次），对比前后 `rpc_client_duration_milliseconds_count` 的差值——服务端 Prometheus 已经在采这个指标，不需要任何新能力。精度不如 APM trace（无法按单请求归因），但足以区分 O(1) 与 O(n)——而这个区分才是本场景的全部目的。**本场景实际上已解除阻塞**，只差安排一个安静窗口执行；DB 侧查询计数 / tcpdump 保留为兜底。

#### S-18 审计完整性核对

| 项 | 内容 |
|---|---|
| **目标** | 证明高负载下审计记录不丢失 |
| **负载形态** | **不是独立场景**——作为 S-02 / S-15 / S-16 每轮 Load 的**收尾步骤** |
| **执行** | 压测结束后核对：`审计记录数 == jtl 中成功事件样本数` |
| **通过标准** | **差值精确为 0**。非 0 即 AUDIT-02 失败，无论延迟指标多好 |
| **实现** | ⬜ 需一个收尾核对脚本 + 审计表只读权限 |
| **阻塞** | 需 DB 只读权限或一个审计计数 API |

**为什么它必须自动化而非人工抽查**：把审计写入改成异步 + 有界队列、满时丢弃，是一个**看起来能改善延迟**的常见优化。它在压测报告上表现为进步，实际是用合规风险换性能。这类变更不会有人主动声明，只能靠每轮自动核对发现。

---

### 3.3 优先级 2 — 四个高价值场景

#### S-05 同笔 trade 并发争用

| 项 | 内容 |
|---|---|
| **目标** | 验证 `pending approve` 锁在并发下的行为：互斥、无死锁、无丢更新 |
| **负载形态** | **低并发（5 / 10 / 20 线程）全部打同一笔 trade** |
| **子场景** | ① 多个 maker 同时对同一 trade 提交事件<br>② maker 提交与 checker 审批同时发生<br>③ 两个 checker 同时审批同一 task<br>④ 并发 amendment（测丢更新） |
| **关键指标** | 成功数 · 业务拒绝数 · 5xx 数 · DB 锁等待时长 · **最终状态一致性** |
| **通过标准** | 见下方决策项 |
| **实现** | ⬜ |
| **阻塞** | 无技术阻塞；**待团队确认预期行为** |

**这个场景是常规压测的盲区。** 标准压测设计让每个线程打不同的 trade（为了避免互相干扰），因此**永远不会触发**同实体争用。而四眼原则恰恰在同一笔 trade 上串行化操作——这是 OREO 最独特的并发行为，也最可能藏 bug。

> **⚠ 待团队决策：并发提交的预期行为是什么？**
>
> 断言逻辑取决于产品意图，三种都是合理设计，但**只有一种是对的**：
>
> | 选项 | 行为 | 断言 |
> |---|---|---|
> | A | 第二个请求收到明确业务拒绝（"该 trade 正在审批中"） | `count(success) == 1 && 其余为业务拒绝` |
> | B | 第二个请求排队等待，前一个完成后继续 | `count(success) == N && 状态链完整` |
> | C | 第二个请求收到 409 Conflict | `count(success) == 1 && 其余 HTTP 409` |
>
> **不可接受的行为**（无论选哪个都算失败）：静默覆盖 · 5xx · 两个都成功导致状态不一致 · 死锁超时。
>
> 这条决策需要产品/架构给出，不应由测试团队代定——它定义的是系统契约，不是测试细节。

#### S-10 数据量伸缩性

| 项 | 内容 |
|---|---|
| **目标** | 验证 blotter 查询随数据量增长的劣化曲线 |
| **负载形态** | 固定负载（blotter 设计容量 33 TPS），遍历数据量档位 |
| **数据档位** | 1,000 / 50,000 / 250,000 笔 trade |
| **关键指标** | 各档位的 P95 / P99 · 新增慢查询 · DB 执行计划变化 |
| **通过标准** | SCALE-01：250k 档 P95 ≤ 1k 档 P95 的 3 倍 |
| **实现** | ⬜ |
| **阻塞** | **造数工厂未建**（需灌 25 万笔 trade，且分布要贴近真实：多组合、多状态、多产品类型） |

**它实际是一个索引缺失探测器。** 数据量增长 250 倍而只允许 P95 劣化 3 倍，等价于要求查询走索引。若实测超过 10 倍，基本可断定存在全表扫描——这个结论比任何单点 P95 数字都有用。

**造数不能简单复制同一笔 trade 25 万次**：那样索引选择性失真，查询计划与真实情况不同，结论无效。数据分布需覆盖多 portfolio、多 counterparty、多状态、多产品类型。

#### S-14 并发解析上限与背压

| 项 | 内容 |
|---|---|
| **目标** | 验证并发 `.dat` 解析超限时**排队或拒绝，而不是 OOM** |
| **负载形态** | 两个上限取小者：<br>① **业务并发目标** K —— 由 S-01 实测耗时按 [Workload Modeling](workload-modeling.zh.md) §4.7.4 规则得出。**FX_TRF 实测 ~0.3 s → K = 2**；最贵产品未测——单笔均值超 3.4 s 则 K = 3，更慢再查 §4.7.4 表（非假设值，随 A26 扫描更新）<br>② **资源理论上限** N = 可用堆 ÷ 单次内存峰值<br>打 K-1 / K / N / N+2 / 2N 并发，全部用**最贵 productType**。k6 载体：`ladder`（闭合模型找拐点）+ `arrival`（开放模型看过载后果——闭合模型在服务端劣化时自动踩刹车，会掩盖排队堆积） |
| **关键指标** | 堆峰值 · GC 停顿 · 拒绝率与拒绝方式 · **无关接口在此期间的劣化** |
| **通过标准** | RES-01：超限时返回明确业务错误或排队；**任何情况下不得 OOM**；无关接口劣化 ≤ 20%（RESIL-03） |
| **实现** | ⬜ |
| **阻塞** | 依赖 S-01 的耗时与内存结论（因此依赖 OBS-02） |

**若 N < K，这是硬容量上限，加内存之外无解**——必须在上线前暴露，见 [NFR](oreo-nfr.zh.md) RES-01。

**注意 §4.7.4 的反馈环**：并发目标 K 本身是单笔耗时的函数。若最贵产品单笔要 45 秒，
P(≥2 并发) 从 3% 跳到 12%，K 从 4 升到 5。**越慢的产品越容易重叠，重叠又让它更慢**——
在 0.013 TPS 下依然可能拥塞坍塌。这是本场景真正要证伪的风险。

**OOM 的后果不是"这个请求失败"，而是整个 JVM 崩溃**——连带杀死所有正在处理的无关请求，包括别人的 blotter 查询和别人正在审批的 task。因此本场景验证的不是"能扛多少并发"，而是**"是否存在一个显式的并发闸门"**。没有闸门，容量上限就是一个悬崖而不是一条曲线。

#### S-15 两阶段审批链路（maker → checker）

| 项 | 内容 |
|---|---|
| **目标** | 分别测量 submit 与 approve/reject 的系统延迟，并验证通知投递与队列行为 |
| **负载形态** | 同一 options 里两个 k6 scenario：maker 侧按业务到达率提交，checker 侧消费 `checker_tasks`，各自独立 executor 与 `startTime` |
| **计时** | `TX_Event_Submit` · `TX_Event_Approve` · `TX_Event_Reject` · `TX_Notify_Delivery` **分别计时** |
| **拒绝比例** | 按 A8 = 5% 配置，**reject 路径必须覆盖** |
| **关键指标** | 四个事务的分位数 · `checker_tasks` 队列深度趋势 · 审计记录数（S-18） |
| **通过标准** | PERF-12/13/14/17 达标；SCALE-02 队列不单调增长 |
| **实现** | ⬜ k6（承载方式已定，见下）；JMeter 存量已建任务池与审批 fragment（`jmx/fragments/setup/checker-task-pool.jmx`、`checker-flow/*`、`p03`/`p04`），作迁移源 |
| **阻塞** | 无技术阻塞，但**脚本设计是全套里最难的一处**，见下 |

**maker → checker 的数据交接**是本计划中唯一的非平凡脚本问题。maker 侧产出 taskId，checker 侧消费——但 k6 的 VU 之间**没有可变共享状态**（`SharedArray` 只读，且只能在 init 阶段构建），两个 scenario 无法在运行中直接传值。三种做法：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 预置任务池**（推荐） | `setup()` 预先提交 N 笔、返回 taskId 数组分发给所有 VU；checker 侧按 VU 序号 / 迭代序号分片消费，互不重叠 | 两侧解耦、可重复、易归因；submit 与 approve 可独立打量；**不需要任何跨 VU 协调** | 不覆盖"提交与审批实时交错"的真实并发 |
| B. 外部交接（Redis / 辅助服务） | maker 写入外部队列，checker 轮询取 | 贴近真实时序 | 需 xk6 扩展或自建服务，引入新故障面与噪音；行内环境多一项审批 |
| C. 文件交接 | 经文件传递 taskId | — | **k6 做不到**：`open()` 仅 init 阶段可用，运行期不能读写文件 |

**推荐 A**，理由与参考数据的处理一致：**把不可控的时序依赖挪到 setup 阶段，让测量阶段只剩单一变量。** 在 k6 里这几乎是唯一务实的选择——而这不是妥协：JMeter 侧同样的三选一我们也论证过 A 胜出（真实交错时序的价值，不足以换取"两侧速率互相影响导致结论无法归因"的代价）。JMeter 存量的 `checker-task-pool.jmx` 就是方案 A 的实现，迁移时逻辑照搬进 `setup()`。

若确实需要验证实时交错（例如怀疑 submit 与 approve 在 DB 层互锁），用 **S-05 子场景②** 专门覆盖，而不是把 S-15 复杂化。

---

### 3.4 优先级 3~8 — 其余场景

| ID | 目标 | 负载形态 | 通过标准 | 备注 |
|---|---|---|---|---|
| **S-03** | Create Trade 完整前端链路 | 按 v2 §5.3 的调用序列 + think time | PERF-07, PERF-11, PERF-19 | k6 🟨（`s01-create-trade-e2e.js` + `journeys/j01`；refdata 地址确认前以 `REFDATA_MODE=csv` 跑，须标注偏差）；JMeter ✅（`jmx/scenarios/s01-create-trade-e2e.jmx`） |
| **S-11** | 下游降级隔离 | 分别令 UC / risk-engine / notification 降级 | RESIL-01/02/05/06，劣化 ≤ 10% | **需故障注入能力**；UC 优先（爆炸半径 9 个 API） |
| **S-12** | DAT 解析对无关接口的挤占 | 后台 large 档并发解析 + 前台 refdata 只读 | RESIL-03，劣化 ≤ 20% | 验证"进程内 CPU 竞争"假设 |
| **S-02** | Booking cutoff 峰值 | 4× 均值持续 1 小时 | PERF-07, PERF-19 | 收尾接 S-18 |
| **S-13** | 批处理与在线并行 | trade-aging / sync-cashflows / refdata sync 与在线负载并行 | RESIL-04，劣化 ≤ 20% | 需确认 refdata sync 写入模式（upsert vs truncate-reload），二者失效模型完全不同 |
| **S-04** | Checker 批量清队列 | `bulk-approve` 批次 1/5/20/50，3 批并发 | PERF-15/16；**单位耗时不随批次上升** | 突发形态，不用恒定到达率。JMeter 脚本已建（`p03` / `p04`），k6 随迁移清单第 ② 位 |
| **S-16** | 全容量混合负载 | [Workload Modeling](workload-modeling.zh.md) §6 全部设计容量同时施加 | **PERF-19**（所有阈值同时达标） | 唯一能暴露跨路径资源竞争的场景。k6 多 scenario 单文件承载（每路径独立到达率）——选它做主线的直接原因之一。**含两个 productType 配比子场景，见下** |
| **S-07** | 月末 / 季末 roll | 3× 普通日，全天 | PERF-20，劣化 ≤ 20% | 事件配比偏向 roll / reassignment |
| **S-17** | Soak — 长交易日 | 设计容量持续 4~8 小时 | AVAIL-01, MAINT-04；无内存/连接泄漏 | **优先级高于 Spike**：blotter 自动刷新恒定跑整天。⚠ 产生数据的路径必须按**到达率**打（见 §4"运行产生的数据"行） |
| **S-06** | 市场波动事件激增 | early termination / novation 突增 | PERF-12, PERF-19 | 倍数待业务确认 |
| **S-08** | 联动层 | S-16 打量 + 3~5 个 Playwright 会话 | 前端指标（[KPI](kpi-definitions.zh.md) §3） | 验证"后端达标 ≠ 前端不卡" |

### 3.5 S-16 的两个 productType 配比子场景

S-16 是唯一以 productType 作为**配比**（而非扫描维度）的场景。它必须跑两遍：

| 子场景 | 配比 | 目的 |
|---|---|---|
| **S-16a 平均配比** | 按 [Workload Modeling](workload-modeling.zh.md) A25 的日均产品分布 | 常态验收，对照 PERF-19 |
| **S-16b 退化配比** | **A27：连续 5 笔全为最贵 productType** | 找真实的容量边界 |

**S-16b 不是"压力测试"，它是常态。** 理由见 [Workload Modeling](workload-modeling.zh.md) §4.7.3：

> 大数定律需要样本量。一个 cutoff 小时只有 48 笔 booking，且到达是**相关的**——
> 一个销售做某类产品推广，连着录 5 笔同类。**在这个量级上，"平均配比"这件事根本不会发生。**

因此一条反直觉但必须遵守的规则：

> **高吞吐系统测平均配比；低吞吐系统必须测退化配比。**

**实操后果**：跟业务反复谈判"到底是 30% 还是 40% TARF"是低价值劳动——那个百分比在 48 笔的
样本上没有统计意义。真正要问业务的是：**"是否存在产品推广期？某类产品会不会短期集中？"**
这决定 A27 要取多极端。

**S-16a 通过而 S-16b 不通过，应判为不通过。** 退化配比是会真实发生的情形，
不是可以列为"极端场景、后续观察"的余量。

---

## 4. 数据准备

| 数据 | 用量 | 供给方式 | 状态 |
|---|---|---|---|
| **Trade 铺底** | 1k / 50k / 250k 三档 | 造数工厂，分布需覆盖多 portfolio / counterparty / 状态 / 产品类型 | ⬜ **阻塞 S-10** |
| **`.dat` 样本** | **按 A26 的 3 个代表 productType**，各若干 + invalid 若干 | 业务提供真实样本；目录按 productType 而非仅按体积分档（`data/dat/products/<TYPE>/`，真实样本不入库） | 🟨 本地仅 FX_TRF 一份；**A26 另两档缺失，阻塞 S-01 扫描** |
| **Composer 产品目录** | 全量 productType 清单 + 各自定盘次数 / schedule 形态 | 产品 owner 提供（A24） | ⬜ **阻塞 A26 代表产品选取** |
| **迁移数据集统计** | 存量 book 的 productType 分布 | 架构 / DBA 出统计（A25） | ⬜ **阻塞 S-16a 配比** |
| **Counterparty / Portfolio** | 每轮运行解析 | **setUp 阶段查询 + 真实建一笔验证 + 归档快照** | ✅ 已实现 |
| **待审批任务池** | S-15 用，N ≈ 200 | `setup()` 预置提交（方案 A） | 🟨 JMeter fragment 已建（`checker-task-pool.jmx`）；k6 迁入 `setup()` 待做 |
| **同一笔争用目标 trade** | S-05 用，每子场景 1 笔 | `setup()` 建立并记录 id | ⬜ |
| **用户身份池** | maker × N、checker × M | `data/shared/accounts.csv` | ✅ 已实现（需真实账号） |
| **运行产生的数据**（每轮的副产品） | 建单数 = VU × 时长 ÷ 单笔耗时。**API 越快造数越多**：0.3 s 时 1 VU × 300 s ≈ 1,000 笔真实 `PENDING APPROVAL` trade；4 VU 满打 4 小时 ≈ **19 万笔**，而按设计容量到达率（0.11 TPS）4 小时只有 ≈ 1,600 笔 | ① 与 DBA / 开发议定清理协议（批量拒绝 / 归档 / 专用标记）；② 产生数据的长时场景一律用 `arrival` 到达率形态，禁用 constant-vus 满打 | ⬜ **第一阶段项**；未清理会漂移 S-10 的数据档位 |

**参考数据是唯一"测试无法控制"的一类**：counterparty / portfolio 由 sync batch job 从第三方同步。硬编码会过期，且失效表现是 **HTTP 200 + 业务全拒**——只看状态码的报告显示 0 错误率。处理方式见 [v2 方案](../trade-api-perf-test-plan-v2-jmeter.md) §4.4，两套工程均已实现（k6：`k6/setup/preflight.js`；JMeter：`jmx/fragments/setup/refdata-preflight.jmx`）。

---

## 5. 环境要求

| 要求 | 说明 | 状态 |
|---|---|---|
| 独立压测环境 | 与功能测试隔离，避免互相干扰 | ⬜ 尚无 |
| 数据量达标 | 达到 [Workload Modeling](workload-modeling.zh.md) A16 假设量级 | ⬜ |
| 服务端监控 | CPU / 堆 / GC / 连接池 / DB 锁 / 慢查询 | 🟨 **Grafana + Prometheus 已在运行**（HTTP / gRPC / JVM / HikariCP 四层，判读方法见 [GRAFANA.zh.md](../../trade-performance/GRAFANA.zh.md)）；缺 DB 锁与慢查询视图；HikariCP acquire/usage 直方图未开（需开发开启 Micrometer percentiles）；**连接池 max = 10 已确认**（RES-04 的实数输入） |
| **扇出计数**（OBS-01） | APM trace 或计数器 | 🟨 精确计数仍缺；**粗测已可用**：`rpc_client_duration_milliseconds_count` 窗口差值（S-09 可先行） |
| **解析内存打点**（OBS-02） | JFR 或应用打点 | ⬜ 逐请求峰值仍缺（JVM heap 面板仅够 1 并发下粗估）· **阻塞 S-14 的 N 推导** |
| 压测指标入服务端 Prometheus | k6 原生 remote-write（`k6/run.sh` / `run.ps1` 已接好），压测 TPS / P95 与服务端指标同库同时间轴 | ⬜ 需 Prometheus 开 `--web.enable-remote-write-receiver`（走审批）。非阻塞：时间戳对齐（manifest 记录 epoch 窗口）先用 |
| **队列深度指标**（OBS-05） | `checker_tasks` 待处理数 | ⬜ **阻塞 S-15 / SCALE-02** |
| 故障注入 | 可控地令 UC / risk-engine / notification 降级 | ⬜ **阻塞 S-11** |
| 进程 kill 演练 | 可控重启，验证锁恢复 | ⬜ 阻塞 AVAIL-02 / INTEG-02 |
| 审计表只读权限 | S-18 核对用 | ⬜ **阻塞 S-18** |

**功能环境的结论只用于趋势对比与暴露实现级问题，不外推生产容量。**

---

## 6. 执行顺序与排期

### 6.1 递进规则（不可跳级）

```
Smoke                              ← 每轮第一步，验证脚本与环境
  ↓
S-01 Cost Profile                  ← 先知道单次多贵
  ↓
S-10 Volume Scaling                ← 再知道数据量下多贵
  ↓
S-09 Fan-out Audit                 ← 再知道一次请求引发多少下游
  ↓
S-03 / S-15 单链路 Load            ← 才开始打并发
  ↓
S-05 Contention · S-14 Resource    ← 边界与争用
  ↓
S-11 / S-12 / S-13 Interference    ← 互扰
  ↓
S-16 全容量混合                     ← 唯一能下"整体达标"结论的场景
  ↓
S-02 / S-04 / S-06 / S-07 峰值     ← 各类峰值形态
  ↓
S-17 Soak · S-08 联动              ← 长时与真实体验
```

**每一轮 Load 类场景（S-02 / S-15 / S-16 / S-07）收尾必须执行 S-18 审计核对。**

**场景内部同样递进**（对应 k6 profile）：`smoke`（脚本自检）→ `baseline`（1 VU，分母）→ 设计并发 / 到达率验收（`load` / `arrival`）→ 才谈 `ladder` / `soak`。跳过前两步跑出的数字一律不采信。

### 6.2 分阶段落地

| 阶段 | 内容 | 前置 |
|---|---|---|
| **第一阶段：解除阻塞** | 提出 OBS-02/05 观测需求 + Micrometer 直方图开启；建造数工厂；**与 DBA 议定压测建单清理协议**；申请审计只读权限与 Prometheus remote-write；确认前端轮询参数 A10~A12；索取 A26 代表产品 `.dat` 样本 | 无 —— **可立即开始，且不做这些后面全部受限** |
| **第二阶段：优先级 1~2** | S-01（A26 扫描）· S-09（rpc_client 差值法，**可先行**）· S-18 · S-05 · S-10 · S-14 · S-15；并行执行 §1.1 迁移清单 ①~② | 第一阶段 |
| **第三阶段：优先级 3~5** | S-03（JMeter 已有，k6 迁移第 ③ 位）· S-11 · S-12 · S-02 · S-13 · S-04 · S-16 | 故障注入能力 |
| **第四阶段：优先级 6~8** | S-07 · S-17 · S-06 · S-08 | 独立压测环境 |

**第一阶段不产出任何性能数字，但它决定后面三个阶段能否得出有效结论。** 跳过它直接跑场景，会得到一批无法归因的数字。

### 6.3 进入准则（每轮开跑门槛）

退出准则（§7）管"什么算测完"，进入准则管"这一轮配不配开跑"。每轮开跑前逐项过：

| # | 门槛 | 不满足的后果 |
|---|---|---|
| 1 | refdata preflight 通过（setup 阶段真实建一笔验证） | 参考数据失效 → HTTP 200 + 业务全拒，报告却显示 0 错误率 |
| 2 | `smoke` 三类错误全 0（profile 的 thresholds 即此门槛，退出码判定） | 脚本 bug 混进结果，整轮作废 |
| 3 | 数据量与 A16 假设量级的差距已声明 | 空库数字被误读为容量结论 |
| 4 | 监控可达、时钟同步（manifest 自动记录 epoch 时间窗） | 服务端指标对不上时间轴，无法归因 |
| 5 | 产生真实数据的场景：清理协议在位，且用到达率形态而非 constant-vus 满打 | 一轮 soak 留下十几万笔无主 trade（见 §4） |
| 6 | 样本量预算成立：`VU × 时长 ÷ 单笔耗时` ≥ 200（报 P95）/ ≥ 1,000（报 P99） | 分位数是随机数，而报告上完全看不出来 |

---

## 7. 退出准则

一轮完整性能测试可以判定"通过"，需同时满足：

| # | 准则 |
|---|---|
| 1 | **脚本错误率 = 0**（PERF-21）。非 0 则本轮结果作废，不允许扣除后达标。k6 中由 `oreo_err_script` threshold 硬门槛化——不达标进程退出码非 0，机器判定不靠自觉 |
| 2 | **参考数据 preflight 通过**。失败的运行结果作废 |
| 3 | **数据量达到 A16 假设量级**。空库结果无效 |
| 4 | S-16 全容量混合场景下 PERF-01~18 **同时**达标 |
| 5 | **S-18 审计核对差值为 0**（AUDIT-02） |
| 6 | 无 [NFR](oreo-nfr.zh.md) §1.1 定义的正确性红线事件（状态不一致 / snapshot 丢字段 / 审计缺失） |
| 7 | 关键结论已复跑验证，两次 P95 差异 ≤ 10% |
| 8 | 所有 NV 标签条目已在报告中显式列为**未验证**，不得默认为通过 |

**第 8 条是最容易被违反的一条。** 一份只报告已测项的报告，会让未测项看起来像已通过。报告必须显式区分"测了且过""测了没过""没测"三种状态。

---

## 8. 风险与前置阻塞

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **OBS-02/05 未满足**（OBS-01 已有降级手段） | S-01 内存结论、S-14 的 N、SCALE-02 无法验证 | 第一阶段作为需求提给开发；S-09 用 `rpc_client` 计数差值先行（见 §3.2） |
| 2 | **前端轮询参数（A10~A12）未确认** | 全部容量数字的基数错误，可能差 6 倍 | 确认成本极低（前端配置项），**列为最高优先级** |
| 3 | **`.dat` 真实样本缺失** | S-01 无法执行，即递进链第一环断裂 | 向业务索取**按 A26 代表产品**的真实样本 |
| 3b | **productType 全集与配比未知（A24 / A25）** | S-01 扫不全、S-16 配比无依据 | 要 Composer 目录 + **迁移数据集统计**（后者把 A5/A7/A25 从猜变成统计，见 [Workload Modeling](workload-modeling.zh.md) §4.7.6） |
| 4 | **造数工厂未建** | S-10 无法执行；且所有 blotter 结论在空库下无效 | 第一阶段并行推进 |
| 5 | **S-05 预期行为未定义** | 场景可执行但无法判定通过 | 需产品/架构决策，见 §3.3 |
| 6 | **SEC-01 身份模型待确认** | 若引入网关认证，压测接入点需改造 | 见 [NFR](oreo-nfr.zh.md) §6，需架构回答 |
| 7 | 无独立压测环境 | 结论只能作趋势对比 | 阶段四前置 |
| 8 | WebSocket 完全未覆盖 | create / trigger-event 的推送路径无结论 | 缺口登记，另行立项 |
| 9 | **团队 k6 经验为零，迁移期双栈并存** | 脚本质量与进度风险；两套工具结论口径混用 | [k6 实操手册](../../trade-performance/k6/HANDBOOK.zh.md)按"从零到出数"写就；两套工程结构逐层对应，p02 双实现是参照答案；JMeter 资产**冻结只修不增**，按 §1.1 清单迁移；`tests/csv.test.mjs` 不装 k6 也能自检脚本逻辑 |
| 10 | **压测建单无清理协议** | 环境数据持续漂移，S-10 档位失真，最终影响所有 blotter 结论 | 第一阶段与 DBA / 开发议定；产生数据的场景一律用到达率形态（§6.3 门槛 5） |

---

## 9. 交付物

| 交付物 | 内容 | 位置 |
|---|---|---|
| **k6 工程（主线）** | 四层结构（scenarios / steps / profiles / lib）、三类错误分离、run.sh / run.ps1、静态自检（node 直跑 `tests/csv.test.mjs`，不需装 k6） | `qa/trade-performance/k6/` |
| JMeter 存量工程 | 交叉验证与迁移源，冻结只修不增 | `qa/trade-performance/jmx/` + `scripts/` |
| 每轮 run manifest | git commit、工具版本、解析后的全部参数、epoch 时间窗（对齐 Grafana） | `results/<runId>/manifest.txt`（两套 runner 均已实现） |
| 单轮报告 | 三类错误分离 + 成功样本单列分位数 + 样本量警告；k6 侧 `summary.txt`（`k6/lib/summary.js`），JMeter 侧 `scripts/summarize.py` 读 jtl，**两侧输出逐行同构可对照** | `results/<runId>/` · 指标口径按 [KPI Definitions](kpi-definitions.zh.md) §6 |
| SLA 判定 | k6 profile 内建 thresholds，退出码即结论（`load` 已含 technical=0、业务成功率 >99%）；**NFR 编号 ↔ threshold 映射表待补**；JMeter jtl 侧的 `assert-sla.py` 随迁移弃建 | `k6/profiles/*.json` 🟨 |
| 审计核对脚本 | S-18 收尾核对（SQL 对账，工具无关） | ⬜ 未建 |
| 操作与判读文档 | 单接口验收操作手册 · Grafana 判读与集成 · k6 原理与上手 | [`RUNBOOK-p02-create-trade.zh.md`](../../trade-performance/RUNBOOK-p02-create-trade.zh.md) · [`GRAFANA.zh.md`](../../trade-performance/GRAFANA.zh.md) · `k6/README.zh.md` / `k6/HANDBOOK.zh.md` |
| 阶段总结 | 达标项 / 未达标项 / **未验证项** / 容量结论 / 架构建议 | Confluence |

---

## 10. 角色与职责

| 角色 | 职责 |
|---|---|
| QA | 场景设计与实现、执行、报告；维护本文档与场景库 |
| 架构 | 回答 [NFR](oreo-nfr.zh.md) §12.3 的 9 个开放问题；签署技术类 NFR；OBS 能力设计 |
| 后端 | 提供 OBS-01/02/05 观测能力；解释新增慢查询；修正确性红线 |
| 前端 | **确认 A10~A12 轮询参数**（最高优先级）；前端指标打点 |
| 业务运营 | 签署 A1~A23 假设与 PERF 延迟阈值；提供 `.dat` 真实样本 |
| 运维 | 提供压测环境、监控、故障注入、kill 演练；签署 AVAIL 类 NFR |
| 合规 / 风控 | 签署 AUDIT 与 SEC 类 NFR |

---

## 相关页面

- [Performance Test Strategy](performance-test-strategy.zh.md) — 测试类型与优先级依据
- [Workload Modeling](workload-modeling.zh.md) — 各场景的负载值来源
- [OREO NFR](oreo-nfr.zh.md) — 各场景的通过标准
- [KPI Definitions](kpi-definitions.zh.md) — 各场景该报的指标
- [k6 工程 README](../../trade-performance/k6/README.zh.md) / [k6 实操手册](../../trade-performance/k6/HANDBOOK.zh.md) — 主线工具实现
- [Trade API 性能测试方案 v2](../trade-api-perf-test-plan-v2-jmeter.md) — API 清单、依赖矩阵、JMeter 存量实现
- [Trade Create 用例集](../trade-create-perf-testcases-jmeter.md) — create 的 15 个用例
