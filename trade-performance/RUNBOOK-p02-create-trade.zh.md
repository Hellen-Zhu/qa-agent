# p02 · `create-trade` 单接口压测 · 执行手册（JMeter）

> 本文档回答一件事：**今天坐下来，从零到一份能写进报告的数字，具体敲什么。**
> 每一步都带通过判据；判据不过就停下，不要往下走。

**与其它文档的分工**

| 文档 | 回答 |
|---|---|
| [`ARCHITECTURE.zh.md`](ARCHITECTURE.zh.md) | 脚本为什么这么搭（fragment / groovy / 执行时序） |
| [`HANDBOOK.zh.md`](HANDBOOK.zh.md) | 阶段 0–5 全景，p02 只是其中的阶段 1 |
| [`HANDBOOK-BUILD.zh.md`](HANDBOOK-BUILD.zh.md) | 在 GUI 里逐个元件怎么建 |
| [`k6/HANDBOOK.zh.md`](k6/HANDBOOK.zh.md) | k6 那套对照实现 |
| **本文档** | **只做 p02 一件事，带验收判据，Mac / Windows 双平台** |

---

## 0. 先把判据定下来

> 没有 pass/fail 判据的压测是**演示**，不是测试。
> 先写下判据再跑，否则跑完只会得到"看起来还行"。

判据不需要现编，[`docs/performance/oreo-nfr.zh.md`](../docs/performance/oreo-nfr.zh.md) 已经定了：

| 编号 | 条件 | P95 | P99 | 技术错误率 |
|---|---|---:|---:|---:|
| **PERF-07** | `POST /trades/create` — **small 档 `.dat`** | **5,000 ms** | 8,000 ms | < 0.5% |
| PERF-08 | medium 档 | 10,000 ms | 15,000 ms | < 0.5% |
| PERF-09 | large 档 | 20,000 ms | 30,000 ms | < 1% |
| PERF-21 | **脚本错误率** | — | — | **= 0** |

**阈值按 `.dat` 档位分列，不是三选一。** 你手上放的是哪一档文件，就对哪一条。
一个不标注文件档位的 create 延迟数字**无法解读**——三个月后没人知道它该对 5 秒还是 20 秒。
档位由 `scripts/index-dat.py` 按实测字节数判定（当前 < 64KB = small，< 1MB = medium）。

> ⚠ **这两个阈值是占位值**，`index-dat.py` 的注释里写明"待真实样本到位后按分布调整"。
> 它决定你对 5 秒还是 10 秒，**差一倍**。拿到真实 `.dat` 后第一件事是回头看这条线
> 划得对不对——如果所有真实文件都落在 200KB 上下，那"< 64KB = small"就等于宣布
> 一个 small 档都没有，PERF-07 永远用不上。

### ⚠ 并发目标是 **3–7**，不是 20

这是本次执行里最容易做错的一件事。

[`workload-modeling.zh.md`](../docs/performance/workload-modeling.zh.md) §6 的设计容量是
**New booking 0.11 TPS（月末 0.32）**；§4.7.4 用 M/G/∞ 从**实测单笔耗时**推出并发目标：

| 实测单笔耗时 | 5 s | 10 s | 15 s | 20 s | 30 s | 45 s | 60 s | 90 s |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **并发测试目标** | **3** | **3** | **4** | **4** | **4** | **5** | **6** | **7** |

取值规则是"满足 P(≥k 并发) < 0.1% 的最小 k"——约每 8 个交易日出现一次的尾部。

NFR §2.5 还明确把**容量拐点 TPS 排除在 NFR 之外**：
> 设计容量远低于拐点，该数字对 OREO 无决策价值。

所以本次的主线是**"在设计并发下达不达标"**，不是"拐点在哪"。
`HANDBOOK.zh.md` §1.7 那个 `for t in 2 4 8 12 16 20` 是找拐点用的，
**这一轮不跑**——理由不只是省时间，见 §7 的建单量估算。

---

## 1. 现在还跑不了：三个硬前置

