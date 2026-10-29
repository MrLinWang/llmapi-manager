import type { Logger } from '../logger';
import type {
  NetworkingAvailability,
  NetworkingConfig,
  NetworkingEngine,
  NetworkingPeer,
  NetworkingStatus,
} from '../domain/networking';
import { EasyTierAcceptor } from './easytier/acceptor';
import { randomBytes } from 'node:crypto';

/**
 * 组网运行时：**双引擎**，自研为主、原生为备。
 *
 * | 引擎 | 实现 | 状态 | 覆盖 |
 * | --- | --- | --- | --- |
 * | `builtin`（默认） | 本仓库 TS（`easytier/`） | 主路径 | 握手/加密/RPC/OSPF 路由 |
 * | `native` | `native/easytier-node/` | 备用 | 官方完整能力（NAT 穿透、端口转发等）|
 *
 * 为什么要两个：自研侧是本仓库自己的代码，出问题能读能改、不依赖 Rust 工具链；
 * 但它的证据边界是"握手/加密/RPC/OSPF 路由"，**NAT 穿透、多跳中继、MTU 协商、
 * 端口转发尚未实现**——那些场景必须能用官方的完整实现兜住。
 *
 * 三条约束：
 * 1. **原生模块不在顶层 `require`**：它是可选依赖，顶层 require 失败会让整个
 *    服务起不来。改成首次使用时惰性加载并缓存结果。
 * 2. **降级必须显式**：请求的引擎不可用时改用另一个，要把 `degradedFrom` 报给
 *    调用方。静默降级会让用户在"为什么 NAT 穿透不生效"上浪费大量时间。
 * 3. **`networkSecret` 不落日志**：它是网络的准入门槛。
 */

/** 原生模块的接口形状，与 `native/easytier-node/src/lib.rs` 的导出保持一致。 */
interface NativeModule {
  startNode(options: {
    networkName: string;
    networkSecret: string;
    peers: string[];
    hostname: string;
    /**
     * 期望的虚拟 IP。
     *
     * **类型只写 `string | undefined`，不要写 `null`**：napi-rs 在
     * `#[napi(object)]` 的结构体上把 `Option<String>` 映射成"可省略但不可为 null"，
     * 传 `null` 会抛 `Failed to convert JavaScript value Null into rust type String`。
     * 这个错误在启动时才出现、且文案像类型系统内部问题，很容易被误判成 Rust 代码写错了。
     */
    ipv4?: string;
  }): Promise<void>;
  stopNode(): Promise<void>;
  nodeStatus(): Promise<{ running: boolean; virtualIpv4?: string | null; peerCount: number }>;
  listPeers(): Promise<
    Array<{ hostname: string; ipv4?: string | null; latencyMs?: number | null; tunnel?: string | null }>
  >;
  /**
   * 协议层自检（纯计算，不启动实例、不联网）。
   *
   * 这是原生模块正确性的**直接证据**：组网成功只能说明"整体能走通"，
   * 而字段错了可能被对端宽容忽略。这里逐层核对能编出正确的字节。
   */
  protocolSelfCheck(): NativeProtocolSelfCheck;
}

/** 协议自检的单层结果。 */
export interface NativeLayerCheck {
  layer: string;
  ok: boolean;
  detail: string;
}

/** 协议自检报告。 */
export interface NativeProtocolSelfCheck {
  ok: boolean;
  checks: NativeLayerCheck[];
  version: string;
}

const MODULE_NAME = '@llmapi/easytier-node';

/**
 * 组网身份的持久化存储。
 *
 * **必须持久化**：对端会按 `noise_static_pubkey` 钉扎本机身份，重启后换密钥
 * 会让对端认为"这是另一个节点"（或直接拒绝、或留下僵尸条目）。此前身份只
 * 存在进程内存里，重启即变——作为备用实现影响有限，但作为主引擎必须修。
 *
 * 私钥由调用方负责加密落盘（走 `ctx.secrets.encode()`），本类只要求
 * "读得到、写进去"两个动作，不关心存储介质。
 */
export interface NetworkingIdentityStore {
  /** 读已保存的身份；没有则返回 null */
  load(): { peerId: number; staticPrivateKeyBase64: string } | null;
  /** 保存身份 */
  save(identity: { peerId: number; staticPrivateKeyBase64: string }): void;
}

/**
 * 自研引擎的默认监听端口，仅作领域层默认值的镜像（实际用的是
 * `config.listenPort`）。留这个常量是为了让"默认 11011"这件事在运行时有
 * 一处可读的定义，但**不要用它覆盖配置**——端口必须由用户可改。
 */
