# OREO 性能测试计划（Performance Test Plan）

> **Confluence 位置**：Testing & Quality → Specialized Testing → Performance Testing → 3. Test Plan & Scenario Library
> **系统**：OREO — Optimized Real-time Execution Orchestrator（FX 结构化产品全生命周期系统）
> **状态**：Draft v0.1 · **Owner**：待指定 · **评审人**：架构 / 后端 / 前端 / 业务运营
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
| [Trade API 方案 v2](../trade-api-perf-test-plan-v2-jmeter.md) | JMeter 怎么实现 | 本页场景落地为它定义的四层工程结构 |

**已实现的工程在 `qa/trade-performance/`。**

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

**实现状态**：✅ 已实现 · 🟨 部分实现 · ⬜ 未实现

| ID | 场景 | 类型 | 优先级 | 验证的 NFR | 实现 |
|---|---|---|:---:|---|:---:|
| **S-01** | **`.dat` 单请求成本画像** | Cost Profile | **1** | PERF-07~10, RES-01 | 🟨 |
| **S-09** | **Fan-out Audit（扇出审计）** | Fan-out | **1** | PERF-02, OBS-01, SCALE-01 | 🟨 |
| **S-18** | **审计完整性核对** | Integrity | **1** | AUDIT-02 | ⬜ |
| **S-05** | **同笔 trade 并发争用** | Contention | **2** | INTEG-03, INTEG-07, AVAIL-02 | ⬜ |
| **S-10** | **数据量伸缩性** | Volume Scaling | **2** | SCALE-01, PERF-02 | 🟨 |
| **S-14** | **并发解析上限与背压** | Resource | **2** | RES-01, RES-02 | ⬜ |
| **S-15** | **两阶段审批链路（maker → checker）** | Load | **2** | PERF-12~14, PERF-17, SCALE-02 | 🟨 |
| S-03 | Create Trade E2E（前端链路） | Load | 3 | PERF-07, PERF-11, PERF-19 | ✅ |
| S-11 | 下游降级隔离（UC / risk / notification） | Interference | 3 | RESIL-01, 02, 05, 06 | ⬜ |
| S-12 | DAT 解析 CPU / 内存竞争 | Interference | 3 | RESIL-03 | ⬜ |
| S-02 | Booking cutoff 峰值 | Load | 4 | PERF-07, PERF-19 | ⬜ |
| S-13 | 批处理与在线并行 | Interference | 4 | RESIL-04, SCALE-05 | ⬜ |
| S-04 | Checker 批量清队列 | Spike | 5 | PERF-15, PERF-16 | ⬜ |
| S-16 | 全容量混合负载 | Load | 5 | **PERF-19**, PERF-01~18 | ⬜ |
| S-07 | 月末 / 季末 roll | Load | 6 | PERF-20 | ⬜ |
| S-17 | Soak — 长交易日 | Soak | 6 | AVAIL-01, MAINT-04 | ⬜ |
| S-06 | 市场波动事件激增 | Spike | 7 | PERF-12, PERF-19 | ⬜ |
| S-08 | 联动层（后端负载 + 真实浏览器） | Combined | 8 | 前端指标 | ⬜ |

**优先级 1~2 的七个场景中，六个未实现。** 这不是遗漏——它们大多被 [NFR](oreo-nfr.zh.md) §12.2 的能力缺口阻塞（扇出计数、内存打点、造数、故障注入）。见 §8。

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
| **实现** | 🟨 脚本已有（`jmx/api/p02-trade-create.jmx` + `smoke` profile + CSV），但 **CSV 目前只有一个 productType（FX_TRF），需按 A26 补齐代表产品**；**内存指标缺采集手段** |
| **阻塞** | **OBS-02**（解析内存峰值不可观测）· **A24 Composer 产品目录未确认** · `.dat` 真实样本缺失。当前只能出耗时结论，不能出内存结论 |

**为什么扫描维度是 productType 而不是文件档位**：文件体积是产品结构的**结果**。
现实中不存在"TARF × small"这种组合，把 productType 与 datSize 当成正交维度会生成不存在的用例。
详见 [Workload Modeling](workload-modeling.zh.md) §4.7。

**本场景的产出决定了另外两个场景怎么设计**：S-14 的并发档位来自这里的耗时实测，
S-16 的退化配比来自这里认定的"最贵产品"。**它不出结果，后面两个都设计不出来。**

**为什么它是第 1 优先级**：[Strategy](performance-test-strategy.zh.md) §4 的递进规则要求 Cost Profile 先于 Load。在不知道单次解析要 3 秒 + 2GB 的情况下打并发，得到的崩溃无法归因——你不知道是并发问题还是单请求就已经超限。

