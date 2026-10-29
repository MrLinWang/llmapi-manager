/**
 * 设备互联（EasyTier 组网）。
 *
 * 用途：让没有公网 IP 的设备互相可达，从而能直接连对端的管理界面做配置同步。
 * 典型场景是 Linux 服务器做 master、Windows 端做 follower，但两者都不在同一个
 * 可路由的网络里。
 *
 * 实现方式：**两个引擎，自研为主、原生为备**。
 *
 * - `builtin`（默认，主）：本仓库的 TypeScript 实现
 *   （`server/src/networking/easytier/`）。协议编解码、Noise XX 握手的两个角色、
 *   数据面加解密、RPC 双向、OSPF 同步与路由广播都已用真实官方节点验证通过。
 *   好处是全平台可用（不需要 Rust 工具链、不需要编译产物）、可调试、可审计。
 * - `native`（备用）：把 EasyTier 作为 Rust 库包成 N-API 原生模块
 *   （`native/easytier-node/`），复用官方完整实现，含 NAT 穿透、`smoltcp`、
 *   端口转发、WireGuard/QUIC 等自研侧尚未覆盖的能力。
 *
 * 为什么默认用自研：它是本仓库自己维护的代码，出问题能读能改；原生模块需要
 * 另行编译，默认安装路径里往往不存在。**但自研侧证据的边界必须说清**：握手、
 * 加密、RPC、OSPF 路由已在真实链路上验证，而 NAT 穿透、多跳中继、MTU 协商、
 * 端口转发等能力**尚未实现或未验证**——这些场景要用原生引擎。
 *
 * 自动降级：引擎设为 `builtin` 时若自研侧无法启动（如端口绑定失败），
 * 会尝试原生模块；反过来也一样。降级事实会写进状态里，不静默发生。
 */

/**
 * 中继服务器（peer）。
 *
 * 格式由 EasyTier 决定，形如 `tcp://public.easytier.cn:11010`。
 * 官方公共中继可以直接用；要求更高可用性或可控性时可填自建地址。
 */
/** 组网引擎。 */
export type NetworkingEngine = 'builtin' | 'native';

/** 全部可选引擎，顺序即"默认优先级"。 */
export const NETWORKING_ENGINES: readonly NetworkingEngine[] = ['builtin', 'native'] as const;

export interface NetworkingConfig {
  /**
   * 用哪个引擎组网。
   *
   * 默认 `builtin`（自研），因为它是本仓库自己的代码且不需要编译产物；
   * `native` 保留官方完整实现，覆盖自研侧尚未实现的能力（NAT 穿透、
   * 端口转发、多跳中继等）。切换引擎需要重启组网才生效。
   */
  engine: NetworkingEngine;
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
  /**
   * 自研引擎的 TCP 监听端口。
   *
   * 只有 `engine: 'builtin'` 用它——自研实现的是**接受方角色**（只监听、
   * 不主动外连），所以对端必须主动连到 `本机地址:此端口`。
   * 原生引擎忽略它（官方自己管理端口与打洞）。
   *
   * 默认 11011：避开官方的 11010，允许两者在同一台机器上并存。
   */
  listenPort: number;
  /**
   * 数据面端口转发（只对 `builtin` 引擎生效）。
   *
   * 每项表示"对端访问本机虚拟 IP 的 `virtualPort` 时，把连接桥接到本机
   * `127.0.0.1:localPort`"。这是组网的实际用途：follower 通过虚拟 IP
   * 访问 master 的管理界面。
   *
   * 默认 `[{ virtualPort: 8787, localPort: 8787 }]`——就是本服务自己的
   * 管理界面端口，开箱即可被对端访问。
   *
   * 原生引擎忽略它（用官方的 `port_forwards`，语义不同：那边是
   * "本机监听 → 转发到虚拟网内的目标"）。
   */
  portForwards: Array<{ virtualPort: number; localPort: number }>;
  /**
   * UDP 转发（只对 `builtin` 引擎生效）。**DNS 走 UDP**，没有它
   * 虚拟网内的域名解析必然失败。
   *
   * `targetHost` 为空字符串表示"自动探测本机解析器"——DNS 的解析器
   * 通常**不是** `127.0.0.1`（systemd-resolved 用 `127.0.0.53`），
   * 由运行时读 `/etc/resolv.conf` 决定，避免开箱就不工作。
   */
  udpForwards: Array<{
    virtualPort: number;
    /** 空字符串 = 自动探测系统解析器 */
    targetHost: string;
    targetPort: number;
  }>;
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
    engine: 'builtin',
    enabled: false,
    networkName: 'llmapi',
    networkSecret: '',
    // 官方公共中继：开箱可用。用户可以换成自己的。
    peers: ['tcp://public.easytier.cn:11010'],
    hostname: 'llmapi-manager',
    ipv4: null,
    listenPort: 11011,
    portForwards: [{ virtualPort: 8787, localPort: 8787 }],
    // 默认把虚拟网内的 53 端口转给本机解析器：开箱就能解析域名
    udpForwards: [{ virtualPort: 53, targetHost: '', targetPort: 53 }],
  };
}

/**
 * 组网引擎的可用状态。两个引擎都不可用时功能降级为"仅同步"，
 * 不影响配置同步本身（可以手填 master 地址）。
 */
export interface NetworkingAvailability {
  available: boolean;
  /** 不可用的原因，直接展示给用户 */
  reason: string | null;
  /** 引擎报告的版本，便于排查版本不匹配 */
  version: string | null;
  /** 实际生效的引擎；两个都不可用时为 null */
  engine: NetworkingEngine | null;
  /** 自研引擎是否可用（几乎总是 true，除非端口被占等） */
  builtinAvailable: boolean;
  /** 原生模块是否可用（取决于是否编译） */
  nativeAvailable: boolean;
  /**
   * 是否发生了降级（请求的引擎不可用，改用了另一个）。
   *
   * 必须显式暴露：用户选了 `native` 却静默跑在 `builtin` 上，
   * 会在"为什么 NAT 穿透不生效"上浪费大量时间。
   */
  degradedFrom: NetworkingEngine | null;
}

/** 运行状态。 */
export interface NetworkingStatus extends NetworkingAvailability {
  enabled: boolean;
  running: boolean;
  virtualIpv4: string | null;
  peerCount: number;
  /**
   * 组网是否**真的**工作起来了。
   *
   * `running` 只表示 EasyTier 的实例对象已建立（`is_ready()` 为真），
   * 而它可能在没有 TUN 设备的环境里"成功"启动——容器缺 `CAP_NET_ADMIN`
   * 或宿主机没有 `/dev/net/tun` 时就是如此：
   * `startNode()` 返回成功、`running` 为真，但虚拟网卡根本没建、
   * 也就永远连不上任何节点。
   *
   * 这种"两端都不报错、只是不工作"的状态必须能被看出来，否则用户会以为
   * 配错了网络名或密钥，去反复改那些其实没问题的参数。
   * 判据是"拿到了虚拟 IP"——没有 IP 就没有可用的虚拟网络。
   */
  functional: boolean;
  /** 不工作的原因，直接展示给用户 */
  functionalReason: string | null;
}

/** 对端节点信息，用于在界面上确认"两台机器互相看见了"。 */
export interface NetworkingPeer {
  hostname: string;
  ipv4: string | null;
  latencyMs: number | null;
  tunnel: string | null;
}
