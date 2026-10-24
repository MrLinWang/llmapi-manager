import type { Logger } from '../logger';
import type {
  NetworkingAvailability,
  NetworkingConfig,
  NetworkingPeer,
  NetworkingStatus,
} from '../domain/networking';

/**
 * EasyTier 原生模块的加载与调用封装。
 *
 * 为什么要有这一层：原生模块是**可选**的（需要 Rust 工具链编译，Windows 还要
 * wintun.dll）。本仓库的默认安装路径里它并不存在，所以任何对它的引用都必须
 * 能优雅降级——同步功能本身不依赖组网，没编译原生模块时应该照常可用。
 *
 * 三条约束：
 * 1. **不在模块顶层 `require`**：顶层 require 失败会让整个服务起不来。
 *    改成首次使用时惰性加载并缓存结果。
 * 2. **错误不外泄内部细节**：用户只需要知道"没编译/装不上"，不需要 Rust 栈。
 *    详细原因进日志。
 * 3. **`networkSecret` 不落日志**：它是网络的准入门槛。
 */

/** 原生模块的接口形状，与 `native/easytier-node/src/lib.rs` 的导出保持一致。 */
interface NativeModule {
  startNode(options: {
    networkName: string;
    networkSecret: string;
    peers: string[];
    hostname: string;
    ipv4?: string | null;
  }): Promise<void>;
  stopNode(): Promise<void>;
  nodeStatus(): Promise<{ running: boolean; virtualIpv4?: string | null; peerCount: number }>;
  listPeers(): Promise<
    Array<{ hostname: string; ipv4?: string | null; latencyMs?: number | null; tunnel?: string | null }>
  >;
}

const MODULE_NAME = '@llmapi/easytier-node';

export class NetworkingRuntime {
  private module: NativeModule | null = null;
  private loadError: string | null = null;
  private loaded = false;

  constructor(private readonly logger: Logger) {}

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
      this.logger.info('EasyTier 原生模块已加载，设备互联功能可用');
    } catch (cause) {
      // 把技术细节留给日志，返回给用户的是可操作的说明
      this.loadError = cause instanceof Error ? cause.message : String(cause);
      this.logger.info(
        `EasyTier 原生模块不可用（设备互联将降级为"仅同步"）：${this.loadError}`,
      );
      this.module = null;
    }
    return this.module;
  }

  availability(): NetworkingAvailability {
    const mod = this.load();
    if (mod) {
      return { available: true, reason: null, version: null };
    }
    return {
      available: false,
      reason:
        '原生模块未安装或加载失败。设备互联需要先编译 native/easytier-node ' +
        '（需要 Rust 工具链）。配置同步功能不受影响，可以手动填写 master 地址。',
      version: null,
    };
  }

  async status(config: NetworkingConfig): Promise<NetworkingStatus> {
    const availability = this.availability();
    if (!availability.available) {
      return {
        ...availability,
        enabled: config.enabled,
        running: false,
        virtualIpv4: null,
        peerCount: 0,
      };
    }

    try {
      const status = await this.load()!.nodeStatus();
      return {
        ...availability,
        enabled: config.enabled,
        running: status.running,
        virtualIpv4: status.virtualIpv4 ?? null,
        peerCount: status.peerCount ?? 0,
      };
    } catch (cause) {
      this.logger.warn('读取 EasyTier 状态失败', cause);
      return {
        ...availability,
        enabled: config.enabled,
        running: false,
        virtualIpv4: null,
        peerCount: 0,
      };
    }
  }

  async peers(): Promise<NetworkingPeer[]> {
    if (!this.availability().available) return [];
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
    const availability = this.availability();
    if (!availability.available) {
      throw new Error(availability.reason ?? '原生模块不可用');
    }
    if (config.networkName.trim() === '') throw new Error('网络名不能为空');
    if (config.networkSecret.trim() === '') {
      throw new Error('网络密钥不能为空——知道网络名和密钥的节点都能加入这个网络');
    }

    // 密钥不进日志；只记网络名与中继数量，够定位问题又不泄漏门槛
    this.logger.info(
      `启动设备互联：network=${config.networkName} peers=${config.peers.length} ` +
        `hostname=${config.hostname}`,
    );

    await this.load()!.startNode({
      networkName: config.networkName,
      networkSecret: config.networkSecret,
      peers: config.peers,
      hostname: config.hostname,
      ipv4: config.ipv4,
    });
  }

  async stop(): Promise<void> {
    if (!this.availability().available) return;
    this.logger.info('停止设备互联');
    await this.load()!.stopNode();
  }
}
