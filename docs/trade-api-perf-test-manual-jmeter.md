# 基于 JMeter 的 Trade API 性能测试操作手册

> 适用范围：Trade 创建、Risk 计算、DAT 文件解析、Trade 列表与详情查询，以及 Counterparty、Portfolio 等 RefData API。  
> 目标：既支持单接口性能测试，也支持完整业务链路串联测试，并能根据项目阶段合理选择测试方式。

---

## 1. 项目背景与业务链路

当前 Create Trade 的前端操作链路如下：

```text
进入 Create Trade 页面
    ↓
查询 Counterparty
GET /api/v1/refdata/counterparties
    ↓
查询 Portfolio
GET /api/v1/refdata/portfolios
    ↓
选择 .dat 文件
POST /api/v1/trades/dat-to-json
    ↓
点击 Save，先执行风险计算
POST /api/v1/trades/calculate-risk-for-new
    ↓
风险计算通过
POST /api/v1/trades/create
    ↓
刷新 Trade 列表
GET /api/v1/trades
    ↓
从列表中定位刚创建的 tradeId
    ↓
查看 Trade 详情
GET /api/v1/trades/{tradeId}
    ↓
可选：查看 Risk Metrics
GET /api/v1/trades/{tradeId}/risk-metrics
```

其中：

- `calculate-risk-for-new` 与 `create` 使用同一个 Trade JSON payload。
- 两个接口都可能采用 `multipart/form-data`。
- multipart 中包含：
  - `trade`：JSON 文件 Part，`Content-Type: application/json`
  - `datFile`：DAT 文件 Part，`Content-Type: application/octet-stream`
- 在并发测试中，不能通过 Trade 列表第一条或最后一条数据判断刚创建的 Trade。
- 必须为每个虚拟用户生成唯一业务标识，并根据该标识定位 `tradeId`。

---

# 2. 性能测试总体策略

项目中不应在"单接口压测"和"业务场景压测"之间二选一，而应采用分层策略：

```text
第一层：单接口基线测试
第二层：关键依赖组合测试
第三层：完整业务场景测试
第四层：容量、稳定性和突增测试
```

推荐顺序：

```text
单接口验证
    ↓
关键接口容量测试
    ↓
业务链路小并发验证
    ↓
完整业务场景基准测试
    ↓
稳定性测试
    ↓
容量与突增测试
```

---

# 3. 单接口压测与串联压测如何选择

## 3.1 适合做单接口压测的情况

单接口压测主要回答：

- 这个接口自身能够支撑多少吞吐量？
- 性能瓶颈是否发生在该服务内部？
- Risk Service、数据库或缓存的最大处理能力是多少？
- 同一个版本发布前后，接口性能是否退化？
- 某个接口的 P95、P99 是否满足 SLA？
- 接口的性能问题是否可以稳定复现？

适合优先单独压测的接口：

| API | 是否建议单压 | 原因 |
|---|---:|---|
| `POST /trades/calculate-risk-for-new` | 强烈建议 | 计算密集、可能调用下游 Risk Service，是核心瓶颈候选 |
| `OreoRiskService.calculateRiskForNew` | 强烈建议 | 可直接验证 Risk Service 容量，排除 Web/API 层影响 |
| `POST /trades/create` | 强烈建议 | 涉及数据库写入、事务、审计、消息或工作流 |
| `POST /trades/dat-to-json` | 建议 | 文件解析和产品解析可能消耗 CPU、内存 |
| `GET /trades` | 强烈建议 | 数据量增长后分页、排序、过滤容易退化 |
| `GET /trades/{id}` | 建议 | 高频详情查询，可用于基线和回归 |
| `GET /trades/{tradeId}/risk-metrics` | 建议 | 可能涉及计算结果查询和复杂数据结构 |
| `GET /refdata/counterparties` | 建议 | 高频查询，但通常不是核心容量瓶颈 |
| `GET /refdata/portfolios` | 建议 | 高频查询，适合验证缓存与分页 |
| `POST /checker/tasks/bulk-approve` | 强烈建议 | 批量写入，存在数据库锁、事务和消息压力 |
| `POST /checker/tasks/bulk-reject` | 强烈建议 | 批量操作，需明确不同批次大小下的性能 |
| `POST /trade-aging/process-all` | 强烈建议 | 批处理接口，不应混入普通在线用户场景 |
| `POST /trade-aging/process-all-from-file` | 强烈建议 | 文件上传加批处理，应采用独立测试模型 |

