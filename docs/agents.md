# Agent 配置下发

把聚合后的网关地址、令牌与模型别名写进本机 Agent 的配置文件，让 Agent 直接用上这套聚合结果。

## 支持的 Agent

| id | 名称 | 文件 | 需要的上游协议 |
| --- | --- | --- | --- |
| `codex` | Codex CLI | `~/.codex/config.toml`、`~/.codex/auth.json` | `responses`（回落 `openai`） |
| `claude-code` | Claude Code | `~/.claude/settings.json` | `anthropic` |

路径由 `AgentPathResolver` 解析：优先取 `AGENT_HOME_DIR`，否则用服务进程所属 OS 用户的家目录。
它按 `{ tenantId, userId }` 计算，`registerTenantWorkspace()` 已预留为"每租户独立工作区"的入口。

## 选哪个供应商

Agent 只能用与自己协议匹配的供应商。协议按优先级列表依次尝试：

| Agent | 候选协议（按顺序） |
| --- | --- |
| `codex` | `responses` → `openai` |
| `claude-code` | `anthropic` |

Codex 优先用原生 Responses 上游（`wire_api = "responses"`）；没有则回落到 `openai` 供应商，
此时 `wire_api` 写 `chat`。**两者必须一起变**：Codex 发 Responses 请求时，
`/v1/responses` 严格要求 `responses` 上游，若配置写 `responses` 却选了 `openai` 供应商，
请求会被网关 501 拦下。

对每种候选协议，选择顺序是：

1. 默认供应商协议匹配 → 用它；
2. 否则取第一个启用的、协议匹配的供应商（按 `priority`）；
3. 所有候选协议都没有 → 400，例如 Codex 是
   `没有可用的 OpenAI 兼容（Responses） 或 OpenAI 兼容（Chat Completions） 供应商，请先添加并启用`，
   Claude Code 是 `没有可用的 Anthropic 兼容（Messages） 供应商，请先添加并启用`
   （`apiTypeLabel` 统一拼出「<厂商> 兼容（<API 形态>）」，与前端下拉文案同源）。

模型优先用"默认供应商 + 默认模型"的组合，否则取该供应商声明的第一个模型。
最终写入客户端的模型是**聚合别名** `lmm-<providerKey>/<model>`，这样 Agent 的每次请求都会明确打到这一家。

## 写入内容

### Codex CLI

`config.toml` 只改这 6 个键：

```toml
model_provider = "llmapi"
model = "lmm-mock-responses/gpt-resp"

[model_providers.llmapi]
name = "LLM API Manager"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"        # 选到 responses 供应商时
requires_openai_auth = true
```

若没有 `responses` 供应商、回落到 `openai` 供应商，则 `wire_api` 写 `chat`
（Codex 省略该键时默认也是 chat），模型指向那家 openai 供应商的别名。

`auth.json`：

```json
{ "OPENAI_API_KEY": "lmm_<网关令牌>" }
```

> 这里的 Key 是**本服务的网关令牌**，不是上游供应商的 Key。上游 Key 只存在于服务端。

### Claude Code

`settings.json` 只改 `env` 下这 3 个键：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "lmm_<网关令牌>",
    "ANTHROPIC_MODEL": "lmm-mock-anthropic/claude-x"
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

### 写入前备份

仅当文件已存在时备份到：

```
data/tenants/<tenantId>/backups/<agentId>/<ISO 时间戳>-<文件名>
```

文件不存在时直接创建（含父目录），此时不产生备份。

### 还原是保守的

只移除"当前值仍等于我们当初写入的值"的键。被你手改过的键保留，并作为 `conflicts` 返回。
若文件是本次应用时由我们创建、且还原后已无任何有效内容，则直接删除该文件，
避免在家目录留下空壳 `config.toml` 或 `{}`。

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
            "model": "lmm-mock-responses/gpt-resp",
            "[model_providers.llmapi] name": "LLM API Manager",
            "[model_providers.llmapi] base_url": "http://127.0.0.1:8787/v1",
            "[model_providers.llmapi] wire_api": "responses",
            "[model_providers.llmapi] requires_openai_auth": "true"
          },
          "created": false
        }
      ]
    }
  }
}
```

`values` 里表内键的写法是 `"[model_providers.llmapi] base_url"`，还原时按此拆出表名与键名。
`appliedBy` 是为了将来多用户审计留痕。

## 操作流程

1. **预览**（`POST /api/agents/:id/preview`）：只读。返回文件绝对路径、"当前值 vs 将写入值"对照，
   以及文件是否已存在。UI 用 `differs` 标记有变化的键。
   凭据类键（`OPENAI_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 等）只返回掩码，完整令牌不会出现在预览响应里；
   完整值只在 `apply` 时写入目标文件。
2. **应用**（`POST /api/agents/:id/apply`）：备份 → 原子写入 → 记录快照。状态变为"已接管"。
3. **重启 Agent**：配置只在进程启动时读取，应用后需要重启才能生效（UI 会提示）。
4. **还原**（`POST /api/agents/:id/revert`）：撤销写入的键，清除快照，状态回到"未接管"。

## 新增一个 Agent

1. 在 `server/src/agents/registry.ts` 的 `AGENT_DEFINITIONS` 登记：`homeDirName`、文件列表
   （`role` / `relativePath` / `format`）。
2. 在 `server/src/agents/service.ts` 的 `buildPlan` 里补 `writes`，并按需要扩展
   `buildPlan` 的协议选择（`codex → responses|openai`、`claude-code → anthropic`），
   以及 Codex 的 `wire_api` 必须跟着所选供应商协议走。
3. 补测试：`server/test/agents.test.ts` 覆盖"保留无关配置"与"还原冲突"；
   若是新格式，同时扩展 `agents/patch.ts`（而不是在路由里做字符串替换）。
4. 更新本文档与 `docs/api.md` 的 Agent 章节。

## 排错

| 现象 | 原因 |
| --- | --- |
| 预览返回 400「尚未生成网关令牌」 | 先去"模型聚合"页生成令牌 |
| 预览返回 400「没有可用的 OpenAI 兼容（Responses） 或 OpenAI 兼容（Chat Completions） 供应商」/「没有可用的 Anthropic 兼容（Messages） 供应商」 | 该 Agent 的候选协议都没有启用的供应商（Codex 会先试 `responses`、再试 `openai`，都没有才报错） |
| 预览返回 400「未声明任何模型」 | 供应商的 `models` 为空 |
| Codex 请求网关返回 501 | `wire_api` 与所选供应商协议不一致：`responses` 供应商要写 `responses`，`openai` 供应商要写 `chat`。重新应用配置即可（`wire_api` 由所选供应商协议决定） |
| 应用后 Agent 仍走旧配置 | Agent 进程需要重启 |
| 还原时出现 conflicts | 被写入的键后来被手动改过，按提示自行处理 |
| 预览报「字段 xxx 不是对象」 | 目标 JSON 里该路径是标量，无法下钻；需手动整理 |
