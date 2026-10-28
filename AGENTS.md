# AGENTS.md

给在本仓库工作的 AI 编码代理（以及新加入的人类开发者）的作业指南。
目标不是重复产品说明，而是把「改了会不会踩坑」的约束写清楚。

## 项目一句话

自托管的 LLM API 控制台：管理多家 OpenAI / Anthropic 兼容供应商，聚合成统一模型别名，
通过本服务自己的网关转发，并把网关地址与令牌写进本机 Agent（Codex CLI、Claude Code）的配置文件。

参考实现是同级目录的 `../cc-switch`（桌面端，Tauri）与 `../new-api`（Go 网关），
**本仓库是独立实现，不复制它们的源码**，也不要为了"对齐"而把它们的架构搬进来。

## 仓库结构

```
package.json          npm workspaces 根（server + web）
server/               Fastify + TypeScript
  src/app.ts          Fastify 装配：cookie、JSON 解析、错误处理、404/SPA、路由注册
  src/index.ts        启动入口：loadConfig → bootstrapIdentity → buildApp → listen
  src/context.ts      AppContext：config / logger / paths / identity / store / secrets
  src/domain/         纯领域类型与纯函数（无 IO）
  src/store/          JSON 文件存储、路径、租户作用域仓储
  src/auth/           口令哈希、会话签名、Principal 解析（会话/API 令牌）、权限裁决、路由守卫
  src/crypto/         凭据编解码（AES-256-GCM）
  src/gateway/        网关令牌、令牌鉴权、上游转发
    selection.ts      选路：候选、转换判定、审批占位名改写（网关与诊断共用）
    convert/          跨协议转换：responses→chat 的请求/响应/流式三向映射
  src/services/       业务编排（供应商、连通性测试、请求日志、首次初始化）
  src/agents/         Agent 注册表、路径解析、JSON/TOML 保值补丁、预览/应用/还原
  src/routes/         路由薄壳，只做参数校验与调用服务
  test/               单元测试 + 端到端冒烟（含假上游）
log/                  运行日志（app.log + 滚动文件），已 gitignore
web/                  React 18 + Vite + Tailwind
  src/lib/            api 封装、鉴权上下文、useAsync、类型、labels（枚举文案键）
  src/i18n/           i18next 初始化、语言探测、日期本地化、locales/{zh,en}/ 按区域字典
  src/pages/          Login / Setup / Layout / Overview / Providers / Models / Agents / Settings
  src/components/     ui 基础件、ProviderForm、CopyButton、LanguageSelect
  test/               页面装配测试 + 字典契约 + 硬编码扫描（jsdom + testing-library）
```

## 常用命令

```bash
npm install                 # 安装两个 workspace 的依赖
npm run dev                 # server:8787 + web:5173（Vite 代理 /api、/v1）
npm run build               # 先 web（tsc --noEmit + vite build）再 server（tsc）
npm start                   # 单进程提供服务端 API、网关与前端静态资源
npm run typecheck           # 两个 workspace 都跑 tsc --noEmit
npm test                    # server（vitest + 假上游）→ web（jsdom）
```

单侧调试：`npm run dev -w server`、`npm test -w server`、`npm run test -w web`。

## 用规划与子 Agent 提高效率

本仓库的改动常常横跨多层（`domain/` 纯函数 → `services/` 编排 → `routes/` 薄壳 → `web/` → 测试 → 文档）。
一个 Agent 顺序做完容易在上下文里丢掉细节，也容易漏掉某一层的同步。**动手前先规划，能并行的部分拆给子 Agent。**

### 先规划再动手

- 多步任务先用待办清单固定顺序与验收条件（"哪几个文件要改、改完怎么验"）。
- 把"探索"和"改"分开：先并行查清事实（现有实现、字段类型、测试基线、上游真实行为），
  再集中动手改。**不要一边猜一边改**——本仓库的坑大多来自"字段存在 ≠ 生效"这类假设。
- 结论要能落到具体证据上（源码行号、实测响应、测试断言）。写进注释/文档的判断，
  必须是自己验证过的，不要复述猜测。

### 什么时候拆子 Agent

适合拆的（互相独立、只读或写不同文件）：

| 场景 | 拆法 |
| --- | --- |
| 同时改 server 与 web | 一侧改完再给另一侧对齐接口；或两人分别改、由 Lead 统一对齐契约 |
| 一次要读很多文件才敢下结论 | 每个候选方向一个子 Agent 并行调研，只回结论与证据 |
| 多套测试要补（unit / smoke / web） | 按文件拆，互不重叠 |
| 大范围排查（某字段在哪些地方被读/写） | 分片检索后汇总 |

**必须串行的**：

