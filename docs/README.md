# 文档索引

| 文档 | 内容 |
| --- | --- |
| [architecture.md](./architecture.md) | 进程结构、分层约定、租户与身份、两条数据流、存储布局、设计取舍 |
| [api.md](./api.md) | 管理面与网关接口参考：路径、权限、请求/响应示例、错误码 |
| [gateway.md](./gateway.md) | 别名格式、选路规则、协议匹配、地址拼接、流式转发、限制与调用示例 |
| [agents.md](./agents.md) | Codex / Claude Code 的写入内容、三条硬约束、快照、还原、扩展方式、排错 |
| [configuration.md](./configuration.md) | 环境变量、两个密钥的含义、数据目录、首次启动、生产部署、迁移 |
| [security.md](./security.md) | 两类凭据、口令与会话、令牌、权限矩阵、上游凭据、文件系统边界、部署风险 |
| [development.md](./development.md) | 本地开发、测试布局、如何加接口/供应商字段/Agent/网关路径、代码约定、技术债 |

## 按问题找文档

- 我想把 Codex 接到自己的 API 上 → [agents.md](./agents.md)
- 我同事的客户端报 401 → [security.md](./security.md)、[configuration.md](./configuration.md)
- 模型别名怎么起名、为什么不能回落 → [gateway.md](./gateway.md)
- 部署到服务器要注意什么 → [configuration.md](./configuration.md#生产部署)、[security.md](./security.md#部署风险清单)
- 我要加一个供应商字段 / 一个新 Agent → [development.md](./development.md)
- 我要理解某个接口返回什么 → [api.md](./api.md)
- 我要改网关转发逻辑 → [AGENTS.md](../AGENTS.md) 的「必须遵守的约束」+ [gateway.md](./gateway.md)

## 文档维护

文档与实现一起改，不要让它们分叉。改到以下内容时同步对应文件：

| 改动 | 需同步 |
| --- | --- |
| 新增/修改 `/api` 路由 | `api.md` |
| 别名规则、选路、协议匹配 | `gateway.md` |
| Agent 写入字段或新增 Agent | `agents.md`、`api.md` |
| 环境变量或数据目录结构 | `configuration.md` |
| 权限位或角色映射 | `security.md`、`api.md` |
| 测试基线数量 | `development.md`、`AGENTS.md` |