### 单接口测试典型使用场景

#### 场景 A：Risk 接口优化验证

例如开发团队优化了 Risk Service：

```text
只运行 calculate-risk-for-new
固定 payload 类型
分别测试 1、5、10、20、50 并发
比较优化前后的 P95、TPS、CPU
```

此时不应加入 Counterparty、Portfolio 和 Trade 列表请求，否则无法准确判断 Risk 优化是否生效。

#### 场景 B：Trade 列表数据量退化验证

```text
准备 1 万、10 万、50 万条 Trade 数据
单独执行 GET /trades
测试分页、排序和搜索
```

此时重点是数据库查询性能，不需要创建 Trade 业务链路。

#### 场景 C：批量审批容量验证

```text
分别准备 10、50、100、500 条 taskId
单独测试 bulk-approve 和 bulk-reject
```

不能把批量审批接口简单混入普通 Create Trade 场景，因为两类用户行为和负载特征不同。

---

## 3.2 适合做业务链路串联压测的情况

业务场景压测主要回答：

- 一个真实用户完成 Create Trade 的整体体验如何？
- 多个接口串联后，下游服务是否相互影响？
- Risk 成功后立即 Create 是否产生资源竞争？
- 创建成功后列表是否及时可见？
- 系统是否存在最终一致性延迟？
- 用户并发操作时是否会出现线程池、连接池或消息队列积压？
- 单接口都达标，但完整业务仍然慢的原因是什么？

以下业务必须做串联测试：

### Create Trade 完整流程

```text
Counterparty
→ Portfolio
→ DAT To JSON
→ Calculate Risk
→ Create Trade
→ All Trades
→ Trade Details
```

### Maker-Checker 流程

```text
Maker Create Trade
→ Checker Pending Tasks
→ Approve / Reject
→ Trade 状态刷新
```

### Trade 更新流程

```text
GET Trade Details
→ Calculate Risk
→ Update Trade
→ Refresh Trade
→ Risk Metrics
```

### Partial Novation 流程

```text
GET Trade
→ Calculate Partial Novation Risk
→ Trigger Event
→ 查询最新状态
```

---

## 3.3 项目中的推荐选择原则

可以使用下面的判断规则：

| 问题 | 推荐方式 |
|---|---|
| 想知道单个 API 最大 TPS | 单接口测试 |
| 想定位具体性能瓶颈 | 单接口测试 |
| 想做版本间性能回归 | 单接口测试为主 |
| 想评估真实用户体验 | 业务场景测试 |
| 想验证系统端到端容量 | 业务场景测试 |
| 想验证数据库查询性能 | 单接口测试 |
| 想验证 Risk Service 容量 | Risk 单接口测试 |
| 想验证创建 Trade 后页面是否及时可见 | 业务场景测试 |
| 想测试批处理、文件批量导入 | 独立批处理场景 |
| 想验证生产真实流量模型 | 多业务混合场景 |

### 实际项目推荐占比

在第一轮性能测试中，可以按以下方式组织：

```text
约 60% 精力：关键单接口测试
约 30% 精力：核心业务链路测试
约 10% 精力：稳定性、突增和异常恢复测试
```

这不是固定比例，关键原则是：

- 先用单接口测试建立性能基线。
- 再用串联测试验证真实业务。
- 如果串联测试失败，用单接口测试进一步定位。
- 如果单接口全部通过但串联失败，重点检查共享资源和上下游依赖。

---

# 4. 建议的 API 分组

## 4.1 S 级：核心业务和高风险 API

建议纳入第一轮性能测试：

```text
GET  /api/v1/trades
GET  /api/v1/trades/{id}
POST /api/v1/trades/create
POST /api/v1/trades/trigger-event
POST /api/v1/trades/{id}/calculate-risk
POST /api/v1/trades/{id}/calculate-partial-novation-risk
POST /api/v1/trades/calculate-risk-for-new
GET  /api/v1/trades/{tradeId}/risk-metrics
GET  /api/v1/notifications/unread-count
POST /api/v1/checker/tasks/bulk-approve
POST /api/v1/checker/tasks/bulk-reject
OreoRiskService.calculateRisk
OreoRiskService.calculateRiskForNew
```

