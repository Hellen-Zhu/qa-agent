# 真实环境启用前检查清单

本地已验证：JSON 配置、纯逻辑模块加载、`k6 inspect`（完整 init：import 图 + open() 文件）、
run.sh 真实运行（summary 写盘、verdict/退出码、preflight 提示）。
以下事项本地无法验证，首次对 dev/uat 压测前逐项确认（编号对应设计文档第 11 节遗留问题）：

- [ ] 真实服务地址：`config/environments/dev.json` 的 services 填真实 host:port，whitelist 同步加真实域（仓库内保持 localhost 占位，真实值不入库或按公司规范管理）
- [ ] Prometheus 开启 `--web.enable-remote-write-receiver`，地址填入 `promRwUrl`（遗留问题 #1）
- [ ] SLA 目标值与业务方确认，替换 `config/slas/` 占位水位（遗留问题 #2）
- [ ] 压测数据识别与清理依赖"专用 PERF portfolio + 状态 + 时间窗"（payload 不接受额外字段，clientRef 方案已废除）；专用 portfolio 真实值建立后填入用例池各行 portfolioId（遗留问题 #3）
- [ ] 用例池同源采集：系统 Web 界面建单 + DevTools 对 POST /trades/create Copy as cURL，逐行填入 `data/worker-svc/trade/trades-create.json`（归属三字段整组同源，勿拼装；真实 .dat 按同名约定另存为 `data/datfiles/products/<productType>/<productType>.dat`（行内只写 productType，框架自动定位）；每换 productType/counterparty 采一次；采集样本放 `_samples/` 不入库）；验证同一 dat 高频重复提交是否触发幂等/去重/日期校验（遗留问题 #4）
- [ ] 响应契约核对（全部为占位假设，首跑逐一校准）：create 成功契约按校准版实现（code=200 + status='PENDING APPROVAL' + data.trade.id ~ TRD-\d+），首跑确认版本未变；query 假设响应含 `trades` 数组且行数>0（perf_trades_rows 空库守卫）；detail 假设含 `data.trade` 且 id 回显一致；risk-metrics 与 unread-count 仅假设含 `data` 键（结构采集后收紧）
- [ ] trade ID 池采集：查询专用 PERF portfolio 下的 trade，id 填入 `data/worker-svc/trade/trade-ids.json`（detail/risk-metrics 共享；ID 随环境失效，成片 http-404 = ID 过期先重采）
- [ ] 压测机 k6 版本 ≥ 0.55（与本地验证版本行为一致：experimental-prometheus-rw 输出名、K6_PROMETHEUS_RW_TREND_STATS、web dashboard 导出）；Windows 机器装 Git Bash 跑同一份 run.sh
- [ ] 5 个微服务清单（服务名/地址/模块）补入 `config/environments/` 与 `src/api/`（遗留问题 #6）
- [ ] X-User-Id 身份：申请 **20 个压测专用 maker 账号**（需真实 maker 角色 + PERF portfolio 建单权限——权限缺失表现为 409 而非 429），逐行替换 `users.maker` 占位（maker01..maker20）并确认在目标环境有效；checker 1 个（P1c 启用）
- [ ] 身份池与并发匹配（网关按 X-User-Id 限流，已确认）：closed 模型下每账号并发 ≈ ⌈顶阶 VU ÷ 池子⌉、每账号 QPS ≈ 顶阶 RPS ÷ 池子。20 账号安全覆盖 40 VU 台阶（每账号 2 路 / ~6-7 QPS）；**80 VU 顶阶下每账号 4 路 / ~13 QPS，跑前用已确认的限流阈值核对**，超了就把 ladder 顶阶降回 40 或继续扩池；限流阈值用"429 涌现台阶的 RPS ÷ 当时池子大小"反推并记录；若 429 在某台阶重现，该轮曲线只读到最后一个干净台阶（429 之后测的是限流器不是系统容量）
- [ ] 导入 `perf-trade-business.json`（单板总览，日常主看板）到现网 Grafana，确认 testid 变量与各面板出数；注意 k6 Prometheus 输出把时长导出为**秒**（Prometheus 基础单位惯例，与 summary 的毫秒不同），所有 duration 面板 unit 必须配 `s`（Grafana 自动渲染成 ms），新增面板勿配 `ms`——SLA 参考线等阈值同样按秒填（300 ms → 0.3）；**跑一轮 smoke 后核对头部对账区大卡与该轮 summary 三分类逐项相等**（对账区用 counter 终值，应精确一致；曲线区是 5s 窗口趋势口径，分位数与 summary 有差属预期）；官方 19665 现网已装、仓库份仅为固定版本存档（若全新 Grafana 才需一并导入）；板顶跳转链接指向 19665 的 uid（`ccbb2351-...`），若现网实例 uid 不同需改链接；19665 的 Checks 面板显示框架桥接的 `business success`（业务成功率镜像，2026-08-02 起）——判定权威仍是 summary 三分类，Checks 大卡仅作展示
- [ ] 服务端指标串联配置（依赖现网信息）：业务 dashboard 底部补服务端资源面板（PromQL 参照现有服务端 dashboard，按 service 过滤）；顶部加带 `?from=${__from}&to=${__to}` 的 dashboard link 跳转到各服务端 dashboard
- [ ] 压测环境 trade 表存量数据接近生产量级（空表查询无参考价值）
- [ ] 首跑顺序：smoke（1 分钟）→ 确认 Grafana 出数、报告生成、服务端无异常 → 再 load
- [ ] 首跑核对三分类归因：故意用一行错误数据跑 smoke，确认报告中 business 类与 row tag 正确归因后再恢复；query 的业务拒绝当前会落入 script 类并触发 perf_err_script count==0 作废本轮——首跑若出现，需为 query 补业务契约回调