先说结论：**当前状态跑 smoke 一定失败**，因为数据全是占位值。

```bash
cd /Users/jliu/hellen/qa/trade-performance
python3 scripts/validate.py     # 现在是非 0 退出
```

| # | 缺什么 | 现状 | 谁能给 |
|---|---|---|---|
| 1 | `data/refdata/refdata-pairs.csv` | 5 行全是 `TBC` | 你，从一次真实 curl |
| 2 | `data/dat/products/FX_TRF/*.dat` | 目录空 | 同一次 curl 里上传的那个文件 |
| 3 | `create-trade-data.csv` 的 `costTier` / `fixings` | `TBC` | 看 `.dat` 内容或问业务 |

### 1.1 采一份真实 curl（一次解决前两个）

在 OREO Web 上手工建一笔 trade，全程开着 Chrome DevTools → Network。
建完找到 `POST /trades/create` → 右键 → **Copy → Copy as cURL**。

从这份 curl 里拿：

- `-F 'trade={...}'` 里的 `portfolioId` / `counterpartyFmId` / `counterpartyName`
  → 天然配对，直接填进 CSV。**不要从两个不同的地方各抄一个拼起来**——
  组合不存在时服务端返回 HTTP 200 + 业务拒绝，报告上显示"0% 错误"。
- 上传的 `.dat`：**在页面上重新下载一份原始文件**，别从 curl 里还原。

顺手把 curl 原文和响应体存一份到 `data/refdata/_samples/`（自建，已被 `.gitignore` 覆盖）。
三个月后有人问"当初凭什么断言 `status == 'PENDING APPROVAL'`"，你要拿得出证据。

### 1.2 填数据

```bash
# ① refdata：一行一对
#    pairId,portfolioId,counterpartyFmId,counterpartyName,note
#    R001,PF-00123,FM-88991,PRINTINGINT10LTD*HKG,2026-07-28 UI curl
$EDITOR data/refdata/refdata-pairs.csv

# ② .dat 放进 data/dat/products/<productType>/，然后对账
#    它会把实测字节数写回 datSizeBytes，并告诉你落在哪一档
python3 scripts/index-dat.py --write

# ③ fixings：那个 .dat 的真实定盘次数
$EDITOR data/create-trade/create-trade-data.csv
```

> **本轮最小集 = 1 个 productType 1 个文件。** `index-dat.py` 会 WARN 说
> 成本画像还缺"最便宜/最贵/最常见"三个代表——那是阶段 5 的输入，不阻断本轮。
>
> ⚠ **不要复制一个文件改几个名字充数。** 内容相同的副本在服务端可能命中缓存，
> 你测到的是缓存命中率而不是解析成本，而 CSV 里看起来是 5 个用例。

### 1.3 通过判据

```bash
python3 scripts/validate.py && echo "OK"
```

**必须 exit 0。** 它同时查五条架构规则和 CSV 里的占位值。

---

## 2. 在哪台机器上跑

**规则：JMeter 和 k6 必须在同一台机器上跑。**

这次做 JMeter 版的唯一目的是**给 k6 版一个可比的参照**。
如果 JMeter 在 Windows 跑、k6 在 Mac 跑，两边 P95 的差异里同时混了
框架差异、机器差异、网络路径差异——**这份对比就作废了**，而报告上看不出来。

本机（Mac）现状，`2026-07-28` 实测：

| 检查 | 结果 |
|---|---|
| `nc -z 10.198.25.56 9089` | ✅ 通 |
| `k6 version` | ✅ 已装 |
| `java -version` | ❌ 没装 |
| `jmeter --version` | ❌ 没装 |

所以最省事的路径是**在这台 Mac 上补装 JMeter**，两套框架同机同网。
如果你打算最终在那台 Windows 远端上跑 k6，那 JMeter 也在那台上跑，
`scripts/run.ps1` 已经备好（见 §3.2）。

**不要两边各跑一半。**

---

## 3. 装 JMeter

