# Trade API 性能测试方案 v2（JMeter）

> 版本：v2.2  
> 适用范围：已识别的 11 个 P0 + 22 个 P1 API，共 33 个接口  
> 核心变化：依赖关系重新建模、按依赖爆炸半径重排降级测试优先级、脚本形态按 API 分级分流、测试数据供给策略显式化、工程结构面向 33 个 API 规模化
>
> **本文档的定位**：本文是**实现层**方案——回答"JMeter 怎么写、33 个 API 怎么组织"。
> 业务量模型、验收阈值、场景库属于上层文档，见 `docs/performance/`：
>
> | 文档 | 回答 |
> |---|---|
> | [Workload Modeling](performance/workload-modeling.zh.md) | 打多少量（OREO 假设登记与推导） |
> | [OREO NFR](performance/oreo-nfr.zh.md) | 什么算通过（10 类非功能需求 + 验证方式标签） |
> | [OREO Performance Test Plan](performance/oreo-performance-test-plan.zh.md) | 18 个场景的场景库与排期 |
> | [KPI Definitions](performance/kpi-definitions.zh.md) | 指标口径 |
> | [Performance Test Strategy](performance/performance-test-strategy.zh.md) | 何时测、测什么类型 |
>
> ⚠️ **本文 §10.3 的 SLA 模板已被 [OREO NFR](performance/oreo-nfr.zh.md) §2 取代。** 阈值以 NFR 为准，本文不再维护数值。

---

## 0. 变更摘要

| # | 变更 | 原因 |
|---|---|---|
| 1 | 重绘**依赖—影响矩阵**（第 2 章），覆盖全部 33 个 API | 确定降级测试的真实优先级 |
| 2 | 降级测试优先级调整为 **UC gRPC > risk-engine > DAT CPU > notification** | UC 命中 trade list/detail 两个 High 频 P0 读，爆炸半径最大 |
| 3 | 修正 v2.0 中"risk-engine 是 dat-to-json 的下游"的说法 | 依赖表显示 dat-to-json 只依赖进程内 DAT parsing / CPU / memory |
| 4 | 新增**脚本形态分类**（第 3 章）：数据驱动 17 个 / 专用 13 个 / 批处理 3 个 | 33 个 API 无法用同一种脚本形态维护 |
| 5 | 新增**测试数据供给策略**（第 4 章） | 7 个状态迁移型接口会在持续压测中断供 |
| 6 | `trigger-event` 与 `bulk-approve` 拆为**两类批量风险模型** | 前者是写放大/工作流发起，后者是事务性批量完成 |
| 7 | 新增场景：DAT CPU 竞争、批处理与在线并行 | 来自依赖表中的进程内资源竞争与批处理特性 |
| 8 | 工程结构改为**四层 + 数据驱动 runner**，面向 33 个 API | 每 API 一棵元件树的做法在此规模下不可维护 |
| 9 | WebSocket 推送通道登记为**已知覆盖缺口**（附录 C） | 本轮 out of scope，但需显式记录风险 |
| 10 | 保留并强化 v1 的 15 项脚本级修复（附录 A） | 任一未修都会导致测试失败或数据作废 |
| **11** | **`trigger-event` 由"一个批量写接口"重新认识为"10 种生命周期事件的共用载体"**（§2.5.1） | OREO 业务背景：右键菜单有 10 个事件，成本画像各不相同 |
| **12** | **审批类接口重新认识为"两阶段写路径的后半段"**（§2.5.2） | 单独测 approve 只测了一半功能；submit 与 approve 必须分别计时 |
| **13** | **新增 `pending approve` 锁争用与 reject 成本两个维度**（§2.5.3） | 常规"每线程打不同 trade"的压测设计永远碰不到同实体争用 |
| **14** | **补入 Blotter 请求放大与 Composer 两个未建模面**（§2.5.4） | 单页多 blotter 使列表查询成为全系统请求量最大来源 |

---

## 1. 测试范围与边界

### 1.1 覆盖什么

JMeter 在协议层模拟前端发出的 HTTP 调用序列，回答：

- 各 API 在真实调用模式下的吞吐、延迟与错误率
- 独立容量与瓶颈位置
- 服务间依赖降级时的影响范围与隔离有效性
- 进程内资源（CPU / 内存）竞争对整体的影响

### 1.2 不覆盖什么

| 缺口 | 原因 | 承接方 |
|---|---|---|
| 页面首屏 / TTI / LCP / 渲染性能 | JMeter 无浏览器 | Playwright + CDP（Confluence `Performance Testing / 8. Frontend & Web Performance`） |
| 浏览器并发连接限制导致的排队 | 同上 | 同上 |
| **WebSocket 推送通道** | **本轮 out of scope**（见附录 C） | 待定 |
| gRPC 下游服务的内部性能 | 属于下游团队职责 | 通过服务端监控观察，不直接施压 |

> **术语约定**：本文的 **"E2E 场景"** 指"按前端调用序列串联的协议层压测"，不等于浏览器端到端测试。报告中必须使用这一口径。

### 1.3 调用序列的事实来源

E2E 场景的调用序列**必须来自真实浏览器 HAR 抓包**，覆盖：完整 Create Trade（正常路径 + 风控失败后继续创建）、请求的**并行关系**、**后台轮询**（`notifications/unread-count`）、页面初始化附加请求（`/products`、`/product-field-configs/{id}/live-fields`、`/uc/entitlements/check/*`）、以及真实的 `create` 与 `calculate-risk-for-new` 请求体。

HAR 归档到 `data/har/`，作为脚本评审依据。

---

## 2. API 全景与依赖分析

### 2.1 API 清单

**P0（11 个）**

| Domain | Interface | Method | Path | Type | Freq | 依赖 |
|---|---|---:|---|---|---|---|
| Trade | Trade List | GET | `/trades` | Read | High | DB; checker enrich; **UC gRPC** |
| Trade | Trade Detail | GET | `/trades/{id}` | Read | High | DB; checker enrich; **UC gRPC** |
| Trade | Create Trade | POST | `/trades/create` | Write; Upload | Med | DAT parsing; DB; audit; *WebSocket* |
| Trade | Trigger Bulk Event | POST | `/trades/trigger-event` | Batch; Write | Med | DB; business rules; checker workflow; *WebSocket*; notification |
| Trade | Calculate Risk | POST | `/trades/{id}/calculate-risk` | Compute | Med | **risk-engine gRPC** |
| Trade | Calc Partial Novation Risk | POST | `/trades/{id}/calculate-partial-novation-risk` | Compute | Med | risk preview; **risk-engine** |
| Trade | Calculate Risk For New | POST | `/trades/calculate-risk-for-new` | Compute; Upload | Med | DAT parsing; **risk-engine gRPC** |
| Trade | Get All Risk Metrics | GET | `/trades/{tradeId}/risk-metrics` | Read; Compute | **High** | **risk-engine gRPC** |
| Checker | Bulk Approve | POST | `/checker/tasks/bulk-approve` | Batch; Write | Med | DB; **UC gRPC**; notification gRPC; transaction |
| Checker | Bulk Reject | POST | `/checker/tasks/bulk-reject` | Batch; Write | Med | DB; **UC gRPC**; notification gRPC; transaction |
| Notification | Unread Count | GET | `/notifications/unread-count` | Read; Polling | High | DB |

**P1（22 个）**

| Domain | Interface | Method | Path | Type | 依赖 |
|---|---|---:|---|---|---|
| Trade | Update Trade | POST | `/trades/{id}/update` | Write | DB; audit |
| Trade | Get Single Risk Metric | GET | `/trades/{tradeId}/risk-metrics/{metricType}` | Read; Compute | **risk-engine** |
| Trade | Convert DAT To JSON | POST | `/trades/dat-to-json` | Upload; Compute | **DAT parsing; CPU; memory** |
| Trade | Target Gain | GET | `/trades/{id}/target-gain` | Read; Compute | DB; **risk-engine** |
| Trade | Generate Schedule | POST | `/trades/generate-schedule` | Compute | external schedule service |
| Trade | Sync Cashflows Batch | POST | `/trades/sync-cashflows-batch` | Batch; Write | DB; trace; batch loop |
| Checker | Get Pending Tasks | GET | `/checker/tasks/pending` | Read | DB |
| Checker | Approve Task | POST | `/checker/tasks/{taskId}/approve` | Write | DB; **UC gRPC**; notification gRPC |
| Checker | Reject Task | POST | `/checker/tasks/{taskId}/reject` | Write | DB; **UC gRPC**; notification gRPC |
| Notification | Inbox | GET | `/notifications/inbox` | Read | DB |
| UserCenter | Check Maker | GET | `/uc/entitlements/check/maker` | Read | UC DB |
| UserCenter | Check Checker | GET | `/uc/entitlements/check/checker` | Read | UC DB |
| UserCenter | Qualified Checkers | GET | `/uc/entitlements/checkers` | Read | UC DB |
| RefData | Get Counterparties | GET | `/refdata/counterparties` | Read | refdata DB |
| RefData | Search Counterparties | GET | `/refdata/counterparties/search` | Read; Search | refdata DB |
| RefData | Get Portfolios | GET | `/refdata/portfolios` | Read | refdata DB |
| RefData | Search Portfolios | GET | `/refdata/portfolios/search` | Read; Search | refdata DB |
| Product | Get All Products | GET | `/products` | Read | DB |
| ProductSchema | Parse Schema | POST | `/products/schema/parse` | Upload; Compute | file parsing; schema service |
| ProductConfig | Live Product Fields | GET | `/product-field-configs/{productId}/live-fields` | Read | DB; config cache |
| TradeAging | Process All Trades | POST | `/trade-aging/process-all` | Batch; Compute | DB; batch rules |
| TradeAging | Process All From File | POST | `/trade-aging/process-all-from-file` | Batch; Upload | DB; batch rules; file input |

