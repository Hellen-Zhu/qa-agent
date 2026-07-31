# trade-svc 数据文件

- `trades-query.json` — 查询字段池：`{ filters: [...] }`。字段间无有效性关联，池内自由轮换。
- `trades-create.json` — create 用例池：一行 = 一个完整可跑用例。行号 `__row` 装载时自动注入，
  作为指标 tag（哪行数据坏了直接从指标切出）；无人工维护的 id 列。

读路径客户端（`src/api/trade-svc/trades-read.js`）与写路径客户端（`trades.js`）代码分离，
原因是读场景不应加载 create 用例池与 dat 二进制——两者互不 import。

## 为什么归属字段内嵌一行，且必须同源

静态供数没有 live 查询兜底，**任何手工拼装都可能造出现实中不存在的组合**——
portfolio 属于 A 台、counterparty 未在 A 台开户。服务端业务拒绝在报告里呈现为
"错误率升高"，看起来像性能问题，实际是数据问题，极难定位。因此：

- `counterpartyFmId` 与 `counterpartyName` 服务端做一致性校验，禁止两处拼凑；
- 三个归属字段必须**整组来自同一份真实 curl**（系统 Web 界面建单，DevTools 对
  `POST /trades/create` Copy as cURL）——这一份 curl 同时给出：配对的归属真值、
  真实 .dat 文件（按同名约定另存为 `../datfiles/products/<productType>/<productType>.dat`——
  行内不写路径，框架按 productType 自动定位）、payload 结构与 header 集合。

## 数据有效性由两层机制守护（preflight 不发请求）

- 开跑前：大轮次同一会话先跑 `smoke`——真实建一笔，这才是"API 此刻接受这份数据"的验证；
- 跑起来后：长时 profile 的业务成功率宽松熔断线（`rate>0.50` + abortOnFail）——
  数据失效表现为整体性业务拒绝，无论发生在启动时还是第 3 小时，几分钟内自动止损。

## 刷新时机

不定期刷新，但以下情况必须重新采集：换环境（id 不跨环境）；smoke 的 create 开始失败或
长跑被业务成功率熔断；错误里出现大量 "counterparty not found / not entitled" 类拒绝。
采集时间与来源记在 `note` 字段。

## 变体池（对照实验）

如 portfolio 级锁竞争：复制 `trades-create.json` 为变体（全部行填同一组归属值），
`CREATE_DATA_FILE=data/trade-svc/<变体>.json` 覆盖切换，不改脚本。

⚠ 采集来的 curl/响应样本放本目录 `_samples/`（已 gitignore）——DevTools 导出含会话
cookie 与真实业务数据，**不入库**。