**超线性是设计缺陷信号**：若 large 档（20MB）耗时是 small 档（假设 200KB）的 100 倍以上，说明解析算法存在超线性成本，这是架构问题而非容量问题。

#### S-09 Fan-out Audit（扇出审计）

| 项 | 内容 |
|---|---|
| **目标** | 回答"1 次 blotter 列表请求触发多少次 UC gRPC 调用" |
| **负载形态** | **单请求**，遍历返回行数：50 / 200 / 500 行 |
| **关键指标** | UC gRPC 调用数 · risk-engine 调用数 · DB 查询数（各按返回行数） |
| **通过标准** | **扇出 = O(1)**，即调用数不随返回行数增长 |
| **实现** | 🟨 被测脚本已建（`p05-trades-list`，返回行数进 jtl 的 `tradesRowCount` 列）；**扇出计数仍缺采集手段** |
| **阻塞** | **OBS-01**（扇出计数不可观测） |

**这是全计划中信息密度最高的一个场景**，成本极低（3 次请求）而结论极重：

```
若扇出 = O(1)：blotter 33 TPS → UC 33 QPS      → 无容量风险
若扇出 = O(n)：blotter 33 TPS → UC 6,600 QPS   → 首要瓶颈，需架构改造
```

两个结论对应完全不同的容量规划与优化方向。**在这个结论出来之前，[NFR](oreo-nfr.zh.md) PERF-02 的 1,500ms 阈值只是一个数字**——我们不知道它背后是 1 次还是 200 次下游调用，因此也不知道它在负载下会怎么变化。

**替代方案（若 OBS-01 短期无法满足）**：在 DB 侧统计查询次数，或用 tcpdump / gRPC 侧日志计数。精度不如 APM，但足以区分 O(1) 与 O(n)——而这个区分才是本场景的全部目的。

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
| **负载形态** | 两个上限取小者：<br>① **业务并发目标** K —— 由 S-01 实测耗时查 [Workload Modeling](workload-modeling.zh.md) §4.7.4 表得出（**3~7**，非假设值）<br>② **资源理论上限** N = 可用堆 ÷ 单次内存峰值<br>打 K-1 / K / N / N+2 / 2N 并发，全部用**最贵 productType** |
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
| **负载形态** | 两个 Thread Group：maker 组按业务量提交，checker 组消费 `checker_tasks` |
| **计时** | `TX_Event_Submit` · `TX_Event_Approve` · `TX_Event_Reject` · `TX_Notify_Delivery` **分别计时** |
| **拒绝比例** | 按 A8 = 5% 配置，**reject 路径必须覆盖** |
| **关键指标** | 四个事务的分位数 · `checker_tasks` 队列深度趋势 · 审计记录数（S-18） |
| **通过标准** | PERF-12/13/14/17 达标；SCALE-02 队列不单调增长 |
| **实现** | ⬜ |
| **阻塞** | 无技术阻塞，但**脚本设计是全套里最难的一处**，见下 |

**跨 Thread Group 的 maker → checker 数据交接**是本计划中唯一的非平凡脚本问题。maker 组产出 taskId，checker 组消费——但 JMeter 的 `vars` 是线程级的，两个 Thread Group 之间无法直接传值。三种做法：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 预置任务池**（推荐） | setUp 阶段预先提交 N 笔，把 taskId 写入池；checker 组从池中消费 | 两组解耦、可重复、易归因；submit 与 approve 可独立打量 | 不覆盖"提交与审批实时交错"的真实并发 |
| B. `props` + 同步队列 | maker 组写入全局 `props` 中的并发队列，checker 组轮询取 | 贴近真实时序 | **仅单 JVM 有效**（`props` 不跨分布式 slave）；两组速率失配时行为难解释 |
| C. 外部队列/文件 | 经 Redis / 文件交接 | 可跨机 | 引入外部依赖，增加故障面与噪音 |

**推荐 A**，理由与参考数据的处理一致（见 [v2 方案](../trade-api-perf-test-plan-v2-jmeter.md) §4.4）：**把不可控的时序依赖挪到 setUp 阶段，让测量阶段只剩单一变量。** 真实交错时序的价值不足以换取"两组速率互相影响导致结论无法归因"的代价。

若确实需要验证实时交错（例如怀疑 submit 与 approve 在 DB 层互锁），用 **S-05 子场景②** 专门覆盖，而不是把 S-15 复杂化。

---

### 3.4 优先级 3~8 — 其余场景

