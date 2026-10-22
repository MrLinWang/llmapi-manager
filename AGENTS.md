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
  src/auth/           口令哈希、会话签名、Principal 解析、权限裁决、路由守卫
  src/crypto/         凭据编解码（AES-256-GCM）
  src/gateway/        网关令牌、令牌鉴权、上游转发
  src/services/       业务编排（供应商、连通性测试、请求日志、首次初始化）
  src/agents/         Agent 注册表、路径解析、JSON/TOML 保值补丁、预览/应用/还原
  src/routes/         路由薄壳，只做参数校验与调用服务
  test/               单元测试 + 端到端冒烟（含假上游）
log/                  运行日志（app.log + 滚动文件），已 gitignore
web/                  React 18 + Vite + Tailwind
  src/lib/            api 封装、鉴权上下文、useAsync、类型
  src/pages/          Login / Setup / Layout / Overview / Providers / Models / Agents / Settings
  src/components/     ui 基础件、ProviderForm、CopyButton
  test/               页面装配测试（jsdom + testing-library）
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

`lmm-<providerKey>/<model>` 是"明确指向某一家"。若供应商被禁用/删除、模型未声明，
`resolveModel` 返回 `invalid`，网关回 400。**不要加"解析失败就用默认供应商"的兜底** ——
那会用错额度、答错模型，而调用方完全看不出来。

只有不带 `lmm-` 前缀的请求才走"默认供应商 + 默认模型"。

### 4. Agent 文件只改自己拥有的键

- `agent` 下发的三条铁律：只改自己拥有的字段、保留文件其余内容、写前备份（仅当文件已存在）。
- JSON 用 `applyJsonWrites` / `removeJsonPathIfValue`，TOML 用 `applyTomlEdits` / `removeTomlKeyIfValue`。
  两者都是"读 → 定位 → 就地改写"，**解析失败必须抛错中止，绝不能退回写空文件**。
- 还原只移除"当前值仍等于我们写入值"的键；被用户改过的键保留并作为 `conflicts` 返回。
- 由我们创建、且还原后没有任何有效内容的文件要删除（`created` 标记 + `isEmptyDocument`），
  避免在用户家目录留空壳 `config.toml` / `{}`。
- 新增 Agent：在 `agents/registry.ts` 登记定义（文件角色、相对路径、格式），
  在 `agents/service.ts` 的 `buildPlan` 里补 `writes`，并明确它需要哪种 `apiType` 的供应商。

### 5. 凭据不许明文出接口

- 上游 API Key 落盘一律走 `ctx.secrets.encode()`；读明文只在真正发请求时（`ProviderService.plainApiKey`）。
- 供应商列表接口只返回 `apiKeyMasked`（首 3 位 + 8 个星 + 尾 4 位）与 `apiKeyTail`，**不得返回 `apiKey`**。
  返回对象用 `toProviderView`，注意它同时剔除了 `tenantId`。
- 网关令牌只存 `tokenHash`（sha256）。`tokenCipher` 是给 Agent 下发用的密文副本，**任何接口都不得返回**。
  完整令牌只在"生成/重置"那一次响应里出现。
- 口令只存 scrypt 哈希。日志器会按 key 名与正则打码，但不要依赖它 —— 不要主动把密钥放进日志。

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

## 改动后的自检清单

- `npm run typecheck` 与 `npm test` 都必须通过（当前基线：server 111 + web 6 = 117 项）。
- 新增/修改 `/api` 路由 → 确认已用 `defineRoute` 声明权限，且 `npm test` 里的冒烟用例仍能登录访问。
- 修改别名逻辑 → 补 `server/test/aliases.test.ts` 的边界（未知 key、禁用、未声明模型、格式残缺）。
- 修改 Agent 补丁 → 补 `server/test/agents.test.ts`，必须覆盖"保留无关配置"与"还原冲突"。
- 修改存储 → 补 `server/test/storage.test.ts`（原子写、损坏隔离、未来版本隔离）。
- 改到网关转发 → 跑 `server/test/smoke.test.ts`（假上游覆盖非流式、流式、501、回退、4xx 透传、日志）。
- 改到日志器 → 补 `server/test/logger.test.ts`（落盘、级别阈值、打码、滚动与保留个数）。
- 改到配置默认值 → 补 `server/test/config.test.ts`（当前 `ADMIN_USERNAME` 默认 `admin`）。
- 改到首次初始化 → 补 `server/test/setup.test.ts`（令牌校验、一次性、重放拒绝、重启幂等）。
- 改了品牌名 / 对外文案 → 同步 `README.md`、`web/index.html`、登录页与侧边栏。

## 明确不做的事

- 不做协议转换：`/v1/messages` 命中 `apiType=openai` 供应商时返回 501，别偷偷转发到错误路径。
- 不做计费、配额、多用户 UI、MCP/Skills/会话管理、桌面打包。
- 不把 JSON 文件存储换成数据库，除非任务明确要求；Repository 接口已就位，替换时不要改路由契约。
- 不要引入第二套状态管理或数据请求库来"重写"现有 `useAsync`；当前页面刻意保持零额外依赖。
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
