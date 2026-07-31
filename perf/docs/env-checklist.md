# 真实环境启用前检查清单

本地已验证：JSON 配置、纯逻辑模块加载、`k6 inspect`（完整 init：import 图 + open() 文件）、
run.sh dry-run（tag 筛选、Job manifest 渲染）。
以下事项本地无法验证，首次对 dev/uat 压测前逐项确认（编号对应设计文档第 11 节遗留问题）：

- [ ] 真实服务地址：`config/environments/dev.json` 的 services 填真实 host:port，whitelist 同步加真实域（仓库内保持 localhost 占位，真实值不入库或按公司规范管理）
- [ ] Prometheus 开启 `--web.enable-remote-write-receiver`，地址填入 `promRwUrl`（遗留问题 #1）
- [ ] SLA 目标值与业务方确认，替换 `config/slas/` 占位水位（遗留问题 #2）
- [ ] 压测数据标记与开发确认：当前用 portfolioId=PERF_TEST + basic.clientRef 承载唯一标记，需确认字段有效且对下游无副作用（遗留问题 #3）
- [ ] 用真实 FX_TRF.dat 替换 `data/datfiles/` 占位文件；验证同一 dat 高频重复提交是否触发幂等/去重/日期校验，若需参数化做模板替换（遗留问题 #4）
- [ ] create 响应结构核对：`bizCheck` 假设响应含 `tradeId` 字段，首跑时确认
- [ ] 5 个微服务清单（服务名/地址/模块）补入 `config/environments/` 与 `src/api/`（遗留问题 #6）
- [ ] X-User-Id 身份（maker/checker 真实账号）填入环境文件并确认在目标环境有效
- [ ] k8s 脚本注入方式（本仓库不交付 Dockerfile）：公司镜像流程内置 k6 + `/perf` 内容（workingDir 与 job.yaml 一致），或 ConfigMap 挂载——二选一实施，镜像地址经 `K6_IMAGE` 传入；`K6_NAMESPACE` 建立并有 Job 创建权限
- [ ] 两份 dashboard 导入现网 Grafana，确认 testid 变量与业务指标面板出数
- [ ] 服务端指标串联配置（依赖现网信息）：业务 dashboard 底部补服务端资源面板（PromQL 参照现有服务端 dashboard，按 service 过滤）；顶部加带 `?from=${__from}&to=${__to}` 的 dashboard link 跳转到各服务端 dashboard
- [ ] 压测环境 trade 表存量数据接近生产量级（空表查询无参考价值）
- [ ] 首跑顺序：smoke（1 分钟）→ 确认 Grafana 出数、报告生成、服务端无异常 → 再 load
