# Grafana 看板指标详解（perf-trade-business）

逐面板解释：展示什么、有什么作用、如何实现。当前 14 面板 / 4 变量 / 2 链接。
理论框架对照见 `metrics-theory-and-coverage.md`；对不上数的排查路径见文末口径表。

## 0. 先读：两种口径

全板只有两种数据口径，每个面板的 description 都标了归属：

| 口径 | 机制 | 特性 |
|---|---|---|
| **精确（对账区）** | counter 终值：`max_over_time(...[$__range])` 取时间窗内计数器最大值（即该轮终值） | 必须与该轮 summary 逐笔相等，对不上=查询或时间窗错 |
| **趋势（曲线区）** | k6 每 5s 推送一次窗口快照（分位数是当窗样本算的 gauge） | 只回答"何时/什么形状"；分位数不可聚合，与 summary 有差属预期 |

时长单位约定：k6 Prometheus 输出为**秒**（Prometheus 惯例），所有 duration 面板 unit 配 `s` 由 Grafana 自动渲染成 ms；新增面板勿配 `ms`（历史事故见 env-checklist）。

## 1. 变量与链接

| 变量 | 实现 | 作用 |
|---|---|---|
| `env` / `profile` | 从 testid 取值正则抽取第 2/3 段（testid 格式 `场景_环境_profile_时间戳`），零 k6 侧改动、历史数据可用 | 巡检过滤：如 profile=load 只看达标轮，排除 ladder 摸底轮污染历史 |
| `testid` | `label_values` 级联 env+profile；All 只展开到过滤后集合 | 全板唯一过滤主键，一轮压测=一个 testid |
| `service` | `label_values(jvm_cpu_recent_utilization_ratio, service_name)` 自动发现 | 服务端面板过滤；真实服务名不入库 |

链接：**19665**（官方板，k6 内建指标细节）；**Server Metrics (backend)**（占位 uid 待替换，`keepTime` 自动携带压测时间窗跳后端板）。

## 2. 对账区（y0，Leader 第一眼）

四张 stat 卡，全部精确口径，`unit: none + decimals 0` 禁缩写（1326 不显示 1.33k）：

| 卡 | 查询 | 作用 |
|---|---|---|
| Total Requests | `sum(max_over_time(k6_http_reqs_total[$__range]))` | 该轮总请求数，= summary samples |
| Success | `sum(max_over_time(k6_perf_ok_total[$__range]))` | 业务成功笔数（三分类引擎的 OK 计数，不是 HTTP 200 数） |
| Request Failures | technical / business / script 三条同款查询合一张宽卡（value_and_name 并排） | 三分类失败账目；`or vector(0)` 保证无错误时显示 0 而非 No data |
| Success Rate | Success ÷ Total | 业务成功率，= verdict 判定的同源数字 |

**用法纪律**：每轮跑完先核对这四张卡与 summary 三分类逐项相等（env-checklist 对账步骤），相等则本板数据链可信，再看曲线。

## 3. Performance Overview + Peak RPS（y4，一眼看全场）

**Performance Overview**（对齐官方 19665 同名面板，业务口径改造）：六条序列同框——

| 序列 | 查询 | 轴/样式 | 讲什么 |
|---|---|---|---|
| vus | `sum(k6_vus)` | 左，绿 | 负载投递 |
| maxVUs cap | `sum(k6_vus_max)` | 左，灰虚线 | open 模型预警：vus 贴近 cap = 速率将失真 |
| rps | `sum(rate(k6_http_reqs_total[$__rate_interval]))` | 右 reqps，黄 | 吞吐 |
| success p95 | `avg(k6_perf_success_duration_p95)` | 右 s，蓝 | 响应时间（成功样本口径——19665 原版是全体请求，此处特意换源） |
| dropped/s | `sum(rate(k6_dropped_iterations_total[...]))` | 左，橙 | **有效性守卫**：>0 = 施压机跟不上目标速率，该轮结论打折 |
| http errors/s | `sum(rate(k6_http_reqs_total{expected_response="false"}[...]))` | 左，红虚线 | HTTP 层错误速率；稀疏错误可能不渲染（rate 需窗口内 ≥2 样本），精确计数看归因面板 |

**Peak RPS**（stat，19665 同款）：`max(sum(irate(k6_http_reqs_total[$__rate_interval])))`——瞬时窗口速率峰值。**summary 没有这个数**（summary 只有全程平均 TPS）：对照 profile 目标速率读，峰值远超目标=投递毛刺；ladder 轮=顶阶天花板。趋势口径，故不在对账区。

## 4. Success Duration Percentiles（y12，全宽，SLA 主图）

每 API 的 p50/p95/p99 三条曲线：`k6_perf_success_duration_{p50,p95,p99}{...}`，legend `{{name}} pXX`。