### 2.2 依赖—影响矩阵（核心）

| 下游依赖 | 受影响 API | 数量 | 含 High 频 P0 读 | 爆炸半径 | 降级测试优先级 |
|---|---|---:|:---:|---|---:|
| **UC gRPC** | trade list、trade detail、bulk approve/reject、approve/reject、uc check maker/checker/checkers | **9** | ✅ ×2 | 列表页与详情页整体变慢，**影响所有用户的主界面** | **1（最高）** |
| **risk-engine gRPC** | calculate-risk、partial-novation-risk、calculate-risk-for-new、risk-metrics（全量+单个）、target-gain | 6 | ✅ ×1 | 风险功能不可用；**Create 不受影响** | 2 |
| **DAT parsing**（进程内 CPU/内存） | create、calculate-risk-for-new、dat-to-json | 3 | ❌ | 大文件解析挤占 API Service CPU，**波及同进程全部接口** | 3 |
| **notification gRPC** | bulk approve/reject、approve/reject | 4 | ❌ | 仅审批写路径 | 4 |
| **WebSocket** | create、trigger-event | 2 | ❌ | 前端收不到实时更新 | **未覆盖**（附录 C） |
| external schedule service | generate-schedule | 1 | ❌ | 单点功能 | 低 |
| DB | 几乎全部 | ~33 | ✅ | 全局 | 常规容量测试已覆盖 |

**三个关键结论：**

1. **UC gRPC 的优先级高于 risk-engine。** 直觉上风险引擎最重要，但 UC 命中了 `GET /trades` 和 `GET /trades/{id}` 两个 High 频 P0 读接口（checker enrich 路径）。UC 抖动会让主界面整体变慢，影响面远大于风险功能不可用。

2. **Create Trade 不依赖 risk-engine。** 依赖链是 DAT parsing → DB → audit → WebSocket。因此 risk-engine 故障时 Create **在架构上应当不受影响**——这个假设必须验证，不能默认成立（场景 C2）。

3. **DAT parsing 是进程内 CPU 竞争，不是下游降级。** 它被 create、calculate-risk-for-new、dat-to-json 三个接口共用，大文件并发解析会抢占 API Service 的 CPU 与内存，**拖慢同进程内所有接口**——包括与它毫无业务关系的 refdata 查询。这类竞争用常规单接口测试发现不了（场景 D）。

### 2.3 Create Trade 链路的依赖特性

前端调用序列（以 HAR 为准）：

```text
页面初始化（并行）
  ├── GET /refdata/counterparties          [硬依赖：提供 counterpartyFmid]
  ├── GET /refdata/portfolios              [硬依赖：提供 portfolioId]
  ├── GET /products
  └── GET /uc/entitlements/check/maker
    ↓ think 1~3s
POST /trades/dat-to-json                   [软依赖：仅前端回显，失败不阻断]
    ↓ think 1~2s
POST /trades/calculate-risk-for-new        [软依赖：建议性风控，失败不阻断]
    ↓ think 0.5~1.5s
POST /trades/create                        [独立执行，自带原始 .dat 由服务端解析]
    ↓
GET /trades?search={ref}                   [定位，Create 若返回 id 可跳过]
    ↓ think 1~3s
GET /trades/{id} + GET /trades/{id}/risk-metrics
```

**依赖类型划分：**

| 类型 | 接口 | 失败策略 |
|---|---|---|
| **硬数据依赖** | counterparties、portfolios | 中止本次迭代（payload 构不出来） |
| **业务软依赖** | dat-to-json、calculate-risk-for-new | 继续执行，打路径标签 |
| **关键步骤** | create | 失败则跳过后续观察步骤 |
| **观察性步骤** | 列表定位、详情、risk-metrics | 失败继续，仅记录 |

### 2.4 待确认的业务行为

| 问题 | 影响 | 当前假设 |
|---|---|---|
| 风控失败时前端是弹窗确认还是直接放行？ | 是否有额外 think time | 弹窗确认，+2s |
| 风控失败后实际多少比例用户继续创建？ | 路径权重与真实 Create 到达量 | 50%（`riskFailProceedPct` 可配） |
| dat-to-json 失败时前端是否阻止继续？ | 该路径是否存在 | 提示错误但允许继续 |
| `trigger-event` 单次请求影响多少笔 trade？ | 决定写放大测试维度 | 见 5.6，需确认 |

---

## 2.5 OREO 业务背景带来的四处修正

本章 §2.1~§2.4 的依赖分析是从 **API 清单与 HAR 抓包**反推出来的。补入 OREO 的业务模型
（四眼原则、Trade Portal 右键菜单、Composer）后，其中四处需要修正——它们都不是"补充细节"，
而是**改变了测试对象的粒度**。

业务模型定义见 [Workload Modeling](performance/workload-modeling.zh.md) §3。

### 2.5.1 `trigger-event` 是 10 种事件的共用载体，不是一个接口

§2.1 把 `POST /trades/trigger-event` 列为一个 Batch/Write 接口，§2.4 的待确认项只问了
"单次请求影响多少笔 trade"。实际上 Trade Portal 的右键菜单包含 **10 个生命周期事件**：

`View Details` · `PartialNovationRemaining` · `PartialNovation` · `PortfolioReassignment` ·
`Cancellation` · `EarlyTermination` · `NovationRemaining` · `StepOutFull` · `StepOutPartial` ·
`Allocation`

**后果**：它们的成本画像互不相同，不能用一条 SLA 覆盖。

| 事件 | 成本特征 | 测试影响 |
|---|---|---|
| `Allocation` | **一笔拆多组合 → 写放大**，倍数上限未知 | 需按拆分数分档计时（单位工作量耗时） |
| `PartialNovation` / `StepOutPartial` | 需重算剩余名义本金，可能触发 risk 计算 | 可能落入 risk-engine 依赖链，需重查依赖矩阵 |
| `Cancellation` | **需 checker 审批** → 两阶段路径 | 与其余 9 个形态不同，见 §2.5.2 |
| `EarlyTermination` | 市场波动时到达量激增 | 峰值形态独立，见 Test Plan S-06 |
| `View Details` | 只读 | 不属于事件，归入读路径 |

**待确认**：这 10 个事件是共用 `trigger-event` 一个端点（用 payload 里的 eventType 区分），
还是各有独立端点？这决定脚本是"一个数据驱动 fragment + eventType 参数"还是"10 个 fragment"。
按 §3.1 的判定规则，若共用端点则应归入**数据驱动型**，`endpoints.csv` 增加 `eventType` 维度。

### 2.5.2 审批类接口是两阶段写路径的后半段

§2.1 把 `approve` / `reject` / `bulk-approve` / `bulk-reject` 列为独立的 Write 接口，
§2.2 把 checker workflow 列为 `trigger-event` 的一个"依赖"。这个建模丢掉了业务事务边界。

真实形态是**一个业务动作横跨两个事务**：

```
maker 提交 ──► trade 锁定为 pending approve ──► 写 checker_tasks ──► 发通知 ──► 存 snapshot
                                    ↓  人工间隔（分钟~小时级）
checker ──┬─ approve ──► 执行 → 状态更新 → 发确认
          └─ reject  ──► 取消 → 从 snapshot 恢复 → 写审计
```

**三条后果：**

1. **只测 `approve` 只测了一半功能。** 必须成对测量 submit + approve/reject，且**分别计时**。
2. **两者之间的间隔不能计入任何事务。** 它由人决定，拼成端到端事务的数字主要反映
   checker 什么时候去吃饭。计时口径见 [KPI Definitions](performance/kpi-definitions.zh.md) §2.1。
3. **审批范围因事件而异**：new booking / amendment / cancellation 需审批；
   novation / step-in / step-out / early termination 等**暂不**需要。
   同一个 `trigger-event` 端点因此有两种截然不同的下游行为——单阶段与两阶段。

> ⚠️ "暂不"（not yet）意味着审批范围是过渡状态，预期会变。脚本与负载模型都应做到
> "只改配置不改结构"，见 [OREO NFR](performance/oreo-nfr.zh.md) MAINT-01。

### 2.5.3 两个缺失的测试维度：锁争用与 reject 成本

**(a) `pending approve` 锁是争用维度。** §5 的全部场景都隐含"每个线程打不同的 trade"
（为避免互相干扰），因此**永远不会触发同实体争用**。而四眼原则恰恰在同一笔 trade 上串行化操作。

需新增"低并发打同一目标"场景（Test Plan S-05），验证：

- 并发提交时是否有且仅有一个成功
- 是否死锁
- 并发 amendment 是否丢更新
- **服务重启时锁是否成为孤儿**（trade 永久冻结或锁凭空消失）

**(b) reject 比 approve 贵。** approve 走正常执行路径；reject 额外要做 snapshot 恢复 +
审计写入。§5 与 §10.3 都只覆盖了 approve，会系统性低估审批路径成本。
拒绝率需作为负载模型参数（Workload Modeling A8，v0 = 5%）。

**一个用性能数据反查功能正确性的例子**：若实测 reject 与 approve 耗时相同，
应怀疑 snapshot 恢复没有真正执行。

### 2.5.4 两个未建模的面：Blotter 请求放大与 Composer