- 同一文件的修改（写冲突）；跨层改动的**契约**（先定字段与语义，再各自实现）。
- 需要看到彼此结果的判断（"这个改法是否可行"要先有结论才能开始写）。
- 最终验收：`npm run typecheck` 与 `npm test` 必须由**一个**执行者跑完整套，
  不要各处分别跑一部分就认为全绿。

### 拆分时必须守的纪律

- **写作用域不重叠**：给每个子 Agent 明确的文件清单，不允许顺手改别人的文件。
- **共享状态是真实风险**：`server/test/smoke.test.ts` 里所有用例共享同一个服务实例，
  新增的供应商/别名/令牌不清理会级联污染后面用例（本文件里已有踩坑注释）。
  让多个 Agent 同时写同一测试文件，几乎必然出这种问题。
- **接口契约单点定义**：字段名、取值范围、默认值只在 `domain/` 定义一次
  （如 `CODEX_STREAM_MAX_RETRIES_RANGE`），前后端都引用它，别各写一份。
- **Lead 负责合并与终检**：子 Agent 报"通过"不等于整体通过，
  必须看最终 diff、跑完整测试，并确认没有把临时脚本/调试文件留在仓库里。

## 必须遵守的约束

改代码前先读这节，这几条是设计上的硬约束，不是风格偏好。

### 1. 租户是数据隔离边界

- 租户数据只能通过 `ctx.store.forTenant(tenantId)` 拿到仓储；**路由层不允许拼 `data/` 路径**。
- 新增任何租户级数据，都要放进 `data/tenants/<tenantId>/`，并挂在 `TenantRepos` 上。
- 会话与网关令牌都必须解析成 `Principal`（`userId` / `tenantId` / `role` / `via`）。
  不存在"取不到身份就用默认租户"的兜底 —— 取不到就 401。
- 当前 `app.ts` 里用的是写死的 `DEFAULT_TENANT_ID`；做多租户时改成从 `Principal` 取，
  **领域模型与接口契约不应因此改动**。

### 2. 每条 `/api` 路由必须声明权限

- 一律用 `defineRoute(app, registry, { method, url, access }, handler)` 注册。
  `defineRoute` 同时完成"注册路由"和"登记访问声明"，两者不允许分家。
- `access` 取值：`'public'`（免鉴权）、`'authenticated'`（登录即可）、或具体 `Permission`。
- 权限枚举与角色映射只在 `server/src/domain/permissions.ts` 定义，不要在路由里硬编码角色判断。
- 裁决只走 `server/src/auth/policy.ts` 的 `can` / `assertCan`。
- `registry.assertAllDeclared()` 会在启动时自检；新增路由忘了声明会直接启动失败。
  不要为了让启动通过而放宽这个检查。
- `/v1/*` 是网关面，不进这个登记簿，由 `gateway/auth.ts` 用网关令牌单独鉴权。

### 3. 别名解析失败必须报错，绝不回落

`lam-<providerKey>/<model>` 是"明确指向某一家"。若供应商被禁用/删除、模型未声明，
`resolveModel` 返回 `invalid`，网关回 400。**不要加"解析失败就用默认供应商"的兜底** ——
那会用错额度、答错模型，而调用方完全看不出来。

只有不带 `lam-` 前缀的请求才走"默认供应商 + 默认模型"。

### 4. Agent 文件只改自己拥有的键

- `agent` 下发的三条铁律：只改自己拥有的字段、保留文件其余内容、写前备份（仅当文件已存在）。
- JSON 用 `applyJsonWrites` / `removeJsonPathIfValue`，TOML 用 `applyTomlEdits` / `removeTomlKeyIfValue`。
  两者都是"读 → 定位 → 就地改写"，**解析失败必须抛错中止，绝不能退回写空文件**。
- 还原只移除"当前值仍等于我们写入值"的键；被用户改过的键保留并作为 `conflicts` 返回。
- 由我们创建、且还原后没有任何有效内容的文件要删除（`created` 标记 + `isEmptyDocument`），
  避免在用户家目录留空壳 `config.toml` / `{}`。
- **写前备份放在被改文件的同目录**（`~/.codex/config.toml.bak-<时间戳>`），不是服务数据目录。
  备份的意义是"改坏了立刻找回"，必须不依赖本服务是否在跑、数据目录是否还在。
  时间戳精确到毫秒并在冲突时追加序号，**任何一次改动都不覆盖前一份备份**。
- 新增 Agent：在 `agents/registry.ts` 登记定义（文件角色、相对路径、格式），
  在 `agents/service.ts` 的 `buildPlan` 里补 `writes`，并明确它需要哪种 `apiType` 的供应商。

### 5. 凭据不许明文出接口

