# OREO 性能测试工程（k6）

以 **create-trade** 为样板搭起来的性能测试工程：一条业务链路（前端 E2E）+
单接口容量测试，其余 API 按同样的模式往里加。
选型依据见[测试计划 §1.1](../../docs/performance/oreo-performance-test-plan.zh.md)。

> 历史：本工程起初与 JMeter 版并行对照；2026-07-29 计划采纳 k6 为主线后，
> JMeter 存量（jmx / groovy / scripts）已从仓库移除，需要时在 git 历史里找。

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

# 6. 按到达率施压（开放模型）
./k6/run.sh p02-trade-create dev arrival RATE=2

# 7. 列表接口（S-09 扇出审计 / S-10 数据量伸缩的载体）
./k6/run.sh p05-trades-list dev smoke
./k6/run.sh p05-trades-list dev smoke BLOTTER_PAGE_SIZE=500

# 8. E2E 前端链路（refdata 地址确认前先用 static 降级，报告须标注偏差）
./k6/run.sh s01-create-trade-e2e dev smoke REFDATA_MODE=static
```

（覆盖项一律裸 `KEY=value`，不加 `-e` —— 与 run.ps1 保持同一副命令行。）

送指标进已有的 Prometheus：

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://<prom-host>:9090/api/v1/write \
  ./k6/run.sh p02-trade-create dev baseline
```

时间序列曲线（k6 web dashboard）**默认开启**：跑时 `http://127.0.0.1:5665`
实时看，跑完导出 `results/<runId>/report.html`（短运行如 smoke 会跳过导出；
`K6_WEB_DASHBOARD=false` 关闭）。⚠ 它的错误率是 HTTP 层口径，
**判定以 summary.txt 的三类错误为准**，dashboard 只用来看曲线形态。

---

## 目录结构：三维正交 + 四层划分

```
k6/
├── run.sh / run.ps1                同一套逻辑的两份实现（Mac / Windows）
├── config/<env>.json               维度二：环境（打哪个环境）
├── profiles/<profile>.json         维度三：负载（施加多大压力）
├── scenarios/*.js                  维度一：计划（测什么，可运行的薄壳）
├── journeys/*.js                   用户路径：把 steps 串成一次完整动作
├── steps/<svc>/<domain>/*.js       原子步骤：一个 API 一个文件（唯一契约）
├── setup/preflight.js              开跑前守卫：数据校验 + 真建一笔
├── lib/                            config 合并 / 数据装载 / 三类错误 / 摘要
├── data/                           测试数据（JSON 为源，契约见 lib/rows.js）
│   ├── create-trade/               create 用例池（datFile → data/dat/）
│   ├── lifecycle-events/           生命周期事件池（供未来 p06）
│   └── dat/                        .dat 样本，按 productType 分目录
├── scripts/index-dat.py            .dat 与数据文件的对账（引用完整性检查）
├── tests/*.test.mjs                纯逻辑单测（node 直接跑，不需要 k6）
└── results/<runId>/                每次运行：manifest + 摘要 + 明细 csv + report.html
```

三维正交的意思：计划 × 环境 × 负载互相独立，任意组合，
`./k6/run.sh <plan> <env> <profile>` 就是这三维的坐标。

**每一层只做一件事**：scenarios 不定义请求（import journey/steps），
steps 不定义负载（executor 在 profiles），环境地址只在 config。
改任何一维不碰其他两维。

---

## 四个必须知道的 k6 约束（诚实版）

### ⚠ 1. `.dat` 按 VU 复制，内存是乘法

```
内存 ≈ VU 数 × 所有被引用 .dat 的总字节数
```

`open()` 只能在 init 上下文调用，而 `SharedArray` **只能存 JSON 可序列化数据**，
二进制放不进去。

| 场景 | 内存 | 结论 |
|---|---|---|
| 20 VU × 3 个 5MB | 300 MB | 可接受 |
| 20 VU × 3 个 50MB | **3 GB** | 不可接受 |

**这是 k6 的真实劣势**（对比：流式读盘的工具没有这个问题）。
撞上了再优化——`k6/experimental/fs` 惰性读取，或按 productType 拆 scenario。
**先量再优化**，别提前设计。

### ⚠ 2. 标签是**指标维度**，不是明细列