S 级 API 的选择标准：

- 直接影响核心交易流程。
- 高并发或高频。
- 计算密集。
- 写数据库或存在事务。
- 会调用关键下游服务。
- 失败后直接影响交易创建或审批。

---

## 4.2 A 级：重要辅助 API

建议纳入核心业务场景，但不一定每个都做大容量单压：

```text
GET  /api/v1/refdata/counterparties
GET  /api/v1/refdata/counterparties/search
GET  /api/v1/refdata/portfolios
GET  /api/v1/refdata/portfolios/search
POST /api/v1/trades/dat-to-json
GET  /api/v1/checker/tasks/pending
POST /api/v1/checker/tasks/{taskId}/approve
POST /api/v1/checker/tasks/{taskId}/reject
GET  /api/v1/notifications/inbox
GET  /api/v1/products
POST /api/v1/products/schema/parse
GET  /api/v1/product-field-configs/{productId}/live-fields
```

A 级 API 主要用于：

- 页面初始化。
- 下拉框和查询。
- 文件解析。
- Maker-Checker 辅助操作。
- 产品和字段配置加载。

---

## 4.3 B 级：低频、后台或批处理 API

建议独立测试，不建议直接混入在线业务场景：

```text
POST /api/v1/trades/sync-cashflows-batch
POST /api/v1/trade-aging/process-all
POST /api/v1/trade-aging/process-all-from-file
POST /api/v1/trades/generate-schedule
GET  /api/v1/trades/{id}/target-gain
```

批处理接口应采用：

- 固定数据量测试。
- 不同批次大小测试。
- 长时间执行测试。
- 对数据库、内存、队列和线程池单独监控。

---

# 5. JMeter 工程目录建议

```text
trade-performance/
├── jmx/
│   ├── 01-api-baseline.jmx
│   ├── 02-create-trade-e2e.jmx
│   ├── 03-maker-checker.jmx
│   ├── 04-batch-processing.jmx
│   └── 99-cleanup.jmx
├── data/
│   ├── trade-test-data.csv
│   ├── counterparty.csv
│   ├── portfolio.csv
│   ├── dat/
│   │   ├── instrument-001.dat
│   │   └── instrument-002.dat
│   └── templates/
│       └── trade-template.json
├── scripts/
│   ├── build-trade-payload.groovy
│   ├── resolve-created-trade.groovy
│   └── cleanup-trade.groovy
├── config/
│   ├── dev.properties
│   ├── sit.properties
│   └── perf.properties
├── results/
├── reports/
└── README.md
```

建议不要把所有接口都放进一个巨大的 `.jmx` 文件。

---

# 6. JMeter Test Plan 基础结构

```text
Test Plan
│
├── User Defined Variables
├── HTTP Request Defaults
├── HTTP Header Manager
├── HTTP Cookie Manager
├── CSV Data Set Config
│
├── setUp Thread Group
│   └── Login / Token
│
├── Thread Group - Create Trade E2E
│   └── Transaction Controller - TX_Create_Trade_E2E
│       ├── Transaction Controller - 01_Load_RefData
│       │   ├── GET Counterparties
│       │   └── GET Portfolios
│       ├── Timer
│       ├── Transaction Controller - 02_Parse_DAT
│       │   └── POST DAT To JSON
│       ├── JSR223 Sampler - Build Shared Trade Payload
│       ├── Transaction Controller - 03_Calculate_Risk
│       │   └── POST Calculate Risk For New
│       ├── Transaction Controller - 04_Create_Trade
│       │   └── POST Create Trade
│       ├── Transaction Controller - 05_Refresh_Trade_List
│       │   └── GET All Trades
│       └── Transaction Controller - 06_View_Details
│           ├── GET Trade By ID
│           └── GET Risk Metrics
│
└── tearDown Thread Group
    └── 可选清理逻辑
```

---

# 7. 公共配置

## 7.1 User Defined Variables

```text
protocol=https
host=test-api.example.com
basePath=/api/v1
```

推荐通过命令行属性覆盖：

```text
${__P(protocol,https)}
${__P(host,test-api.example.com)}
${__P(datDir,./data/dat)}
${__P(templateDir,./data/templates)}
```

