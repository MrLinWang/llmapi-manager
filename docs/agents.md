# Agent 配置下发

把聚合后的网关地址、令牌与模型别名写进本机 Agent 的配置文件，让 Agent 直接用上这套聚合结果。

## 支持的 Agent

| id | 名称 | 文件 | 需要的上游协议 |
| --- | --- | --- | --- |
| `codex` | Codex CLI | `~/.codex/config.toml`、`~/.codex/auth.json`、`~/.codex/llmapi-model-catalog.json`（整份生成） | `responses` |
| `claude-code` | Claude Code | `~/.claude/settings.json` | `anthropic` |

路径由 `AgentPathResolver` 解析：优先取 `AGENT_HOME_DIR`，否则用服务进程所属 OS 用户的家目录。
它按 `{ tenantId, userId }` 计算，`registerTenantWorkspace()` 已预留为"每租户独立工作区"的入口。
结束进程时服务端还会读 `CODEX_HOME`（若设置）来定位 Codex 的配置目录。

## 选哪个供应商

Agent 只能用与自己协议匹配的供应商：

| Agent | 候选协议 |
| --- | --- |
| `codex` | `responses` |
| `claude-code` | `anthropic` |

> **Codex 只支持 Responses 协议。** 它已移除 `wire_api = "chat"`（见
> [openai/codex#7782](https://github.com/openai/codex/discussions/7782)），
> 配置写 `chat` 会直接拒绝启动。因此 Codex 只能绑定 `responses` 类型的供应商；
> 没有时预览/应用会返回 400 并提示去改供应商协议，**不会**退回写 `chat` 配置。

如果你的上游同时支持 Chat Completions 与 Responses（很多聚合上游都是），
而你又希望 Codex 和普通 Chat 客户端都能用，做法是建**两条供应商记录**指向同一个
`baseUrl` 与 Key：一条 `openai`（给 Chat 客户端）、一条 `responses`（给 Codex）。

对每个 Agent 所需的协议，选择顺序是：

1. 默认供应商协议匹配 → 用它；
2. 否则取第一个启用的、协议匹配的供应商（按 `priority`）；
3. 没有启用的匹配供应商 → 400。报错文案由 `apiTypeLabel` 拼出「<厂商> 兼容（<API 形态>）」，
   与前端下拉文案同源。Codex 的报错后面还会追加一句引导：
   `没有可用的 OpenAI 兼容（Responses） 供应商，请先添加并启用。Codex CLI 只支持 Responses 协议：
   请把某个供应商的协议类型改为「OpenAI 兼容（Responses）」，或新增一个 responses 供应商`；
   Claude Code 是 `没有可用的 Anthropic 兼容（Messages） 供应商，请先添加并启用`。

模型优先用"默认供应商 + 默认模型"的组合，否则取该供应商声明的第一个模型。
最终写入客户端的模型是**聚合别名** `lam-<providerKey>/<model>`，这样 Agent 的每次请求都会明确打到这一家。

## 写入内容

### Codex CLI

`config.toml` 最多改这 9 个键（顶层 4 个、`[model_providers.llmapi]` 表内 5 个；
`web_search` 在开关关闭时是"删除该行"而非写入）：

```toml
model_provider = "llmapi"
model = "lam-mock-responses/gpt-resp"
model_catalog_json = "/home/user/.codex/llmapi-model-catalog.json"   # 顶层键
web_search = "disabled"       # 由 disableCodexWebSearch 决定，默认写

[model_providers.llmapi]
name = "LLM API Manager"
base_url = "http://127.0.0.1:8787/v1"
model_catalog_url = "http://127.0.0.1:8787/v1/models"
wire_api = "responses"        # Codex 现已只接受 responses
requires_openai_auth = true  # 布尔 true，不是字符串 "true"
stream_max_retries = 10       # 由 codexStreamMaxRetries 决定，默认 10；整数不加引号
stream_idle_timeout_ms = 600000  # 由 codexStreamIdleTimeoutMs 决定，默认 600000
```

### 流式断流的两个参数：`stream_max_retries` 与 `stream_idle_timeout_ms`

聚合链路（尤其是中间还有反向代理时）常在空闲约 **60 秒**就掐断流式连接，
表现是 Codex 反复「重连 → 继续」，最终 `stream disconnected before completion:
Transport error: timeout`。这两个参数是 Codex 官方 `ModelProviderInfo` 的字段，可以缓解。

| 字段 | 默认写入 | 范围 | 作用 |
| --- | --- | --- | --- |
| `stream_max_retries` | `10` | 0–100 | 流被掐断后最多重连几次 |
| `stream_idle_timeout_ms` | `600000` | 1000–3600000 | 等流式活动的最长时间（毫秒） |

Codex 内置默认分别是 5 次和 300000ms；我们默认调高是因为实测断流间隔 42–64 秒、
而多数请求重试一两次就能拿到完整响应。

几处必须知道的取舍：

- **`stream_max_retries` 有硬上限 100**，Codex 内部用 `.min(MAX_STREAM_MAX_RETRIES)`
  **静默截断**。所以服务端在保存时就拒绝超限值（400），否则用户填 200 会以为生效了。
- **`stream_idle_timeout_ms` 没有硬上限**，但服务端限制在 1 秒–1 小时：
  再低必然误判，再长只会掩盖真实故障。
- **提高重试次数不能消除重连本身**，只是让每次被掐断后更可能接上。
  根因在链路（上游或反向代理的读超时），治本要调那一侧。
- **空了就删，不是"不写"**：把设置清空（null）时会向文件发**删除**指令。
  只"不写"会让上一版的值残留，界面显示未设置而文件里仍生效 —— 最难排查的一类不一致。
  删除只在当前值仍等于上次写入值时执行（取自绑定快照），用户手改过的值会保留。
- 两个值都是 `u64`，必须用 `raw` 标量写入（不加引号）。写成 `"10"` 在 TOML 里是字符串，
  Codex 会判类型不符 —— 与 `requires_openai_auth` 写布尔是同一类坑。


### 模型目录：`model_catalog_json` 与 `model_catalog_url`

Codex 的「切换模型」列表读的是模型目录，而不是把 `/v1/models` 的响应直接当列表用 ——
后者是 `{ object, data: [{ id }] }`，而目录要求 `{ models: [{ slug, ... }] }`，结构不同。
所以应用配置时会额外生成一份目录文件 `~/.codex/llmapi-model-catalog.json`，内容取自网关当前发布的全部别名。

> 目录里**只有对话模型**。供应商记录里的 `imageModels`（生图模型）不发布别名，
> 因此不会出现在目录、也就不会出现在 Codex 的 `/model` 列表里——图像模型在那里被选中
> 只会得到一个"不能聊天"的上游报错。它们由 Codex 内置的 `imagegen` 工具
> 通过 `/v1/images/generations` 使用，详见 `docs/gateway.md` 的「生图直通」。

**`model_catalog_json` 必须是顶层键。** 写进 `[model_providers.llmapi]` 会被 Codex 显式忽略并告警，
表现为 `/model` 里看不到我们的模型。`model_catalog_url` 则是 **provider 级**字段，写在表内指向网关的
`/v1/models`：`model_catalog_json` 生效时 Codex 用本地目录（不再去拉 URL），
`model_catalog_url` 留着是为了让「哪条上游提供模型」这件事对 Codex 也是显式的。

目录结构是 Codex 原生的 `{ models: [{ slug, ... }] }`，不是 `/v1/models` 的 `{ object, data }`。

`display_name` **等于 `slug`**，也就是别名本身（`lam-<providerKey>/<model>`）。原因：Codex 的
`/model` 列表渲染的是 `display_name`，而真正标识模型、发请求用的是 `slug`。两者一致后，
用户在列表里看到的、复制出来的、写进 `config.toml` 的就是同一个字符串，不会出现
"列表里一个名字、配置文件里另一个名字"。

`description` 是另一回事：它仍是给人看的说明 `${providerName} 提供的 ${upstreamModel}`
（例子里是 `Mock Responses 提供的 gpt-resp`），**与 `display_name` 不同**，别把两者当成一回事。

```json
{
  "models": [
    {
      "slug": "lam-mock-responses/gpt-resp",
      "display_name": "lam-mock-responses/gpt-resp",
      "description": "Mock Responses 提供的 gpt-resp",
      "priority": 1,
      "visibility": "list",
      "supported_in_api": true,
      "context_window": 128000,
      "max_context_window": 128000,
      "auto_compact_token_limit": 115200,
      "max_output_tokens": 8192,
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "快速响应，推理较轻" },
        { "effort": "medium", "description": "速度与推理深度均衡" },
        { "effort": "high", "description": "更深的推理，适合复杂问题" },
        { "effort": "xhigh", "description": "很高的推理投入，适合困难任务" },
        { "effort": "max", "description": "最大推理投入，最慢但最深入" }
      ],
      "default_reasoning_summary": "auto",
      "effective_context_window_percent": 95,
      "input_modalities": ["text", "image"],
      "shell_type": "default",
      "truncation_policy": { "mode": "tokens", "limit": 10000 },
      "support_verbosity": false,
      "additional_speed_tiers": [],
      "service_tiers": [],
      "availability_nux": null,
      "upgrade": null,
      "supports_image_detail_original": false,
      "supports_search_tool": false,
      "supports_parallel_tool_calls": false,
      "supports_reasoning_summaries": true,
      "experimental_supported_tools": [],
      "base_instructions": "You are a coding assistant served through LLM API Manager, ..."
    }
  ]
}
```

几个容易踩的点：

- `slug` 必须与网关能解析的模型名完全一致（`lam-<key>/<model>`），否则 Codex 选中后发来的请求会被网关判为未知别名。
- `display_name` 固定写 `slug`（不再拼「供应商 · 模型」），`description` 才是那句人类可读的说明。
  改动这两者时不要互换：`display_name` 是 Codex 列表里直接显示的名字。
- `supported_reasoning_levels` 是**对象数组**（`{ effort, description }`），写字符串数组会被判类型错误。
- 每个模型至少要给 `base_instructions` 或 `model_messages.instructions_template` 之一，否则 Codex 拒绝加载。
  这里写一段简短说明而不是复制官方 21KB 系统提示词 —— 那些提示词描述的是官方模型的行为约定，套到第三方上游并不成立。
- `context_window` **优先用上游声明的真实值**，取不到才回落保守值 128k。
  Codex 的 `ModelInfo` 会读它来算可用上下文与自动压缩阈值（默认在 95% 处压缩），
  写死 128k 会让 1M 上下文的上游只用到约十分之一。
  真实值来源有两条：点「从上游获取模型」时解析 `/models` 响应里的 `metadata`
  （`context_limit` / `context_window` / `context_length`）；上游不返回时由
  `npm run registry:sync -w server` 从 modelinfo.dev / models.dev 补（见下）。
  两种都存进供应商记录的 `modelCapabilities`，生成目录时按模型取用。
  **取不到就不写**，由目录回落默认值 ——
  不能凭空猜一个大数，猜大了 Codex 会把上下文塞爆，上游直接报超长，比用不满更难排查。
  逐字段回落：只声明了上下文、没声明输出上限时，前者用真实值、后者用默认值。
- `max_output_tokens` 目前不在 Codex 的 `ModelInfo` 里（会被忽略），保留它只是让目录文件自解释；
  有上游声明的 `output_budget` 时一并写入，没有就写 8192。
- 其余条目字段分四组，取值都是 **Codex 缺省值 / 第三方上游的保守值**，写出来是为了让目录自解释、
  并兼容旧版解析器（对照 cc-switch 给第三方供应商生成的目录 `ref/cc-switch` 的
  `codex_catalog_from_specs_for_row`）：
  - 窗口派生：`max_context_window` 与 `context_window` 相同（Codex 用它 clamp
    `model_context_window` 覆盖，别让配置把窗口开过上游真实值）；`auto_compact_token_limit`
    写窗口的 90%，与 Codex 不写该字段时的推导完全一致，不改变压缩时机；
    `effective_context_window_percent` 写 Codex 默认的 95。
  - 官方账号权益与服务能力显式清空/关闭：`additional_speed_tiers`、`service_tiers` 为空数组，
    `availability_nux`、`upgrade` 为 `null`，`supports_image_detail_original`、
    `supports_search_tool` 为 `false`。联网搜索仍由设置项控制（`web_search = "disabled"`
    或删除该键），目录不替用户打开。
  - `default_reasoning_summary` 写 `auto`（Codex 缺省）。**不照抄** cc-switch 给纯第三方模板的
    `none`：我们的目录里也可能有官方 GPT 模型，写 `none` 会让它们默认不再返回思考摘要。
  - `supports_parallel_tool_calls` / `supports_reasoning_summaries` 是**旧版 Codex 解析器要求的键**：
    当前版本（已核 `ref/codex` 的 `ModelInfo`）没有这两个字段，会当作未知键忽略；
    保留是为了让旧客户端也能加载这份目录（cc-switch 记录过 0.148 缺键会拒绝整份目录）。
- **刻意不写** `apply_patch_tool_type`、`model_messages`、`tool_mode`、`multi_agent_version` 等字段：
  `apply_patch_tool_type` 非空会让 Codex 启用 freeform apply_patch 工具，而那套补丁格式依赖官方
  提示词一起训练；我们的 `base_instructions` 是一段中立短说明，打开它只会给模型一个不会用的工具。
  cc-switch 对没有官方目录的第三方供应商同样不写 apply_patch。

### 模型元数据的来源与优先级

目录里的上下文窗口、推理档位等字段按**四级**取值，优先级从高到低：

1. **上游 `/models` 的 `metadata`**（点「从上游获取模型」时解析并落盘）—— 最贴近这个中转的
   真实额度，`context_limit` / `output_budget` 都以它为准。
2. **modelinfo.dev** `/v1/models` —— **推理档位优先取它**：`reasoning.efforts` 直接给数组，
   不需要按 provider 投票。实测它与 models.dev 的多数票逐项吻合（claude / gpt 系列完全一致）。
   缺点是覆盖不全（我们 11 个模型里缺 2 个），且有 221 条是 "supported 但 efforts 为空"。
3. **models.dev** `models.json` —— 覆盖更全，用来补 modelinfo 的空缺。
   按模型名匹配前做归一化（抹平 `.` 与 `-`、忽略作者前缀与大小写），
   因为上游叫 `claude-opus-5.5` 而 models.dev 叫 `anthropic/claude-opus-5-5`。
4. **代码默认值**（128k / 8192 / 三档 reasoning / text+image）。

几处刻意的取舍：

- **`context_window` 取上游值**，不取两者较小值：上游的 1048000 与 models.dev 的 1000000
  是实现细节差异，以上游为准更贴近实际。
- **`max_output_tokens` 取两者较小值**：上游 `output_budget`（128k）往往比 models.dev 的模型
  规格（384k）更保守，高估会让上游直接报超长，比"用不满"更难排查。
- **逐字段合并**，不是整条覆盖：上游只给了上下文时，输出上限与 reasoning 仍由公开源补。
- 归一化后**多候选时放弃**，不随便挑一条 —— 挑错等于给别家模型的窗口。
- models.dev **不包含**我们这种聚合上游（它只收录 232 家公开供应商），所以我们只用
  与供应商无关的 `models.json`，不用 `api.json` / `catalog.json`。
- **`reasoningEfforts: []` 与 `undefined` 语义不同**：前者是"查过、没有可用档位"
  （目录写空数组，Codex 隐藏推理菜单），后者是"未知"（目录回落三档默认）。
  因此 modelinfo 返回空数组时**必须继续问 models.dev**，把它当成"无档位"会丢掉
  glm-5.3-flash / kimi-k2.7-code 的真实档位。

**同步是显式动作，不自动跑。** 它会改写用户数据，偷偷改等于"配置自己变了"，出问题无法回溯；
而且让 `apply` 依赖外网可达性也不可接受。所以做成这几条命令：

```bash
npm run registry:sync -w server                          # 演练：只打印会改哪些模型
npm run registry:sync -w server -- --write               # 真正落盘，之后需重新「应用配置」
npm run registry:sync -w server -- --write --verify-efforts
                                                         # 额外实打上游校验每个档位
```

网络不可达时该命令报错退出，**服务本身与已有配置完全不受影响**（目录仍按已有能力生成）。

**为什么需要 `--verify-efforts`：** 数据源声明"支持某档位"不等于我们的上游接受它。
实测 `claude-opus-5.5` 的 `none` 在上游是 **400**，而 `gpt-6-luna` 的 `none` 是 200 ——
档位集合是模型特定的，不能跨模型推断。该开关会为每个模型声明的每个档位发一次极小请求
（16 output tokens），只保留返回 2xx 的。**它默认关闭**，因为会真实消耗额度。

**网页上的「逐档实测」按钮**（在「编辑供应商」表单的「思考档位」一节；
后端是 `POST /api/providers/:id/probe-efforts`）做的是更彻底的一件事：
不依赖数据源声明，直接把 Codex 认识的**全部 9 个候选档位**各打一次上游，把 2xx 的写回
`modelCapabilities`。数据源没有档位（如 `glm-5.3-flash` / `kimi-k2.7-code`）或对聚合上游
不适用时，这是唯一能拿到真实档位的方式。两者共用 `services/effortProbe.ts` 的 `probeEffort()`，
不要各写一份（否则会出现"CLI 说支持、网页说不支持"）。探测只改供应商记录，**目录要重新
apply 才生效**。

探测结果写回 `modelCapabilities`，就展示在同一节里（读落盘值，所以刷新后仍可见）。
它**不放列表行内**：十几个模型各带"接受/被拒"的档位会把整行撑坏。

一个供应商可能是「12 个模型 × 9 档 = 108 次请求」，所以接口回的是 **NDJSON 进度流**而不是
一次性 JSON：先 `start`（带 `total`），每完成一次请求推一条 `progress`（`done` 单调递增），
最后 `result`。**不要把它改回普通 JSON** —— 没有中间进度，用户只会看到界面卡住几十秒，
以为功能挂了（这正是加进度条的原因）。前端进度条只依赖 `done / total`，不假设并发顺序；
`Cache-Control: no-cache` 与 `x-accel-buffering: no` 也不能去掉，否则 nginx 会把整条流
缓冲到结束才发。

### 推理档位（`supported_reasoning_levels`）

档位**按模型实际能力生成**，不是所有模型共用一套。上一版写死 `low/medium/high`，
而实测差异很大（claude 支持 `xhigh`/`max`，`kimi-k3` 只有 `low/high/max`）。

**顺序必须按强度升序**（`none < minimal < low < medium < high < xhigh < max < ultra < persistent`）。
这不是美观问题：Codex 遇到"当前档位不在列表里"时会静默取
`supported_reasoning_levels[len-1/2]`（见 `core/src/session/turn_context.rs` 的 `with_model`），
乱序会让那个"中间档"不再是 medium，用户配的 high 可能被悄悄降成 low。

**`default_reasoning_level` 跟随用户在 `config.toml` 里配的 `model_reasoning_effort`。**
不跟随会出现"配置写 high、`/model` 里显示 medium"的错位。但该值必须先确认在本次声明的
档位列表里 —— 不在的话主动对齐到中间档，而不是写一个必然被 Codex 替换掉的值。

**声明档位 ≠ 上游接受。** 已知陷阱：

| 值 | gpt-6-luna | claude-opus-5.5 |
| --- | --- | --- |
| `none` | 200 ✅ | **400 ❌** |
| `persistent` | — | **400 ❌** |

`persistent` 在 Codex 里是合法档位，但我们的上游直接拒绝。这类值靠 `--verify-efforts`
实测排除（见上）。

另外注意 `xhigh` 的实际效果：实测同一难题下 `xhigh` 的 reasoning_tokens（251）反而低于
`high`（368），说明上游可能把它归并了。这不构成错误（用户仍能选到 high），但**不要指望
声明了它就有更强推理**。

### `input_modalities` 只能写 text / image / audio

这是整个目录里最容易静默失效的一处，务必当**安全边界**对待：

Codex 的 `InputModality` 枚举只有 `text` / `image` / `audio`。而 models.dev 的模态里常有
`pdf`、`video`。一旦把未经白名单过滤的值写进目录，Codex 会报：

```
Error: failed to parse model_catalog_json path ...: unknown variant `pdf`,
expected one of `text`, `image`, `audio`
```

**然后静默回退到内置的官方模型列表** —— `/model` 里冒出 GPT-6.x，且终端里通常看不到任何提示
（已做 A/B 对照实测：只差一个 `pdf`，目录就从"我们的 11 条"变成"官方内置列表"）。

所以代码里 `filterInputModalities` 是唯一入口：只放行三者，`text` 恒定保留，其余丢弃而非透传。
`models.dev` 的值在映射时过滤一次、落盘时再过滤一次、生成目录时第三次过滤。

反过来，**没有模态信息时要写 `["text","image"]` 而不是只写 `["text"]`**：Codex 的
`default_input_modalities()` 就是 `[text, image]`，而 `view_image` 工具靠
`input_modalities.contains(Image)` 开门。未知时只写 `text` 会把所有未收录模型的看图能力静默关掉。

目录文件由我们**整份覆盖生成**（不做按键合并），因此也遵守"写前备份 + 还原"规则：由我们创建的在还原时直接删除；
应用前就已存在的，还原时重置为 `{}` 并作为冲突提示，避免误删用户内容。

顶层是否写 `web_search = "disabled"` 由租户设置 `disableCodexWebSearch` 决定（默认关闭），
原因见下。

### 为什么关闭 web_search

Codex 在配置里没写 `web_search` 时默认为 `cached`（`resolve_web_search_mode(...).unwrap_or(WebSearchMode::Cached)`），
于是把 `web_search` 作为 **Responses 托管工具**放进请求的 `tools[]`。多数聚合上游
把 Responses 请求转成 Chat 线路时不支持这个工具，会直接返回：

```
[code=unsupported_tool] unsupported Responses tool type "web_search" at tools[N]
```

这个报错看起来像"模型不支持"，实际是**工具**不支持——换模型无效，关掉工具才行。

关闭方式（顶层键）：

```toml
web_search = "disabled"
```

源码依据：只有 `WebSearchMode::Disabled`（或 `None`）会让 `create_web_search_tool()` 返回 `None`；
其余取值都会构造出 `ToolSpec::WebSearch` 并进入 `tools[]`。

代价是 Codex 不能联网搜索，所以做成了开关：Agent 配置页 Codex 卡片上的
「关闭联网搜索」复选框，对应设置项 `disableCodexWebSearch`（默认 `true`）。

- **勾选（默认）**：写 `web_search = "disabled"`，Codex 不发该工具，聚合上游可用。
- **取消勾选**：会主动**删除**这一行（不是留着不动），再重新应用配置。
  否则上一版写进去的值会残留，用户会以为开关没生效。删除只在当前值仍是 `"disabled"`
  时执行，被用户手改过的值保留。

切换开关后页面会自动重新应用配置，省掉一次点击。改完后仍需重启 Codex 进程
（见「结束正在运行的进程」）。

`auth.json`：

```json
{ "OPENAI_API_KEY": "lam_<网关令牌>" }
```

> 这里的 Key 是**本服务的网关令牌**，不是上游供应商的 Key。上游 Key 只存在于服务端。

### Claude Code

`settings.json` 只改 `env` 下这 3 个键：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "lam_<网关令牌>",
    "ANTHROPIC_MODEL": "lam-mock-anthropic/claude-x"
  }
}
```

注意 Claude Code 的 Base URL **不带** `/v1`，而 Codex 的 `base_url` **带** `/v1`，两者路径约定不同。

## 三条硬约束

### 只改自己拥有的键

除上表列出的键之外，文件里的任何内容都不动：MCP 配置、钩子、权限、其他 provider、注释、键序。
JSON 用"读 → 定位 → 就地改写"，TOML 用"按段定位 → 只替换目标行"。

**解析失败必须中止**。文件不是合法 JSON/TOML 时报错返回，绝不退回"写一个空文件"。
如果目标 JSON 顶层不是对象，或某个中间节点不是对象（无法继续下钻），同样报错而不是覆盖。

模型目录（`llmapi-model-catalog.json`）是唯一的例外：它整份由我们生成、不做按键合并，
但仍遵守"写前备份 + 只删自己创建的文件"。

### 写入前备份

仅当文件已存在时备份，且备份**放在被改文件的同目录**：

```
~/.codex/config.toml.bak-2026-10-23T09-39-52-003Z
~/.codex/auth.json.bak-2026-10-23T09-39-52-010Z
```

为什么是同目录而不是服务的数据目录：

- 备份的意义是"改坏了立刻找回"。放在 Agent 自己的目录里，用户**不依赖本服务仍在运行**、
  不依赖数据目录是否被清空或迁移，打开文件管理器就能恢复。
- 时间戳精确到毫秒，同一毫秒内重复写入会追加序号（`-1`、`-2`），**任何一次改动都不会覆盖
  前一份备份**，历史可回溯。
- 文件不存在时直接创建（含父目录），此时不产生备份。

清理：备份会累积，需要时自行删除 `*.bak-*` 即可；本服务不自动清理（宁可留多，不可丢失）。

### 还原是保守的

只移除"当前值仍等于我们当初写入的值"的键。被你手改过的键保留，并作为 `conflicts` 返回。
若文件是本次应用时由我们创建、且还原后已无任何有效内容，则直接删除该文件，
避免在家目录留下空壳 `config.toml` 或 `{}`。

模型目录文件没有"我们写入的键"可撤销，按 `created` 标记决定：由我们创建的直接删除；
应用前已存在的重置为 `{}` 并作为冲突返回。

## 快照

每次应用都在 `data/tenants/<id>/agents.json` 记录：

```json
{
  "bindings": {
    "codex": {
      "agentId": "codex",
      "appliedAt": "2026-01-01T00:00:00.000Z",
      "appliedBy": "u_owner",
      "files": [
        {
          "role": "config",
          "path": "/home/user/.codex/config.toml",
          "values": {
            "model_provider": "llmapi",
            "model": "lam-mock-responses/gpt-resp",
            "model_catalog_json": "/home/user/.codex/llmapi-model-catalog.json",
            "web_search": "disabled",
            "[model_providers.llmapi] name": "LLM API Manager",
            "[model_providers.llmapi] base_url": "http://127.0.0.1:8787/v1",
            "[model_providers.llmapi] model_catalog_url": "http://127.0.0.1:8787/v1/models",
            "[model_providers.llmapi] wire_api": "responses",
            "[model_providers.llmapi] requires_openai_auth": "true"  // 写入时是布尔 true
          },
          "created": false
        },
        {
          "role": "catalog",
          "path": "/home/user/.codex/llmapi-model-catalog.json",
          "values": {},
          "created": true
        }
      ]
    }
  }
}
```

`values` 里表内键的写法是 `"[model_providers.llmapi] base_url"`，还原时按此拆出表名与键名。
生成类文件（`role: "catalog"`）的 `values` 恒为空，还原时只依据 `created`。
`requires_openai_auth` 快照里是字符串 `"true"`，但写入文件时是 TOML 布尔 `true`（`raw` 标量）。
`appliedBy` 是为了将来多用户审计留痕。

## 操作流程

1. **预览**（`POST /api/agents/:id/preview`）：只读。返回文件绝对路径、"当前值 vs 将写入值"对照，
   以及文件是否已存在。UI 用 `differs` 标记有变化的键。
   凭据类键（`OPENAI_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 等）只返回掩码，完整令牌不会出现在预览响应里；
   完整值只在 `apply` 时写入目标文件。
   Codex 的预览里有三个文件：`config`（最多 9 个键）、`auth`（1 个键）、`catalog`
   （整份生成，只有一条汇总行「包含 N 个模型别名」，不逐个列出 `slug`）。