**(a) Blotter：单页多个 blotter。** §2.3 的页面初始化序列只列了一次 `GET /trades`。
实际 Trade Portal 含**多个 trade blotter**，每个是一次独立列表查询，且可能自动刷新：

```
稳态列表查询 TPS = 并发用户数 × 每页 blotter 数 ÷ 自动刷新间隔
```

按 Workload Modeling 的 v0 假设（31 并发 × 4 blotter ÷ 30s）这是 **4.13 TPS 恒定负载**——
**全系统请求量最大的单一来源**，超过真实业务负载约两个数量级。若列表还逐行走 UC gRPC 富化，
扇出再放大 200 倍。

这使 §2.2 结论 1（"UC gRPC 优先级最高"）**比原先论证的更强**：原论证依据是"UC 命中两个
High 频 P0 读"，实际情况是这两个读接口本身被 blotter 自动刷新恒定放大。

**(b) Composer 完全未建模。** §2.1 列了 `/products`、`/products/schema/parse`、
`/product-field-configs/{id}/live-fields` 三个接口，但没有把 Composer 作为一个操作面考虑：

- 产品定义 / 更新 / 标记删除
- 产品的生命周期事件配置

它本身是低频操作，但**其配置被热路径读取**——产品字段配置与可用事件列表在每次 booking 与
每次事件提交时都要读。因此 Composer 的风险不在自身吞吐，而在**配置缓存失效时对在线路径的影响**
（见 [OREO NFR](performance/oreo-nfr.zh.md) MAINT-02 / MAINT-04）。

### 2.5.5 修正后的优先级影响

| 修正 | 对本方案的影响 |
|---|---|
| §2.5.1 | §3.2 形态归属表需为 `trigger-event` 增加 `eventType` 维度；`endpoints.csv`（§7.6）加一列 |
| §2.5.2 | §5 需新增两阶段审批场景；§10.3 的 SLA 模板需拆出 submit / approve / reject 三行（已由 NFR PERF-12/13/14 承接） |
| §2.5.3 | §5 需新增同实体争用场景（Test Plan S-05）；负载模型加拒绝率参数 |
| §2.5.4 | §2.2 结论 1 论证加强；blotter 列表升为请求量第一的路径；Composer 配置缓存纳入互扰场景 |

---

## 3. 脚本形态分类

### 3.1 三种形态与判定规则

| 形态 | 数量 | 占比 | 单个成本 | 维护方式 |
|---|---:|---:|---|---|
| **数据驱动**（`endpoints.csv` 一行一个 API） | 17 | 52% | 加一行 CSV | 集中维护 |
| **专用脚本** | 13 | 39% | 半天 ~ 1 天 | 独立 jmx |
| **批处理模型** | 3 | 9% | 独立设计 | 独立 jmx |

**判定规则**（写进规范，避免每次讨论）：

```text
需要动态构建请求体？            → 专用
需要从上一响应提取参数做关联？  → 专用
是 multipart / 文件上传？       → 专用
需要按数据量 / 批次大小分档？   → 专用
断言超出「状态码 + 字段存在 + 单值比对」？ → 专用
批次大小是主测试维度且执行时间长？ → 批处理
以上都不是                      → 数据驱动
```

### 3.2 形态归属表

**数据驱动（17 个）** — 全部进 `api/g00-generic.jmx` + `endpoints.csv`

| API | 需要的数据池 | 下游标注 |
|---|---|---|
| `GET /trades/{id}` | trade-ids | uc-grpc |
| `GET /trades/{tradeId}/risk-metrics` | trade-ids | risk-engine |
| `GET /trades/{tradeId}/risk-metrics/{metricType}` | trade-ids + metric-types | risk-engine |
| `GET /trades/{id}/target-gain` | trade-ids | risk-engine |
| `POST /trades/generate-schedule` | 固定 bodyFile | external-schedule |
| `GET /notifications/unread-count` | — | db |
| `GET /notifications/inbox` | — | db |
| `GET /checker/tasks/pending` | — | db |
| `GET /uc/entitlements/check/maker` | — | uc-db |
| `GET /uc/entitlements/check/checker` | — | uc-db |
| `GET /uc/entitlements/checkers` | — | uc-db |
| `GET /refdata/counterparties` | — | refdata-db |
| `GET /refdata/counterparties/search` | search-terms | refdata-db |
| `GET /refdata/portfolios` | — | refdata-db |
| `GET /refdata/portfolios/search` | search-terms | refdata-db |
| `GET /products` | — | db |
| `GET /product-field-configs/{productId}/live-fields` | product-ids | db |

**专用脚本（13 个）**

| API | 归属 jmx | 专用原因与主测试维度 |
|---|---|---|
| `GET /trades` | `p01-trade-list.jmx` | 数据量分档 × 分页/排序/过滤/搜索矩阵 |
| `POST /trades/create` | `p02-trade-write.jmx` | multipart 双 part + 动态 payload |
| `POST /trades/{id}/update` | `p02-trade-write.jmx` | 一次性消费 + 可能有乐观锁版本号 |
| `POST /trades/{id}/calculate-risk` | `p03-risk-compute.jmx` | 按 trade 复杂度分档 |
| `POST /trades/{id}/calculate-partial-novation-risk` | `p03-risk-compute.jmx` | 需要合格 trade 子集 |
| `POST /trades/calculate-risk-for-new` | `p03-risk-compute.jmx` | multipart + 动态 payload |
| `POST /trades/dat-to-json` | `p04-upload-parse.jmx` | 文件大小分档 + CPU/GC 观察 |
| `POST /products/schema/parse` | `p04-upload-parse.jmx` | 文件上传 |
| `POST /checker/tasks/bulk-approve` | `p05-checker-approval.jmx` | 批次大小维度（事务型） |
| `POST /checker/tasks/bulk-reject` | `p05-checker-approval.jmx` | 同上 |
| `POST /checker/tasks/{taskId}/approve` | `p05-checker-approval.jmx` | 一次性消费 |
| `POST /checker/tasks/{taskId}/reject` | `p05-checker-approval.jmx` | 一次性消费 |
| `POST /trades/trigger-event` | `p06-trigger-event.jmx` | **写放大维度**（见 5.6） |

**批处理（3 个）**

| API | 归属 jmx |
|---|---|
| `POST /trade-aging/process-all` | `b01-trade-aging.jmx` |
| `POST /trade-aging/process-all-from-file` | `b01-trade-aging.jmx` |
| `POST /trades/sync-cashflows-batch` | `b02-cashflow-batch.jmx` |

---

## 4. 测试数据供给策略

33 个 API 中有 7 个是**状态迁移型**，跑一次消耗一份数据。在 30 分钟持续压测和 8 小时 Soak 中会直接断供，导致测试中途失效。

### 4.1 按消费类型分类

| 消费类型 | 接口 | 供给策略 |
|---|---|---|
| **幂等只读**（可无限复用） | 全部 GET、risk-metrics、target-gain、pending tasks | 预置 ID 池，CSV `Recycle=True` |
| **幂等计算**（可复用，注意缓存） | calculate-risk、partial-novation-risk、calculate-risk-for-new、dat-to-json、schema parse | 池化 + 轮换不同输入，避免结果缓存掩盖真实耗时 |
| **一次性消费**（状态迁移） | approve、reject、bulk-approve、bulk-reject、trigger-event、update | 见 4.2 |
| **持续增长**（污染基线） | create | 独立 Portfolio 隔离；`GET /trades` 基线必须在 create 压测**之前**采集 |
| **外部同步型**（不受测试控制） | counterparties、portfolios | 见 4.4 |

### 4.2 一次性消费的三种供给方案

| 方案 | 适用场景 | 代价 |
|---|---|---|
| **预生成大池** | **单接口容量测试**（首选） | 需 DB 层灌数脚本；池耗尽即测试结束，需按 `目标TPS × 时长 × 1.2` 估算规模 |
| **生产者—消费者同场跑** | **Maker-Checker 业务场景** | 两个 Thread Group 速率需匹配，否则积压或饥饿；两者相互影响，不适合做单接口容量测试 |
| **每轮重置 DB 快照** | Soak 测试 | 环境要求高，恢复耗时长 |

> **不要混用**：单接口容量测试要的是干净隔离（用预生成池），业务场景要的是真实（用生产者—消费者）。两个目的不同。

### 4.3 数据池管理

```text
data/pools/
├── trade-ids.csv                  幂等只读，压测前生成，可长期复用
├── trade-ids-novation.csv         partial novation 合格子集
├── pending-task-ids.csv           一次性消费，每轮重新生成
├── product-ids.csv                幂等只读
├── metric-types.csv               幂等只读
└── search-terms.csv               搜索词，覆盖命中率高/低/无结果三档
```

- 池由 `ops/z01-seed-pools.jmx` 或独立 SQL 脚本生成，**不在压测过程中生成**
- 池规模、生成时间记入 run manifest，作为结果可复现的一部分
- `pending-task-ids.csv` 每轮重新生成，用后即弃

### 4.4 外部同步型参考数据（Counterparty / Portfolio）

Counterparty 与 Portfolio 由 **sync batch job 从第三方同步进我们的数据库**，再经 refdata API 暴露。它们与前三类的本质区别是：**测试无法保证其存在性与有效性**。第三方随时可能停用、改名、重编号，环境 DB refresh 也会让 UUID 全部作废。

固定值最危险的后果不是"跑不起来"，而是"**HTTP 200 但业务全拒**"——只看状态码的断言会报 0 错误率，报告上却是一条 trade 都没建成。

**绑定时机决定一切：**

