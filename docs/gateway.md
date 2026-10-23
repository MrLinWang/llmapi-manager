# 网关

网关把"多家供应商的模型"聚合为一套稳定别名，并负责把请求转发到正确的上游。

## 别名格式

```
lam-<providerKey>/<model>
```

- `providerKey`：由供应商名称派生，小写、非字母数字转 `-`、最长 24 字符；租户内唯一，重名追加 `-2`、`-3`。
- `model`：供应商声明的原始模型名，原样拼接（含斜杠也安全，解析时只按第一个 `/` 切分）。
- 只有 `enabled=true` 的供应商会发布别名。

> **前缀是硬编码常量**（`server/src/domain/aliases.ts` 的 `ALIAS_PREFIX`）。只有以它开头的 model
> 才会被当作别名解析；改了前缀，旧写法就不再匹配 `isAliasShape`，于是被当成"不带别名"走默认选路，
> 原样透传给上游（多数上游会报模型不存在）—— 与"未知别名返回 400"不是一回事，也更难排查。
> 升级后请重新应用 Agent 配置（Codex 的 `model`、Claude Code 的 `ANTHROPIC_MODEL` 都会重写），
> 并更新其它客户端里写死的模型名。网关令牌前缀是另一个常量（`server/src/gateway/token.ts`），
> 它只影响新签发的令牌；旧令牌因为只存哈希，改名后继续有效。

示例：

| 供应商 | providerKey | 模型 | 别名 |
| --- | --- | --- | --- |
| Mock OpenAI | `mock-openai` | `gpt-x` | `lam-mock-openai/gpt-x` |
| Mock Anthropic | `mock-anthropic` | `claude-x` | `lam-mock-anthropic/claude-x` |

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

默认是**严格匹配**：不匹配时返回 **501**，不会静默转发到错误路径。
唯一的例外是设置项 `protocolConversion` 打开后的 `/v1/responses → openai`，
见下方「跨协议转发」。

`/v1/responses` 早期是"不限协议"的直通路径，那会把 Responses 请求发给只支持 Chat
的上游，表现为上游报参数错误。现在默认要求供应商协议就是 `responses`；
反向同样被拦住：`responses` 供应商接不了 `/v1/chat/completions`——
那个方向没有转换器，开着开关也仍然是 501。

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
2. 逐块 `read()` 上游 body。**不转换协议时**原样 `write()` 给客户端，不做分片重组或改写；
   **转换协议时**上游的 Chat SSE 按行解析、翻译成 Responses 事件再写出（见「跨协议转发」）。
3. 客户端断开时 abort 上游请求，避免上游继续生成没人要的 token。

> 实现注意：监听的是**响应流**的 `close` 且只在 `!reply.writableFinished` 时 abort。
> 不要改成监听请求的 `close` —— Node 在请求体读完后就会触发它，会把刚发出的上游请求立即中止。

## 日志