---

## 7.2 HTTP Request Defaults

```text
Protocol: ${__P(protocol,https)}
Server Name: ${__P(host,test-api.example.com)}
Connect Timeout: 10000
Response Timeout: 120000
Implementation: HttpClient4
```

Risk 接口响应时间可能较长，应根据 SLA 设置合理超时，不建议无限等待。

---

## 7.3 HTTP Header Manager

```text
Accept: application/json
Authorization: Bearer ${accessToken}
```

对于 multipart 请求，不要手工设置：

```text
Content-Type: multipart/form-data
```

JMeter 会自动生成 boundary。

---

# 8. 测试数据准备

## 8.1 CSV 文件

`trade-test-data.csv`：

```csv
counterpartyName,portfolioName,datFile,notionalCurrency,productType
10 AM NY,PERF_PORTFOLIO_01,./data/dat/instrument-001.dat,USD,IRS
COUNTERPARTY_02,PERF_PORTFOLIO_02,./data/dat/instrument-002.dat,EUR,IRS
```

CSV Data Set Config：

```text
Filename: ./data/trade-test-data.csv
Variable Names:
counterpartyName,portfolioName,datFile,notionalCurrency,productType

Delimiter: ,
Recycle on EOF: False
Stop thread on EOF: True
Sharing mode: All threads
```

正式测试中，建议保证：

- 每行数据可独立创建 Trade。
- Counterparty 和 Portfolio 是性能环境专用数据。
- DAT 文件内容合法。
- 不同用户尽量使用不同业务数据。
- 不要让所有线程竞争同一个唯一业务编号。

---

# 9. RefData API 配置

## 9.1 Counterparty

```text
Method: GET
Path: /api/v1/refdata/counterparties
```

假设响应：

```json
[
  {
    "id": "abc123",
    "fmid": "300036958",
    "name": "10 AM NY"
  }
]
```

JMESPath Extractor：

```text
Variable: counterpartyFmid
Expression:
[?name == '${counterpartyName}'].fmid | [0]

Default Value:
NOT_FOUND
```

JSR223 Assertion：

```groovy
if (vars.get('counterpartyFmid') == 'NOT_FOUND') {
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage(
        "Counterparty not found: ${vars.get('counterpartyName')}"
    )
}
```

---

## 9.2 Portfolio

```text
Method: GET
Path: /api/v1/refdata/portfolios
```

JMESPath Extractor：

```text
Variable: portfolioId
Expression:
[?name == '${portfolioName}'].id | [0]

Default Value:
NOT_FOUND
```

---

# 10. DAT To JSON 配置

```text
Name: 03_POST_DAT_To_JSON
Method: POST
Path: /api/v1/trades/dat-to-json
Use multipart/form-data for POST: 勾选
```

Files Upload：

| File Path | Parameter Name | MIME Type |
|---|---|---|
| `${datFile}` | `datFile` | `application/octet-stream` |

增加断言：

```text
Response Code = 200
```

如后续 Trade payload 需要使用该响应，添加 JSR223 PostProcessor：

```groovy
vars.put('datToJsonResponse', prev.getResponseDataAsString())
```

---

# 11. 生成 Risk 与 Create 共用 Payload

新建：

```text
JSR223 Sampler
Name: Build Shared Trade Payload
Language: groovy
```

示例脚本：