- 上游 API Key 落盘一律走 `ctx.secrets.encode()`；读明文只在真正发请求时（`ProviderService.plainApiKey`）。
- 供应商列表接口只返回 `apiKeyMasked`（首 3 位 + 8 个星 + 尾 4 位）与 `apiKeyTail`，**不得返回 `apiKey`**。
  返回对象用 `toProviderView`，注意它同时剔除了 `tenantId`。
- 网关令牌只存 `tokenHash`（sha256）。`tokenCipher` 是给 Agent 下发用的密文副本，**任何接口都不得返回**。
  完整令牌只在"生成/重置"那一次响应里出现。
- 口令只存 scrypt 哈希。日志器会按 key 名与正则打码，但不要依赖它 —— 不要主动把密钥放进日志。
- **`POST /api/agents/:id/apply` 的响应必须脱敏**：直连模式下写进配置的是上游**真实 Key**，
  而 `binding.files[].values` 里存的就是那份原值，原样返回等于把凭据经接口发出去。
  预览路径一直脱敏（`maskPreviewSecret`），apply 曾漏掉——两处必须用同一条敏感键规则
  （`isSensitiveValueKey`）。注意**只脱敏响应、不脱敏存储**：`revert` 依赖
  "当前值是否仍等于我们写入的值"做比对，存了打码值会让还原全部变成冲突。

### 6. 网关转发的三个已知坑

这三处都已被真实 bug 踩过，改动 `gateway/forward.ts` 时特别注意：

- **不要用 `request.raw` 的 `'close'` 事件去 abort 上游。** Node 在请求体读完后就会触发它，
  会把刚发出的上游请求立刻中止（表现为全部 502「请求被中止」）。现在监听的是响应流的
  `'close'`，且只在 `!reply.writableFinished` 时 abort。
- **无 body 的 POST 不能带 `Content-Type: application/json`。** Fastify 会抛
  `FST_ERR_CTP_EMPTY_JSON_BODY`。服务端已注册自定义 JSON 解析器把空 body 当 `{}`，
  前端 `web/src/lib/api.ts` 也只在确有 `body` 时才加 JSON 头。两侧都要保持。
- **延迟写错误后必须补写。** `deferErrorWrite` 让 `forwardOnce` 失败时不碰 response，
  好在回退前不把错误发给客户端。但一旦判定"不回退"（非 5xx / 无备选），
  必须调用 `writeDeferredError` 补写 —— 漏掉这一步会表现为上游 4xx、客户端收到
  `200` + 空 body。4xx 不换供应商，但状态码与错误体要原样透传。

### 7. 存储写入必须原子

- 只用 `jsonFile.ts` 提供的 `createJsonFile` / `appendJsonLine` / `writeFileAtomic`。
- 写入是"临时文件 + rename"，文件权限 0600。
- 每个数据文件带 `schemaVersion`。**读到比自己新的版本要隔离（改名 `.corrupt-<时间戳>`）并告警**，
  不能当成空数据静默覆盖。新增字段时保持向后兼容（缺字段走默认值）。

### 8. 前端不要绕开 api 层

- 所有请求走 `web/src/lib/api.ts`：它统一处理凭据携带、错误体解析、401 回登录页。
- 判断权限用 `useAuth().can(permission)`，不要在前端复刻一套角色规则。
- 界面上除"编辑态输入框"外不得出现明文 API Key 或完整网关令牌。

### 9. 首次初始化的判据与令牌

- **"是否已初始化"只看默认租户里有没有账号**，不要用"用户名是否等于 `ADMIN_USERNAME`"来判断。
  首次初始化时用户名由用户自填，可能不等于默认值；按用户名判断会导致重启后误判为未初始化、
  重新发放令牌（等于开后门）。这一点被测试 `server/test/setup.test.ts` 固定住。
- 初始化令牌只打印到控制台，**不要写进日志文件**；落盘只存 `sha256(token)`。
- 完成后令牌必须作废，`POST /api/setup` 对已初始化的实例一律 409，绝不覆盖已有管理员。
- `POST /api/setup` 与 `GET /api/setup/status` 是 `public` 路由（此时还没有账号可用），
  门禁是令牌本身；新增此类接口要同样想清楚"凭什么只有部署者能调用"。

### 10. 三种上游协议默认严格匹配，跨协议转发按需自动开启

- `ApiType` 有三值：`openai`（Chat Completions）、`anthropic`（Messages）、`responses`（Responses API）。
- 路径与协议一一对应：`/v1/chat/completions → openai`、`/v1/messages → anthropic`、
  `/v1/responses → responses`。**默认不匹配一律 501**，不要为了"能跑通"而放宽成直通。
  `/v1/responses` 早期是"不限协议"的直通，会把 Responses 请求发给只支持 Chat 的上游，
  症状是上游报参数错误——这条已被真实问题踩过。
