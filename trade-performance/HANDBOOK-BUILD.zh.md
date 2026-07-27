# OREO 性能测试 · 从零搭建（JMeter GUI 实操）

本文回答"**怎么建**"。怎么跑在 [`HANDBOOK.zh.md`](HANDBOOK.zh.md)，为什么这么分层在 [`README.md`](README.md)。

全程以 **JMeter 5.6.3** 为准。第一件事，把界面切成英文：

> **Options → Choose Language → English**

不是崇洋。JMeter 的中文翻译在多个元件上与属性名对不上（`Generate parent sample`
译成"生成父样本"，但出错时日志里打的是英文属性名），网上所有资料也都是英文字段名。
切成英文能省掉大量"这个选项到底对应哪个属性"的猜测。

---

## 0. 先接受一条工作方式

> ### ⚠ **GUI 保存会删掉 XML 里所有 `<!-- -->` 注释**

JMeter 不是文本编辑器。它把 jmx 读进内存变成对象树，保存时**从对象树重新序列化整个文件**。
文件顶部那几十行设计说明、元件之间的 `<!-- 为什么这么写 -->`，一次保存全没。

我们每个 fragment 头部都有"这个 API 是什么、契约是什么、为什么这么设计"的注释块——
那是这套框架能被第二个人接手的全部原因。**它们经不起一次 GUI 保存。**

所以工作方式是三段式，不能省：

```
GUI 建结构  →  文本编辑器定稿（加注释 + 改函数字段）  →  命令行跑
   ↑                                                        │
   └──── 之后再要改结构，改完记得把注释粘回去 ─────────────┘
```

**保住注释的两个办法，一起用：**

| 办法 | 做法 | 会不会被 GUI 保存干掉 |
|---|---|---|
| ① 元件 Comments 字段 | 每个元件都有 `Comments` 输入框，存成 `TestElement.comments` | **不会** —— 它是对象树的一部分 |
| ② 文件头 `<!-- -->` 块 | 定稿时用文本编辑器加在 `<?xml?>` 之后 | **会** —— 只能定稿后不再从 GUI 保存 |

关键信息（契约、坑、为什么）**优先写进 ① Comments**，长篇设计说明才放 ②。
本项目现有文件是 ② 为主，因为它们已经定稿了。

> ### ⚠ 第二条：一个字段从 GUI 保存会被改坏

全项目只有一处——主 Thread Group 的 **Specify Thread lifetime** 复选框：

```xml
<stringProp name="ThreadGroup.scheduler">${__P(scheduler,true)}</stringProp>
```

这是"把函数塞进复选框"，让 profile 能控制它。但 GUI 里复选框只有勾/不勾两态，
**保存时会写死成 `<boolProp>true</boolProp>` 或 `false`**，函数就没了。

文本框字段（Number of Threads、Ramp-up、Duration、Loop Count）不受影响——
它们本来就是字符串，`${__P(threads,1)}` 能原样存回去。只有复选框有这个问题。

定稿检查：

```bash
grep -c 'stringProp name="ThreadGroup.scheduler"' jmx/api/p02-trade-create.jmx   # 应为 1
```

---

## 1. 建目录骨架

```bash
mkdir -p oreo-perf && cd oreo-perf

mkdir -p \
  jmx/fragments/steps/refdata \
  jmx/fragments/steps/workers/trade-management \
  jmx/fragments/steps/workers/checker-flow \
  jmx/fragments/steps/workers/product-management \
  jmx/fragments/steps/uc \
  jmx/fragments/steps/notifications \
  jmx/fragments/steps/ops \
  jmx/fragments/steps/_composites \
  jmx/fragments/setup \
  jmx/journeys jmx/scenarios jmx/api jmx/suites jmx/ops \
  groovy config profiles scripts \
  data/refdata data/create-trade data/lifecycle-events data/shared \
  data/dat/{small,medium,large,invalid} \
  results reports
```

### 这棵树的形状不是随便定的

**`steps/` 按 svc/module 分，`_composites/` 不分。** 两套分类法，不能合并成一棵树：

- **原子 fragment 按服务架构组织** —— 镜像代码归属，`steps/workers/checker-flow/` 对应
  workers 服务的 checker-flow 模块，`qa/CODEOWNERS` 据此把目录映射到团队
- **组合 fragment 按业务动作组织** —— 一个业务动作可能横跨多个服务
  （`view-trade-details` 同时打 workers 和 risk-engine）

强行合并的结果是有人找不到该放哪，然后开始复制 fragment。

**五个可运行目录的区别：**

