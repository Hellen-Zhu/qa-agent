# 压测数字 ↔ OREO 服务端指标（Grafana + Prometheus）

> 压测端的数字单独看只能说"慢"，说不出"**为什么**慢"。
> 一份报告的价值不在"P95 是 3.2 秒"，而在
> "TPS 卡在 8 不动，同时 `hikaricp_connections_pending` 涨到 6、CPU 才 35% —— 瓶颈是连接池"。
> 这份文档讲的就是怎么把后一句话说出来。

适用于 k6 工程（runner 跑完会打印本次运行的 Grafana 时间范围）。

---

## 0. 这块看板的形状

看板：**OREO – Microservice Observability with Host**，数据源 `OREO-Prometheus`。
模板变量：`Host` / `Service` / `Data Source` / `Interval`。

> 以下结构按 **2026-07-28 的截图**记录。面板会改，跑之前自己再对一眼。

| 分区 | 面板 | 指标 |
|---|---|---|
| **Service Health & Uptime** | Service Status / Service Uptime | 5 个服务的 UP/DOWN 与运行时长 |
| **HTTP Traffic** | Request Rate、Error Rate 5xx %、Latency p50/p95/p99、Rate by Method+Route、p99 Latency by Route | `http_server_request_duration_seconds_*`<br>标签 `http_request_method` / `http_response_status_code` / `http_route` |
| **gRPC Inter-Service Calls** | Server 入站速率 / Client 出站速率 / 两侧 p50·p95·p99 | `rpc_server_duration_milliseconds_*`<br>`rpc_client_duration_milliseconds_*` |
| **JVM & Resources** | Heap Used vs Limit、Non-Heap、CPU、Thread Count、GC Duration rate、GC Collections rate | `jvm_memory_*` / `jvm_cpu_recent_utilization_ratio` / `jvm_thread_count` / `jvm_gc_duration_seconds_{sum,count}` |
| **Database – HikariCP** | Active/Idle/Max、Pending/Timeouts、Acquire Time、Usage Time | `hikaricp_connections_*`，标签 `pool` |

五个服务：`oreo-workers-backend`（被测主体）、`oreo-gateway`、`oreo-risk-engine`、
`oreo-notification`、`oreo-user-center`。
序列标签是 **`service_name`** 和 **`host_name`**（不是 `job` / `instance`）。

### 这四层就是归因的下钻顺序

```
HTTP        ← 症状在这层出现（P95 涨了）
  ↓
gRPC        ← 是不是下游拖的？（risk-engine / user-center）
  ↓
JVM         ← 是不是自己算不过来？（CPU / GC / 线程）
  ↓
HikariCP    ← 是不是在等连接？（pending > 0）
```

**从上往下找第一个"饱和"的层。** 找到就停，不用再往下 —— 下面的层多半只是没活干。

---

## 1. 开跑前必须先确认四件事

跳过这四件，跑出来的图会指向错误的结论。

### 1.1 `Host` 下拉里有几台？

截图里选的是单台 `uklvadpta0005a`。**如果服务跑在多台上而你只选一台**，
你看到的是 1/N 的负载，而压测端打的是全量 —— 两边对不上，且看板这边永远显得很闲。

> 展开 Host 下拉数一下。不止一台就选 `All`，同时接受一个代价：
> 各实例的曲线会叠在一起，单实例的饱和会被平均掉。
> 更好的做法是**先 All 看总量，发现异常再切到单台看是哪个实例**。

### 1.2 分辨率够不够 —— 决定你每级要跑多久

看板上有两个不同的 30s，别混：

| 位置 | 是什么 | 影响 |
|---|---|---|
| `Interval 30s` 下拉 | 模板变量，多半用作 `rate(...[$interval])` 的窗口 | 窗口越大越平滑，**短尖峰会被抹掉** |
| 右上角 `Refresh 30s` | 浏览器自动刷新 | 只影响你盯屏时的更新频率 |
| Prometheus `scrape_interval` | **真正的采样分辨率上限** | 决定一段时间内最多有几个数据点 |

第三个才是硬约束，而它不在看板上。确认方式：

```promql
# 每个 target 的实际抓取间隔（秒）
rate(prometheus_target_interval_length_seconds_sum[5m])
  / rate(prometheus_target_interval_length_seconds_count[5m])
```

然后算一次：