k6 的 tag 会成为指标的维度——**高基数标签会让内存和 Prometheus 存储爆炸**。

| 可以打标签 | **绝对不要** |
|---|---|
| `runPhase` `caseId` `productType` `errClass` | `tradeId` `taskId` `tradeReference` |

需要逐笔明细用 `--out csv`（run.sh 已默认开），不要塞进 tag。

### ⚠ 3. 没有 GUI

不写代码的人就用不了了。这是不可逆的取舍，选型时已让团队知情（计划 §8 风险 9）。
看请求体靠 `--http-debug=full` 日志（HANDBOOK §4.1）。

### ⚠ 4. `open()` 的路径以**脚本文件**为基准

不是当前工作目录。数据路径都以 `k6/` 为根（`lib/data.js` 的 ROOT），
config 里的 `data/...` 也按这个根解析。

---

## 开放模型：为什么两种都要跑

```
闭合模型（constant-vus / ramping-vus）
  N 个 VU → 发请求 → 等响应 → 再发下一个
  ⚠ 服务端变慢时压力也跟着变慢 —— 压力机自己踩了刹车

开放模型（constant-arrival-rate / ramping-arrival-rate）
  请求按 λ 到达，不管前一笔有没有回来
  → 服务端跟不上时队列真实堆积
```

**OREO 的负载天然是一个到达率**：120 笔/天由交易员各自提交，
没有人会等上一笔完成才提交下一笔。

服务端从 2 秒劣化到 20 秒时：

| | 结果 |
|---|---|
| 闭合（8 VU） | `8 × 1/20s = 0.4 TPS` ← 压力自动降了 10 倍，**问题被掩盖** |
| 开放（λ 固定） | 仍按 λ 到达 → 队列堆积 → 响应时间雪崩 ← **真实后果暴露** |

两种都要跑：
- `ladder`（闭合）→ **找容量拐点**
- `arrival`（开放）→ **验证生产 λ 下 P95 达标吗，以及过了拐点会怎样**

> ⚠ `arrival` profile 有一条 `dropped_iterations: count==0` 的阈值。
> 它 > 0 说明 `maxVUs` 不够、到达率**没打满**——这时结果不可用，
> 不是"系统扛住了"。这是开放模型独有的、必须盯的信号。

⚠ 数据副作用：p02 / s01 每次迭代**真实创建一笔 trade**。
长时运行一律用 `arrival`（按业务 λ），禁止 constant-vus 满打——
4 VU 闭合跑 4 小时 ≈ 19 万笔，按 λ 只有约 1,600 笔（计划 §4）。

---

## 怎么测脚本本身

分层验证，别把所有问题都留到真实压测时一起炸：

| 层 | 怎么测 | 现状 |
|---|---|---|
| **纯逻辑**（rows.js / csv.js） | `node k6/tests/*.test.mjs` | ✅ 12 + 11 个用例 |
| **判定逻辑**（errors.js） | 需 k6 运行时；可写一个喂假响应的 scenario | ⬜ 待补 |
| **请求构造**（create-trade.js） | `k6 run --http-debug=full` 看实际发出的 multipart | ⬜ 手工 |
| **端到端** | `./k6/run.sh p02-trade-create dev smoke` | ✅ |

**纯逻辑要和 k6 API 隔离**（`lib/rows.js`、`lib/csv.js` 不 import 任何 `k6/*`），
隔离开才能用 node 直接测。

---

## 待办

- [ ] 填 `data/create-trade/create-trade-data.json` 的真值——归属字段
      （portfolioId / counterpartyFmId / counterpartyName）内嵌在用例行里，
      采集方式见 `data/create-trade/README.md`；真值还在旧 CSV 里的机器可先
      `CREATE_DATA_FILE=<csv 路径>` 顶住
- [ ] 把真实 `FX_TRF.dat` 放进 `data/dat/products/FX_TRF/`，跑 `./scripts/index-dat.py` 对账
- [ ] 跑通 `smoke`，用 `--http-debug=full` 核对发出的 multipart 与真实 curl 一致
- [ ] p05 首次 smoke 人工核对返回行数 == 请求 size（分页参数名是推断值）
- [ ] 量 `.dat` 加载的实际内存占用（`k6 run` 会打印）
- [ ] 补 `errors.js` 的判定逻辑测试