需要 **JDK 11+** 和 **JMeter 5.6.3**（`.jmx` 里的 `jmeter="5.6.3"` 是兼容性声明）。

### 3.1 macOS

```bash
brew install jmeter          # 会一并装 openjdk@21
jmeter --version
```

> ⚠ 行内网络可能拦掉 `formulae.brew.sh`（本机实测就报了 SSL_ERROR_SYSCALL）。
> brew 装不上就走 zip：
>
> ```bash
> # JDK
> brew install openjdk@21 || echo "改用 https://adoptium.net/ 的 pkg 安装包"
> # JMeter
> # dlcdn 只保留当前版本；5.6.3 被新版取代后，把域名换成 archive.apache.org/dist
> curl -LO https://dlcdn.apache.org/jmeter/binaries/apache-jmeter-5.6.3.tgz
> mkdir -p ~/tools && tar xzf apache-jmeter-5.6.3.tgz -C ~/tools/
> echo 'export PATH="$HOME/tools/apache-jmeter-5.6.3/bin:$PATH"' >> ~/.zshrc
> exec zsh
> ```

### 3.2 Windows

```powershell
# JDK（二选一）
winget install --id EclipseAdoptium.Temurin.21.JDK
# 或到 https://adoptium.net/ 下 msi

# JMeter：下载 apache-jmeter-5.6.3.zip
#   https://jmeter.apache.org/download_jmeter.cgi
# 解压到 C:\tools\apache-jmeter-5.6.3
# 把 C:\tools\apache-jmeter-5.6.3\bin 加进 PATH
#   系统属性 → 环境变量 → Path → 新建
```

装完**必须重开一个 PowerShell 窗口**——PATH 不会在已经开着的窗口里刷新。
这条是 Windows 上最常见的"装了但找不到"。

```powershell
java -version
jmeter --version
```

> **首次执行 `.ps1` 可能被执行策略拦下**：
> ```powershell
> Get-ExecutionPolicy -List
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```
> `RemoteSigned` 允许本地脚本、拦截未签名的下载脚本，是够用且不过度放开的一档。

> ⚠ 仓库里的 `.dat` 是二进制。`.gitattributes` 已经声明了 `*.dat binary`，
> 但**它是这次才加的**——如果这个仓库以前在 Windows 上 checkout 过，
> 本地副本可能已经被 CRLF 转换改坏了。拉下来先做一次规范化：
> ```powershell
> git pull
> git rm --cached -r .
> git reset --hard
> python scripts\index-dat.py    # 字节数对不上就说明确实被改坏过
> ```

---

## 4. 四条命令一览

| 跑什么 | macOS / Linux | Windows |
|---|---|---|
| ① 脚本自检 | `./scripts/run.sh p02-trade-create dev smoke` | `.\scripts\run.ps1 p02-trade-create dev smoke` |
| ② 单笔基线 | `./scripts/run.sh p02-trade-create dev baseline` | `.\scripts\run.ps1 p02-trade-create dev baseline` |
| ③ 设计并发 | `./scripts/run.sh p02-trade-create dev baseline -Jthreads=4 -JrampUp=4 -Jduration=304` | `.\scripts\run.ps1 p02-trade-create dev baseline threads=4 rampUp=4 duration=304` |
| ④ 读结果 | `python3 scripts/summarize.py` | `python scripts\summarize.py` |

> **覆盖项的写法两边不同，这是刻意的。**
> Windows 版推荐裸 `key=value`：PowerShell 会把 `-` 开头的 token 当参数名去匹配本脚本，
> `-J...` 虽然也能落进 `$args`，但那依赖参数绑定的具体行为，版本之间未必一致。
> 裸写法绕开整套规则。`run.ps1` 两种都收，内部统一转成 `-Jkey=value`。

---

## 5. 第 1 跑 · smoke —— 验证脚本，不是验证性能

```bash
./scripts/run.sh p02-trade-create dev smoke
```

`smoke` = 1 线程 × 1 轮。**它会在 dev 里真建 2 笔 trade**
（setUp 的 preflight 一笔 + 主循环一笔），状态 `PENDING APPROVAL`。心里有数。

