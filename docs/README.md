# 文档索引

仓库主 README 有中英两份：[English](../README.md) | [简体中文](../README.zh-CN.md)。
**本目录下的文档目前只有中文。**

| 文档 | 内容 |
| --- | --- |
| [architecture.md](./architecture.md) | 进程结构、分层约定、租户与身份、两条数据流、存储布局、设计取舍 |
| [api.md](./api.md) | 管理面与网关接口参考：路径、权限、请求/响应示例、错误码、`messageKey` 与语言解析顺序、三种 `apiType` |
| [gateway.md](./gateway.md) | 别名格式、选路规则、三条路径的协议匹配与鉴权头、地址拼接、流式转发、限制与调用示例 |
| [agents.md](./agents.md) | Codex / Claude Code 的写入内容、Codex 模型目录与 `web_search` 开关、三条硬约束、快照、还原、结束进程、扩展方式、排错 |
| [sync.md](./sync.md) | 多设备配置同步：角色、同步范围、凭据为什么明文过网、冲突仲裁、接口与已知限制 |
| [configuration.md](./configuration.md) | 环境变量（含 `LOG_LANGUAGE`）、两个密钥的含义、数据目录、首次启动、生产部署、迁移 |

| [security.md](./security.md) | 两类凭据、口令与会话、令牌、权限矩阵、上游凭据、文件系统边界、部署风险 |
| [development.md](./development.md) | 本地开发、测试布局、如何加接口/供应商字段/Agent/网关路径、**如何加/改界面与接口文案**、代码约定、技术债 |

## 按问题找文档

- 我想把 Codex 接到自己的 API 上 → [agents.md](./agents.md)
- 我同事的客户端报 401 → [security.md](./security.md)、[configuration.md](./configuration.md)
- 模型别名怎么起名、为什么不能回落 → [gateway.md](./gateway.md)
- 部署到服务器要注意什么 → [configuration.md](./configuration.md#生产部署)、[security.md](./security.md#部署风险清单)
- 我要加一个供应商字段 / 一个新 Agent → [development.md](./development.md)
- 我要理解某个接口返回什么 → [api.md](./api.md)
- 我要加一条界面文案 / 报错文案 → [development.md](./development.md#加改一条界面文案)、[development.md](./development.md#改服务端文案)
- 报错文案跟着什么语言走、脚本怎么判断错误类型 → [api.md](./api.md#message-跟随语言messagekey-不随语言变化)
- 日志为什么是中文（或者怎么改成英文）→ [configuration.md](./configuration.md) 的 `LOG_LANGUAGE`
- 三种协议分别接哪条路径、为什么不能直通 → [gateway.md](./gateway.md#协议匹配)、[api.md](./api.md#网关)
- Codex 为什么只能选 `responses`、`wire_api` 为什么固定写 `responses` → [agents.md](./agents.md#选哪个供应商)
- Codex 的 `/model` 列表来自哪个文件、`web_search` 为什么默认关闭 → [agents.md](./agents.md#模型目录model_catalog_json-与-model_catalog_url)
- `/model` 里的思考档位不对、比别的工具少 → [agents.md](./agents.md#131-推理档位只能靠实测不能靠声明)、[api.md](./api.md#post-apiprovidersidprobe-efforts)
- 改完配置后 Codex 没生效、要重启 → [agents.md](./agents.md#结束正在运行的进程)
- 家里和服务器都要用同一套供应商配置 → [sync.md](./sync.md)
- 为什么同步要开 HTTPS、快照里为什么会是明文 Key → [security.md](./security.md#同步快照的威胁模型)
- 我要改网关转发逻辑 → [AGENTS.md](../AGENTS.md) 的「必须遵守的约束」+ [gateway.md](./gateway.md)

## 文档维护

文档与实现一起改，不要让它们分叉。改到以下内容时同步对应文件：

| 改动 | 需同步 |
| --- | --- |
| 新增/修改 `/api` 路由 | `api.md` |
| 别名规则、选路、协议匹配 | `gateway.md` |
| 新增/修改 `apiType`（协议枚举、文案、鉴权头分组） | `gateway.md`、`api.md`、`README.md`、`AGENTS.md` |
| Agent 写入字段、`wire_api` 规则或模型目录 | `agents.md`、`api.md` |
| 同步范围、冲突判定、快照字段或 `sync:*` 权限 | `sync.md`、`api.md`、`security.md` |
| 逐档实测 / 推理档位来源（`probe-efforts`、NDJSON 进度流） | `api.md`、`agents.md`、`README.md` |

| 环境变量或数据目录结构 | `configuration.md` |
| 权限位、角色映射或权限的副作用（如结束进程） | `security.md`、`api.md` |
| 测试基线数量 | `development.md`、`AGENTS.md` |
| 新增/修改界面或接口文案 | `web/src/i18n/locales/`、`server/src/i18n/locales/`；口径说明见 `development.md` |
| 语言相关行为（语言来源、`messageKey`、`LOG_LANGUAGE`） | `api.md`、`configuration.md`、`README.md`、`AGENTS.md` |
