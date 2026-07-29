# OREO Trade 性能测试

性能测试工程主体在 [`k6/`](k6/README.zh.md)——结构、约束、快速开始都在那份 README。

```bash
node k6/tests/rows.test.mjs            # 脚本自检（不需要 k6）
./k6/run.sh p02-trade-create dev smoke # 第一次跑通
```

## 本目录内容

| 内容 | 说明 |
|---|---|
| [`k6/`](k6/README.zh.md) | 测试工程：scenarios / journeys / steps / profiles / data / 执行入口 |
| [`k6/HANDBOOK.zh.md`](k6/HANDBOOK.zh.md) | 实操手册：从装 k6 到容量测试，Mac/Windows 双平台 |
| [`GRAFANA.zh.md`](GRAFANA.zh.md) | 压测数字 ↔ 后端指标对齐：四层归因、PromQL、集成方案 |
| [`api-registry.csv`](api-registry.csv) | 33 个 trade API 的注册表（范围与优先级的依据） |

方案层面（为什么这么测、指标口径、NFR）见 [`../docs/performance/`](../docs/performance/)：
测试计划、NFR、KPI 定义、负载建模。

## 历史

本工程曾有 JMeter 与 k6 两套并行实现；2026-07-29 起测试计划采纳 k6 为主线
（选型依据见计划 §1.1），JMeter 存量（jmx / groovy / scripts / 配套手册）已从
仓库移除，需要考古时在 git 历史 `87f124d` 之前找。