const BUILTIN_DEFAULT_PORT = 11011;
void BUILTIN_DEFAULT_PORT;

/** 自研引擎的运行实例。 */
interface BuiltinInstance {
  acceptor: EasyTierAcceptor;
  hostname: string;
  ipv4: string | null;
  startedAt: number;
}

export class NetworkingRuntime {
  private module: NativeModule | null = null;
  private loadError: string | null = null;
  private loaded = false;
  /** 自研引擎的实例；null 表示未启动 */
  private builtin: BuiltinInstance | null = null;
  /** 本次启动是否发生过降级（请求的引擎不可用） */
  private degradedFrom: NetworkingEngine | null = null;
  /**
   * 上次 `start()` 失败的原因（键 + 人类可读说明）。
   *
   * 为什么必须记住：`builtin` 引擎最常见的启动失败是**端口被占**——
   * 而单进程内 `NetworkingRuntime` 不是单例，服务重启后新实例既不知道
   * 端口还被上个进程占着、也看不到"上次为什么失败"。用户会看到
   * "没启动 → 点启动 → 又失败"的循环，却没有任何线索。
   */
  private lastStartError: string | null = null;
  /**
   * 当前**实际在跑**的引擎。
   *
   * 不能靠"`this.builtin !== null` 就说明 builtin 在跑"来推断——那是把
   * 实现细节当契约。显式记录还有第二个必要原因：降级后实际引擎与
   * `config.engine` 不一致，`peers()` 必须跟着**实际**引擎走。
   */
  private activeEngine: NetworkingEngine | null = null;
  /**
   * 本机在组网里的稳定身份（peer_id 与 Noise 静态私钥）。
   *
   * **必须持久化在进程级而不是每次启动随机生成**：对端会按
   * `noise_static_pubkey` 钉扎本机身份，每次换密钥会让对端认为
   * "这是另一个节点"（或直接拒绝）。这里用进程内缓存实现"本次运行内稳定"；
   * 跨重启的持久化留给配置层（见 README 的已知边界）。
   */
  private identity: { peerId: number; staticPrivateKey: Buffer } | null = null;

  private readonly logger: Logger;
  private readonly identityStore: NetworkingIdentityStore | null;

  constructor(logger: Logger, identityStore?: NetworkingIdentityStore) {
    this.logger = logger;
    this.identityStore = identityStore ?? null;
  }

  /** 取（或创建）本机稳定的组网身份。 */
  private stableIdentity(): { peerId: number; staticPrivateKey: Buffer } {
    if (this.identity !== null) return this.identity;

    // 优先读已持久化的身份：重启后必须保持同一身份，否则对端的钉扎会失效
    const stored = this.identityStore?.load() ?? null;
    if (stored !== null) {
      const staticPrivateKey = Buffer.from(stored.staticPrivateKeyBase64, 'base64');
      if (staticPrivateKey.length === 32) {
        this.identity = { peerId: stored.peerId, staticPrivateKey };
        return this.identity;
      }
      // 长度不对说明数据被破坏：重新生成而不是崩掉，但要留下日志
      this.logger.warn('组网身份的私钥长度不是 32 字节，已重新生成（对端可能需要重新钉扎）');
    }

    // peer_id 取 32 位随机数并避开 0 与广播地址
    let peerId = 0;
    while (peerId === 0 || peerId === 0xffffffff) {
      peerId = randomBytes(4).readUInt32LE(0);
    }
    // X25519 私钥是 32 字节随机数（clamp 由实现负责）
    const identity = { peerId, staticPrivateKey: randomBytes(32) };
    this.identity = identity;
    this.identityStore?.save({
      peerId: identity.peerId,
      staticPrivateKeyBase64: identity.staticPrivateKey.toString('base64'),
    });
    this.logger.info(`已生成并保存组网身份：peerId=${identity.peerId}`);
    return identity;
  }

  /**
   * 惰性加载原生模块。结果（含失败）会被缓存——反复尝试加载一个不存在的模块
   * 只会拖慢每个请求。
   */
  private load(): NativeModule | null {
    if (this.loaded) return this.module;
    this.loaded = true;

    try {
      // 用 require 而非 import：这是可选依赖，打包器不该把它当成静态依赖去解析，
      // 否则在没有编译原生模块的机器上构建就会失败。
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require(MODULE_NAME) as NativeModule;
      this.module = loaded;
      this.logger.info('EasyTier 原生模块已加载（备用引擎可用）');
    } catch (cause) {
      // 把技术细节留给日志，返回给用户的是可操作的说明
      this.loadError = cause instanceof Error ? cause.message : String(cause);
      this.logger.info(
        `EasyTier 原生模块不可用（备用引擎缺失，自研引擎不受影响）：${this.loadError}`,
      );
      this.module = null;
    }
    return this.module;
  }