2. **应用**（`POST /api/agents/:id/apply`）：备份 → 原子写入 → 记录快照。状态变为"已接管"。
3. **重启 Agent**：配置只在进程启动时读取，应用后需要重启才能生效（UI 会提示）。
   Codex 可以直接用「退出 Codex 进程」按钮（见下节）。
4. **还原**（`POST /api/agents/:id/revert`）：撤销写入的键，删除我们创建的生成类文件，清除快照，
   状态回到"未接管"。

## 新增一个 Agent

1. 在 `server/src/agents/registry.ts` 的 `AGENT_DEFINITIONS` 登记：`homeDirName`、文件列表
   （`role` / `relativePath` / `format`）。
2. 在 `server/src/agents/service.ts` 的 `buildPlan` 里补 `writes`，并按需要扩展
   `buildPlan` 的协议选择（`codex → responses`、`claude-code → anthropic`）。
3. 补测试：`server/test/agents.test.ts` 覆盖"保留无关配置"与"还原冲突"；
   若是新格式，同时扩展 `agents/patch.ts`（而不是在路由里做字符串替换）。
4. 更新本文档与 `docs/api.md` 的 Agent 章节。

## 连接方式：走网关与直连上游

页面上的「连接方式」按 Agent **各自独立**设置（Codex 与 Claude Code 可以一个走网关、一个直连），
存于设置项 `agentTargets[<agentId>] = { mode, directProviderId, directModel }`，默认全为 `gateway`。

