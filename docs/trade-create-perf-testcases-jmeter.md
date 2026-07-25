# Create Trade API 性能测试用例与 JMeter 实操方案

> 目标接口：`POST /api/v1/trades/create`  
> 依据：真实 curl 请求与响应（dev 环境 `uklvadpta0005a.pi.dev.net:9089`）  
> 定位：本文是 [trade-api-perf-test-plan-v2-jmeter.md](trade-api-perf-test-plan-v2-jmeter.md) 落地路线图第一阶段的第一个样例，用于验证四层工程结构与 fragment 契约

---

## 1. 从真实请求得到的关键事实

### 1.1 请求结构

```bash
curl -X 'POST' \
  'http://uklvadpta0005a.pi.dev.net:9089/api/v1/trades/create' \
  -H 'accept: application/json' \
  -H 'X-Dyn-Run: false' \
  -H 'X-User-ID: anonymous' \
  -H 'X-User-Id: maker@sc.com' \
  -H 'Content-Type: multipart/form-data' \
  -F 'trade={"basic":{"portfolioId":"546a832e-7602-327d-b2cf-9cfa6085c9bb","counterpartyFmId":"400954563","counterpartyName":"PRINTINGINT10LTD*HKG","notionalCurrency":""}}' \
  -F 'datFile=@0_instrument.dat'
```

| 事实 | 说明 | 对脚本的影响 |
|---|---|---|
| **请求体是 `multipart/form-data`** | curl 检测到 `-F` 后会在该头上**自动追加 boundary**，实际发出的是 `multipart/form-data; boundary=...` | JMeter 勾选 "Use multipart/form-data for POST" 自动生成完整头；**不可手写**（见 4.2） |
| **`trade` 是普通表单字段，不是文件 part** | `-F 'trade={...}'` 无 `@` 前缀 | JMeter 用 **Parameters 页签**，不用 Files Upload；**无需写临时文件** |
| **`datFile` 是文件 part** | `-F 'datFile=@...'` | JMeter 用 Files Upload 页签 |
| **非文件 part 不带 Content-Type** | curl 只对带 filename 的 part 写 Content-Type | JMeter 需勾选 **"Browser-compatible headers"** 才一致（见 4.2） |
| **payload 仅 4 个字段** | portfolioId / counterpartyFmId / counterpartyName / notionalCurrency | payload 构建极简，无需 JSON 模板文件 |
| **`notionalCurrency` 传空串仍成功** | 响应返回 `"USD"` | 币种来自 .dat |
| **业务数据全部来自 .dat** | dealDate、valueDate、tradeType、productId、currencyPair、notionalAmount、rate 均未在请求中出现 | **测试数据的变异维度在 .dat 文件上** |
| **无 Authorization 头** | 身份靠 `X-User-Id` | token 刷新机制可能不需要（待确认 perf 环境） |
| **未指定 protocol/port 默认值** | HTTP、9089 | 非 HTTPS，perf 环境需确认 |

### 1.2 响应结构

```json
{
  "code": 200,
  "status": "PENDING APPROVAL",
  "msg": "Submitted for checker approval. TaskId: CHK-98C0DF19",
  "data": { "trade": { "id": "TRD-178494756767995", "basic": { ... } } }
}
```

| 事实 | 说明 | 对脚本的影响 |
|---|---|---|
| **HTTP 状态与业务状态分离** | body 内有独立的 `code` | 断言需三层：HTTP 200 + `code==200` + `status` 白名单 |
| **成功状态是 `PENDING APPROVAL`** | 不是 `CREATED` | 断言值修正 |
| **直接返回 `data.trade.id`** | `TRD-178494756767995` | **删除**列表定位与最终一致性轮询逻辑 |
| **每次 create 自动产生 checker task** | `TaskId: CHK-98C0DF19` | 持续压测会在审批队列**累积任务**，影响下游接口（用例 PT-010） |
| **TaskId 埋在 `msg` 字符串里，非结构化字段** | 需正则提取 | 脆弱；建议提 improvement 让后端返回结构化字段 |
| **trade 状态 `Pending Approval Draft`，eventStatus `New`** | 草稿态 | 不影响性能脚本，但清理时要按此状态筛选 |
| **`trader: "system"`** | 未使用 `X-User-Id` 的值 | 印证 1.3 的头部歧义问题 |

### 1.3 必须澄清的问题

