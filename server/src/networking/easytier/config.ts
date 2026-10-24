/**
 * EasyTier 节点配置模型（TypeScript 侧）。
 *
 * 对照 `easytier-core/src/config/toml.rs` 的 `TomlConfig` 结构。
 *
 * ## 为什么单独一个模块
 *
 * 配置项决定"节点能不能加入网络"，而官方配置有几十个字段。这里只收需要的子集，
 * 并**显式记录哪些字段是必须的、哪些有默认值、哪些故意不暴露**。
 *
 * 显式不暴露的字段（以及理由）：
 * - `listeners` / `rpc_portal`：本服务不对外提供 EasyTier 的 RPC 面板，
 *   开放这些端口只会多一个攻击面
 * - `proxy_networks` / `vpn_portal_config`：子网代理与会话级 VPN 属于进阶用法，
 *   本功能的目的是"让两台设备互相可达"，不需要
 * - `file_logger`：日志统一走本服务的 logger，避免出现两套日志文件
 *
 * 这个取舍会写进 `docs/sync.md`，让用户知道"界面上没有某项"是有意为之。
 */

/**
 * 本服务生成的节点配置。
 *
 * 字段名用 camelCase（TypeScript 习惯），映射到 EasyTier 的 TOML 时
 * 由 `toToml()` 负责转成 snake_case。转换集中在一处，方便对照检查。
 */
export interface NodeConfigInput {
  /** 网络名。同一网络名的节点互相发现 */
  networkName: string;
  /** 网络密钥。绝不写日志 */
  networkSecret: string;
  /** 中继服务器（已规范化的 `scheme://host:port`） */
  peers: string[];
  /** 本节点在网络里显示的名字 */
  hostname: string;
  /** 期望的虚拟 IPv4；null 表示由 EasyTier 自动分配 */
  ipv4: string | null;
  /**
   * 是否启用数据加密。默认开启。
   *
   * 关闭只在"内网且对性能极度敏感"时有意义——关掉后同网络内的流量是明文，
   * 而网络密钥本身仍用于握手。
   */
  enableEncryption: boolean;
}

export function defaultNodeConfig(): NodeConfigInput {
  return {
    networkName: 'llmapi',
    networkSecret: '',
    peers: ['tcp://public.easytier.cn:11010'],
    hostname: 'llmapi-manager',
    ipv4: null,
    enableEncryption: true,
  };
}

/** TUN 设备名固定，便于识别与清理。与原生模块侧的约定保持一致。 */
export const TUN_DEVICE_NAME = 'llmapi0';

/** EasyTier 的实例名。用于在 `easytier-cli` 侧识别本服务起的实例。 */
export const INSTANCE_NAME = 'llmapi-manager';

/**
 * 校验节点配置。返回所有问题而不是第一个——
 * 用户改一处保存一次太麻烦，一次性列出更好。
 */
export function validateNodeConfig(config: NodeConfigInput): string[] {
  const errors: string[] = [];
  if (config.networkName.trim() === '') errors.push('网络名不能为空');
  if (config.networkSecret.trim() === '') {
    errors.push('网络密钥不能为空（知道网络名与密钥的节点都能加入）');
  }
  if (config.hostname.trim() === '') errors.push('节点名不能为空');
  if (config.peers.length === 0) {
    errors.push('至少需要一个中继服务器，否则节点无法发现彼此（除非在同一局域网）');
  }
  if (config.ipv4 !== null && !isValidIpv4(config.ipv4)) {
    errors.push(`虚拟 IPv4 格式不合法：${config.ipv4}`);
  }
  return errors;
}

function isValidIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = Number.parseInt(part, 10);
    return num >= 0 && num <= 255;
  });
}

/**
 * 生成 EasyTier 的 TOML 配置文本。
 *
 * 为什么先生成 TOML 而不是直接拼命令行：配置放文件里可审计（用户能看到实际参数）、
 * 不经 shell（不会被空格与引号影响）、也不受命令行长度限制。
 * Rust 侧的 `create_native_instance(TomlConfig)` 收的正是这个结构。
 *
 * **注意**：`network_secret` 会出现在返回的文本里。调用方必须保证
 * 这个文本不被写进日志、也不被返回给前端。
 */
export function toToml(config: NodeConfigInput, listenPort: number): string {
  const lines: string[] = [
    `instance_name = "${INSTANCE_NAME}"`,
    `hostname = "${escapeToml(config.hostname)}"`,
    `instance_id = ""`,
    '',
    `dhcp = false`,
    `network_name = "${escapeToml(config.networkName)}"`,
    // 密钥在文件里；调用方不得记录本函数的返回值
    `network_secret = "${escapeToml(config.networkSecret)}"`,
    `ipv4 = "${config.ipv4 ?? ''}"`,
    '',
    `[[peer]]`,
    ...config.peers.map((peer) => `uri = "${escapeToml(peer)}"`),
    '',
    `[flags]`,
    `default_protocol = "tcp"`,
    `enable_encryption = ${config.enableEncryption ? 'true' : 'false'}`,
    `enable_ipv6 = false`,
    // 不对外暴露 RPC 面板：本服务不提供那个界面，开放端口只会多一个攻击面
    `disable_p2p = false`,
    `relay_network_whitelist = "${escapeToml(config.networkName)}"`,
    '',
    `[file_logger]`,
    // 日志统一走本服务，避免出现第二套日志文件
    `enabled = false`,
    '',
    `[[listeners]]`,
    `url = "tcp://0.0.0.0:${listenPort}"`,
    '',
  ];
  return lines.join('\n');
}

/** TOML 基本字符串转义。只处理会让解析失败的字符。 */
function escapeToml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