- **跨协议转发由设置项 `protocolConversion` 控制**（默认 `false`）。
  打开后 `/v1/responses → openai` 由 `gateway/convert/` 双向转换（含工具调用与流式）；
  其余组合一律仍然 501——只有 Responses→Chat 有转换器，别顺手把它做成"任意协议互转"。
- **协议不匹配时自动开启**：当路径要求 `responses`、实例里**没有**启用的 `responses`
  供应商、但有启用的 `openai` 供应商时，网关自动打开 `protocolConversion` 并持久化。
  触发条件必须这么窄——如果已经能用 responses，或转换解决不了（如 `/v1/messages`
  命中 openai），自动打开只会误导用户。
  自动改动会写响应头 `x-llmapi-auto-conversion: 1`，用户得能发现行为被改了。
  这个头必须用 `reply.raw.setHeader`，转发是直接写 `reply.raw` 的。
- 路径清单与协议要求只在 `gateway/forward.ts` 定义一次（`GATEWAY_PATHS` / `requiredApiType`），
  `routes/gateway.ts` 必须 import 复用，不要复制一份。
- `openai` 与 `responses` 共用 Bearer 鉴权，只有 `anthropic` 用 `x-api-key` +
  `anthropic-version`。鉴权分支按这个分组写，不要逐个协议罗列。
- **Codex CLI 只支持 `wire_api = "responses"`**：`chat` 已被其上游移除
  （openai/codex discussion #7782），写 `chat` 会让 Codex 拒绝启动。
  因此 Codex 只能绑定 `responses` 供应商，**不要**再加"回落到 openai 写 chat"的分支。
- `requires_openai_auth` 必须是 **TOML 布尔 `true`**（`DesiredWrites.raw = true` 原样写入），
  写成字符串 `"true"` 是类型错误。

### 11. 连接方式：走网关 vs 直连上游

`agentTargets[<agentId>]`（默认全部 `gateway`）决定写进该 Agent 配置文件的是哪一套东西。
**按 Agent 分开存**：Codex 与 Claude Code 协议不同、用途也可能不同，一个全局开关会强迫
两者同步切换。

| | `gateway` | `direct` |
| --- | --- | --- |
| `base_url` | `PUBLIC_BASE_URL/v1` | 供应商自己的 `baseUrl` |
| 凭据 | 网关令牌 `lam_...` | 供应商的真实上游 Key |
| 模型名 | 别名 `lam-<key>/<model>` | 裸模型名 |
| 模型目录 | 生成本地 catalog，条目是**该 Agent 协议可用的别名** | 同样生成，条目是**上游裸模型名** |

- **直连必须明确指定供应商**（`directProviderId`）。多供应商时按 priority 自动挑是错的：
  用户既看不到选了谁也无法干预，而这会把那家的地址和 Key 直接写进配置。
  未指定时返回 400 让用户去选；保存接口要在写入前就校验协议匹配与是否停用。
- **目录只列该 Agent 能用的协议**（Codex→`responses`，Claude Code→`anthropic`）。
  列出 openai 供应商的别名会让用户选中后必然 501——把错误推给用户，而不是在列表里就排除。
  **例外**：开启 `protocolConversion` 后，Codex 的目录也要包含 `openai` 供应商的别名，
  否则用户开了开关却看不到对应模型，会以为功能没生效。两处必须一起改。
- **两种模式都要生成 `model_catalog_json`**，只是条目不同。直连不生成是错的：
  Codex 拿不到本地目录会回退到**内置官方模型列表**，`/model` 里出现 GPT-6.x，
  与用户配的供应商无关（真实踩过）。
- 直连的配置里不能残留任何指向网关的字段：要删除 `model_catalog_url`（它指向网关）。
  只"不写"不够，上一模式的值会残留。
- 反向同理：切回网关要重新生成别名目录并写回 `model_catalog_url`。
- `generatedFiles` 里 `content` 缺省表示**删除该文件**，这是清理上一模式产物的机制。
- 直连会把上游真实 Key 写进 Agent 的凭据文件。预览必须脱敏（已有 `maskPreviewSecret`），
  **不要让明文 Key 经任何接口返回**。
- 这是租户级全局设置，改动要重新 apply 才生效。**前端切换模式时不自动 apply**
  （刚切到直连还没选供应商时 apply 会 400，等于拿报错当交互反馈）；
  只有「选定直连供应商」与「web_search 开关」这两处会自动补一次 apply。

### 12. 「Approve for me」的模型只能在网关侧改写

Codex 在 API Key 认证下把审批模型**硬编码**成 `gpt-5.6-luna`，没有任何配置项能改：