| # | 问题 | 技术说明 | 影响 |
|---|---|---|---|
| 1 | **`X-User-ID: anonymous` 与 `X-User-Id: maker@sc.com` 同时存在** | HTTP 头名**大小写不敏感**（RFC 7230 §3.2），这是同一个头发了两次，服务端收到 `anonymous, maker@sc.com`；多数框架 `getHeader()` 只取第一个即 `anonymous` | 当前请求的实际身份不确定；权限校验是否被绕过需确认。**脚本只发一个头**，并对比行为是否一致 |
| 2 | **`X-Dyn-Run: false` 的语义** | 疑似"动态运行"开关 | 若 `true` 会触发实时定价或调用 risk-engine，则是一个**必须覆盖的性能维度**（耗时可能差一个量级） |
| 3 | **perf 环境的协议、端口、鉴权方式** | dev 是 HTTP + 头部身份 | 若 perf 用 HTTPS + Bearer token，需恢复 v2 的 token 刷新机制 |
| 4 | **是否接受 payload 中的额外字段** | 无 `externalReference` 可注入 | 决定清理策略（见 6.3） |
| 5 | **create 的 SLA 目标** | — | 决定 Response Timeout 与通过标准 |

---

## 2. 测试数据设计

### 2.1 核心原则

**变异维度在 .dat 文件上。** payload 的 4 个字段只决定归属（哪个组合、哪个交易对手），交易的产品类型、名义金额、期限、复杂度全部由 .dat 决定。因此 .dat 文件池是本接口的**首要测试资产**。

### 2.2 .dat 文件池

```text
data/dat/
├── fx_trf/                     # 按产品类型分目录
│   ├── small/    01..20.dat     # 最简结构，基准用
│   ├── medium/   01..20.dat
│   └── large/    01..10.dat     # 长期限、多现金流
├── <other_product>/            # 待补：确认还有哪些产品类型
└── invalid/
    ├── corrupt.dat              # 二进制损坏
    ├── truncated.dat            # 不完整
    ├── empty.dat                # 0 字节
    └── wrong-format.dat         # 非 dat 格式
```

需要向业务/开发确认：**支持哪些产品类型、各类型的典型文件大小区间、生产中的产品分布占比**。分布占比决定混合场景里各类型 .dat 的权重。

### 2.3 CSV 设计

`data/create-trade/create-trade-data.csv`

```csv
caseId,portfolioId,counterpartyFmId,counterpartyName,datFile,productType,datSize,notionalCurrency
C001,546a832e-7602-327d-b2cf-9cfa6085c9bb,400954563,PRINTINGINT10LTD*HKG,dat/fx_trf/small/01.dat,FX_TRF,small,
C002,546a832e-7602-327d-b2cf-9cfa6085c9bb,400954563,PRINTINGINT10LTD*HKG,dat/fx_trf/small/02.dat,FX_TRF,small,
C003,<perf_portfolio_2>,<cp_fmid_2>,<cp_name_2>,dat/fx_trf/medium/01.dat,FX_TRF,medium,
```

**注意 `notionalCurrency` 放在最后一列且为空**：JMeter 的 CSV Data Set 在行尾缺字段时行为不直观。稳妥做法是**把可空字段放最后并保留结尾逗号**，或改用哨兵值（如 `_EMPTY_`）在 Groovy 里转换。本方案采用前者，并在 Smoke 阶段用 Debug Sampler 确认变量确实为空串。

**CSV Data Set Config：**

```text
Filename:        ./data/create-trade/create-trade-data.csv
Variable Names:  caseId,portfolioId,counterpartyFmId,counterpartyName,datFile,productType,datSize,notionalCurrency
Recycle on EOF:      True
Stop thread on EOF:  False
Sharing mode:        All threads
```

### 2.4 环境数据准备

- **专用 PERF Portfolio**（至少 3~5 个），避免污染他人功能测试数据，也便于清理
- **专用 Counterparty**（或确认可复用现有的）
- portfolioId / counterpartyFmId 通过 `GET /refdata/portfolios`、`GET /refdata/counterparties` 预先查询并写入 CSV，**不在压测过程中查询**（单接口测试要纯净）

---

## 3. 性能测试用例

### 3.1 用例总览