### 八条自检，缺一不可

任何一条不过都不要往下走——带着脚本 bug 加压，产出的是一份看起来正常、实际无意义的报告。

| # | 查什么 | 怎么查 | 不过说明什么 |
|---|---|---|---|
| 1 | 没有未解析变量 | run.sh / run.ps1 末尾会自动扫 jtl 里的 `${...}` | CSV 列名对不上 / 变量拼错 |
| 2 | preflight 通过 | 末尾没有 `PREFLIGHT FAILED` | refdata 值在库里不存在或已停用 |
| 3 | 真的发出了请求 | `summarize.py` 的"阶段分布"里 `main` ≥ 2 | Include 路径错（八成没在项目根跑） |
| 4 | 打到了正确的服务 | `jmeter.log` 里的 URL 是 `10.198.25.56:9089` | config 里 host 还是 localhost 占位值 |
| 5 | `errClass` 全是 `ok` | `summarize.py` 的错误分类表 | 见下方分诊 |
| 6 | `tradeId` 提取到了 | jtl 的 `tradeId` 列是 `TRD-<数字>` | `$.data.trade.id` 与真实响应不符 |
| 7 | `taskId` 提取到了 | jtl 的 `taskId` 列是 `CHK-...` | 正则与 msg 文案不符（文案一改就断） |
| 8 | multipart 发对了 | 见下方 | Content-Type 被 Header Manager 覆盖 |

### 三类错误分诊

`errClass` 是整个框架里最该先看的一列：

| 值 | 含义 | 处置 |
|---|---|---|
| `ok` | 成功 | — |
| `technical` | 连接失败 / 超时 / 5xx | **这才是性能结论** |
| `business` | HTTP 200 但业务拒绝 | 修数据，不是性能问题 |
| `script` | 提取器拿不到值 / 解析异常 | 修脚本，**本轮结果作废**（PERF-21 要求 = 0） |

> 这个接口业务失败时**照样返回 HTTP 200**。只看状态码的报告会显示"错误率 0%"，
> 而实际一条 trade 都没建成。这是本项目最容易产出误导性报告的地方，
> 也是三类分离存在的全部理由。

### 确认 multipart（第 8 条）

命令行模式看不到请求体，用 GUI 单独确认一次（**在项目根目录启动**）：

```bash
jmeter -t jmx/api/p02-trade-create.jmx
```

1. 在主 Thread Group 下临时加一个 **View Results Tree**
2. 只跑 1 次 → Request → Request Body
3. 应该看到 `Content-Type: multipart/form-data; boundary=...`，两个 part：
   `trade`（JSON）和 `datFile`（带 `filename=`）
4. **确认完把 View Results Tree 删掉或禁用**——压测时它会吃光内存

若 `trade` part 上多出 `Content-Type: text/plain`，说明 `BROWSER_COMPATIBLE_MULTIPART` 没生效；
若整个请求没有 boundary，说明有人在 Header Manager 里手写了 Content-Type。两者都会让服务端无法分段。

> **GUI 只用来看结构和调试，绝不用来压测**——GUI 自身开销会污染结果。

### 顺手校准三处推断

脚本里有三处标着"未经真实响应验证"，用 §1.1 采到的响应体对一遍：

| 位置 | 推断内容 |
|---|---|
| `groovy/build-trade-payload.groovy` | `trade` 字段只有 `basic` 一层，4 个子字段 |
| `groovy/assert-create-response.groovy` | 成功判定 `code==200 && status=='PENDING APPROVAL'` |
| `create-trade.jmx` 的两个提取器 | `$.data.trade.id`、`TaskId:\s*(CHK-[A-Za-z0-9]+)` |

改动只在这三处，`p02` 和 `s01` 同时生效——这是四层架构的收益兑现点。

---

## 6. 第 2 跑 · baseline —— 先测一笔要多久

```bash
./scripts/run.sh p02-trade-create dev baseline
```