```
后端数据点数 = 单级时长 ÷ scrape_interval
```

**≥ 20 个点才看得出"上升 → 平台期"的形状。**
scrape 若是 15s，单级至少 300s；若是 30s，单级至少 600s。

> ⚠ 这条和压测端的样本量纪律（`样本数 = 线程数 × 时长 ÷ 单笔耗时`，≥100）
> 是**两个独立的下限，取更严的那个**。
> 常见的错误是只算了压测端够 100 个样本就开跑，结果后端只有 8 个数据点，
> 曲线看着像噪声，什么也说明不了。
>
> 跑之前把两个数都算出来，写进 manifest 旁边的笔记。

### 1.3 两个面板是空的

截图里 **DB Connection Acquire Time** 和 **DB Connection Usage Time** 有图例、没曲线。

大概率原因：Micrometer 的这两个 Timer 只导出了 `_sum` / `_count` / `_max`，
**没有 `_bucket`** —— 而 `histogram_quantile()` 必须要有 bucket。

这不是小事：**它俩正好是区分"在等连接"和"查询本身慢"的那把尺子。**
没有它们，`pending > 0` 只能告诉你在排队，说不出排了多久。

两条路：

```promql
# 权宜之计：用 sum/count 求平均值（拿不到 p95，但比没有强）
rate(hikaricp_connections_acquire_seconds_sum{service_name="oreo-workers-backend"}[1m])
  / rate(hikaricp_connections_acquire_seconds_count{service_name="oreo-workers-backend"}[1m])
```

根治：请开发在 Spring 配置里打开直方图，重启后 `_bucket` 才会出现。

```properties
management.metrics.distribution.percentiles-histogram.hikaricp.connections.acquire=true
management.metrics.distribution.percentiles-histogram.hikaricp.connections.usage=true
management.metrics.distribution.percentiles-histogram.http.server.requests=true
```

> 第三行同样重要：没有它，HTTP 的 p95/p99 面板要么是空的，要么用的是
> Micrometer 客户端预计算的分位数 —— 那种分位数**不能跨实例聚合**
> （把两台机器的 p95 加起来求平均是没有意义的），多实例场景下数字直接不可信。

### 1.4 空载噪声基线

截图里最反直觉的一处：**几乎没有流量，CPU 却有多次打到 100% 的尖峰**
（oreo-workers-backend / gateway / risk-engine 各有几次）。

不先记下来，压测时看到 100% 你会当成自己压出来的。

开跑前先**空跑 10 分钟**，把这几个数抄进 manifest 旁边：

| 记什么 | 空载值 |
|---|---|
| CPU 尖峰频率与幅度 | |
| Heap used（各服务） | |
| Thread count（各服务） | |
| GC Collections rate | |
| DB active / idle | |
| HTTP request rate（轮询底噪） | |

> 顺带：截图上 Uptime 是 **4.15 天**，说明服务没重启过，JIT 和缓存都是热的。
> 这对测量是好事，但也意味着**你测不到冷启动**，报告里别声称"包含冷启动场景"。

---

## 2. ⚠ 这块看板看不见业务失败

**这是最重要的一条。**

`POST /trades/create` 业务失败时**照样返回 HTTP 200**，业务状态在 body 的 `code` / `status` 里。

后果：

- **HTTP Error Rate – 5xx %** 面板会稳稳地显示 **0%**
- **HTTP Latency p95** 面板会显示一个**很好看**的数字（业务拒绝返回得快）
- 而实际上**一笔 trade 都没建成**

看板这边所有指标全绿 —— 只有压测端的 `oreo_err_business` 计数能看见
（k6 摘要的"三类错误"段，见 `k6/lib/summary.js`）。

> 所以口径是固定的：
> **技术层结论看 Grafana，业务层结论看 `errClass`，两边缺一不可。**
> 只贴 Grafana 截图的性能报告，在 OREO 上是不成立的。

同理，**服务端的 p95 也不是你的 P95**。它只算 HTTP 处理时间，不含：
连接建立、`.dat` 上传的传输时间、客户端排队。差值本身就是一个信息（见 §8）。

---

## 3. 跑之前 / 跑之中 / 跑之后

### 跑之前（10 分钟空载）

填 §1.4 那张表。顺手确认 5 个服务全 UP、Uptime 没有异常归零。