**直连必须明确指定供应商。** 多供应商时按优先级自动挑的问题是：用户既看不到选了谁、
也无法干预，而直连会把那家的地址与 Key 直接写进配置。所以未指定时预览/应用会返回 400，
提示去页面上选一家；接口 `PATCH /api/agents/:id/target` 在保存时就会校验（协议匹配、未停用）。

| | `gateway`（走网关） | `direct`（直连上游） |
| --- | --- | --- |
| `base_url` | 本服务网关（`PUBLIC_BASE_URL/v1`） | 供应商自己的 `baseUrl` |
| 凭据 | 网关令牌 `lam_...` | 供应商的真实上游 Key |
| 模型名 | 别名 `lam-<key>/<model>` | 裸模型名 `<model>` |
| 模型目录 | 生成本地 `llmapi-model-catalog.json`，条目是**该 Agent 协议可用的别名** | 同样生成，条目是**上游裸模型名** |
| 服务依赖 | 必须先启动本服务 | **不启动也能用** |

直连模式的用途就是最后一条：把选定供应商的地址与 Key 直接写进 Codex 的配置，
之后即使本服务没在运行，Codex 也能正常使用。代价是没有网关侧的换源、回退与请求日志。

**两种模式都会生成 `model_catalog_json`**，只是条目里的模型标识不同。直连也必须生成：
一旦没有它，Codex 会回退到**内置的官方模型列表**（`models-manager` 的 `fallback_models`
→ `load_remote_models_from_file`），`/model` 里就会出现 `GPT-6.x` 这类与所配供应商
毫无关系的条目——这个坑真实踩过。

