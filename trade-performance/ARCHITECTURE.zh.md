# 运行原理 · JMeter 是怎么把这些文件变成一次请求的

**这份文档讲机制,不讲布局。**
"目录为什么分四层""三维正交是什么"见 [README.md](README.md);
"怎么一步步跑"见 [HANDBOOK.zh.md](HANDBOOK.zh.md);
"怎么在 GUI 里从零搭出来"见 [HANDBOOK-BUILD.zh.md](HANDBOOK-BUILD.zh.md)。

本文回答的是另一类问题:

- 为什么 `workers_trademgmt_create` 在报告里出现两次?
- 为什么 `run.sh` 必须先 `cd`?
- 为什么身份是 UDV 而不是 groovy,而 refdata 池必须是 `props`?
- 为什么改了断言却不生效?
- 为什么报告绿油油的,却一条 trade 都没建成?

> ⚠ **这份文档存在的第二个理由**:上述原理大量散落在各 `.jmx` 的 XML 注释里,
> 而**在 GUI 里保存一次,JMeter 会重新序列化整棵树,所有 `<!-- -->` 注释全部丢失**。
> 落进 md 才存得住。

以 `create-trade` 单接口链路为例贯穿全文,其余链路同理。

---

## 目录

1. [一次请求的每个字节来自哪里](#1-一次请求的每个字节来自哪里)
2. [Fragment 这一层是被一个硬约束逼出来的](#2-fragment-这一层是被一个硬约束逼出来的)
3. [Include 在加载期展开](#3-include-在加载期展开)
4. [四种作用域](#4-四种作用域)
5. [属性合并:命令行顺序即优先级](#5-属性合并命令行顺序即优先级)
6. [一次运行的完整时间线](#6-一次运行的完整时间线)
7. [一次迭代内部的元件执行顺序](#7-一次迭代内部的元件执行顺序)
8. [三个 PreProcessor 的分工与顺序](#8-三个-preprocessor-的分工与顺序)
9. [作用域组合:一个 fragment 服务多个调用方](#9-作用域组合一个-fragment-服务多个调用方)
10. [一次迭代的变量状态推演](#10-一次迭代的变量状态推演)
11. [失败模式地图](#11-失败模式地图)
12. [读数陷阱](#12-读数陷阱)
13. [GUI 会破坏什么](#13-gui-会破坏什么)

---

## 1. 一次请求的每个字节来自哪里

这是 dev 环境的真实请求,每一部分标注来源:

```
POST http://10.198.25.56:9089/api/v1/trades/create
     ────┬─── ──────┬────── ─┬── ───────┬───────
         │          │        │          └─ 原子 fragment 写死
         │          │        │             ${__P(workers.basePath)}/trades/create
         │          │        └─ config/<env>.properties  workers.port
         │          └─ config/<env>.properties  workers.host
         └─ config/<env>.properties  workers.protocol

Headers:
  X-User-Id: maker@sc.com
      ← 线程组级 UDV effectiveUserId ← ${__P(makerUserId)} ← config/<env>.properties
  Content-Type: multipart/form-data; boundary=WtScfdAKxG8...
      ← JMeter 自己生成（DO_MULTIPART_POST=true）

Body:
  --WtScfdAKxG8...
  Content-Disposition: form-data; name="trade"

  {"basic":{"portfolioId":"ABS-HK-CFD-BDC","counterpartyFmId":"10052235",...}}
      ← build-trade-payload.groovy 产出 ${tradePayload}
        ← select-refdata.groovy 校验/写入 portfolioId 等三个变量
          ← CSV Data Set "csv: refdata pairs" ← data/refdata/refdata-pairs.csv

  --WtScfdAKxG8...
  Content-Disposition: form-data; name="datFile"; filename="fx_trf_01.dat"
  Content-Type: application/octet-stream
  <二进制>
      ← ${datDir}/${effectiveDatFile}
        ← resolve-dat-file.groovy
          ← CSV Data Set "csv: create-trade data" 的 datFile 列
```

**没有任何一段写死在单一位置。** 每段都来自一个可独立替换的源——
这是整套结构存在的理由,也是它初看复杂的原因。

### multipart 的两个开关(易错,勿改)

| 开关 | 值 | 作用 |
|---|---|---|
| `DO_MULTIPART_POST` | `true` | 让 **JMeter 生成** `Content-Type` 及其 boundary |
| `BROWSER_COMPATIBLE_MULTIPART` | `true` | 只给带 `filename` 的 part 写 `Content-Type` |

> ⚠ **绝不能在 Header Manager 里手写 `Content-Type`**——手写值不带 boundary,
> 且会覆盖生成值,服务端无法分段。

`BROWSER_COMPATIBLE_MULTIPART=false`(严格模式)会给 `trade` 这个普通字段
多加 `Content-Type: text/plain` 和 `Content-Transfer-Encoding: 8bit`,与真实 curl 不一致。

`trade` 是**普通表单字段**(curl 用 `-F 'trade={...}'`,不是 `-F 'trade=@file'`),
所以 `build-trade-payload.groovy` 不需要写临时文件,也就不需要
每线程文件管理和 tearDown 清目录。

---

## 2. Fragment 这一层是被一个硬约束逼出来的

JMeter 的 **Include Controller 只能引入 Test Fragment**。
在被引入的文件里放 Thread Group,它会被**静默丢弃**——
不报错、不警告,那部分永远不执行,报告显示 `0 samples`。

这一条约束直接反推出四层:

```
可运行层   jmx/api/p02-trade-create.jmx           有 Thread Group  →  能跑
           jmx/scenarios/s01-create-trade-e2e.jmx
              │  Include
              ▼
组合层     jmx/journeys/j01-create-trade.jmx      只有 Test Fragment  →  不能跑
           jmx/fragments/setup/csv-refdata-preflight.jmx
              │  Include
              ▼
原子层     jmx/fragments/steps/.../create-trade.jmx    一个 API 一个文件
              │  引用
              ▼
脚本层     groovy/*.groovy                        纯逻辑,不含 JMeter 结构
```

`scripts/run.sh` 里那段拒绝逻辑防的就是这个坑:

```bash
if find jmx/fragments jmx/journeys -name "$PLAN.jmx" | grep -q .; then
    echo "ERROR: '$PLAN' is a fragment/journey — it has no Thread Group..."
```

> **一个跑完了、绿色的、0 sample 的报告,比一个红色的错误难查十倍。**

### 收益只有一句话

**`create` 的请求契约只存在一份。**
`p02`(单接口)、`s01`(E2E)、`csv-refdata-preflight`(开跑前守卫)
三处都要发 create,Include 的是**同一个文件**。
后端给 payload 加一个必填字段,只改一处。

早期版本在 preflight 里复制过一份 sampler——契约有两份,
而**没有任何机制会提醒你第二份的存在**。校验规则 R2 就是为了让这种复制再进不来。

---

## 3. Include 在加载期展开

JMeter 读 jmx 时,`IncludeController` 去磁盘读被引入的文件,
把它的 Test Fragment 子树**原地嫁接**进主树。
**这一切发生在任何线程启动之前。**

```
加载前的树                      引擎实际执行的树
─────────────                  ─────────────────────
ThreadGroup                     ThreadGroup
└ IncludeController      ──►    └ TransactionController TX_workers_trademgmt_create
     (create-trade.jmx)            ├ PreProcessor  resolve dat file
                                   ├ PreProcessor  select refdata
                                   ├ PreProcessor  build trade payload
                                   ├ HTTPSampler   workers_trademgmt_create
                                   ├ Assertion     http 200
                                   ├ Assertion     business status + error class
                                   ├ PostProc      ext tradeId
                                   └ PostProc      ext taskId
```

### 三个后果

| 后果 | 原因 |
|---|---|
| **`includepath` 里不能用变量/函数** | 展开时线程还不存在,`${...}` 无从求值 |
| **`run.sh` 必须先 `cd` 到项目根** | 路径按**当前工作目录**解析。不 cd 就静默找不到 → 0 sample |
| **同一文件 Include 两次 = 两份互相独立的副本** | 是树上真的有两个元件,不是同一元件跑了两次 |

第三条正是报告里 `workers_trademgmt_create` **出现两次**的原因:

```
setUp Thread Group  →  Include create-trade.jmx   ← 副本 A（preflight）
主 Thread Group     →  Include create-trade.jmx   ← 副本 B（主循环）
```

两份副本不共享任何状态。**这不是 bug,不要"优化"掉**——
preflight 是静态 refdata 模式下唯一能证明 CSV 今天还能用的东西(见 §11)。

正确做法是**过滤**而非删除:按 `runPhase=setup` 剔除。
但 `runPhase` 只有通过 `-Jsample_variables` 才会成为 jtl 的列,
而那是 `run.sh` 注入的——**这是 GUI 出不了数的直接原因之一**(见 §12)。

---

## 4. 四种作用域

这是整个框架里唯一需要背下来的东西。

| 种类 | 谁写 | 存活范围 | 求值时机 | 脚本里怎么访问 |
|---|---|---|---|---|
| **Property** | `-q` 文件 / `-J` / `props.put()` | **JVM 全局,跨线程组** | 启动时 | `props` |
| **计划级 UDV** | TestPlan 下的 `Arguments` | 该线程 | **启动时一次** | `vars` |
| **线程组级 UDV** | Thread Group 下的 `Arguments` | 该线程 | **启动时一次** | `vars` |
| **Variable** | CSV Data Set / PostProcessor / `vars.put()` | 该线程,跨迭代保留 | 随时 | `vars` |

### 唯一需要记住的规则

> # `vars` 不能跨线程,`props` 可以。

**setUp Thread Group 与主 Thread Group 是不同的线程。**
setUp 想传给主循环任何东西,**只能走 `props`**。

这一条解释了代码里所有看起来随意的选择:

```groovy
// setUp 要告诉主循环"参考数据坏了" → 必须 props
props.put('refdataPoolError', "csv=${reason.join(' | ')}")

// 动态模式下 setUp 建的池要给主循环用 → 必须 props
def rawP = props.getProperty('perfPortfolios')

// 本次迭代用哪个 portfolio → 线程私有 → vars
vars.put('portfolioId', portfolios[pIdx] as String)
```

### 推论一:静态 CSV 方案的简化是结构性的

动态池模式需要:setUp 查 refdata → 塞进 `props` → 主线程从 `props` 挑
→ 两个全局 JSON + 一套选取策略 + 池空检查 + 快照归档。

CSV 模式下,**CSV Data Set 是配置元件,每个线程各自读**——
根本没有"传递"这个动作。`select-refdata.groovy` 在 csv 分支里退化成纯校验,
一个变量都不写。

> 这不是"少写了几行代码",是**少了一整个跨线程状态共享的问题类别**。

### 推论二:身份为什么从 groovy 降级成 UDV

`${__P(makerUserId,maker@sc.com)}` 写在线程组级 `Arguments` 里,
**在线程启动时求值一次,之后就是一个普通变量,不会每次迭代重算**。

全部线程组都是单一角色,身份在整个线程组生命周期内是常量——
per-iteration 计算**没有任何东西可算**。
于是正确性从"脚本逻辑对不对"变成了"配置填对没有",后者可以静态校验。

### ⚠ 陷阱:`props.getProperty()` 对非 String 返回 null

存 `ConcurrentLinkedQueue` 这类对象(`checker-task-pool-init.groovy` 就是)
**必须用 `props.get()`** 取。用错了不报错,只是拿到 `null`,
然后一路走进"池为空"分支——查半天以为是环境没数据。

---

## 5. 属性合并:命令行顺序即优先级

JMeter 把 `-q`(追加属性文件)和 `-J`(单条属性)放在**同一个循环里、按命令行出现顺序**处理。
**后者覆盖前者。**

`run.sh` 的顺序因此是刻意的:

```bash
jmeter -n -t "$PLAN_FILE" \
    -q "$ENV_FILE" \          # ① 环境
    -q "$PROFILE_FILE" \      # ② 负载模型（覆盖 ①）
    -JbaseDir=... \           # ③ 框架注入
    -Jsample_variables=... \
    "${EXTRA[@]}" \           # ④ 用户覆盖（最高优先级）
    -l "$JTL" -j "$LOG" -e -o "$REPORT_DIR"
```

> ⚠ **手敲命令时顺序写反会静默失效。**
> `jmeter -Jthreads=8 -q profiles/baseline.properties` 里,
> profile 的 `threads=1` **会覆盖掉 `-J`**,你以为跑了 8 线程,实际跑了 1 个。
> **`-J` 永远放在所有 `-q` 之后。**

另外 `bin/user.properties` 也参与合并(在 `-q`/`-J` 之前)。
本项目不使用它——**所有配置都必须在仓库里可见**,
否则"同一份脚本在你机器上和我机器上跑出不同结果"就无法解释。

---

## 6. 一次运行的完整时间线

以 `./scripts/run.sh p02-trade-create dev smoke` 为例:

```
┌─ Shell ────────────────────────────────────────────────────┐
│ 1. cd 到项目根                    ← 不做这步 Include 全断      │
│ 2. 定位 jmx/api/p02-trade-create.jmx；拒绝 fragment/journey  │
│ 3. 写 manifest（commit / 配置全文 / 覆盖参数 / 环境指纹）      │
│ 4. exec jmeter -n ...                                       │
└──────────────────────┬─────────────────────────────────────┘
                       ▼
┌─ JMeter 启动 ──────────────────────────────────────────────┐
│ 5. 属性合并（§5）                                            │
│ 6. 解析 jmx → 对象树                                         │
│ 7. **展开所有 Include Controller**（读盘、嫁接）              │
│    此后不再涉及磁盘 —— 运行中改 fragment 文件不会生效          │
└──────────────────────┬─────────────────────────────────────┘
                       ▼
┌─ setUp Thread Group（1 线程 1 轮，必须整体跑完）───────────┐
│ 8.  线程变量初始化                                           │
│       计划级 UDV: datDir, refdataSource=csv                 │
│       线程组级 UDV: runPhase=setup, effectiveUserId=maker@… │
│ 9.  迭代开始 → 两个计划级 CSV Data Set 各推进一行             │
│       ⚠ setUp 会消耗掉第一行（shareMode.all 是全局游标）      │
│ 10. JSR223Sampler  validate csv refdata  ← 本地检查，不发请求 │
│ 11. GenericController "preflight create"                     │
│       ├ 嫁接进来的 create 子树 → **真的建一笔 trade**          │
│       └ 外层挂 preflight-policy 断言（只在这一侧，§9）         │
└──────────────────────┬─────────────────────────────────────┘
                       ▼
┌─ 主 Thread Group（threads 个线程，rampUp 秒内启动）────────┐
│ 12. 每线程独立初始化 UDV: runPhase=main, effectiveUserId     │
│ 13. 循环 → 见 §7                                             │
│       scheduler=true + duration  → 到点停                    │
│       scheduler=false + loops=1  → 跑一轮（smoke）           │
└──────────────────────┬─────────────────────────────────────┘
                       ▼
┌─ 收尾 ─────────────────────────────────────────────────────┐
│ 14. 写 jtl（含 sample_variables 指定的业务列）                │
│ 15. -e -o 生成 HTML 报告                                     │
│ 16. run.sh 扫日志: PREFLIGHT FAILED? jtl 里有 ${...} 字面量?  │
└────────────────────────────────────────────────────────────┘
```

**setUp Thread Group 保证在主 Thread Group 之前整体跑完**——
这是 JMeter 的语义,不需要额外同步。

---

## 7. 一次迭代内部的元件执行顺序

JMeter 的顺序是**固定的、按元件类型的**,不是按你在树上写的先后:

```
0. 配置元件      CSV Data Set / HTTP Defaults / Header Manager
1. 前置处理器    PreProcessors
2. 定时器        Timers          ← p02 没有（单接口测试不加 think time）
3. 采样器        Sampler         ← 计时的起止点
4. 后置处理器    PostProcessors  ⚠ 在断言之前！
5. 断言          Assertions
6. 监听器        Listeners / 写 jtl
```

代入本项目:

| 序 | 元件 | 干什么 | 产出 |
|---|---|---|---|
| 0 | `csv: create-trade data` | 推进一行 | `caseId, datFile, productType, datSizeBytes, …` |
| 0 | `csv: refdata pairs` | 推进一行 | `pairId, portfolioId, counterpartyFmId, …` |
| 1 | PreProc `resolve dat file` | 定哪个 .dat | `effectiveDatFile` |
| 1 | PreProc `select refdata` | 三源收敛 + 校验 | csv 模式下只校验 |
| 1 | PreProc `build trade payload` | 拼 JSON | `tradePayload`, `tradeReference` |
| 3 | **Sampler** | 组装 multipart 并发出 | **计时从这里开始/结束** |
| 4 | PostProc `ext tradeId` | JSONPath `$.data.trade.id` | `tradeId` / `NOT_FOUND` |
| 4 | PostProc `ext taskId` | 正则 `TaskId:\s*(CHK-[A-Za-z0-9]+)` | `taskId` / `NOT_FOUND` |
| 5 | Assertion `http 200` | HTTP 层 | 标红/绿 |
| 5 | Assertion `business status` | 业务层 + 分类 | **`errClass`** |
| 6 | 写 jtl | 快照当前 vars 到额外列 | `errClass` 已就位 ✓ |

### ⚠ 后置处理器在断言**之前**跑

很多人记反。这里正好利用了这个顺序:

```groovy
// assert-create-response.groovy —— 能校验提取器的产出，
// 是因为提取器已经跑完了
if (!(tradeId ==~ /^TRD-\d+$/)) {
    vars.put('errClass', 'script')
```

**校验格式而不只是非空**:提取器失败时的默认值 `NOT_FOUND` 也是非空字符串,
会被"非空"这种弱断言放过去。

### CSV Data Set 按**线程组迭代**推进,不是按 sampler

一次迭代内所有 sampler 看到的是同一行。
p02 主循环一次迭代只有一个 sampler,所以**一行 = 一笔 create**。

> ⚠ **耦合陷阱**:两个 CSV 都是 `shareMode.all`,各自推进一行。
> **行数相同时组合会被锁死**——N 行 × N 行只跑到 N 种,而不是 N²。
> 把行数取成互质(如 refdata 5 行、产品 3 行)即可打散。

### `cacheKey=true` 不是装饰

每个 JSR223 元件都有这一行,它让 Groovy **编译一次、缓存复用**。

不设的话,20 线程 × 300 秒 × 3 个 PreProcessor = 上万次 Groovy 编译,
全烧在压测机 CPU 上。**你会以为被测系统慢,其实是压力机在编译脚本。**

同理,脚本走 `filename` 而非内联 `script`:能进 git、能 diff、能被多处共用。

### `datSizeBytes` 里的 `AUTO` 不是运行时占位符

JMeter 不认识它。那是给 `scripts/index-dat.py --write` 看的标记,
**离线**用实测字节数替换。跑测试时那一列已经是数字。

> 把体积从"可以随便填的标签"变成"必须实测的数字"——**手写不了,就编不出来。**

---

## 8. 三个 PreProcessor 的分工与顺序

依赖关系只有**一条硬约束**:

```
resolve-dat-file  ──┐
                    ├──►  互相独立，谁先谁后都行
select-refdata  ────┘
        │
        │ 写 portfolioId / counterpartyFmId / counterpartyName
        ▼
build-trade-payload            ← 必须在 select-refdata 之后
        │
        │ 写 tradePayload
        ▼
     Sampler                   ← ${tradePayload} 在这里被求值
```

**同层 PreProcessor 按树上的书写顺序执行**,所以顺序是可控的。

那为什么不合成一个脚本?因为每个在解决一个**独立的、会独立变化**的问题。

### `resolve-dat-file` —— 收敛"不同调用方来源不同"

```groovy
if (fromCsv && fromCsv.trim() && !fromCsv.startsWith('${')) { ... }
```

注意 `!fromCsv.startsWith('${')`:

> **JMeter 对解析不掉的 `${var}` 不报错,直接把字面量当值用。**

CSV 路径写错、列名对不上时,`vars.get('datFile')` 返回字符串 `"${datFile}"`,
然后拿它去拼文件路径。这类"成功地做错事"的失败必须自己抓。

也是不把判断写进 `File.path` 的 `${}` 表达式的理由:
出错时报"文件不存在",**与真的缺文件无法区分**。

### `select-refdata` —— 三个来源的收敛点

```groovy
if (vars.get('refdataBound') == 'true') return       // ① E2E 已现场查好
def source = vars.get('refdataSource') ?: props.getProperty('refdataSource') ?: 'pool'
if (source == 'csv') { /* 只校验，不覆盖 */ return }  // ② CSV 供数（p02）
// ③ 从 setUp 建的全局池里挑（动态模式）
```

下游 `build-trade-payload` **只认 `vars.portfolioId`,不关心它从哪来**。
加第四种来源只加一个分支,`create-trade.jmx` 一行都不用改——
这就是把"选数"独立成 PreProcessor 而不是写进 `build-trade-payload` 的全部理由。

动态模式下用 `ctx.getThreadNum()` 而非随机数取模,是为了**可复现**:
同一份 profile 跑两次,线程 N 拿到的永远是同一个 portfolio。
随机数会让"这次慢是因为数据不同还是系统不同"无法回答。

### `build-trade-payload` —— 只负责序列化

```groovy
import groovy.json.JsonOutput
vars.put('tradePayload', JsonOutput.toJson(trade))
```

用 `JsonOutput` 而非字符串拼接:真实 counterparty 名字里有 `*`
(`PRINTINGINT10LTD*HKG`),还可能出现引号、反斜杠、非 ASCII。

> 手拼字符串迟早拼出非法 JSON,而那种失败表现为"**某些行偶发 400**"
> ——压测里最难定位的一类。

`tradeReference`(`PERF-<caseId>-<线程号>-<迭代号>`)**只存在于结果文件**,
未写入被测系统——payload 目前不接受额外字段。
这正是清理策略只能靠"专用 PERF Portfolio + 状态 + 时间窗口"三者交集兜底的原因。

---

## 9. 作用域组合:一个 fragment 服务多个调用方

**JMeter 的断言/处理器按树层级生效,不按书写顺序。**
挂在某个控制器上,就对该控制器下的**所有** sampler 生效。

```
setUp Thread Group                        主 Thread Group
├ Arguments runPhase=setup                ├ Arguments runPhase=main
└ [csv-refdata-preflight 展开]            └ [create-trade 展开]
   ├ JSR223Sampler validate csv refdata      └ TX_workers_trademgmt_create
   └ GenericController "preflight create"       └ HTTPSampler
      ├ [create-trade 展开] ← 同一个文件          ├ 3 个 PreProcessor
      │  └ TX_...                                ├ 2 个 Assertion
      │     └ HTTPSampler                        └ 2 个 PostProcessor
      │        ├ 3 个 PreProcessor
      │        ├ 2 个 Assertion
      │        └ 2 个 PostProcessor
      └ JSR223Assertion preflight policy  ◄── 只在这一侧
         （挂在 GenericController 上，
           作用于其下所有 sampler）
```

### 那个空壳 `GenericController` 是一道作用域围栏

去掉它,`preflight-policy` 会挂到 setUp 线程组层级——**现在照样能用**。
但如果哪天 preflight 要加第二个 sampler(比如先查一下 portfolio 是否还在),
那个断言会**连带作用到新 sampler 上**,而它的逻辑只对 create 的响应成立。

> **用一个空壳控制器把作用域圈起来,是 JMeter 里表达"这条策略只属于这一步"的唯一方式。**

### 由此得到一条可复用的规则

| 放哪 | 放什么 | 判据 |
|---|---|---|
| **原子 fragment 内** | 请求构造、HTTP 断言、业务断言、提取器 | **每个调用方都需要** |
| **调用方 Include 的外层** | 中止策略、额外校验、调用方特有断言 | **只有这个调用方需要** |

于是加一个调用方,**永远不需要改被调用的文件**。

### `TransactionController` 的两个开关

```xml
<boolProp name="TransactionController.parent">false</boolProp>
<boolProp name="TransactionController.includeTimers">false</boolProp>
```

- `parent=false` —— 事务行**不吞掉**子采样行,两者都进 jtl(见 §12)
- `includeTimers=false` —— **think time 不计入事务耗时**。
  为 `true` 时报告里的事务会被 think time 撑大,
  那个数字既不是服务端能力也不是用户感受,**没有意义**

---

## 10. 一次迭代的变量状态推演

主循环第 1 次迭代(线程 0):

```
线程启动
  vars = { datDir: "/path/data/dat",  refdataSource: "csv",
           runPhase: "main",          effectiveUserId: "maker@sc.com" }
                                      ↑ 这四个在整个线程生命周期内是常量

迭代 1 开始 —— 两个 CSV Data Set 各推进一行
  += { caseId:"C001", datFile:"products/FX_TRF/fx_trf_01.dat",
       productType:"FX_TRF", costTier:"typical", fixings:"1",
       datSizeBytes:"48213", notionalCurrency:"" }
  += { pairId:"R001", portfolioId:"ABS-HK-CFD-BDC",
       counterpartyFmId:"10052235", counterpartyName:"UNIVERSAL WEST",
       refdataNote:"…" }

PreProc resolve-dat-file
  += { effectiveDatFile: "products/FX_TRF/fx_trf_01.dat" }

PreProc select-refdata
  refdataSource=csv → 检查三个字段非空、非 ${ → 全通过 → return
  （什么都不写）

PreProc build-trade-payload
  += { tradePayload: '{"basic":{"portfolioId":"ABS-HK-CFD-BDC",…}}' }
  += { tradeReference: "PERF-C001-0-1" }
                            ↑caseId ↑线程号 ↑迭代号

Sampler  ── 计时开始 ──
  File.path = ${datDir}/${effectiveDatFile}  → 读盘、组 multipart、发出
  ── 计时结束 ── elapsed = 本次采样的响应时间

PostProc ext tradeId   += { tradeId: "TRD-100234" }
PostProc ext taskId    += { taskId:  "CHK-98C0DF19" }

Assertion http 200          → pass
Assertion business status   += { errClass: "ok" }

写 jtl —— 两行:
  workers_trademgmt_create     elapsed=… runPhase=main caseId=C001 errClass=ok …
  TX_workers_trademgmt_create  elapsed=… runPhase=main caseId=C001 errClass=ok …
                                          ↑ sample_variables 指定的额外列
```

`sample_variables` 的快照在**断言之后**取,所以 `errClass` 一定进得去。

---

## 11. 失败模式地图

这套东西看起来防御过度,但每一道对应一个**真实存在、且报告上看不出来**的失败:

| 守卫 | 在哪 | 防的失败 | 不防会怎样 |
|---|---|---|---|
| `run.sh` 拒绝跑 fragment | shell | 跑了个没有 Thread Group 的文件 | **绿色的 0-sample 报告** |
| `run.sh` `cd` 到项目根 | shell | Include 路径解析失败 | 同上 |
| `validate-csv-refdata` | setUp | CSV 里还是 `TBC` 占位值 | **错误率 100% 的报告** |
| **preflight create** | setUp | CSV 值今天已失效 | 错误率升高,**被误读成性能问题** |
| `select-refdata` 判 `${` 开头 | 每次迭代 | CSV 路径/列名写错 | 请求带 `${portfolioId}` 字面量发出去 |
| `resolve-dat-file` 判 `${` 开头 | 每次迭代 | 同上 | 拼出不存在的文件路径 |
| `ResponseAssertion http 200` | 每次迭代 | 5xx / 超时 | — |
| **`assert-create-response`** | 每次迭代 | **HTTP 200 但业务拒绝** | **错误率 0%,却一笔都没建成** |
| `errClass` 三分类 | 每次迭代 | 三类错误混成一个数 | "12% 错误率"——找开发还是修数据? |
| `run.sh` 扫 jtl 里的 `${` | shell | 变量没定义 | 静默业务拒绝 |
| `scripts/validate.py` | 提交前 | 结构性错误(R1–R4) | 跑起来才发现 |
| `scripts/index-dat.py` | 提交前 | .dat 与 CSV 对不上 | 报告标的产品类型是错的 |

### 为什么业务断言不可省

> **这个接口业务失败时照样返回 HTTP 200,业务状态藏在 body 的 `code` / `status` 里。**

```groovy
if (json.code != 200 || json.status != 'PENDING APPROVAL') {
    vars.put('errClass', 'business')
```

只看状态码的报告会显示"错误率 0%",而实际一条 trade 都没建成——
**这是本项目最容易产出误导性报告的地方。**

### 三类错误必须分开,因为处置方式完全不同

| `errClass` | 含义 | 该找谁 |
|---|---|---|
| `technical` | 连接失败 / 超时 / 5xx | **系统扛不住 —— 这才是性能结论** |
| `business` | HTTP 200 但业务拒绝 | 多半是测试数据失效,**不是性能问题** |
| `script` | 提取器拿不到值 / 解析异常 | 脚本 bug,**整轮结果作废** |
| `ok` | 成功 | — |

OREO 特有的第四种:`lockedRejection`——四眼原则下同一笔 trade 被并发 claim,
**这是正确行为**,但会污染容量结论,所以要单独计数而不是算作错误。

### 静态化之后 preflight 反而更重要

动态模式下失效数据在 setUp 查询时**当场暴露**。
静态模式没有那次查询——CSV 里的 id 若已失效(counterparty 被第三方停用、
portfolio 被归档),请求照发,服务端返回业务拒绝。

> **报告里表现为"错误率升高"而不是"启动失败",会被误读成性能问题。**

所以 preflight 不是可选加固,是静态模式**唯一**的数据有效性证明。
一行 CSV 证明不了任何事,只有真发一笔 create 才行。

### 两道守卫的分工(别合并)

| | 查什么 | 怎么查 | 防什么 |
|---|---|---|---|
| `validate-csv-refdata` | CSV **填了没** | 纯本地,不发请求 | script 错误 |
| `preflight create` | 填的值**今天还能用吗** | 必须真发一笔 | 数据失效 |

前者过不了,后者跑了也没意义——所以前者失败直接 `stopTest()`,
不走 `preflightPolicy` 的 warn/abort 分支:占位值会让**每一笔**都失败,
没有"部分可用"可言。

### `validate-csv-refdata` 为什么是 Sampler 而不是 PreProcessor

它需要在报告里**产生一行可见的记录**,并能用一个独立的响应码
(`CSV_REFDATA_INVALID`)说明失败原因。PreProcessor 不产生 sample。

> **一道会静默失败的守卫,比没有守卫更危险。**

---

## 12. 读数陷阱

### ① TX 行是额外产生的,不能与采样器行相加

`TransactionController.parent=false` 意味着事务行**不吞掉**子采样行,两者都进 jtl。

```
workers_trademgmt_create      ← 采样器行
TX_workers_trademgmt_create   ← 事务行（额外的）
```

> **算 TPS 只能用采样器行,或只能用 TX 行,绝不能用两者之和**——吞吐量会凭空翻倍。
> HTML 报告的 `Total` 行同样包含两者。

### ② setUp 的 preflight 会混进统计

两次执行**标签完全相同**(§3),按标签聚合时分不开。
而它恰好是全场最慢的一笔:JIT 冷启动 + TCP 首次建连 + 服务端懒加载,
**会顶高 `Max`,样本量小时还污染 P99**。

过滤方式:jtl 里按 `runPhase=setup` 剔除。

```bash
awk -F, 'NR==1 || $0 !~ /,setup,/' result.jtl > main-only.jtl
```

> ⚠ **`runPhase` 只有通过 `-Jsample_variables` 才成为 jtl 的列**,
> 而那是 `run.sh` 注入的。**GUI 里没有这一列,因此无法剔除。**

### ③ 样本量下限

低吞吐系统最容易踩的坑:

```
样本数 = 线程数 × 时长 ÷ 单笔耗时
```

| 单笔耗时 | 1 线程 300s 的样本数 | P95 可信吗 |
|---|---|---|
| 2s | 150 | 勉强 |
| 20s | **15** | **完全没意义** |

**下限 100,300 以上才踏实。** 拿一个数字之前先问"这是几个样本算出来的"。

### ④ ramp-up 窗口稀释均值

爬坡期并发从 1 涨到 N,这段的响应时间不代表任何稳态。
HTML 报告的 over-time 曲线能看出边界;GUI 的 Aggregate Report 不能。

---

## 13. GUI 会破坏什么

### ⚠ 唯一一个属性驱动的布尔字段

```xml
<stringProp name="ThreadGroup.scheduler">${__P(scheduler,true)}</stringProp>
```

**GUI 保存时会把它重新序列化成 `boolProp`**,属性引用被写死。
后果:`smoke`(本该跑 1 轮)变成跑满 `duration` 秒。

这是全项目唯一一个 GUI 保存会静默破坏的字段。同类技巧还有:

```xml
<stringProp name="LoopController.loops">${__P(loops,-1)}</stringProp>
```

Loop Count 不勾 "Infinite",直接填 `${__P(loops,-1)}`——
`-1` 在运行时仍表示无限,但现在可被 profile 覆盖。

### XML 注释会全部丢失

GUI 保存时 JMeter 从对象树**重新序列化整个文件**,所有 `<!-- -->` 消失。

元件的 `Comments` 字段(`TestElement.comments`)会保留——
需要长期留在 jmx 里的说明应该写在那里,而不是 XML 注释里。

**结论:GUI 用来看请求体、调断言;改配置改 `.properties` 或用 `-J`;不要保存。**

### 带配置启动 GUI

```bat
jmeter -q config\dev.properties -q profiles\baseline.properties -JbaseDir=%CD%
```

`-q` / `-J` 在 GUI 模式下同样生效。
**不带 `-q` 启动的 GUI,跑的是一套你从没配置过的默认参数。**

---

## 附:改动影响面速查

| 改了什么 | 影响 |
|---|---|
| `config/*.properties` | 换环境,脚本不动 |
| `profiles/*.properties` | 换负载模型,脚本不动 |
| `data/**/*.csv` | 换数据,脚本不动 |
| `groovy/<某个>.groovy` | 只影响挂载了它的 fragment |
| `jmx/fragments/steps/.../<某个>.jmx` | **所有 Include 它的计划同时生效** |
| `jmx/api/*.jmx`、`jmx/scenarios/*.jmx` | 只影响该计划 |

**三个维度正交:环境 × 负载 × 计划。**
`run.sh` 的三个参数就是这三个维度,任何一个都能独立替换而不碰其余两个。
