# 网关

网关把"多家供应商的模型"聚合为一套稳定别名，并负责把请求转发到正确的上游。

## 别名格式

```
lmm-<providerKey>/<model>
```

- `providerKey`：由供应商名称派生，小写、非字母数字转 `-`、最长 24 字符；租户内唯一，重名追加 `-2`、`-3`。
- `model`：供应商声明的原始模型名，原样拼接（含斜杠也安全，解析时只按第一个 `/` 切分）。
- 只有 `enabled=true` 的供应商会发布别名。

示例：

| 供应商 | providerKey | 模型 | 别名 |
| --- | --- | --- | --- |
| Mock OpenAI | `mock-openai` | `gpt-x` | `lmm-mock-openai/gpt-x` |
| Mock Anthropic | `mock-anthropic` | `claude-x` | `lmm-mock-anthropic/claude-x` |

## 选路

`resolveModel(requested, providers)` 返回三种结果：

### 1. 命中别名（`kind: 'alias'`）

只路由到该供应商，并把上游请求体的 `model` 改写成原始模型名。**不做故障转移。**

以下任一情况返回 `kind: 'invalid'`，网关回 **400**，绝不回落到默认供应商：

| 情况 | 错误信息 |
| --- | --- |
| 缺 `/` 分隔符 | `别名 ... 缺少 "/" 分隔符` |
| key 或 model 为空 | `别名 ... 格式不完整` |
| 未知 providerKey | `未知供应商 key: xxx` |
| 供应商已禁用 | `供应商 X 已禁用` |
| 模型未在该供应商声明 | `供应商 X 未声明模型 Y` |

> 为什么必须报错：回落会用另一家的额度、回答另一个模型，而调用方完全看不出来。

### 2. 不带别名（`kind: 'default'`）

在"已启用且协议匹配"的供应商里，优先取默认供应商，否则取 `priority` 最小的一家。
上游模型名取 `settings.defaultModel`（若默认供应商同时配置了它），否则用请求里的原值。

**回退**：主供应商返回 5xx 或连接失败时，按 `priority` 顺序尝试下**一家**（只一次），
成功时响应头带 `x-llmapi-fallback: 1`。别名请求不参与回退。

**4xx 不回退**：400/401/403/429 这类错误是请求本身的问题（模型名、参数、额度、鉴权），
换一家大概率同样失败，还会掩盖真实原因。此时上游的状态码与错误体会**原样透传**给客户端。

> 实现注意：主供应商那次转发是"延迟写"模式（为了给回退留出机会，失败时先不碰 response）。
> 因此一旦判定不回退，必须调用 `writeDeferredError` 把错误补写给客户端；
> 漏掉这一步的表现是上游 4xx、客户端却收到 `200` + 空 body（真实踩过的 bug）。
> 回归用例：`server/test/smoke.test.ts` 的「上游 4xx 且存在备选时不回退，并把错误原样透传」。

### 3. 无可用供应商

返回 400，消息里带的是该路径要求的 `apiType`，例如 `/v1/responses` 下是
`没有启用的 responses 供应商，请先在控制台添加并启用`，`/v1/chat/completions` 下是
`没有启用的 openai 供应商，请先在控制台添加并启用`。

注意这里只看"启用 + 协议匹配"的供应商：一家 `openai` 供应商再健康，也不会被算作
`/v1/responses` 的可用候选。

## 协议匹配

| 路径 | 要求的上游 `apiType` |
| --- | --- |
| `/v1/chat/completions` | `openai`（Chat Completions） |
| `/v1/messages` | `anthropic`（Messages） |
| `/v1/responses` | `responses`（OpenAI Responses API） |

对应的前端文案统一为「<厂商> 兼容（<API 形态>）」：**OpenAI 兼容（Chat Completions）** /
**OpenAI 兼容（Responses）** / **Anthropic 兼容（Messages）**。三段文案在
`web/src/lib/labels.ts`（下拉、徽标）与 `server/src/domain/provider.ts`（报错）各有一份，
口径必须一致；判断"接哪条路"看括号里的 API 形态，不要只看厂商名。

三条路径都是**严格匹配**：不匹配时返回 **501**，消息明确说明"骨架期不做协议转换"，
不会静默转发到错误路径。