切换模式时会自动重新应用配置，并且**主动清理上一模式的产物**：

- 切到直连：删除 `model_catalog_url`（它指向网关，直连时无意义），并用裸模型名**重写**目录文件。
- 切回网关：重新生成别名目录并写回 `model_catalog_url`。

预览面板会显示本次是哪种模式（`connectionMode`）与直连时的实际上游地址（`directBaseUrl`），
避免两种模式写出的文件看起来都一样。

> 直连模式下预览里的 Key 同样只显示前后片段（`sk-super********6789`），完整值只写进
> Agent 的凭据文件，不经任何接口返回。

## 结束正在运行的进程

Codex 只在**启动时**读一次配置与模型目录。改完配置（或换了模型目录）后如果不重启，
`/model` 里仍是旧列表 —— 看起来像配置没生效。

页面上「**退出 Codex 进程**」按钮调 `POST /api/agents/:id/stop-processes`，服务端做三步：

1. `codex app-server daemon stop` —— 官方入口，让 TUI 连的托管守护进程优雅退出
   （先停 daemon 再停 TUI，否则 TUI 可能在 daemon 退出过程中自动重连）；
2. **按 pid 文件兜底结束 daemon 与 updater** —— 官方命令失败时的保险，见下；
3. 按进程表精确匹配后 `SIGTERM` 掉 `codex`（TUI）与 `codex exec` 进程，按
   800ms/1200ms/1600ms 三轮检查存活，仍活着的补 `SIGKILL`。