| 方案 | 新鲜度 | 测量纯净度 | 可复现性 | 适用 |
|---|---|---|---|---|
| 硬编码 CSV | ✗ | ✓ | ✓ | 不可单独使用 |
| 压测循环内查询 | ✓ | ✗ refdata 耗时混入被测值 | ✗ | **仅** E2E 场景（真实前端确实这么做，属被测链路） |
| **setUp Thread Group 解析 + 归档快照** | ✓ | ✓ 不在测量窗口内 | ✓ | **单接口容量测试统一采用** |

- **走 API 不走 DB 直连**：DB 里存在 ≠ API 能用（权限过滤、软删除、状态机），而 create 的校验与查询 API 同源。仅当需要 API 提供不了的批量筛选条件时才申请 JDBC 只读权限，且限 setUp 阶段
- **setUp 内必须做一次真实业务冒烟**（建一笔 trade），把"数据失效"从压测中期的噪音变成开跑前的明确失败
- 解析结果落盘 `results/${runId}/resolved-refdata.csv`，纳入 run manifest
- **sync job 是 create 的资源竞争者**：与 API 共用 DB 实例时会争抢连接池与 IO。压测排期需避开其调度窗口；或专门测量该窗口内的退化（PT-CREATE-015）

> 完整实现（setUp 元件树、池构建 Groovy、选取策略 property、前置校验策略）见 `trade-create-perf-testcases-jmeter.md` §2.4。该策略适用于**所有**需要有效 portfolio / counterparty 的接口，不限于 create。

---

## 5. 测试策略分层与场景设计

### 5.1 分层

```text
第 0 层：脚本调试与冒烟         g99-all-api-smoke，33 个接口各打一次
   ↓
第 1 层：单接口基线             数据驱动 Sweep（17 个）+ 专用深度测（选代表）
   ↓
第 2 层：依赖降级隔离           UC → risk-engine → notification
   ↓
第 3 层：资源竞争               DAT parsing CPU 竞争
   ↓
第 4 层：业务场景               Create E2E、查询、Maker-Checker、Update
   ↓
第 5 层：混合负载 + 批处理并行
   ↓
第 6 层：容量、稳定性、突增
```

**首轮精力分配：**

```text
35%  单接口基线（Sweep 全覆盖 + 5 个深度测）
25%  依赖降级隔离与资源竞争   ← 高于 v1，因为爆炸半径已量化
25%  业务场景（Create E2E + Maker-Checker）
15%  稳定性、突增、批处理并行
```

### 5.2 场景 A：单接口基线

**A-1 全量 Sweep**（数据驱动，17 个接口）
低负载（3~5 VU）遍历全部数据驱动接口，为每个接口建立 P95 基线。约 15 分钟一轮，可纳入版本回归。

**A-2 深度容量测试：按"依赖代表"选，不按接口选**

11 个 P0 全做梯度测试需约 16 小时机时，不现实。**同一下游依赖的接口瓶颈画像高度相似**，因此按依赖分组挑代表：

| 依赖组 | 代表接口 | 理由 | 负载梯度 |
|---|---|---|---|
| UC gRPC | `GET /trades` | 最高频，enrich 逻辑最重 | 5,10,20,40,80 |
| risk-engine gRPC | `calculate-risk-for-new` | 计算最重，且含 DAT parsing | 1,5,10,20,40 |
| DB 写 + audit | `POST /trades/create` | 核心写路径 | 1,5,10,20,40 |
| DB 批量写 + 事务 | `bulk-approve` | 锁竞争风险最高 | 批次 × 并发矩阵 |
| 进程内 CPU | `dat-to-json` | 文件分档看 CPU/GC | 1,5,10,20 |

每级持续 10~15 分钟。发现瓶颈后再针对性扩展到同组其他接口。

**A-3 专项维度**

| 接口 | 维度 |
|---|---|
| `GET /trades` | 数据量 1万/10万/50万/100万 × {首页、深分页、按时间排序、按状态过滤、按 Counterparty 搜索、按唯一编号搜索} |
| `dat-to-json` | 文件 {小、中、大、错误、不完整} |
| `bulk-approve/reject` | 批次 {10,50,100,500,1000} × 并发 {1,2,5} |
| `trigger-event` | 见 5.6 |

### 5.3 场景 B：Create Trade E2E

结构见 7.2。关键设计点：

- 页面初始化的并行请求用 **Parallel Controller** 还原，否则串行执行高估页面加载耗时
- 后台轮询（`unread-count`）用**独立 Thread Group**，不混入主链路事务
- 每步失败策略遵循第 6 章
- 每次迭代打 `pathFlavor` 标签，分路径统计

**路径权重**（risk-engine 健康时）：

| 路径 | 预期占比 |
|---|---:|
| Happy path | ~95% |
| Risk rejected → 用户继续创建 | ~3% |
| Risk rejected → 用户放弃 | ~2% |

> 放弃路径必须建模。全部走完整链路会高估 Create 的实际到达量。

### 5.4 场景 C：依赖降级隔离测试

统一设计：**恒定到达率的背景负载 + 时间窗口内注入下游干扰 + 观察未依赖该下游的接口是否被连累**。

干扰注入手段（按可行性）：并发打满该下游 / Toxiproxy 或服务网格故障注入（推荐，可精确控制且可重复）/ 缩容下游实例 / Mock 下游。

---

**C-1：UC gRPC 降级**（优先级最高）

```text
背景负载（开环，持续 30 min）：
  GET /trades          @ 目标 TPS
  GET /trades/{id}     @ 目标 TPS
  GET /notifications/unread-count  @ 轮询速率
  POST /trades/create  @ 目标 TPS      ← 不依赖 UC，用作对照组

干扰（第 10~20 min）：
  阶段1 UC 高延迟（P95 → 5s）
  阶段2 UC 超时率 50%
  阶段3 UC 完全不可用
```

| 观察项 | 通过 | 失败（隔离缺失） |
|---|---|---|
| `GET /trades` / `{id}` P95 | 有劣化但可接受，或能降级返回（enrich 字段缺失但主体可用） | 直接 5xx / 超时，整页不可用 |
| **`POST /trades/create` P95** | **劣化 < 10%** | **劣化 > 30% → API Service 线程池被 UC 调用阻塞** |
| `unread-count` P95 | 不受影响 | 受影响即证明共享线程池 |
| API Service 对 UC 的连接池 | 独立、有上限 | 与其他下游共用池 |

**关键判定**：`create` 和 `unread-count` 完全不依赖 UC，若它们在 UC 降级时也变慢，说明 API Service 缺少舱壁隔离——这是 P1 架构缺陷，不是调优项。

**附加检查**：`GET /trades` 是否对 UC 做了 **N+1 调用**（每行 trade 单独查一次 checker 信息）。分页 size=20 与 size=100 时 UC 调用量若呈线性增长，即为 N+1，是深分页性能问题的根因。

---

**C-2：risk-engine 降级**

```text
背景负载：calculate-risk-for-new、risk-metrics、POST /trades/create（对照组）
干扰：risk-engine 高延迟 → 超时 → 不可用
```

| 观察项 | 通过 | 失败 |
|---|---|---|
| **`POST /trades/create`** | **劣化 < 10%，错误率不上升** | 出现 5xx 或超时 |
| `GET /trades` / `{id}` | 不受影响 | 受影响即证明共享资源 |
| risk 相关接口 | 快速失败（有超时与熔断） | 长时间挂起，耗尽线程 |

`create` 是本场景的核心对照组——它在依赖表中明确不含 risk-engine。

---

**C-3：notification gRPC 降级**

背景负载：`bulk-approve`、`approve`。观察审批是否因通知发送失败而整体回滚，或通知是否为异步、失败仅降级。
**关键问题**：通知发送是否在审批事务内？若是，通知服务抖动会拉长事务、加剧锁竞争——这是应当发现的设计问题。

### 5.5 场景 D：DAT parsing CPU 竞争

DAT parsing 是**进程内 CPU/内存密集操作**，不是 gRPC 下游。它被 create、calculate-risk-for-new、dat-to-json 共用。

```text
背景负载（持续）：
  GET /refdata/counterparties     ← 与 DAT 毫无业务关系的轻量接口
  GET /trades/{id}
  GET /notifications/unread-count

干扰（时间窗口）：
  POST /trades/dat-to-json  大文件 × 高并发
```

**观察**：无关接口的 P95 是否上升、API Service CPU 是否饱和、Full GC 频率、堆内存峰值、文件句柄数。

**判定**：无关接口劣化 > 20% 说明 DAT 解析缺少资源隔离（独立线程池、并发上限、文件大小限制）。这类问题在单接口测试中完全不会暴露。

### 5.6 场景 E：两类批量写路径（区分设计）

`trigger-event` 与 `bulk-approve` 都标注为 Batch; Write，但**风险模型完全不同**，必须分开设计。

---

**E-1：`POST /trades/trigger-event` — 写放大 / 工作流发起型**

依赖：DB; business rules; checker workflow; WebSocket; notification

特征（**假设，需确认**）：一次请求触发 N 笔 trade 的事件 → 产生 N 个 checker task → N 条通知 → WS 推送。**风险在下游产出洪峰，而非请求本身。**

| 项目 | 设计 |
|---|---|
| 主测试维度 | **单次触发影响的 trade 数量 N**：1 / 10 / 50 / 100 / 500 |
| 并发 | 低（1 / 2 / 5），重点不在并发 |
| 核心观察 | 响应时间随 N 的**增长曲线是否线性**；checker task 表写入速率；notification 队列积压；business rules 计算耗时占比 |
| 关键风险 | 业务规则计算随 N 非线性增长；下游任务/通知洪峰；WS 推送积压（本轮不测，见附录 C） |
| 失败信号 | N 翻倍而耗时超过 2 倍 → 存在 N² 逻辑；notification 队列持续增长不回落 → 下游消费能力不足 |

