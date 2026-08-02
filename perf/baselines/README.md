# baselines — 性能基线

基线 = 某轮可信运行**晋升**而来的 `summary.json`，不是新格式：

```bash
cp results/<UTC日>/<runId>/summary.json baselines/<scenario>_<env>_<profile>.json
```

文件名三段组合键缺一不可——跨环境或跨负载档的对比没有意义。之后每次同组合运行，
k6 会在 summary 里自动附加 **Baseline comparison** 段（run.sh 在无基线且本轮 PASS 时
会打印现成的晋升命令）。

## 对比维度与容差

| 维度 | 容差 | 说明 |
|---|---|---|
| 成功延迟 P50/P95/P99 增幅 | +10%（`BASELINE_TOL_PCT=15` 单次覆盖） | 只看 perf_success_duration（业务成功请求） |
| 业务成功率降幅 | -1.0pp | |
| technical 从无到有 | 基线 0 而本轮 >0 即标红 | |
| ok-samples | 不设容差，并排展示 | 分位数可信度随样本量走，双方悬殊时读者要看见 |

rps 刻意不比：open 模型下速率是 profile 配置出来的，比它没有信息量。

## 纪律

- **超容差只标红不改判定**——verdict 的权威永远是阈值（spec §7/§9）；基线对比是回归发现机制，要做门禁等 P2 接 CI 时再议。
- **只晋升样本量够的运行**：summary 的 Sample size 段没有告警（P95 ≥200 样本）才配当基线；用 smoke 当基线是拿随机数当参照物。
- 基线随环境失效（数据、机器、版本变了就该重新晋升），晋升即入库——git 历史就是基线变更史，无需另记。
- 基线损坏（非法 JSON）会让下轮 init 响亮失败而不是静默跳过——修复或删除该文件。