`baseline` = 1 线程连续跑 300 秒。**目的不是压出上限，是测出单笔耗时。**

这一步不能跳，因为**并发目标是从这个数推出来的**（§0 的表）：
单笔 5 秒对应并发 3，单笔 90 秒对应并发 7。没有它，线程数只能靠猜，
而猜出来的数字在评审上答不出"为什么是这个数"。

### 先看样本量，再看百分位

```bash
python3 scripts/summarize.py
```

```
样本数 = 线程数 × 时长 ÷ 单笔耗时
```

1 线程 × 300 秒，单笔 3 秒 → 100 个样本（P50 可用，P95 偏抖）
1 线程 × 300 秒，单笔 20 秒 → **15 个样本，P95 完全没有意义**

`summarize.py` 会自己算并告诉你还差多久。不够就加时长：

```bash
./scripts/run.sh p02-trade-create dev baseline -Jduration=1800
```

> 单线程下拿 P95 是昂贵的——300 个样本 × 20 秒 = 100 分钟。
> 现实做法：**baseline 只认 P50 和分布形状**，P95 留到 §7 的并发跑里拿
> （那里样本量是线程数倍）。报告里要标注这一点，不要拿 15 个样本的 P95 当结论。

### 记下三个数

| 记什么 | 用来干嘛 |
|---|---|
| **P50** | 查 §0 的表，定并发目标 |
| **P95 / P50 比值** | > 3 说明有慢路径（多半是 `.dat` 解析或 risk 计算），是下一步要单独拆的 |
| **max** | 对照 PERF-07 的 P99 上限，看有没有离群点 |

> `summarize.py` 已经把 setUp 的 preflight 样本剔掉了。
> 那一笔是**冷启动**（连接未建、JIT 未热、缓存空），通常就是 HTML 报告里那个 max——
> 拿它当"最坏情况"写结论是错的。想看它加 `--phase all`。

### 跑两次

第一次是热身（连接池、JIT、缓存都在爬坡），第二次才是测量。
两次差得离谱说明系统有冷启动效应，那本身是个要写进报告的发现。

---

## 7. 第 3 跑 · 设计并发下的验收

用 §6 的 P50 查 §0 的表，得到并发目标 **k**（多半是 3 或 4）。跑 **k-1 / k / k+1** 三级：

```bash
# 假设查出来 k=4
for t in 3 4 5; do
  ./scripts/run.sh p02-trade-create dev baseline \
      -Jthreads=$t -JrampUp=$t -Jduration=$((t + 300))
  sleep 60      # 让队列排空、GC 收尾，也让 Grafana 上分得清级与级的边界
done
```

```powershell
foreach ($t in 3,4,5) {
  .\scripts\run.ps1 p02-trade-create dev baseline `
      threads=$t rampUp=$t duration=$($t + 300)
  Start-Sleep -Seconds 60
}
```

> `duration` 是**从测试开始算的总时长**，包含 ramp-up。
> 想要 300 秒满并发，就得写 `rampUp + 300`。写死 300 的话，满并发的时间随 rampUp
> 逐级缩短——差几秒不影响结论，但**级与级之间的口径不一致了**，
> 而"每次只改一个变量"这条纪律要求它一致。

### 通过判据（PERF-07，small 档）

| 指标 | 阈值 | 从哪看 |
|---|---|---|
| 成功样本 P95 | ≤ 5,000 ms | `summarize.py` 的"成功样本"行 |
| 成功样本 P99 | ≤ 8,000 ms | 同上 |
| `technical` 占比 | < 0.5% | 错误分类表 |
| `script` 占比 | **= 0**（PERF-21） | 同上，非 0 则本轮作废 |

三级都过 → **PASS**，可以写结论。
k 过、k+1 不过 → 也是 PASS，但要在报告里写明"余量很薄"。
k 就不过 → **FAIL**，此时才需要往上加压找拐点，那属于诊断，不属于验收。

### ⚠ 建单量：跑之前先算

**每一个请求都在 dev 里留下一笔真实的 `PENDING APPROVAL` trade，且当前没有商定的清理方案。**

```
建单数 ≈ 线程数 × 时长 ÷ 单笔耗时
```

| 方案 | 单笔 3 s | 单笔 20 s |
|---|---:|---:|
| 本文档（3/4/5 三级 × 300 s） | ~1,200 笔 | ~180 笔 |
| HANDBOOK §1.7 的 2/4/8/12/16/20 | ~6,200 笔 | ~930 笔 |

当前 payload 不接受自定义字段，压测数据只能靠
"专用 PERF Portfolio + `PENDING APPROVAL` 状态 + 时间窗口"三者交集来识别。
**开跑前先和 DBA / 开发对齐清理方案**——这也是本轮不跑到 20 并发的一个实际理由。

---

## 8. 对照实验（可选，各跑一次）

主线到 §7 就完了。下面这个开关回答"性能问题出在哪一层"：

```bash
# 全部线程打同一个 portfolio —— 若 TPS 显著下降，存在 portfolio 级锁竞争
./scripts/run.sh p02-trade-create dev baseline -Jthreads=4 -JrampUp=4 -Jduration=304 \
    -JrefdataFile=data/refdata/refdata-pairs-single.csv