`/v1/responses` 早期是"不限协议"的直通路径，那会把 Responses 请求发给只支持 Chat
的上游，表现为上游报参数错误。现在要求供应商协议就是 `responses`，
双向都被拦住：`responses` 供应商也接不了 `/v1/chat/completions`。

### 协议与鉴权头

`openai` 与 `responses` 同属 OpenAI 体系，都用 `Authorization: Bearer <上游 Key>`；
只有 `anthropic` 用 `x-api-key` 加 `anthropic-version`。

## 上游地址拼接

```
baseUrl = https://api.example.com        → https://api.example.com/v1/chat/completions
baseUrl = https://api.example.com/v1     → https://api.example.com/v1/chat/completions
baseUrl = https://api.example.com/v1/    → https://api.example.com/v1/chat/completions
```

规则：去掉尾部 `/`；若已以 `/v1` 结尾则不重复添加。

## 请求头

| 上游类型 | 注入 | 透传 |
| --- | --- | --- |
| `openai` | `Authorization: Bearer <上游 Key>` | `openai-organization`、`openai-project`、`accept` |
| `responses` | `Authorization: Bearer <上游 Key>` | `openai-organization`、`openai-project`、`accept` |
| `anthropic` | `x-api-key: <上游 Key>`、`anthropic-version`（默认 `2023-06-01`） | `anthropic-beta`、`accept` |

实现上按"鉴权体系"分组而不是逐个协议罗列：`openai` 与 `responses` 共用 Bearer 分支，
只有 `anthropic` 走 `x-api-key`。新增协议时不要复制一个 if 分支，否则很容易漏掉。

客户端自带的鉴权头**不会**传给上游 —— 网关头只用于校验本服务令牌。

## 流式转发

`"stream": true` 时：

1. 响应头设 `content-type: text/event-stream`、`cache-control: no-cache, no-transform`、
   `x-accel-buffering: no`（避免反代缓冲）。
2. 逐块 `read()` 上游 body 并原样 `write()` 给客户端，**不做分片重组或改写**。
3. 客户端断开时 abort 上游请求，避免上游继续生成没人要的 token。

> 实现注意：监听的是**响应流**的 `close` 且只在 `!reply.writableFinished` 时 abort。
> 不要改成监听请求的 `close` —— Node 在请求体读完后就会触发它，会把刚发出的上游请求立即中止。

## 日志

每次尝试都写一条记录到 `data/tenants/<id>/requests.jsonl`，字段见 [api.md](./api.md#日志与统计)。
回退时会产生两条：主供应商失败一条、备选成功一条（后者 `fallback: true`）。

日志写入失败只记服务端告警，不影响转发结果。

## 当前限制

- 不做协议转换：跨协议调用返回 501。
- 不做计费与限流：每个请求都直接打上游。
- 无熔断器：连续失败的供应商不会被自动摘除，只会因为 5xx 触发一次回退。
- 不重写参数与模型映射：上游模型名只由别名或默认配置决定。
- 单次请求最多两次上游尝试（主 + 一次回退）。

## 调用示例

生成令牌后（见 [api.md](./api.md#post-apigatewaytoken)）：

```bash
# 别名：明确打到 Mock OpenAI 的 gpt-x
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lmm-mock-openai/gpt-x","messages":[{"role":"user","content":"hi"}]}'

# 不带别名：走默认供应商 + 默认模型，可享受一次回退
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-x","messages":[{"role":"user","content":"hi"}]}'

# 流式
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lmm-mock-openai/gpt-x","stream":true,"messages":[]}'

# Anthropic 形态（可用 x-api-key）
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lmm-mock-anthropic/claude-x","max_tokens":16,"messages":[]}'

# Responses 形态（必须打到 responses 供应商，请求体是 input 而不是 messages）
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lmm-mock-responses/gpt-resp","input":"hi"}'
```

注意最后两例的区别：`/v1/messages` 只能用 `anthropic` 供应商、`/v1/responses` 只能用
`responses` 供应商。拿 `openai` 供应商的别名去打 `/v1/responses` 会得到 501，而不是被当成
Chat 请求转发出去。