```groovy
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

String templateDir = props.get('templateDir') ?: './data/templates'
Path templatePath = Paths.get(templateDir, 'trade-template.json')

if (!Files.exists(templatePath)) {
    throw new IllegalStateException(
        "Trade template does not exist: ${templatePath.toAbsolutePath()}"
    )
}

def trade = new JsonSlurper().parse(templatePath.toFile())

String timestamp = new Date().format('yyyyMMddHHmmssSSS')
String threadNo = String.valueOf(ctx.getThreadNum())
String iterationNo = String.valueOf(vars.getIteration())

String tradeReference =
    "PERF-${threadNo}-${timestamp}-${iterationNo}"

trade.basic.portfolioId = vars.get('portfolioId')
trade.basic.counterpartyFmid = vars.get('counterpartyFmid')
trade.basic.counterpartyName = vars.get('counterpartyName')
trade.basic.notionalCurrency = vars.get('notionalCurrency')
trade.basic.externalReference = tradeReference

// 如果 dat-to-json 返回内容需要合并到 payload，则按实际结构处理。
// def parsedDat = new JsonSlurper().parseText(
//     vars.get('datToJsonResponse')
// )
// trade.instrument = parsedDat.instrument

String tradePayload = JsonOutput.toJson(trade)

Path threadDirectory = Paths.get(
    System.getProperty('java.io.tmpdir'),
    'jmeter-trade-payloads',
    "thread-${ctx.getThreadNum()}"
)

Files.createDirectories(threadDirectory)

Path blobFile = threadDirectory.resolve(
    "blob-${iterationNo}.json"
)

Files.write(
    blobFile,
    tradePayload.getBytes(StandardCharsets.UTF_8)
)

vars.put('tradeReference', tradeReference)
vars.put('tradePayload', tradePayload)
vars.put(
    'tradeJsonFile',
    blobFile.toAbsolutePath().toString()
)
```

关键要求：

- 该脚本只在 Risk 之前执行一次。
- Risk 和 Create 都使用 `${tradeJsonFile}`。
- 每个线程必须使用独立文件。
- 不要让多个线程写同一个 `/tmp/blob`。

---

# 12. Calculate Risk For New 配置

```text
Name: 04_POST_Calculate_Risk_For_New
Method: POST
Path: /api/v1/trades/calculate-risk-for-new
Use multipart/form-data for POST: 勾选
```

Files Upload：

| File Path | Parameter Name | MIME Type |
|---|---|---|
| `${tradeJsonFile}` | `trade` | `application/json` |
| `${datFile}` | `datFile` | `application/octet-stream` |

断言至少包括：

- HTTP 状态码。
- 风险计算业务状态。
- 错误消息为空。
- 必要的 Risk 结果字段存在。

示例 JSR223 Assertion：

```groovy
import groovy.json.JsonSlurper

def response =
    new JsonSlurper().parseText(
        prev.getResponseDataAsString()
    )

String status = String.valueOf(
    response.riskStatus ?: response.status
)

if (!(status in ['PASSED', 'SUCCESS', 'COMPLETED'])) {
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage(
        "Risk calculation failed. status=${status}"
    )
}
```

具体字段以真实响应为准。

---

# 13. Create Trade 配置

```text
Name: 05_POST_Create_Trade
Method: POST
Path: /api/v1/trades/create
Use multipart/form-data for POST: 勾选
```

Files Upload 与 Risk 完全一致：

| File Path | Parameter Name | MIME Type |
|---|---|---|
| `${tradeJsonFile}` | `trade` | `application/json` |
| `${datFile}` | `datFile` | `application/octet-stream` |

若 Create 响应直接返回 Trade ID：

```json
{
  "id": "trade-uuid",
  "status": "CREATED"
}
```

JSON Extractor：

```text
Variable: createdTradeId
JSONPath: $.id
Default Value: NOT_FOUND
```

---

# 14. 从 Trade 列表定位刚创建的 Trade

```text
Method: GET
Path: /api/v1/trades
```

优先使用后端支持的搜索条件：

```text
/api/v1/trades?search=${tradeReference}
```

不要直接取：

```text
content[0].id
```

在并发环境下第一条数据可能是其他线程创建的。

假设响应：

```json
{
  "content": [
    {
      "id": "trade-uuid",
      "externalReference": "PERF-1-20260725100000123-1"
    }
  ]
}
```

JMESPath Extractor：

```text
Variable: tradeIdFromList
Expression:
content[?externalReference == '${tradeReference}'].id | [0]

Default Value:
NOT_FOUND
```

最终 Trade ID 处理：

```groovy
String createdTradeId = vars.get('createdTradeId')
String tradeIdFromList = vars.get('tradeIdFromList')

if (createdTradeId &&
    createdTradeId != 'NOT_FOUND') {

    vars.put('tradeId', createdTradeId)

} else if (tradeIdFromList &&
           tradeIdFromList != 'NOT_FOUND') {

    vars.put('tradeId', tradeIdFromList)

} else {
    throw new IllegalStateException(
        "Cannot resolve tradeId for reference=" +
        vars.get('tradeReference')
    )
}
```

---