```

**一次只开一个开关。** 同时开两个，结果无法归因。

> ### per-user 锁竞争这个维度**测不了**
>
> 身份已固定成 `maker@sc.com`（不从 CSV 轮换），全部线程本来就共用同一个 maker——
> **永远处于"集中"那一侧，没有"分散"的对照组**。
>
> 这是保守选择：如果服务端真有 per-user 锁或计数器，我们测到的是它最坏的一面。
> 但**报告里不能声称"不存在 per-user 竞争"**——我们没做那个实验，
> 只是一直站在竞争最激烈的那一侧。

---

## 9. 怎么读结果

```bash
python3 scripts/summarize.py                              # 最近一次
python3 scripts/summarize.py results/<runId>/result.jtl   # 指定某次
python3 scripts/summarize.py results/<runId>/result.jtl --phase all
```

### 为什么不直接读 JMeter 的 HTML 报告

HTML 报告（`reports/<runId>/index.html`）没有错，但它的口径和我们要的不是一回事，
**三处差异都让结论偏乐观**：

| # | HTML 报告 | 为什么是问题 |
|---|---|---|
| 1 | setUp 的 preflight 和主循环算成同一行 | 标签完全相同（preflight 就是 Include 了同一个 fragment）。那一笔是冷启动，通常就是报告里的 max |
| 2 | 失败样本一起算进百分位 | 业务拒绝往往**很快**返回，把 P95 往下拽 |
| 3 | `Total` 行同时含 TX 行和 sampler 行 | `TransactionController.parent=false` 会多出一行样本，照 Total 读 TPS 会**翻倍** |

HTML 报告仍然值得看的是**时间序列图**（Response Times Over Time / Active Threads），
那是 `summarize.py` 不给的：看 P95 是全程平稳还是后半程爬升。

### 两个 label 的关系

| label | 是什么 |
|---|---|
| `TX_workers_trademgmt_create` | 事务口径：一步业务的耗时 |
| `workers_trademgmt_create` | 采样器口径：单个 HTTP 请求 |

本例两者几乎相同（一步只含一个请求）。**引用哪个都行，全篇必须统一，且永远不要相加。**

### 后端指标（Grafana + Prometheus）

**完整用法见 [`GRAFANA.zh.md`](GRAFANA.zh.md)** —— 看板的四层结构、归因决策表、
现成 PromQL、三种集成方案。这里只放跑 p02 时最低限度要知道的：

runner 跑完会直接打印时间范围，贴进看板 URL 替换 `from=now-1h&to=now`：

```
Grafana 时间范围（替换 URL 里的 from=now-1h&to=now）：
  &from=1785222714298&to=1785223019331
