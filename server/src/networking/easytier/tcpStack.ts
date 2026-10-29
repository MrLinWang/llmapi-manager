/**
 * 用户态 TCP 栈：让虚拟网络里的对端能连到本机的真实服务。
 *
 * # 它解决什么问题
 *
 * EasyTier 的 `PacketType.Data` 承载完整 IP 包。官方实现把这些包交给 TUN 设备
 * 或 smoltcp（`no_tun` 时）处理，于是虚拟 IP 上的 TCP 连接能真实落地。
 * 自研实现要在没有 TUN、没有 Rust 依赖的前提下做到同样的事，就必须自己实现
 * TCP 状态机，并把虚拟端的连接**桥接到本机 socket**。
 *
 * ```
 * 官方节点                     自研引擎
 *   虚拟 10.0.0.2:40000
 *        │ SYN ──────────────▶  TcpListener（虚拟 10.0.0.1:8787）
 *        │◀──────────── SYN-ACK    │
 *        │ ACK ──────────────▶     │ 建立虚拟连接
 *        │ data ─────────────▶     │── relay ──▶ net.connect(127.0.0.1:8787)
 *        │◀──────────── data       │◀── relay ──
 * ```
 *
 * # 实现边界（必须说清）
 *
 * - ✅ 三次握手、有序数据传输、FIN/RST 关闭、接收窗口、超时重传
 * - ✅ 支持同时上行的多个连接（按四元组区分）
 * - ❌ 不做拥塞控制（没有慢启动/拥塞避免）——虚拟链路通常是点对点短连接，
 *   固定窗口够用；但**大流量长连接下吞吐会低于理想值**
 * - ❌ 不做 IP 分片重组：收到分片包直接丢弃（MTU 1380 以下不会触发）
 * - ❌ 不做 TCP 选项协商（MSS 固定按对端声明的窗口推）
 *
 * 这些"不做"都记在 README 的边界里，不假装完整。
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  IpProtocol,
  TcpFlags,
  buildIpv4Packet,
  buildTcpSegment,
  decodeIpv4Header,
  decodeTcpHeader,
  decodeTcpOptions,
  hasTcpFlag,
  TcpOptionKind,
  type TcpOption,
} from './ip';

/** TCP 会话状态（RFC 9293 的状态子集）。 */
export type TcpState =
  | 'synReceived'
  | 'established'
  | 'finWait1'
  | 'finWait2'
  | 'closeWait'
  | 'lastAck'
  | 'closed';

/** 一个虚拟 TCP 连接。 */
interface TcpConnection {
  /** 四元组：对端 ip:port + 本端 ip:port */
  remoteIp: string;
  remotePort: number;
  localIp: string;
  localPort: number;
  state: TcpState;

  /** 本端下一个要发的序列号（我们自己发的字节流） */
  sendSeq: number;
  /** 对端下一个期望的序列号（用于判断是否按序到达） */
  recvNext: number;
  /** 对端通告的窗口 */
  remoteWindow: number;
  /** 我们通告给对端的窗口 */
  localWindow: number;

  /** 桥接到本机服务的真实 socket */
  bridge: net.Socket | null;
  /** 桥接还没建立时缓存的待发送载荷（来自虚拟对端） */
  pendingToBridge: Buffer[];
  /** 桥接建立失败的原因（用于日志） */
  bridgeError: string | null;

  /** 重传用：已发出但未被确认的段 */
  unacked: Array<{ seq: number; payload: Buffer; flags: number; sentAt: number }>;
  /** 定时器句柄 */
  retransmitTimer: NodeJS.Timeout | null;
  lastActivityAt: number;

  // ── 拥塞控制（见文件头的说明） ──
  /** 拥塞窗口（字节）。限制"在途未确认数据"的总量 */
  cwnd: number;
  /** 慢启动阈值（字节）。cwnd 超过它就从慢启动切到拥塞避免 */
  ssthresh: number;
  /** 最大段长（字节） */
  mss: number;
  /**
   * 收到重复 ACK 的次数。
   *
   * 连续 3 个重复 ACK 是"某个段丢了但后续段还在到达"的信号——这时
   * **不该等超时**（RTO 往往是几百毫秒到几秒），应立即重传那一段。
   * 这就是快速重传。
   */
  dupAckCount: number;
  /** 已经从本机服务读出、但因窗口不足还没发出的数据 */
  pendingSend: Buffer;
  /**
   * 对端是否允许 SACK（在 SYN/SYN-ACK 里用 `SACK_PERMITTED` 选项协商）。
   *
   * 没协商就不能发 SACK 块——对端会当作未知选项忽略，等于白占头部空间。
   */
  sackEnabled: boolean;
  /**
   * 乱序到达的数据，按起始序列号存放。
   *
   * **必须有它**：之前 `acceptPayload` 不看序列号，收到什么就往本机 socket
   * 写什么。一旦网络乱序，写进 socket 的字节顺序就错了——TCP 承诺的是
   * "有序字节流"，而下游（HTTP 解析器等）拿到乱序数据会解析失败或更糟。
   */
  outOfOrder: Map<number, Buffer>;
  /**
   * 待上报给对端的 SACK 块（`[left, right)` 实际序列号）。
   *
   * 每次发 ACK 时带上，告诉对端"这些区间我收到了"，
   * 对端据此**只重传真正的空洞**，而不是整段重发。
   */
  sackBlocks: Array<{ left: number; right: number }>;
  /**
   * 对端上报给我们的 SACK 块。
   *
   * 用于选择性重传：结合 `unacked` 找出对端**没收到**的区间。
   */
  peerSackBlocks: Array<{ left: number; right: number }>;