### 跑之中（只盯三个面板，别贪多）

| 面板 | 看什么 | 不对就中止 |
|---|---|---|
| **HTTP Request Rate** | 曲线有没有真的抬起来 | 压力根本没进来（打错服务 / 全被拒） |
| **DB Connections – Pending** | 有没有离开 0 | 离开 0 就是连接池开始排队 —— 这是 OREO 最可能先饱和的地方 |
| **CPU Usage** | 是不是贴着 100% | 贴住了就是算力天花板，再加并发只是排队 |

> 盯屏不是为了读数（读数跑完再读），是为了**及时中止一次明显跑废的运行**，
> 省下几百笔垃圾 trade。

### 跑完（按 §0 的四层往下钻）

把 runner 打印的时间范围贴进 URL：

```
&from=<epochMillis>&to=<endEpochMillis>
```

两个数都在 `results/<runId>/manifest.txt` 里，runner 最后也会直接打出来。

---

## 4. 归因决策表

前提：压测端已经看到 **TPS 不再随并发上升，而 P95 开始陡增**（拐点）。
接下来在看板上找是哪一层先饱和。

| 看板上同时看到 | 结论 | 下一步 |
|---|---|---|
| `hikaricp_connections_pending` > 0，`active` 顶到 `max`（截图里 **max = 10**） | **DB 连接池是瓶颈** | 先量连接持有时长（§5.2），再谈调大池子 |
| `jvm_cpu_recent_utilization_ratio` 接近 1 | **算力瓶颈**（`.dat` 解析 / risk 计算） | 用 productType 标签切分，看是哪类产品贵 |
| gRPC **Client** 出站速率随并发线性上升，且 p99 陡增 | **下游拖的**（risk-engine / user-center） | 切 Service 到那个服务，重走四层 |
| gRPC 出站**次数**随并发超线性上升 | **N+1 扇出**（见 §5.1） | 这是架构问题，不是容量问题 |
| GC Collections rate 明显上升、Heap 锯齿谷底持续抬升 | **内存压力** | 短测看不准，留到 soak |
| Thread Count 撞平顶 | **线程池打满** | 找 Tomcat / 业务线程池的上限配置 |
| **所有面板都闲**，TPS 就是不涨 | **串行段或锁竞争** | 见下方 ⚠ |
| 服务端 p99 远小于你测到的 P95 | 瓶颈**不在服务端业务逻辑** | 见 §8 |

> ### ⚠ "所有资源都闲但 TPS 不涨" —— 当前配置下大概率会撞上
>
> 现在 `create-trade-data.json` 只有一条用例（一组归属值），全部 VU 打同一个 portfolio。
> 如果服务端有 portfolio 级的锁或唯一性检查，这就是人为制造的串行段，
> **测到的不是系统容量，是那把锁的容量**。
>
> 分辨方法：多采几条不同 portfolio 的用例再跑一次对照。
> TPS 明显上去了，就说明存在 portfolio 级竞争 —— 那本身是个值得报的发现。

---

## 5. 这块看板刚好能回答的两个 OREO 特有问题

### 5.1 UC gRPC 扇出是不是 N+1

[Workload Modeling](../docs/performance/workload-modeling.zh.md) §6 把
**UC gRPC 扇出（推导值 826 QPS）** 列为首要瓶颈嫌疑，前提是"若 N+1 成立"。

这块看板的 gRPC Client 面板让这件事变成**可直接测量**的，不需要读代码：

```promql
# 一段时间内，workers-backend 发出的各类 gRPC 调用次数
sum by (rpc_method) (
  increase(rpc_client_duration_milliseconds_count{service_name="oreo-workers-backend"}[10m])
)
```

拿这个数除以同一窗口内**成功创建的 trade 笔数**（`summarize.py` 的成功样本数），
得到 **每笔 create 的 gRPC 调用次数**。

判据很干脆：

- 这个比值**不随并发变化** → 常数扇出，正常
- 随并发或数据量**上升** → N+1，是架构问题

> 这是**用性能数据反查架构假设**，比读代码快、比问人可靠。
> 截图里已经能看到 `calculateRiskForNew` / `CalculateMetric` / `retrieveTargetDetails` /
> `extractCounterparties` / `extractPortfolios` 五个方法名 —— 一次 create 到底会调几个、各几次，
> 跑一轮就有答案。