| 用例 ID | 名称 | 类型 | 负载 | 时长 | 优先级 |
|---|---|---|---|---|---|
| PT-CREATE-001 | 脚本验证与单笔基线 | Debug | 1 VU × 1 | — | P0 |
| PT-CREATE-002 | Smoke | Smoke | 2 VU | 5 min | P0 |
| PT-CREATE-003 | 基线（Baseline） | Baseline | 5 VU | 15 min | P0 |
| PT-CREATE-004 | 梯度容量测试（找拐点） | Stress | 1→5→10→20→40 | 每级 12 min | P0 |
| PT-CREATE-005 | 恒定到达率负载（SLA 验证） | Load | 目标 TPS 开环 | 30 min | P0 |
| PT-CREATE-006 | .dat 文件大小分档 | 对比 | 10 VU × 3 档 | 每档 10 min | P0 |
| PT-CREATE-007 | 产品类型分档 | 对比 | 10 VU × N 档 | 每档 10 min | P1 |
| PT-CREATE-008 | `X-Dyn-Run: true` 对比 | 对比 | 10 VU | 10 min | P1（待确认语义） |
| PT-CREATE-009 | 无效 .dat 的失败快速性 | 错误路径 | 10 VU | 5 min | P1 |
| PT-CREATE-010 | Checker 任务累积影响 | 跨接口 | 持续 create + 周期查 pending | 2 h | **P0** |
| PT-CREATE-011 | 稳定性 Soak | Soak | 峰值 70% | 2~8 h | P1 |
| PT-CREATE-012 | 突增 Spike | Spike | 0→3~5 倍→回落 | 10 min | P1 |
| PT-CREATE-013 | risk-engine 降级对照 | 隔离 | create 恒定 + 干扰 | 30 min | **P0** |
| PT-CREATE-014 | 同一 Portfolio 并发竞争 | 竞争 | 20 VU 全打同一 portfolio | 10 min | P1 |

---

### 3.2 用例明细

#### PT-CREATE-001 脚本验证与单笔基线

| 项 | 内容 |
|---|---|
| 目的 | 验证 JMeter 请求与 curl 完全等价；取得单笔无竞争耗时 |
| 负载 | 1 线程，1 次循环，无 think time |
| 数据 | CSV 第一行（与 curl 完全相同的 portfolio / counterparty / dat） |
| 断言 | HTTP 200；`code==200`；`status=="PENDING APPROVAL"`；`data.trade.id` 匹配 `^TRD-\d+$`；`msg` 中能提取 `CHK-` 开头的 TaskId |
| 通过标准 | 响应体结构与 curl 一致；成功提取 tradeId 与 taskId |
| 观察点 | 单笔响应时间（作为后续所有对比的地板值）；请求原文（用 View Results Tree 逐字节对比 multipart 结构） |
| 备注 | **必须先用 Debug Sampler 确认 `${tradePayload}` 拼出的 JSON 与 curl 中的字符串一致**，包括空串字段 |

#### PT-CREATE-002 Smoke

| 项 | 内容 |
|---|---|
| 目的 | 确认脚本可持续运行、CSV 循环正常、数据无冲突、监控通路正常 |
| 负载 | 2 线程，ramp-up 10s，5 分钟 |
| 通过标准 | 错误率 0；**脚本错误 0**；CSV 未耗尽导致线程停止；服务端监控有数据 |
| 观察点 | 是否出现唯一键冲突；JTL 中 tradeId 是否全部唯一 |

#### PT-CREATE-003 基线（Baseline）

| 项 | 内容 |
|---|---|
| 目的 | 建立低负载基线，作为版本回归对比基准 |
| 负载 | 5 线程，ramp-up 60s，15 分钟，无 think time |
| 数据 | 统一使用 `small` 档 .dat，固定产品类型（消除数据变异） |
| 通过标准 | 错误率 < 0.5%；P95 记录归档 |
| 观察点 | P50/P90/P95/P99、TPS；API Service CPU/Heap/GC；DB 连接池、慢 SQL、事务时长；审批任务写入速率 |
| 归档 | 写入 `Performance Baselines` 页面，标注应用版本、环境规格、.dat 档位 |

#### PT-CREATE-004 梯度容量测试（找拐点）

| 项 | 内容 |
|---|---|
| 目的 | 找出 TPS 拐点与最先饱和的资源 |
| 负载 | 1 → 5 → 10 → 20 → 40 线程，每级 12 分钟（含 2 分钟爬坡），级间不停测 |
| 数据 | 固定 `small` 档，只变负载（**每次只改一个变量**） |
| 通过标准 | 本用例不判通过/失败，产出拐点位置 |
| 观察点 | 每级的 TPS 与 P95；**TPS 不再增长而 P95 开始爬升的位置即实际容量**；同时记录 API Service CPU、DB 连接池使用率、锁等待、审批任务表写入速率 |
| 注意 | 压测前先标定压力机自身容量（用 1 线程打一个静态资源确认工具无瓶颈） |

#### PT-CREATE-005 恒定到达率负载（SLA 验证）