- 目录条目 `auto_review_model_override` → **无效**：该字段在 `ModelInfo` 上有，
  但 `select_review_model` 收的是 `&[ModelPreset]`，而 `impl From<ModelInfo> for ModelPreset`
  没搬这个字段。字段存在 ≠ 生效。
- `review_model`（config.toml）→ 只给 `/review` 用，guardian 路径不读它。
- `model_providers.*` → 没有相关字段。

- **目录里没有这个占位名 → 静默回退到父模型**（最容易漏的一环）：
  `select_review_model` 拿 `available_models: &[ModelPreset]` 做 `find`，
  找不到 `gpt-5.6-luna` 时不报错，而是取 `parent_model.slug`——审批请求于是带着
  **用户当前的对话模型**发出去，网关那套"识别占位名"的判定一次都不命中。
  症状：配了审批模型毫无效果，且**请求日志里看不到任何审批请求**。
  所以生成 Codex 目录时必须把占位名注进去（`BuildCatalogOptions.approvalPlaceholder`），
  Codex 才找得到它、才会真的发这个名字。

可行做法是**在网关侧改写**：走网关时 `model` 会原样出现在请求体里，把它当占位名换掉。
判定必须两个条件同时满足——请求头 `x-codex-turn-metadata` 的
`turn_trigger === "guardian_review"`，且 `model === APPROVAL_REVIEW_MODEL_NAME`。
只看模型名会误伤"用户真拿这个模型聊天"，只看 turn_trigger 会在占位名随版本变化时改错。
改写后不做故障转移（换家供应商多半没同名模型）。
- 目标模型必须真实存在于某家**已启用**供应商的 `models` 里，否则 400 并说清原因：
  放过去只会让上游报一个含糊的"模型不存在"。
- **同一模型名可能被多家声明**（用户的 `gpt-6-luna` 就同时属于 openai 与 responses 两家）。
  选供应商时优先协议匹配的那家——能直通就别转换；随便 `find` 一个可能挑到需要转换的，
  甚至在明明有直通供应商时误报"未开启转换"。自动开启转换的判定同理：
  只有当**没有 responses 供应商也声明该模型**时才开。
- 后端接口的候选列表要列**所有已启用供应商**的模型，不能只列 responses：
  Codex 只能绑 responses，而用户常常只有 openai 供应商，只列 responses 会让列表空着、
  功能等于不可用。能不能承接由选路判断并报错，不该在列表阶段就把选项藏起来。

### 13. 向上游查模型列表

- 拉取模型列表（`fetchProviderModels`）接受的是**表单临时值**，不是 `ProviderRecord`：
  新增供应商时还没有 id、也还没落盘，而"先试连再保存"正是该功能的用途。
- `POST /api/providers/models` 的 `apiKey` 留空且带 `providerId` 时沿用已保存的 Key。
  前端不回显明文，编辑态不该为了拉列表强迫用户重填。
- 连上了但响应里没有 `data[]` / `models[]` 时返回 `ok: false` 并说明原因，
  **不要返回空数组** —— 界面会看起来像"上游真的没有模型"。
- 任何失败都不抛异常、不回 500（与连通性测试一致）。
- 上游 `/models` 的 URL 与转发路径同一套规则：`baseUrl` 已以 `/v1` 结尾时不重复拼接。
- 前端模型编辑器是**标签片段**式（参考 new-api 渠道模型框）：已选模型在框中以片段排列、
  点 × 移除，末尾留可输入的空片段（回车/逗号添加、支持粘贴多选、空输入退格删最后一个）。
  改这块时注意 `ProviderForm` 用 `useId()` 生成输入框 id —— 同一页面可能同时存在多个
  实例，写死 id 会让 label 关联到别的表单。

### 13.1 推理档位只能靠实测，不能靠声明

Codex 目录里的 `supported_reasoning_levels` **只来自** `modelCapabilities[model].reasoningEfforts`，
没有数据就回落三档 `low/medium/high`。而档位恰恰是最容易"看着有、其实不对"的字段：

- 上游 `/models` 基本不给档位（实测聚合上游只给 context/output）；
- modelinfo.dev / models.dev 经常 `supported=true, efforts=[]`（glm-5.3-flash、kimi-k2.7-code 都是）；
- 数据源说支持 ≠ 上游接受（`claude-opus-5.5` 的 `none` 在上游是 400）。
  默认三档里的 `medium` 对只接受 `low/high/max` 的模型同样会 400。

所以有两个入口，**都走 `services/effortProbe.ts` 的 `probeEffort()`**：

- CLI：`npm run registry:sync -w server -- --write --verify-efforts`，只校验数据源**已声明**的档位。
- 网页「逐档实测」：`POST /api/providers/:id/probe-efforts`，把 9 个候选档位全打一遍。

两条硬规则：