```

按 **HTTP → gRPC → JVM → HikariCP** 从上往下找第一个饱和的层：

| 现象 | 大概率原因 |
|---|---|
| TPS 平了、CPU 也不高、`hikaricp_connections_pending` 离开 0 | DB 连接池是瓶颈（截图里 `max=10`） |
| TPS 平了、CPU 打满 | 真的算不过来（`.dat` 解析 / risk） |
| TPS 平了、gRPC Client 出站 p99 陡增 | 下游拖的（risk-engine / user-center） |
| TPS 平了、**所有面板都闲** | 串行段 / 锁竞争 ← 只有一对 refdata 时最可能是这个 |
| heap 锯齿谷底持续抬升 | 泄漏，留到 soak 验证 |

> ### ⚠ 看板看不见 OREO 的业务失败
>
> create 业务失败**照样返回 HTTP 200**，所以 **5xx 面板会稳稳显示 0%**，
> 而 p95 面板还会因为业务拒绝返回得快而显得**更好看**。
>
> **技术层结论看 Grafana，业务层结论只能看 `summarize.py` 的 `errClass`。**
> 只贴 Grafana 截图的性能报告，在 OREO 上不成立。

> ⚠ 单级时长有**两个下限，取更严的那个**：
> 压测端 `样本数 = 线程数 × 时长 ÷ 单笔耗时 ≥ 100`，
> 后端 `数据点数 = 时长 ÷ scrape_interval ≥ 20`。
> 只算了前者就开跑，后端曲线会只有几个点，看着像噪声。scrape 间隔怎么查见 GRAFANA.zh.md §1.2。

---

## 10. 结果记录表（跑完填这个）

```markdown
# Perf test: OREO create-trade (p02, JMeter) — 2026-__-__

**问题：** 在设计并发 k=__ 下，POST /trades/create 能否满足 PERF-07？
**结论：** PASS / FAIL — ____
**环境：** dev 10.198.25.56:9089 / 单机压测端 ____ / 库存 trade 量 ____
**数据：** .dat = ____（____ bytes，____ 档）/ refdata 对数 ____
**偏差：** 只有 1 个 productType；per-user 竞争维度未测；压测端与被测机 NTP 未确认

| 轮次 | 线程 | 时长 | 成功样本 | TPS | P50 | P95 | P99 | max | tech% | biz% | script% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline |  1 | 300s | | | | | | | | | |
| k-1      |    |      | | | | | | | | | |
| **k**    |    |      | | | | | | | | | |
| k+1      |    |      | | | | | | | | | |
| 单 portfolio |  |    | | | | | | | | | |