| 项 | 内容 |
|---|---|
| 目的 | 在目标业务量下验证 SLA |
| 负载 | **开环模型**：`bzm - Arrivals Thread Group`，按目标 TPS 恒定发压，30 分钟 |
| 为何开环 | 固定线程数在系统变慢时会自动降压，测出的是虚假容量 |
| 通过标准 | P95 ≤ SLA（待业务确认）；技术错误率 < 0.5%；脚本错误 = 0 |
| 观察点 | 到达率是否稳定（若 JMeter 跟不上目标速率，说明压力机或系统已饱和）；错误率与延迟并排看 |

#### PT-CREATE-006 .dat 文件大小分档

| 项 | 内容 |
|---|---|
| 目的 | 量化文件大小对解析耗时与资源的影响 |
| 负载 | 10 线程 × 10 分钟 × 3 档（small / medium / large），三次独立运行 |
| 数据 | 每档独立 CSV，产品类型固定 |
| 通过标准 | 无（对比性用例） |
| 观察点 | 各档 P95 的比值；**API Service CPU 与 Full GC 次数**；堆内存峰值；是否出现临时文件或文件句柄泄漏 |
| 关键判断 | 若 large 档 P95 相对 small 档增长远超文件大小比例，说明解析算法存在非线性问题 |
| 关联 | 与 v2 方案场景 D（DAT CPU 竞争）联动——本用例给出单接口视角，场景 D 给出对无关接口的影响 |

#### PT-CREATE-007 产品类型分档

| 项 | 内容 |
|---|---|
| 目的 | 不同产品结构的解析与落库成本差异 |
| 负载 | 10 线程 × 10 分钟 × 每种产品类型 |
| 前置 | 需先确认支持哪些产品类型并准备对应 .dat |
| 观察点 | 各类型 P95；是否有某类型显著更慢（决定混合场景权重与是否需要单独 SLA） |

#### PT-CREATE-008 `X-Dyn-Run: true` 对比

| 项 | 内容 |
|---|---|
| 目的 | 量化该开关对性能的影响 |
| 前置 | **需先确认该头的语义**（见 1.3 #2）。若 `true` 会触发实时定价或调用 risk-engine，本用例升为 P0 |
| 负载 | 10 线程 × 10 分钟，`false` 与 `true` 各一次 |
| 观察点 | P95 差异；`true` 时是否出现新的下游调用（risk-engine / 定价服务的调用量变化） |

#### PT-CREATE-009 无效 .dat 的失败快速性

| 项 | 内容 |
|---|---|
| 目的 | 错误路径不应比成功路径更耗资源 |
| 负载 | 10 线程 × 5 分钟，全部使用 `invalid/` 下的文件 |
| 断言 | 期望**明确的业务错误**（4xx 或 `code != 200` 且有清晰 msg），**不应是 5xx 或超时** |
| 通过标准 | 无 5xx；无超时；失败响应时间 ≤ 成功路径 P95；CPU/内存无异常尖峰 |
| 关键风险 | 损坏文件导致解析器进入长循环或 OOM——这类问题只有专门测才会发现 |

#### PT-CREATE-010 Checker 任务累积影响（本轮新发现）

| 项 | 内容 |
|---|---|
| 背景 | **每次 create 自动产生一个 checker task**，持续压测会让审批队列单向增长 |
| 目的 | 验证审批队列增长是否会拖慢 create 自身与下游查询接口 |
| 负载 | create 按目标 TPS 恒定发压 2 小时；同时每 5 分钟采样一次 `GET /checker/tasks/pending` 与 `GET /notifications/unread-count`（低负载，仅测量） |
| 通过标准 | create 的 P95 在 2 小时内劣化 < 10%；`GET /checker/tasks/pending` P95 劣化 < 20% |
| 观察点 | 审批任务表行数增长曲线；`pending` 接口 P95 随任务数的变化；notification 表增长；相关索引是否有效 |
| 失败信号 | `pending` 接口 P95 随任务数线性增长 → 缺少分页限制或索引；create 自身变慢 → 任务表写入或索引维护成为瓶颈 |
| 备注 | 这是**跨接口的累积效应**，单接口测试发现不了。测试结束后必须清理，否则影响后续所有测试的基线 |

#### PT-CREATE-011 稳定性 Soak

| 项 | 内容 |
|---|---|
| 目的 | 发现泄漏与随时间恶化 |
| 负载 | 拐点的 70%，持续 2~8 小时（首轮建议 2 小时，问题排除后再拉长） |
| 通过标准 | P95 无持续上升趋势；错误率不随时间增长；堆内存回落正常；无连接泄漏 |
| 观察点 | 堆内存趋势与 Full GC 频率；DB 连接数；文件句柄数；**审批任务累积量**（与 PT-010 相关）；磁盘（.dat 上传是否产生未清理的临时文件） |
| 前置 | 数据池规模需覆盖全程；确认无 token 过期问题（当前无 token 机制，但 perf 环境需确认） |

