# API 摸底与基线建立 Runbook

适用：单 API 场景的首次容量摸底与性能基线建立（基线失效后的重建同此流程）。
全程只用现有工具链（run.sh + profiles + Grafana Capacity 行 + summary 基线对比），无额外依赖。
下文以 trades-create 为例，替换场景名即可复用。

## 流程总览

```
0 前置确认 → 1 ladder 找拐点 K → 2 工作点 constant-rate ×3 轮 → 3 校准 SLA → 晋升基线
```

## 第 0 步：前置确认（一次性）

- [ ] `./run.sh trades-create dev smoke`（单用户单次链路检查；多打几发用 ITERATIONS=5）：无 technical/http-429（身份池生效，见 env-checklist 身份池匹配项）；business 失败原因可解释（Failure Attribution 面板 + k6.log body 摘录）；Grafana 头部对账区与该轮 summary 三分类逐项相等
- [ ] 写接口专项：摸底全程真实建单——确认 PERF portfolio 清理方案吃得下量（ladder 一轮可达数十万笔 PENDING），下游（审批队列、通知）不会被灌爆影响他人
- [ ] 数据池循环复用同一批 payload：确认高频重复提交不触发幂等/去重拒绝（env-checklist 遗留问题 #4），否则 business 失败率随轮次爬升会污染摸底数据

## 第 1 步：ladder 找拐点（约 24 分钟）

```bash
./run.sh trades-create dev ladder     # 当前阶梯 10/20/40/80 VU；改形状须编辑 profiles/ladder.json（stages 是字面量，VUS= 覆盖不生效）
```

读图纪律（看板 Capacity 行，只读各台阶**平台段**）：

- RPS 是否随 VU 接近翻倍——增幅明显掉队的那一级就是拐点区间，记下拐点吞吐 **K req/s**
- p95 何时翘头、technical 何时涌现（三者通常同点位出现，互为印证）
- 预热期（前几分钟）的点掐掉不读；closed 模型没有 dropped_iterations，压不上去表现为 RPS 不再涨
- 429 在某台阶重现 → 该轮只读到最后一个干净台阶（之后测的是限流器不是系统容量）
- **ladder 轮的 summary 分位数是各台阶混合值——不作数，更不能当基线**；ladder 的 summary 只看三分类账目（technical 从哪级开始）

## 第 2 步：工作点 constant-rate 复核（3 轮）

基线不建在拐点上，建在**工作点**上。工作点取法二选一：

1. 业务方能给生产预期峰值 → 用它（前提 < K）
2. 给不了 → 取 **K 的 50–70%** 作标称容量

```bash
./run.sh trades-create dev load RATE=<工作点>     # 连跑 3 轮
```

- 3 轮 p95 相互波动 **< 10%**（与基线容差同宽）才算稳态可信
- 波动超限先查原因（数据池衰减、共享环境邻居、GC/部署抖动），修完重跑——不出基线

## 第 3 步：先校准 SLA，再晋升基线

顺序不可倒：run.sh 只在 **verdict PASS 且尚无基线**时提示晋升，SLA 未落定则 PASS 无意义。

1. 拿第 2 步实测 p95 与业务方校准 `config/slas/`（create 当前 800/2000 为占位）；同步手改看板 Success Duration Percentiles 的 SLA 参考线（**按秒填**，300 ms → 0.3）
2. 从 3 轮中选**中位的那轮**晋升（不选最好的——基线过紧会长期误报）：

```bash
cp results/<该轮目录>/summary.json baselines/trades-create_dev_load.json
```

3. 之后所有同 scenario+env+profile 轮次自动对比：p50/p95/p99 超 +10%、业务成功率降 1pp、technical 0→非 0 在 summary 标红（只标红不改判定；容差 `BASELINE_TOL_PCT` 可调）

## 摸底完成的产出物清单

| 产出 | 落点 |
|---|---|
| 拐点吞吐 K | 记录于测试报告/工单 |
| 标称容量（工作点） | 同上；后续 load/soak 的 RATE 依据 |
| 基线文件 | `baselines/trades-create_dev_load.json` |
| 校准后的 SLA | `config/slas/worker-svc/trade.json` + 看板参考线 |
| 每用户限流阈值实测 | env-checklist 身份池匹配项 |
| 工作点三分类失败画像 | 该轮 summary（基线自带） |

## 基线失效与重建

环境重部署、库存数据量级变化、SLA 重校准、依赖服务升级 → 基线作废，从第 2 步重走（拐点 K 若怀疑漂移则从第 1 步重走）。基线只增不改：重建即覆盖晋升，旧值以 git 历史为准。
