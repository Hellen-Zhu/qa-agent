# Performance Test Strategy（OREO 性能测试策略）

> **Confluence 位置**：Testing & Quality → Specialized Testing → Performance Testing → 1. Strategy & Workload Model
> **系统**：OREO — Optimized Real-time Execution Orchestrator（FX 结构化产品全生命周期系统）
> **状态**：Draft v0.2 · **Owner**：待指定 · **评审人**：架构 / 后端 / 前端 / QA 各一名
> **更新触发**：系统架构变更、上线后拿到真实流量数据、每次大版本发布后回顾
> **English**：[performance-test-strategy.en.md](performance-test-strategy.en.md)

---

## 1. 目的与范围

本页定义 OREO 性能测试的整体策略：测什么、什么时候测、用什么标准判定通过。所有性能测试活动（API 压测、前端性能、CI 性能门禁）都以本页为依据。

**范围内**：Trade Portal 与 Composer 两个页面的全部 API 链路、四眼审批链路、`.dat` 解析与 risk 计算路径、批处理与在线业务互扰、前端 Web 加载与长时运行性能、CI 性能门禁。

**范围外**（如适用另行立项）：第三方 refdata 同步源自身性能、UC / risk-engine / notification 三个下游服务的内部性能（本页只测它们对 OREO 的影响）、WebSocket 推送通道（当前缺口，见 [v2 方案](../trade-api-perf-test-plan-v2-jmeter.md) 附录 C-1）。

---

## 2. 系统性能画像 — 为什么不能按普通 Web 系统测，也不能按零售交易系统测

[Workload Modeling](workload-modeling.zh.md) §1 的结论是：**OREO 的峰值 TPS 在个位数，环境轮询负载超过峰值业务负载约 280 倍。** 这否定了两套常见方法论。

| 特征 | 含义 | 对测试的要求 |
|---|---|---|
| **低吞吐、高单价** | 每日 120 笔 booking，但单笔含 `.dat` 解析与 risk 计算 | **测单请求成本，不测 TPS 拐点**。加压测不出"一次解析吃 3GB 堆" |
| **两阶段写路径** | maker 提交 → pending approve 锁 → checker 审批，中间隔人工间隔 | submit 与 approve **分别计时、分别设 SLA**；拼成一个事务的数字无业务含义 |
| **拒绝路径更贵** | reject 要做 snapshot 恢复 + 审计写入 | 负载模型必须含 reject 流，不能只压 approve |
| **同实体争用** | 同一笔 trade 上的并发事件互相阻塞 | 需专门的"同目标并发"场景；常规"每线程打不同 trade"永远测不出 |
| **读放大** | 单页 4 个 blotter × 200 行，可能逐行走 UC gRPC 富化 | 必须审计**扇出倍数**：1 次前端请求 = 多少次下游调用 |
| **数据量敏感** | 3 年后 25 万笔 trade；blotter 是全表范围查询 | 空库结果无效。必须在**目标数据量**下测，并测多个数据量档位 |
| **进程内 CPU/内存竞争** | `.dat` 解析与全部 API 同进程 | 大文件解析会拖慢**毫无业务关系的接口**，需交叉干扰场景 |
| **批处理共存** | trade-aging、sync-cashflows、refdata sync job 与在线并行 | 批处理运行期的在线劣化是独立测试维度 |
| **长交易日** | 跨时区，用户挂机数小时，blotter 持续自动刷新 | Soak 优先级**高于** Spike：连接泄漏、内存增长、慢性积压 |
| **审计不可丢** | 每次状态流转都要可归因、可追溯 | 高负载下审计写入不得丢失或降级——这是正确性要求，不是性能要求 |

**明确不适用于 OREO 的三条零售假设：** 开盘脉冲（OREO 峰值在 booking cutoff 与月末）· 高并发连接（用户数以十计）· 行情推送洪峰（无此通道）。

---

## 3. 分层测试策略

| 层 | 回答的问题 | 变量 | 工具 | 详见 |
|---|---|---|---|---|
| API 层 | 单请求多贵、目标容量下延迟分布如何、扇出多少 | 输入规模、数据量、并发 | **JMeter** | [v2 方案](../trade-api-perf-test-plan-v2-jmeter.md)、`qa/trade-performance/` |
| 前端层 | 4 个 blotter × 200 行渲染有多快、挂机数小时是否劣化 | 行数、刷新间隔、会话时长 | Playwright + CDP | Frontend / Web Performance |
| 联动层 | 后端在目标负载下真实用户体验如何 | 两者叠加 | JMeter 打量 + 3~5 个 Playwright 会话 | [Test Plan](oreo-performance-test-plan.zh.md) S-08 |

