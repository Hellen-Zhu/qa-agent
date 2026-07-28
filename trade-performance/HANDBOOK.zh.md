# OREO 性能测试 · JMeter 实操手册

本手册是**执行指南**，回答"现在坐在电脑前该敲什么"。

- 工程还没搭 / 要加新 API → 先看 [`HANDBOOK-BUILD.zh.md`](HANDBOOK-BUILD.zh.md)（GUI 逐元件实操）
- 方案层面的取舍（为什么这么测、指标口径、NFR）→ [`../docs/performance/`](../docs/performance/)
- 架构约束（四层结构、五条强制规则）→ [`README.md`](README.md)

---

## 阶段总览

| 阶段 | 目标 | 产出 | 状态 |
|---|---|---|---|
| **0** | 采集一份真实 curl | 数据 + 契约校准依据 | 手册已写，待执行 |
| **1** | `create-trade` 单接口压测 | 单笔耗时基线 → 并发拐点 | **← 本次详写** |
| 2 | `s01` E2E 场景 | 含 refdata 查询与 think time 的用户级链路 | 待写 |
| 3 | Checker flow / 生命周期事件 | 四眼原则两阶段路径的成本 | 身份链路与结果口径已写，加压部分待写 |
| 4 | Blotter 常驻自动刷新（`suites/`） | OREO 真正的负载形态（约占请求量 97%） | 脚本未建 |
| 5 | 混合场景 + 长稳 | 上线验收结论 | 待写 |

**阶段顺序不可跳。** 阶段 1 产出的"单笔耗时"是阶段 2 以后所有并发目标的输入——
没有它，线程数就只能靠猜，而猜出来的数字无法解释。

---

# 阶段 0 · 采集一份真实 curl

> 这一步不用 JMeter。它是整个阶段 1 的唯一前置，**跳过它后面每一步都会返工**。

在 OREO Web 上手工建一笔 trade，全程开着 Chrome DevTools 的 Network 面板。
建完后找到 `POST /trades/create` 这条请求 → 右键 → **Copy → Copy as cURL**。

一份 curl 同时给你五样东西：

| 从 curl 里拿 | 用来填 |
|---|---|
| `portfolioId` / `counterpartyFmId` / `counterpartyName` | `data/refdata/refdata-pairs.csv`（且天然配对） |
| 上传的 `.dat` 文件 | `data/dat/products/<productType>/`（在页面上重新下载一份原始文件） |
| `trade` 表单字段的 JSON 结构 | 校准 `groovy/build-trade-payload.groovy` |
| 全部 header | 校准 `X-User-Id` 大小写、确认 `X-Dyn-Run` 语义 |
| 响应体 | 校准 `groovy/assert-create-response.groovy` 与两个提取器 |

**重复 5 次、每次换一个 counterparty**，就得到 5 行 refdata 和 5 个真实响应样本。

把 curl 原文存到 `data/refdata/_samples/`（自建目录，加进 `.gitignore`）。
三个月后有人问"当初为什么断言 `status == 'PENDING APPROVAL'`"，你需要拿得出证据。

> ⚠ **不要用 UI 抓的 curl 直接压测。** 它带着会话上下文和一次性的表单值。
> 它的价值是**校准**，不是**执行**。

---

# 阶段 1 · create-trade 单接口压测

测的是 `POST /trades/create` 的纯服务端能力：不查 refdata、不加 think time、不看详情。

## 1.1 环境检查

```bash
cd /Users/jliu/hellen/qa/trade-performance

java -version      # 需要 11+
jmeter --version   # 需要 5.6.3（脚本里的 jmeter="5.6.3" 是兼容性声明）
```

当前脚本**不依赖任何第三方插件**。（`_composites/refdata-load.jmx` 提到的
bzm Parallel Controller 是阶段 2 的可选优化，现在不用装。）

> ⚠ **必须从项目根目录启动 JMeter**，无论 GUI 还是命令行。
> Include Controller 的 `includepath` 不支持变量，按**当前工作目录**解析。
> 在别处启动的表现是"跑完了，0 条请求"——不报错，只是什么都没发生。
> `scripts/run.sh` 已经帮你 `cd` 了；手工开 GUI 时要自己注意。

## 1.2 填三份数据

### ① 参考数据（阶段 0 的产出）

编辑 `data/refdata/refdata-pairs.csv`，把 5 行 `TBC` 换成真值：