| 目录 | 装什么 | 有 Thread Group |
|---|---|---|
| `jmx/fragments/` | 原子 + 组合，**不可运行** | ❌ |
| `jmx/journeys/` | 业务链路，**不可运行**（被 scenario 引用） | ❌ |
| `jmx/scenarios/` | E2E 场景，可运行 | ✅ |
| `jmx/api/` | 单接口容量测试，可运行 | ✅ |
| `jmx/suites/` | 混合/常驻负载，可运行 | ✅ |

`run.sh` 会**拒绝**直接运行 `fragments/` 和 `journeys/` 下的文件——它们没有 Thread Group，
跑起来是 0 sample，与其让人对着空报告排查半天，不如直接拒绝。

---

## 2. 元件对照表：JMeter 概念 ↔ 本框架四层

| 层 | JMeter 元件 | 关键约束 |
|---|---|---|
| **原子 fragment** | `Test Fragment` + `Transaction Controller` + `HTTP Request` | **必须是 Test Fragment，不能是 Thread Group** |
| **组合 fragment** | `Test Fragment` + 若干 `Include Controller` | 自己**一个 HTTPSampler 都不许有**（规则 R1/R2） |
| **journey** | `Test Fragment` + `Include` + `Test Action`(think time) | 同上 |
| **可运行 plan** | `Test Plan` + `Thread Group` + `Include Controller` | 薄壳，只组装不定义 |

### 为什么被 Include 的文件必须是 Test Fragment

Include Controller 的工作方式是：**把外部 jmx 的 Test Plan 子节点，原地插到自己的位置**。

如果那个文件里是 Thread Group，插进来就成了"Thread Group 套在 Controller 里"——
JMeter 不支持这种嵌套，结果是元件被静默丢弃。**表现为跑完 0 sample，不报错。**

Test Fragment 是专门为此设计的容器：它在自己的文件里**默认不执行**，
只有被 Include 时才作为普通控制器展开。

> 这一条约束，反推出了整套四层架构。不是先有架构再选元件，是元件的限制决定了架构只能长这样。

---

## 3. 开工前：五分钟连通性验证

**不要一上来就建四层。** 先用一个丢弃式的 plan 确认网络、host、header 是对的——
否则你会在四层结构里排查一个其实是端口写错的问题。

1. `File → New`
2. 右键 `Test Plan` → **Add → Threads (Users) → Thread Group**（默认 1 线程 1 轮，不用改）
3. 右键 `Thread Group` → **Add → Sampler → HTTP Request**
   - `Server Name or IP`：真实 host
   - `Port Number`：真实端口
   - `Method`：`GET`
   - `Path`：`/api/v1/refdata/portfolios`
4. 右键 `Thread Group` → **Add → Config Element → HTTP Header Manager**
   - 加一行 `X-User-Id` = `maker@sc.com`
5. 右键 `Thread Group` → **Add → Listener → View Results Tree**
6. 点绿色 ▶ 运行

看 View Results Tree 里的 Response。**拿到 200 和一段 JSON 再往下走。**

拿不到的话，问题在这五样之一：host / 端口 / basePath / header / 网络可达性。
现在排查是 5 分钟的事，建完四层再排查是半天。

**验证完这个文件直接丢掉**，不要存进 `jmx/`。

---

## 4. 建第一个原子 fragment

自底向上：原子 → 组合 → plan。因为 plan 要 Include fragment，fragment 不存在就没法建。

以 `create-trade` 为例。

### 4.1 新建空文件并放上 Test Fragment

1. `File → New`
2. **删掉自动生成的 Thread Group**（如果有）——原子 fragment 里不能有
3. 右键 `Test Plan` → **Add → Test Fragment → Test Fragment**
4. 改名：`workers.trade-management.create`

   命名用 `<svc>.<module>.<api>`，与 `api-registry.csv` 的 `apiId` 列**一字不差**。
   规则 R5 会检查这个对应关系。

5. 顺手把 Test Plan 的 `Comments` 填上：`Atomic fragment. Never run directly.`

### 4.2 加 Transaction Controller

右键 Test Fragment → **Add → Logic Controller → Transaction Controller**

| 字段 | 填什么 | 为什么 |
|---|---|---|
| Name | `TX_workers_trademgmt_create` | 事务名进报告，命名规范见 [KPI Definitions §2.6](../docs/performance/kpi-definitions.zh.md) |
| ☐ Generate parent sample | **不勾** | 勾了会把子 sampler 从报告里隐藏,只剩一个聚合行,出问题时看不到是哪一步慢 |
| ☐ Include duration of timer and pre-post processors | **不勾** | 勾了 think time 会被算进事务耗时。那个数字既不是服务端能力也不是用户感受,没有意义 |