---

**E-2：`bulk-approve` / `bulk-reject` — 事务性批量完成型**

依赖：DB; UC gRPC; notification gRPC; transaction

特征：一次请求在**单个事务内**完成 N 个任务，含 N 次 UC 权限校验与 N 条通知。**风险在事务本身。**

| 项目 | 设计 |
|---|---|
| 主测试维度 | **单请求批次大小**：10 / 50 / 100 / 500 / 1000，× 并发 1 / 2 / 5 |
| 核心观察 | 事务时长；行锁/表锁等待；**UC gRPC 调用次数是否为 N**（N+1 问题）；通知发送是否在事务内；回滚率与回滚耗时 |
| 关键风险 | 长事务阻塞其他写操作；批次过大导致事务超时后全量回滚；UC 或 notification 的 N+1 调用 |
| 失败信号 | 批次 500 时锁等待显著上升 → 需要分批提交；UC 调用次数 = 批次大小 → 未做批量化 |

> **两者的"批量"含义不同**：trigger-event 的 N 决定**产出多少下游工作**，bulk-approve 的 N 决定**单个事务多大**。前者的风险在下游洪峰，后者的风险在事务与锁。因此归属两个独立 jmx，负载模型也不同。

### 5.7 场景 F：混合负载

无生产数据时的 v0 假设模型（每条假设显式记录，上线后修正）：

| 场景 | 权重 | 主要接口 |
|---|---:|---|
| Trade 查询 | 40% | list、detail、risk-metrics |
| Create Trade E2E | 30% | refdata、dat-to-json、calc-risk、create |
| Maker-Checker | 15% | pending、approve/reject、uc check |
| Trade Update / Trigger Event | 10% | update、trigger-event |
| Notification / RefData 独立查询 | 5% | unread-count、inbox、refdata |

修正依据：生产访问日志、APM、API Gateway 统计、前端埋点、业务日交易量与峰值小时交易量。

### 5.8 场景 G：批处理与在线业务并行

批处理接口在生产中会与在线业务同时运行，单独测批处理会漏掉相互影响。

```text
背景：混合负载场景 F @ 正常水位，持续运行
干扰：启动 trade-aging/process-all（全量）或 sync-cashflows-batch
观察：在线接口 P95 是否劣化；DB CPU/IOPS；锁等待；连接池是否被批处理占满
```

**这是最贴近生产事故的场景之一**——批处理任务在业务高峰期跑，把数据库连接池占满。建议纳入首轮。

---

## 6. 失败处理策略矩阵

原则：**按依赖类型区分策略，并对每条路径分别统计**。

| 步骤 | 失败类型 | 策略 | JMeter 实现 |
|---|---|---|---|
| Login / Token | 致命 | 停止测试 | setUp 断言失败 → Stop Test |
| refdata counterparties / portfolios | 硬数据依赖 | **中止本次迭代** | 提取值 NOT_FOUND → `ctx.getThread().startNextLoop()` |
| Build payload | 脚本错误 | **中止本次迭代**并计数告警 | 抛异常并记录 |
| dat-to-json | 业务软失败 | **继续**，置 `datOk=false` | Thread Group action = Continue |
| calculate-risk-for-new | 业务软失败 | **继续**，按配置比例决定继续或放弃 | 见 6.2 |
| create | 关键步骤 | 失败则**跳过后续观察步骤** | If Controller 判断 `${createdTradeId}` |
| 列表定位 / 详情 / risk-metrics | 观察性 | 继续，记录标志位 | |

**Thread Group 的 "Action to be taken after a Sampler error" 设为 `Continue`**，硬依赖的中止由显式 If Controller / `startNextLoop()` 控制。设成 `Start Next Thread Loop` 会连软失败一起中止，与业务不符。

### 6.1 硬依赖门禁

```text
If Controller
  Condition: ${__jexl3("${counterpartyFmid}" != "NOT_FOUND" && "${portfolioId}" != "NOT_FOUND")}
    └── [后续全部步骤]
```

### 6.2 风控失败后的用户行为建模

```groovy
// groovy/risk-result-router.groovy —— JSR223 PostProcessor
import java.util.concurrent.ThreadLocalRandom

boolean riskPassed = /* 解析响应业务状态 */
vars.put('riskOk', String.valueOf(riskPassed))

if (riskPassed) {
    vars.put('pathFlavor', 'happy')
    vars.put('proceedToCreate', 'true')
} else {
    int proceedPct = Integer.parseInt(props.getProperty('riskFailProceedPct') ?: '50')
    boolean proceed = ThreadLocalRandom.current().nextInt(100) < proceedPct
    vars.put('pathFlavor', proceed ? 'risk_failed_proceed' : 'risk_failed_abandon')
    vars.put('proceedToCreate', String.valueOf(proceed))
}
```

---

## 7. JMeter 工程结构

> **已落地**：本章的结构已实现在 [`../trade-performance/`](../trade-performance/)，
> 以 create-trade 为样板（1 条 E2E 链路 + 1 个单接口容量测试）。
> 其余 32 个 API 按同样模式扩展。运行方式与已知偏差见该目录的 `README.md`。
> 下面的目录树是完整目标态，实际已建的是其中一个可运行子集。

### 7.1 四层架构

```text
业务逻辑（唯一真相来源） → fragments/    不含 Thread Group，不可独立运行
用户旅程（组合 + 分流）  → journeys/     不含 Thread Group
可执行场景（薄壳）       → scenarios/    Thread Group + Include，≈20 行
组合套件（薄壳）         → suites/       多 Thread Group，按权重配比
```

**根本约束**：含 Thread Group 的 jmx 无法被 Include Controller 引用。因此业务流程**必须**住在 fragment 里，scenario 与 suite 只能是壳。API 变更时只改 fragment，所有引用方自动生效。

**Fragment 抽取规则**：只有被 **2 个以上 journey** 使用的步骤才抽成 fragment，否则内联。JMeter 过度拆分的代价（路径解析、GUI 跳转、调试困难）通常大于收益。

### 7.2 目录结构

```text
trade-performance/
├── jmx/
│   ├── fragments/                          # ← 不可运行（Test Fragment，无 Thread Group）
│   │   ├── setup/                          # 供 setUp Thread Group 引用
│   │   │   └── refdata-preflight.jmx       # 参考数据解析 + 前置校验 + 快照归档
│   │   ├── steps/                          # 被 2+ journey 复用
│   │   │   ├── refdata-load.jmx            # counterparties + portfolios（并行）
│   │   │   ├── build-trade-payload.jmx
│   │   │   ├── create-trade.jmx            # payloadSource=built|pool
│   │   │   ├── locate-trade.jmx
│   │   │   ├── view-trade-details.jmx      # detail + risk-metrics
│   │   │   └── checker-pick-task.jmx
│   │   ├── generic-sampler.jmx             # 数据驱动核心
│   │   └── teardown.jmx
│   │
│   ├── api/                                # ← 可运行（单接口基线）
│   │   ├── g00-generic.jmx                 # 17 个接口，Sweep / Focus 双模式
│   │   ├── p01-trade-list.jmx              # 数据量分档 × 查询矩阵
│   │   ├── p02-trade-write.jmx             # create / update
│   │   ├── p03-risk-compute.jmx            # calculate-risk ×3
│   │   ├── p04-upload-parse.jmx            # dat-to-json / schema parse
│   │   ├── p05-checker-approval.jmx        # bulk ×2 + single ×2
│   │   ├── p06-trigger-event.jmx           # 写放大维度
│   │   ├── b01-trade-aging.jmx
│   │   ├── b02-cashflow-batch.jmx
│   │   └── g99-all-api-smoke.jmx           # 33 个各打一次，1 VU，CI 每晚
│   │
│   ├── journeys/                           # ← 不可运行（Test Fragment，无 Thread Group）
│   │   ├── j01-create-trade.jmx
│   │   ├── j02-trade-query.jmx
│   │   ├── j03-maker-checker.jmx           # 生产者—消费者
│   │   ├── j04-trade-update.jmx
│   │   ├── j05-partial-novation.jmx
│   │   └── j06-background-poll.jmx         # unread-count 轮询
│   │
│   ├── scenarios/                          # ← 可运行（薄壳：Thread Group + Include）
│   │
│   ├── suites/                             # ← 可运行（多 Thread Group）
│   │   ├── m01-mixed-load.jmx
│   │   ├── m02-degrade-uc.jmx              # 优先级最高
│   │   ├── m03-degrade-risk-engine.jmx
│   │   ├── m04-degrade-notification.jmx
│   │   ├── m05-dat-cpu-contention.jmx
│   │   └── m06-batch-under-online-load.jmx
│   │
│   └── ops/                                # ← 可运行
│       ├── z01-seed-pools.jmx
│       └── z99-cleanup.jmx
│
├── groovy/                                 # 脚本外置，不内联
│   ├── resolve-identity.groovy             # X-User-Id（无 login/token）
│   ├── build-refdata-pools.groovy
│   ├── select-refdata.groovy
│   ├── build-trade-payload.groovy
│   ├── assert-create-response.groovy       # 三类错误分离
│   ├── preflight-policy.groovy
│   └── risk-result-router.groovy
│
├── config/{dev,sit,perf}.properties        # 维度二：环境
├── profiles/                               # 维度三：负载模型
│   ├── smoke.properties
│   ├── baseline.properties
│   ├── load.properties
│   ├── stress.properties
│   └── soak.properties
│
├── data/
│   ├── api-catalog/endpoints.csv           # API 注册表 + 数据驱动输入
│   ├── pools/                              # 见 4.3
│   ├── dat/{small,medium,large,invalid}/
│   ├── payloads/                           # 单接口测试用预生成 payload
│   ├── shared/accounts.csv                 # 多账号（Maker / Checker）
│   ├── create-trade/                       # 按场景隔离，避免相互踩踏
│   └── har/
│
├── scripts/
│   ├── run.sh
│   ├── gen-payloads.groovy
│   └── assert-sla.py
├── taurus/
└── results/  reports/
```

