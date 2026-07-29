# k6 版 create-trade —— 主线工程

**这个工程起初是与 JMeter 对照的决策 spike；自 2026-07-29 起[测试计划](../../docs/performance/oreo-performance-test-plan.zh.md)已采纳 k6 为主线**（选型依据见计划 §1.1），JMeter 存量降为交叉验证与迁移源、冻结只修不增。

它**刻意与 JMeter 版保持结构对应**——四层划分、三维正交、同样的 preflight 守卫、
同样的三类错误分离,**并且读同一份 `data/` 数据**(k6 读 JSON 源,
JMeter 读由它生成的 CSV —— `scripts/data-sync.py` 负责生成与对账)。
只有这样两边跑出来的数字才可比,对比才有意义。

---

## 快速开始

```bash
# 1. 装 k6
brew install k6                        # macOS
winget install k6 --source winget      # Windows
# Linux 见 https://grafana.com/docs/k6/latest/set-up/install-k6/

# 2. 先跑脚本自检（不需要 k6）
node k6/tests/rows.test.mjs && node k6/tests/csv.test.mjs

# 3. smoke
./k6/run.sh p02-trade-create dev smoke

# 4. 单线程基线
./k6/run.sh p02-trade-create dev baseline

# 5. 阶梯找拐点（闭合模型）
./k6/run.sh p02-trade-create dev ladder

# 6. 按到达率施压（开放模型 —— JMeter 默认做不到）
./k6/run.sh p02-trade-create dev arrival RATE=2

# 7. 列表接口（S-09 扇出审计 / S-10 数据量伸缩的载体）
./k6/run.sh p05-trades-list dev smoke
./k6/run.sh p05-trades-list dev smoke BLOTTER_PAGE_SIZE=500

# 8. E2E 前端链路（refdata 地址确认前先用 csv 降级，报告须标注偏差）
./k6/run.sh s01-create-trade-e2e dev smoke REFDATA_MODE=csv
```

（覆盖项一律裸 `KEY=value`，不加 `-e` —— 与 run.ps1 保持同一副命令行。）

送指标进你们已有的 Prometheus:

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://<prom-host>:9090/api/v1/write \
  ./k6/run.sh p02-trade-create dev baseline