> **一个原子 fragment 一个 TX，不要嵌套。** 组合层的 `TX_flow_*` 才包含原子的 `TX_<svc>_*`。
> 算 TPS 时两者**二选一不可相加**，否则同一次工作被计两次。

### 4.3 加 HTTP Request

右键 Transaction Controller → **Add → Sampler → HTTP Request**

#### Web Server 区

| GUI 字段 | 填什么 | ⚠ |
|---|---|---|
| Protocol | `${__P(workers.protocol,http)}` | |
| Server Name or IP | `${__P(workers.host,localhost)}` | **必须显式写**，见下 |
| Port Number | `${__P(workers.port,8080)}` | |

**为什么每个 sampler 都要重复写这三行、而不是在 HTTP Request Defaults 里设一次：**

OREO 有 5 个服务（workers / uc / refdata / notifications / ops），它们**各自独立寻址**。
在 Defaults 里设一个全局 host，会让"忘记写 domain 的 sampler"静默打到错误的服务上，
**而请求本身成功**——这类错误在报告里完全看不出来。

规则 R3 会检查：`steps/<svc>/` 下的 fragment 必须用 `${__P(<svc>.host)}`。目录和前缀对不上就报错。

#### HTTP Request 区

| GUI 字段 | 填什么 |
|---|---|
| Method | `POST` |
| Path | `${__P(workers.basePath,/api/v1)}/trades/create` |
| ☑ Follow Redirects | 勾 |
| ☐ Redirect Automatically | 不勾 |
| ☑ Use KeepAlive | 勾 |
| ☑ **Use multipart/form-data** | 勾 —— 本接口是 multipart |
| ☑ **Browser-compatible headers** | 勾 |

> **multipart 三条铁律**（改错了服务端直接无法分段）：
>
> 1. 勾 `Use multipart/form-data` → JMeter 自己生成 `Content-Type` **及其 boundary**
> 2. **绝不在 Header Manager 里手写 `Content-Type`** —— 手写值不带 boundary，且会覆盖生成值
> 3. 勾 `Browser-compatible headers` → 只给带 `filename` 的 part 写 Content-Type。
>    不勾的话 JMeter 会给 `trade` 这个普通字段多加 `Content-Type: text/plain`
>    和 `Content-Transfer-Encoding: 8bit`，与真实 curl 不一致

#### Parameters 标签页

点 `Add`，加一行：

| Name | Value | Encode? | Include Equals? |
|---|---|---|---|
| `trade` | `${tradePayload}` | 不勾 | 勾 |

`trade` 是**普通表单字段**（真实 curl 是 `-F 'trade={...}'`，不是 `-F 'trade=@file'`），
所以不需要写临时文件、不需要每线程文件管理、不需要 tearDown 清目录。

#### Files Upload 标签页

点 `Add`，加一行：

| File Path | Parameter Name | MIME Type |
|---|---|---|
| `${datDir}/${effectiveDatFile}` | `datFile` | `application/octet-stream` |

`effectiveDatFile` 由 PreProcessor 算出来（见 4.4），**不要在这个格子里写 JMeter 函数做判断**——
函数嵌在文件路径里求值时机不确定,出错时报的是"文件不存在",与真实缺文件无法区分。

### 4.4 挂 PreProcessor（决定"发出去的是什么"）

右键 **HTTP Request**（不是 Transaction Controller）→ **Add → Pre Processors → JSR223 PreProcessor**，加三个。

> ### ⚠ 作用域：挂在哪个元件上，决定它作用于谁
>
> JMeter 的前后置处理器**按树的层级作用，不按书写顺序**：
> - 挂在 **HTTP Request 下** → 只作用于这一个 sampler ✅
> - 挂在 **Transaction Controller 下** → 作用于该 TX 内**全部** sampler ❌
>
> 组合 fragment 里这一点尤其致命：`refdata-load` 有 portfolios 和 counterparties 两个查询，
> 提取器若挂在 TX 层，它会去解析 counterparties 的响应找 portfolio id——
> **拿不到，静默写入 `NOT_FOUND`**。所以那里每个 Include 都单独套了一层 Simple Controller。

三个 PreProcessor 都是同样的填法，只有 File Name 不同：