- **响应必须是 NDJSON 进度流，不能改回一次性 JSON。** 108 次请求要几十秒，没有中间进度
  用户会以为卡死。`Cache-Control: no-cache` 与 `x-accel-buffering: no` 也不能去掉——
  nginx 默认会缓冲整条流，进度会攒到最后一起到。
- **全档位被拒时不要写能力表。** 那可能是网络抖动、Key 错或协议错，固化成"不支持推理"
  会让用户更难排查；把上游第一条原因带进 `error` 让用户自己判断。

### 14. API 令牌只能收窄权限

`/api/*` 除会话 cookie 外还接受 `Authorization: Bearer api_…`。三条硬规则：

- **两套令牌不混用**：`api_` 只进 `/api/*` 管理面，`lam_` 只进 `/v1/*` 转发。
  前缀分开是为了日志与处置能区分，别为了"统一"合并它们。
- **只收窄、不提权**：`scopes` 必须是创建者权限的子集；判定时**只看 scopes、忽略角色**
  （`policy.ts` 的 `can`）。若叠加角色，创建只读令牌反而会拿到创建者全部权限。
- **令牌不能碰账号与会话**：`authenticated` 级接口（改口令）拒绝令牌——否则凭据泄露
  后可永久接管账号，吊销令牌也救不回来。令牌也不能创建/吊销令牌（防自我续命）。

存储只存 `sha256`、比对用 `timingSafeEqual`、明文只在创建响应里出现一次。
`lastUsedAt` 按 60 秒节流更新：每次请求都写盘会让高频脚本把磁盘打得很差。

### 15. 诊断接口必须复用真实逻辑

`/api/diagnostics/*` 用来回答"某个功能到底有没有生效"（`ENABLE_DIAGNOSTICS=1` 才开）。

**核心约束：诊断不许自己重算一遍。** 选路用 `gateway/selection.ts`、转换用
`gateway/convert/`、上游 URL 用 `forward.ts` 的 `upstreamPathFor`。
若诊断自己拼一份逻辑，就会出现"诊断说会转换、实际没转换"——比没有诊断更糟。
这几个函数当初被抽成共享模块，正是为了这个。

- 默认关闭、未开启时返回 **404**。注意 404 的**实际隐蔽效果有限**，别当成安全边界：
  `guard.ts` 的鉴权钩子在 handler 之前跑，未登录者拿到的是 **401**；看到 404 的是
  已登录的 `settings:write` 用户。用 404 的理由是语义（"功能没启用"不是权限问题），
  不是隐藏。文案里也不写开关名——对方本来就有足够权限。
- 它会回显 prompt 片段并真实打上游，所以定位是"排查工具"而非常开项。
- 排查这类问题必须靠它，因为症状是**两端都不报错、只是结果不对**
  （工具调不动、思考区转圈、列表少一家），读日志定位不了。
- 改这些接口时，确认四条都在：路由预演、全链路、自检清单、转换器纯函数自检。


### 16. 界面与服务端文案都必须走 i18n

控制台是双语的（`zh` / `en`），实现是 `i18next` + `react-i18next`。界面文案的
**唯一来源**是 `web/src/i18n/locales/{zh,en}/` 下的字典；组件里硬编码中文会被
`web/test/i18n-guard.test.tsx` 扫出来并判失败。

- **键集必须成对**：英文对象声明成 `typeof zhXxx`，漏译/多键直接编译失败。
  改中文时必须在同一提交里改英文，别留 TODO。
- **计数文案写三份**：`key_one` / `key_other`（中文两份相同），调用 `t(key, { count })`。
  只写基名时英文 `count=1` 会说 `1 items`。
- **组件里用 `useTranslation()`，不要 import 全局 i18n 实例**：前者订阅语言变化，
  后者要等下一次渲染才更新（症状是"点了切换、页面不刷新"）。
- **时间用 `web/src/i18n/format.ts`**，不要用 `toLocaleString()`：后者跟随浏览器语言，
  会出现"界面英文、时间中文格式"。
- **服务端有独立的同构字典**（`server/src/i18n/locales/{zh,en}/`，区域为
  `errors` / `gateway` / `diagnostics` / `providers` / `agents` / `auth` / `tokens` / `settings`）。
  **不要复用前端字典**：两边受众不同（前端是"看界面的人"，服务端是"调 API 的脚本
  + 看报错的人"），合并会让前端改界面文案时顺带改掉 API 报错文本。
- **语言只在边界解析**：`domain/` 与 `services/` 只产出"键 + 参数"（`LocalizedText`），
  由错误处理器或路由响应调 `resolveRequestLanguage()` 后 `translate()`。
  需要语言时用 `language: UiLanguage = 'zh'` 的末位可选参数，**不要在服务层读 Request**。
  优先级：租户设置 > `Accept-Language` > 中文（`server/src/i18n/language.ts`）。