### 7.3 Fragment 契约

Fragment 之间靠 JMeter 变量隐式传递，必须显式声明契约（放在 fragment 顶部的 User Defined Variables 或同名 `.md`）：

```text
steps/create-trade.jmx

【输入变量】
  counterpartyFmid  必填  来自 steps/refdata-load
  portfolioId       必填  来自 steps/refdata-load
  datFile           必填  来自 CSV
  payloadSource     可选  built(默认) | pool

【输出变量】
  tradeReference    本次业务唯一标识
  createdTradeId    成功时的 id，失败为 NOT_FOUND

【依赖属性】  templateDir, payloadPoolDir
【产出事务】  TX_workers_trademgmt_create
```

`payloadSource` 是同一 fragment 服务 E2E 与单接口测试的关键：E2E 走 `built`（现场构建），单接口基线走 `pool`（读预生成文件，排除脚本计算开销）。**没有参数化的 fragment 复用不了。**

### 7.4 三维正交与执行入口

线程数、时长、ramp-up **一律不写进 jmx**：

```text
Number of Threads: ${__P(threads,1)}
Ramp-up:           ${__P(rampUp,10)}
Duration:          ${__P(duration,60)}
```

`-q` 可重复指定，后者覆盖前者：

```bash
jmeter -n -t jmx/scenarios/s01-create-trade-e2e.jmx \
  -q config/perf.properties \
  -q profiles/load.properties \
  -l results/... -e -o reports/...
```

`run.sh` 封装为三参数入口：

```bash
./scripts/run.sh s01-create-trade-e2e perf load
./scripts/run.sh s01-create-trade-e2e perf smoke          # 同场景换负载
./scripts/run.sh api-generic          perf stress --focus trade_detail
./scripts/run.sh api-generic          perf smoke  --grade P1
./scripts/run.sh m02-degrade-uc       perf load
```

同时生成 **run manifest**：脚本 git commit、被测应用版本、环境、profile、全部生效属性、数据池规模与生成时间。这是"每次只改一个变量"这条纪律能被事后验证的前提。

### 7.5 数据驱动 runner

`g00-generic.jmx` 的 HTTP Sampler 名称设为 `${apiId}`——JMeter 用解析后的名称作为报告标签，每个 API 在报表里独立成行。

**两种模式：**

| 模式 | 用途 | 实现 |
|---|---|---|
| **Sweep** | 全量回归 / 冒烟，低负载遍历 | 读完整 CSV，3~5 VU |
| **Focus** | 单接口容量测试 | `run.sh` 按 `apiId` 或 `grade` 预筛生成临时 CSV，JMeter 只读筛选结果 |

在 JMeter 内用 If Controller 过滤也可实现，但 CSV 会空转大量行；在 `run.sh` 里用 `awk` 预筛更干净。

### 7.6 `endpoints.csv` 设计

```csv
apiId,grade,domain,method,path,queryParams,bodyFile,contentType,expectedStatus,assertPath,assertOp,assertValue,dataPool,downstream,owner,lastVerified
trade_detail,P0,Trade,GET,/api/v1/trades/${tradeId},,,,200,id,eq,${tradeId},trade-ids.csv,uc-grpc,zhang,2026-07-25
risk_metrics_all,P0,Trade,GET,/api/v1/trades/${tradeId}/risk-metrics,,,,200,metrics,exists,,trade-ids.csv,risk-engine,zhang,2026-07-25
notif_unread,P0,Notification,GET,/api/v1/notifications/unread-count,,,,200,count,exists,,,db,li,2026-07-25
refdata_cp_search,P1,RefData,GET,/api/v1/refdata/counterparties/search,q=${searchTerm},,,200,,,,search-terms.csv,refdata-db,zhang,2026-07-25
uc_check_maker,P1,UserCenter,GET,/api/v1/uc/entitlements/check/maker,,,,200,,,,,uc-db,wang,2026-07-25
```

三个字段值得强调：

- **`dataPool`** — 声明所需 ID 池，`generic-sampler` 据此加载对应 CSV
- **`downstream`** — 依赖标注，降级测试可直接按下游筛选（"UC 降级时把所有 `downstream=uc-grpc` 的接口拉出来跑"），无需维护第二份清单
- **`lastVerified`** — 资产保鲜，由 `g99-all-api-smoke` 自动更新

这张表同时是**测试范围的事实来源**——评审覆盖范围直接看它，不用翻 jmx。

> 若有 OpenAPI / Swagger，建议写脚本从 spec 生成 `endpoints.csv` 骨架并在 CI 里 diff，新增接口自动进入待办。

### 7.7 Include Controller 的坑

1. **被引用文件里不能有 Thread Group**，只能是 Test Fragment
2. **路径解析**：在 `user.properties` 统一设 `includecontroller.prefix=<工程绝对路径>/`，否则相对路径取决于工作目录，换机器即断
3. **路径不支持运行时变量**（测试计划加载期解析），只能用 `${__P()}`
4. **嵌套 Include 可用**（journey 引用 step），但不超过 2 层，否则 GUI 无法调试
5. **Module Controller 只在同一棵树内有效**，按名称路径引用，重命名 fragment 会静默失效
6. **CSV Data Set 放在 fragment 里**时 Sharing mode 设 `All threads`，同一文件只会被打开一次

### 7.8 Groovy 外置

JSR223 元件一律用 **Script file** 指向 `groovy/*.groovy`：jmx 是 XML，内联脚本 diff 不可读且必冲突；外置可用 IDE 编辑、有语法检查、能被多 fragment 共用；**外置脚本会被编译缓存**，内联脚本在高并发下反复编译是真实的客户端开销。

### 7.9 分布式压测

- fragment、groovy、data 必须在**所有压力机的相同绝对路径**下存在
- 属性用 `-G` 传递才会同步到 remote engines（`-J` 只作用于 controller）
- CSV 若按行消费需按压力机切分，避免重复使用
- `tradeReference` 必须含压力机标识（见 8.2）

---

## 8. 脚本设计规范（必修项）

### 8.1 计时口径

**所有 Transaction Controller 必须取消勾选 "Include duration of timer and pre-post processors in generated sample"。**

- 新建时 GUI 默认不勾选，但**属性缺失或从旧版本升级的 JMX 会按 true 处理**，需逐个确认
- 勾选状态下 1~3 秒 think time 会计入事务耗时，P95 完全不可用于 SLA 对照
- Timer 放在 Transaction Controller **之外**
- 如需"含思考时间的用户旅程时长"，用外层独立 Transaction Controller 统计并标明口径

### 8.2 数据与参数化

**CSV Data Set Config：**

```text
Recycle on EOF: True          ← 必须；False 会导致测试开跑即停
Stop thread on EOF: False
Sharing mode: All threads
```

唯一性由 `tradeReference` 保证，而非 CSV 行数。

**唯一业务标识（含压力机标识）：**

```groovy
String tradeReference = "PERF-${InetAddress.localHost.hostName}-${ctx.getThreadNum()}-${System.currentTimeMillis()}-${vars.getIteration()}"
```

**多账号**（`data/shared/accounts.csv`）：避免全场共用单一身份绕过按用户限流；Maker-Checker 场景中 Maker 与 Checker 必须不同用户。

### 8.3 Payload 构建

**用 JSR223 PreProcessor**（挂在请求上），不用独立 Sampler——独立 Sampler 会进入 JTL，虚增 TPS 并拉低平均值，报表出现不存在的"接口"。

**临时文件每线程复用单个**，不要每迭代新建：

```groovy
Path threadDir = Paths.get(System.getProperty('java.io.tmpdir'), 'jmeter-trade-payloads')
Files.createDirectories(threadDir)
Path blob = threadDir.resolve("blob-${host}-${ctx.getThreadNum()}.json")   // 反复覆盖
Files.write(blob, JsonOutput.toJson(trade).getBytes(StandardCharsets.UTF_8))
```

tearDown 中删除整个目录。v1 每迭代新建文件，8 小时 Soak 会产生数万文件。

> **注意**：Create 自行解析原始 .dat，不需要合并 dat-to-json 的响应。该假设必须用 HAR 中的真实 create 请求体核实后才能定稿。

### 8.4 身份模型（无 login / 无 token）

**本系统没有登录接口，也没有 token。所有 API 的权限由 `X-User-Id` 请求头决定。**

这消掉了原方案里的整块内容：不需要 setUp 登录、不需要后台刷新 Thread Group、
不需要 401 兜底重试、Soak 中也不存在 token 过期导致全场作废的风险。
`fragments/setup/` 里因此**没有** `auth-login.jmx` 与 `token-refresh.jmx`。

**但"身份"这个维度并没有消失。** 若服务端按 maker 做过滤、计数或加锁，
20 个线程共用一个 `X-User-Id` 与分散到 20 个用户，压出来的数会显著不同。所以仍需参数化：