| ID | 目标 | 负载形态 | 通过标准 | 备注 |
|---|---|---|---|---|
| **S-03** | Create Trade 完整前端链路 | 按 v2 §5.3 的调用序列 + think time | PERF-07, PERF-11, PERF-19 | ✅ 已实现（`s01-create-trade-e2e`） |
| **S-11** | 下游降级隔离 | 分别令 UC / risk-engine / notification 降级 | RESIL-01/02/05/06，劣化 ≤ 10% | **需故障注入能力**；UC 优先（爆炸半径 9 个 API） |
| **S-12** | DAT 解析对无关接口的挤占 | 后台 large 档并发解析 + 前台 refdata 只读 | RESIL-03，劣化 ≤ 20% | 验证"进程内 CPU 竞争"假设 |
| **S-02** | Booking cutoff 峰值 | 4× 均值持续 1 小时 | PERF-07, PERF-19 | 收尾接 S-18 |
| **S-13** | 批处理与在线并行 | trade-aging / sync-cashflows / refdata sync 与在线负载并行 | RESIL-04，劣化 ≤ 20% | 需确认 refdata sync 写入模式（upsert vs truncate-reload），二者失效模型完全不同 |
| **S-04** | Checker 批量清队列 | `bulk-approve` 批次 1/5/20/50，3 批并发 | PERF-15/16；**单位耗时不随批次上升** | 突发形态，不用恒定到达率。**脚本已建**：`p03-checker-bulk-approve` / `p04-checker-bulk-reject` |
| **S-16** | 全容量混合负载 | [Workload Modeling](workload-modeling.zh.md) §6 全部设计容量同时施加 | **PERF-19**（所有阈值同时达标） | 唯一能暴露跨路径资源竞争的场景。**含两个 productType 配比子场景，见下** |
| **S-07** | 月末 / 季末 roll | 3× 普通日，全天 | PERF-20，劣化 ≤ 20% | 事件配比偏向 roll / reassignment |
| **S-17** | Soak — 长交易日 | 设计容量持续 4~8 小时 | AVAIL-01, MAINT-04；无内存/连接泄漏 | **优先级高于 Spike**：blotter 自动刷新恒定跑整天 |
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
| **`.dat` 样本** | **按 A26 的 3 个代表 productType**，各若干 + invalid 若干 | 业务提供真实样本；目录按 productType 而非仅按体积分档 | ⬜ **阻塞 S-01**（`data/dat/` 当前为空） |
| **Composer 产品目录** | 全量 productType 清单 + 各自定盘次数 / schedule 形态 | 产品 owner 提供（A24） | ⬜ **阻塞 A26 代表产品选取** |
| **迁移数据集统计** | 存量 book 的 productType 分布 | 架构 / DBA 出统计（A25） | ⬜ **阻塞 S-16a 配比** |
| **Counterparty / Portfolio** | 每轮运行解析 | **setUp 阶段查询 + 真实建一笔验证 + 归档快照** | ✅ 已实现 |
| **待审批任务池** | S-15 用，N ≈ 200 | setUp 预置提交（方案 A） | ⬜ |
| **同一笔争用目标 trade** | S-05 用，每子场景 1 笔 | setUp 建立并记录 id | ⬜ |
| **用户身份池** | maker × N、checker × M | `data/shared/accounts.csv` | ✅ 已实现（需真实账号） |

**参考数据是唯一"测试无法控制"的一类**：counterparty / portfolio 由 sync batch job 从第三方同步。硬编码会过期，且失效表现是 **HTTP 200 + 业务全拒**——只看状态码的报告显示 0 错误率。处理方式见 [v2 方案](../trade-api-perf-test-plan-v2-jmeter.md) §4.4，已在 `jmx/fragments/setup/refdata-preflight.jmx` 实现。

---

## 5. 环境要求

| 要求 | 说明 | 状态 |
|---|---|---|
| 独立压测环境 | 与功能测试隔离，避免互相干扰 | ⬜ 尚无 |
| 数据量达标 | 达到 [Workload Modeling](workload-modeling.zh.md) A16 假设量级 | ⬜ |
| 服务端监控 | CPU / 堆 / GC / 连接池 / DB 锁 / 慢查询 | ⬜ 需确认可用性 |
| **扇出计数**（OBS-01） | APM trace 或计数器 | ⬜ **阻塞 S-09** |
| **解析内存打点**（OBS-02） | JFR 或应用打点 | ⬜ **阻塞 S-01 / S-14** |
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

### 6.2 分阶段落地

