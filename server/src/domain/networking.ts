/**
 * 设备互联（EasyTier 组网）。
 *
 * 用途：让没有公网 IP 的设备互相可达，从而能直接连对端的管理界面做配置同步。
 * 典型场景是 Linux 服务器做 master、Windows 端做 follower，但两者都不在同一个
 * 可路由的网络里。
 *
 * 实现方式：把 EasyTier 作为 Rust 库包成 N-API 原生模块（`native/easytier-node/`），
 * 在**本进程内**运行，从而复用官方的握手、加密、NAT 穿透与路由实现，
 * 天然兼容官方中继服务器与自建中继。
 *
 * 为什么不自研：EasyTier core 是 6 万余行 Rust 的网络协议栈，其正确性依赖大量
 * 真实网络环境（NAT 类型、丢包、MTU、防火墙）验证。自造一份既不可靠、又无法
 * 跟上上游的安全修复。所以这里只做"托管"，不重新实现协议。
 */

/**
 * 中继服务器（peer）。
 *
 * 格式由 EasyTier 决定，形如 `tcp://public.easytier.cn:11010`。
 * 官方公共中继可以直接用；要求更高可用性或可控性时可填自建地址。
 */
export interface NetworkingConfig {
  /**
   * 是否启用组网。
   *
   * 默认 false：原生模块可能没编译（需要 Rust 工具链），而且组网会创建 TUN 设备、
   * 需要相应权限。不该因为升级就自动开始做这些事。
   */
  enabled: boolean;
  /** 网络名。**同一网络名的节点才会互相发现**，相当于"房间名" */
  networkName: string;
  /**
   * 网络密钥。落盘时经 `ctx.secrets.encode()` 加密。
   *
   * 这是网络的准入门槛：知道网络名+密钥的人都能加入。因此：
   * - 界面上一律打码，不回显
   * - 绝不写日志
   * - 绝不进同步快照（每台机器各自持有）
   */
  networkSecret: string;
  /** 中继服务器列表。为空时 EasyTier 只能靠局域网发现 */
  peers: string[];
  /** 本节点在网络里显示的名字，便于在两台机器间辨认 */
  hostname: string;
  /**
   * 期望的虚拟 IP（如 `10.126.126.1`）。为空则由 EasyTier 自动分配。
   * 固定下来的好处是 follower 可以直接记住 master 的固定地址。
   */
  ipv4: string | null;
}

export function defaultNetworkingConfig(): NetworkingConfig {
  return {
    enabled: false,
    networkName: 'llmapi',
    networkSecret: '',
    // 官方公共中继：开箱可用。用户可以换成自己的。
    peers: ['tcp://public.easytier.cn:11010'],
    hostname: 'llmapi-manager',
    ipv4: null,
  };
}

/** 原生模块的可用状态。缺失时功能降级为"仅同步"，不影响其他部分。 */
export interface NetworkingAvailability {
  available: boolean;
  /** 不可用的原因，直接展示给用户（例如"未编译原生模块"） */
  reason: string | null;
  /** 原生模块报告的版本，便于排查版本不匹配 */
  version: string | null;
}

/** 运行状态。 */
export interface NetworkingStatus extends NetworkingAvailability {
  enabled: boolean;
  running: boolean;
  virtualIpv4: string | null;
  peerCount: number;
}

/** 对端节点信息，用于在界面上确认"两台机器互相看见了"。 */
export interface NetworkingPeer {
  hostname: string;
  ipv4: string | null;
  latencyMs: number | null;
  tunnel: string | null;
}
