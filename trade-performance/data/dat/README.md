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

## 目前状态

**空目录，需要业务/开发提供真实样本。** 未提供前只有 smoke 能跑（且会失败在文件不存在）。

需要确认（README「待确认事项」#3）：
- 支持哪些产品类型
- 各类型的典型文件大小区间（决定 small/medium/large 的实际阈值）
- 生产中的产品分布占比（决定混合场景里各类型的权重）

## 命名与 CSV 的对应

`data/create-trade/create-trade-data.csv` 的 `datFile` 列是**相对 `data/dat/` 的路径**，
在 JMX 里拼成 `${datDir}/${datFile}`。新增文件后同步加 CSV 行即可，不必改脚本。

## 不要提交大文件

`large/` 下的样本可能有几十 MB。建议只提交 `small/`，其余走对象存储或本地生成脚本，
在 `.gitignore` 里排除。当前 `.gitignore` 尚未配置此项——加之前先确认真实文件体积。