- **数据源是 `perf_success_duration`**——只统计业务成功请求的耗时（三分类引擎入账），快速拒绝不污染分位数，SLA 判定同源；
- 红色参考线 = SLA 水位（阈值线 0.3s 占位，SLA 校准后手动同步，按秒填）；
- p95 与 p50 张开 = 慢路径开始出现；作用是回答"分位数**何时**恶化、什么形状"——轮次级精确数字在 summary。

## 5. 失败归因区（y20，排障入口）

**Failure Attribution (by reason)**（bargauge）：`topk(10, sum by (reason)(max_over_time(k6_perf_err_*_total[$__range])))` 两类各取前十。精确口径条形图而非 rate 曲线——**3 个错误也显示 3**（时序 rate 对稀疏错误序列渲染为空的教训）。reason 是有界枚举：`net-*`=连接/超时类、`http-4xx/5xx`=状态码类、`code-*`=业务拒绝码。**读法**：`net-*` 涌现=系统扛不住；`http-429`=限流（查身份池预算）；`http-404` 成片=ID 池过期；`code-*` 集中=测试数据问题。

**Errors Over Time**（累计阶梯曲线）：三分类 counter 原值随时间。累计曲线的斜率变化点 = 错误开始涌现的时刻——与 Capacity 行对照定位"错误从哪一级负载开始"。

## 6. Capacity Analysis（y28，容量三联，ladder/stress 轮专用）

经典性能曲线的看板化。常规恒速轮这行"平"是正常的——它只在负载扫升的轮次里讲故事。

| 面板 | 实现 | 读法 |
|---|---|---|
| Load / Throughput / Response Time | vus + rps + success p95 三线同框（时间轴；ladder 中负载单调升，时间轴即负载轴代理） | RPS 增幅掉队 + p95 翘头的位置 = 拐点 |
| Response Time vs Load (XY) | `joinByField(Time)` 把 vus 和 p95 按时间戳配对成散点 | 教科书 X 轴（负载）版本；每点=一个 5s 窗口；预热期点会虚高低负载区，读平台段 |
| Throughput vs Load (XY) | 同法配对 vus 和 rps | 吞吐饱和曲线；散点趋平的起点 = 物理拐点 |

p95 轴均钉 0（softMin），防自动缩放把 ±3% 噪声放大成假趋势。

## 7. Run History + Server Utilization（y36，跨轮与服务端）

**Run History (per testid)**（表格）：全板唯一**跨轮**视图。四条 instant 查询按 testid join：Total / Success / Success Rate（精确口径，同对账区查询）+ p95 approx（`avg_over_time` 窗口均值——方向参考，特意标 approx）。**用法**：env+profile 过滤 + testid=All + 宽时间窗（7d/30d），一行一轮读回归方向；也是基线轮 vs 当前轮的肉眼对照入口（基线判定权威在 summary）。

**Server Utilization / Saturation**：教科书曲线缺的 U/S 两条线（k6 与服务端指标同一 Prometheus 实例，2026-08-04 确认）——

- `jvm_cpu_recent_utilization_ratio{service_name=~"$service"}`：**Utilization**，JVM 进程视角 CPU（多服务同机时比主机 CPU 更能归因）；90% 红色警戒参考线（threshold line，不是数据序列）；
- `hikaricp_connections_pending`（右轴）：**Saturation**，DB 连接池排队数——排队比 CPU 到顶更早报警；拐点处谁先抬头谁是瓶颈嫌疑人。

注意服务端是 **30s 抓取口径**（k6 侧 5s 推送），对齐趋势不对齐毛刺。

## 8. 有意不展示的（去过又删掉的，防止回潮）

| 曾有 | 删因 |
|---|---|
| Live 行 | 跑中盯盘职责归 k6 web dashboard(:5665)；stale marker 使跑后 instant 查询无数据 |
| Business TPS 卡 | 分母口径（引擎时长 vs URL 时间窗）与 summary 有 ~2s 差，对不上就有歧义 |
| Query Rows 面板 | 空库守卫判定权威在 k6 阈值（`perf_trades_rows avg>0`），面板是单场景专属诊断视图 |
| All vs Success p95 | "秒拒还是超时"由归因面板 reason 前缀（net-* vs http-*/code-*）更直接回答；精确对比在 summary 双延迟行 |
| per-API 排行榜（19665 Requests by URL 类比） | 单接口轮次无行可排；P1c mixed/journey 后按本板口径实现（spec §12 已记） |

## 9. 对不上数时的排查顺序

1. **是分位数吗** → 结构性差异（5s 窗口 gauge 不可聚合），趋势区只看形状，权威在 summary；
2. **是计数吗** → 必须相等：确认查询用 `max_over_time(...[$__range])`、时间窗覆盖整轮（用 run.sh 输出的 epochMillis 定位）；
3. **是显示吗** → 单位缩写（short 的 1.33k）、秒/毫秒（duration 一律 unit `s`）、时间窗分母（深链 from/to 含 runner 启停 ~2s）。
