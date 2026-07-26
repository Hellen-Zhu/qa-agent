# .dat 文件池

**这是本接口的首要测试资产。** `POST /trades/create` 的 payload 只有 4 个字段（归属信息），
交易的产品类型、名义金额、期限、复杂度**全部由 .dat 决定**——所以变异维度在这里，不在 CSV。

## 目录约定

```
small/     典型小文件      —— 基线与容量测试主力
medium/    典型中等文件
large/     压力上限文件     —— 用于验证 DAT 解析的 CPU 争抢（进程内竞争，见 v2 方案场景 D）
invalid/   坏文件           —— 验证 fail-fast，不应把 CPU 浪费在必然失败的解析上
```

`invalid/` 至少覆盖四种：

| 文件 | 构造方式 | 期望 |
|---|---|---|
| `corrupt.dat` | 正常文件中间字节随机翻转 | 快速拒绝，不应超时 |
| `truncated.dat` | 正常文件截断到 50% | 快速拒绝 |
| `empty.dat` | 0 字节 | 快速拒绝，且不应抛未捕获异常 |
| `wrong-format.dat` | 直接放一个 .txt/.png | 快速拒绝 |

**为什么 invalid 用例算性能测试**：一个不能 fail-fast 的解析器，在生产里被批量坏文件打中时会
把 CPU 全部吃掉，拖垮同进程内所有接口——包括与它毫无业务关系的 refdata 查询。

## 分档的真实含义：productType 决定体积，不是相反

`small/ medium/ large/` 是按**体积**分的，但体积不是一个可以自由设定的变量——
**它是产品结构的结果**。一笔 TARF 的文件之所以大，是因为它有 24 个定盘；
现实中不存在"TARF × small"这种组合。

所以采样时**按 productType 收集，让体积自然落到某一档**，不要反过来"为 large 档凑一个文件"。
详见 [Workload Modeling §4.7](../../../docs/performance/workload-modeling.zh.md)。

需要收集的是 [A26](../../../docs/performance/workload-modeling.zh.md) 的**三个代表产品**：

| 代表 | 选取依据 | 用途 |
|---|---|---|
| **最便宜** | 定盘 1 次、bullet、封闭解定价 | 成本下界 |
| **最贵** | 定盘最多、schedule 最长、路径依赖定价 | **成本上界 —— 决定并发目标与内存上限** |
| **最常见** | 迁移数据集里占比最高的类型 | 常态验收 |

按成本驱动因子分类而非枚举全部产品的理由，以及**成本信封**（新产品何时需要重测）见
[Workload Modeling §4.7.2 / §4.7.5](../../../docs/performance/workload-modeling.zh.md)。

## 目前状态

**空目录，需要业务/开发提供真实样本。** 未提供前只有 smoke 能跑（且会失败在文件不存在）。

需要确认：
- **Composer 产品目录**（A24）：支持哪些 productType，各自定盘次数与 schedule 形态
- **迁移数据集 / 前置系统的产品分布统计**（A25）——这一条把配比从"猜"变成"统计"，
  是 [§4.7.6](../../../docs/performance/workload-modeling.zh.md) 里可靠性最高的数据来源
- 各类型的典型文件大小区间（据此定 small/medium/large 的实际阈值）

## 命名与 CSV 的对应

`data/create-trade/create-trade-data.csv` 的 `datFile` 列是**相对 `data/dat/` 的路径**，
在 JMX 里拼成 `${datDir}/${datFile}`。新增文件后同步加 CSV 行即可，不必改脚本。

CSV 的 `costTier` 与 `fixings` 两列是**结果标签**（进 jtl 的额外列，用于按成本维度切分），
不影响请求内容。**当前它们是 `TBC`，`scripts/validate.py` 会因此报错**——
这是刻意的：带着 TBC 能跑得通，但"P95 对定盘次数"这条成本曲线整列是 TBC，整轮数据白跑。

## 不要提交大文件

`large/` 下的样本可能有几十 MB。建议只提交 `small/`，其余走对象存储或本地生成脚本，
在 `.gitignore` 里排除。当前 `.gitignore` 尚未配置此项——加之前先确认真实文件体积。