# 15. 最终一致性处理

如果 Create 成功后 Trade 不会立即出现在列表中，应使用轮询。

推荐结构：

```text
Counter: pollCounter
While Controller
    GET /trades?search=${tradeReference}
    JSON Extractor
    Constant Timer: 1000 ms
```

轮询原则：

```text
间隔：1 秒
最大次数：5～10 次
最大等待：5～10 秒
```

不要无限循环，也不建议固定等待 10 秒后只查一次。

轮询耗时应单独统计，不要与 Create 接口服务端响应时间混淆。

---

# 16. View Details 配置

```text
Name: 07_GET_Trade_Details
Method: GET
Path: /api/v1/trades/${tradeId}
```

Risk Metrics：

```text
Name: 08_GET_Risk_Metrics
Method: GET
Path: /api/v1/trades/${tradeId}/risk-metrics
```

详情接口应断言：

- HTTP 200。
- 返回 `id` 等于 `${tradeId}`。
- 关键字段存在。
- Trade 状态符合预期。

---

# 17. Think Time 与 Pacing

真实用户操作中建议模拟：

| 用户动作 | Think Time |
|---|---:|
| 页面加载后选择 Counterparty、Portfolio | 1～3 秒 |
| 选择 DAT 文件 | 1～2 秒 |
| Risk 成功后点击确认 | 0.5～1.5 秒 |
| 列表刷新后点击详情 | 1～3 秒 |

使用：

```text
Uniform Random Timer
Constant Delay Offset: 1000
Random Delay Maximum: 2000
```

即等待 1～3 秒。

注意：

- Think Time 模拟用户思考。
- Pacing 控制一个用户两次完整业务迭代之间的间隔。
- 不要仅通过增加线程数模拟业务量。
- 需要根据生产用户行为估算每小时业务笔数。

---

# 18. 推荐负载模型

## 18.1 脚本调试

```text
Threads: 1
Ramp-up: 1 秒
Loop Count: 1
```

开启：

```text
View Results Tree
Debug Sampler
```

仅用于调试。

---

## 18.2 Smoke Test

```text
Threads: 2
Ramp-up: 10 秒
Duration: 2～5 分钟
```

目标：

- 确认脚本可运行。
- 动态参数关联正确。
- 数据不会互相覆盖。
- 监控链路正常。

---

## 18.3 Baseline Test

```text
Threads: 5～10
Ramp-up: 1～2 分钟
Duration: 10～15 分钟
```

目标：

- 建立低负载基线。
- 记录接口 P50、P90、P95、P99。
- 记录 CPU、内存、数据库和线程池基线。

---

## 18.4 Load Test

根据生产业务量计算并发用户。

不要直接假设：

```text
100 用户 = 100 TPS
```

可以使用近似关系：

```text
并发用户数 ≈ 每秒事务数 × 单次业务平均停留时间
```

例如：

```text
目标：每秒 2 个 Create Trade
一个用户完成完整流程平均需要 20 秒

估算并发用户：
2 × 20 = 40 用户
```

实际需通过小规模试跑校准。

---

## 18.5 Stress Test

```text
10 用户
→ 20 用户
→ 40 用户
→ 60 用户
→ 80 用户
```

每一级保持 10～20 分钟。

目标：

- 找到 TPS 不再增长的位置。
- 找到响应时间突然升高的位置。
- 找到错误率开始增加的位置。
- 定位最先饱和的资源。

---

## 18.6 Stability Test

```text
负载：预计生产峰值的 70%～100%
持续时间：2～8 小时
```

重点观察：

- 内存是否持续增长。
- 数据库连接是否泄漏。
- Risk Service 是否积压。
- 消息队列是否积压。
- GC 是否恶化。
- 错误率是否随时间增长。

---

# 19. 单接口测试方案建议

## 19.1 Calculate Risk For New

### 测试维度

```text
不同产品类型
不同 DAT 文件大小
不同 Trade 复杂度
不同并发
相同数据重复计算
不同数据随机计算
```

### 建议负载

```text
1、5、10、20、40 并发
每级持续 10～15 分钟
```

### 重点指标

```text
P95 / P99
TPS
错误率
Risk Service CPU
Risk Service 线程池
下游计算节点
请求队列长度
超时数量
```

---