```csv
pairId,portfolioId,counterpartyFmId,counterpartyName,note
R001,PF-00123,FM-88991,PRINTINGINT10LTD*HKG,2026-07-27 从 UI curl 采集
```

一行一对，**不要跨行拼**（详见 [`data/refdata/README.md`](data/refdata/README.md)）。

### ② .dat 文件

至少放一个到 `data/dat/products/<productType>/`，路径与 `create-trade-data.csv`
的 `datFile` 列对上，然后跑一次对账（它会把实测字节数填进 `datSizeBytes`）：

```bash
./scripts/index-dat.py --write
```

阶段 1 的最小集是 **1 个 productType 1 个文件**。
成本画像需要的三个代表（最便宜 / 最贵 / 最常见）是阶段 5 的输入，现在不必凑齐——
`index-dat.py` 会 WARN 提醒你还差几个，那不是阻断。

> **不要把一个文件复制几份改名充数。** 内容相同的副本在服务端可能走缓存，
> 测到的是命中率不是解析成本，而 CSV 里 5 行看起来像 5 个用例。
> 详见 [`data/dat/README.md`](data/dat/README.md)。

### ③ 成本标签

`data/create-trade/create-trade-data.csv` 的 `fixings` 列现在是 `TBC`。
它不影响请求内容（只是 jtl 里的一个结果标签），但**它是"P95 对定盘次数"这条成本曲线的横轴**。
只用一个 .dat 时先填那一个文件的真实定盘次数即可。

### 校验

```bash
python3 scripts/validate.py
```

必须 **exit 0**。它会检查五条架构规则 + CSV 里的占位值。
现在跑会看到 3 条 TBC 报错，那就是你要填的东西。

## 1.3 在 GUI 里先看一眼结构

```bash
jmeter -t jmx/api/p02-trade-create.jmx        # 注意：在项目根执行
```

你会看到一棵**很浅**的树——这是对的。p02 是薄壳：

```
p02-trade-create
├── UDV (datDir, refdataSource=csv)
├── HTTP Request Defaults      ← 刻意不设 domain（见文件头注释）
├── HTTP Header Manager        ← X-User-Id = ${effectiveUserId}
├── CSV Data Set: create-trade data / refdata pairs
├── setUp Thread Group
│   ├── UDV (runPhase=setup, effectiveUserId=maker)
│   └── Include → fragments/setup/csv-refdata-preflight.jmx
└── Thread Group: create-trade capacity
    ├── UDV (runPhase=main, effectiveUserId=maker)
    └── Include → fragments/steps/workers/trade-management/create-trade.jmx
```

**Include 的内容在 GUI 里看不到**（JMeter 只在运行时展开）。想看请求长什么样，
直接打开 `jmx/fragments/steps/workers/trade-management/create-trade.jmx`。

GUI 里**不要跑压测**——GUI 模式自身的开销会污染结果。GUI 只用来看结构和调试。

## 1.4 第一次 smoke：验证脚本，不是验证性能

```bash
./scripts/run.sh p02-trade-create dev smoke
```

`smoke` = 1 线程 × 1 轮。**它会在被测系统里真建 2 笔 trade**
（setUp 的 preflight 一笔 + 主循环一笔），状态 `PENDING APPROVAL`。心里有数。

### 自检清单（八条，缺一不可）

跑完后按顺序检查。**任何一条不过，都不要往下走**——带着脚本 bug 加压，
产出的是一份看起来正常、实际无意义的报告。

| # | 查什么 | 怎么查 | 不过说明什么 |
|---|---|---|---|
| 1 | 没有未解析变量 | run.sh 末尾会自动扫 jtl 里的 `${...}` | CSV 列名对不上 / 变量拼错 |
| 2 | preflight 通过 | run.sh 末尾没有 `PREFLIGHT FAILED` | refdata 值在库里不存在或已停用 |
| 3 | 真的发出了请求 | jtl 行数 ≥ 3（validate + 2 笔 create） | Include 路径错（八成没在项目根跑） |
| 4 | 打到了正确的服务 | `jmeter.log` 里的 URL 是 `workers.host` | config 里 host 还是 localhost 占位值 |
| 5 | `errClass=ok` | `grep -c ',ok,' results/*/result.jtl` | 见下方"三类错误"分诊表 |
| 6 | `tradeId` 提取到了 | jtl 的 tradeId 列是 `TRD-数字` 而非 `NOT_FOUND` | `$.data.trade.id` 与真实响应不符 |
| 7 | `taskId` 提取到了 | jtl 的 taskId 列是 `CHK-...` | 正则与 msg 文案不符（文案一改就断） |
| 8 | multipart 发对了 | 见下方"确认 multipart"　 | Content-Type 被 Header Manager 覆盖 |

