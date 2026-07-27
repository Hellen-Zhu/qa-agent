# 练手：从零重建一遍

六个练习，累计约 4 小时。**在新目录里做，不要在现有工程里改**——
练习的价值一半来自"故意犯错"，那些错不该出现在真工程的 git 历史里。

```bash
mkdir -p ~/oreo-perf-practice && cd ~/oreo-perf-practice
```

字段级细节不重复写，需要时跳到 [`HANDBOOK-BUILD.zh.md`](HANDBOOK-BUILD.zh.md) 对应小节。

## 怎么用这份文档

每个练习三段：

- **【这一练在解决什么】** —— 不看这段就只是抄文件
- **【验收】** —— 过了再往下，不要攒着一起调
- **【故意犯错】** —— **最重要的部分**

那些"故意犯错"全是 JMeter **不报错**的失败模式。让它们在受控环境里发生一次，
以后在真工程里遇到，你会在三十秒内认出来，而不是排查半天。

| 练习 | 内容 | 约时 |
|---|---|---|
| 0 | 骨架 + 最小 run.sh | 20 min |
| 1 | 一个 GET 跑通（Test Fragment + Include） | 40 min |
| 2 | 第二个端点 + 组合层（作用域） | 40 min |
| 3 | 变量三兄弟 + 第一个 groovy | 50 min |
| 4 | setUp Thread Group + 跨线程组传数据 | 40 min |
| 5 | create-trade（multipart + 两层断言） | 60 min |
| 6 | 装上 validate.py，故意违规 | 30 min |

> **顺序不能换。** 练习 5 的 create-trade 是最复杂的一个（multipart + 3 个 groovy +
> 2 层断言 + 2 个提取器 + CSV + setUp）。从它开始，你会同时排查五类问题，
> 分不清哪个是哪个。从最简单的 `GET /refdata/portfolios` 开始，每次只多一个新概念。

---

# 练习 0 · 骨架（20 min）

## 【这一练在解决什么】

先让 `run.sh` 能跑起来并正确报错。**一个连"找不到 plan"都报不清楚的入口脚本，
后面每次失败你都要先怀疑是不是它的问题。**

## 做什么

### ① 目录

```bash
mkdir -p jmx/fragments/steps/refdata \
         jmx/fragments/steps/workers/trade-management \
         jmx/fragments/steps/_composites \
         jmx/fragments/setup \
         jmx/api jmx/scenarios jmx/journeys \
         groovy config profiles scripts \
         data/refdata data/create-trade data/shared data/dat/small \
         results
```

### ② `config/dev.properties`

先只写 refdata 一个服务——**用到哪个加哪个**，不要一次铺五个。

```properties
refdata.protocol=http
refdata.host=<填真实 host>
refdata.port=8080
refdata.basePath=/api/v1
refdataPageSize=200

connectTimeout=5000
responseTimeout=60000
```

### ③ `profiles/smoke.properties`

```properties
threads=1
rampUp=1
duration=0
loops=1
scheduler=false
```

> **两个文件的分工是一条纪律，不是习惯。**
> `config/` 只描述"打哪个环境"，`profiles/` 只描述"施加多大压力"。
> 一旦 host 混进 profile，你就再也无法说"这两轮只差线程数"——
> 而"每次只改一个变量"是压测结论能成立的前提。

### ④ `scripts/run.sh`

先写最小版,后面几练再逐步加东西。

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"          # ← 不可删，见【故意犯错 1-B】