  /**
   * 跑一遍原生模块的协议层自检。
   *
   * 返回 `null` 表示原生模块不可用——调用方应当把它当成"无法自检"，
   * 而不是"自检失败"：这两种情况的处置完全不同。
   */
  protocolSelfCheck(): NativeProtocolSelfCheck | null {
    const mod = this.load();
    if (!mod) return null;
    try {
      return mod.protocolSelfCheck();
    } catch (cause) {
      // 自检本身出错也不该让接口 500——它是诊断工具
      this.logger.info(
        `协议自检执行失败：${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return null;
    }
  }

  /**
   * 决定本次用哪个引擎。
   *
   * 自研引擎视为"总是可选"——它没有编译依赖，只有启动失败（端口被占等）
   * 才会真正不可用，而那要 start() 之后才知道。所以这里只在原生模块
   * 缺失时把 `native` 降级到 `builtin`。
   */
  private resolveEngine(requested: NetworkingEngine): {
    engine: NetworkingEngine | null;
    degradedFrom: NetworkingEngine | null;
    reason: string | null;
  } {
    const nativeOk = this.load() !== null;
    if (requested === 'native') {
      if (nativeOk) return { engine: 'native', degradedFrom: null, reason: null };
      return {
        engine: 'builtin',
        degradedFrom: 'native',
        reason:
          '请求的是原生引擎，但原生模块未安装或加载失败，已降级到自研引擎。' +
          '自研引擎不提供 NAT 穿透与端口转发；需要这些能力请先编译 native/easytier-node。',
      };
    }
    // requested === 'builtin'
    return { engine: 'builtin', degradedFrom: null, reason: null };
  }

  availability(requested: NetworkingEngine = 'builtin'): NetworkingAvailability {
    const nativeOk = this.load() !== null;
    const resolved = this.resolveEngine(requested);
    return {
      available: resolved.engine !== null,
      reason: resolved.reason,
      version: null,
      engine: resolved.engine,
      builtinAvailable: true,
      nativeAvailable: nativeOk,
      degradedFrom: resolved.degradedFrom,
    };
  }

  async status(config: NetworkingConfig): Promise<NetworkingStatus> {
    const availability = this.availability(config.engine);
    if (!availability.available) {
      return {
        ...availability,
        enabled: config.enabled,
        running: false,
        virtualIpv4: null,
        peerCount: 0,
        functional: false,
        functionalReason: null,
      };
    }

    if (availability.engine === 'native') {
      return this.nativeStatus(config, availability);
    }
    return this.builtinStatus(config, availability);
  }

  private async nativeStatus(
    config: NetworkingConfig,
    availability: NetworkingAvailability,
  ): Promise<NetworkingStatus> {
    try {
      const status = await this.load()!.nodeStatus();
      const virtualIpv4 = status.virtualIpv4 ?? null;
      // 没有虚拟 IP 说明网卡没建起来——最常见的原因是容器缺 CAP_NET_ADMIN、
      // 或宿主机没有 /dev/net/tun。此时 startNode 是"成功"的、running 也是 true，
      // 但网络实际不存在。必须显式标出来，否则用户会去反复改网络名/密钥。
      const functional = status.running && virtualIpv4 !== null;
      return {
        ...availability,
        enabled: config.enabled,
        running: status.running,
        virtualIpv4,
        peerCount: status.peerCount ?? 0,
        functional,
        functionalReason:
          status.running && !functional
            ? 'EasyTier 已启动但未取得虚拟 IP，说明虚拟网卡没能创建。' +
              '常见原因：容器缺少 CAP_NET_ADMIN 权限，或宿主机没有 /dev/net/tun。' +
              '请用 `--cap-add=NET_ADMIN` 并挂载 /dev/net/tun，或以 root 运行。'
            : null,
      };
    } catch (cause) {
      this.logger.warn('读取 EasyTier 状态失败', cause);
      return {
        ...availability,
        enabled: config.enabled,
        running: false,
        virtualIpv4: null,
        peerCount: 0,
        functional: false,
        functionalReason: null,
      };
    }
  }

  private builtinStatus(
    config: NetworkingConfig,
    availability: NetworkingAvailability,
  ): NetworkingStatus {
    const instance = this.builtin;
    const running = instance !== null;
    const peerCount = instance === null ? 0 : instance.acceptor.connectionCount();
    // 自研引擎**不创建 TUN 设备**，所以"functional"不能按"有虚拟 IP"判。
    // 判据改成"有对端连上了"：它证明握手、加密与 OSPF 全链路都通了。
    // 同时把 `virtualIpv4` 报成本机广播给对端的那个地址（配置里的 ipv4），
    // 因为对端确实靠它把本节点装进路由表。
    const functional = running && peerCount > 0;
    return {
      ...availability,
      enabled: config.enabled,
      running,
      virtualIpv4: instance?.ipv4 ?? null,
      peerCount,
      functional,
      functionalReason:
        running && !functional
          ? '自研引擎已监听，但还没有节点连上。请确认对端填的是本机真实地址与端口，' +
            '并且网络名与密钥一致。'
          : // 没跑起来时把上次的失败原因带上：否则用户只看到 running=false，
            // 完全不知道是端口被占还是配置有问题
            (this.lastStartError ?? null),
    };
  }

  async peers(): Promise<NetworkingPeer[]> {
    // 按**实际在跑**的引擎取，不是按配置：降级后两者可能不一致。
    // 还没启动过时（activeEngine === null）才回退到"谁能用就用谁"，
    // 这样页面在启动前也能展示已有信息。
    const engine = this.activeEngine ?? (this.load() !== null ? 'native' : 'builtin');
    if (engine === 'builtin') {
      if (this.builtin === null) return [];
      return this.builtin.acceptor.connectedPeers().map((peer) => ({
        hostname: peer.hostname ?? `peer-${peer.peerId}`,
        ipv4: peer.ipv4,
        latencyMs: peer.latencyMs,
        tunnel: 'tcp',
      }));
    }
    if (this.load() === null) return [];
    try {
      const list = await this.load()!.listPeers();
      return list.map((item) => ({
        hostname: item.hostname,
        ipv4: item.ipv4 ?? null,
        latencyMs: item.latencyMs ?? null,
        tunnel: item.tunnel ?? null,
      }));
    } catch (cause) {
      this.logger.warn('读取 EasyTier 节点列表失败', cause);
      return [];
    }
  }

  /**
   * 启动组网。
   *
   * 参数校验放在这里而不是只靠前端：网络名为空、密钥为空都会让节点加入失败，
   * 而且失败信息在 EasyTier 侧往往不直观。提前拒绝能给出可操作的提示。
   */
  async start(config: NetworkingConfig): Promise<void> {
    if (config.networkName.trim() === '') throw new Error('网络名不能为空');
    if (config.networkSecret.trim() === '') {
      throw new Error('网络密钥不能为空——知道网络名和密钥的节点都能加入这个网络');
    }

    const resolved = this.resolveEngine(config.engine);
    if (resolved.engine === null) {
      throw new Error(resolved.reason ?? '没有可用的组网引擎');
    }
    this.degradedFrom = resolved.degradedFrom;
    if (resolved.degradedFrom !== null) {
      this.logger.warn(`组网引擎降级：${resolved.degradedFrom} → ${resolved.engine}`, {
        reason: resolved.reason,
      });
    }

    // 密钥不进日志；只记网络名与中继数量，够定位问题又不泄漏门槛
    this.logger.info(
      `启动设备互联：engine=${resolved.engine} network=${config.networkName} ` +
        `peers=${config.peers.length} hostname=${config.hostname}`,
    );

    if (resolved.engine === 'native') {
      // 必须先把自研实例停掉：否则 `this.builtin` 残留，`peers()` 会优先
      // 返回一个已经不该在跑的引擎的数据（切引擎后看到旧对端列表，极易误判）。
      await this.stopBuiltin();
      await this.load()!.startNode({
        networkName: config.networkName,
        networkSecret: config.networkSecret,
        peers: config.peers,
        hostname: config.hostname,
        // null → undefined：见上面 NativeModule.startNode 的说明。
        // 配置层用 null 表示"让 EasyTier 自动分配"，而 napi 只接受省略。
        ...(config.ipv4 === null ? {} : { ipv4: config.ipv4 }),
      });
      this.activeEngine = 'native';
      return;
    }

    // ── 自研引擎 ──
    // 先停掉残留实例，避免端口被自己占着
    await this.stopBuiltin();

    const identity = this.stableIdentity();
    // 监听端口从配置的 ipv4 推不出来，改用固定默认端口（与 native 侧一致）
    const acceptor = new EasyTierAcceptor(
      {
        port: config.listenPort,
        myPeerId: identity.peerId,
        networkName: config.networkName,
        networkSecret: config.networkSecret,
        staticPrivateKey: identity.staticPrivateKey,
        hostname: config.hostname,
        virtualIpv4: config.ipv4 ?? undefined,
        advertiseRoute: true,
      },
      {
        onHandshake: (info) => {
          this.logger.info(`组网对端已连接：peer=${info.remotePeerId}`);
        },
        onOspfAnswered: () => {
          this.logger.info('已应答对端的 OSPF 路由同步');
        },
        onError: (err) => {
          // 单个连接失败不该拖垮整个组网
          this.logger.warn('自研引擎连接出错', err);
        },
        onDataPlaneLog: (message) => {
          this.logger.info(`组网数据面：${message}`);
        },
        // 协议层诊断走 debug 级别：内容是报文片段，正常运行时不该刷屏，
        // 排查时把日志级别调低就能看到——比 stdout.write 可控。
        onProtocolLog: (message) => {
          this.logger.debug(`组网协议：${message}`);
        },
      },
    );

    try {
      await acceptor.start();
      this.lastStartError = null;
    } catch (cause) {
      // 端口被占是最常见的失败：给出可操作的说明，而不是原始 EADDRINUSE
      const err = cause as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        this.lastStartError =
          `自研引擎无法监听端口 ${config.listenPort}：端口已被占用。` +
          `可能是上一个进程还没完全退出，或另一个 EasyTier 实例用了同一端口。` +
          `改配置里的 listenPort 或释放该端口后重试。`;
        throw new Error(this.lastStartError, { cause });
      }
      this.lastStartError = `自研引擎启动失败：${err.message}`;
      // 自研引擎启动失败时尝试原生兜底：端口被占是常见原因，
      // 而原生用随机端口，能绕开。
      const fallback = this.load();
      if (fallback !== null) {
        this.degradedFrom = 'builtin';
        this.logger.warn('自研引擎启动失败，降级到原生引擎', cause);
        await fallback.startNode({
          networkName: config.networkName,
          networkSecret: config.networkSecret,
          peers: config.peers,
          hostname: config.hostname,
          ...(config.ipv4 === null ? {} : { ipv4: config.ipv4 }),
        });
        this.activeEngine = 'native';
        return;
      }
      throw cause;
    }

    // 数据面：把虚拟 IP 上的端口桥接到本机真实端口。
    // 没有它，对端"连得上虚拟 IP"却没有任何服务可达——控制面通、数据面不通。
    // 数据面：把虚拟 IP 上的端口桥接到本机真实端口。
    //
    // 需要虚拟 IP 作为回包源地址。**默认配置里 ipv4 是 null**（让对端自动分配），
    // 那种情况下不能开数据面——但我们也不该让整个组网启动失败：
    // 控制面（互相发现、路由同步）仍然有价值。所以这里降级为"只开控制面"
    // 并明确告警，而不是抛错或静默失效。
    if (config.portForwards.length > 0) {
      if (config.ipv4 === null) {
        this.logger.warn(
          '组网数据面未启用：需要在配置里指定本机虚拟 IP（networking.ipv4）。' +
            '没有它无法作为回包源地址，对端会丢弃数据。控制面（节点发现与路由同步）不受影响。',
        );
      } else {
        acceptor.enableDataPlane(config.portForwards);
        this.logger.info(
          `组网数据面已启用：${config.portForwards
            .map((f) => `${f.virtualPort}→127.0.0.1:${f.localPort}`)
            .join(', ')}`,
        );
      }
    }

    this.builtin = {
      acceptor,
      hostname: config.hostname,
      ipv4: config.ipv4,
      startedAt: Date.now(),
    };
    this.activeEngine = 'builtin';
  }

  private async stopBuiltin(): Promise<void> {
    const instance = this.builtin;
    if (instance === null) return;
    this.builtin = null;
    try {
      await instance.acceptor.close();
    } catch (cause) {
      this.logger.warn('关闭自研引擎时出错（已忽略）', cause);
    }
  }

  async stop(): Promise<void> {
    this.logger.info('停止设备互联');
    await this.stopBuiltin();
    if (this.load() !== null) {
      await this.load()!.stopNode();
    }
    this.degradedFrom = null;
    this.activeEngine = null;
    this.lastStartError = null;
  }

  /** 本次运行是否发生过引擎降级。 */
  degradedEngine(): NetworkingEngine | null {
    return this.degradedFrom;
  }
}