- **错误响应同时带 `messageKey`**：调用方与测试都用键做判断，不要匹配会随语言变化的
  译文。给 `badRequest(key, params)` 时**第二参是插值参数、第三参才是 details**。
- **日志与 CLI 跟随 `LOG_LANGUAGE`（默认 `zh`），不跟随请求语言**：日志的读者是
  部署者，同一故障在不同客户端下长得不一样会让 grep 失效。`ctx.logger.info('logs.xxx', {…})`
  直接传**键**，logger 按 `logLanguage` 渲染、并把 meta 当插值参数；传成品文案也支持
  （含变量拼接时），此时不翻译。启动横幅与 `scripts/` 的 CLI 输出用 `translate(config.logLanguage, …)`。
- **启动告警存"键 + 参数"**（`addWarning(code, messageKey, params)`）：告警在启动期产生、
  拿不到 Request，由 `/api/health` 用 `getWarningsFor(language)` 在响应阶段渲染。
  `warning.message` 仍是中文渲染结果（日志与既有测试在读）。
- 新增语义时同步两边字典：界面文案进 `web/src/i18n/locales/`，接口文案进
  `server/src/i18n/locales/`。`server/test/i18n.test.ts` 会校验键集一致、插值一致、无空文案。
- **语言偏好存服务端**（`TenantSettings.language`，`null` = 跟随浏览器），
  接口 `PATCH /api/settings/language`，随 `GET /api/auth/me` 下发。
  **不要改用 localStorage**：换设备会丢设置，也可能与另一台机器打架。
- **不翻译**：品牌名、模型名、`lam-` 别名、`/v1/...`、`Codex`、`Claude Code`、
  `web_search` 等标识符。翻译它们会让用户无法照抄命令或对照日志。
- 新增语言 = 加一份 `locales/<lang>/` + 在 `i18n/language.ts` 的 `UI_LANGUAGES`
  与服务端 `domain/settings.ts` 的 `UI_LANGUAGES` 各加一个值——**两处必须同步**，
  否则会出现"保存成功但界面不认"。

### 17. 多设备同步只传明文凭据，且必须走 HTTPS

配置同步（`server/src/routes/sync.ts`）把一台机器的配置复制到另一台。两条硬规则：

- **跨机传的是明文，不是密文。** `enc:v1:` 绑定本机 `DATA_ENCRYPTION_KEY`，
  换个密钥就解不开。所以 master 侧 `secrets.decode()` → TLS → follower 侧
  `secrets.encode()`。由此推出：快照响应必须 `no-store`、**绝不进请求日志**
  （只记"谁导出了多少条"）。
- **传输安全看实际请求，不看配置字符串。** 早先按 `publicBaseUrl` 判断，而它在
  未配置时由监听地址推导（`HOST=0.0.0.0` → `http://127.0.0.1`），被当成"回环所以安全"
  ——对外监听的服务明文就能取走全部上游 Key。现在读 `request.protocol`，且只有在
  部署者显式 `TRUST_PROXY=1` 时才采信 `X-Forwarded-Proto`（`trustProxy` 只信任回环
  来源，防止外部伪造）。follower 侧的 `masterUrl` 同样要校验，否则令牌与 Key 走明文出去。
- `sync:read`（导出快照）与 `sync:write`（拉取/仲裁）**刻意分开**：前者能把全部
  上游 Key 明文导出去，admin 只有 `sync:write`。默认不给任何角色。

### 18. 时间戳比较用数值，不用字符串

同步要判断"谁更新"，而 `updatedAt` 来自另一台机器、时区写法不保证一致。
`'2026-05-05T10:00:00+08:00'`（=02:00Z）按字典序排在 `'2026-05-05T05:00:00.000Z'`
之后，但它实际更早——直接比字符串会把"远端更新"误判成"本地更新"，产生假冲突并
保留本该被覆盖的旧值。一律用 `Date.parse()` 比数值。

另外**时间戳相同但内容不同也要判冲突**：让远端静默覆盖等于丢掉本地改动，
那正是同步功能承诺要避免的事。

## 改动后的自检清单

- `npm run typecheck` 与 `npm test` 都必须通过（当前基线：server 534 + web 30 = 564 项）。