| 字段 | 填什么 |
|---|---|
| Name | `resolve dat file` / `select refdata` / `build trade payload` |
| Script language | `groovy` |
| Parameters | 留空 |
| **File Name** | `${__P(baseDir,.)}/groovy/<脚本名>.groovy` |
| Script | **留空**（用了 File Name 就别再写内联脚本） |
| ☑ Cache compiled script if available | 勾 |

> **为什么用 File Name 而不是把脚本粘在 Script 框里：**
>
> 1. 内联脚本在 jmx 里是一个 XML 字符串——**git diff 完全不可读**，review 等于没做
> 2. 同一段逻辑被两个 fragment 用时,内联就必然复制。`select-refdata.groovy`
>    现在被 `create-trade` 和 `calc-risk-for-new` 共用,改一处两处生效
> 3. IDE 里有语法高亮和括号匹配。内联框里写 30 行 Groovy，漏个花括号只有运行时才知道
>
> `Cache compiled script if available` 必须勾：不勾的话每次迭代都重新编译 Groovy，
> **压测时这个开销会盖过被测接口本身**。

### 4.5 挂断言（两层，缺一不可）

#### ① Response Assertion —— HTTP 层

右键 HTTP Request → **Add → Assertions → Response Assertion**

| 字段 | 选什么 |
|---|---|
| Apply to | `Main sample only` |
| Field to Test | **`Response Code`** |
| Pattern Matching Rules | **`Equals`** |
| Patterns to Test | `200` |

#### ② JSR223 Assertion —— 业务层

右键 HTTP Request → **Add → Assertions → JSR223 Assertion**，File Name 指向
`${__P(baseDir,.)}/groovy/assert-create-response.groovy`。

> ### 这是本项目最容易产出误导性报告的地方
>
> **这个接口业务失败时照样返回 HTTP 200**，业务状态藏在 body 的 `code` / `status` 里。
> 只有 Response Assertion 的报告会显示"错误率 0%"，而实际一条 trade 都没建成。
>
> 业务断言还负责**三类错误分离**——它们的处置方式完全不同：
>
> | errClass | 含义 | 找谁 |
> |---|---|---|
> | `technical` | 连接失败 / 超时 / 5xx | **这才是性能结论** |
> | `business` | HTTP 200 但业务拒绝 | 修数据 |
> | `script` | 提取器拿不到值 | 修脚本，**本轮作废** |
>
> 混在一个"错误率 12%"里的报告没法用——到底该找开发还是该修数据？

### 4.6 挂提取器

#### JSON Extractor

右键 HTTP Request → **Add → Post Processors → JSON Extractor**

| 字段 | 填什么 |
|---|---|
| Names of created variables | `tradeId` |
| JSON Path expressions | `$.data.trade.id` |
| Match No. | `1` |
| Default Values | `NOT_FOUND` |

**Default Values 必须填**，且业务断言里要**校验格式而非只判非空**——
提取失败时默认值 `NOT_FOUND` 也是非空字符串，"非空"这种弱断言会把它放过去。
所以 `assert-create-response.groovy` 判的是 `tradeId ==~ /^TRD-\d+$/`。

#### Regular Expression Extractor

| 字段 | 填什么 |
|---|---|
| Name of created variable | `taskId` |
| Regular Expression | `TaskId:\s*(CHK-[A-Za-z0-9]+)` |
| Template | `$1$` |
| Match No. | `1` |
| Default Value | `NOT_FOUND` |

> taskId 目前只存在于 msg 的自然语言里（`"Submitted for checker approval. TaskId: CHK-98C0DF19"`），
> 只能用正则捞。**文案一改就断**——已作为 improvement 提给开发。
> 这类脆弱点要在 Comments 里标出来，否则半年后没人知道为什么突然全是 `NOT_FOUND`。

### 4.7 存盘

`File → Save Test Plan as…` → `jmx/fragments/steps/workers/trade-management/create-trade.jmx`

然后**用文本编辑器**打开，在 `<?xml ...?>` 后面补文件头注释块。格式照抄现有 fragment：

```
【层级】【API】【服务】【被谁引用】
══ Fragment 契约 ══
【输入变量】【输出变量】【产出事务】
```

> ⚠ **XML 注释里不能出现连续两个连字符 `--`**。
> markdown 表格分隔线 `|---|---|` 会让整个文件无法解析。用缩进列表代替。
> （这条是踩过的坑，`validate.py` 现在会抓。）

---

## 5. 建组合 fragment

以 `csv-refdata-preflight` 为例。

1. `File → New`，删掉 Thread Group
2. **Add → Test Fragment → Test Fragment**，命名 `csv-refdata-preflight`
3. 右键 → **Add → Sampler → JSR223 Sampler**（本地校验，不发请求）
   - File Name：`${__P(baseDir,.)}/groovy/validate-csv-refdata.groovy`
