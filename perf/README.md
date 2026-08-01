# perf — k6 性能测试框架

FX Structured Products Trading System 服务端压测框架。
设计文档：`../docs/superpowers/specs/2026-07-31-k6-perf-framework-design.md`。

## 快速开始

```bash
# 本机直跑（本地 runner，位置参数：<scenario> [env] [profile]，默认 local + smoke）
./run.sh trades-create.js dev smoke
./run.sh trades-query                                      # 等价 trades-query local smoke
./run.sh trades-create local baseline VUS=1 DURATION=600s  # KEY=value 任意 __ENV 覆盖
./run.sh --tags P0 dev load                                # 批量 + 汇总表

# 本地静态验证（不发压）
k6 inspect -e ENV=local src/scenarios/trades-query.js
./run.sh --tags P0 --dry-run

# 内网压 dev 环境（k8s Job，先按 docs/env-checklist.md 完成启用项）
./deploy/run.sh -s trades-query -p smoke -e dev            # 首跑必须 smoke
./deploy/run.sh -s trades-query -p load -e dev -r 50 -d 10m
./deploy/run.sh --tags P0 -p load -e dev                   # 批量 P0 + 汇总表
```

## 目录结构

- `config/environments/` 环境（服务地址映射、白名单、promRwUrl、身份池）；**仓库内全部为 localhost/示例占位，真实值仅在内网填写；没有也不允许有 prod**
- `config/slas/` 按 服务/模块 组织的 API 级分位数 SLA（挂 perf_success_duration；错误率与熔断属 profile 级）
- `profiles/` 负载 profile（JSON 声明式，scenario 块即 k6 executor 原文；`_` 开头键为注释；smoke/baseline/load/ladder/stress/spike/soak 七个，方法论见各文件 description）
- `data/trade-svc/` 每 API 专属数据：查询字段池 + create 用例池（一行=一个完整同源用例，纪律见 `data/trade-svc/README.md`）；`data/datfiles/products/<productType>/` dat 样本（占位，须真实采集替换）
- `src/lib` 纯逻辑模块（config/users/data/rows/sla/report，Node 可加载）+ k6 侧模块（http.js 纯发送管道、errors.js 三分类引擎、bootstrap.js 场景装配）
- `src/api/<service>/` API 客户端层：`<module>.js`（请求构造+响应契约分类）与 `<module>-data.js`（用例池实例化+dat 预载）
- `src/setup/` preflight（本地数据闸，setup 阶段不发请求）
- `src/scenarios` 场景入口（meta + 数据 + 一次业务动作）
- `deploy/` run.sh 与 Job 模板（镜像/脚本注入由公司侧机制提供）；`dashboards/` Grafana JSON
- `tools/` meta 提取、报告提取/渲染

## 约定

- 场景文件必须导出静态 `meta = { tags: [...] }`；`P0/P1/P2` tag 表达优先级
- `run.sh --tags` 是框架参数（用例选择）；k6 的 `--tag` 是指标标签，由 run.sh 注入 testid
- **错误三分类**：technical（性能结论）/ business（通常是数据问题）/ script（本轮作废）必须分开看；SLA 分位数只看 `perf_success_duration`（业务成功请求）
- 数据取数一律全局游标（`exec.scenario.iterationInTest`）；指标 tag 只允许有界取值，严禁 tradeId 类唯一值
- 新增写路径 API：`src/api/<service>/` 加 `<api>.js`（契约）+ `<api>-data.js`（用例池）+ `data/<service>/<scenario>.json` 用例文件 + preflight；新增读路径 API：加 `<api>.js` 用 `classifyRead` + 字段池数据文件
- RATE/VUS/DURATION/MAX_VUS 覆盖仅作用于 profile 中存在的同名标量键（stages 字面量不受影响）；本地模式（`./run.sh` 或 `deploy/run.sh --local`）支持任意 `KEY=value` 透传为 k6 `-e`；k8s 模式仅 `-r`/`-d`（Job 命令为固定模板）

## 真实环境启用

见 `docs/env-checklist.md`——本仓库无 mock 与单元测试，**内网首跑 smoke 即框架首次端到端验证**，务必小流量先行并逐项核对清单。
