# 真实环境启用前检查清单

本地已验证：JSON 配置、纯逻辑模块加载、`k6 inspect`（完整 init：import 图 + open() 文件）、
run.sh dry-run（tag 筛选、Job manifest 渲染）。
以下事项本地无法验证，首次对 dev/uat 压测前逐项确认（编号对应设计文档第 11 节遗留问题）：

- [ ] 真实服务地址：`config/environments/dev.json` 的 services 填真实 host:port，whitelist 同步加真实域（仓库内保持 localhost 占位，真实值不入库或按公司规范管理）
- [ ] Prometheus 开启 `--web.enable-remote-write-receiver`，地址填入 `promRwUrl`（遗留问题 #1）
- [ ] SLA 目标值与业务方确认，替换 `config/slas/` 占位水位（遗留问题 #2）
- [ ] 压测数据识别与清理依赖"专用 PERF portfolio + 状态 + 时间窗"（payload 不接受额外字段，clientRef 方案已废除）；专用 portfolio 真实值建立后填入用例池各行 portfolioId（遗留问题 #3）
- [ ] 用例池同源采集：系统 Web 界面建单 + DevTools 对 POST /trades/create Copy as cURL，逐行填入 `data/trade-svc/trades-create.json`（归属三字段整组同源，勿拼装；真实 .dat 按同名约定另存为 `data/datfiles/products/<productType>/<productType>.dat`（行内只写 productType，框架自动定位）；每换 productType/counterparty 采一次；采集样本放 `_samples/` 不入库）；验证同一 dat 高频重复提交是否触发幂等/去重/日期校验（遗留问题 #4）
- [ ] create/query 响应契约核对：create 成功契约按校准版实现（code=200 + status='PENDING APPROVAL' + data.trade.id ~ TRD-\d+），首跑确认版本未变；query 假设响应含 `trades` 数组且行数>0（perf_trades_rows 空库守卫）
- [ ] 镜像内 k6 版本 ≥ 0.55（与本地验证版本行为一致：空 K6_OUT 容忍、experimental-prometheus-rw 输出名、K6_PROMETHEUS_RW_TREND_STATS 支持）
- [ ] 5 个微服务清单（服务名/地址/模块）补入 `config/environments/` 与 `src/api/`（遗留问题 #6）
- [ ] X-User-Id 身份（maker/checker 真实账号）填入环境文件并确认在目标环境有效
- [ ] k8s 脚本注入方式（本仓库不交付 Dockerfile）：公司镜像流程内置 k6 + `/perf` 内容（workingDir 与 job.yaml 一致），或 ConfigMap 挂载——二选一实施，镜像地址经 `K6_IMAGE` 传入；`K6_NAMESPACE` 建立并有 Job 创建权限
- [ ] 两份 dashboard 导入现网 Grafana，确认 testid 变量与业务指标面板出数；官方 19665 面板中 k6_checks_rate 图恒为空（框架已不使用 check()），首次看板评审勿当作故障
- [ ] 服务端指标串联配置（依赖现网信息）：业务 dashboard 底部补服务端资源面板（PromQL 参照现有服务端 dashboard，按 service 过滤）；顶部加带 `?from=${__from}&to=${__to}` 的 dashboard link 跳转到各服务端 dashboard
- [ ] 压测环境 trade 表存量数据接近生产量级（空表查询无参考价值）
- [ ] 首跑顺序：smoke（1 分钟）→ 确认 Grafana 出数、报告生成、服务端无异常 → 再 load
- [ ] 首跑核对三分类归因：故意用一行错误数据跑 smoke，确认报告中 business 类与 row tag 正确归因后再恢复；query 的业务拒绝当前会落入 script 类并触发 perf_err_script count==0 作废本轮——首跑若出现，需为 query 补业务契约回调