每次尝试都写一条记录到 `data/tenants/<id>/requests.jsonl`，字段见 [api.md](./api.md#日志与统计)。
回退时会产生两条：主供应商失败一条、备选成功一条（后者 `fallback: true`）。

日志写入失败只记服务端告警，不影响转发结果。

## 当前限制

- 协议转换只做 `/v1/responses → openai` 一个方向（默认关闭）。其余组合一律 501，
  即便 `protocolConversion` 开着也不转换。
- 不做计费与限流：每个请求都直接打上游。
- 无熔断器：连续失败的供应商不会被自动摘除，只会因为 5xx 触发一次回退。
- 不重写参数与模型映射：上游模型名只由别名、默认配置，以及「Approve for me」的
  `approvalReviewModel` 映射决定。
- 单次请求最多两次上游尝试（主 + 一次回退）。

## 调用示例

生成令牌后（见 [api.md](./api.md#post-apigatewaytoken)）：

```bash
# 别名：明确打到 Mock OpenAI 的 gpt-x
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lam-mock-openai/gpt-x","messages":[{"role":"user","content":"hi"}]}'

# 不带别名：走默认供应商 + 默认模型，可享受一次回退
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-x","messages":[{"role":"user","content":"hi"}]}'

# 流式
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lam-mock-openai/gpt-x","stream":true,"messages":[]}'

# Anthropic 形态（可用 x-api-key）
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lam-mock-anthropic/claude-x","max_tokens":16,"messages":[]}'

# Responses 形态（必须打到 responses 供应商，请求体是 input 而不是 messages）
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lam-mock-responses/gpt-resp","input":"hi"}'
```

注意最后两例的区别：`/v1/messages` 只能用 `anthropic` 供应商、`/v1/responses` 只能用
`responses` 供应商。拿 `openai` 供应商的别名去打 `/v1/responses` 会得到 501，而不是被当成
Chat 请求转发出去。

## 「Approve for me」的模型映射

Codex 在 API Key 认证下把自动审批的模型**硬编码**成 `gpt-5.6-luna`
（`model-provider/src/provider.rs` 的 `API_KEY_APPROVAL_REVIEW_PREFERRED_MODEL`）。
没有任何配置项能改它：

| 尝试 | 结果 |
| --- | --- |
| 目录条目 `auto_review_model_override` | ❌ 被 `ModelInfo → ModelPreset` 的转换丢弃 |
| `review_model`（config.toml） | ❌ 只给 `/review` 用，guardian 不读 |
| `model_providers.*` 任何字段 | ❌ 没有相关配置 |

但**走网关时**这个名字会原样出现在请求体里，于是可以把它当占位名换掉。

判定依据是请求头 `x-codex-turn-metadata` 里的 `turn_trigger === "guardian_review"`——
审批请求带这个标记。两个条件同时满足才改写：

1. 请求来自审批流程（`turn_trigger=guardian_review`）
2. 请求体里的 `model` 就是那个硬编码占位名

只靠其一都不行：只看模型名会把"用户真的拿 `gpt-5.6-luna` 聊天"也一起改掉；
只看 turn_trigger 则会在占位名变化（Codex 升级）时改错东西。

设置项是 `approvalReviewModel`，`null` 表示不映射。改写后的请求**不做故障转移**：
换个供应商大概率没有同名模型，多打一次上游只是浪费。

> 直连模式下这个功能无效——请求不经过本服务，网关看不到也改不了。

## 跨协议转发（Responses → Chat）

Codex CLI 只会发 `/v1/responses`，而很多上游只提供 Chat Completions。
开启设置项 `protocolConversion` 后，网关会在这个方向做双向转换。

| 方向 | 是否支持 |
| --- | --- |
| `/v1/responses` → `openai`（Chat） | ✅ 打开开关后 |
| `/v1/responses` → `anthropic` | ❌ 501 |
| `/v1/chat/completions` → `responses` | ❌ 501 |
| `/v1/messages` → `openai` | ❌ 501 |

**默认关闭**。但遇到协议不匹配时**会自动开启**，前提是"打开真的能解决问题"：

| 实例状态 | 行为 |
| --- | --- |
| 有启用的 `responses` 供应商 | 不自动开启（用 responses 就行） |
| 只有 `openai` 供应商，请求 `/v1/responses` | **自动开启**并持久化 |
| 只有 `openai` 供应商，请求 `/v1/messages` | 不开启（没有 `messages→chat` 转换器），仍 501 |

自动改动会在响应头带 `x-llmapi-auto-conversion: 1`，并写一条 info 日志——
用户得能发现行为被改了，不能悄悄发生。想固定住行为就在页面上手动设这个开关。

开关关着时若"打开就能解决"（`/v1/responses` 命中 `openai` 供应商），501 的 `error.details`
会带 `{ "canEnableConversion": true }`（前端据此弹"一键开启"提示）；其余组合不带这个标记。

同时有 `responses` 与 `openai` 供应商时，**协议完全匹配的排前面**（能直通就不转换，
转换有信息损失）；回退到不同协议的供应商时会连同转换一起做。

### 转换了什么

实现在 `server/src/gateway/convert/`，三个文件对应三个方向：

| 文件 | 作用 |
| --- | --- |
| `responsesToChat.ts` | 请求体：`input`/`instructions` → `messages`，工具定义改嵌套 |
| `chatToResponses.ts` | 非流式响应：`choices[].message` → `output[]` |
| `chatToResponsesStream.ts` | 流式：Chat delta → Responses 事件序列 |

关键映射：

- `instructions` → 首条 `system` 消息
- `input` 数组里的 `function_call` → 最近一条 assistant 的 `tool_calls`
- `input` 数组里的 `function_call_output` → `tool` 消息（保留 `call_id`）
- `custom_tool_call`（自由文本入参的工具，如 `apply_patch`）→ 参数为
  `{"input": "<原始文本>"}` 的 `function` 调用；对应的工具**定义**也转成
  只有 `input` 一个字符串参数的 function。响应方向再拆回
  `custom_tool_call`，否则 Codex 会按 `function_call` 解析，
  下一轮它发出的 `custom_tool_call_output` 就对不上
- `tools` 从扁平 `{type,name,parameters}` → 嵌套 `{type,function:{...}}`
- `max_output_tokens` → `max_tokens`
- `reasoning.effort` → `reasoning_effort`（取值域一致，直接透传；未知值也透传，
  让上游自己报错，比静默丢弃更容易发现版本不匹配）
- `input_image` 内容块 → Chat 的 `{type:"image_url", image_url:{url,detail}}`；
  纯文本内容会降级成字符串，兼容只认字符串的老上游
- 响应方向把 `choices[0].message.content` 变成 `output[].content[].text`，
  `tool_calls` 变成 `output[].type="function_call"`，`call_id` 必须原样保留
  （下一轮 `function_call_output` 靠它对应）

流式事件序列：

```
response.created
→ response.output_item.added      (message / function_call / reasoning)
→ response.output_text.delta      (正文增量)
→ response.function_call_arguments.delta
→ response.output_item.done
→ response.completed
```

`sequence_number` 必须单调递增；上游中途报错要转成 `response.failed`，
否则 Codex 会一直等下去。

### 有损的地方

转换函数会把丢弃的字段名收集到返回值的 `meta.dropped`，但**目前不会写进请求日志**
（`requests.jsonl` 没有对应字段），排查时需要直接在 `convert.test.ts` 里验证或看代码。

- **托管工具**（`web_search`、`file_search` 等）在 Chat 协议里没有等价物，转换时丢弃
  （记入 `meta.dropped`）。这也是为什么建议同时勾上「关闭联网搜索」。
- **有状态字段**（`previous_response_id`、`conversation`）直接报错而不是静默忽略——
  用户以为用了会话状态、实际没有，行为会莫名其妙且难排查。
- **推理内容**：Chat 上游的 `reasoning_content` 是非标准字段，有就转、没有就没有。
  流式时会产出 `reasoning_summary_text.delta` 并在结束时补 `done`，
  否则 Codex 的思考折叠区会一直显示"进行中"。
- **`reasoning.summary`**（要不要回传思考摘要）Chat 没有对应开关，丢弃。
- **custom 工具的流式参数**：Responses **确实有** `response.custom_tool_call_input.delta`
  事件（Codex 会解析它并交给 `apply_patch` 消费），不用它不是因为协议缺失，
  而是**编码对不上**：上游给的是 JSON 参数 `{"input": "…"}` 的分片，
  直接当 `input` 文本转发会带上引号与转义，Codex 收到的补丁内容就是错的。
  要做对得在网关里维护一个"分片 JSON 字符串解码器"。当前选择只在
  `output_item.done` 时一次性给出完整 `input`，代价是参数不流式显示。
- **图片的 `file_id` 形态**需要上游先解析成 URL，Chat 协议没有等价物，丢弃。
  直接给 `image_url` 的形态可以正常转换。
- 请求体的其余字段（`metadata`、`store` 等）对 Chat 无意义，丢弃。

> 请求体转换失败、或上游响应无法解析成 Chat 形状时，分别返回
> **400 `conversion_failed`**（发请求前就拒绝，不让上游收到残缺请求）与
> **502 `conversion_failed`**（上游返回了非预期结构）。