## 19.2 Create Trade

### 重点验证

```text
数据库写入吞吐
事务耗时
唯一键冲突
审计表写入
消息发送
工作流创建
连接池占用
锁等待
```

测试数据必须唯一。

---

## 19.3 GET All Trades

至少覆盖：

```text
第一页查询
深分页
按创建时间排序
按状态过滤
按 Counterparty 搜索
按 Portfolio 搜索
按唯一业务编号搜索
```

不同数据量应分别测试：

```text
1 万条
10 万条
50 万条
100 万条
```

---

## 19.4 DAT To JSON

至少覆盖：

```text
小文件
中等文件
大文件
不同产品结构
错误 DAT 文件
不完整 DAT 文件
```

重点观察：

```text
CPU
内存
Full GC
临时文件
文件句柄
解析失败率
```

---

## 19.5 Bulk Approve / Reject

分别测试批次大小：

```text
10
50
100
500
1000
```

不要只测试并发数，还要测试单请求包含的任务数量。

---

# 20. 业务场景测试方案建议

## 20.1 场景一：Create Trade E2E

推荐权重：

```text
生产系统主要用于交易创建时：40%～60%
```

链路：

```text
RefData
→ DAT To JSON
→ Risk
→ Create
→ Trades
→ Details
```

---

## 20.2 场景二：Trade 查询

推荐权重：

```text
20%～40%
```

链路：

```text
GET Trades
→ GET Trade Details
→ GET Risk Metrics
```

查询通常比创建更频繁，不能只测试 Create。

---

## 20.3 场景三：Maker-Checker

推荐权重：

```text
10%～20%
```

链路：

```text
GET Pending Tasks
→ Approve 或 Reject
→ Refresh Task
→ Refresh Trade
```

Approve 和 Reject 的比例应根据生产数据确定。

---

## 20.4 场景四：Trade Update / Event

推荐权重：

```text
5%～15%
```

链路：

```text
GET Trade
→ Calculate Risk
→ Update / Trigger Event
→ GET Trade
```

---

## 20.5 混合负载示例

如果暂时没有生产流量数据，可以用第一版假设：

| 场景 | 权重 |
|---|---:|
| Trade 查询 | 40% |
| Create Trade | 30% |
| Maker-Checker | 15% |
| Trade Update / Trigger Event | 10% |
| Notification / RefData | 5% |

此权重仅用于初始模型，最终应根据：

- 生产访问日志。
- APM。
- API Gateway。
- 前端埋点。
- 业务日交易量。
- 峰值小时交易量。

进行修正。

---

# 21. 关键指标与 SLA

建议至少统计：

| 指标 | 建议 |
|---|---|
| Average | 仅作为参考 |
| Median / P50 | 典型用户体验 |
| P90 | 大部分用户体验 |
| P95 | 主要 SLA 指标 |
| P99 | 尾延迟 |
| Throughput | 吞吐量 |
| Error Rate | 业务和技术错误率 |
| Active Threads | 实际并发 |
| Connect Time | 连接耗时 |
| Latency | 首字节耗时 |
| Response Time | 完整响应耗时 |

示例 SLA 模板：

| API / 场景 | P95 | P99 | 错误率 |
|---|---:|---:|---:|
| RefData 查询 | 待业务确认 | 待业务确认 | < 0.1% |
| DAT To JSON | 待业务确认 | 待业务确认 | < 0.5% |
| Calculate Risk | 待业务确认 | 待业务确认 | < 1% |
| Create Trade | 待业务确认 | 待业务确认 | < 0.5% |
| Trade 查询 | 待业务确认 | 待业务确认 | < 0.1% |
| Create Trade E2E | 待业务确认 | 待业务确认 | < 1% |

不要在没有业务依据时随意承诺固定响应时间。

---

# 22. 服务端监控

JMeter 只能说明客户端观察到的性能，必须结合服务端监控。

建议监控：

## API Service

```text
CPU
Memory
Heap
GC
Thread Pool
HTTP Active Requests
HTTP Queue
Error Rate
Response Time
```

## Risk Service

```text
调用量
计算耗时
线程池
任务队列
超时
失败率
CPU
内存
```

## Database

```text
连接池使用率
慢 SQL
锁等待
事务时间
CPU
IOPS
Buffer Cache
Active Sessions
```