```

---

## 目录结构:与 JMeter 版一一对应

```
k6/
├── run.sh                          ← scripts/run.sh
├── config/<env>.json               ← config/<env>.properties      维度二：环境
├── profiles/<profile>.json         ← profiles/<profile>.properties 维度三：负载
├── scenarios/p02-trade-create.js   ← jmx/api/p02-trade-create.jmx  维度一：计划（可运行）
├── setup/preflight.js              ← jmx/fragments/setup/csv-refdata-preflight.jmx
│                                     + groovy/validate-csv-refdata.groovy
│                                     + groovy/preflight-policy.groovy
├── steps/workers/trade-management/
│   └── create-trade.js             ← jmx/fragments/steps/.../create-trade.jmx
│                                     + groovy/build-trade-payload.groovy
│                                     + groovy/select-refdata.groovy
│                                     + groovy/resolve-dat-file.groovy
├── lib/
│   ├── config.js                     三维合并（对应 -q/-q/-J 的优先级链）
│   ├── data.js                       ← 两个 CSV Data Set + ${datDir}
│   ├── errors.js                     ← groovy/assert-create-response.groovy
│   ├── csv.js                        （JMeter 内置，这里要自己写）
│   └── summary.js                    ← -e -o 的 HTML 报告
├── tests/csv.test.mjs                （JMeter 侧没有对应物 —— 这正是重点）
└── results/                          ← results/
```

**数据文件不复制,直接读 `../data/`。** 两套框架用同一份 CSV 和同一个 `.dat`,
否则"数字对不上"会分不清是工具差异还是数据差异。

---

## 概念映射表

| JMeter | k6 | 备注 |
|---|---|---|
| setUp Thread Group | `setup()` | k6 的返回值直接拷给每个 VU |
| Thread Group | `options.scenarios` | |
| Test Fragment + Include Controller | ES module + `import` | **加载期嫁接 → 普通模块解析** |
| CSV Data Set | `SharedArray` + 全局游标取模 | |
| `shareMode.all` | `exec.scenario.iterationInTest` | 语义一致 |
| JSR223 PreProcessor | 发请求前的函数调用 | |
| JSR223 Assertion | `classifyCreate()` + 自定义 metric | |
| Response Assertion | 同上(合并了) | |
| JSON PostProcessor | `res.json()` | |
| Regex Extractor | `RegExp.exec()` | |
| Transaction Controller | **不需要** | 见下方「三个消失的问题」 |
| `${__P(name,default)}` | `__ENV` + config 合并 | |
| 计划级 / 线程组级 UDV | 模块常量 / `cfg` | |
| `props`(跨线程组) | `setup()` 返回值 | **不再需要全局属性** |
| `-Jsample_variables` | tags | ⚠ 基数约束不同,见下 |
| `-e -o` HTML 报告 | `handleSummary()` | |
| `validate.py` 的 R1/R2 | 模块系统天然保证 | |

---

## 三个在 k6 里**消失**的问题

这些不是"k6 更好用"的感觉,是三个具体的、你已经踩过的坑不复存在:

### 1. 没有"事务行 + 采样行"双计数

JMeter 的 `TransactionController.parent=false` 会额外产生一行样本,
算 TPS 时**绝不能把两者相加**,HTML 报告的 `Total` 行也包含两者。

k6 里 `http_reqs` 就是请求数,没有第二个计数。

### 2. preflight 不再污染统计,也不再吃掉 CSV 第一行

JMeter 里 setUp 的 preflight 和主循环**标签完全相同**,按标签聚合时分不开;
而它恰好是全场最慢的一笔(JIT 冷启动 + TCP 首次建连),会顶高 `Max`。
过滤要靠 `runPhase` 列,而那列只有 `run.sh` 注入 `-Jsample_variables` 才有——
**GUI 里根本剔不掉**。

k6 的 `setup()` **不占用 scenario 迭代**:
- 不消耗 CSV 行(JMeter 里主循环线程 0 拿到的是第 2 行)
- 自带 `runPhase=setup` 标签,天然可分

### 3. 契约不会出现第二份

JMeter 靠"Test Fragment + Include + `validate.py` 的 R2 规则"三件套来保证
create 的请求只定义一次(早期版本真的在 preflight 里复制过一份 sampler)。

k6 里 `import { createTrade }` 就是全部——**没有机制能让它出现两份**。

---

## 四个必须知道的 k6 约束(诚实版)

### ⚠ 1. `.dat` 按 VU 复制,内存是乘法

```
内存 ≈ VU 数 × 所有被引用 .dat 的总字节数
```

`open()` 只能在 init 上下文调用,而 `SharedArray` **只能存 JSON 可序列化数据**,
二进制放不进去。

| 场景 | 内存 | 结论 |
|---|---|---|
| 20 VU × 3 个 5MB | 300 MB | 可接受 |
| 20 VU × 3 个 50MB | **3 GB** | 不可接受 |

**这是 k6 相对 JMeter 的真实劣势**(JMeter 是每次请求流式读盘)。
撞上了再优化——`k6/experimental/fs` 惰性读取,或按 productType 拆 scenario。
**先量再优化**,别提前设计。

### ⚠ 2. 标签是**指标维度**,不是 CSV 列

JMeter 的 `sample_variables` 写进 jtl 的列,多少种值都无所谓。
k6 的 tag 会成为指标的维度——**高基数标签会让内存和 Prometheus 存储爆炸**。

| 可以打标签 | **绝对不要** |
|---|---|
| `runPhase` `caseId` `productType` `pairId` `errClass` | `tradeId` `taskId` `tradeReference` |

需要逐笔明细用 `--out csv`(run.sh 已默认开),不要塞进 tag。

### ⚠ 3. 没有 GUI

不写代码的人就用不了了。这是不可逆的取舍,选型时必须让团队知道。
看请求体这件事在 k6 里靠日志,不如 View Results Tree 直观。

### ⚠ 4. `open()` 的路径以**脚本文件**为基准

不是当前工作目录。这与 JMeter 的 Include Controller 按 cwd 解析正好相反——
**JMeter"不 cd 就静默 0 sample"的坑在 k6 里不存在**,但相对路径要从 `.js` 文件的位置算。

---

## 开放模型:JMeter 默认给不了的东西

```
闭合模型（JMeter 默认 Thread Group、k6 的 constant-vus / ramping-vus）
  N 个 VU → 发请求 → 等响应 → 再发下一个
  ⚠ 服务端变慢时压力也跟着变慢 —— 压力机自己踩了刹车

