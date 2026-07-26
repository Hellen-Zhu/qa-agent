# scenario 字段契约

`.yaml`(需 PyYAML)或 `.json`(零依赖)均可,结构完全相同。

## 顶层

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 否 | 测试计划名,显示在 GUI 顶部 |
| `base_url` | **是** | 含协议、域名、端口、basePath。如 `http://staging.example.com:8080/api` |
| `data` | 否 | CSV 参数化,见下 |
| `defaults` | 否 | 全局默认 headers 与 think_time |
| `thread_groups` | **是** | 负载单元列表 |
| `flows` | **是** | 业务流列表 |
| `connect_timeout` / `response_timeout` | 否 | 毫秒,默认 10000 / 60000 |

`base_url` 的 basePath 会自动前缀到每个 sampler 路径。Swagger 的 path 是相对的
(`/orders`),curl 的路径是完整的(`/api/orders`)——合并时按后缀段对齐,
所以两种来源混用不会重复拼 basePath。

## data —— CSV 参数化

```yaml
data:
  file: users.csv          # 相对于 JMeter 的运行目录
  vars: [username, password]
  recycle: true            # 用完循环。线程数 > 账号数时必须开,否则线程会被停掉
```

假定 CSV **带表头行**(生成的配置里 `ignoreFirstLine=true`)。变量名以 `vars` 为准,
不依赖表头解析——表头带 BOM 或空格时会污染变量名。

## defaults

```yaml
defaults:
  headers: { Content-Type: application/json }
  think_time: 1000         # 毫秒,每个步骤可单独覆盖
```

## thread_groups —— 负载单元

```yaml
thread_groups:
  - name: 主流量
    load: { threads: 500, ramp_up: 120, hold: 600 }   # 秒
    login:
      api: "POST /auth/login"
      body: { username: "${username}", password: "${password}" }
      extract: { token: "$.data.accessToken" }
      assert: { jsonpath: "$.code", equals: "0" }
    auth_header: { Authorization: "Bearer ${token}" }
    mix:                                              # 权重必须合计 100
      - { flow: 商品浏览, weight: 70 }
      - { flow: 下单主链路, weight: 30 }
```

- `login` 放进 **Once Only Controller**:每个虚拟用户只登录一次,之后复用 token。
  真实用户不会每点一次就重新登录,把登录算进混合比例是建模错误。
- `auth_header` 挂在 **Throughput Controller 层**而非线程组层。挂线程组层的话,
  登录请求自己也会带上一个还没提取出来的 `${token}` 字面量。
- `load` 会被写成 `${__P(tg1.threads,500)}`,所以同一份 jmx 能被 CI 用
  `-J tg1.threads=1000` 复用,不必重新生成。多个线程组按序号 `tg1` / `tg2`。

## flows —— 业务流

```yaml
flows:
  - name: 商品浏览
    steps:
      - api: "GET /products"              # 必须能在 catalog 中命中
        name: 商品列表                     # 可选,GUI 里的显示名
        query: { page: 1, size: 20 }
        extract: { productId: "$.data.list[0].id" }
      - api: "GET /products/{id}"
        path_vars: { id: "${productId}" }  # 路径参数,必填项缺失会被拦下
        headers: { X-Trace: "load-test" }  # 该步专属请求头
        think_time: 2000
        assert: { status: 200 }
```

### 变量作用域规则(生成器强制校验)

flow 内引用的每个 `${var}`,只能来自三个源头:

1. CSV 的列
2. 本 thread_group 的 `login.extract`
3. **本 flow 内更早步骤**的 `extract`

**跨 flow 引用会被拒绝生成。** 混合比例下 flow 之间没有执行顺序保证——
「下单」可能在「商品浏览」之前被抽中,那时 `${productId}` 还不存在。JMeter 不会报错,
只会把字面量原样发出去,服务端回 400,你会以为是业务 bug。

`${__P(...)}`、`${__Random(1,100)}` 等 JMeter 内置函数不参与校验,原样透传。

### assert

```yaml
assert:
  status: 200                # 或 [200, 201]
  jsonpath: "$.code"
  equals: "0"
  contains: "success"        # 响应体子串
```

未声明 `assert` 时走 `gen_jmx.py` 里的 `default_assertions()`——
默认只断言 HTTP 2xx,业务码策略需按团队约定补。

### body

- 步骤写了 `body` → 用步骤的
- 否则用 catalog 里的(curl 抓到的真实 body 优先于 Swagger 推导的空壳)
- `body` 非空时走 raw 模式;若同时有 `query`,query 会被拼进 URL