### 三类错误分诊

`errClass` 这一列是整个框架里最该先看的东西：

| 值 | 含义 | 找谁 |
|---|---|---|
| `ok` | 成功 | — |
| `technical` | 连接失败 / 超时 / 5xx | **这才是性能结论** |
| `business` | HTTP 200 但业务拒绝 | 修数据，不是性能问题 |
| `script` | 提取器拿不到值 / 解析异常 | 修脚本，**本轮结果作废** |

> 一个只报"错误率 12%"的报告没法用——该找开发还是该修数据？
> 这就是三类分离存在的全部理由。

### 确认 multipart（第 8 条的做法）

命令行模式看不到请求体。用 GUI 单独确认一次：

1. GUI 打开 `p02`，在 Thread Group 下临时加一个 **View Results Tree**
2. 只跑 1 次，看 Request → Request Body
3. 应该看到 `Content-Type: multipart/form-data; boundary=...`，两个 part：
   `trade`（普通字段，JSON）和 `datFile`（带 `filename=`）
4. **确认完把 View Results Tree 删掉或禁用**——它在压测时会吃光内存

若 `trade` part 上多出 `Content-Type: text/plain`，说明
`BROWSER_COMPATIBLE_MULTIPART` 没生效；若整个请求没有 boundary，
说明有人在 Header Manager 里手写了 Content-Type。两者都会让服务端无法分段。

## 1.5 用真实响应校准三处推断

脚本里有三处标着"未经真实响应验证"。阶段 0 的响应样本就是用来校准它们的：

| 位置 | 推断内容 | 校准方式 |
|---|---|---|
| `groovy/build-trade-payload.groovy` | `trade` 字段只有 `basic` 一层，4 个子字段 | 对照 curl 的 `-F 'trade={...}'` |
| `groovy/assert-create-response.groovy` | 成功判定 `code==200 && status=='PENDING APPROVAL'` | 对照真实响应体 |
| `create-trade.jmx` 的两个提取器 | `$.data.trade.id` 与 `TaskId:\s*(CHK-[A-Za-z0-9]+)` | 同上 |

**改动只在这三处**，`p02` 和 `s01` 同时生效——这是四层架构的收益兑现点。

## 1.6 单线程基线：先测一笔要多久

```bash
./scripts/run.sh p02-trade-create dev baseline
```

`baseline` = 1 线程连续跑 300 秒。**目的不是压出上限，是测出单笔耗时的分布。**

为什么这一步不能跳：OREO 的并发目标是**推导出来的，不是拍出来的**。
单笔 20 秒和单笔 90 秒对应的稳态并发数差一倍以上
（M/G/∞ 排队模型，推导过程见 [Workload Modeling §4.7.4](../docs/performance/workload-modeling.zh.md)）。
先拿到耗时，才知道下一步该开多少线程。

记下三个数：**P50 / P95 / 最大值**。P95 与 P50 的比值比绝对值更有信息量——
比值大说明存在慢路径（多半是 .dat 解析或 risk 计算），那是下一步要单独拆的。

## 1.7 阶梯加压：找拐点，不是找一个数

不要直接上 `load`。手工阶梯，**每级只改线程数这一个变量**：

```bash
for t in 2 4 8 12 16 20; do
  ./scripts/run.sh p02-trade-create dev baseline -Jthreads=$t -Jduration=180
done
```

每级记录：**TPS / P95 / errClass 分布**。

拐点的判据是 **TPS 不再随线程数上升，而 P95 开始陡增**。
那个点就是容量上限；超过它继续加线程只会让排队变长，不会让吞吐变高。

> ⚠ 每一级都会在被测系统里留下真实 trade。跑 6 级 × 180 秒，
> 数据量可能是四位数。**开跑前先和 DBA/开发对齐清理方案**——
> 当前 payload 不接受自定义字段，压测数据只能靠
> "专用 PERF Portfolio + `PENDING APPROVAL` 状态 + 时间窗口"三者交集来识别。