#### PT-CREATE-012 突增 Spike

| 项 | 内容 |
|---|---|
| 目的 | 验证突发承受力与恢复能力 |
| 负载 | 基线水位运行 3 分钟 → 瞬间拉至 3~5 倍持续 2 分钟 → 回落基线 5 分钟 |
| 通过标准 | 峰值期间错误率 < 5%；**回落后 2 分钟内 P95 恢复到基线水平** |
| 观察点 | 恢复时间是关键指标；是否出现雪崩（回落后仍不恢复）；线程池/连接池是否耗尽后无法回收 |

#### PT-CREATE-013 risk-engine 降级对照

| 项 | 内容 |
|---|---|
| 目的 | 验证 create **不依赖 risk-engine** 这一架构假设 |
| 依据 | 依赖表：create → DAT parsing; DB; audit; WebSocket，**不含 risk-engine** |
| 负载 | create 按目标 TPS 恒定发压 30 分钟；第 10~20 分钟注入 risk-engine 干扰（高延迟 → 超时 → 不可用） |
| 通过标准 | **干扰期间 create 的 P95 劣化 < 10%，错误率不上升** |
| 失败判定 | 劣化 > 30% 或出现 5xx → **API Service 缺少舱壁隔离**（共享线程池/连接池），属 P1 架构缺陷而非调优项 |
| 观察点 | API Service 分下游的连接池使用率；线程池活跃线程是否被 risk 调用占满 |
| 关联 | v2 方案场景 C-2 |

#### PT-CREATE-014 同一 Portfolio 并发竞争

| 项 | 内容 |
|---|---|
| 目的 | 验证是否存在按 Portfolio 的行锁或序列号竞争 |
| 负载 | 20 线程全部使用**同一个** portfolioId，10 分钟；与"20 线程分散到 5 个 portfolio"对比 |
| 通过标准 | 两者 P95 差异 < 20% |
| 失败信号 | 集中打同一 portfolio 时显著变慢 → 存在 portfolio 级锁或计数器竞争，生产中大客户集中交易时会出问题 |

---

## 4. JMeter 实操方案

### 4.1 元件树

```text
Test Plan  [api/p02-trade-create.jmx]
├── User Defined Variables
├── HTTP Request Defaults
├── HTTP Header Manager
├── CSV Data Set Config
│
├── Thread Group  ［${__P(threads,1)} / ${__P(rampUp,1)} / ${__P(duration,60)}］
│   └── Transaction Controller  "TX_Create_Trade"    ［不勾选 Include timer］
│       └── HTTP Request  "create_trade"
│           ├── JSR223 PreProcessor    "build trade payload"   → groovy/build-trade-payload.groovy
│           ├── Response Assertion     "http 200"
│           ├── JSR223 Assertion       "business status"       → groovy/assert-create-response.groovy
│           ├── JSON Extractor         "tradeId"
│           └── Regular Expression Extractor  "taskId"
│
└── Backend Listener / Simple Data Writer
```

**说明**：单接口容量测试**不加 think time**（要测纯服务端能力）。think time 只在 E2E 场景中使用。

### 4.2 逐元件配置

#### User Defined Variables

```text
basePath = /api/v1
userId   = ${__P(userId,maker@sc.com)}
dynRun   = ${__P(dynRun,false)}
```

#### HTTP Request Defaults

```text
Protocol:          ${__P(protocol,http)}
Server Name or IP: ${__P(host,uklvadpta0005a.pi.dev.net)}
Port Number:       ${__P(port,9089)}
Connect Timeout:   10000
Response Timeout:  ${__P(respTimeout,30000)}
Implementation:    HttpClient4
```

> Response Timeout 首轮设 30s，基线出来后按 SLA 收紧。不要设成 120s——过宽会掩盖严重劣化。

#### HTTP Header Manager

```text
accept       : application/json
X-Dyn-Run    : ${dynRun}
X-User-Id    : ${userId}
```

**关键：只发一个 `X-User-Id`。** 原 curl 里 `X-User-ID` 与 `X-User-Id` 是同一个头（HTTP 头名大小写不敏感）发了两次，服务端行为不确定。首次运行需对比响应是否与 curl 完全一致。

#### Content-Type 必须发送，但不能手写

`Content-Type: multipart/form-data` **是必需的**，且**必须携带 boundary 参数**，否则服务端无法切分请求体：

```
Content-Type: multipart/form-data; boundary=--------------------------1a2b3c4d5e6f
```

curl 命令里的 `-H 'Content-Type: multipart/form-data'` 看似没有 boundary，但 curl 检测到 `-F` 表单提交后会**自动追加 boundary**，实际发出的是完整的头。