4. 右键 → **Add → Logic Controller → Simple Controller**，命名 `preflight create`
5. 右键 Simple Controller → **Add → Logic Controller → Include Controller**
   - **Filename**：`jmx/fragments/steps/workers/trade-management/create-trade.jmx`
6. 右键 Simple Controller → **Add → Assertions → JSR223 Assertion**
   - File Name：`${__P(baseDir,.)}/groovy/preflight-policy.groovy`
7. 存到 `jmx/fragments/setup/csv-refdata-preflight.jmx`

### 三个必须记住的点

**① Include Controller 的 Filename 不支持变量。**

只能写死，且按**当前工作目录**解析。所以：
- `run.sh` 强制 `cd` 到项目根（脚本里那行 `cd` 不可删）
- GUI 也必须从项目根启动
- 写**相对项目根**的路径，不要写绝对路径（绝对路径换台机器就废）

不满足时 JMeter **不报错**，静默找不到 fragment——表现为"跑完了，一条请求都没发"。

**② 第 4 步那个 Simple Controller 不是装饰。**

它把第 6 步断言的作用域限制在这个 Include 内。直接挂在 Test Fragment 下，
会作用到 fragment 里**全部** sampler，包括第 3 步那个本地校验 sampler。

**③ 组合 fragment 里一个 HTTP Request 都不能有。**

需要发请求就 Include 原子 fragment。规则 R1/R2 会挡住复制进来的 sampler——
这条规则的由来是：早期版本 preflight 自己复制了一份 create 的 sampler，
后端加一个必填字段要改两处，**而没有任何东西会提醒你第二处存在**。

---

## 6. 建可运行 plan（p02）

终于到有 Thread Group 的那一层。

### 6.1 Test Plan 本体

`File → New`。Test Plan 节点上：

| 字段 | 值 |
|---|---|
| Name | `p02-trade-create` |
| Comments | `Runnable single-API capacity test. Thin shell.` |
| ☐ Run Thread Groups consecutively | 不勾 |
| ☐ Run tearDown Thread Groups after shutdown | 不勾 |
| ☐ Functional Test Mode | **不勾**（勾了会记录全部响应数据，压测时直接撑爆磁盘） |

### 6.2 User Defined Variables

右键 Test Plan → **Add → Config Element → User Defined Variables**

| Name | Value |
|---|---|
| `datDir` | `${__P(baseDir,.)}/data/dat` |
| `refdataSource` | `csv` |

`refdataSource` 用 **UDV（变量）而非全局属性**：同一次跑批里 E2E 计划（`pool`）
与单接口计划（`csv`）可能并存，用全局属性会互相污染。

且刻意**写死成 `csv`，不做成 `${__P(refdataSource,csv)}`**——它与 setUp 的 Include
是绑定的一对，只翻这个开关而不换 setUp，全局池就是空的，每个线程第一次迭代就 stop，
得到一份 0 sample 的报告。**一个只有一半生效的开关，比没有开关更危险。**

### 6.3 HTTP Request Defaults

右键 Test Plan → **Add → Config Element → HTTP Request Defaults**

| 字段 | 填什么 |
|---|---|
| Protocol / Server Name / Port | **全部留空** |
| Connect Timeout (Advanced 页) | `${__P(connectTimeout,5000)}` |
| Response Timeout (Advanced 页) | `${__P(responseTimeout,60000)}` |
| Content encoding | `UTF-8` |

前三个留空是**刻意的**，理由见 4.3。这个元件在本项目里只用来统一超时。

### 6.4 HTTP Header Manager

右键 Test Plan → **Add → Config Element → HTTP Header Manager**

| Name | Value |
|---|---|
| `accept` | `*/*` |
| `X-User-ID` | `${effectiveUserId}` |
| `X-User-Id` | `${effectiveUserId}` |
| `X-Dyn-Run` | `${__P(dynRun,false)}` |

> **⚠ 这里绝不能加 `Content-Type`** —— multipart 的 Content-Type 必须由 JMeter 生成（见 4.3）。
>
> **⚠ 两行 `X-User-Id` 只差大小写，取同一个值,这是刻意的。**
> 按 RFC 7230 §3.2 header 名大小写不敏感,**两者是同一个 header**——真实 curl 里
> 两个都存在。早期版本把大写那个写死成 `anonymous`：如果服务端取第一个出现的值，
> **全部请求都会以 anonymous 身份执行**，maker/checker 的区分静默失效，
> 而报告完全看不出来（请求成功、断言通过、错误率 0%）。
> 现在两行同值，服务端读哪个都对。
>
> 首次 smoke 在 View Results Tree 里确认服务端实际认哪个，
> 确认只认 `X-User-Id` 后把大写那行删掉。