| 阶段 | 内容 | 前置 |
|---|---|---|
| **第一阶段：解除阻塞** | 提出 OBS-01/02/05 观测需求；建造数工厂；申请审计只读权限；确认前端轮询参数 A10~A12 | 无 —— **可立即开始，且不做这些后面全部受限** |
| **第二阶段：优先级 1~2** | S-01 · S-09 · S-18 · S-05 · S-10 · S-14 · S-15 | 第一阶段 |
| **第三阶段：优先级 3~5** | S-03（已有）· S-11 · S-12 · S-02 · S-13 · S-04 · S-16 | 故障注入能力 |
| **第四阶段：优先级 6~8** | S-07 · S-17 · S-06 · S-08 | 独立压测环境 |

**第一阶段不产出任何性能数字，但它决定后面三个阶段能否得出有效结论。** 跳过它直接跑场景，会得到一批无法归因的数字。

---

## 7. 退出准则

一轮完整性能测试可以判定"通过"，需同时满足：

| # | 准则 |
|---|---|
| 1 | **脚本错误率 = 0**（PERF-21）。非 0 则本轮结果作废，不允许扣除后达标 |
| 2 | **参考数据 preflight 通过**。失败的运行结果作废 |
| 3 | **数据量达到 A16 假设量级**。空库结果无效 |
| 4 | S-16 全容量混合场景下 PERF-01~18 **同时**达标 |
| 5 | **S-18 审计核对差值为 0**（AUDIT-02） |
| 6 | 无 §1.1 定义的正确性红线事件（状态不一致 / snapshot 丢字段 / 审计缺失） |
| 7 | 关键结论已复跑验证，两次 P95 差异 ≤ 10% |
| 8 | 所有 NV 标签条目已在报告中显式列为**未验证**，不得默认为通过 |

**第 8 条是最容易被违反的一条。** 一份只报告已测项的报告，会让未测项看起来像已通过。报告必须显式区分"测了且过""测了没过""没测"三种状态。

---

## 8. 风险与前置阻塞

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **OBS-01/02/05 未满足** | 优先级 1~2 的四个场景无法出完整结论 | 第一阶段作为需求提给开发；S-09 可用 DB 计数降级替代 |
| 2 | **前端轮询参数（A10~A12）未确认** | 全部容量数字的基数错误，可能差 6 倍 | 确认成本极低（前端配置项），**列为最高优先级** |
| 3 | **`.dat` 真实样本缺失** | S-01 无法执行，即递进链第一环断裂 | 向业务索取**按 A26 代表产品**的真实样本 |
| 3b | **productType 全集与配比未知（A24 / A25）** | S-01 扫不全、S-16 配比无依据 | 要 Composer 目录 + **迁移数据集统计**（后者把 A5/A7/A25 从猜变成统计，见 [Workload Modeling](workload-modeling.zh.md) §4.7.6） |
| 4 | **造数工厂未建** | S-10 无法执行；且所有 blotter 结论在空库下无效 | 第一阶段并行推进 |
| 5 | **S-05 预期行为未定义** | 场景可执行但无法判定通过 | 需产品/架构决策，见 §3.3 |
| 6 | **SEC-01 身份模型待确认** | 若引入网关认证，压测接入点需改造 | 见 [NFR](oreo-nfr.zh.md) §6，需架构回答 |
| 7 | 无独立压测环境 | 结论只能作趋势对比 | 阶段四前置 |
| 8 | WebSocket 完全未覆盖 | create / trigger-event 的推送路径无结论 | 缺口登记，另行立项 |

---

## 9. 交付物

| 交付物 | 内容 | 位置 |
|---|---|---|
| JMeter 工程 | 四层架构、三维正交、run.sh、静态校验 | `qa/trade-performance/` |
| 每轮 run manifest | git commit、jmeter/java 版本、解析后的全部属性、环境声明 | `results/<runId>/manifest.txt`（已实现） |
| 单轮报告 | 标准结果表 + OREO 专有列 + 资源占用 + 三类错误分离 | 按 [KPI Definitions](kpi-definitions.zh.md) §6 |
| SLA 判定脚本 | 解析 jtl，按 NFR 编号对照，以退出码反映结论 | `scripts/assert-sla.py` ⬜ 未建 |
| 审计核对脚本 | S-18 收尾核对 | ⬜ 未建 |
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
- [Trade API 性能测试方案 v2](../trade-api-perf-test-plan-v2-jmeter.md) — JMeter 工程实现细节
- [Trade Create 用例集](../trade-create-perf-testcases-jmeter.md) — create 的 15 个用例