| 属性 | 取值 | 用途 |
|---|---|---|
| `userMode` | `pool`（默认） | 从 `data/shared/accounts.csv` 轮换 |
| | `fixed` | 全部线程共用 `fixedUserId`，测 per-user 锁/计数器竞争 |

与 `portfolioSelect=roundRobin\|fixed` 完全同构——同一份脚本靠属性切换即可跑两个相反的对照实验。

**身份解析必须挂在 Test Plan 层**（`groovy/resolve-identity.groovy`），不能挂在 create 上：
E2E journey 里 refdata 查询跑在 create 之前，挂在 create 上会导致同一次迭代内出现两个身份，
等于测了一个不存在的场景。

> **待确认**：真实 curl 同时带了 `X-User-ID: anonymous` 和 `X-User-Id: maker@sc.com`。
> 按 RFC 7230 §3.2 header 名大小写不敏感，两者是**同一个 header**。
> 工程里暂时原样保留以复现"已知可用"的请求，但首次 smoke 必须确认实际发出去的是什么
> ——JMeter 底层 HttpClient 可能合并或覆盖。见 `trade-performance/README.md`「第一次跑之前」#2。

### 8.5 结果打标

```properties
sample_variables=tradeReference,apiId,pathFlavor,riskOk,datOk,locateOk
```

JTL 追加对应列，分析时按 `pathFlavor` 过滤，得到 happy path 的 P95（用于 SLA 判定）、降级路径的 P95、各路径实际占比（校验负载模型）。**不做这一步，降级时段数据会与正常数据混在一起，P95 失去意义。**

---

## 9. 负载模型

### 9.1 开环与闭环

| 测试目的 | 模型 | JMeter 实现 |
|---|---|---|
| 找容量上限 / 单接口 TPS | **开环** | `bzm - Arrivals Thread Group`，或 Concurrency Thread Group + Precise Throughput Timer |
| 模拟真实用户体验 / E2E 场景 | 闭环 | 标准 / Concurrency Thread Group |
| 降级与竞争测试的背景负载 | **开环** | 干扰期间必须恒定发压，否则观察不到真实影响 |

固定线程数在系统变慢时自动降压，测出的是虚假容量。

### 9.2 负载梯度

| 阶段 | 配置 | 时长 | 目的 |
|---|---|---|---|
| 调试 | 1 线程 1 循环 | — | 验证关联 |
| Smoke | 2 线程 | 2~5 min | 脚本可跑、数据不冲突、监控通路正常 |
| Baseline | 5~10 线程 | 10~15 min | 建立低负载基线 |
| Load | 按目标业务量换算 | 30 min | 验证 SLA |
| Stress | 逐级加压至拐点 | 每级 10~20 min | 找拐点与最先饱和的资源 |
| Spike | 瞬间 3~5 倍再回落 | 5 min | 突发承受与恢复 |
| Soak | 峰值 70%~100% | 2~8 h | 泄漏、GC 恶化、队列积压 |

### 9.3 并发换算

```text
并发用户数 ≈ 目标 TPS × 单次完整业务耗时（含 think time）
例：2 笔/秒 × 20 秒/笔 = 40 并发
```

必须通过小规模试跑校准。

---

## 10. 指标口径与判定

### 10.1 三类错误分离

| 类别 | 定义 | 计入 SLA | 处理 |
|---|---|:---:|---|
| **技术错误** | HTTP 5xx、超时、连接重置、连接池耗尽 | **是** | 违反 SLA，需定位修复 |
| **业务拒绝** | HTTP 200 但业务状态为拒绝（如风控未通过） | 否 | 单独统计"拒绝率"，异常波动需排查 |
| **脚本错误** | 提取器 NOT_FOUND、模板缺失、变量为空 | 否 | **必须为 0**，非 0 说明测试不可信 |

### 10.2 指标要求

- 报 **P50 / P90 / P95 / P99**，平均值仅参考，**不作 SLA 依据**
- 延迟必须与错误率**并排呈现**——快速失败的系统"看起来更快"
- 记录**拐点**：TPS 不再增长而延迟开始爬升的位置
- 轮询定位（`TX_Locate_Trade`）耗时**独立统计**
- E2E 事务标注是否含 think time
- 批量接口额外记录：**单位工作量耗时**（总耗时 ÷ 批次大小），用于判断是否线性

### 10.3 SLA 模板

> ⚠️ **本表已被 [OREO NFR](performance/oreo-nfr.zh.md) §2 取代**，保留仅作历史对照。
> NFR 中的 PERF-01~21 给出了带推导依据的提议值，并按文件档位拆分了上传类阈值、
> 按 submit / approve / reject 拆分了审批类阈值。**阈值以 NFR 为准，本表不再维护。**

| API / 场景 | P95 | P99 | 技术错误率 | 备注 |
|---|---:|---:|---:|---|
| RefData / UC / Product 查询 | 待确认 | 待确认 | < 0.1% | |
| `GET /trades` | 待确认 | 待确认 | < 0.1% | 需标注数据量 |
| `GET /trades/{id}` | 待确认 | 待确认 | < 0.1% | |
| `GET risk-metrics` | 待确认 | 待确认 | < 0.5% | |
| `dat-to-json` | 待确认 | 待确认 | < 0.5% | 需标注文件大小 |
| `calculate-risk-for-new` | 待确认 | 待确认 | < 1% | |
| **`POST /trades/create`** | 待确认 | 待确认 | < 0.5% | |
| `bulk-approve` | 待确认 | 待确认 | < 0.5% | 需标注批次大小 |
| `trigger-event` | 待确认 | 待确认 | < 0.5% | 需标注影响 trade 数 |
| Create Trade E2E（不含 think time） | 待确认 | 待确认 | < 1% | 仅 happy path |

**架构性判定标准（无需业务确认，可直接生效）：**

| 判定项 | 标准 |
|---|---|
| UC 降级期间，`create` / `unread-count` 劣化 | **< 10%** |
| risk-engine 降级期间，`create` / `GET /trades` 劣化 | **< 10%** |
| DAT 大文件高并发期间，无关只读接口劣化 | **< 20%** |
| 批处理运行期间，在线接口劣化 | **< 20%** |
| 脚本错误率 | **= 0** |

### 10.4 自动化判定

JMeter 无内置 threshold，需外挂一层：

**Taurus（推荐）**

```yaml
reporting:
  - module: passfail
    criteria:
      - 'p95 of TX_workers_trademgmt_create>1500ms for 1m, stop as failed'
      - 'failures of TX_workers_trademgmt_create>0.5% for 1m, stop as failed'
      - 'failures of TX_Page_Init>0.1% for 1m, stop as failed'
```

**或 `scripts/assert-sla.py`**：解析 JTL，按 `apiId` / `pathFlavor` 分组对照 SLA，以退出码反映结论——这是接入 CI 的前提。

---

## 11. 服务端监控

**API Service**：CPU、Heap、GC、线程池活跃/队列、HTTP 活跃请求；**分下游的连接池使用率**（UC / risk-engine / notification 是否独立，是隔离测试的关键指标）

**UC Service**：调用量、耗时、UC DB 连接与慢查询、**是否被 N+1 调用**

**Risk Engine**：调用量、计算耗时、线程池、任务队列深度、超时数、失败率

**Notification Service**：发送速率、失败重试、队列积压、DLQ

**Database**：连接池使用率、慢 SQL、锁等待、事务时长、CPU、IOPS、Active Sessions

**Cache**：命中率、连接数、Eviction、内存

监控与压测时间轴对齐是分析前提。建议 JMeter 通过 Backend Listener 输出到与服务端监控相同的时序库，在同一 Grafana 看板对照。

---

## 12. 结果分析路径

| 现象 | 首要排查方向 |
|---|---|
| Risk 单接口慢，风险相关接口全慢 | Risk Engine 自身：CPU、线程池、下游计算节点、队列深度 |
| `GET /trades` 慢但 `GET /trades/{id}` 正常 | 分页/排序 SQL、数据量、UC 的 N+1 调用 |
| 所有单接口都快，E2E 慢 | 步骤间等待、轮询耗时、共享连接池/线程池、DB 事务竞争 |
| **UC 降级时 create 也劣化** | **舱壁隔离缺失**：共享线程池/连接池，缺超时与熔断 —— 架构缺陷 |
| **DAT 大文件并发时无关接口变慢** | **进程内资源竞争**：解析缺少并发上限与文件大小限制 |
| **bulk 批次增大后耗时超线性增长** | 长事务锁等待、UC/notification 的 N+1 调用、缺少分批提交 |
| **trigger-event 的 N 翻倍而耗时超 2 倍** | 业务规则存在 N² 逻辑，或下游任务/通知逐条同步发送 |
| 批处理运行时在线接口变慢 | 连接池被占满、DB IOPS 饱和、锁竞争 |
| 低并发正常，高并发骤然恶化 | 线程池/连接池/队列上限、下游限流、DB 锁、GC、CPU 饱和 |

---

## 13. 执行

```bash
./scripts/run.sh s01-create-trade-e2e perf load

# 等价的原始命令
jmeter -n -t jmx/scenarios/s01-create-trade-e2e.jmx \
  -q config/perf.properties -q profiles/load.properties \
  -Jsample_variables=tradeReference,apiId,pathFlavor,riskOk,datOk,locateOk \
  -l results/2026-07-25/s01_perf_load_1030.jtl \
  -e -o reports/2026-07-25/s01_perf_load_1030

python3 scripts/assert-sla.py results/.../*.jtl config/sla.yaml
```