这三步都成功也只代表「能探测到的进程都停了」。提示里因此固定附一句
**「也可手动执行 `pkill -9 -f codex` 来清理相关进程」**：从非标准位置启动、
或进程表读不到的 Codex 不会出现在匹配结果里，按钮返回成功而 Codex 仍能用时，
用户至少知道下一步做什么，不必去翻日志或猜。

**目录只列该 Agent 能用的协议。** Codex 的 `wire_api` 固定是 `responses`，所以目录里
默认不能出现 `openai` 供应商的别名——用户选中后 `/v1/responses` 打到 `openai` 上游必然
501。让他在列表里看到一个选了就报错的模型，等于把错误推给他。
同理 Claude Code 只用 `anthropic`。

**开启跨协议转发后例外**：此时网关会把 Responses 请求转成 Chat，`openai` 供应商
就真的能用了，目录必须把它们列出来。只改转发逻辑不改目录的话，用户开了开关却看不到
对应模型，会以为功能没生效——这两处是一对，改一个必须改另一个。

### 为什么需要第 2 步（按 pid 文件兜底）

`codex app-server daemon stop` 要写 `~/.codex`（操作锁 `daemon.lock`、pid 文件）。
目录只读时它会**立刻失败**，而 daemon 进程仍在跑 —— 表现为"点了退出进程，Codex 却还能用"，
用户只能手动 `pkill -9 -f codex`。