| 做法 | 结果 |
|---|---|
| ✅ 勾选 "Use multipart/form-data for POST" | JMeter 自动生成完整头（含随机 boundary），与请求体一致 |
| ❌ 在 HTTP Header Manager 里手写 `Content-Type: multipart/form-data` | 手写值**没有 boundary**，会覆盖自动生成的头，服务端解析失败（通常 400/500） |

**结论：这个头是必须的，但只能由 JMeter 生成**——boundary 是随机值，只有 JMeter 自己知道请求体用了哪个。因此 Header Manager 里**不写** Content-Type，靠 HTTP Request 的勾选项生成。

#### CSV Data Set Config

见 2.3 节。

#### HTTP Request "create_trade"

```text
Method:  POST
Path:    ${basePath}/trades/create
☑ Use multipart/form-data for POST
☑ Browser-compatible headers        ← 必须勾选，理由见下
```

**为什么必须勾选 "Browser-compatible headers"**

curl 实际发出的 part 结构是：非文件 part 只有 `Content-Disposition`，**只有带 filename 的 part 才写 `Content-Type`**。

```
------------------------------1a2b3c4d5e6f
Content-Disposition: form-data; name="trade"
                                                   ← 无 Content-Type
{"basic":{"portfolioId":"...","counterpartyFmId":"400954563","counterpartyName":"PRINTINGINT10LTD*HKG","notionalCurrency":""}}
------------------------------1a2b3c4d5e6f
Content-Disposition: form-data; name="datFile"; filename="0_instrument.dat"
Content-Type: application/octet-stream             ← 文件 part 才有

<binary content>
------------------------------1a2b3c4d5e6f--
```

JMeter 的两种模式对比：

| 模式 | 非文件 part（`trade`） | 文件 part（`datFile`） | 与 curl 一致 |
|---|---|---|:---:|
| 默认（strict） | 追加 `Content-Type: text/plain; charset=US-ASCII` 与 `Content-Transfer-Encoding: 8bit` | 写 Content-Type | ❌ |
| **勾选 Browser-compatible** | 只写 `Content-Disposition` | 写 Content-Type | ✅ |

若服务端对 part 的 Content-Type 有严格的消息转换逻辑，strict 模式会返回 400/415。勾选后与 curl 字节级一致，风险最低。

**Parameters 页签**（`trade` 走这里，不是 Files Upload）：

| Name | Value | URL Encode? | Content-Type | Include Equals? |
|---|---|:---:|---|:---:|
| `trade` | `${tradePayload}` | ☐ | *（留空）* | ☑ |

> 留空 Content-Type 是为了与 curl 的 `-F 'trade={...}'` 完全一致（curl 对非文件字段不发 Content-Type）。若服务端返回 400/415，再改为 `application/json` 重试。

**Files Upload 页签**（`datFile` 走这里）：

| File Path | Parameter Name | MIME Type |
|---|---|---|
| `${__P(datDir,./data)}/${datFile}` | `datFile` | `application/octet-stream` |

#### JSR223 PreProcessor — 构建 payload

`groovy/build-trade-payload.groovy`（用 **Script file** 引用，不要内联）：

```groovy
import groovy.json.JsonOutput

// payload 极简：仅 4 个字段，业务数据由 .dat 提供
def trade = [
    basic: [
        portfolioId     : vars.get('portfolioId'),
        counterpartyFmId: vars.get('counterpartyFmId'),
        counterpartyName: vars.get('counterpartyName'),
        notionalCurrency: vars.get('notionalCurrency') ?: ''
    ]
]

vars.put('tradePayload', JsonOutput.toJson(trade))
```

**相比 v2 方案的简化**：`trade` 是表单字段而非文件 part，因此**不需要**写临时文件、不需要每线程文件管理、不需要 tearDown 清理目录。整套文件 I/O 机制删除。

#### Response Assertion — HTTP 层

```text
Apply to:        Main sample only
Field to Test:   Response Code
Pattern Matching: Equals
Pattern:         200
```

#### JSR223 Assertion — 业务层

`groovy/assert-create-response.groovy`：

```groovy
import groovy.json.JsonSlurper

def body = prev.getResponseDataAsString()

def r
try {
    r = new JsonSlurper().parseText(body)
} catch (Exception e) {
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("Response is not valid JSON: ${e.message}")
    return
}

// 三层断言：HTTP 已由 Response Assertion 覆盖，此处校验业务层
if (r.code != 200) {
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("business code=${r.code}, msg=${r.msg}")
    return
}

// 成功状态是 PENDING APPROVAL（不是 CREATED）
def ok = ['PENDING APPROVAL'] as Set
if (!(r.status in ok)) {
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("unexpected status=${r.status}, msg=${r.msg}")
    return
}

def tradeId = r.data?.trade?.id
if (!tradeId || !(tradeId ==~ /^TRD-\d+$/)) {
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("invalid tradeId=${tradeId}")
}
```