- 新增/修改 `/api` 路由 → 确认已用 `defineRoute` 声明权限，且 `npm test` 里的冒烟用例仍能登录访问。
- 修改别名逻辑 → 补 `server/test/aliases.test.ts` 的边界（未知 key、禁用、未声明模型、格式残缺）。
- 修改 Agent 补丁 → 补 `server/test/agents.test.ts`，必须覆盖"保留无关配置"与"还原冲突"。
- 修改存储 → 补 `server/test/storage.test.ts`（原子写、损坏隔离、未来版本隔离）。
- 改到网关转发 → 跑 `server/test/smoke.test.ts`（假上游覆盖非流式、流式、501、回退、4xx 透传、日志）。
- 改到日志器 → 补 `server/test/logger.test.ts`（落盘、级别阈值、打码、滚动与保留个数）。
- 改到配置默认值 → 补 `server/test/config.test.ts`（当前 `ADMIN_USERNAME` 默认 `admin`）。
- 改到首次初始化 → 补 `server/test/setup.test.ts`（令牌校验、一次性、重放拒绝、重启幂等）。
- 改到协议匹配 → 补 `server/test/gateway.test.ts` 的 `requiredApiType` 断言 + smoke 的双向 501 用例。
- 改到诊断接口 → 确认它复用了 `selection.ts` / `convert/` / `upstreamPathFor`，
  并在 smoke 里验「默认关闭返回 404」「开启后路由预演能解释原因」。
- 改到鉴权/权限 → 补 `server/test/apiToken.test.ts`（令牌生命周期）与 smoke 里的
  「令牌能调管理接口」「越权 403」「令牌不能改口令/建令牌」「吊销后失效」。
- 改到协议转换 → 补 `server/test/convert.test.ts`（请求/响应/流式三向映射），
  并确认 smoke 里三条都在："自动开启后打通 Chat 上游"、"有 responses 供应商时不自动开"、
  "转换解决不了时仍 501 且不改设置"。
- 改到模型拉取 → 补 `server/test/smoke.test.ts`（三种协议、`/v1` 拼接、借用已保存 Key、上游不可达不 500）。
- 改到逐档实测 → 补 `server/test/effortProbe.test.ts`（两种协议的请求形状、`/v1` 拼接、accepted/rejected、
  全拒时不写能力、进度回调），并确认 smoke 里「NDJSON 流事件顺序」「anthropic 400」「无模型 400」
  「未知 id 404」「只读令牌 403」仍在。
- 改 web 测试 → 记住 `globals: false` 让 RTL **不自动 cleanup**，清理靠
  `web/test/setup.ts` 的 `afterEach(cleanup)`。少了它，上一个用例的 DOM 会留到下一个，
  症状是"单独跑通过、整个文件跑失败"或读到上一条用例的 mock 数据。
- 改界面文案 → 中文与英文两份字典一起改，跑 `npm test -w web`（字典契约 +
  硬编码扫描）；计数文案确认 `_one`/`_other` 成对。
- 改语言设置接口/存储 → 补 `server/test/smoke.test.ts` 的「界面语言设置」用例组
  （默认 null、落盘、非法值 400、读路径降级、只读令牌 403、不影响其它设置、
  报错文案跟随租户语言与 Accept-Language、每条错误都带 `messageKey`）。
- 改服务端文案 → 键进 `server/src/i18n/locales/{zh,en}/`，跑 `npm test -w server`
  （含 `server/test/i18n.test.ts` 的字典契约）。**测试断言用 `messageKey`，不要断言译文。**
- 改了品牌名 / 对外文案 → 同步 `README.md`（英文主文档）与 `README.zh-CN.md`（中文版）、
  `web/index.html`、登录页与侧边栏。**两份 README 必须同时改**：只改一份会让另一份悄悄过期。
  它们是人工维护的镜像，没有测试能抓出来。

## 明确不做的事

- 不做**任意**协议互转：只有 `/v1/responses → openai`（Chat）这一个方向有转换器。
  `/v1/messages`、`/v1/chat/completions` 等其余组合一律 501，
  即便 `protocolConversion` 开着也不会转换——别偷偷转发到错误路径。
- 不做计费、配额、多用户 UI、MCP/Skills/会话管理、桌面打包。
- 不把 JSON 文件存储换成数据库，除非任务明确要求；Repository 接口已就位，替换时不要改路由契约。
- 不要引入第二套状态管理或数据请求库来"重写"现有 `useAsync`。前端依赖刻意保持精简
  （目前额外依赖只有 i18n 的 `i18next` + `react-i18next`，见第 16 条）；新增依赖要有明确必要性。
- 不要提交 `data/`、`.env`、`node_modules/`、`dist/`。

## 文档

产品与接口细节在 `docs/`：

- `docs/architecture.md` 架构与请求流
- `docs/api.md` 接口参考
- `docs/gateway.md` 别名、选路、转发
- `docs/agents.md` Agent 配置下发
- `docs/configuration.md` 环境变量与数据目录
- `docs/security.md` 鉴权、权限、凭据与安全边界
- `docs/development.md` 开发、测试、扩展方式

改动行为时同步更新对应文档，别让文档与实现分叉。