所以读 `app-server-daemon/daemon.pid` 与 `daemon-updater.pid` 里记录的 pid 直接发信号。
这两个文件由 daemon 自己写，比按命令行匹配可靠：daemon 的参数形态是
`app-server --listen ... --managed-daemon`，按命令行猜容易漏，且不同版本还不一样。

第 3 步也不是发一次 `SIGTERM` 就算完：Codex 关闭时要收尾（写 rollout、断连接），
一轮检查常常来不及，用户会看到"点了退出但进程还在"。

匹配规则刻意保守：只认可执行文件名为 `codex`（前面是行首或 `/`，后面是空格或结束）的进程，
且子命令不在 `app-server` / `login` / `logout` / `update` / `mcp` / `debug` / `completion` /
`help` / `version` / `apply` / `resume` 之列；`codex --version`、`codex --help` 这类一次性命令也不会被当成 TUI。
这样避免误杀编辑器插件、`mycodex` 或本服务自己的子进程。

定位配置目录时优先用环境变量 `CODEX_HOME`，否则用 `AGENT_HOME_DIR`（再否则 OS 家目录）下的 `.codex`；
该目录不存在时不会强行设 `CODEX_HOME`（codex 会对不存在的路径报错，但那只是"本机还没配过"）。

响应：

```json
{
  "actions": ["已停止 Codex 守护进程（codex app-server daemon stop）", "已结束 1 个 Codex 客户端进程"],
  "killed": 1,
  "warnings": [],
  "supported": true
}
```