## 1.8 对照实验（各跑一次，与基准对比）

到这里主线已完成。下面这个开关回答的是"性能问题出在哪一层"：

```bash
# 全部线程打同一个 portfolio —— 若 TPS 显著下降，存在 portfolio 级锁竞争
./scripts/run.sh p02-trade-create dev baseline -Jthreads=8 \
    -JrefdataFile=data/refdata/refdata-pairs-single.csv
```

**一次只开一个开关。** 同时开两个，结果无法归因。

> ### ⚠ per-user 锁竞争这个维度**测不了**
>
> 身份已固定成 `maker@sc.com`（不再从 CSV 轮换），所以全部线程本来就共用同一个 maker——
> **永远处于"集中"那一侧，没有"分散"的对照组可比。**
>
> 这是保守选择：如果服务端真有 per-user 锁或计数器，我们测到的是它最坏的一面，
> 不会给出偏乐观的容量结论。但**报告里不能声称"不存在 per-user 竞争"**——
> 我们没有做那个实验，只是一直站在竞争最激烈的那一侧。
>
> 真要做这个对照，加一个 CSV Data Set 直接供 `effectiveUserId` 即可
> （见 [HANDBOOK-BUILD §6.5](HANDBOOK-BUILD.zh.md)），不需要恢复 groovy。

## 1.9 交付物

阶段 1 结束时应该拿得出：

1. 单笔耗时的 P50/P95/max（`baseline` 那一轮）
2. TPS–线程数曲线与拐点位置（阶梯那六轮）
3. 拐点处的 `errClass` 构成（技术失败占比多少）
4. 两个对照实验相对基准的差异
5. 每轮的 `results/<runId>/manifest.txt`——**它是结论可复现的唯一凭据**

第 5 条不是形式主义。三个月后有人质疑某个数字，没有 manifest
你无法回答"那次跑的是哪个 commit、哪份数据、什么参数"。

---

# 阶段 2–5（提纲）

## 阶段 2 · `s01` E2E 场景

与阶段 1 的差别：加回 refdata 查询（`refdataSource=pool`）、加 think time、加 view-details。
测的是**用户视角的端到端耗时**，不是服务端能力。

阶段 1 的单笔耗时是这里的输入：`TX_flow_*` 减去 `TX_workers_*` 就是"其余环节的开销"。

## 阶段 3 · Checker flow 与生命周期事件

`s03` / `s04` / `p03`–`p06`。核心是四眼原则的**两阶段路径**：
提交 → 锁 → 建 task → 通知 → 审批 → 执行。

### 3.1 两个身份，顺序不能反

```
s01-create-trade-e2e     maker@sc.com     提交 → trade 锁 pending approve → 建 checker task
        ↓ 造数
s03-checker-approve-e2e  checker@sc.com   审批 → 事件执行 / 拒绝时从快照恢复
```

```bash
./scripts/run.sh s01-create-trade-e2e    dev smoke    # 造数：maker
./scripts/run.sh s03-checker-approve-e2e dev smoke    # 审批：checker
```

阶段 1 跑完任务池自然就有了。池空时 setUp 报 `CHECKER TASK POOL TOO SMALL`——
这个报错语义是干净的，**只可能是"环境里没有待审批任务"**，因为
`checker@sc.com` 已确认在 dev 存在（2026-07 与业务确认）。不必怀疑账号问题。

### 3.2 ⚠ 首次 smoke 必须盯的一件事：四眼分支真的走到了吗

> **全 `ok` 不能证明四眼原则被测到了。**
>
> 身份改成固定双角色之前，checker 和 maker 都从 `accounts.csv` 取值，而那份 CSV
> 五行全是 `MAKER`——`s03` 实际在做"maker 审批自己提交的单子"。
> 那时候报告一样是全绿：请求成功、断言通过、错误率 0%。
> **"报告没问题"和"测到了想测的东西"是两回事。**

跑完 `s03` smoke，看 `errClass` 分布和 `checkerFailMsg` 列：

| 观察到 | 说明 | 处置 |
|---|---|---|
| 全 `ok` | 审批成功 | ✅ 但还不足以证明服务端校验了 maker≠checker，见下方"反证" |
| `business` + msg 含 `same user` / `not authorized` / `self-approval` | **服务端的 maker≠checker 口径与我们理解的不一样**（例如按角色判而非按账号判） | 回头调 `checkerUserId`，或与开发确认判定规则 |
| `business` + msg 含 `not found` / `already processed` | 任务被别的线程抢走或已过期 | 正常竞争，见 3.3 |

