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

> **单进程模式下改前端必须重新构建。** `npm start` 托管的静态资源是**已构建**的
> `web/dist`，改 `web/src` 不会自动生效 —— 页面继续跑旧 bundle，看起来像"改了没用"。
> 要么用 `npm run dev`（Vite 热更新），要么改完执行 `npm run build -w web`。
> 排查这类"文案没变"的问题，先比对 `web/src` 与 `web/dist/assets/*.js` 的修改时间，
> 再判断是不是代码的问题。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 并行起 server + web |
| `npm run build` | web（`tsc --noEmit` + `vite build`）→ server（`tsc`） |
| `npm start` | 运行 `server/dist/index.js`，单进程托管前端 |
| `npm run typecheck` | 两个 workspace 各跑一次 `tsc --noEmit` |
| `npm test` | server（vitest）→ web（vitest + jsdom） |
| `npm run registry:sync -w server` | 用 modelinfo.dev / models.dev 校准模型上下文与推理档位（默认演练，`-- --write` 落盘） |

## 测试布局

| 文件 | 覆盖 |
| --- | --- |
| `server/test/aliases.test.ts` | providerKey 派生、脱敏、别名生成/解析的边界 |
| `server/test/config.test.ts` | 配置默认值（`ADMIN_USERNAME=admin`、日志目录与滚动参数）与非法值回落 |
| `server/test/setup.test.ts` | 首次初始化：令牌校验、一次性、重放拒绝、重启幂等、`ADMIN_PASSWORD` 应急通道 |
| `server/test/gateway.test.ts` | 上游 URL 拼接、三条路径的协议匹配、协议文案句式、令牌哈希比对 |
| `server/test/convert.test.ts` | Responses ←→ Chat 的请求 / 响应 / 流式三向映射，含工具调用与有损字段 |
| `server/test/apiToken.test.ts` | API 令牌生成与校验：`api_` 前缀区分、sha256 比对与 `timingSafeEqual`、空 scopes / 过期 / 吊销一律拒绝、`lastUsedAt` 60 秒节流、对外视图不含 hash |
| `server/test/agents.test.ts` | JSON/TOML 补丁（含 `raw` 布尔）、Codex 模型目录生成（含按模型分化的推理档位与模态白名单）、备份、还原冲突、空壳文件清理 |
| `server/test/modelInfo.test.ts` | modelinfo.dev 的字段映射、`document` 模态过滤、档位白名单与升序、`efforts: []` 与未知的区分 |
| `server/test/modelRegistry.test.ts` | models.dev 的名字归一化与多候选放弃、四源合并优先级（上游 > modelinfo > models.dev > 默认）、输出上限取最小 |
| `server/test/processes.test.ts` | Codex 进程识别（TUI / `exec` / 不误伤 `mycodex` 与一次性命令）、`etime` 解析 |
| `server/test/security.test.ts` | 权限矩阵、租户隔离、凭据编解码、路由登记 |
| `server/test/storage.test.ts` | 原子写、损坏隔离、未来版本隔离 |
| `server/test/logger.test.ts` | 运行日志落盘、级别阈值、打码、按大小滚动与保留个数 |
| `server/test/smoke.test.ts` | 端到端：登录、供应商（含三种 `apiType` 与拉取模型列表）、网关令牌、API 令牌（生命周期 / 收窄 403 / 不能改口令与建令牌 / 吊销即失效）、转发（含流式/回退/501 双向/4xx 透传/自动开启转换）、诊断接口（默认 404、开启后路由预演与自检清单、只读令牌 403）、Agent（含模型目录与 `web_search` 开关、结束进程）、界面语言设置（默认 null / 落盘 / 非法值 400 / 读路径降级 / 只读令牌 403）、越权、持久化 |
| `web/test/pages.test.tsx` | 页面装配：登录、首次设置、供应商（含获取模型与标签片段编辑）、模型（含三种协议选项与文案）、Agent、概览、设置页语言切换（落盘 PATCH + 刷新身份 + 无权限只读）（jsdom + 假 fetch） |
| `web/test/i18n.test.tsx` | 字典契约：中英键集一致、复数后缀成对、无空文案、插值变量一致、关键键存在 |
| `web/test/i18n-guard.test.tsx` | 界面文案硬编码扫描（除字典与白名单外 `web/src` 不得出现中文字面量）、语言切换与 `<html lang>` 同步 |
| `web/test/setup.ts` | 全局 `afterEach(cleanup)` 与 `beforeEach(固定为中文)`。前者原因：`globals: false` 会让 RTL 的自动清理失效，不加的话上一个用例的 DOM 会留到下一个用例，症状是"单独跑通过、整个文件跑失败"；后者原因：jsdom 的 `navigator.language` 是 `en-US`，不固定的话断言中文文案的用例会整片变红 |