[[ $# -lt 3 ]] && { echo "usage: $0 <plan> <env> <profile> [-Jk=v ...]" >&2; exit 1; }
PLAN="$1"; ENV="$2"; PROFILE="$3"; shift 3

PLAN_FILE=""
for d in jmx/scenarios jmx/api; do
    [[ -f "$d/$PLAN.jmx" ]] && { PLAN_FILE="$d/$PLAN.jmx"; break; }
done
[[ -z "$PLAN_FILE" ]] && { echo "ERROR: plan '$PLAN' not found" >&2; exit 2; }

RUN_DIR="results/${PLAN}_${ENV}_${PROFILE}_$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN_DIR"

jmeter -n -t "$PLAN_FILE" \
    -q "config/$ENV.properties" \
    -q "profiles/$PROFILE.properties" \
    -JbaseDir="$PROJECT_ROOT" \
    "$@" \
    -l "$RUN_DIR/result.jtl" \
    -j "$RUN_DIR/jmeter.log"

echo "jtl: $RUN_DIR/result.jtl"
```

```bash
chmod +x scripts/run.sh
```

> `-q` 可重复,**后指定的覆盖先指定的**：config → profile → 命令行 `-J`。
> 这就是三维正交（计划 × 环境 × 负载）的全部机制,没有别的魔法。

## 【验收】

```bash
./scripts/run.sh                    # → usage
./scripts/run.sh nope dev smoke     # → ERROR: plan 'nope' not found
```

---

# 练习 1 · 一个 GET 跑通（40 min）

## 【这一练在解决什么】

**Test Fragment 与 Include 的配合。** 这是整套四层架构的地基——
搞懂这一步，后面五练都是它的重复。

先做 [`HANDBOOK-BUILD.zh.md` §3 五分钟连通性验证](HANDBOOK-BUILD.zh.md)，
拿到 200 再往下。**别跳过。**

## 做什么

### ① 原子 fragment

GUI 建，参照 [§4](HANDBOOK-BUILD.zh.md)：

```
Test Plan  (Comments: Atomic fragment. Never run directly.)
└── Test Fragment            "refdata.portfolios.list"
    └── Transaction Controller  "TX_refdata_portfolios_list"
        └── HTTP Request        "refdata_portfolios_list"
            └── Response Assertion  (Response Code Equals 200)
```

HTTP Request 关键字段：

| 字段 | 值 |
|---|---|
| Protocol | `${__P(refdata.protocol,http)}` |
| Server Name or IP | `${__P(refdata.host,localhost)}` |
| Port Number | `${__P(refdata.port,8080)}` |
| Method | `GET` |
| Path | `${__P(refdata.basePath,/api/v1)}/refdata/portfolios?status=ACTIVE&size=${__P(refdataPageSize,200)}` |

存到 `jmx/fragments/steps/refdata/portfolios-list.jmx`。

> **没有 Thread Group**——这是本练习的全部重点。

### ② 可运行 plan

`File → New`，参照 [§6](HANDBOOK-BUILD.zh.md)：

```
Test Plan  "p01-refdata-portfolios"
├── HTTP Request Defaults    (只填两个 timeout，host 三项留空)
└── Thread Group  "TG: portfolios"
    │   Number of Threads  ${__P(threads,1)}
    │   Ramp-up            ${__P(rampUp,1)}
    │   Loop Count         ${__P(loops,-1)}   ← Infinite 不勾
    │   ☑ Specify Thread lifetime,  Duration ${__P(duration,60)}
    └── Include Controller
            Filename: jmx/fragments/steps/refdata/portfolios-list.jmx
```

存到 `jmx/api/p01-refdata-portfolios.jmx`。

**存完立刻用文本编辑器改一处**（[§0 第二条](HANDBOOK-BUILD.zh.md)）：

```diff
- <boolProp   name="ThreadGroup.scheduler">true</boolProp>
+ <stringProp name="ThreadGroup.scheduler">${__P(scheduler,true)}</stringProp>
```

### ③ 跑

```bash
./scripts/run.sh p01-refdata-portfolios dev smoke
```

## 【验收】

```bash
cat results/*/result.jtl
```

应该是 **3 行**：

```
timeStamp,elapsed,label,responseCode,...          ← 表头
...,refdata_portfolios_list,200,...              ← sampler 本身
...,TX_refdata_portfolios_list,200,...           ← 事务
```

> ### 为什么一个请求出两行
>
> Transaction Controller 的 `Generate parent sample` 不勾时，
> 它会**额外**产生一个以事务名命名的样本，代表整段耗时。
>
> 这直接推出一条口径纪律：**算 TPS 时事务行和 sampler 行二选一，绝不可相加**，
> 否则同一次工作被计两次。组合层的 `TX_flow_*` 与原子层的 `TX_<svc>_*` 同理。
> （详见 [KPI Definitions §2.7](../docs/performance/kpi-definitions.zh.md)）

## 【故意犯错】

### 1-A：把 Test Fragment 换成 Thread Group

GUI 打开 `portfolios-list.jmx`，把 Test Fragment 换成 Thread Group（其它不动），保存，重跑。

**观察**：样本消失或数量不对，而 `jmeter.log` 里**没有一条 ERROR**。

具体行为不必记，要记的是：**它不报错**。这就是"跑完 0 sample"这个症状的头号原因。
改回来再跑一次确认恢复。

### 1-B：换个目录跑

```bash
cd /tmp
jmeter -n -t ~/oreo-perf-practice/jmx/api/p01-refdata-portfolios.jmx -l /tmp/x.jtl
cat /tmp/x.jtl
```

**观察**：又是 0 sample。Include Controller 的 `Filename` **不支持变量**，
按**当前工作目录**解析。这就是 `run.sh` 里那行 `cd` 不能删的原因。

### 1-C：把 domain 三行删掉

删掉 fragment 里的 Protocol / Server Name / Port，重跑。

**观察**：请求打到了 `localhost`（或直接连接失败）。
现在只有一个服务所以很明显；等到有 5 个服务、而 HTTP Request Defaults 里
设了个全局 host 时——**请求会成功，只是打错了服务**，报告里完全看不出来。

这就是规则 R3 存在的理由，也是本项目的 Defaults 里刻意不填 host 的理由。

---

# 练习 2 · 组合层与作用域（40 min）

## 【这一练在解决什么】

**JMeter 的作用域规则**——前后置处理器按**树的层级**作用，不按书写顺序。
这是最容易写出"静默错误"的地方。

## 做什么

### ① 第二个原子 fragment

照练习 1 再建一个 `counterparties-list.jmx`（`GET /refdata/counterparties`），
TX 名 `TX_refdata_counterparties_list`。**十分钟的重复劳动，但它是练习 6 的伏笔。**

### ② 组合 fragment

```
Test Plan
└── Test Fragment  "refdata-load"
    └── Transaction Controller  "TX_flow_refdata_load"
        ├── Simple Controller  "portfolios"
        │   ├── Include Controller → steps/refdata/portfolios-list.jmx
        │   └── JSR223 PostProcessor → groovy/pick-portfolio.groovy
        └── Simple Controller  "counterparties"
            ├── Include Controller → steps/refdata/counterparties-list.jmx
            └── JSR223 PostProcessor → groovy/pick-counterparty.groovy
```

存到 `jmx/fragments/steps/_composites/refdata-load.jmx`。

groovy 先放占位内容，练习 3 再写实的：

```groovy
// groovy/pick-portfolio.groovy
log.info("portfolios response length = ${prev.getResponseDataAsString().length()}")
```

### ③ 改 p01 指向组合层

把 p01 的 Include 改成 `jmx/fragments/steps/_composites/refdata-load.jmx`，重跑。

## 【验收】

jtl 里应该有 **5 行**：表头 + 2 个 sampler + 2 个原子 TX + 1 个 `TX_flow_refdata_load`……
数一下,自己解释为什么是这个数。

## 【故意犯错】

### 2-A：把 PostProcessor 提到 TX 层

删掉两个 Simple Controller，把两个 PostProcessor 直接挂在 `TX_flow_refdata_load` 下，重跑。

**观察** `jmeter.log`：`pick-portfolio.groovy` 打了 **4 次** log（2 个 sampler × 2 个脚本），
其中两次解析的是 counterparties 的响应。

真实脚本里，这会导致 portfolio 提取器去 counterparties 的响应里找 `id`，
**拿不到，静默写入 `NOT_FOUND`**，请求照发，服务端业务拒绝。
报告里表现为错误率升高——你会去查性能，而问题在作用域。

改回来。**这个 Simple Controller 不是装饰。**

---

# 练习 3 · 变量三兄弟 + 第一个 groovy（50 min）

## 【这一练在解决什么】

JMeter 里有三种"变量"，作用域完全不同。混用是新手最大的坑：

| | 元件 | 作用域 | 写法 | 何时用 |
|---|---|---|---|---|
| **属性** | `-J` / `-q` 文件 | **JVM 全局**，跨线程组 | `${__P(name,默认)}` | 环境、负载参数、跨线程组传数据 |
| **UDV** | User Defined Variables | 计划级，**只读** | `${name}` | 本计划的常量、模式声明 |
| **变量** | CSV Data Set / 提取器 / `vars.put` | **每线程独立** | `${name}` | 本次迭代的数据 |

> **`props` 是跨线程组的唯一通道。** setUp Thread Group 和主 Thread Group 是不同线程,
> setUp 写进 `vars` 的东西主线程**一个都读不到**。这条在练习 4 会亲眼看到。

## 做什么

### ① 加 UDV 和 CSV Data Set

在 p01 的 Test Plan 下加（[§6.2 / §6.6](HANDBOOK-BUILD.zh.md)）：

- **User Defined Variables**：`datDir` = `${__P(baseDir,.)}/data/dat`
- **CSV Data Set Config**：
  - Filename `${__P(baseDir,.)}/data/shared/accounts.csv`
  - Variable Names `userId,userRole,userNote`
  - Sharing mode `All threads`

`data/shared/accounts.csv`：

```csv
userId,role,note
maker@sc.com,MAKER,来自真实 curl
maker02@sc.com,MAKER,待创建
```

### ② 写第一个真 groovy

把 `groovy/pick-portfolio.groovy` 换成实的。**这段留给你写**——
它有一个真实的取舍，不是模板代码：

```groovy
/*
 * pick-portfolio.groovy
 * 挂载点：_composites/refdata-load.jmx → "portfolios" Simple Controller 下的 PostProcessor
 * 职责：从响应里挑一条 portfolio id，写进 vars.portfolioId
 */
import groovy.json.JsonSlurper

def list
try {
    list = new JsonSlurper().parseText(prev.getResponseDataAsString())?.data
} catch (Exception e) {
    log.error("refdata/portfolios response is not JSON — ${e.message}")
    vars.put('portfolioId', 'NOT_FOUND')
    return
}
if (!list) {
    log.error('refdata/portfolios returned no rows')
    vars.put('portfolioId', 'NOT_FOUND')
    return
}

// TODO ── 你来写这 3~4 行 ──
// 从 list 里挑一条，把它的 id 写进 vars.portfolioId。
//
// 挑法有两种，选哪种取决于这个脚本服务于什么用例：
//
//   随机           ThreadLocalRandom.current().nextInt(list.size())
//                  → 贴近真实分布。E2E 场景要的是这个。
//
//   线程号取模      ctx.getThreadNum() % list.size()
//                  → 可复现。同一 profile 跑两次，线程 N 永远拿到同一条，
//                    两次结果可直接对比。
//
// 关键问题：如果用随机，某一轮 P95 变差了，你怎么回答
// "这次慢是因为系统变了，还是因为碰巧抽到了不同的数据"？
// 反过来，如果用取模，你测的分布和生产真实分布一致吗？
//
// 本项目现在两种都在用（pick 用随机、select-refdata 用取模），
// 因为它们服务的用例目标相反。你先选一种，并在注释里写下理由。
```

**写完在文件头注释里留一句为什么。** 三个月后你自己会来问这个问题。

### ③ 把变量送进 jtl

`run.sh` 的 jmeter 命令里加一行：

```bash
    -Jsample_variables=portfolioId,userId \
```

## 【验收】

```bash
head -1 results/*/result.jtl        # 表头末尾应出现 portfolioId,userId
grep -c 'NOT_FOUND' results/*/result.jtl   # 应为 0
```

## 【故意犯错】

### 3-A：CSV 列名写错

把 Variable Names 改成 `user_id,userRole,userNote`（下划线），重跑。

**观察**：jtl 里 `userId` 那列是空的，**但没有任何错误**。
如果这个变量被用在 header 或 payload 里，发出去的会是字面量 `${userId}`——
服务端返回业务拒绝，报告里是"错误率升高"。

真 `run.sh` 里那段扫 `${` 的检查就是为这个加的:

```bash
if [[ -f "$JTL" ]] && grep -q '\${' "$JTL" 2>/dev/null; then
    echo "⚠ jtl 中出现未解析的 \${...} 字面量"
    grep -o '\${[A-Za-z0-9_]*}' "$JTL" | sort -u | head -10
fi
```

现在把它加进你的 `run.sh`。

---

# 练习 4 · setUp Thread Group（40 min）

## 【这一练在解决什么】

**`props` 与 `vars` 的边界**，以及 `runPhase` 这个标记为什么不能省。

## 做什么

### ① 加 setUp Thread Group

在 p01 里加（[§6.7](HANDBOOK-BUILD.zh.md)），1 线程 1 轮：

```
setUp Thread Group  "setUp: refdata pool"
├── User Defined Variables   runPhase = setup
└── Include Controller → jmx/fragments/steps/_composites/refdata-load.jmx
```

主 Thread Group 下也加一个 UDV：`runPhase` = `main`。

`run.sh` 的 `sample_variables` 加上 `runPhase`。

### ② 建池：写 props

新建 `groovy/pool-portfolios.groovy`，挂在 setUp 那份 Include 的 Simple Controller 下：

```groovy
import groovy.json.JsonOutput
import groovy.json.JsonSlurper

def data = new JsonSlurper().parseText(prev.getResponseDataAsString())?.data
def list = (data ?: []).collect { it.id as String }.findAll { it && it != 'null' }

props.put('perfPortfolios', JsonOutput.toJson(list))
log.info("pool resolved: ${list.size()} portfolios")
```

### ③ 主循环读池

在主 Thread Group 的 sampler 上挂一个 PreProcessor：

```groovy
import groovy.json.JsonSlurper
def raw = props.getProperty('perfPortfolios')
log.info("main thread sees pool: ${raw == null ? 'NULL' : new JsonSlurper().parseText(raw).size()}")
```

## 【验收】

```bash
grep 'pool resolved\|main thread sees' results/*/jmeter.log
awk -F, 'NR>1 {print $NF}' results/*/result.jtl | sort | uniq -c   # setup / main 两种
```

## 【故意犯错】

### 4-A：改成 vars 试试

把 `pool-portfolios.groovy` 里的 `props.put` 换成 `vars.put`，
读的那边换成 `vars.get`，重跑。

**观察**：主线程读到 `null`。setUp 和主线程组是**不同的线程**，
`vars` 每线程一份,写进去的东西主线程一个都读不到。改回 `props`。

### 4-B：存对象而不是字符串

```groovy
props.put('myQueue', new java.util.concurrent.ConcurrentLinkedQueue(list))
// 读的那边：
log.info("via getProperty: ${props.getProperty('myQueue')}")   // → null !
log.info("via get:         ${props.get('myQueue')}")           // → 正常
```

**`props.getProperty()` 对非 String 值返回 `null`**，必须用 `props.get()`。
本项目的 checker 任务池存的就是 `ConcurrentLinkedQueue`（要的是
`poll()` 的原子性，保证两个线程不会领到同一个 task），踩过这个坑。

### 4-C：去掉 runPhase 看看

把两个 UDV 删掉，重跑，然后在 jtl 里统计 `TX_refdata_portfolios_list` 有几行。

**观察**：setUp 那一次和主循环那一次混在一起，**无法区分**。
在真工程里这意味着 preflight 那笔冷启动请求会混进容量统计——
1 线程 300 秒的 baseline 里多混一笔冷请求，P95 就偏了。

---

# 练习 5 · create-trade（60 min）

## 【这一练在解决什么】

multipart、两层断言、三类错误分离。**这是本项目最容易产出误导性报告的接口。**

## 做什么

照 [§4 全节](HANDBOOK-BUILD.zh.md)建 `create-trade.jmx`。新东西只有三样：

1. **multipart 三条铁律**（[§4.3](HANDBOOK-BUILD.zh.md)）——
   勾两个框、**绝不手写 Content-Type**
2. **两层断言**——Response Assertion 判 HTTP，JSR223 Assertion 判业务
3. **提取器的 Default Value**——必须填,且断言要校验**格式**而非只判非空

`config/dev.properties` 加上 workers 那一组，`data/refdata/refdata-pairs.csv`
和一个真实 `.dat` 参照 [`HANDBOOK.zh.md` 阶段 0](HANDBOOK.zh.md)。

## 【验收】

GUI 里加 View Results Tree，看 Request Body：
`Content-Type: multipart/form-data; boundary=...`，两个 part（`trade` + `datFile`）。

**看完立刻禁用 View Results Tree。**

## 【故意犯错】

### 5-A：在 Header Manager 里手写 Content-Type

加一行 `Content-Type: multipart/form-data`，重跑，看 Request Body。

**观察**：没有 boundary 了，服务端无法分段。
手写值会**覆盖** JMeter 生成的那个（生成值带 boundary，手写的不带）。

### 5-B：只留 HTTP 断言

禁用 JSR223 Assertion，故意把 `portfolioId` 改成一个不存在的值，重跑。

**观察**：报告显示**错误率 0%**，而实际一条 trade 都没建成——
这个接口业务失败时照样返回 HTTP 200，业务状态藏在 body 的 `code`/`status` 里。

**这是本项目最危险的一个失败模式。** 把它记牢。

---

# 练习 6 · 装上校验器，故意违规（30 min）

## 【这一练在解决什么】

为什么"每个 API 只维护一份"必须**机器强制**，而不能靠约定。

## 做什么

把现工程的 `scripts/validate.py` 和 `api-registry.csv` 拷过来，
按你练习里建的几个 fragment 改 registry，跑：

```bash
python3 scripts/validate.py
```

## 【故意犯错】—— 五条规则各撞一次

| 制造 | 预期 |
|---|---|
| 在 `p01` 里直接加一个 HTTP Request（不 Include） | **R1** |
| 复制 `portfolios-list.jmx` 成 `portfolios-list-v2.jmx` 并被引用 | **R2** |
| 把 `portfolios-list.jmx` 的 host 改成 `${__P(workers.host)}` | **R3** |
| 建一个 fragment 但不被任何 plan 引用 | **R4** |
| 建 fragment 但不写进 `api-registry.csv` | **R5** |

## 【收尾：亲眼看一次为什么需要规则】

回头数一下你练习里建的东西：**3 个原子 fragment，但 `refdata-load` 和 setUp
都引用了 `portfolios-list`。**

现在假设后端给 `GET /refdata/portfolios` 加一个必填 query 参数。
你要改几个文件？

—— **一个。**

再假设当初 `refdata-load` 里没用 Include，而是复制了一份 sampler。
你要改几个文件？**两个，而且没有任何东西会提醒你第二处存在。**

> 这不是假设。本项目早期版本的 `refdata-preflight.jmx` 就自己写了三个 sampler，
> 与 `steps/` 下的定义完全重复。规则 R2 就是那次之后加的。
>
> 现在只有 3 个 fragment，靠自觉能守住。**5 个服务 × N 个模块 × 33 个 API 时守不住**——
> 这就是为什么规则必须由机器执行。

---

# 练完之后

你应该能不看文档回答这几个问题。答不上来的，回去重做对应练习：

1. 为什么被 Include 的文件必须是 Test Fragment 而不是 Thread Group？（练习 1-A）
2. `run.sh` 里那行 `cd` 为什么不能删？（练习 1-B）
3. PostProcessor 挂在 Transaction Controller 下会怎样？（练习 2-A）
4. setUp 里 `vars.put` 的东西，主线程读得到吗？（练习 4-A）
5. `props.getProperty()` 什么时候返回 `null`？（练习 4-B）
6. 报告显示"错误率 0%"，能说明系统是好的吗？（练习 5-B）
7. 一个接口加了必填字段，你要改几个文件？为什么？（练习 6）

然后回到真工程，接 [`HANDBOOK.zh.md` 阶段 0](HANDBOOK.zh.md)：采集一份真实 curl。