### 6.5 身份：线程组级 UDV，不需要 groovy

`X-User-Id` 的值来自变量 `effectiveUserId`。它**不是**每次迭代算出来的——
在线程组的 UDV 里声明一次就够了（见 6.7 / 6.8）：

| 线程组做什么 | `effectiveUserId` |
|---|---|
| create / trigger-event / calculate-risk / 列表查询 | `${__P(makerUserId,maker@sc.com)}` |
| approve / reject / pending-tasks | `${__P(checkerUserId,checker@sc.com)}` |

> ### 为什么不用 PreProcessor 算
>
> 早期版本挂了个 `resolve-identity.groovy`，从 `accounts.csv` 轮换取用户。**它做错了两件事。**
>
> **一是没必要。** 全部 14 个线程组都是单一角色——没有任何一个线程组既做 maker 动作
> 又做 checker 动作（j03 只审批，j01 只提交）。身份在整个线程组生命周期内是常量，
> **per-iteration 计算没有任何东西可算**，只是把一个静态事实包装成了动态逻辑。
>
> **二是它错了。** `accounts.csv` 五行全是 `MAKER`，而 checker 场景也从这里取身份——
> 等于**"maker 审批自己提交的单子"**。四眼原则要求 checker ≠ maker（NFR SEC-02），
> 那个场景压根不成立。而这类错误脚本层面无法自证：
> 请求成功、断言通过、报告全绿，只有懂业务的人看一眼身份才会发现。
>
> 换成两个固定身份之后，**正确性从"脚本逻辑对不对"变成了"配置对不对"**——
> 后者一眼能看出来，前者不能。

**代价要说清楚**：原先 `userMode=pool|fixed` 的对照实验（分散 maker vs 集中同一 maker，
用来暴露 per-user 锁 / 计数器竞争）没有了，现在永远处于"集中"那一侧。
这是保守选择——测到的是最坏情况，不会给出偏乐观的结论，但也无法把"慢"归因到 per-user 锁上。
真需要时加一个 CSV Data Set 直接供 `effectiveUserId` 即可，不用恢复 groovy。

### 6.6 两个 CSV Data Set Config

右键 Test Plan → **Add → Config Element → CSV Data Set Config** ×2。

通用字段：

| 字段 | 值 | 说明 |
|---|---|---|
| File Encoding | `UTF-8` | |
| Ignore first line | ☑ | 表头行 |
| Delimiter | `,` | |
| Allow quoted data? | ☐ | 值里有逗号时才勾 |
| Recycle on EOF? | ☑ | 跑到文件尾回到第一行 |
| Stop thread on EOF? | ☐ | |
| Sharing mode | `All threads` | |

各自的 Filename / Variable Names：

| Name | Filename | Variable Names |
|---|---|---|
| `csv: create-trade data` | `${__P(baseDir,.)}/data/create-trade/create-trade-data.csv` | `caseId,datFile,productType,costTier,fixings,datSize,notionalCurrency` |
| `csv: refdata pairs` | `${__P(baseDir,.)}/${__P(refdataFile,data/refdata/refdata-pairs.csv)}` | `pairId,portfolioId,counterpartyFmId,counterpartyName,refdataNote` |

> **没有身份 CSV。** maker / checker 是两个固定值，走属性不走 CSV（见 6.5）。
>
> **Variable Names 与 CSV 表头是两套东西。** `Ignore first line` 勾上后表头被忽略，
> 运行时用的是这里填的名字。所以 `refdata-pairs.csv` 表头末列是 `note`、这里是 `refdataNote`——
> 表头那个名字让 `validate.py` 认出这是自由文本列，JMX 那个名字避免与别的 CSV 撞名。
>
> **Sharing mode 三选一的区别：**
> - `All threads` —— 全局一个游标，每个线程每次迭代取走一行，**不重复**
> - `Current thread group` —— 每个线程组一个游标
> - `Current thread` —— 每个线程独立从头读，**所有线程拿到相同序列**
>
> 用 `All threads`。选 `Current thread` 会让 20 个线程全部用第一行数据。

