# create 用例池

一条数据 = **一个完整可跑用例**：`.dat` 引用 + 归属字段
（`portfolioId` / `counterpartyFmId` / `counterpartyName`）内嵌在同一行里。
没有独立的 refdata 池 —— 用例与它的归属数据一对一绑定，取哪条用例就用哪条的归属值。

格式契约见 `k6/lib/rows.js`：数据在 `rows` 数组下，`_` 开头的键是注释，
值一律按字符串处理。`note` 不带下划线，是真实数据列（记采集时间与来源）。

| 文件 | 用途 |
|---|---|
| `create-trade-data.json` | 正常路径用例池。roundRobin 轮换（迭代 N 取第 `N % 条数` 条） |
| `create-trade-invalid.json` | 非法 `.dat` 用例（INTEG-04 / SEC-05），预期全部业务拒绝 |

切换用覆盖项，不改脚本：

```bash
./k6/run.sh p02-trade-create dev baseline CREATE_DATA_FILE=data/create-trade/create-trade-invalid.json
```

> 数据只支持 `.json`。改版前旧 CSV 里已采过的真值请手工填进 JSON ——
> 旧 CSV 没有归属三字段，列结构与新 schema 不兼容，没有直读路径。

## 归属字段为什么内嵌，而且必须同源

`live` 模式（E2E 的默认）下 refdata 是 setup 里现场查回来的，每条都是服务端刚确认存在的。
静态供数没有那次查询，**任何手工拼装都可能造出现实中不存在的组合**——
portfolio 属于 A 台、counterparty 没在 A 台开户。服务端返回业务拒绝，
报告里看到的是"错误率 12%"，**看起来像性能问题，实际是数据问题**，极难定位。

所以三个归属字段必须**整组来自同一份真实 curl**：

- ⚠ `counterpartyFmId` 与 `counterpartyName` 服务端会做一致性校验，不要两处拼凑
- ⚠ `portfolioId` 与 counterparty 的组合必须是已验证可用的（建过 trade 的那组）

内嵌进用例行正是把"同源"固化成结构：一行填完就是一组已验证组合，
不存在跨文件对错行的可能。

## 静态数据的失效方式（为什么 preflight 不能省）

Counterparty / Portfolio 由 sync batch job 从第三方同步，变更频率以周/月计，
静态化在压测的时间尺度上成立。但失效方式变了：

- `live` 模式：数据失效 → setup 当场查不到 → 立刻暴露
- 静态供数：id 已在库中不存在 → **请求照发，服务端业务拒绝** → 报告里只是错误率升高

所以 `k6/setup/preflight.js` 的检查 2（真发一笔 create）是唯一能证明
"这条用例今天仍然可用"的东西，不能跳过。

## 怎么填（当前全是 TBC）

**最省事的办法是一次性拿全**：在 OREO Web 上手工建一笔 trade，开着 Chrome DevTools
的 Network 面板，对 `POST /trades/create` 右键 → Copy as cURL。这一份 curl 同时给你：

- 三个归属字段的**真实且已配对**的值
- 真实的 `.dat` 文件（在 request payload 里，另存到 `../dat/products/<productType>/`）
- 真实的 payload 字段名与嵌套结构（校准 `steps/.../create-trade.js` 的 buildTradePayload）
- 真实的 header 集合（校准 `X-User-Id` 大小写、`X-Dyn-Run` 语义）

每换一个 productType / counterparty 重复一次，一行一行填进 `rows`。

⚠ preflight 的本地检查会因为 `TBC` 中止测试，这是刻意的：带着 TBC 能跑，
但每一行都会被服务端拒绝，整轮数据白跑。

⚠ 采集来的 curl / 响应样本放本目录 `_samples/`（已 gitignore）——
DevTools 导出带着会话 cookie、真实 counterparty 名称，**不能进版本库**。

## 对照实验：portfolio 级锁竞争

全部 VU 打同一个 portfolio 的实验不再需要单独的池文件：
复制 `create-trade-data.json` 为一个变体（所有行填同一组归属值），
用 `CREATE_DATA_FILE=<变体路径>` 指过去即可。

## 刷新策略

不需要定期刷新，但下列情况必须重新采集：

- 换环境（dev → sit → perf）——id 不跨环境通用
- preflight create 开始失败
- 压测错误率里出现大量"counterparty not found / not entitled"类业务拒绝

采集时间与来源记在 `note` 字段，事后才能回答"这批数据是什么时候的"。
