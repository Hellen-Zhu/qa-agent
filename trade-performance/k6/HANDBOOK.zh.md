# k6 实操手册 · Windows 优先

**面向对象**:在 Windows 远端机上从零把 k6 跑起来、能改脚本、能出数的人。

| 想干什么 | 看哪一节 |
|---|---|
| 装环境 | [阶段 0](#阶段-0--环境搭建windows) |
| 第一次跑通 | [阶段 1](#阶段-1--第一次跑通) |
| 看懂这个项目怎么组织的 | [阶段 2](#阶段-2--读懂结构) |
| 加一个新接口 | [阶段 3](#阶段-3--加一个新接口) |
| 调试 | [阶段 4](#阶段-4--调试手段) |
| 从 smoke 到压测 | [阶段 5](#阶段-5--从-smoke-到容量测试) |
| 看结果 | [阶段 6](#阶段-6--结果怎么读) |
| 接 Grafana | [阶段 7](#阶段-7--接进-prometheus--grafana) |
| 出错了 | [故障速查](#故障速查) |

原理(执行模型、作用域、为什么这么分层)见 [`README.zh.md`](README.zh.md)。
本文只讲**怎么做**。

---

# 阶段 0 · 环境搭建(Windows)

## 0.1 装 k6

在 **PowerShell** 里(不是 cmd):

```powershell
winget install k6 --source winget
```

没有 winget 就用 Chocolatey:

```powershell
choco install k6
```

两个都没有 → 从 https://github.com/grafana/k6/releases 下 `k6-vX.Y.Z-windows-amd64.zip`,
解压到比如 `C:\tools\k6\`,然后把这个目录加进 PATH:

```powershell
[Environment]::SetEnvironmentVariable(
    "Path", $env:Path + ";C:\tools\k6", [EnvironmentVariableTarget]::User)
```

> ⚠ **装完必须重开一个 PowerShell 窗口。**
> PATH 不会在已经打开的窗口里刷新——这是 Windows 上最常见的"装了但找不到"。

验证:

```powershell
k6 version
```

## 0.2 装 Node(可选,但建议)

只用来跑脚本单测,**压测本身不需要 Node**。

```powershell
winget install OpenJS.NodeJS.LTS
```

## 0.3 PowerShell 执行策略

Windows 默认禁止运行 `.ps1`。第一次跑会报
`无法加载文件 ...\run.ps1，因为在此系统上禁止运行脚本`。

**推荐做法**(只对当前窗口生效,不改系统设置,不需要管理员):

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

每次新开窗口都要敲一次。嫌烦就改成对当前用户永久生效:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

> `RemoteSigned` 表示"本地写的脚本可以跑,从网上下载的必须有签名"——
> 比 `Bypass` 安全,够用。**不要设成 `Unrestricted`。**

## 0.4 控制台中文

老版本 Windows 控制台默认不是 UTF-8,preflight 的中文报错会变成乱码。
`run.ps1` 里已经设了 `[Console]::OutputEncoding`,但保险起见可以先:

```powershell
chcp 65001
```

**推荐直接用 Windows Terminal**(`winget install Microsoft.WindowsTerminal`),
它默认 UTF-8,不用折腾。

## 0.5 拉代码 —— ⚠ 这一步有个坑

```powershell
git clone <repo>
cd trade-performance
```

仓库里有 `.gitattributes`,它保证:

| 规则 | 防什么 |
|---|---|
| `*.dat binary` | **Windows 上 git 把 .dat 当文本会改行尾,直接损坏二进制文件** |
| `*.sh text eol=lf` | CRLF 会让 shebang 变成 `#!/usr/bin/env bash\r`,Git Bash 报 `bad interpreter: ^M` |

**如果你的仓库是在加 `.gitattributes` 之前克隆的**,已经检出的文件可能已经被改坏了。
重新规范化一次:

```powershell
git rm --cached -r .
git reset --hard
```

验证 `.dat` 没坏——字节数必须和 CSV 里声明的一致:

```powershell
python scripts\index-dat.py
```

## 0.6 编辑器

VS Code + 这两个扩展就够:

- **k6**(Grafana 官方)—— `k6/*` 模块的自动补全
- **ESLint**(可选)

`.js` 文件不需要任何构建步骤——**k6 直接跑源码,没有 npm install、没有打包**。

---

# 阶段 1 · 第一次跑通

## 1.1 自检(不需要 k6,不需要网络)

```powershell
node k6\tests\csv.test.mjs
```

期望 `14 passed, 0 failed`。

这一步验证 CSV 解析器和你的数据文件表头对得上。**过不了就别往下走**——
后面所有失败都会被它污染。

## 1.2 填数据

两套框架**共用同一份数据**,所以这一步做一次,JMeter 和 k6 都受益。

### ① 参考数据

编辑 `data\refdata\refdata-pairs.csv`,把 `TBC` 换成真值:

```csv
pairId,portfolioId,counterpartyFmId,counterpartyName,note
R001,ABS-HK-CFD-BDC,10052235,UNIVERSAL WEST,来自 2026-07-28 dev 实测 curl
```

值从哪来:在 UI 上手工建一笔 trade → F12 DevTools → Network → 找到
`trades/create` → 右键 **Copy as cURL** → payload 里就是这三个字段。

> **一行不够。** 只有一组 refdata 意味着所有 VU 打同一个 portfolio,
> 你永远处在锁竞争的最坏侧,而且无法归因。**至少采 4~5 组**(每次换个 counterparty 重复上面步骤)。

### ② .dat 文件

把真实 `.dat` 放进 `data\dat\products\FX_TRF\fx_trf_01.dat`,
然后让脚本把实测字节数填进 CSV:

```powershell
python scripts\index-dat.py --write
```

### ③ 校验

```powershell
python scripts\validate.py
```

必须 exit 0。还在报 TBC 就是①②没做完。

## 1.3 smoke

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass   # 每个新窗口一次
.\k6\run.ps1 p02-trade-create dev smoke
```

Mac/Linux 或 Git Bash:

```bash
./k6/run.sh p02-trade-create dev smoke
```

### 期望看到

```
> plan     k6\scenarios\p02-trade-create.js
> env      k6\config\dev.json
> profile  k6\profiles\smoke.json
> results  k6\results\p02-trade-create_dev_smoke_20260728-...

── preflight ─────────────────────────────────
env=dev profile=smoke
target=http://10.198.25.56:9089/api/v1/trades/create
maker=maker@sc.com
refdata rows=5  case rows=1
✓ 检查 1/2：CSV 字段齐全，无占位值
✓ 检查 2/2：refdata 业务可用 — pairId=R001 portfolio=ABS-HK-CFD-BDC → TRD-100234 / CHK-98C0DF19 (1843ms)
```

然后是摘要。

### 自检清单(缺一不可)

| # | 检查 | 怎么看 |
|---|---|---|
| 1 | preflight 两项都 ✓ | 上面的日志 |
| 2 | `ok` 计数 = 1 | 摘要「结果分类」 |
| 3 | technical / business / script 全 0 | 同上 |
| 4 | `tradeId` 是 `TRD-` 开头的真值 | preflight 日志 |
| 5 | `taskId` 是 `CHK-` 开头的真值 | 同上,`NOT_FOUND` 说明 msg 文案变了 |
| 6 | 被测系统里真多了一笔 `PENDING APPROVAL` | 去 UI 上看 |
| 7 | **multipart 结构对** | 见 [4.1](#41-看实际发出去的是什么) |
| 8 | `X-User-Id` 发出去的是 `maker@sc.com` 不是 `anonymous` | 同上 |

第 7、8 条**必须人工看一次**。它们错了不会报错,只会让结论悄悄失真。

---

# 阶段 2 · 读懂结构

## 三维正交

```
.\k6\run.ps1  <plan>            <env>           <profile>
              ↓                 ↓               ↓
              维度一：测什么     维度二：打哪     维度三：多大压力
              scenarios\*.js    config\*.json   profiles\*.json
```

**任何一维都能独立替换而不碰其余两维。** 换环境不用改脚本,换负载不用改环境。

## 文件职责

| 文件 | 管什么 | 什么时候改 |
|---|---|---|
| `config\<env>.json` | host / port / 身份 / 数据文件路径 | 换环境、地址变了 |
| `profiles\<p>.json` | VU 数 / 时长 / 到达率 / 阈值 | 换负载模型 |
| `scenarios\p02-*.js` | 组装:setup + 循环体 + 摘要 | 加新的可运行计划 |
| `steps\...\create-trade.js` | **这个 API 的契约** | 后端改接口 |
| `lib\errors.js` | 响应怎么判定、错误怎么分类 | 判定规则变了 |
| `lib\data.js` | CSV / .dat 怎么装载、怎么取 | 取数策略变了 |
| `lib\config.js` | 三维怎么合并 | 加新的可覆盖项 |

**改 `steps\` 里的文件,所有引用它的计划同时生效。** 这是分层的全部收益。

## 覆盖任何配置

```powershell
.\k6\run.ps1 p02-trade-create dev baseline VUS=8 DURATION=180s
```

⚠ **不要加 `-e` 前缀。** PowerShell 会把 `-e` 当成本脚本的参数名前缀去匹配,
报 `ambiguous parameter`,而错误信息完全不提你其实是想传给 k6。
`run.sh` 已同步成同样写法,**两边命令行长得一样,笔记才通用**。

目前支持的覆盖项(见 `lib\config.js`):

| KEY | 作用 |
|---|---|
| `VUS` | 并发数 |
| `DURATION` | 时长,如 `300s` / `30m` |
| `RATE` | 到达率(仅 arrival profile) |
| `ITERATIONS` | 迭代数(仅 smoke) |
| `REFDATA_FILE` | 换参考数据文件 → 对照实验 |
| `CREATE_DATA_FILE` | 换用例文件 → 坏 .dat 测试 |
| `MAKER_USER_ID` | 换身份 |
| `PREFLIGHT_POLICY` | `abort` / `warn` |

---

# 阶段 3 · 加一个新接口

以 `GET /trades`(blotter 列表)为例,四步。

## 3.1 写原子步骤

新建 `k6\steps\workers\trade-management\trades-list.js`:

```javascript
/*
 * 【API】 workers.trade-management.list · GET /trades
 * 【契约】唯一真相来源 —— 请求构造 + 响应判定都只在这里定义一次
 */
import http from 'k6/http';
import { cfg } from '../../../lib/config.js';

const URL = `${cfg.workersUrl}/trades`;

export function tradesList(opts) {
  const { runPhase, pageSize, page } = opts;

  // 查询串在这里拼，不写死在 path 里 ——
  // blotter 列表与 search 定位是同一个端点、同一份契约，差异只能由参数表达
  const q = [`size=${pageSize}`, `page=${page || 0}`];
  if (opts.status) q.push(`status=${encodeURIComponent(opts.status)}`);

  const tags = {
    name: 'workers_trademgmt_list',   // ← 低基数，会成为指标维度
    runPhase,
    pageSize: String(pageSize),       // ← 成本因子，要能按它切分结果
  };

  const res = http.get(`${URL}?${q.join('&')}`, {
    headers: { accept: '*/*', 'X-User-Id': cfg.makerUserId },
    timeout: cfg.requestTimeout,
    tags,
  });

  return { res, tags };
}
```

### 三条规矩

1. **URL 从 `cfg` 拿**,不写死 host —— 否则换环境要改代码
2. **标签只放低基数字段** —— `tradeId` 这种每次都不同的会撑爆 Prometheus
3. **判定逻辑不写在这里**,放 `lib\errors.js` —— 多个接口共用同一套错误分类

## 3.2 加判定函数

在 `lib\errors.js` 里加(照抄 `classifyCreate` 的分支结构):

```javascript
export function classifyList(res, tags) {
  if (res.status !== 200) { record(ERR.TECHNICAL, tags, res); return { errClass: ERR.TECHNICAL, rows: 0 }; }
  let body;
  try { body = res.json(); }
  catch (e) { record(ERR.SCRIPT, tags, res); return { errClass: ERR.SCRIPT, rows: 0 }; }
  if (body.code !== 200) { record(ERR.BUSINESS, tags, res); return { errClass: ERR.BUSINESS, rows: 0 }; }
  record(ERR.OK, tags, res);
  return { errClass: ERR.OK, rows: (body.data && body.data.length) || 0 };
}
```

> ⚠ **`rows` 一定要返回并检查。** 参数名是推断的(`size` / `page`),
> 服务端若忽略未知参数会返回默认页 —— 请求成功、行数不对,**报告里完全看不出来**。
> 首次 smoke 必须人工核对 `rows === pageSize`。

## 3.3 写可运行计划

新建 `k6\scenarios\p05-trades-list.js`,照抄 `p02` 的骨架,改三处:
`PLAN` 常量、循环体调用的函数、`setup()` 里的守卫。

## 3.4 跑

```powershell
.\k6\run.ps1 p05-trades-list dev smoke
```

**不需要改 `run.ps1`,不需要注册,不需要配置。** 文件放进 `scenarios\` 就能跑。

---

# 阶段 4 · 调试手段

## 4.1 看实际发出去的是什么

**这是 k6 里替代 JMeter「View Results Tree」的东西:**

```powershell
k6 run --http-debug=full -e ENV=dev -e PROFILE=smoke k6\scenarios\p02-trade-create.js
```

会打印完整的请求和响应,包括 multipart 的每一段。**smoke 时必看一次**,确认:

```
Content-Type: multipart/form-data; boundary=------------------------abc123
                                   ↑ k6 自己生成的，不是你写的

--------------------------abc123
Content-Disposition: form-data; name="trade"

{"basic":{"portfolioId":"ABS-HK-CFD-BDC",...}}
                       ↑ 不能是 ${...} 或 undefined

--------------------------abc123
Content-Disposition: form-data; name="datFile"; filename="fx_trf_01.dat"
                                                          ↑ 只能是文件名，
                                                            不能带路径
Content-Type: application/octet-stream
```

`--http-debug`(不加 `=full`)只打头,不打 body,输出少很多。

## 4.2 只跑一次

```powershell
k6 run --iterations 1 --vus 1 -e ENV=dev -e PROFILE=smoke k6\scenarios\p02-trade-create.js
```

调脚本时比走 `run.ps1` 快,少一层封装。

## 4.3 打日志

```javascript
console.log(`portfolio=${refdata.portfolioId} dat=${caseRow.datFile}`);
```

`console.log / info / warn / error` 都有。

> ⚠ **压测时把日志关掉。** 每 VU 每迭代一行 `console.log`,
> 20 VU 跑 30 分钟就是几十万行,I/O 会算进你的测量。
> 调试用 `--log-output=file=debug.log` 落盘,别刷屏。

## 4.4 校验配置有没有生效

```powershell
k6 inspect k6\scenarios\p02-trade-create.js -e ENV=dev -e PROFILE=baseline
```

打印**最终生效**的 `options`(scenarios / thresholds / tags)。
怀疑 profile 没读到时先看这个。

## 4.5 单测纯逻辑

```powershell
node k6\tests\csv.test.mjs
```

**不依赖 k6 的逻辑要和 k6 API 隔离开**(`lib\csv.js` 不 import 任何 `k6/*`),
隔离开就能这么测。这是 k6 相对 JMeter 最大的工程优势——
JMeter 侧的 groovy **唯一验证方式是跑一次真实压测**。

---

# 阶段 5 · 从 smoke 到容量测试

## ⚠ 开跑前:先谈妥数据

每次迭代都在被测系统里**真建一笔 trade**。

| 跑什么 | 大概产生 |
|---|---|
| baseline 300s | 几十 ~ 一百多笔 |
| ladder 全程 | **上千笔** |

**开跑前必须和 DBA/开发谈妥能不能建、怎么删。** 最好申请专用 PERF portfolio。

## 5.1 单线程基线 —— 先测"一笔要多久"

```powershell
.\k6\run.ps1 p02-trade-create dev baseline
```

**目的不是压出上限,是测出单笔耗时分布。** 这是后续一切的分母。

记三个数:**P50 / P95 / P95÷P50**。比值 > 3 说明存在慢路径。

### ⚠ 样本量下限

```
样本数 = VU 数 × 时长 ÷ 单笔耗时
```

| 单笔耗时 | 1 VU × 300s | P95 可信吗 |
|---|---|---|
| 2s | 150 | 勉强 |
| 20s | **15** | **完全没意义** |

**下限 100,300 以上才踏实。** 摘要里会自动警告并算出需要多长时间。
不够就 `DURATION=1800s` 重跑。

## 5.2 阶梯加压 —— 找拐点(闭合模型)

```powershell
.\k6\run.ps1 p02-trade-create dev ladder
```

或逐级单跑(**推荐**——各级之间有空档,Grafana 上能分辨边界):

```powershell
foreach ($n in 2,4,8,12,16,20) {
    .\k6\run.ps1 p02-trade-create dev baseline VUS=$n DURATION=300s
    Start-Sleep -Seconds 60
}
```

**拐点判据:TPS 不再随 VU 上升,而 P95 开始陡增。**

提前停的信号(任一出现就停):
- `technical` 错误开始出现 ← **这才是性能结论**
- TPS 比上一级不升反降
- 环境方喊停

## 5.3 开放模型 —— 按到达率施压

```powershell
foreach ($r in 1,2,4,8) {
    .\k6\run.ps1 p02-trade-create dev arrival RATE=$r
    Start-Sleep -Seconds 60
}
```

**这是 JMeter 默认 Thread Group 给不了的。**

闭合模型下服务端变慢时压力也跟着变慢(压力机自己踩刹车),会**系统性低估过载后果**。
开放模型按 λ 固定到达,队列真实堆积。

> ⚠ 摘要里 `dropped_iterations > 0` 说明 `maxVUs` 不够、**到达率没打满**——
> 这时结果不可用,**不是"系统扛住了"**。这是开放模型独有的必盯信号。

## 5.4 对照实验

```powershell
# D 类：全部 VU 打同一个 portfolio → 若 TPS 显著下降，存在 portfolio 级锁竞争
.\k6\run.ps1 p02-trade-create dev baseline VUS=8 REFDATA_FILE=data/refdata/refdata-pairs-single.csv

# 坏 .dat：期望失败，看的是"多快拒绝"（P95），不是错误率
.\k6\run.ps1 p02-trade-create dev baseline CREATE_DATA_FILE=data/create-trade/create-trade-invalid.csv
```

**每次只改一个变量。** manifest 会记下改了什么,三个月后还能解释。

---

# 阶段 6 · 结果怎么读

## 产物

```
k6\results\<runId>\
├── summary.txt     ← 先看这个
├── summary.json    原始指标，做曲线用
├── result.csv      逐笔明细，按标签切分用
├── k6.log          完整日志（含 preflight）
└── manifest.txt    这一轮到底跑了什么 ← 三个月后靠它解释数字
```

## 读 summary.txt 的顺序

**1. 先看结果分类,不是先看 P95:**

```
── 结果分类 ────────────────────────────────────
  ok              1523   业务成功
  technical          0   连接失败/超时/5xx ← 这才是性能结论
  business          12   HTTP 200 但业务拒绝 ← 多半是数据失效
  script             0   脚本 bug ← 结果作废
```

| 看到 | 意味着 | 该做什么 |
|---|---|---|
| `script > 0` | 脚本 bug | **本轮作废**,先修脚本 |
| `technical > 0` | 系统扛不住 | **这是性能结论**,写进报告 |
| 只有 `business > 0` | 多半数据失效 | 查数据,**别当性能问题上报** |

**2. 再看耗时**——摘要只统计**业务成功**的请求。
失败请求(尤其是快速拒绝)会把 P95 拉低,让容量看起来比实际好。

**3. 检查样本量警告** —— `< 100` 时 P95 不要写进报告。

## 按维度切分

`result.csv` 里有标签列,可以按成本因子切:

```powershell
Import-Csv k6\results\<runId>\result.csv |
    Where-Object { $_.metric_name -eq 'http_req_duration' -and $_.runPhase -eq 'main' } |
    Group-Object productType |
    ForEach-Object {
        $v = $_.Group.metric_value | ForEach-Object { [double]$_ } | Sort-Object
        [PSCustomObject]@{
            productType = $_.Name
            count       = $v.Count
            p50         = $v[[int]($v.Count * 0.50)]
            p95         = $v[[int]($v.Count * 0.95)]
        }
    }
```

`runPhase -eq 'main'` 把 preflight 那笔剔掉——**它是全场最慢的一笔**
(JIT 冷启动 + TCP 首次建连),不剔会顶高 max。

---

# 阶段 7 · 接进 Prometheus / Grafana

```powershell
$env:K6_PROMETHEUS_RW_SERVER_URL = "http://<prom-host>:9090/api/v1/write"
.\k6\run.ps1 p02-trade-create dev baseline
```

Prometheus 需要开启 remote-write 接收端(启动参数 `--web.enable-remote-write-receiver`)。

## 为什么值得折腾

**压测指标和后端指标进同一个 TSDB、同一根时间轴**,判读从"两个窗口来回切 + 手动对时"
变成"一个面板一眼看出":

| JMeter 侧现象 | 后端指标 | 结论 |
|---|---|---|
| TPS 平了,P95 涨,**CPU 空闲** | `hikaricp_connections_pending > 0` | **DB 连接池瓶颈** |
| TPS 平了,P95 涨,**CPU 空闲** | `tomcat_threads_busy == max` | 容器线程池打满 |
| TPS 平了,P95 涨,**CPU 满** | — | 真 CPU 瓶颈 |
| P95 周期性尖刺 | `jvm_gc_pause` 同步尖刺 | GC 停顿 |
| **全部资源都不饱和,TPS 就是上不去** | 全绿 | **串行段/锁** ← 只有 1 组 refdata 时大概率撞上 |

## 时间对齐

`run.ps1` 结束时会打印:

```
Grafana 时间范围（贴进 URL）:
  &from=1785283200000&to=1785283500000
```

直接拼进 Grafana URL,比手动拖时间轴准得多,截图也能复现。

> ⚠ **压测机和服务器必须对时(NTP)。** 时钟差 30 秒,两条曲线对不上,
> 上面那张判读矩阵全部作废。**开跑前先确认这一条。**

## 不接 Prometheus 也要做的事

至少把 `manifest.txt` 里的 `epochMillis` / `endEpochMillis` 记下来,
事后还能手工对齐 Grafana 的时间窗。

---

# 故障速查

## Windows 专属

| 现象 | 原因 | 解 |
|---|---|---|
| `无法加载文件 run.ps1，禁止运行脚本` | 执行策略 | `Set-ExecutionPolicy -Scope Process Bypass` |
| `k6 : 无法将"k6"项识别为...` | 装完没重开窗口 | **关掉 PowerShell 重开** |
| `ambiguous parameter -e` | 覆盖项加了 `-e` | 去掉,直接写 `VUS=8` |
| 中文全是问号/方块 | 控制台不是 UTF-8 | `chcp 65001`,或换 Windows Terminal |
| `bad interpreter: /usr/bin/env bash^M` | `.sh` 被检出成 CRLF | 见 [0.5](#05-拉代码--️-这一步有个坑) |
| `.dat` 上传后服务端解析失败 | **git 把二进制当文本改了行尾** | 同上,并跑 `python scripts\index-dat.py` 核对字节数 |
| PowerShell 报 `NativeCommandError` 但 k6 没输出 | `$ErrorActionPreference='Stop'` + k6 写 stderr | `run.ps1` 已规避;直接敲 `k6 run` 不受影响 |

## 通用

| 现象 | 原因 | 解 |
|---|---|---|
| `PREFLIGHT FAILED — csv 数据不可用` | CSV 还是 `TBC` | 填真值,见 [1.2](#12-填数据) |
| `.dat 未加载：xxx` | CSV 的 `datFile` 列与磁盘不一致 | `python scripts\index-dat.py` |
| `cannot open file` | 路径相对**脚本文件**,不是 cwd | 检查 `config\*.json` 的 `data.*` 路径 |
| `threshold for a non-existent metric` | 阈值指标名写错,或该指标本轮没产生 | 检查 `profiles\*.json`;`dropped_iterations` 报错就删掉那条 |
| 内存暴涨 / OOM | **`.dat` 按 VU 复制** | `VU 数 × 全部 .dat 字节数`,见 README「四个约束」 |
| `errClass=business` 全部失败 | refdata 已失效 | 重新采一次 curl |
| `taskId=NOT_FOUND` | 服务端 msg 文案改了 | 改 `lib\errors.js` 的正则 |
| 摘要说样本 < 100 | 跑太短 | `DURATION=1800s` |
| `dropped_iterations > 0` | maxVUs 不够,**到达率没打满** | 调大 `profiles\arrival.json` 的 `maxVUs`;**结果不可用** |

---

# 附:Windows 一页速查

```powershell
# 每个新窗口一次
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

# 自检（不需要 k6）
node k6\tests\csv.test.mjs
python scripts\validate.py

# 跑
.\k6\run.ps1 p02-trade-create dev smoke
.\k6\run.ps1 p02-trade-create dev baseline
.\k6\run.ps1 p02-trade-create dev baseline VUS=8 DURATION=300s
.\k6\run.ps1 p02-trade-create dev arrival  RATE=4

# 调试
k6 run --http-debug=full -e ENV=dev -e PROFILE=smoke k6\scenarios\p02-trade-create.js
k6 run --iterations 1 --vus 1 -e ENV=dev -e PROFILE=smoke k6\scenarios\p02-trade-create.js
k6 inspect k6\scenarios\p02-trade-create.js -e ENV=dev -e PROFILE=baseline

# 接 Grafana
$env:K6_PROMETHEUS_RW_SERVER_URL = "http://<prom>:9090/api/v1/write"
```