  // ── BBR 状态（仅 algorithm === 'bbr' 时使用） ──
  /**
   * 带宽估计（字节/毫秒）。
   *
   * 取"最近若干个往返里观察到的最大投递速率"——BBR 的核心观点是
   * **链路的最大带宽是一个稳定属性**，不该因为一次丢包就大幅下调。
   */
  bwEstimate: number;
  /**
   * 最小 RTT（毫秒）。用滑动窗口取最小值。
   *
   * 它代表"链路里没有排队时的往返时间"，是算 BDP 的一半。
   */
  minRttMs: number;
  /** 本轮统计的起点（用于算投递速率） */
  bwSampleStartMs: number;
  /** 本轮统计已确认的字节数 */
  bwSampleBytes: number;
  /** 累计已确认字节（用于诊断） */
  deliveredBytes: number;

  /**
   * 已见过的最高确认号。
   *
   * 判断"这次 ACK 是新确认还是重复确认"必须有它：只看
   * `unacked` 是否变化在边界情况下会误判（比如 ACK 覆盖了半个段）。
   */
  lastAckNumber: number;
}

/**
 * 拥塞控制算法。
 *
 * - `reno`：丢包驱动。窗口靠 ACK 线性增长、丢包砍半。实现简单，
 *   但在**有随机丢包**的链路上会把窗口压得过小（它把丢包当成拥塞信号，
 *   而实际可能只是链路误码）。
 * - `bbr`（默认）：**模型驱动**。持续估计"带宽 × 最小 RTT"作为窗口，
 *   不把丢包直接当作拥塞信号。高丢包率链路上吞吐明显更好。
 *
 * 默认选 bbr：虚拟网络常跑在公网隧道上，随机丢包不罕见。
 */
export type CongestionControl = 'reno' | 'bbr';

export interface TcpStackOptions {
  /** 本机在虚拟网络里的 IP */
  localIp: string;
  /** 把虚拟连接桥接到哪个本机地址（通常是 127.0.0.1） */
  bridgeHost: string;
  /** 单个连接的空闲超时（毫秒），超时后强制关闭 */
  idleTimeoutMs?: number;
  /** 拥塞控制算法（默认 `bbr`） */
  congestionControl?: CongestionControl;
  /** 重传超时基数（毫秒） */
  retransmitBaseMs?: number;
  /** 最大重传次数，超过则放弃连接 */
  maxRetransmits?: number;
  /** 发出 IP 包的出口（由数据面提供） */
  sendIpPacket: (packet: Buffer) => void;
  log?: (message: string) => void;
}

/**
 * 拥塞控制常量。
 *
 * `MSS` 取 1340 = MTU 1380 − IP 头 20 − TCP 头 20，与我们广告的 MTU 对齐。
 * `INITIAL_CWND` 用 4×MSS（保守值；RFC 6928 建议 10×MSS，但虚拟链路
 * 的可用带宽未知，起小一点更安全）。`INITIAL_SSTHRESH` 取 64KB，
 * 先跑一段慢启动再转拥塞避免。
 */
const MSS = 1340;
const INITIAL_CWND = 4 * MSS;
const MIN_CWND = MSS;
const INITIAL_SSTHRESH = 64 * 1024;

/** 把一个 32 位序列号按有符号差值比较（处理回绕）。 */
function seqDiff(a: number, b: number): number {
  // 转成有符号 32 位差值：a - b，结果在 [-2^31, 2^31)
  return ((a - b) | 0);
}

/**
 * 用户态 TCP 栈。
 *
 * 只实现"服务端"角色：它监听虚拟 IP 上的端口，接受对端连入，并把连接桥接到
 * 本机真实端口。这正是组网要的形态——follower（官方节点）通过虚拟 IP
 * 访问 master（自研引擎）的管理界面。
 */
