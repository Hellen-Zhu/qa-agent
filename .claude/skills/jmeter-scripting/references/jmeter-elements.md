# JMeter 元件选型与陷阱

## 命名陷阱:Throughput Controller 不控制吞吐量

它控制的是**执行比例**,不是 RPS。真正控制 RPS 的是 **Constant Throughput Timer**。

这个误解非常普遍:配了 Throughput Controller 以为限住了 QPS,结果压出来的数
完全不是想要的。本 skill 用它做流量构成(70% 浏览 / 30% 下单),
需要限 RPS 时另加 Constant Throughput Timer。

配置要点:

| 属性 | 取值 | 含义 |
|---|---|---|
| `style` | `1` | Percent Executions(按百分比)。`0` 是 Total Executions(按固定次数) |
| `perThread` | `false` | 百分比在全局收敛,符合「流量构成比例」语义 |
| `percentThroughput` | `70.0` | 每次迭代掷骰子决定是否执行,短期有偏差、长期收敛 |

`perThread=true` 时每个用户各自按 70/30 执行,是另一种语义,一般不是你想要的。

## Once Only Controller

语义是「每个线程只在**第一次迭代**执行」。这正好是「每个虚拟用户登录一次然后复用
token」的精确建模。

不要用 setUp Thread Group 做登录:setUp 是全局跑一次,拿到的是**单个** token,
所有虚拟用户共用同一账号,会撞服务端限流和缓存,压的不是业务。

## 线程组:正式与冒烟的差异

| | 正式 | 冒烟 |
|---|---|---|
| `num_threads` | `${__P(tg1.threads,500)}` | `1` |
| `LoopController.loops` | `-1`(无限) | `1` |
| `scheduler` | `true` | `false` |
| `duration` | `${__P(tg1.hold,600)}` | `0` |

正式模式下 loops 必须是 `-1`,由 `duration` 控制时长;写成有限次数会导致
线程提前结束,ramp-up 还没完就没人了。

## 关联提取:JSON Extractor

```
referenceNames  = token
jsonPathExprs   = $.data.accessToken
match_numbers   = 1
defaultValues   = __EXTRACT_FAILED__
```

`defaultValues` 必须写成可检测的哨兵,不要留空。留空时提取失败,JMeter 会把
**字面量 `${token}` 原样发送**,不警告不报错——排查成本极高。写了哨兵之后,
冒烟阶段 grep 一下就能定位到具体哪一步失败。

## 断言

| 元件 | 用途 | 关键属性 |
|---|---|---|
| Response Assertion | 状态码、响应体子串 | `Assertion.test_field` + `test_type` |
| JSON Assertion | 业务码、结构字段 | `JSON_PATH` + `EXPECTED_VALUE` |

`test_type` 位标志:`1` Matches(整体正则)、`2` Contains(正则子串)、
`8` Equals、`16` Substring。

**格式坑**:Response Assertion 的集合属性名在 JMeter 里就是拼错的
——`Asserion.test_strings`(少一个 t)。必须照抄,改成正确拼写 JMeter 反而读不到。

**性能坑**:每个 JSON Assertion 都要解析响应体。高并发下压测机自己的 CPU 可能
先被断言吃满,测出来的 p95 里混着压测机开销。关键步骤断言,不必每步都断。

## 定时器作用域

定时器在其作用域内的 sampler 执行**之前**生效。挂在某个 step 下 =
执行该 step 前先等待。挂在线程组层会作用于该线程组内**所有** sampler,
通常不是你想要的。

## 不要加的东西

- **View Results Tree / Aggregate Report 等 GUI Listener**:无头压测里是性能杀手,
  内存占用随样本数线性增长。结果走 `-l result.jtl`,报告用 `-e -o report/` 生成。
- **正式压测时的 samplerData 保存**:那是冒烟专用。开着会让 .jtl 体积爆炸。

## 运行命令

```bash
# 冒烟(保存请求数据,便于诊断)
jmeter -n -t testplan.smoke.jmx -l smoke.jtl \
  -Jjmeter.save.saveservice.output_format=xml \
  -Jjmeter.save.saveservice.samplerData=true

# 正式(默认 CSV 输出 + HTML 报告)
jmeter -n -t testplan.jmx -l result.jtl -e -o report/ -J tg1.threads=1000
```