**反证一次（十分钟，值得做）**：临时让 checker 用 maker 身份跑一轮——

```bash
./scripts/run.sh s03-checker-approve-e2e dev smoke -JcheckerUserId=maker@sc.com
```

**期望它失败**。如果它照样全 `ok`，说明**服务端根本没校验 maker≠checker**——
那是一个需要立刻提给开发的安全缺陷（NFR SEC-02），
而且意味着四眼原则在生产里也不成立。这一轮无论结果如何都要写进报告。

### 3.3 结果口径

- **按 `checkerAction` 切分**：`approve` 和 `reject` 成本不同——
  reject 要恢复 pre-execution 快照并写审计日志，路径更长。默认拒绝率 5%
  （`checkerRejectRate`），单独看 reject 的 P95 需要拉高这个比例专门跑一轮。
- **按 `needsApproval` 切分**（`s04` / `p06`）：同一个 `trigger-event` 端点，
  需审批走两阶段、不需审批走单阶段，耗时与资源占用完全不同，
  **绝不能用一条 SLA 覆盖**。
- **`lockedRejection` 不是缺陷**：目标 trade 已处于 pending approve 而被拒，
  这是四眼原则**正确工作**的表现。它的正确读法是"可挑的 trade 太少"（数据问题），
  不是找开发。混进业务拒绝率里会掩盖真问题。
- **`bulkOutcome`**（`p03` / `p04`）：批量接口可能部分成功，
  `full` / `partial` / `unverifiable` 三态必须分开统计——
  把 partial 记成成功会高估容量。

## 阶段 4 · Blotter 常驻自动刷新 ⚠ 脚本未建

**这是缺口最大的一块。** 当前 `s02` 只模拟用户主动打开页面（约 0.14 TPS），
而真实大头是 blotter 自动刷新——4 个 blotter × 刷新间隔，**恒定约 4.13 TPS，与用户行为无关**。

按 [Workload Modeling](../docs/performance/workload-modeling.zh.md) 的测算，
环境背景流量约为业务峰值的 **278 倍**，占总请求量 **97.4%**。
只跑 `s02` 会低估 blotter 真实负载约 30 倍。

需要在 `jmx/suites/` 下建一个常驻线程组。**这是阶段 5 混合场景成立的前提。**

前置依赖：前端确认自动刷新间隔与单页 blotter 数（A10–A12）。这两个参数是前端配置项，
确认成本极低，却决定了 97% 的请求量——**是整个项目里性价比最高的一个待确认项**。

## 阶段 5 · 混合场景 + 长稳

阶段 4 的常驻负载打底，叠加阶段 1–3 的业务流量，按真实配比混合。
外加 `soak` 长稳（观察内存与连接池泄漏）。

**低吞吐系统的特殊性**：OREO 每天约 120 笔 booking，
意味着"平均产品配比"这个状态在生产中**从不出现**——实际总是某一种产品连续来几笔。
所以除了平均配比，必须单独测**退化配比**（全是最贵的那个产品）。
详见 [Test Plan](../docs/performance/oreo-performance-test-plan.zh.md) 场景 S-16b。

---

## 附：常见故障速查

| 症状 | 原因 | 处置 |
|---|---|---|
| 跑完 0 条请求 | 没在项目根启动 | `cd` 到 `trade-performance/` 再跑 |
| jtl 里有 `${xxx}` 字面量 | CSV 列名与 `variableNames` 对不上 | 核对 CSV Data Set 配置 |
| `PREFLIGHT FAILED — csv refdata` | CSV 还是占位值 | 见阶段 0 |
| `PREFLIGHT FAILED — code=...` | CSV 值在库里失效 | 重新采集 refdata |
| 全部 `errClass=business` | payload 结构或 refdata 不对 | 见 1.5 校准 |
| 全部 `errClass=script` | 提取器与真实响应不符 | 见 1.5 校准 |
| 文件不存在（multipart） | `.dat` 没放或路径对不上 | 见 1.2 ② |
| 内存溢出 | View Results Tree 忘了禁用 | 见 1.4 |