三层互不替代：API 层达标不代表前端不卡（200 行 × 4 blotter 的 DOM 更新是前端问题），前端流畅不代表服务器扛得住批处理并行。

**工具选型说明**：API 层用 JMeter 而非 k6，原因是 OREO 的核心链路需要 multipart `.dat` 上传、跨线程组的 maker→checker 数据交接、以及大量既有 curl 资产的直接复用；详见 [v2 方案](../trade-api-perf-test-plan-v2-jmeter.md) 附录 B。**已实现的工程在 `qa/trade-performance/`。**

---

## 4. 测试类型定义与优先级

OREO 的类型清单与通用模板不同：**前三类是 OREO 的主战场，传统的 Stress / Spike 被降级。**

| 优先级 | 类型 | 回答的问题 | 负载形态 | 为什么对 OREO 重要 |
|:---:|---|---|---|---|
| — | **Smoke** | 脚本和系统能不能跑通 | 1 线程 1 轮 | 每次脚本改动、每轮测试第一步 |
| **1** | **Cost Profile**（单请求成本画像） | **一次**请求消耗多少 CPU / 内存 / 时间 | **1 并发**，遍历输入规模档位 | OREO 首要风险。一次 large `.dat` 解析的内存峰值决定了整个服务的资源下限 |
| **2** | **Volume Scaling**（数据量伸缩） | 数据量增长时是否劣化 | 固定负载，遍历数据量档位（1k / 50k / 250k 笔） | blotter 是范围查询；空库 P95 与 25 万笔下的 P95 可能差一个数量级 |
| **3** | **Fan-out Audit**（扇出审计） | 1 次前端请求引发多少次下游调用 | 单请求 + 下游调用计数 | 若 blotter 富化为 N+1，33 TPS 列表 = 6,600 QPS gRPC。这是**唯一**能让 OREO 达到三位数 QPS 的路径 |
| **4** | **Load** | 目标容量下是否满足 NFR | 爬坡到设计容量，稳定 30 分钟 | 仍需做，但数字很低（见 Workload Modeling §6） |
| **5** | **Contention**（同实体争用） | 同一笔 trade 上的并发操作是否互斥、死锁、丢更新 | **低并发（5~20）打同一目标** | 四眼原则的 pending approve 锁；常规压测的盲区 |
| **6** | **Interference**（互扰） | 批处理 / 大文件解析运行时在线接口劣化多少 | 后台作业 + 在线负载并行 | `.dat` 解析与 API 同进程；批处理与 API 共用 DB |
| **7** | **Soak** | 长交易日是否劣化 | 设计容量持续 4~8 小时 | **优先级高于 Spike**：blotter 自动刷新恒定跑一整天，连接与内存泄漏是真实风险 |
| 8 | **Spike** | 突发能否吸收 | checker 批量清队列形态的突发 | 仅针对 `bulk-approve` 与 cutoff 集中提交；**不做零售式 20× 脉冲** |
| 9 | **Stress** | 系统在哪断、怎么断 | 阶梯加压超过峰值 | 降级为"了解过载行为"，不作为容量结论依据 |
| 10 | **Capacity** | 目标架构最大承载多少 | 逐步扩量 + 扩容对照 | 上线后按真实数据重做；当前阶段收益低 |

**递进规则（不可跳级）**：
```
Smoke → Cost Profile → Volume Scaling → Fan-out Audit → Load → 其余
```
把 Cost Profile 放在 Load 之前是刻意的：**在不知道单请求成本的情况下打并发，得到的是一个无法归因的数字。** 先知道一次 large 解析要 3 秒 + 2GB，才能解释为什么 3 并发就崩。

---

## 5. 触发规则 — 什么改动必须做性能测试

| 触发条件 | 最低要求 |
|---|---|
| 每次合码（PR） | CI 性能冒烟（JMeter 低负载 + 前端 bundle 体积门禁），自动执行 |
| **`.dat` 解析逻辑或依赖库变更** | **Cost Profile 全档位 + 内存峰值对比基线**。这是 OREO 最脆弱的一环 |
| **blotter 查询 / UC 富化逻辑变更** | Volume Scaling（三档数据量）+ Fan-out Audit |
| 四眼审批流程变更（含**新事件类型迁入审批流**） | 两阶段链路重测 + Contention 场景 |
| snapshot / 审计写入逻辑变更 | Contention 场景 + 审计完整性校验（见 [NFR](oreo-nfr.zh.md) §4） |
| 数据模型 / 索引 / SQL 变更 | 涉及接口的 Volume Scaling，关注目标数据量下的表现 |
| 前端轮询间隔调整（A11 / A12） | 重算 Workload Modeling §5，并重跑 Load |
| 中间件 / 依赖版本升级（DB、gRPC、JVM） | Load + Soak 回归一轮 |
| 批处理逻辑变更（trade-aging、sync-cashflows、refdata sync） | Interference 场景 |
| Composer 产品定义 / lifecycle 配置逻辑变更 | 配置缓存失效路径的 Interference 场景 |
| 前端框架升级 / blotter 组件改动 | 前端加载性能 + 长会话 Soak |
| 发布前（每个大版本） | 完整轮次：Smoke → Cost Profile → Volume Scaling → Fan-out → Load → Contention → Interference → Soak，出正式报告 |