## Message Queue

```text
生产速率
消费速率
积压数量
失败重试
Dead Letter Queue
```

## Cache

```text
命中率
连接数
响应时间
Eviction
内存
```

---

# 23. 结果分析方法

## 情况一：Risk 单接口慢，E2E 也慢

结论方向：

```text
Risk Service 是主要瓶颈
```

继续检查：

- Risk Service CPU。
- 线程池。
- 下游计算节点。
- 队列。
- 请求复杂度。

---

## 情况二：所有单接口都快，但 E2E 慢

重点检查：

```text
接口之间等待
最终一致性轮询
连接池共享
线程池共享
数据库事务竞争
消息队列积压
前端串行调用
```

---

## 情况三：Create 单接口快，但混合场景下变慢

可能原因：

```text
GET Trades 与 Create 竞争数据库资源
Risk 和 Create 共用线程池
Checker 操作产生锁竞争
数据库连接池不足
```

---

## 情况四：低并发正常，高并发突然恶化

重点检查：

```text
线程池上限
连接池上限
队列上限
下游限流
数据库锁
GC
CPU 饱和
```

---

# 24. 正式执行命令

```bash
jmeter \
  -n \
  -t jmx/02-create-trade-e2e.jmx \
  -Jprotocol=https \
  -Jhost=test-api.example.com \
  -JdatDir=./data/dat \
  -JtemplateDir=./data/templates \
  -Jthreads=20 \
  -JrampUp=120 \
  -Jduration=1800 \
  -l results/create-trade.jtl \
  -e \
  -o reports/create-trade
```

Thread Group 中使用：

```text
Number of Threads:
${__P(threads,5)}

Ramp-up:
${__P(rampUp,30)}

Duration:
${__P(duration,300)}
```

---

# 25. 正式压测注意事项

正式运行前关闭或禁用：

```text
View Results Tree
View Results in Table
Graph Results
Response Time Graph
```

可以保留：

```text
Simple Data Writer
Backend Listener
Summary Report
```

不要使用 GUI 执行正式负载测试。

---

# 26. 数据清理策略

建议所有性能测试 Trade 都带统一标识：

```text
PERF-线程号-时间戳-循环号
```

测试结束后单独运行：

```text
99-cleanup.jmx
```

清理原则：

- 正式测试期间不要边创建边删除。
- 清理操作不要混入正式指标。
- 使用独立测试 Portfolio。
- 使用独立测试 Counterparty。
- 清理前保留必要审计证据。

---

# 27. 第一轮测试的推荐落地范围

从项目实际出发，第一轮建议不要一次覆盖所有 API。

## 第一阶段：必须完成

### 单接口

```text
POST /trades/calculate-risk-for-new
POST /trades/create
POST /trades/dat-to-json
GET  /trades
GET  /trades/{id}
GET  /trades/{tradeId}/risk-metrics
```

### 完整业务场景

```text
Create Trade E2E
```

### 监控

```text
API Service
Risk Service
Database
```

---

## 第二阶段：补充业务

```text
Maker-Checker
Trade Update
Trigger Event
Partial Novation
Notification
RefData Search
```

---

## 第三阶段：批处理和稳定性

```text
Bulk Approve
Bulk Reject
Trade Aging
Cashflow Batch
File Batch
2～8 小时 Stability Test
```

---

# 28. 最终建议

针对当前项目，推荐采用以下结论：

1. `calculate-risk-for-new`、`create`、`dat-to-json` 和 `GET /trades` 必须做单接口测试。
2. Create Trade 完整链路必须做业务串联测试。
3. 单接口测试用于建立基线、验证容量和定位瓶颈。
4. 串联测试用于验证真实用户体验、上下游依赖和共享资源竞争。
5. 批处理 API 应独立建场景，不与在线 Create Trade 场景混合。
6. RefData API 应包含在 E2E 场景中，但通常不需要投入与 Risk 相同的容量测试强度。
7. 第一轮先覆盖少量核心 API，避免一开始把所有接口放进一个复杂脚本。
8. 先完成单用户数据关联，再增加并发。
9. Risk 与 Create 必须复用同一份 Trade payload 文件。
10. 使用唯一业务标识定位刚创建的 Trade，不能依赖列表顺序。