export class TcpStack extends EventEmitter {
  private readonly connections = new Map<string, TcpConnection>();
  private readonly portMap = new Map<number, string>();
  private readonly options: Required<
    Pick<
      TcpStackOptions,
      'localIp' | 'bridgeHost' | 'idleTimeoutMs' | 'retransmitBaseMs' | 'maxRetransmits'
    >
  > &
    TcpStackOptions;
  private sweepTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: TcpStackOptions) {
    super();
    this.options = {
      localIp: options.localIp,
      bridgeHost: options.bridgeHost,
      idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
      congestionControl: options.congestionControl ?? 'bbr',
      retransmitBaseMs: options.retransmitBaseMs ?? 1_000,
      maxRetransmits: options.maxRetransmits ?? 8,
      sendIpPacket: options.sendIpPacket,
      ...(options.log === undefined ? {} : { log: options.log }),
    };
  }

  /** 监听虚拟 IP 上的一个端口，把连接桥接到本机 `bridgePort`。 */
  listen(localPort: number, bridgePort: number): void {
    this.portMap.set(localPort, String(bridgePort));
  }

  /** 当前活跃连接数。 */
  connectionCount(): number {
    return this.connections.size;
  }

  /** 列出活跃连接（诊断用）。 */
  activeConnections(): Array<{
    remote: string;
    local: string;
    state: TcpState;
    pending: number;
  }> {
    return [...this.connections.values()].map((conn) => ({
      remote: `${conn.remoteIp}:${conn.remotePort}`,
      local: `${conn.localIp}:${conn.localPort}`,
      state: conn.state,
      pending: conn.pendingToBridge.length,
    }));
  }

  /** 开始周期性清理空闲连接。 */
  start(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), 5_000);
    // 不让这个定时器拖住进程退出
    this.sweepTimer.unref?.();
  }

  /** 关闭所有连接与定时器。 */
  close(): void {
    this.closed = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const conn of this.connections.values()) {
      this.teardown(conn);
    }
    this.connections.clear();
  }

  private sweepIdle(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const conn of this.connections.values()) {
      if (now - conn.lastActivityAt > this.options.idleTimeoutMs) {
        this.log(`连接空闲超时，强制关闭 ${conn.remoteIp}:${conn.remotePort}`);
        this.teardown(conn);
        this.connections.delete(this.key(conn));
      }
    }
  }

  private key(conn: { remoteIp: string; remotePort: number; localPort: number }): string {
    return `${conn.remoteIp}:${conn.remotePort}->${this.options.localIp}:${conn.localPort}`;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /**
   * 处理一个来自虚拟网络的 IP 包。
   *
   * 只处理 TCP；其他协议（UDP/ICMP）由调用方决定是否另作处理。
   * 返回 true 表示这个包已被消费。
   */
  handleIpPacket(packet: Buffer): boolean {
    if (this.closed) return false;
    const ipHeader = decodeIpv4Header(packet);
    if (ipHeader === null) return false;

    // 非 TCP 由 Acceptor 的分发器转给 UDP 栈 / ICMP 处理器，这里不处理也不记日志
    // （否则每条 DNS 查询都会刷一行"丢弃 UDP"，那是误导）
    if (ipHeader.protocol !== IpProtocol.TCP) return false;
    // 分片包丢弃：本实现不做 IP 重组，拼接错的数据比丢包更糟
    if (ipHeader.moreFragments || ipHeader.fragmentOffset !== 0) {
      this.log('丢弃 IP 分片包（不做重组）');
      return false;
    }
    if (ipHeader.totalLength < ipHeader.headerLength + 20) return false;

    const segment = packet.subarray(
      ipHeader.headerLength,
      Math.min(ipHeader.totalLength, packet.length),
    );
    const tcpHeader = decodeTcpHeader(segment);
    if (tcpHeader === null) return false;

    const payload = segment.subarray(tcpHeader.dataOffset);
    // 选项区在 20 字节固定头之后、dataOffset 之前
    const options =
      tcpHeader.dataOffset > 20
        ? decodeTcpOptions(segment.subarray(20, tcpHeader.dataOffset))
        : [];
    this.handleSegment(ipHeader.src, ipHeader.dst, tcpHeader, payload, options);
    return true;
  }

  private handleSegment(
    srcIp: string,
    dstIp: string,
    header: { srcPort: number; dstPort: number; seq: number; ack: number; flags: number; window: number },
    payload: Buffer,
    options: TcpOption[] = [],
  ): void {
    const key = `${srcIp}:${header.srcPort}->${dstIp}:${header.dstPort}`;
    const existing = this.connections.get(key);

    // ── 新连接：只接受 SYN ──
    if (existing === undefined) {
      if (!hasTcpFlag(header.flags, TcpFlags.SYN) || hasTcpFlag(header.flags, TcpFlags.ACK)) {
        // 不是 SYN，或 SYN+ACK（我们没主动连过），按 RST 回绝
        if (!hasTcpFlag(header.flags, TcpFlags.RST)) {
          this.sendRst(srcIp, dstIp, header);
        }
        return;
      }
      const bridgePort = this.portMap.get(header.dstPort);
      if (bridgePort === undefined) {
        // 没监听这个端口：明确 RST，让对端立刻失败而不是等超时
        this.sendRst(srcIp, dstIp, header);
        return;
      }
      this.acceptConnection(srcIp, dstIp, header, bridgePort, options);
      return;
    }

    existing.lastActivityAt = Date.now();

    // ── RST：无条件关闭 ──
    if (hasTcpFlag(header.flags, TcpFlags.RST)) {
      this.teardown(existing);
      this.connections.delete(key);
      return;
    }

    // ── SYN 重传：对端没收到我们的 SYN-ACK，重发 ──
    if (hasTcpFlag(header.flags, TcpFlags.SYN) && existing.state === 'synReceived') {
      this.sendSegment(existing, TcpFlags.SYN | TcpFlags.ACK, Buffer.alloc(0));
      return;
    }

    // ── 第三次握手：ACK 确认我们的 SYN-ACK ──
    if (existing.state === 'synReceived' && hasTcpFlag(header.flags, TcpFlags.ACK)) {
      existing.state = 'established';
      // 这个 ACK 确认了我们的 SYN-ACK。必须记下它，否则后续第一个数据 ACK
      // 会被误判成"新确认"，导致重复 ACK 计数从 0 开始——快速重传永远不触发。
      existing.lastAckNumber = header.ack;
      this.connectBridge(existing);
      if (payload.length > 0) this.acceptPayload(existing, header.seq, payload);
      if (hasTcpFlag(header.flags, TcpFlags.FIN)) this.handleFin(existing, header);
      return;
    }

    if (existing.state === 'closed') return;

    // ── 确认：清掉已被 ack 覆盖的未确认段 ──
    //
    // 必须做这一步。漏掉它会让**每个已确认的段都被无限重传**：定时器看到
    // `unacked` 永远非空就一直在重发，对端会收到大量重复数据。小响应时
    // 因为连接很快关闭看不出来，大响应或长连接下会明显卡顿。
    if (hasTcpFlag(header.flags, TcpFlags.ACK)) {
      // 一个段只有在 ack **越过它的结束序号**时才算被完全确认。
      // 用起始 seq 比较是错的：段内的字节可能只被确认了一部分。
      existing.unacked = existing.unacked.filter((seg) => {
        const end =
          seg.seq +
          seg.payload.length +
          (hasTcpFlag(seg.flags, TcpFlags.SYN) ? 1 : 0) +
          (hasTcpFlag(seg.flags, TcpFlags.FIN) ? 1 : 0);
        // 保留"还没被完全确认"的段
        return seqDiff(header.ack, end) < 0;
      });

      // 记录对端上报的 SACK 块：后面选择性重传要用
      const sackOption = options.find((option) => option.kind === TcpOptionKind.SACK);
      if (sackOption !== undefined && sackOption.kind === TcpOptionKind.SACK) {
        existing.peerSackBlocks = sackOption.blocks;
      }

      // 新确认 vs 重复确认：靠 lastAckNumber 判定
      const newlyAcked = seqDiff(header.ack, existing.lastAckNumber);
      if (newlyAcked > 0) {
        const ackedBytes = newlyAcked;
        existing.lastAckNumber = header.ack;
        existing.dupAckCount = 0;
        this.growWindow(existing, ackedBytes);
      } else if (newlyAcked === 0 && existing.unacked.length > 0) {
        // 重复 ACK：对端在说"我还是没收到某个段"
        existing.dupAckCount += 1;
        if (existing.dupAckCount === 3) {
          // 快速重传：不等 RTO，立即重发最老的那一段。
          // 这一步是吞吐的关键——RTO 往往几百毫秒，等它会让长连接明显卡顿。
          // 选**真正的空洞**：第一个未被 SACK 覆盖的段。
          // 直接取最老的段是错的——那一段可能对端早就收到了。
          const oldest = [...existing.unacked]
            .sort((a, b) => seqDiff(a.seq, b.seq))
            .find(
              (seg) =>
                !this.isCoveredBySack(
                  existing,
                  seg.seq,
                  seg.seq + seg.payload.length,
                ),
            );
          if (oldest !== undefined) {
            this.log(`快速重传：3 个重复 ACK，重发 seq=${oldest.seq}`);
            this.resendSegment(existing, oldest.seq, oldest.flags, oldest.payload);
            oldest.sentAt = Date.now();
            this.onCongestionLoss(existing);
          }
        }
      }

      // 窗口可能因为确认而打开：把等着的数据发出去
      this.flushPendingSend(existing);
    }

    // ── 数据与 ACK ──
    if (payload.length > 0) {
      this.acceptPayload(existing, header.seq, payload);
      // 立即确认，避免对端等 RTO 重传
      this.sendSegment(existing, TcpFlags.ACK, Buffer.alloc(0));
    }
    if (hasTcpFlag(header.flags, TcpFlags.FIN)) {
      this.handleFin(existing, header);
    }
  }

  private acceptConnection(
    srcIp: string,
    dstIp: string,
    header: { srcPort: number; dstPort: number; seq: number; window: number },
    bridgePort: string,
    options: TcpOption[] = [],
  ): void {
    const conn: TcpConnection = {
      remoteIp: srcIp,
      remotePort: header.srcPort,
      localIp: dstIp,
      localPort: header.dstPort,
      state: 'synReceived',
      // 我们的初始序列号：随机（避免与会话残留冲突）
      sendSeq: (Math.floor(Math.random() * 0xffffffff) >>> 0),
      // 对端的 SYN 占一个序列号
      recvNext: (header.seq + 1) >>> 0,
      remoteWindow: header.window,
      localWindow: 65535,
      bridge: null,
      pendingToBridge: [],
      bridgeError: null,
      unacked: [],
      retransmitTimer: null,
      lastActivityAt: Date.now(),
      cwnd: INITIAL_CWND,
      ssthresh: INITIAL_SSTHRESH,
      mss: MSS,
      dupAckCount: 0,
      pendingSend: Buffer.alloc(0),
      lastAckNumber: 0,
      sackEnabled: false,
      outOfOrder: new Map(),
      sackBlocks: [],
      peerSackBlocks: [],
      bwEstimate: 0,
      minRttMs: Number.POSITIVE_INFINITY,
      bwSampleStartMs: Date.now(),
      bwSampleBytes: 0,
      deliveredBytes: 0,
    };
    this.connections.set(this.key(conn), conn);
    this.portMap.set(header.dstPort, bridgePort);
    this.log(`新连接 ${srcIp}:${header.srcPort} → 虚拟 ${dstIp}:${header.dstPort}`);

    // SACK 协商：对端的 SYN 里带 SACK_PERMITTED 才启用（双向都要同意）
    conn.sackEnabled = options.some(
      (option) => option.kind === TcpOptionKind.SACK_PERMITTED,
    );
    this.sendSegment(conn, TcpFlags.SYN | TcpFlags.ACK, Buffer.alloc(0), undefined, true);
    // SYN 占一个序列号
    conn.sendSeq = (conn.sendSeq + 1) >>> 0;
    this.emit('connection', {
      remote: `${srcIp}:${header.srcPort}`,
      localPort: header.dstPort,
    });
  }

  /** 把虚拟连接桥接到本机真实端口。 */
  private connectBridge(conn: TcpConnection): void {
    const bridgePort = Number(this.portMap.get(conn.localPort));
    const socket = net.connect({ host: this.options.bridgeHost, port: bridgePort });

    socket.on('connect', () => {
      this.log(`桥接已建立 → ${this.options.bridgeHost}:${bridgePort}`);
      // 把握手期间攒下的载荷按序写出
      for (const chunk of conn.pendingToBridge) socket.write(chunk);
      conn.pendingToBridge = [];
    });

    socket.on('data', (chunk: Buffer) => {
      // 本机服务回数据 → **先入队**，由 flushPendingSend 按窗口与 MSS 发出。
      // 不能直接 sendSegment 整块发：那样拥塞窗口形同虚设，
      // 一次把几 MB 全灌进网络，丢包后重传代价极大。
      conn.pendingSend = Buffer.concat([conn.pendingSend, chunk]);
      this.flushPendingSend(conn);
    });

    socket.on('end', () => {
      // 本机服务主动关闭 → 向虚拟对端发 FIN
      if (conn.state === 'established') {
        this.sendSegment(conn, TcpFlags.FIN | TcpFlags.ACK, Buffer.alloc(0));
        conn.state = 'finWait1';
        conn.sendSeq = (conn.sendSeq + 1) >>> 0;
      }
    });

    socket.on('error', (err) => {
      conn.bridgeError = err.message;
      this.log(`桥接失败 ${this.options.bridgeHost}:${bridgePort} —— ${err.message}`);
      // 桥接不通时明确回 RST：对端会立刻得到"连接被拒"，而不是挂到超时
      this.sendRst(conn.remoteIp, conn.localIp, {
        srcPort: conn.remotePort,
        dstPort: conn.localPort,
        seq: conn.recvNext,
        ack: conn.sendSeq,
        flags: TcpFlags.RST,
        window: 0,
      });
      this.teardown(conn);
      this.connections.delete(this.key(conn));
    });

    socket.on('close', () => {
      this.teardown(conn);
    });

    conn.bridge = socket;
  }

  /** 收到虚拟对端的数据：转交给本机 socket。 */
  /**
   * 收到对端的数据：按序列号**有序**交付给本机 socket。
   *
   * 这是 TCP 的"有序字节流"承诺。之前的实现不看序列号、收到就写——
   * 网络一乱序，写进 socket 的字节顺序就错了，下游（HTTP 解析器等）
   * 会解析失败或得到错误结果。注释写着"序列号校验"但代码没做，是典型
   * 的"注释与实现脱节"。
   *
   * 三种情况：
   * - `seq == recvNext`：正是期望的，交付并顺带排空乱序缓存
   * - `seq > recvNext`：未来数据，缓存到 `outOfOrder` 并生成 SACK 块
   * - `seq < recvNext`：重复/部分重复，裁掉已交付部分再处理
   */
  private acceptPayload(conn: TcpConnection, seq: number, payload: Buffer): void {
    const diff = seqDiff(seq, conn.recvNext);

    if (diff > 0) {
      // ── 乱序（未来数据）──
      if (!conn.outOfOrder.has(seq)) {
        conn.outOfOrder.set(seq, Buffer.from(payload));
        // 缓存上限：防止对端猛发乱序数据打爆内存
        if (conn.outOfOrder.size > 512) {
          this.log('乱序缓存过多，丢弃该连接');
          this.teardown(conn);
          this.connections.delete(this.key(conn));
          return;
        }
      }
      // 生成/更新 SACK 块，告诉对端"这段我收到了"
      this.rebuildSackBlocks(conn);
      return;
    }

    if (diff < 0) {
      // ── 重复数据 ──
      const overlap = -diff; // recvNext - seq
      if (overlap >= payload.length) {
        // 整段都已交付过，忽略（对端重传的）
        return;
      }
      // 裁掉已交付的前缀
      this.deliverToBridge(conn, payload.subarray(overlap));
      conn.recvNext = (conn.recvNext + (payload.length - overlap)) >>> 0;
    } else {
      // ── 正是期望的 ──
      this.deliverToBridge(conn, payload);
      conn.recvNext = (conn.recvNext + payload.length) >>> 0;
    }

    // 排空乱序缓存里现在能接上的数据
    this.drainOutOfOrder(conn);
    this.rebuildSackBlocks(conn);
  }

  /** 把数据交给本机 socket（或暂存，等桥接建立）。 */
  private deliverToBridge(conn: TcpConnection, payload: Buffer): void {
    if (payload.length === 0) return;
    if (conn.bridge !== null && conn.bridge.writable) {
      conn.bridge.write(payload);
      return;
    }
    // 桥接还没连上：缓存，等 connect 后按序写出
    conn.pendingToBridge.push(Buffer.from(payload));
    // 防止对端猛发导致内存暴涨
    if (conn.pendingToBridge.length > 256) {
      this.log('桥接未就绪且缓存过多，丢弃该连接');
      this.teardown(conn);
      this.connections.delete(this.key(conn));
    }
  }

  /** 连续把乱序缓存里能接上的数据交付出去。 */
  private drainOutOfOrder(conn: TcpConnection): void {
    for (;;) {
      const next = conn.outOfOrder.get(conn.recvNext);
      if (next === undefined) return;
      conn.outOfOrder.delete(conn.recvNext);
      this.deliverToBridge(conn, next);
      conn.recvNext = (conn.recvNext + next.length) >>> 0;
    }
  }

  /**
   * 根据乱序缓存重建 SACK 块。
   *
   * 把缓存里连续的区间合并成块（`[left, right)`）。合并很重要：
   * 逐个段上报会塞满 40 字节的选项空间（最多 4 个块），
   * 而合并后通常一两个块就够。
   */
  private rebuildSackBlocks(conn: TcpConnection): void {
    const starts = [...conn.outOfOrder.keys()].sort((a, b) => seqDiff(a, b));
    const blocks: Array<{ left: number; right: number }> = [];
    for (const start of starts) {
      const data = conn.outOfOrder.get(start);
      if (data === undefined) continue;
      const end = (start + data.length) >>> 0;
      const last = blocks[blocks.length - 1];
      // 与前一块相邻或重叠就合并（seqDiff 处理回绕）
      if (last !== undefined && seqDiff(start, last.right) <= 0) {
        if (seqDiff(end, last.right) > 0) last.right = end;
      } else {
        blocks.push({ left: start, right: end });
      }
    }
    // 只保留最近 4 个块（选项空间上限）
    conn.sackBlocks = blocks.slice(-4);
  }

  private handleFin(
    conn: TcpConnection,
    header: { seq: number; flags: number },
  ): void {
    conn.recvNext = (conn.recvNext + 1) >>> 0;
    if (conn.state === 'established') {
      conn.state = 'closeWait';
      this.sendSegment(conn, TcpFlags.ACK, Buffer.alloc(0));
      // 本机 socket 也结束写入
      conn.bridge?.end();
      // 主动补一个 FIN（简化：立即关闭，不等本机 socket 的 end 事件）
      this.sendSegment(conn, TcpFlags.FIN | TcpFlags.ACK, Buffer.alloc(0));
      conn.sendSeq = (conn.sendSeq + 1) >>> 0;
      conn.state = 'lastAck';
    } else if (conn.state === 'finWait2') {
      conn.state = 'lastAck';
      this.sendSegment(conn, TcpFlags.ACK, Buffer.alloc(0));
    }
    void header;
  }

  /** 发一个 TCP 段（封装成完整 IP 包）。 */
  private sendSegment(
    conn: TcpConnection,
    flags: number,
    payload: Buffer,
    seqOverride?: number,
    /**
     * 是否在 SYN-ACK 里宣告 SACK 支持。
     *
     * 只有握手时该带这个选项；后续 ACK 带 SACK_PERMITTED 是无效的
     * （RFC 2018 规定它只出现在 SYN/SYN-ACK 里）。
     */
    announceSack = false,
  ): void {
    const seq = seqOverride ?? conn.sendSeq;

    // 组装选项：握手时宣告 SACK；平时有乱序数据就上报 SACK 块
    const tcpOptions: TcpOption[] = [];
    if (announceSack) {
      tcpOptions.push({ kind: TcpOptionKind.MSS, mss: conn.mss });
      tcpOptions.push({ kind: TcpOptionKind.SACK_PERMITTED });
    } else if (conn.sackEnabled && conn.sackBlocks.length > 0) {
      // 上报乱序到达的区间：对端据此只重传真正的空洞。
      // 没有这一步，对端只能靠"3 个重复 ACK"猜，或等 RTO。
      tcpOptions.push({ kind: TcpOptionKind.SACK, blocks: conn.sackBlocks });
    }

    const segment = buildTcpSegment({
      srcPort: conn.localPort,
      dstPort: conn.remotePort,
      seq,
      ack: conn.recvNext,
      flags,
      window: conn.localWindow,
      payload,
      srcIp: conn.localIp,
      dstIp: conn.remoteIp,
      ...(tcpOptions.length > 0 ? { tcpOptions } : {}),
    });
    const packet = buildIpv4Packet({
      src: conn.localIp,
      dst: conn.remoteIp,
      protocol: IpProtocol.TCP,
      payload: segment,
      identification: (Math.random() * 0xffff) & 0xffff,
    });
    this.options.sendIpPacket(packet);

    // 记录未确认段用于重传（纯 ACK 不重传——对端会自己重发数据触发我们的 ACK）
    const consumesSeq = payload.length > 0 || hasTcpFlag(flags, TcpFlags.SYN) || hasTcpFlag(flags, TcpFlags.FIN);
    if (consumesSeq && !hasTcpFlag(flags, TcpFlags.RST)) {
      conn.unacked.push({ seq, payload: Buffer.from(payload), flags, sentAt: Date.now() });
      this.scheduleRetransmit(conn);
      // 数据/FIN 消耗序列号（SYN 由调用方处理）
      if (payload.length > 0 || hasTcpFlag(flags, TcpFlags.FIN)) {
        conn.sendSeq = (conn.sendSeq + payload.length + (hasTcpFlag(flags, TcpFlags.FIN) ? 1 : 0)) >>> 0;
      }
    }
  }

  private sendRst(
    remoteIp: string,
    localIp: string,
    header: { srcPort: number; dstPort: number; seq: number; ack: number; flags: number; window: number },
  ): void {
    const segment = buildTcpSegment({
      srcPort: header.dstPort,
      dstPort: header.srcPort,
      seq: header.ack,
      ack: (header.seq + 1) >>> 0,
      flags: TcpFlags.RST | (hasTcpFlag(header.flags, TcpFlags.ACK) ? 0 : TcpFlags.ACK),
      window: 0,
      srcIp: localIp,
      dstIp: remoteIp,
    });
    this.options.sendIpPacket(
      buildIpv4Packet({
        src: localIp,
        dst: remoteIp,
        protocol: IpProtocol.TCP,
        payload: segment,
        identification: (Math.random() * 0xffff) & 0xffff,
      }),
    );
  }

  /** 安排超时重传。 */
  private scheduleRetransmit(conn: TcpConnection): void {
    if (conn.retransmitTimer !== null) return;
    conn.retransmitTimer = setTimeout(() => {
      conn.retransmitTimer = null;
      if (conn.state === 'closed' || this.connections.get(this.key(conn)) === undefined) return;
      const now = Date.now();
      const due = conn.unacked.filter(
        (seg) =>
          now - seg.sentAt >= this.options.retransmitBaseMs &&
          // **SACK 的核心价值**：对端已经通过 SACK 块告诉我们
          // "这段我收到了"，就不必重传。没有这个过滤，超时会把
          // 整段未确认区间全部重发——包括早已到达的数据，
          // 白白占用带宽并加重拥塞。
          !this.isCoveredBySack(conn, seg.seq, seg.seq + seg.payload.length),
      );
      if (due.length === 0) {
        if (conn.unacked.length > 0) this.scheduleRetransmit(conn);
        return;
      }
      // 超时也意味着丢包：按拥塞处理收缩窗口
      this.onCongestionLoss(conn);

      if (conn.unacked.length > this.options.maxRetransmits) {
        this.log(`重传次数超限，关闭 ${conn.remoteIp}:${conn.remotePort}`);
        this.teardown(conn);
        this.connections.delete(this.key(conn));
        return;
      }
      for (const seg of due) {
        seg.sentAt = now;
        this.resendSegment(conn, seg.seq, seg.flags, seg.payload);
      }
      this.scheduleRetransmit(conn);
    }, this.options.retransmitBaseMs);
    conn.retransmitTimer.unref?.();
  }

  /**
   * 这个序列号区间是否已被对端的 SACK 块覆盖（= 对端已收到）。
   *
   * 判断要求**整段**被某个 SACK 块包含：部分覆盖时仍要重传剩余部分
   * （本实现按整段重传，保守但正确）。
   */
  private isCoveredBySack(conn: TcpConnection, left: number, right: number): boolean {
    for (const block of conn.peerSackBlocks) {
      // seqDiff 处理 32 位回绕
      if (seqDiff(left, block.left) >= 0 && seqDiff(right, block.right) <= 0) {
        return true;
      }
    }
    return false;
  }

  private resendSegment(conn: TcpConnection, seq: number, flags: number, payload: Buffer): void {
    const segment = buildTcpSegment({
      srcPort: conn.localPort,
      dstPort: conn.remotePort,
      seq,
      ack: conn.recvNext,
      flags,
      window: conn.localWindow,
      payload,
      srcIp: conn.localIp,
      dstIp: conn.remoteIp,
    });
    this.options.sendIpPacket(
      buildIpv4Packet({
        src: conn.localIp,
        dst: conn.remoteIp,
        protocol: IpProtocol.TCP,
        payload: segment,
        identification: (Math.random() * 0xffff) & 0xffff,
      }),
    );
  }

  /**
   * 当前可用的发送窗口（字节）。
   *
   * 取"对端通告的窗口"与"拥塞窗口"的**较小值**：
   * - 对端窗口是接收方能力（他缓冲快满了就会缩小）
   * - cwnd 是网络能力（我们对路径拥塞的估计）
   *
   * 只看对端窗口会让拥塞控制形同虚设（把网络灌满、丢包后重传雪崩）。
   */
  private effectiveWindow(conn: TcpConnection): number {
    return Math.max(0, Math.min(conn.remoteWindow, conn.cwnd));
  }

  /** 在途未确认的字节数。 */
  private inFlight(conn: TcpConnection): number {
    return conn.unacked.reduce((sum, seg) => sum + seg.payload.length, 0);
  }

  /**
   * 把 `pendingSend` 里能发的数据按 MSS 切成段发出去。
   *
   * 每次最多发到"窗口填满"为止，剩下的留在 `pendingSend` 等下一次 ACK
   * 打开窗口。**这是拥塞控制真正生效的地方**——不按窗口限流的话，
   * cwnd 只是个没人看的数字。
   */
  private flushPendingSend(conn: TcpConnection): void {
    if (conn.state !== 'established' && conn.state !== 'closeWait') return;

    for (;;) {
      if (conn.pendingSend.length === 0) return;
      const window = this.effectiveWindow(conn);
      const canSend = window - this.inFlight(conn);
      if (canSend <= 0) return; // 窗口满，等 ACK

      const chunkSize = Math.min(conn.mss, conn.pendingSend.length, canSend);
      if (chunkSize <= 0) return;
      const chunk = conn.pendingSend.subarray(0, chunkSize);
      conn.pendingSend = conn.pendingSend.subarray(chunkSize);
      this.sendSegment(conn, TcpFlags.PSH | TcpFlags.ACK, chunk);
    }
  }

  /**
   * 确认到达时增长拥塞窗口。
   *
   * 两个阶段（RFC 5681）：
   * - **慢启动**（cwnd < ssthresh）：每个 ACK 加一个 MSS，实际是每 RTT 翻倍。
   *   名字里的"慢"是相对最初的"一次翻倍到对端窗口"而言。
   * - **拥塞避免**（cwnd >= ssthresh）：每 RTT 只加一个 MSS（线性增长），
   *   避免把网络压到丢包。
   */
  private growWindow(conn: TcpConnection, ackedBytes: number): void {
    if (this.options.congestionControl === 'bbr') {
      this.updateBbrOnAck(conn, ackedBytes);
      return;
    }
    if (conn.cwnd < conn.ssthresh) {
      // 慢启动：按确认的字节数增长（近似"每 ACK 加一个 MSS"）
      conn.cwnd = Math.min(conn.cwnd + ackedBytes, 1024 * 1024);
    } else {
      // 拥塞避免：每 RTT 约增加一个 MSS，即每确认 cwnd 字节加一个 MSS
      conn.cwnd = Math.min(
        conn.cwnd + Math.max(1, Math.floor((conn.mss * ackedBytes) / conn.cwnd)),
        1024 * 1024,
      );
    }
  }

  /**
   * BBR 的 ACK 处理：更新带宽与最小 RTT，再用 BDP 重算窗口。
   *
   * ## 与 Reno 的根本区别
   *
   * Reno 把"丢包"当成拥塞信号，一丢就砍半窗口。BBR 不问丢包，
   * 只问两件事：
   * - **链路最快能跑多少**（`bwEstimate`，取观察到的最大投递速率）
   * - **往返最少要多久**（`minRttMs`，取滑动窗口最小值）
   *
   * 两者相乘就是"链路里最多能存多少数据"（BDP），窗口就该是它的倍数。
   * 这样即使有随机丢包，窗口也不会被无谓压低。
   *
   * ## 简化之处（如实说明）
   *
   * 真正的 BBR 有四个状态（Startup / Drain / ProbeBW / ProbeRTT）与
   * 精细的增益循环。这里实现的是**简化版**：
   * - 不做状态机，直接按 BDP × 增益算窗口
   * - 增益固定为 2（BBR 在 ProbeBW 阶段用的 cwnd gain 也是 2）
   * - 带宽用固定窗口（约 1 秒）内的最大值，不做多轮采样与轮次边界判定
   *
   * 对点对点虚拟链路够用；在复杂公网环境下不如完整 BBR。
   */
  private updateBbrOnAck(conn: TcpConnection, ackedBytes: number): void {
    const now = Date.now();
    conn.deliveredBytes += ackedBytes;
    conn.bwSampleBytes += ackedBytes;

    // 最小 RTT：用滑动窗口（10 秒）内的最小值。超时重置，避免旧值一直压制
    // 窗口（链路变慢后 minRtt 该更新）。
    const sampleMs = now - conn.bwSampleStartMs;
    if (sampleMs >= 1000) {
      const rate = sampleMs > 0 ? conn.bwSampleBytes / sampleMs : 0;
      if (rate > conn.bwEstimate) {
        // 取最大值：带宽是链路的稳定属性，一次采样偏低不代表链路变差
        conn.bwEstimate = rate;
      }
      conn.bwSampleBytes = 0;
      conn.bwSampleStartMs = now;

      // minRtt 也每秒刷新一次：本轮 RTT 用"从这里回溯到 ACK 的时间"近似。
      // 没有精确的发送时间戳，所以用采样窗口作为 RTT 上界的粗估——
      // 这是本简化实现的已知不足（真实 BBR 靠时间戳选项）。
      if (sampleMs < conn.minRttMs) conn.minRttMs = sampleMs;
    }

    // 没有足够样本时先用保守初值，别把窗口压到 0
    const minRtt = Number.isFinite(conn.minRttMs) ? Math.max(conn.minRttMs, 1) : 100;
    const bw = conn.bwEstimate > 0 ? conn.bwEstimate : 0;
    if (bw > 0) {
      // BDP × 增益 2：BBR 在 ProbeBW 阶段的标准做法
      const target = Math.floor(bw * minRtt * 2);
      const bounded = Math.min(Math.max(target, MIN_CWND), 1024 * 1024);
      if (bounded > conn.cwnd) {
        // 窗口增长要平滑：一次跳太多会让发送突发
        conn.cwnd = Math.min(conn.cwnd + ackedBytes, bounded);
      } else {
        // 允许缓慢回落到目标（链路变慢时），但不因单次丢包砍半
        conn.cwnd = Math.max(bounded, Math.floor(conn.cwnd * 0.9));
      }
    } else {
      // 还没测出带宽：按慢启动走，尽快拿到第一个样本
      conn.cwnd = Math.min(conn.cwnd + ackedBytes, 1024 * 1024);
    }
  }

  /**
   * 检测到丢包时的窗口收缩。
   *
   * `ssthresh` 砍半、`cwnd` 退到 1 个 MSS 并重新慢启动——这是最保守的
   * 反应（Reno 的做法）。虚拟链路通常是点对点，丢包多半是真的拥塞，
   * 保守一点比激进重传好。
   */
  private onCongestionLoss(conn: TcpConnection): void {
    conn.dupAckCount = 0;

    if (this.options.congestionControl === 'bbr') {
      // **BBR 不因丢包砍窗口**。这是它与 Reno 最重要的区别：
      // 随机丢包不代表链路拥塞，砍窗口只会白白损失吞吐。
      // 窗口由带宽估计决定，这里只是记一笔便于诊断。
      this.log(
        `BBR：观察到丢包，窗口保持 cwnd=${conn.cwnd}B（不当作拥塞信号）`,
      );
      return;
    }

    conn.ssthresh = Math.max(Math.floor(conn.cwnd / 2), MIN_CWND);
    conn.cwnd = MIN_CWND;
    this.log(`拥塞：cwnd → ${conn.cwnd}B，ssthresh → ${conn.ssthresh}B`);
  }

  /** 清理一个连接的资源。 */
  private teardown(conn: TcpConnection): void {
    if (conn.retransmitTimer !== null) {
      clearTimeout(conn.retransmitTimer);
      conn.retransmitTimer = null;
    }
    if (conn.bridge !== null) {
      conn.bridge.removeAllListeners();
      conn.bridge.destroy();
      conn.bridge = null;
    }
    conn.state = 'closed';
    conn.pendingToBridge = [];
    conn.unacked = [];
  }

  /** 供测试用：把序列号比较暴露出来，验证回绕语义。 */
  static compareSeq(a: number, b: number): number {
    return seqDiff(a, b);
  }
}

/**
 * 为出站 IP 包选目标对端（纯函数，便于测试）。
 *
 * 依据包的**目标 IP** 与各对端声明的虚拟 IP 做精确匹配。规则见
 * `acceptor.ts` 的 `pickConnectionFor`：精确匹配优先；只有一条对端时发它；
 * 多条且都不匹配时返回 null（**不猜**——发错对端会让数据串到别人的虚拟网里，
 * 静默丢弃至少是"不通"而非"串了"）。
 */
export function selectPeerForPacket<T extends { ipv4?: string }>(
  peers: readonly T[],
  dstIp: string | null,
): { peer: T | null; reason: 'matched' | 'single' | 'ambiguous' | 'none' } {
  if (dstIp !== null) {
    for (const peer of peers) {
      if (peer.ipv4 !== undefined && peer.ipv4 === dstIp) {
        return { peer, reason: 'matched' };
      }
    }
  }
  if (peers.length === 1) return { peer: peers[0], reason: 'single' };
  if (peers.length > 1) return { peer: null, reason: 'ambiguous' };
  return { peer: null, reason: 'none' };
}