`actions` 是成功做到的事，`warnings` 是没做到的原因（例如 `codex` 不在 PATH、守护进程停不掉），
二者都可能为空。`killed` 是实际发出信号的进程数。

Claude Code 没有常驻进程，该按钮只对 Codex 显示；直接调接口会返回 `supported: false`
与 `warnings: ["Claude Code 没有需要结束的常驻进程"]`，而不是报错。

> 这需要 `codex` 在服务进程的 PATH 上。缺 `codex` 时只结束本机进程并在 `warnings` 里说明。
> `~/.codex` 只读时官方 `daemon stop` 会失败，但第 2 步的 pid 兜底通常仍能结束进程；
> 两步的结果都会在 `actions` / `warnings` 里如实返回，不会静默当成成功。

## 排错

| 现象 | 原因 |
| --- | --- |
| 预览返回 400「尚未生成网关令牌」 | 先去"模型聚合"页生成令牌 |
| 预览返回 400「没有可用的 OpenAI 兼容（Responses） 供应商，请先添加并启用」 | 没有启用的 `responses` 供应商。Codex 只能绑 `responses`，把某家供应商的协议改为「OpenAI 兼容（Responses）」即可 |
| 预览返回 400「没有可用的 Anthropic 兼容（Messages） 供应商」 | 没有启用的 `anthropic` 供应商（Claude Code 用） |
| 预览返回 400「未声明任何模型」 | 供应商的 `models`（**对话**模型）为空。只配了生图模型是不够的：Agent 下发需要一个对话模型 |
| Codex 里看不到生图模型 | 预期行为。生图模型填在「生图模型」框里，不进目录；`/model` 里出现它反而说明填错框了 |
| 生图返回 400 `modelIsNotImageModel` | 该模型在「模型列表」里，把它挪到「生图模型」框 |
| Codex 启动报 `` `wire_api = "chat"` is no longer supported `` | 旧版本写出的配置已过时：Codex 只接受 `responses`。把供应商协议改为「OpenAI 兼容（Responses）」后重新应用配置 |
| Codex 请求网关返回 501 | 供应商协议不是 `responses`：Codex 走 `/v1/responses`，需要 `responses` 类型的供应商 |
| `/model` 里没有我们的模型 | 检查 `model_catalog_json` 是否被写进了 `[model_providers.llmapi]`（必须是顶层键），以及改完配置后是否重启了 Codex |
| 上游报 `unsupported Responses tool type "web_search"` | 该上游不支持 Responses 托管工具，勾选「关闭联网搜索」后重新应用 |
| 结束进程后仍走旧配置 | Codex 进程可能不在服务进程的 PATH 上，看响应里的 `warnings`；也可手动重启 Codex |
| 应用后 Agent 仍走旧配置 | Agent 进程需要重启 |
| 还原时出现 conflicts | 被写入的键后来被手动改过，按提示自行处理 |
| 预览报「字段 xxx 不是对象」 | 目标 JSON 里该路径是标量，无法下钻；需手动整理 |
