/**
 * 通用错误文案。
 *
 * 只放"框架级"报错（鉴权、404、500、协议不匹配这类不归属某个业务区域的），
 * 业务报错放各自区域文件（`providers` / `agents` / `tokens`…）。
 */
export const zhErrors = {
  unauthorized: '需要登录',
  forbidden: '没有执行该操作的权限',
  notFound: '资源不存在',
  internal: '服务端内部错误',
  /** 路由访问登记簿漏声明：这是开发期错误，不应出现在正常运行中 */
  routeNotDeclared: '路由 {{method}} {{url}} 未在访问登记簿中声明',
  /** `/api/*` 或 `/v1/*` 下不存在的路径 */
  apiRouteMissing: '接口不存在：{{method}} {{url}}',
  /** Fastify 自身的 schema 校验/JSON 解析失败：文案来自框架，不翻译 */
  framework: '请求格式不正确',
};
