# perf — k6 性能测试框架

FX Structured Products Trading System 服务端压测框架。
设计文档：`../docs/superpowers/specs/2026-07-31-k6-perf-framework-design.md`。

## 快速开始

```bash
# 本地静态验证（不发压）
k6 inspect -e ENV=local src/scenarios/trades-query.js
./deploy/run.sh --tags P0 -p smoke -e local --dry-run

# 内网压 dev 环境（先按 docs/env-checklist.md 完成启用项）
./deploy/run.sh -s trades-query -p smoke -e dev            # 首跑必须 smoke
./deploy/run.sh -s trades-query -p load -e dev -r 50 -d 10m
./deploy/run.sh --tags P0 -p load -e dev                   # 批量 P0 + 汇总表

# 本机直跑（不经 k8s）
./deploy/run.sh -s trades-query -p smoke -e dev --local
```

## 目录结构

- `config/environments/` 环境（服务地址映射、白名单、promRwUrl、身份池）；**仓库内全部为 localhost/示例占位，真实值仅在内网填写；没有也不允许有 prod**
- `config/slas/` 按 服务/模块 组织的 SLA 阈值（当前为占位水位，见环境清单）
- `src/lib` 框架层：纯逻辑模块（config/users/data/sla/report，Node 可加载）+ k6 侧模块（http.js、metrics.js、bootstrap.js——场景装配层，集中 cfg/参数池加载与 options/handleSummary 组装，场景文件只写业务编排）；`src/api/<service>/<module>.js` API 客户端层
- `data/<service>/<scenario>.json` **每个 API 一个专属数据文件**，压该 API 所需的全部参数池都在这一个文件里；`data/datfiles/` 产品 dat 模板（跨 API 复用的二进制资产，占位，须替换）；`src/payloads` multipart 组装工厂
- `src/profiles` smoke/load/stress/spike/soak；`src/scenarios` 场景入口
- `deploy/` run.sh 与 Job 模板（镜像/脚本注入由公司侧机制提供）；`dashboards/` Grafana JSON
- `tools/` meta 提取、报告提取/渲染

## 约定

- 场景文件必须导出静态 `meta = { tags: [...] }`；`P0/P1/P2` tag 表达优先级
- `run.sh --tags` 是框架参数（用例选择）；k6 的 `--tag` 是指标标签，由 run.sh 注入 testid，用户不手写
- 新增 API：在 `src/api/<service>/` 加函数（统一走 `lib/http.js` 三动词）+ 建 `data/<service>/<scenario>.json` 专属数据文件；新增产品：`data/datfiles/` 加 dat + `payloads/factory.js` 注册

## 真实环境启用

见 `docs/env-checklist.md`——本仓库无 mock 与单元测试，**内网首跑 smoke 即框架首次端到端验证**，务必小流量先行并逐项核对清单。