`smoke.test.ts` 会起三个假上游（正常 200、永远 500、固定 4xx），用系统分配的随机端口（`port=0`），
所以并行跑测试不会撞端口。正常那个假上游同时提供 Chat Completions / Responses / Messages 三种
响应形态（`server/test/mockUpstream.ts`），以便断言请求确实打到了对应协议的路径上。
Agent 相关用例用 `AGENT_HOME_DIR` 指向临时目录，**不会碰你的真实家目录**。
`processes.test.ts` 只测纯函数（命令行分类与 `etime` 解析），不会真的给任何进程发信号。
日志用例一律把 `LOG_DIR` 指向临时目录，**不会污染仓库根的 `log/`**。

当前基线：305 项（server 278 + web 27）。

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

## 加/改一条界面文案

界面是双语的（简体中文 / English），实现是 `i18next` + `react-i18next`，字典在
`web/src/i18n/locales/{zh,en}/` 下按区域拆成多个文件（`app`、`common`、`labels`、
`providers`、`agents`…），`index.ts` 再把它们聚合成单一的 `translation` 命名空间。

1. 在**对应区域**的中文文件里加键（例如供应商页的文案放 `zh/providers.ts`），
   键名形如 `providers.table.name`。不要都堆进 `common`：一个页面改文案不该让
   所有页面的字典都变脏，review 也看不出影响范围。
2. 在英文文件里加同样的键。英文对象声明成 `typeof zhXxx`，**漏译或多键会直接编译失败**，
   不需要人工比对。
3. 组件里用 `useTranslation()` 拿 `t`，不要 import 全局 i18n 实例：
   前者会在语言切换时触发重渲染，后者要等下一次渲染才更新
   （表现为"点了切换、页面要再点一下才变"）。
4. 带变量的文案用 `{{name}}` 插值。**带计数的句子必须写复数三份键**：
   `key_one` / `key_other`（中文两份文本相同），调用 `t(key, { count })`。
   只写基名的话，英文在 `count=1` 时也会说 `1 items`。
5. 句子里含 `<code>` / `<strong>` 时用 `<Trans i18nKey="..." components={{ code: <code className="font-mono" /> }} />`，
   字典值里保留 `<code>…</code>`；如果嵌的是运行时变量（如某个路径），
   改为把标签留在 JSX、只翻译前后半句。
6. 时间一律用 `web/src/i18n/format.ts` 的 `formatDateTime` / `formatTime` /
   `formatTimestamp`。**不要用 `toLocaleString()` 的默认行为**：它跟随浏览器语言，
   会出现"界面英文、时间是中文格式"。

边界（不要越界，也别试图绕开）：

- **服务端返回的 `message`（`AppError`、启动告警、Agent 描述、诊断输出）仍是中文**，
  前端原样显示。要翻译它们得在服务端引入消息键，那是另一项改动。
- 语言偏好存服务端（`TenantSettings.language`，`null` = 跟随浏览器），
  接口是 `PATCH /api/settings/language`，随 `GET /api/auth/me` 一并下发。
  **不要用 localStorage**：换浏览器后设置会丢，也可能与另一台设备上的选择打架。
- 不翻译：品牌名、模型名、`lam-` 别名、`/v1/...`、`Codex`、`Claude Code`、
  `web_search` 这类标识符。

改完跑：`npm run typecheck -w web`（键名与漏译）+
`npm test -w web`（字典契约 + 硬编码扫描 + 页面装配）。

## 代码约定

- **语言**：注释用中文；标识符、类型名、日志 key 用英文。
  界面文案一律走 i18n 字典（见上面「加/改一条界面文案」），**不允许在组件里
  硬编码中文**——`web/test/i18n-guard.test.tsx` 会扫出来。
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