### 5.2 HikariCP `max = 10` 是不是硬天花板

截图里连接池上限是 **10**。设计并发是 3–7（RUNBOOK §0），看着够用 —— 但取决于**连接被握多久**：

```promql
# 连接平均持有时长（秒）
rate(hikaricp_connections_usage_seconds_sum{service_name="oreo-workers-backend"}[1m])
  / rate(hikaricp_connections_usage_seconds_count{service_name="oreo-workers-backend"}[1m])
```

把它和单笔请求耗时比：

- **持有时长 ≈ 请求耗时** → 连接在整个请求期间被握着（含 `.dat` 解析、含 gRPC 往返）。
  那么**池子大小就等于最大并发**，10 是硬上限，且 `.dat` 越大越糟。
- **持有时长 << 请求耗时** → 连接只在真正读写时借出，池子不是约束。

第一种情况值得单独写进报告 —— 它意味着"加机器"解决不了问题，
要么缩短持有时长（把解析挪出事务），要么调大池子（但那会把压力推给数据库）。

---

## 6. 现成 PromQL

标签按截图核对：`service_name`、`host_name`、`http_route`、`http_request_method`、
`http_response_status_code`、`pool`。

```promql
# ── create 接口的 TPS ──
sum(rate(http_server_request_duration_seconds_count{
  service_name="oreo-workers-backend",
  http_route="/api/v1/trades/create",
  http_request_method="POST"
}[1m]))

# ── create 接口的服务端 p95（需要 _bucket，见 §1.3）──
histogram_quantile(0.95, sum by (le) (
  rate(http_server_request_duration_seconds_bucket{
    service_name="oreo-workers-backend",
    http_route="/api/v1/trades/create"
  }[1m])))

# ── 5xx 比例 ⚠ 业务失败不在这里，见 §2 ──
sum(rate(http_server_request_duration_seconds_count{
      service_name="oreo-workers-backend",
      http_route="/api/v1/trades/create",
      http_response_status_code=~"5.."}[1m]))
/
sum(rate(http_server_request_duration_seconds_count{
      service_name="oreo-workers-backend",
      http_route="/api/v1/trades/create"}[1m]))

# ── 连接池：排队深度与利用率 ──
hikaricp_connections_pending{service_name="oreo-workers-backend"}
hikaricp_connections_active{service_name="oreo-workers-backend"}
  / hikaricp_connections_max{service_name="oreo-workers-backend"}

# ── CPU（0..1 的比值，不是百分数）──
jvm_cpu_recent_utilization_ratio{service_name="oreo-workers-backend"}

# ── GC 占用的 CPU 时间比例 —— 比"GC 次数"更能说明问题 ──
sum by (service_name) (rate(jvm_gc_duration_seconds_sum[1m]))

# ── 每笔 create 的 gRPC 调用次数（§5.1）──
sum by (rpc_method) (
  increase(rpc_client_duration_milliseconds_count{service_name="oreo-workers-backend"}[10m]))
```

> 多实例时加 `host_name="..."` 收窄，或去掉 `sum by` 的分组看单实例。

---

## 7. 三种集成方案

> **方案 0 · k6 web dashboard —— 已内置，先用它看曲线。**
> 两个 runner 默认开启：跑时 `http://127.0.0.1:5665` 实时看，
> 跑完在 `results/<runId>/report.html` 留一份自包含 HTML（短运行如 smoke 会跳过导出）。
> 在 remote-write 审批（方案 B）落地前，这是唯一的压测端时间序列视图。
> ⚠ 它只看**压测端**曲线，回答不了"为什么慢"——归因仍需下面的方案把
> 后端指标对到同一根时间轴；且它的错误率是 `http_req_failed`（HTTP 层），
> 三类错误判定以 `summary.txt` 为准。

### 方案 A · 时间轴对齐 —— 零改造，现在就能用 ✅ 推荐先做

两个 runner（`k6/run.sh` `k6/run.ps1`）跑完都会打印：

```
Grafana 时间范围（替换 URL 里的 from=now-1h&to=now）：
  &from=1785222714298&to=1785223019331
```

把看板 URL 里的 `from=now-1h&to=now` 换成这两个数即可。
两个数也写进了 `manifest.txt`，事后还能复现同一个视图。

想少一步手工，把看板 URL 设成环境变量，runner 会直接打完整链接：