**判据对照：** P95 ____ vs 5,000ms ｜ P99 ____ vs 8,000ms ｜ tech ____ vs 0.5% ｜ script ____ vs 0
**瓶颈假设：** ____（附 Grafana 截图时间段 from=____ to=____）
**每轮 manifest：** results/<runId>/manifest.txt
```

最后一行不是形式主义。三个月后有人质疑某个数字，没有 manifest
你无法回答"那次跑的是哪个 commit、哪份数据、什么参数"。

---

## 11. 跑完 JMeter 再跑 k6 时，怎么保证可比

两套框架**读的是同一个 `data/` 目录**——这是刻意的：
P50/P95 出现差异时，只可能是脚本差异，不可能是数据差异。

对齐这五项，差异才归因得了框架：

| # | 对齐什么 | 怎么做 |
|---|---|---|
| 1 | 同一台机器 | 见 §2 |
| 2 | 同一个 `.dat` 和同一批 refdata | 两边都读 `data/`，不要单独改 |
| 3 | 同样的并发与时长 | `./scripts/run.sh … -Jthreads=4 -Jduration=304` ↔ `./k6/run.sh … VUS=4 DURATION=300s`<br>（两个 runner 的覆盖项写法不同，见 §4 的说明） |
| 4 | 同样的"成功"定义 | 两边都是 `code==200 && status=='PENDING APPROVAL'`，且百分位只算成功样本 |
| 5 | 中间隔够久 | 上一轮的队列排空、GC 收尾之后再跑下一轮 |

⚠ **百分位算法在两边实现不同**（最近秩 / 线性插值）。样本量小于 ~200 时，
不同算法能差出几个百分点。**对比要看 P50 和整体形状，不要咬 P95 的第三位数字。**

还有一条结构性差异，不是 bug：JMeter 的 Thread Group 是**闭合模型**
（发→等→再发，服务端变慢时压力自己也变慢），k6 的 `arrival` profile 是**开放模型**
（按到达率打，不管前一笔回没回来）。OREO 的负载天然是到达率——
没有交易员会等上一笔 booking 完成才提交下一笔。所以两边的 `baseline`/`ladder` 可比，
而 k6 的 `arrival` **没有 JMeter 对照物**（需要 jpgc Arrivals Thread Group 插件）。

---

## 12. 故障速查

| 症状 | 原因 | 处置 |
|---|---|---|
| 跑完 0 个样本，也不报错 | 没在项目根启动，Include Controller 找不到 fragment | 用 `run.sh` / `run.ps1`，它们自己会 cd |
| `ERROR: jmeter not on PATH` | 没装 / 装完没重开窗口 | §3 |
| `bad interpreter: ...^M` | `.sh` 被 checkout 成 CRLF | `.gitattributes` 已声明 `*.sh text eol=lf`，重新 clone 或 `git rm --cached -r . && git reset --hard` |
| `NativeCommandError`，看着像 JMeter 一启动就崩 | PowerShell `$ErrorActionPreference='Stop'` + JMeter 写 stderr | `run.ps1` 已规避；手工调 jmeter 时先 `$ErrorActionPreference='Continue'` |
| jtl 里出现 `${...}` 字面量 | 变量没定义 / CSV 列名拼错 | 两个 runner 末尾都会扫出来并列出变量名 |
| `PREFLIGHT FAILED` | refdata 组合在库里不存在或已停用 | 重采一次 curl；`dev` 默认 `preflightPolicy=warn`，不会阻断但结论不可用 |
| 全是 `business` 错误 | refdata 组合无效 / `.dat` 格式不对 | 拿 curl 里的原始值逐字段比对 |
| 出现 `script` 错误 | 提取器与真实响应不符 | §5 的"校准三处推断"；PERF-21 要求 script = 0，本轮作废 |
| **控制台**里的中文变成乱码 | Windows 控制台不是 UTF-8 | `run.ps1` 已设 `[Console]::OutputEncoding`；手工调 jmeter 时自己设一次 |
| **响应体**里的中文变成乱码（断言因此失败） | 响应没带 charset，JMeter 用了平台默认编码 | `jmeter.properties` 里设 `sampleresult.default.encoding=UTF-8` |
| P95 抖得离谱 | 样本量不够 | `summarize.py` 会直接告诉你差多少、还要跑多久 |
| 报告里 max 特别大但只有一个 | setUp 的冷启动样本 | 用 `summarize.py`（默认已剔除），别读 HTML 报告的 Total |

---

## 13. 一页速查

```bash
# 前置（只做一次）
python3 scripts/validate.py            # 必须 exit 0
python3 scripts/index-dat.py --write   # 填 datSizeBytes，判档位

# 三跑
./scripts/run.sh p02-trade-create dev smoke                                  # 八条自检
./scripts/run.sh p02-trade-create dev baseline                               # 拿 P50 → 查表定 k
./scripts/run.sh p02-trade-create dev baseline -Jthreads=k -JrampUp=k -Jduration=$((k+300))

# 读
python3 scripts/summarize.py           # 已剔除 preflight、已分离三类错误、已分开 label
open reports/<runId>/index.html        # 只为看时间序列图
```

| 判据 | 值 |
|---|---|
| P95（small 档） | ≤ 5,000 ms |
| P99（small 档） | ≤ 8,000 ms |
| technical 错误率 | < 0.5% |
| **script 错误率** | **= 0** |
| 并发目标 k | 由 baseline 的 P50 查 §0 的表，**3–7**，不是 20 |