开放模型（k6 的 constant-arrival-rate / ramping-arrival-rate）
  请求按 λ 到达，不管前一笔有没有回来
  → 服务端跟不上时队列真实堆积
```

**OREO 的负载天然是一个到达率**:120 笔/天由交易员各自提交,
没有人会等上一笔完成才提交下一笔。

服务端从 2 秒劣化到 20 秒时:

| | 结果 |
|---|---|
| 闭合(8 VU) | `8 × 1/20s = 0.4 TPS` ← 压力自动降了 10 倍,**问题被掩盖** |
| 开放(λ 固定) | 仍按 λ 到达 → 队列堆积 → 响应时间雪崩 ← **真实后果暴露** |

两种都要跑:
- `ladder`(闭合)→ **找容量拐点**
- `arrival`(开放)→ **验证生产 λ 下 P95 达标吗,以及过了拐点会怎样**

JMeter 要做开放模型得装 `jpgc` 的 Arrivals Thread Group 插件。

> ⚠ `arrival` profile 有一条 `dropped_iterations: count==0` 的阈值。
> 它 > 0 说明 `maxVUs` 不够、到达率**没打满**——这时结果不可用,
> 不是"系统扛住了"。这是开放模型独有的、必须盯的信号。

---

## 怎么测脚本本身

这是换 k6 的核心理由之一,不能只停留在口头。

| 层 | 怎么测 | 现状 |
|---|---|---|
| **纯逻辑**(csv.js) | `node k6/tests/csv.test.mjs` | ✅ 14 个用例 |
| **判定逻辑**(errors.js) | 需 k6 运行时;可写一个喂假响应的 scenario | ⬜ 待补 |
| **请求构造**(create-trade.js) | `k6 run --http-debug=full` 看实际发出的 multipart | ⬜ 手工 |
| **端到端** | `./k6/run.sh p02-trade-create dev smoke` | ✅ |

对比一下 JMeter 侧:`groovy/*.groovy` 的**唯一验证方式是跑一次真实压测**——
而那一次跑批同时在验证网络、环境、数据、服务端和脚本,出错时分不清是谁的问题。

**纯逻辑要和 k6 API 隔离**(`lib/csv.js` 不 import 任何 `k6/*`),隔离开才能测。

---

## 待办

- [ ] 填 `data/refdata/refdata-pairs.json` 的 R001(值已知,见 `HANDBOOK.zh.md` 阶段 0;旧 CSV 里已有真值的话 `python scripts/data-sync.py --from-csv --write` 直接搬)
- [ ] 把真实 `FX_TRF.dat` 放进 `data/dat/products/FX_TRF/`,跑 `./scripts/index-dat.py --write`
- [ ] 跑通 `smoke`,用 `--http-debug=full` **逐字节比对**两边发出的 multipart
- [ ] 两边各跑一次 `baseline`,**对比 P50/P95** —— 对不上说明有一方脚本有问题,先查清再往下走
- [ ] 量 `.dat` 加载的实际内存占用(`k6 run` 会打印)
- [ ] 补 `errors.js` 的判定逻辑测试