#### JSON Extractor — tradeId

```text
Names of created variables: tradeId
JSON Path expressions:      $.data.trade.id
Default Values:             NOT_FOUND
```

#### Regular Expression Extractor — taskId

TaskId 埋在 `msg` 字符串里，只能用正则：

```text
Field to check:      Body
Reference Name:      taskId
Regular Expression:  TaskId:\s*(CHK-[A-Z0-9]+)
Template:            $1$
Match No.:           1
Default Value:       NOT_FOUND
```

> **建议向后端提 improvement**：把 TaskId 放进 `data` 里做成结构化字段。当前靠解析 msg 文案，文案一改脚本就静默失效。

### 4.3 结果打标（替代自建文件写入）

不要在 PostProcessor 里自己写文件——并发写会争抢且拖慢客户端。用 JMeter 的 `sample_variables` 把提取值写进 JTL 列：

```properties
sample_variables=caseId,tradeId,taskId,datFile,productType,datSize
```

好处：
- **清理**：压测后从 JTL 提取 tradeId 列表，交给清理脚本
- **下游测试**：提取 taskId 列表，作为 approve/reject 与 bulk 测试的数据池
- **分档分析**：按 `datSize` / `productType` 分组算 P95（用例 PT-006 / PT-007 直接靠这个出结果）

```bash
# 压测后提取
awk -F',' 'NR>1 {print $N}' results/xxx.jtl | sort -u > data/pools/created-trade-ids.csv
```

### 4.4 负载模型配置

`profiles/` 下分档，jmx 里只写 `${__P(...)}`：

| 用例 | Thread Group 类型 | 关键配置 |
|---|---|---|
| PT-001 | 标准 Thread Group | threads=1, loops=1 |
| PT-002/003 | 标准 Thread Group | threads=2/5, duration=300/900 |
| PT-004 | **Concurrency Thread Group** | 分级递增，或分 5 次运行改 `-Jthreads` |
| PT-005/010/013 | **bzm - Arrivals Thread Group** | 按目标 TPS 开环发压 |
| PT-012 | **Concurrency Thread Group** | 用 Throughput Shaping Timer 做尖峰曲线 |

> 容量类用例（PT-004/005）必须用开环或到达率驱动。固定线程数在系统变慢时自动降压，会给出虚假容量。

### 4.5 执行命令

```bash
# PT-CREATE-001 调试（GUI 或命令行 + View Results Tree）
jmeter -n -t jmx/api/p02-trade-create.jmx \
  -q config/dev.properties -q profiles/debug.properties \
  -l results/pt001.jtl

# PT-CREATE-003 基线
./scripts/run.sh p02-trade-create dev baseline

# 等价原始命令
jmeter -n -t jmx/api/p02-trade-create.jmx \
  -q config/dev.properties -q profiles/baseline.properties \
  -Jsample_variables=caseId,tradeId,taskId,datFile,productType,datSize \
  -l results/2026-07-25/pt003_dev_baseline.jtl \
  -e -o reports/2026-07-25/pt003_dev_baseline

python3 scripts/assert-sla.py results/2026-07-25/pt003_dev_baseline.jtl config/sla.yaml
```

`config/dev.properties`：

```properties
protocol=http
host=uklvadpta0005a.pi.dev.net
port=9089
userId=maker@sc.com
dynRun=false
datDir=./data
respTimeout=30000
```

### 4.6 正式执行前的检查清单

- [ ] View Results Tree 中逐字节对比 JMeter 请求与 curl 的 multipart 结构（part 名称、顺序、有无多余 Content-Type）
- [ ] Debug Sampler 确认 `${tradePayload}` 与 curl 中的 JSON 字符串一致，含 `notionalCurrency` 为空串
- [ ] 确认只发了一个 `X-User-Id`，且响应与 curl 一致
- [ ] 确认发出的请求头中 `Content-Type: multipart/form-data; boundary=...` **带 boundary**，且该值由 JMeter 自动生成（Header Manager 中未手写）
- [ ] 确认 `trade` part **没有** `Content-Type` 与 `Content-Transfer-Encoding`（即 Browser-compatible headers 已勾选）
- [ ] 确认 `datFile` part 带 `Content-Type: application/octet-stream` 与正确的 `filename`
- [ ] 所有 Transaction Controller 取消勾选 "Include duration of timer and pre-post processors"
- [ ] 禁用 View Results Tree / Table / Graph Results（正式运行）
- [ ] 确认 CSV 未耗尽即停（Recycle=True）
- [ ] 确认 tradeId 全部唯一（JTL 去重后行数 = 采样数）
- [ ] 服务端监控已就绪且时间轴与压测对齐

