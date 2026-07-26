# Swagger 2.0 / OpenAPI 3.x 解析差异

两者不是「版本号不同」那么简单,要改的地方是实打实的。`parse_swagger.py`
把这些差异全部吸收在解析层,下游只看到统一的 `api-catalog.json`。

| | Swagger 2.0 | OpenAPI 3.x |
|---|---|---|
| 版本字段 | `swagger: "2.0"` | `openapi: "3.0.x"` |
| 基础 URL | `schemes` + `host` + `basePath` 三个字段拼 | 一个 `servers[]` |
| 请求体 | `parameters` 里 `in: body` 的那一项 | 独立的 `requestBody.content[媒体类型]` |
| 模型定义 | `definitions` | `components/schemas` |
| 引用 | `#/definitions/X` | `#/components/schemas/X` |
| Bearer 鉴权 | 无原生表达,写成 `type: apiKey, name: Authorization, in: header` | `type: http, scheme: bearer` |
| 表单 | `in: formData` 参数 | `requestBody` + 对应 content-type |
| 内容类型 | 顶层或操作级 `consumes` / `produces` | 每个 `content` 的键 |

## Springfox 泛型名坑

国内 Java 团队的 Swagger 2.0 多由 Springfox / Knife4j 生成,入口通常是活的 URL
(`http://host/v2/api-docs`)而不是文件——好处是永远最新。

坑在于泛型返回类型的定义名:

```
Result«List«OrderVO»»
```

`«»` 是 U+00AB / U+00BB,在 `$ref` 里常被百分号编码:

```json
{ "$ref": "#/definitions/Result%C2%ABList%C2%ABOrderVO%C2%BB%C2%BB" }
```

不做 `urllib.parse.unquote` 的话这些引用一律解析失败,**body 示例会全空**。
`parse_swagger.py:resolve_ref()` 已处理,回归用例在
`tests/fixtures/swagger-v2.json` 里。

## 其他解析约定

- **循环引用**:`Tree.children: [Tree]` 这类自引用模型会打爆递归。按 `$ref` 路径
  去重,重复出现时返回 `{}`;另有 `MAX_DEPTH = 6` 兜底。
- **组合类型**:`allOf` 合并所有分支的属性;`oneOf` / `anyOf` 取第一个分支。
  压测不需要覆盖所有变体。
- **示例值优先级**:`example` > `default` > `enum[0]` > 按 type 生成零值。
- **path 级 parameters**:Swagger 允许在 path 层声明所有方法共用的参数,
  解析时会与操作级参数合并。

## 接口太多时

`/v2/api-docs` 动辄 500KB、几百个接口。直接塞进上下文既贵又会淹没关键信息。

```bash
python3 scripts/parse_swagger.py http://host/v2/api-docs --filter /orders -o api-catalog.json
```

先收窄到目标业务域,再和用户讨论场景。

## Swagger 给不了的东西

规范里**不存在**这些概念,它们必须由用户提供:

- 可用的测试环境地址(文档里的 `host` 通常是文档服务器)
- 真实存在的参数值(哪个 `productId` 在测试环境里真的有货)
- 登录去哪拿 token
- 接口之间的业务顺序

**这正是 curl 的价值**:一条能跑通的 curl 同时带来真实的 header、真实的 body
和真实存在的参数值。合并后 `path_var_examples` 字段里就是可直接用的真实 ID。
