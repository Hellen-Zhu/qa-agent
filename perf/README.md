# perf — k6 性能测试框架

FX Structured Products Trading System 服务端压测框架，本机 runner 触发（Linux/macOS 直跑，Windows 用 Git Bash 跑同一份 run.sh）。
设计文档：`../docs/superpowers/specs/2026-07-31-k6-perf-framework-design.md`。

## 快速开始

```bash
# <scenario> [env] [profile] [KEY=value...]，默认 local+smoke
./run.sh trades-create.js dev smoke
./run.sh trades-query                                      # 等价 trades-query local smoke
./run.sh trades-create local baseline VUS=1 DURATION=600s  # KEY=value 任意 __ENV 覆盖

# 产物在 results/<UTC日>/<runId>/：
#   summary.txt   三分类/双延迟文本摘要（终端同款），判定权威
#   summary.json  机读（runner 提取 verdict 定退出码；基线对比输入）
#   dashboard.html k6 web dashboard 时序曲线导出（不作判定；极短运行会跳过导出）
#   result.csv    逐请求明细（含全部 tag）
#   manifest.txt  本轮完整环境快照；k6.log 全量日志（UTC，可与服务端日志对表）

# 本地静态验证（不发压）
k6 inspect -e ENV=local src/scenarios/trades-query.js
```

除 k6 外无任何依赖（无 Node/jq/python），summary 由 k6 的 handleSummary 直接写盘。

## 目录结构

- `config/environments/` 环境（服务地址映射、白名单、promRwUrl、grafanaDashboard、身份池）；**仓库内全部为 localhost/示例占位，真实值仅在内网填写；没有也不允许有 prod**
- `config/slas/` 按 服务/模块 组织的 API 级分位数 SLA（挂 perf_success_duration；错误率与熔断属 profile 级）
- `profiles/` 负载 profile（JSON 声明式，scenario 块即 k6 executor 原文；`_` 开头键为注释；smoke/baseline/load/ladder/stress/spike/soak 七个，方法论见各文件 description）
- `data/<service>/<module>/` 每 API 专属数据：查询字段池 + create 用例池（一行=一个完整同源用例，纪律见 `data/worker-svc/trade-management/README.md`）；`data/datfiles/products/<productType>/` dat 样本（占位，须真实采集替换）
- `src/lib` 纯逻辑模块（config/users/data/rows/sla/report，Node 可加载）+ k6 侧模块（http.js 纯发送管道、errors.js 三分类引擎、bootstrap.js 场景装配 + handleSummary 双路输出）
- `src/api/<service>/<module>/` API 客户端层：`<api>.js`（请求构造+响应契约分类）+ 需要用例池的配 `<api>-data.js`——每 API 一文件，init 图天然隔离；按需建档（被压测才建）
- `src/setup/` preflight（本地数据闸，setup 阶段不发请求）
- `src/scenarios` 场景入口（数据 + 一次业务动作）
- `dashboards/` Grafana dashboard JSON（单板总览 + 官方 19665 固定版本存档）

## 约定

- **全链路 UTC**：run.sh 已 `export TZ=UTC`（k6 是 Go，认 TZ，Windows Git Bash 同样生效），runId/结果目录/manifest/k6.log 同钟，可直接与服务端日志对表；**绕过 run.sh 裸跑调试须自带 `TZ=UTC k6 run ...`**，否则 k6.log 落回本机时区。dashboard.html 图表横轴是浏览器本地时区渲染，属前端行为，不参与对表
- **错误三分类**：technical（性能结论）/ business（通常是数据问题）/ script（本轮作废）必须分开看；SLA 分位数只看 `perf_success_duration`（业务成功请求）
- 判定权威是 summary（三分类 + 阈值 + 0 请求防假绿），不是 dashboard.html——web dashboard 的错误率是 HTTP 层的 http_req_failed，本系统业务失败也返回 200
- 数据取数一律全局游标（`exec.scenario.iterationInTest`）；指标 tag 只允许有界取值，严禁 tradeId 类唯一值
- 新增写路径 API：`src/api/<service>/<module>/` 加 `<api>.js`（契约）+ `<api>-data.js`（用例池）+ `data/<service>/<module>/<scenario>.json` 用例文件 + preflight；新增读路径 API：加 `<api>.js` 用 `classifyRead` + 字段池数据文件
- RATE/VUS/DURATION/MAX_VUS 覆盖仅作用于 profile 中存在的同名标量键（stages 字面量不受影响）；任意 `KEY=value` 透传为 k6 `-e`

## 真实环境启用

见 `docs/env-checklist.md`——本仓库无 mock 与单元测试，**内网首跑 smoke 即框架首次端到端验证**，务必小流量先行并逐项核对清单。
