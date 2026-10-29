/**
 * 设备互联（EasyTier 组网）的接口文案。
 *
 * 覆盖 `/api/networking*` 的参数校验错误。这些错误大多是"前端传了非法类型"，
 * 但接口也会被脚本直接调用，所以文案要说清字段名与期望值。
 *
 * **安全约束**：不得回显 `networkSecret` 的值（哪怕打码）。
 * 早先前端提交打码值表示"不修改"，这个语义在 `networking.ts` 里有注释说明。
 */
export const zhNetworking = {
  engine: {
    /** 只有两个引擎，写错说明调用方拼错了枚举值 */
    invalid: 'engine 只能是 builtin（自研）或 native（原生模块）',
  },
  listenPort: {
    /** 自研引擎的 TCP 监听端口 */
    invalid: 'listenPort 必须是 1-65535 之间的整数',
  },
  enabled: {
    mustBeBoolean: 'enabled 必须是布尔值',
  },
  networkName: {
    /** 网络名是网络隔离的依据，空字符串等于加入一个无名网络 */
    required: 'networkName 不能为空',
  },
  networkSecret: {
    mustBeString: 'networkSecret 必须是字符串',
  },
  peers: {
    mustBeStringArray: 'peers 必须是字符串数组',
  },
  hostname: {
    required: 'hostname 不能为空',
  },
  ipv4: {
    mustBeStringOrNull: 'ipv4 必须是字符串或 null',
  },
  start: {
    /** 没启用就启动是配置顺序错了，先说清要先做什么 */
    needEnable: '请先在配置里启用设备互联（enabled），再启动',
  },
};