---

## 5. 观察指标清单

### 5.1 客户端（JMeter）

P50 / P90 / P95 / P99（**不报平均值**）、TPS、技术错误率、业务失败率（`code != 200`）、脚本错误数（提取器 NOT_FOUND，**必须为 0**）、Connect Time、Latency

### 5.2 服务端

| 层 | 指标 | 关注点 |
|---|---|---|
| **API Service** | CPU、Heap、GC 次数与耗时、线程池活跃/队列、HTTP 活跃请求 | DAT 解析是 CPU 密集操作，重点看 CPU 与 Full GC |
| **API Service 下游连接池** | 对 risk-engine / UC / notification 的连接池**是否独立** | PT-013 的核心判定指标 |
| **Database** | 连接池使用率、慢 SQL、锁等待、事务时长、IOPS | create 涉及 trade 表 + audit 表 + checker task 表多次写入 |
| **审批任务** | checker task 表行数增长、写入速率 | PT-010 的核心指标 |
| **文件系统** | 临时文件数、文件句柄数、磁盘占用 | .dat 上传是否产生未清理的临时文件 |
| **消息/通知** | notification 生产速率、队列积压 | create 是否触发通知 |

---

## 6. 风险与注意事项

### 6.1 环境影响（重要）

**每次 create 都会产生一个 pending checker task 和一笔 Pending Approval Draft 状态的 trade。** 高并发压测会在共享 dev 环境里堆积大量待审批数据，**直接干扰其他人的功能测试**。

必须做的三件事：

1. **提前通知**：压测窗口与预计产生的数据量
2. **数据隔离**：使用专用 PERF Portfolio，让测试数据可被识别和批量清理
3. **事后清理**：从 JTL 提取 tradeId / taskId，压测结束后清理；**清理不要与压测同时进行**（会污染指标）

如果 dev 环境不允许这种数据量，需要申请独立的性能测试环境。

### 6.2 环境规格差异

dev 环境（HTTP、9089、无鉴权）与 perf/生产环境可能差异较大。所有 dev 上的结论只能作为**趋势参考与脚本验证**，正式基线必须在规格接近生产的环境上采集，并在报告中注明缩放说明。

### 6.3 清理策略

无 `externalReference` 可注入，因此清理依赖两条路径：

- **主路径**：JTL 中提取的 tradeId 精确列表（覆盖率 100%，前提是 JTL 完整保留）
- **兜底**：按专用 PERF Portfolio + `status = 'Pending Approval Draft'` + 时间窗口筛选

两条都要有——JTL 可能因异常中断丢失，兜底能捞回漏网数据。清理前保留必要审计证据。

### 6.4 其他

- 首次运行前先标定压力机自身容量，避免把工具瓶颈当成系统瓶颈
- 每次只改一个变量（负载 / .dat 档位 / 应用版本 三者不可同时变）
- 正式测量前预热，关键用例执行两次确认可重复
- 严禁未经授权对生产发压

---

## 7. 待确认事项汇总

| # | 事项 | 阻塞哪些用例 | 找谁 |
|---|---|---|---|
| 1 | `X-User-ID` / `X-User-Id` 双头的正确用法与权限影响 | 全部（身份不明确则结果不可信） | 开发 |
| 2 | `X-Dyn-Run` 的语义；`true` 是否触发额外下游调用 | PT-008 | 开发 |
| 3 | perf 环境的协议、端口、鉴权方式 | 全部（决定是否需要 token 机制） | 开发/运维 |
| 4 | 支持的产品类型清单与各类型典型 .dat 大小 | PT-006、PT-007 | 业务/开发 |
| 5 | create 的 SLA 目标（P95 / P99 / 错误率） | PT-005 的通过判定 | 业务 |
| 6 | API Service 对下游是否使用独立线程池/连接池 | PT-013 的预期结论 | 开发 |
| 7 | dev 环境可承受的压测数据量与压测窗口 | 全部 | 环境负责人 |
| 8 | 专用 PERF Portfolio / Counterparty 的创建 | 全部 | 业务/开发 |
| 9 | payload 是否接受额外字段（如自定义 reference） | 清理策略可优化 | 开发 |
| 10 | TaskId 能否改为结构化字段返回 | 提取健壮性 | 开发（improvement） |