> ### ⚠ 一个真实的耦合
>
> `create-trade-data.csv`（5 行）和 `refdata-pairs.csv`（5 行）都是 `All threads`，
> 每次迭代**各推进一行**。行数相同时 `C00N` 会永远配 `R00N`，
> **25 种组合只跑到 5 种**。要打散就把两个文件的行数取成互质（比如 5 和 7）。

### 6.7 setUp Thread Group

右键 Test Plan → **Add → Threads (Users) → setUp Thread Group**

| 字段 | 值 |
|---|---|
| Name | `setUp: csv refdata preflight` |
| Action to be taken after a Sampler error | `Continue` |
| Number of Threads | `1` |
| Ramp-up period | `1` |
| Loop Count | `1`（Infinite 不勾） |
| ☐ Specify Thread lifetime | 不勾 |

**它做的是"造数与守门"，不是"施压"，所以永远 1 线程 1 轮。**

然后在它下面加两个东西：

1. **Add → Config Element → User Defined Variables**，两行：

   | Name | Value |
   |---|---|
   | `runPhase` | `setup` |
   | `effectiveUserId` | `${__P(makerUserId,maker@sc.com)}` |

   > setUp 的角色**必须与它 Include 的动作一致**：
   > `csv-refdata-preflight` 真建一笔 trade → maker；
   > `checker-task-pool` 查待审批队列 → 这里要写 `${__P(checkerUserId,checker@sc.com)}`。
   > 写错不会报错，只会让 preflight 以错误身份执行——而 preflight 恰恰是
   > 用来证明"数据业务上可用"的那一步，身份不对时它证明的是另一件事。
2. **Add → Logic Controller → Include Controller**
   → `jmx/fragments/setup/csv-refdata-preflight.jmx`

> ### `runPhase` 这一行不能省
>
> setUp 里 Include 的是**和主链路完全相同**的 create fragment，
> 所以它产生的样本**事务名也完全相同**,会一起进 jtl。
>
> 不加这个标记，preflight 那一笔 create 会混进容量统计——
> 1 线程跑 300 秒的 baseline 里多混一笔冷启动请求，P95 会被拉偏。
>
> `run.sh` 已经把 `runPhase` 加进 `sample_variables`，它会成为 jtl 的一列。
> 分析时 `runPhase=setup` 的行全部过滤掉。

### 6.8 主 Thread Group

右键 Test Plan → **Add → Threads (Users) → Thread Group**

| 字段 | 值 | 说明 |
|---|---|---|
| Name | `TG: create-trade capacity` | |
| Action after Sampler error | `Continue` | 不要选 Stop——一笔失败不代表要终止整轮 |
| Number of Threads | `${__P(threads,1)}` | 文本框，函数能存住 |
| Ramp-up period | `${__P(rampUp,1)}` | |
| Loop Count | `${__P(loops,-1)}`，Infinite **不勾** | 见下 |
| ☑ Specify Thread lifetime | **勾**，Duration = `${__P(duration,60)}`，Startup delay = `0` | 见下 |

> **Loop Count 的技巧：** 勾 `Infinite` 会写死 `continue_forever=true`，profile 就控制不了了。
> 改成**不勾 Infinite、在文本框里写 `${__P(loops,-1)}`** ——
> `-1` 在运行时同样表示无限，但现在它是可被 profile 覆盖的。
> `smoke` profile 传 `loops=1`，`load` 传 `-1`，同一份脚本两种跑法。
>
> **Specify Thread lifetime 就是那个会被 GUI 改坏的复选框**（见 §0）。
> GUI 里勾上它保证 Duration 字段可编辑,存盘后**必须**用文本编辑器把
> `<boolProp name="ThreadGroup.scheduler">true</boolProp>`
> 改回 `<stringProp name="ThreadGroup.scheduler">${__P(scheduler,true)}</stringProp>`。
> 不改的话 `smoke`（`scheduler=false`）会失效，1 轮变成跑满 60 秒。

下面同样加两个：

1. **User Defined Variables**，两行：

   | Name | Value |
   |---|---|
   | `runPhase` | `main` |
   | `effectiveUserId` | `${__P(makerUserId,maker@sc.com)}` |

   checker 类计划（`s03` / `p03` / `p04`）这里换成 `${__P(checkerUserId,checker@sc.com)}`。
2. **Include Controller** → `jmx/fragments/steps/workers/trade-management/create-trade.jmx`

> **单接口测试直接 Include 原子 fragment，不经过 journey。** journey 里有
> think time 和额外步骤,那些是"用户体验",不是"服务端能力"。
> 加了 think time 的单接口测试压不出真实上限。

### 6.9 存盘 + 手工定稿