**执行纪律：**

- **禁止 GUI 执行正式负载测试**
- 正式运行前禁用 View Results Tree / Table / Graph Results / Response Time Graph；保留 Simple Data Writer、Backend Listener、Summary Report
- 每次只改**一个变量**（负载等级、代码版本、基础设施配置三者不可同时变）
- 正式测量前预热（缓存、JIT、连接池），关键测试**执行两次**确认可重复
- 压测前标定压力机与 JMeter 自身容量，避免把工具瓶颈当系统瓶颈
- 严禁未经授权对生产或第三方服务发压；压测环境与时间需提前通知相关方

---

## 14. 数据清理

- 全部测试数据带统一前缀 `PERF-{host}-{thread}-{timestamp}-{iteration}`
- 使用专用测试 Portfolio 与 Counterparty
- **正式测试期间不做清理**，避免删除操作污染指标
- 结束后单独执行 `ops/z99-cleanup.jmx`
- 清理前保留必要审计证据与样本数据
- 一次性消费型数据池（pending task）用后即弃，下轮重新生成

---

## 15. 落地路线图

### 第一阶段（结构验证 + 核心覆盖）

1. **前置确认清单**（第 16 章）全部完成
2. 用 Create Trade 走通四层结构与 fragment 契约：`j01` + `p02` + `p03` + `p04`
3. 建 `g00-generic.jmx` + `endpoints.csv`，一次性铺入 17 个数据驱动接口
4. `g99-all-api-smoke.jmx` 接入 CI（每晚 1 VU 全量冒烟）
5. **深度容量测试 5 个依赖代表**（见 5.2）
6. **降级隔离测试 C-1（UC）+ C-2（risk-engine）**
7. 监控接入：API Service（含分下游连接池）、UC、Risk Engine、Database

### 第二阶段

`p01` 数据量分档、`p05` 审批批次矩阵、`p06` trigger-event 写放大、场景 D（DAT CPU 竞争）、Maker-Checker 与 Update 业务场景、混合负载

### 第三阶段

批处理 `b01`/`b02`、场景 G（批处理与在线并行）、2~8 小时 Soak、Spike、CI 性能冒烟门禁

> **不要反过来**——先追求 API 覆盖率会把结构问题放大到几十个文件里，返工成本极高。

---

## 16. 开工前置确认清单

未确认前不要开始正式脚本开发，任一项错误都会让结果失效。

**业务与接口**

- [ ] HAR 抓包完成，调用序列、并行关系、后台轮询已确认
- [ ] `create` 请求体结构核实：是否真的不需要合并 dat-to-json 响应？multipart part 名称与 Content-Type 是否与文档一致？
- [ ] 风控失败后前端行为：弹窗？自动继续？用户继续比例初始假设值？
- [ ] `GET /trades?search=` 是否支持按 externalReference 精确搜索，性能如何
- [ ] `create` 响应是否直接返回 tradeId（是则可删除整个列表定位与轮询逻辑）
- [ ] 最终一致性延迟实测：create 成功后多久能在列表查到
- [ ] **`trigger-event` 语义确认**：单次请求影响多少笔 trade？是否为每笔产生一个 checker task 和一条通知？（5.6 的测试维度基于此假设）
- [ ] `update` 是否有乐观锁版本号需要先读取

**依赖与架构**

- [ ] API Service 对 UC / risk-engine / notification 是否使用**独立线程池与连接池**（决定降级测试的预期结论）
- [ ] `GET /trades` 对 UC 是否为**逐行调用**（N+1）
- [ ] `bulk-approve` 的 UC 校验与通知发送是否**批量化**、是否在事务内
- [ ] DAT parsing 是否有并发上限与文件大小限制

**环境与数据**

- [ ] 压测环境规格与生产差异（用于报告缩放说明）
- [ ] 压测环境已有数据量（影响 `GET /trades` 基线可比性）
- [ ] 数据池生成方式（DB 灌数脚本可用性）与规模估算
- [ ] Token TTL 与刷新机制
- [ ] 降级干扰注入手段确认（Toxiproxy / 服务网格 / 缩容，需谁配合）

**流程**

- [ ] SLA 数值从业务侧获取
- [ ] 压测窗口与通知对象确认

---

## 附录 A：v1 问题修复对照

| # | v1 问题 | 后果 | v2 处理 |
|---|---|---|---|
| 1 | CSV `Recycle=False` + `Stop on EOF=True` + 2 行数据 | 测试开跑数秒即全部线程停止 | Recycle=True，唯一性由 tradeReference 保证（8.2） |
| 2 | Transaction Controller 包含 Timer | E2E P95 混入 4~9 秒 think time | 取消勾选并把 Timer 移出事务（8.1） |
| 3 | ~~Risk 失败应中止 Create~~ | — | **结论有误**：Create 独立于 risk-engine，改为按依赖类型分策略并打路径标签（第 6 章） |
| 4 | 每迭代新建临时 payload 文件 | 8 小时 Soak 产生数万文件 | 每线程复用单文件 + tearDown 清理（8.3） |
| 5 | Build Payload 用 JSR223 Sampler | 虚假接口进 JTL，虚增 TPS | 改为 PreProcessor（8.3） |
| 6 | 全部固定线程数（闭环） | 系统变慢时自动降压，假容量 | 容量测试改用到达率驱动（9.1） |
| 7 | 无自动化通过/失败判定 | 结论依赖人工看报告 | Taurus passfail 或 assert-sla.py（10.4） |
| 8 | 身份未参数化 | 无 login/token，但 `X-User-Id` 集中到单一账号会掩盖 per-user 锁竞争 | `userMode=pool\|fixed` + accounts.csv（8.4） |
| 9 | payload 是否需合并 dat 解析结果未确认 | Risk 耗时可能被低估 | 列入前置确认清单（第 16 章） |
| 10 | 未考虑分布式线程号碰撞 | 多压力机时 tradeReference 重复 | 引用格式加压力机标识（8.2） |
| 11 | 页面初始化请求串行 | 高估页面加载事务耗时 | Parallel Controller 按 HAR 还原（5.3） |
| 12 | 未建模后台轮询与用户放弃 | 低估背景负载，高估 Create 到达量 | 独立轮询 Thread Group + 放弃路径（5.3） |
| 13 | 未验证依赖隔离 | 遗漏高风险架构缺陷 | 场景 C 全套（5.4） |
| 14 | 风控失败按技术错误统计 | SLA 错误率被业务拒绝污染 | 三类错误分离（10.1） |
| 15 | 统一 120s 响应超时 | 查询类接口严重劣化被掩盖 | 按接口类型分层设置 |
| 16 | 每 API 一棵元件树 | 33 个 API 下不可维护 | 数据驱动 + 专用分流（第 3、7 章） |
| 17 | 未考虑一次性消费型数据断供 | 持续压测中途失效 | 数据供给策略（第 4 章） |
| 18 | `trigger-event` 与 `bulk-approve` 混为一类 | 两类风险模型都测不到位 | 拆分为 E-1 / E-2（5.6） |

---

## 附录 B：工具选型说明

团队性能测试规范以 **k6 为主力**（见 Confluence `Performance Testing / Tooling / Tool Comparison & Selection`）。本项目选用 JMeter 的理由：

- multipart 双文件上传（JSON part + 二进制 part）图形化配置成熟
- 需在请求前用 Groovy 动态构建 payload 并落盘为文件 part
- 提取—断言—关联链路复杂，GUI 调试效率更高
- 团队已有 JMeter 存量资产与技能

**该例外应登记到 Tool Comparison 页面**（"multipart 复杂编排类 API 压测允许使用 JMeter"），避免后续以工具规范质疑本套脚本。若本项目将来需要 WebSocket 压测（见附录 C）或接入 CI 性能门禁，应评估迁移或补充 k6。

---

## 附录 C：已知覆盖缺口

### C-1 WebSocket 推送通道

| 项目 | 说明 |
|---|---|
| **缺口** | `POST /trades/create` 与 `POST /trades/trigger-event` 依赖 WebSocket 向前端推送更新，本方案只验证 HTTP 响应，不验证推送 |
| **本轮状态** | **Out of scope**（已确认） |
| **未覆盖的风险** | 高并发创建时推送积压、丢失或延迟；trigger-event 批量触发时推送洪峰；大量长连接下的连接管理与内存占用；前端收不到实时更新但 HTTP 全部成功——压测报告会显示"全绿"而实际用户体验受损 |
| **为何不用 JMeter 补** | JMeter 需第三方插件（WebSocket Samplers），且其请求—响应模型不适合异步推送流；一线程一连接的模型在海量长连接下压测机先成为瓶颈 |
| **建议的后续方案** | ① k6 原生支持 WS，适合做推送通道容量测试；② 少量 Playwright 实例挂在压测期间做推送到达性的定性验证（是否收到、延迟多少）。推荐组合使用：k6 测容量，Playwright 测到达性 |
| **重新评估时机** | 首轮压测完成后；或产品明确推送为关键体验时；或线上出现推送相关问题时 |

### C-2 前端渲染性能

页面首屏、TTI、LCP、大列表虚拟滚动等由 Playwright + CDP 承接，见 Confluence `Performance Testing / 8. Frontend & Web Performance`。本方案的"E2E"仅指协议层调用序列。

### C-3 gRPC 下游服务内部性能

UC、risk-engine、notification 的内部性能属下游团队职责。本方案只在降级测试中观察其对 Trade API 的影响，不直接对下游施压。
