# 参考数据（静态 CSV 模式）

`portfolio` / `counterparty` 的取数有两种模式，**同一套下游脚本共用**：

| 模式 | 来源 | 谁在用 | 何时用 |
|---|---|---|---|
| `pool`（动态，默认） | setUp 里查 `GET /refdata/*` 建池 | `s01` E2E 场景 | refdata 查询本身是被测链路的一部分 |
| `csv`（静态） | 本目录的 CSV | `p02` 单接口压测 | 只想测 create，refdata 是噪音 |

模式由**计划级 UDV `refdataSource`** 决定，不是全局属性——因为同一次跑批里
E2E 和单接口计划可能并存，全局属性会互相污染。

## 为什么可以静态化

Counterparty / Portfolio 由 sync batch job 从第三方同步，**变更频率以周/月计**，
而一轮压测的生命周期以小时计。在这个时间尺度上它们是常量。

真正的代价不是"数据会变"，而是**失效方式变了**：

- 动态模式：数据失效 → setUp 当场查不到 → 立刻暴露
- 静态模式：数据失效 → CSV 里的 id 已在库中不存在 → **请求照发，服务端业务拒绝**

后者在报告里表现为错误率升高，而不是启动失败。所以静态模式**必须保留 preflight
create**（`jmx/fragments/setup/csv-refdata-preflight.jmx`）：它是唯一能证明
"这行 CSV 今天仍然可用"的东西。refdata 查询返回 200 都证明不了这件事，一行 CSV 更不能。

## 为什么一行一对，而不是两个独立列表

两个独立列表 = 笛卡尔积。动态取数时无害（池里每条都是服务端刚确认存在的），
静态化之后会造出**现实中不存在的组合**——portfolio 属于 A 台、counterparty 没在
A 台开户。服务端返回业务拒绝，报告里看到的是"错误率 12%"，
**看起来像性能问题，实际是数据问题**，而且极难定位。

一行一对，每行都是一个已验证可用的组合。失去了组合多样性，
但对容量测试而言 5 组可用组合远胜 25 组半数无效的组合。

⚠ `counterpartyFmId` 与 `counterpartyName` **必须同源**——它们在服务端会做一致性校验。
不要手工拼两个不同来源的值。

## 文件

| 文件 | 用途 |
|---|---|
| `refdata-pairs.csv` | 默认池。roundRobin 轮换（线程 N 取第 `N % 行数` 行） |
| `refdata-pairs-single.csv` | 单行池。全部线程打同一个 portfolio，测 portfolio 级锁竞争 |

切换用属性，不改脚本：

```bash
./scripts/run.sh p02-trade-create dev load \
    -JrefdataFile=data/refdata/refdata-pairs-single.csv
```

## 怎么填（当前全是 TBC）

**最省事的办法是一次性拿全**：在 OREO Web 上手工建一笔 trade，开着 Chrome DevTools
的 Network 面板，对 `POST /trades/create` 右键 → Copy as cURL。这一份 curl 同时给你：

- `portfolioId` / `counterpartyFmId` / `counterpartyName` 的**真实且已配对**的值
- 真实的 `.dat` 文件（在 request payload 里，另存到 `data/dat/small/`）
- 真实的 payload 字段名与嵌套结构（校准 `groovy/build-trade-payload.groovy`）
- 真实的 header 集合（校准 `X-User-Id` 大小写、`X-Dyn-Run` 语义）

重复 5 次、每次换不同的 counterparty，就得到 5 行。

⚠ `scripts/validate.py` 会因为 `TBC` 报错，这是刻意的：带着 TBC 能跑，
但每一行都会被服务端拒绝，整轮数据白跑。

## 刷新策略

不需要定期刷新，但下列情况必须重新采集：

- 换环境（dev → sit → perf）——id 不跨环境通用
- preflight create 开始失败
- 压测错误率里出现大量"counterparty not found / not entitled"类业务拒绝

采集时间与来源记在 `note` 列，事后才能回答"这批数据是什么时候的"。

## CSV 格式注意

**表头列名与 JMX 里的 `variableNames` 是两套东西**（`ignoreFirstLine=true`，运行时表头被忽略）。
末列表头叫 `note`、JMX 里叫 `refdataNote`：前者让 `scripts/validate.py` 认出这是自由文本列
（否则里面写个 "TBC 待确认" 会被当成占位值报错），后者避免与 `accounts.csv` 的 `userNote` 撞名。
`accounts.csv` 是同样的模式（表头 `role` / JMX `userRole`）。

`quotedData=false`。`counterpartyName` 已知含 `*`（如 `PRINTINGINT10LTD*HKG`），无妨；
但**若真实名称含逗号**，必须把 `p02` 里该 CSV Data Set 的 `quotedData` 改为 `true`
并给字段加引号，否则列会错位——错位后 `counterpartyName` 会串进 `refdataNote`，
请求仍然发得出去，只是全部业务失败。
