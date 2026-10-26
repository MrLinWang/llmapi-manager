# 开发指南

## 环境

- Node.js >= 18.18（`package.json` 的 `engines`）。开发机上验证过 18.20。
- npm 9+（使用 workspaces）。
- 无需数据库、无需 Go/Rust 工具链。

## 起步

```bash
git clone <repo> && cd llmapi-manager
npm install
cp .env.example .env
npm run dev
```

打开 http://localhost:5173 ，首次启动会进入设置页：
把控制台打印的一次性初始化令牌填进去，自己设管理员用户名与口令。
Vite 把 `/api`、`/v1` 代理到 `http://127.0.0.1:8787`（可用 `SERVER_ORIGIN` 覆盖）。

只跑一侧：

```bash
npm run dev -w server     # tsx watch，改文件自动重启
npm run dev -w web        # vite，热更新
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 并行起 server + web |
| `npm run build` | web（`tsc --noEmit` + `vite build`）→ server（`tsc`） |
| `npm start` | 运行 `server/dist/index.js`，单进程托管前端 |
| `npm run typecheck` | 两个 workspace 各跑一次 `tsc --noEmit` |
| `npm test` | server（vitest）→ web（vitest + jsdom） |

## 测试布局

| 文件 | 覆盖 |
| --- | --- |
| `server/test/aliases.test.ts` | providerKey 派生、脱敏、别名生成/解析的边界 |
| `server/test/config.test.ts` | 配置默认值（`ADMIN_USERNAME=admin`、日志目录与滚动参数）与非法值回落 |
| `server/test/setup.test.ts` | 首次初始化：令牌校验、一次性、重放拒绝、重启幂等、`ADMIN_PASSWORD` 应急通道 |
| `server/test/gateway.test.ts` | 上游 URL 拼接、三条路径的协议匹配、协议文案句式、令牌哈希比对 |
| `server/test/convert.test.ts` | Responses ←→ Chat 的请求 / 响应 / 流式三向映射，含工具调用与有损字段 |
| `server/test/apiToken.test.ts` | API 令牌生成与校验：`api_` 前缀区分、sha256 比对与 `timingSafeEqual`、空 scopes / 过期 / 吊销一律拒绝、`lastUsedAt` 60 秒节流、对外视图不含 hash |
| `server/test/agents.test.ts` | JSON/TOML 补丁（含 `raw` 布尔）、Codex 模型目录生成、备份、还原冲突、空壳文件清理 |
| `server/test/sync.test.ts` | 配置同步：快照导出 Key 为明文且不含网关令牌、只导出勾选范围、跨机重新加密后能解出原文、冲突判定（本地更晚 / 远端更晚 / 内容相同 / 时间戳相同但内容不同 / 时区偏移）、冲突文件无明文 Key、不删远端没有的供应商、不覆盖本机网关令牌、两种仲裁选择、未配置加密密钥时不封存远端值 |
| `server/test/processes.test.ts` | Codex 进程识别（TUI / `exec` / 不误伤 `mycodex` 与一次性命令）、`etime` 解析 |
| `server/test/security.test.ts` | 权限矩阵、租户隔离、凭据编解码、路由登记 |
| `server/test/storage.test.ts` | 原子写、损坏隔离、未来版本隔离 |
| `server/test/logger.test.ts` | 运行日志落盘、级别阈值、打码、按大小滚动与保留个数 |
| `server/test/smoke.test.ts` | 端到端：登录、供应商（含三种 `apiType` 与拉取模型列表）、网关令牌、API 令牌（生命周期 / 收窄 403 / 不能改口令与建令牌 / 吊销即失效）、转发（含流式/回退/501 双向/4xx 透传/自动开启转换）、诊断接口（默认 404、开启后路由预演与自检清单、只读令牌 403）、Agent（含模型目录与 `web_search` 开关、结束进程）、越权、持久化 |
| `web/test/pages.test.tsx` | 页面装配：登录、首次设置、供应商（含获取模型与标签片段编辑）、模型（含三种协议选项与文案）、Agent、概览（jsdom + 假 fetch） |
| `web/test/setup.ts` | 全局 `afterEach(cleanup)`。`globals: false` 会让 RTL 的自动清理失效，不加这个的话上一个用例的 DOM 会留到下一个用例，症状是"单独跑通过、整个文件跑失败" |

`smoke.test.ts` 会起三个假上游（正常 200、永远 500、固定 4xx），用系统分配的随机端口（`port=0`），
所以并行跑测试不会撞端口。正常那个假上游同时提供 Chat Completions / Responses / Messages 三种
响应形态（`server/test/mockUpstream.ts`），以便断言请求确实打到了对应协议的路径上。
Agent 相关用例用 `AGENT_HOME_DIR` 指向临时目录，**不会碰你的真实家目录**。
`processes.test.ts` 只测纯函数（命令行分类与 `etime` 解析），不会真的给任何进程发信号。
日志用例一律把 `LOG_DIR` 指向临时目录，**不会污染仓库根的 `log/`**。

当前基线：424 项（server 412 + web 12）。

```bash
npm test                                # 全部
npm test -w server                      # 只跑服务端
npx vitest run --root server test/smoke.test.ts
npm run typecheck
```

## 加一个管理接口

```ts
// server/src/routes/providers.ts
defineRoute(
  app,
  registry,
  { method: 'GET', url: '/api/providers/:id/usage', access: 'providers:read' },
  async (request) => {
    const principal = getPrincipal(request);   // 需要身份时
    const { id } = request.params as { id: string };
    return service.someRead(principal, id);
  },
);
```

要点：

1. 必须用 `defineRoute`，它同时登记访问声明；漏了会在启动自检时报错。
2. `access` 选最贴近的权限；只有真正公开的才用 `'public'`。
3. 参数校验放在路由或服务入口，抛 `badRequest` / `notFound` / `conflict`（`http/errors.ts`）。
4. 租户数据一律通过 `ctx.store.forTenant(principal.tenantId)` 取，不要拼路径。
5. 在 `smoke.test.ts` 里补一条能跑通的正向用例 + 一条越权/边界用例。

## 加一个供应商能力

供应商当前是扁平模型（`domain/provider.ts`）。新增字段时：

1. 在 `ProviderRecord` 加字段（注意：可选项用 `?`，保持旧文件可读）。
2. 在 `ProviderView` / `toProviderView` 决定它是否对外可见（凭据类字段必须剔除或脱敏）。
3. 在 `services/providers.ts` 的 `create` / `update` 做归一化与校验。
4. 前端 `web/src/lib/types.ts` + `components/ProviderForm.tsx` + `pages/ProvidersPage.tsx` 同步。
5. 存储无需迁移：读取时缺字段走 `undefined`，写入时按新结构保存。

## 加一个 Agent

见 [agents.md](./agents.md#新增一个-agent)。核心是三步：注册表登记定义、`buildPlan` 补写入键、
补 `agents.test.ts` 用例。若目标格式不是 JSON/TOML，建议在 `agents/` 下新增一个格式模块，
而不是在路由或服务里做字符串替换。

## 加一个网关路径

1. `gateway/forward.ts` 的 `GatewayPath` 加枚举值，并在**同一个文件**的 `GATEWAY_PATHS`
   里登记、在 `requiredApiType` 声明协议要求（路径清单与协议要求只在这里定义一次）。
2. `routes/gateway.ts` 复用 `GATEWAY_PATHS`，不要复制一份 —— 复制出来的副本只改一处会漏另一处。
3. 确认上游 URL 拼接（`upstreamUrl`）对你的路径成立。
4. 若引入新的 `apiType`，同步 `domain/provider.ts` 的 `API_TYPES` / `apiTypeLabel`、
   前端 `web/src/lib/labels.ts` 的 `API_TYPE_META`（文案统一成「<厂商> 兼容（<API 形态>）」），
   以及鉴权头分组（当前只有 anthropic 走 `x-api-key`）。
5. 在 `gateway.test.ts` 补 `requiredApiType` 断言，在 `smoke.test.ts` 补一条真实转发用例
   和一条反向 501 用例。

## 代码约定

- **语言**：注释与用户可见文案用中文；标识符、类型名、日志 key 用英文。
- **类型**：`strict` 已开，且开了 `noUnusedLocals` / `noUnusedParameters`，不要用 `any` 绕过。
- **分层**：路由薄、服务厚、领域纯。领域层不得 import Fastify 或 fs。
- **错误**：统一抛 `AppError` 子类，让 `app.ts` 的错误处理器产出标准结构；不要手写 `reply.code(500)`。
- **注释**：只解释"为什么"（尤其是有坑的地方，如响应流 close、空 body 的 JSON 头），
  不复述代码在做什么。
- **前端**：所有请求走 `web/src/lib/api.ts`；权限判断用 `useAuth().can()`；
  除编辑态输入框外不得渲染明文密钥。

## 调试

```bash
LOG_LEVEL=debug npm run dev:server          # 更详细的日志
curl -s localhost:8787/api/health | jq      # 启动告警
```

- 想看网关实际行为：起一个假上游（参见 `server/test/mockUpstream.ts` 的实现思路），
  把供应商的 Base URL 指向它。
- 想看 Agent 会写什么：先调 `POST /api/agents/:id/preview`，它不会改任何文件。
  想验证写入，把 `AGENT_HOME_DIR` 指到临时目录。想连 Codex 的配置目录一起隔离，
  可另设 `CODEX_HOME`（结束进程时按它定位）。
- 想看模型目录：应用 Codex 配置后读 `~/.codex/llmapi-model-catalog.json`；
  `codex debug models` 可导出官方目录作为结构参照。
- 会话问题：`data/instance.json` 被换了会导致所有会话失效。

## 提交前自查

- `npm run typecheck` 与 `npm test` 全绿。
- 改了 `/api` 路由 → 权限声明齐全，冒烟用例通过。
- 改了别名逻辑 → `aliases.test.ts` 覆盖了新边界。
- 改了 Agent 补丁 → `agents.test.ts` 覆盖"保留无关配置"与"还原冲突"。
- 改了 Codex 模型目录 → `agents.test.ts`（目录结构）与 `smoke.test.ts`（顶层键 + 目录文件生成/还原）通过。
- 改了进程识别规则 → `processes.test.ts` 覆盖新的命令行形态，且"不误伤"用例仍通过。
- 改了存储 → `storage.test.ts` 覆盖原子写与损坏隔离。
- 改了协议匹配或 `apiType` → `gateway.test.ts` 的 `requiredApiType` 断言 +
  `smoke.test.ts` 的双向 501 用例（`/v1/responses` 打 `openai` 供应商、`responses` 供应商打
  `/v1/chat/completions`）通过。
- 改了鉴权 / 权限 → `apiToken.test.ts`（令牌生命周期）与 `smoke.test.ts` 的
  「令牌能调管理接口」「越权 403」「令牌不能改口令 / 建令牌」「吊销后失效」都通过。
- 改了诊断接口 → `smoke.test.ts` 里「默认关闭返回 404」与「开启后路由预演/自检清单」通过，
  且确认它复用的是 `selection.ts` / `convert/` / `upstreamPathFor`，没有自己重算一遍。
- 改了行为 → `docs/` 对应章节同步更新。
- 没有把 `data/`、`.env`、`node_modules/`、`dist/` 加进版本库。

## 已知技术债

| 项 | 现状 | 若要做 |
| --- | --- | --- |
| 租户写死 | `app.ts` 用 `DEFAULT_TENANT_ID` | 改为从 `Principal` 取，并增加用户/租户管理 |
| 存储 | JSON 文件 + 进程内缓存 | 换 SQLite/Postgres，实现同一套 `TenantRepos` 接口 |
| 请求日志 | 全量追加，无轮转 | 加按大小/时间轮转或迁移到数据库 |
| 无熔断 | 失败供应商不会被摘除 | 加熔断器与健康检查，注意与"别名不回落"的语义区分 |
| 协议转换 | 只支持 `/v1/responses → openai`（Chat）一个方向 | 其余组合（如 `/v1/messages`）仍 501；需要时按 `gateway/convert/` 的结构补转换器 |
| Codex 模型目录 | 上下文与输出上限是写死的保守值（128k / 8192），不反映上游真实能力 | 需要在供应商记录里补"每模型能力"字段，再喂给目录生成 |
| 结束进程 | 只覆盖 Linux/macOS（依赖 `ps -ww -Ao`），Windows 上探测不到进程 | 按平台分支实现（Windows 需 `tasklist` / `wmic` 或 `Get-CimInstance`） |
| 前端数据层 | 自写 `useAsync` | 页面规模变大后再评估引入查询库，不要提前抽象 |