---

## 6. 通过 / 失败原则

1. **没有通过/失败标准的压测是演示，不是测试。** 任何场景执行前必须有书面阈值——阈值来自 [OREO NFR](oreo-nfr.zh.md)，口径来自 [KPI Definitions](kpi-definitions.zh.md)。
2. **标准长在脚本里**：写进 JMeter 断言 + `scripts/assert-sla.py`（或 Taurus `passfail`），执行即自动判定，不依赖人看报告。
3. 比对对象二选一并在报告注明：对比 **NFR**（绝对达标）或对比 **基线**（相对劣化，如 P95 劣化 >10% 不通过）。
4. **延迟结论必须与错误率并排呈现**——快速失败的系统会"看起来更快"。
5. **三类错误分离统计**（技术 / 业务 / 脚本），见 KPI Definitions §1.3。**脚本错误率必须为 0**，非 0 说明本轮结果不可信，不允许"扣掉脚本错误后达标"这种结论。
6. **正确性红线优先于性能红线**：任何一轮测试中若出现 trade 状态不一致、snapshot 恢复丢字段、审计记录缺失，**无论延迟多好都判失败**，且必须先修正确性再谈性能。

---

## 7. 方法纪律

- **单变量**：一次只改一个变量（负载、代码版本、配置、数据量），否则结论不可归因。
- **先预热再测量**：缓存、JIT、连接池就绪后才开始统计窗口。
- **铺底数据达量**：数据量必须达到 [Workload Modeling](workload-modeling.zh.md) A16 的假设量级。**空库结果无效**——这对 OREO 尤其致命，因为 blotter 是范围查询。
- **可重复**：关键结论复跑一遍，两次 P95 差异 >10% 视为噪声，先排查再下结论。
- **环境声明**：非等比环境的结果必须在报告中写明缩容比例与折算假设。
- **参考数据时效**：counterparty / portfolio 由 sync batch job 从第三方同步，**测试无法控制**。每轮运行必须在 setUp 阶段解析并归档快照，否则失效数据会表现为"HTTP 200 + 业务全拒"，在报告里显示 0 错误率。详见 [v2 方案](../trade-api-perf-test-plan-v2-jmeter.md) §4.4。
- **禁止**未经授权与协调压生产环境或第三方服务（含 refdata 同步源）。

---

## 8. 当前阶段（资产建设期）

系统尚无独立压测环境。当前所有工作以"环境到位第一天即可开跑"为目标：

| 工作项 | 状态 |
|---|---|
| JMeter 工程骨架（四层架构、三维正交、run.sh、静态校验） | ✅ 已建，见 `qa/trade-performance/` |
| create-trade 单接口 + E2E 链路脚本 | ✅ 已建 |
| 业务量模型与假设登记 | ✅ 本轮建立（[Workload Modeling](workload-modeling.zh.md)） |
| NFR 与验收阈值 | ✅ 本轮建立（[OREO NFR](oreo-nfr.zh.md)），数值待业务确认 |
| 场景库（18 个场景） | ✅ 本轮建立（[Test Plan](oreo-performance-test-plan.zh.md)）。**S-03 已实现；S-01 脚本已有但缺内存采集（部分）；其余 16 个待建** |
| 前端轮询参数确认（A10–A12） | ⚠️ **阻塞项，最高优先级** |
| 造数工厂（25 万笔 trade 铺底） | ⚠️ 未建 |
| 可观测性前置（gRPC 扇出计数、解析内存打点） | ⚠️ 未提需求 |
| CI 冒烟相对基线 | ⚠️ 未建 |

**功能环境的测试结论只用于趋势对比与暴露实现级问题，不外推生产容量。**

---

## 相关页面

- [Workload Modeling](workload-modeling.zh.md) — 打多少量
- [OREO NFR](oreo-nfr.zh.md) — 通过标准
- [OREO Performance Test Plan](oreo-performance-test-plan.zh.md) — 场景库与执行计划
- [KPI Definitions](kpi-definitions.zh.md) — 指标口径
- [Trade API 性能测试方案 v2](../trade-api-perf-test-plan-v2-jmeter.md) — API 清单与 JMeter 工程实现