存到 `jmx/api/p02-trade-create.jmx`，然后文本编辑器里做两件事：

1. 改回 `ThreadGroup.scheduler`（见上）
2. 补文件头注释块

---

## 7. GUI 调试

### 启动命令

```bash
cd /path/to/oreo-perf     # 必须！Include 路径按 cwd 解析

jmeter -q config/dev.properties \
       -JbaseDir="$PWD" \
       -t jmx/api/p02-trade-create.jmx
```

**这两个参数在 GUI 模式下同样生效，不带的话：**

| 不带 | 后果 |
|---|---|
| `-q config/dev.properties` | 所有 `${__P(workers.host,localhost)}` 退回默认值 `localhost`，打不到真实环境 |
| `-JbaseDir="$PWD"` | 所有 groovy 脚本路径变成 `./groovy/...`——**碰巧也对**，但 `datDir` 之类的会跟着 cwd 漂 |

### 三个调试元件（用完必须删）

| 元件 | 加在哪 | 看什么 |
|---|---|---|
| **View Results Tree** | Thread Group 下 | 请求体（确认 multipart）、响应体、断言结果 |
| **Debug Sampler** | 想看的 sampler **后面** | 该时刻所有 `vars` 的值——排查 `${xxx}` 没解析时最有用 |
| **Debug PostProcessor** | 挂在某个 sampler 上 | 同上，但不产生额外样本 |

> ⚠ **压测前必须删掉或禁用（右键 → Disable）。**
> View Results Tree 会把每个响应完整存在内存里,几分钟就 OOM。
> 这是新手最常见的"压测跑一半 JMeter 自己挂了"的原因。

### GUI 里看不到 Include 的内容

Include Controller 在 GUI 里只显示一个文件路径,**内容只在运行时展开**。
想看请求长什么样,直接打开那个 fragment 文件。

这不是缺陷,是分层的代价:换来的是"接口变更只改一处"。

---

## 8. 完工校验

```bash
python3 scripts/validate.py
```

它检查五条机器强制规则——这五条是"每个 API 只维护一份"在
5 svc × N module × M api 规模下唯一守得住的办法（约定守不住）：

| 规则 | 检查什么 | 触发时说明你 |
|---|---|---|
| **R1** | HTTPSampler 只许出现在 `fragments/` 下 | 在 plan 或 journey 里直接建了 sampler |
| **R2** | 同一 method + 规范化 path 不得定义两次 | 复制了 fragment 而不是 Include |
| **R3** | `steps/<svc>/` 下必须用 `${__P(<svc>.host)}` | 目录放错了，或者忘了写 domain |
| **R4** | 每个 fragment 必须被某个可运行 plan 间接引用 | 建了个没人用的孤儿 fragment |
| **R5** | `api-registry.csv` 与磁盘一致 | 建了 fragment 但没登记 |

> **它验证不了**：JSONPath 是否匹配真实响应、断言是否成立、服务端是否接受请求。
> 那些只能靠真跑一次 smoke —— 接 [`HANDBOOK.zh.md`](HANDBOOK.zh.md) 阶段 1。

---

## 9. GUI 陷阱速查

| 症状 | 原因 | 处置 |
|---|---|---|
| 跑完 0 sample | 被 Include 的文件里是 Thread Group 不是 Test Fragment | 见 §2 |
| 跑完 0 sample | 没在项目根启动 | 见 §5① |
| 文件头注释全没了 | 从 GUI 保存过 | 见 §0 —— 只能粘回去 |
| `smoke` 跑满 60 秒 | `Scheduler` 被 GUI 写死了 | 见 §6.8 |
| 提取器全是 `NOT_FOUND` | PostProcessor 挂在 TX 层，作用到了别的 sampler | 见 §4.4 |
| 服务端说 multipart 无法解析 | Header Manager 里手写了 Content-Type | 见 §4.3 |
| 错误率 0% 但一条数据都没建成 | 只有 Response Assertion，没有业务断言 | 见 §4.5 |
| jtl 里有 `${xxx}` 字面量 | CSV 列名与 Variable Names 对不上 | Debug Sampler 看 vars |
| 压测跑一半 JMeter 自己挂了 | View Results Tree 忘了禁用 | 见 §7 |
| 20 个线程全用第一行数据 | CSV Sharing mode 选了 `Current thread` | 改成 `All threads` |
| XML 解析失败 | 注释里有 `--`（markdown 表格线） | 见 §4.7 |
| Groovy 编译开销盖过被测接口 | `Cache compiled script` 没勾 | 见 §4.4 |