```bash
export GRAFANA_DASHBOARD_URL='https://<grafana>/d/<uid>/oreo-microservice-observability-with-host?orgId=1&var-host=uklvadpta0005a&var-service=$__all&var-interval=10s'
```

```powershell
$env:GRAFANA_DASHBOARD_URL = 'https://<grafana>/d/<uid>/...'
```

> URL 里顺手把 `var-interval` 调小（10s / 15s），比事后在页面上点一次可靠 ——
> 忘了调的那一跑，事后无法补救。

**这个方案的局限**：压测的 TPS/P95 仍然只在你的终端里，看板上没有。
要对照就得两个窗口并排看。对于阶段 1 这够用了。

### 方案 B · k6 指标直接写进 Prometheus —— k6 阶段再做

k6 原生支持 remote-write，`k6/run.sh` 与 `k6/run.ps1` 已经接好：

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://<prom>:9090/api/v1/write \
  ./k6/run.sh p02-trade-create dev baseline
```

生效后，压测的 TPS / P95 / 三类错误计数会和
`hikaricp_connections_pending` 出现在**同一个面板、同一根时间轴**上 —— 这才是真正的"集成"。

两个前置条件，都要找平台/运维确认：

1. Prometheus 必须带 `--web.enable-remote-write-receiver` 启动（默认是关的）
2. 压测端到 Prometheus 的网络要通

> 原生 remote-write（push 模型）是当初选 k6 的理由之一（计划 §1.1）——
> 不需要改 Prometheus 的 scrape 配置去反向抓压测机。
> 但阶段 1 只是要一份基线数字，方案 A 完全够。

### 方案 C · Grafana Annotation

每次跑在**所有面板上**留一条竖线（含 runId），事后翻历史一眼就能定位。

```bash
curl -s -X POST "$GRAFANA_URL/api/annotations" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"time\":$START_MS,\"timeEnd\":$END_MS,\"isRegion\":true,
       \"tags\":[\"perf\",\"p02\"],\"text\":\"$RUN_ID\"}"
```

成本是一个有写权限的 Grafana API token。拿得到就值得做 ——
它把"哪一段是压测"这个信息**固化在看板里**，而不是留在某个人的记忆里。

> 要我把这段接进两个 runner（有 token 才启用，没有就跳过）的话说一声。

### 推荐路径

| 阶段 | 做什么 |
|---|---|
| **现在（阶段 1）** | 方案 A。同时问平台团队要两样东西：Prometheus 的 remote-write 是否可开、Grafana 能否给个写 token |
| **拿到 remote-write** | 上方案 B |
| **拿到 token 后** | 补方案 C |

---

## 8. 服务端 p99 与压测端 P95 对不上时

两个数**本来就不该相等**，差值本身是信息：

```
你的 P95  =  服务端处理  +  连接建立  +  .dat 上传传输  +  客户端排队  +  网络往返
看板 p95  =  服务端处理
```

| 差值 | 说明 | 怎么办 |
|---|---|---|
| 小且稳定 | 正常 | 报告里两个数都给，标明口径 |
| **大且随并发增长** | 压力堆在服务端**之前** —— 网关队列、连接池（HTTP 层）、或**压测机自己成了瓶颈** | 先排除压测机：看它的 CPU 和网络；再看 gateway 服务的指标 |
| 大但不随并发变化 | 固定开销，多半是 `.dat` 上传的传输时间 | 用不同大小的 `.dat` 对比即可确认 |

> ⚠ 前提是**两台机器的时钟同步**。压测端和被测机若差几秒，
> 时间轴对齐就是错的，而图上完全看不出来 —— 你只会觉得"指标反应有点滞后"。
> 开跑前确认两边都在同一个 NTP 源上。

---

## 附：一页速查

```
跑之前   5 个服务 UP？Host 选对了？空载 10 分钟记基线？
         单级时长 ≥ 20 × scrape_interval，且 ≥ 100 个压测样本 —— 取更严的
跑之中   只盯 3 个：HTTP Request Rate / DB Pending / CPU
跑之后   贴 &from=&to= → 按 HTTP → gRPC → JVM → HikariCP 找第一个饱和的层

永远记住 5xx 面板看不见 OREO 的业务失败（create 失败也返回 200）
         业务结论只能从 summarize.py 的 errClass 来
```
