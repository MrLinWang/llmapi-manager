/**
 * EasyTier 兼容实现的**接受方（服务端）**。
 *
 * # 为什么需要这个方向
 *
 * 官方把连接分成发起方/接受方两个角色，`RpcResp` 只由接受方回给发起方
 * （`peer_conn.rs:205` 的 `after_received` 按连接角色过滤，不符合就**在解密前
 * 静默丢弃**）。此前 TS 只能当发起方，导致官方节点发来的 OSPF
 * `SyncRouteInfo` 请求永远无法应答——这是"自研实现与官方不一致"的最后一个
 * 功能缺口。
 *
 * 实现接受方之后，TS 可以监听端口等官方节点来连：官方是发起方，TS 是
 * 接受方，应答就站到了合法的一侧。
 *
 * # 流程（对照 `peer_conn.rs:1008` 的 `do_noise_handshake_as_server`）
 *
 * ```
 * 官方(发起方)                     TS(接受方)
 *   │── NoiseHandshakeMsg1 ────────▶│  e + 明文 protobuf（网络名/conn_id）
 *   │◀── NoiseHandshakeMsg2 ────────│  e,ee,s,es + protobuf（root_key/proof）
 *   │── NoiseHandshakeMsg3 ────────▶│  s,se + protobuf（双向 conn_id 回显 + proof）
 *   │◀════════ 数据面（AES-GCM）════▶│  Ping/Pong、OSPF 同步
 * ```
 *
 * # 三个必须精确的细节（错一个就静默失败）
 *
 * 1. **两份 secret_proof 用不同时点的握手哈希**：
 *    - 我方（Msg2 里）的 proof 用**读完 Msg1 之后**的哈希（官方 `peer_conn.rs:1051`）
 *    - 发起方（Msg3 里）的 proof 用**写完 Msg2 之后**的哈希（`:1126`），
 *      我方校验它时也要用同一时点
 * 2. **Msg3 的双向 conn_id 回显**都要校验（防串线/重放）
 * 3. **Ping 的回应就是把原包的 packet_type 从 Ping 改成 Pong 原样发回**
 *    （`peer_conn.rs:1340`——连包头都不改，只翻类型字节）
 */

import type { Socket, Server } from 'node:net';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { NoiseXXResponder, generateKeyPair, publicKeyFromPrivate } from './noiseXX';
import {
  decodeNoiseMsg1,
  decodeNoiseMsg3,
  encodeNoiseMsg2,
  secretProof,
  newConnId,
  SessionAction,
} from './noiseHandshake';
import { extractFrame, framePacket } from './framing';
import { PacketType, PeerManagerHeaderFlags, decodeHeader } from './protocol';
import { deriveTrafficKey, directionForSender, decryptPayload, encryptPayload } from './dataPlane';
import { TcpStack, selectPeerForPacket } from './tcpStack';
import { UdpStack } from './udpStack';
import { buildIcmpEchoReply } from './icmp';
import { IpReassembler } from './ipReassembly';
import { PeerTopology, decodeConnPeerList, decodeConnBitmap } from './topology';
import { IpProtocol, decodeIpv4Header } from './ip';
import {
  buildOspfSyncRouteRequest,
  buildWrappedRpcResponse,
  encodeRpcRequestWrapper,
  decodeRpcPacket,
  decodeRpcRequestWrapper,
  decodeRpcResponse,
  decodeSyncRouteInfoRequest,
  encodeRpcPacket,
  encodeSyncRouteInfoResponse,
  SyncRouteInfoRequestField,
  type RpcPacket,
} from './rpc';
import {
  decodeRoutePeerInfos,
  encodeRoutePeerInfos,
  type RoutePeerInfo,
} from './route';
import {
  decodeFields,
  encodeBytesField,
  encodeVarintField,
  encodeVarintField64,
  getBytes,
} from './protobuf';
import { timingSafeEqual } from 'node:crypto';

/** OSPF 同步请求的 body 字段号（`peer_rpc.proto` 的 `SyncRouteInfoRequest`）。 */
const SYNC_REQ_FIELD = {
  myPeerId: 1,
  mySessionId: 2,
  isInitiator: 3,
  peerInfos: 4,
  /** oneof conn_info 的 bitmap 分支（`peer_rpc.proto:117`） */
  connBitmap: 5,
  /** oneof conn_info 的 list 分支（`peer_rpc.proto:118`） */
  connPeerList: 7,
} as const;

/** 编码 `PeerIdVersion { peer_id = 1, version = 2 }`。 */
function encodePeerIdVersion(peerId: number, version: number): Buffer {
  return Buffer.concat([encodeVarintField(1, peerId), encodeVarintField(2, version)]);
}

export interface AcceptorOptions {
  /** 监听端口 */
  port: number;
  /** 本节点在虚拟网络里的 peer id（自己选，别与对端相同） */
  myPeerId: number;
  /** 网络名——必须与来连的官方节点一致，否则官方会按外部网络处理 */
  networkName: string;
  /** 网络密钥——proof 与数据面都依赖它 */
  networkSecret: string;
  /**
   * 接受方的 Noise 静态私钥（32 字节）。
   * 不传则每次启动随机生成——官方节点不做钉扎校验时这样没问题；
   * 要让官方钉扎本机身份，就得固定并持久化。
   */
  staticPrivateKey?: Buffer;
  /** 广播给对端的主机名（会出现在对端的 peer 列表里） */
  hostname?: string;
  /**
   * 本节点的虚拟 IPv4（如 `10.126.200.1`）。
   *
   * **路由安装需要它**：官方 OSPF 的路由表按 IPv4 组织，无虚拟 IP 的节点
   * 进不了路由表——连接与 OSPF 应答都正常，但对端 peer 列表的主机名
   * 永远是 `peer-<id>` 兜底（实测踩过）。
   */
  virtualIpv4?: string;
  /** 握手完成后是否主动广播自己的 RoutePeerInfo（默认 false） */
  advertiseRoute?: boolean;
  /** 数据面加密算法，与官方默认一致 */
  algorithm?: string;
}

export interface AcceptorCallbacks {
  onHandshake?(info: { remotePeerId: number; roleHint: number }): void;
  onOspfAnswered?(info: { remotePeerId: number; nativeMyPeerId: number }): void;
  onRouteAdvertised?(): void;
  onPingPong?(): void;
  onError?(err: Error): void;
  /** 数据面的诊断日志（连接建立、桥接失败等） */
  onDataPlaneLog?(message: string): void;
  /**
   * 协议层诊断（收到的报文、应答结果等）。
   *
   * 为什么不用 `process.stdout.write`：那样会绕过日志系统——不受日志级别
   * 控制、不落盘、不打码，生产环境里还会污染 stdout（可能被当成业务输出）。
   * 这里统一走回调，由调用方决定记到哪。
   *
   * 注意内容可能包含报文十六进制，只在显式开启诊断时传。
   */
  onProtocolLog?(message: string): void;
}

interface Connection {
  socket: Socket;
  remotePeerId: number;
  roleHint: number;
  bConnId: Uint8Array;
  rootKey: Buffer;
  sendSeq: bigint;
  /** 对端在 OSPF 请求里声明的主机名（首个非空的） */
  hostname?: string;
  /** 对端在 OSPF 请求里声明的虚拟 IPv4 */
  ipv4?: string;
  /** 最近一次 Ping/Pong 的往返时间（毫秒） */
  latencyMs?: number;
}

/**
 * 中继跳数上限。
 *
 * 每转发一跳 `forward_counter` 加一，超过就丢弃。用途是**防环**：
 * 拓扑有误或对端路由不一致时，包可能在几个节点间来回弹，
 * 没有上限会一直占用带宽。8 跳对"两台机器 + 中继"的组网绰绰有余。
 */
const MAX_FORWARD_HOPS = 8;

/**
 * 拓扑广播的去抖窗口（毫秒）。
 *
 * 多节点同时上线时 OSPF 请求会成串到达；每个都触发全量广播会产生
 * O(n²) 的包。合并到 200ms 内一次即可。
 */
const TOPOLOGY_BROADCAST_DEBOUNCE_MS = 200;

/** 单帧解析循环的状态。 */
function makeFrameBuffer() {
  return { buf: Buffer.alloc(0) };
}

function pushFrame(state: { buf: Buffer }, chunk: Buffer): Buffer[] {
  state.buf = Buffer.concat([state.buf, chunk]);
  const frames: Buffer[] = [];
  for (;;) {
    let frame: { body: Buffer } | null = null;
    try {
      frame = extractFrame(state.buf);
    } catch {
      state.buf = Buffer.alloc(0);
      break;
    }
    if (frame === null) break;
    frames.push(frame.body);
    state.buf = state.buf.subarray(4 + frame.body.length);
  }
  return frames;
}

/**
 * EasyTier 接受方：监听 TCP 端口，完成服务端 Noise 握手，
 * 然后作为合法的应答方处理 Ping/Pong 与 OSPF 路由同步。
 */
export class EasyTierAcceptor {
  private server: Server | null = null;
  private readonly connections = new Set<Connection>();
  private readonly staticKeyPair: { privateKey: Buffer; publicKey: Buffer };
  private ospfAnswered = false;
  /** 收到的各类包计数。数据面排查靠它回答"包到底有没有来"。 */
  private readonly packetTypes = new Map<number, number>();

  /** 各类包计数（键是包类型名，便于阅读）。 */
  packetTypeCounts(): Record<string, number> {
    const names: Record<number, string> = {
      [PacketType.Data]: 'Data',
      [PacketType.HandShake]: 'HandShake',
      [PacketType.Ping]: 'Ping',
      [PacketType.Pong]: 'Pong',
      [PacketType.RpcReq]: 'RpcReq',
      [PacketType.RpcResp]: 'RpcResp',
      [PacketType.NoiseHandshakeMsg1]: 'NoiseMsg1',
      [PacketType.NoiseHandshakeMsg2]: 'NoiseMsg2',
      [PacketType.NoiseHandshakeMsg3]: 'NoiseMsg3',
    };
    const out: Record<string, number> = {};
    for (const [type, count] of this.packetTypes) {
      out[names[type] ?? `type-${type}`] = count;
    }
    return out;
  }
  /**
   * 本节点在 OSPF 会话里的 session id（稳定，不随请求变化）。
   *
   * `SyncRouteInfoResponse.session_id` 的语义是**应答方自己的会话号**
   * （`peer_ospf_route.rs:4221-4223`：`session_id = session.my_session_id`），
   * 不是回显请求方的——对端靠它学习 `dst_session_id` 来建立会话。
   * 我曾错误地回显请求里的值，对端一比对（等于它自己的会话号）就判
   * "session id mismatch, clear saved info"，同步永远建立不起来。
   */
  private readonly mySessionId = BigInt('0x' + randomBytes(8).toString('hex'));

  constructor(
    private readonly options: AcceptorOptions,
    private readonly callbacks: AcceptorCallbacks = {},
  ) {
    // 传了固定私钥时**必须从它推导公钥**，不能另外随机一对——
    // 否则广播出去的 noise_static_pubkey 与握手实际使用的私钥不匹配，
    // 对端钉扎校验会失败（或更糟：对端接受的公钥永远无法再复现）。
    this.topology = new PeerTopology(options.myPeerId);
    this.staticKeyPair = options.staticPrivateKey
      ? {
          privateKey: options.staticPrivateKey,
          publicKey: publicKeyFromPrivate(options.staticPrivateKey),
        }
      : generateKeyPair();
  }

  /** 开始监听。resolve 表示端口已绑定。 */
  async start(): Promise<void> {
    // 分片组的超时清理：不清理会让半截包一直占内存
    this.reassembler.start();
    const server = createServer((socket) => {
      void this.handleConnection(socket);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, '0.0.0.0', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.tcpStack?.close();
    this.tcpStack = null;
    this.udpStack?.close();
    this.udpStack = null;
    this.reassembler.close();
    if (this.topologyBroadcastTimer !== null) {
      clearTimeout(this.topologyBroadcastTimer);
      this.topologyBroadcastTimer = null;
    }
    this.topology.clear();
    for (const conn of this.connections) conn.socket.destroy();
    this.connections.clear();
    await new Promise<void>((resolve) => {
      if (this.server === null) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  /**
   * 是否开启协议层诊断。
   *
   * 两个来源：显式环境变量（调试用），或调用方提供了回调（由它决定记在哪、
   * 记不记）。后者让生产环境可以通过 logger 的级别控制，而不是走 stdout。
   */
  private debugEnabled(): boolean {
    return (
      process.env.EASYTIER_ACCEPTOR_DEBUG !== undefined ||
      this.callbacks.onProtocolLog !== undefined
    );
  }

  private debug(message: string): void {
    if (process.env.EASYTIER_ACCEPTOR_DEBUG !== undefined) {
      // 调试时直接打 stdout：为了让 `node -e` 那种一次性脚本能立刻看到，
      // 不用先配日志。生产走下面的回调。
      process.stdout.write(`[ts-acceptor] ${message}\n`);
    }
    this.callbacks.onProtocolLog?.(message);
  }

  /** 是否已成功应答过一次 OSPF 同步请求。 */
  hasAnsweredOspf(): boolean {
    return this.ospfAnswered;
  }

  /**
   * 当前已建立的对端。
   *
   * 主机名与虚拟 IP 从对端的 OSPF 广播里取——它们不在握手包里，
   * 所以刚握手完成时可能还没有，页面要能接受 `null`。
   */
  connectedPeers(): Array<{
    peerId: number;
    hostname: string | null;
    ipv4: string | null;
    latencyMs: number | null;
  }> {
    return [...this.connections].map((conn) => ({
      peerId: conn.remotePeerId,
      hostname: conn.hostname ?? null,
      ipv4: conn.ipv4 ?? null,
      latencyMs: conn.latencyMs ?? null,
    }));
  }

  /** 已建立连接数。`status().peerCount` 用它。 */
  connectionCount(): number {
    return this.connections.size;
  }

  private async handleConnection(socket: Socket): Promise<void> {
    const frames = makeFrameBuffer();
    let conn: Connection | null = null;
    let responder: NoiseXXResponder | null = null;
    let msg1ConnId: Uint8Array | null = null;
    let hashAfterMsg2: Buffer | null = null;

    socket.on('error', (err) => this.callbacks.onError?.(err));

    socket.on('data', (chunk) => {
      for (const frame of pushFrame(frames, chunk)) {
        try {
          const header = decodeHeader(frame);
          if (header === null) continue;

          if (conn === null) {
            // ── 握手阶段 ──
            if (header.packetType !== PacketType.NoiseHandshakeMsg1) {
              throw new Error(`握手首包类型错误：${header.packetType}（期望 Msg1）`);
            }
            // 用固定的静态密钥：对端（若配置了钉扎）会认这把钥匙
            responder = new NoiseXXResponder(undefined, this.staticKeyPair);

            // 1) 读 Msg1：payload 是明文 protobuf
            const payload = responder.readMessage(frame.subarray(16));
            const msg1 = decodeNoiseMsg1(payload);
            msg1ConnId = msg1.aConnId;

            // 发起方的 peer id 在**包头**里（`peer_conn.rs:1030` 的 get_src_peer_id）
            const remotePeerId = header.fromPeerId;

            // 2) 网络名匹配 → role_hint=1 并带 proof；不匹配 → 2（外部网络语义）
            const nameMatches = msg1.aNetworkName === this.options.networkName;
            const roleHint = nameMatches ? 1 : 2;
            // proof 用**读完 Msg1 之后**的握手哈希（`peer_conn.rs:1051`）
            const serverProof =
              nameMatches && this.options.networkSecret !== ''
                ? secretProof(this.options.networkSecret, responder.getHandshakeHash())
                : null;

            // 3) 生成新会话的材料（对照 upsert_responder_session 的 Create 分支）
            const rootKey = randomBytes(32);
            const bConnId = newConnId();

            const msg2 = encodeNoiseMsg2({
              bNetworkName: this.options.networkName,
              roleHint,
              action: SessionAction.Create,
              bSessionGeneration: null,
              rootKey32: rootKey,
              initialEpoch: 0,
              bConnId,
              aConnIdEcho: msg1.aConnId,
              secretProof32: serverProof,
              serverEncryptionAlgorithm: this.options.algorithm ?? 'aes-gcm',
              features: ['liveness-echo-v1'],
            });

            const ct2 = responder.writeMessage(msg2);
            // 发起方 Msg3 里的 proof 用**写完 Msg2 之后**的哈希（`peer_conn.rs:1126`）
            hashAfterMsg2 = responder.getHandshakeHash();

            socket.write(
              framePacket(ct2, {
                fromPeerId: this.options.myPeerId,
                toPeerId: remotePeerId,
                packetType: PacketType.NoiseHandshakeMsg2,
              }),
            );

            conn = {
              socket,
              remotePeerId,
              roleHint,
              bConnId,
              rootKey,
              sendSeq: 0n,
            };
            this.connections.add(conn);
            continue;
          }

          // ── Msg3：握手确认 ──
          if (header.packetType === PacketType.NoiseHandshakeMsg3 && responder !== null) {
            const payload = responder.readMessageFinal(frame.subarray(16));
            const msg3 = decodeNoiseMsg3(payload);

            if (Buffer.from(msg3.aConnIdEcho).compare(Buffer.from(msg1ConnId!)) !== 0) {
              throw new Error('noise msg3 a_conn_id mismatch');
            }
            if (
              msg3.bConnIdEcho === null ||
              Buffer.from(msg3.bConnIdEcho).compare(Buffer.from(conn.bConnId)) !== 0
            ) {
              throw new Error('noise msg3 b_conn_id mismatch');
            }
            if (conn.roleHint === 1 && msg3.secretProof !== null && hashAfterMsg2 !== null) {
              const expected = secretProof(this.options.networkSecret, hashAfterMsg2);
              // timingSafeEqual 要求等长；proof 固定 32 字节，长度不等即失败
              if (
                msg3.secretProof.length !== expected.length ||
                !timingSafeEqual(msg3.secretProof, expected)
              ) {
                throw new Error('secret proof mismatch（对端不持有网络密钥）');
              }
            }
            this.callbacks.onHandshake?.({
              remotePeerId: conn.remotePeerId,
              roleHint: conn.roleHint,
            });
            continue;
          }

          // ── 数据面 ──
          this.handleDataPlane(frame, header, conn, responder);
        } catch (err) {
          this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
          socket.destroy();
        }
      }
    });
  }

  /** 握手完成后的数据面：Ping/Pong 与 OSPF。 */
  private handleDataPlane(
    frame: Buffer,
    header: NonNullable<ReturnType<typeof decodeHeader>>,
    conn: Connection,
    responder: NoiseXXResponder | null,
  ): void {
    // 统计必须放在**最前面**：放后面会漏掉早退的分支（Ping/未加密/其他类型），
    // 而"某类包到底有没有来"正是排查数据面时的第一个问题。
    this.packetTypes.set(
      header.packetType,
      (this.packetTypes.get(header.packetType) ?? 0) + 1,
    );

    // Ping → Pong：把类型字节从 Ping 翻成 Pong，其余原样发回（`peer_conn.rs:1340`）。
    //
    // **注意 frame 里没有 4 字节长度前缀**——本类的收帧循环返回的是去掉前缀的
    // body（16 字节包头 + 载荷）。直接把 body 写回 socket，对端会把 body 的
    // 前 4 字节（from_peer_id，约 19 亿）当成帧长，报 `body too long` 断连。
    // 踩过：症状是"握手成功但每 1 秒重连一次"，没有任何 TS 侧错误。
    if (header.packetType === PacketType.Ping) {
      const body = Buffer.from(frame);
      body[8] = PacketType.Pong; // 包头内 type 在偏移 8（完整帧里是 4+8=12）
      const out = Buffer.alloc(4 + body.length);
      out.writeUInt32LE(body.length, 0);
      body.copy(out, 4);
      conn.socket.write(out);
      this.callbacks.onPingPong?.();
      return;
    }

    // 对端对我们广播的响应（成功或 MalformatRpcPacket 错误）——
    // 这是判断"广播是否被接受"的唯一权威来源
    if (header.packetType === PacketType.RpcResp) {
      if (this.debugEnabled()) {
        try {
          const respRpc = decodeRpcPacket(
            decryptPayload({
              key: deriveTrafficKey(
                conn.rootKey,
                0,
                directionForSender(conn.remotePeerId, this.options.myPeerId),
              ),
              ciphertextWithTail: frame.subarray(16),
              algorithm: this.options.algorithm ?? 'aes-gcm',
            }),
          );
          const unwrapped = decodeRpcResponse(respRpc.body);
          this.debug(
            `广播响应: txn=${respRpc.transactionId} error=${JSON.stringify(
              unwrapped.error,
            )} payload=${unwrapped.response.toString('hex').slice(0, 60)}`,
          );
        } catch (e) {
          this.debug(`广播响应解码失败: ${(e as Error).message}`);
        }
      }
      return;
    }

    // ── 业务数据包（Data）：虚拟网络里的真实流量 ──
    //
    // `Data` 的载荷是**完整 IP 包**（`peer_manager.rs:462`：官方把它直接投给
    // 网卡或 smoltcp）。这里把它交给用户态 TCP 栈，由栈把虚拟连接桥接到
    // 本机真实端口——这是"follower 通过虚拟 IP 访问 master 管理界面"的关键。
    //
    // 注意 Data 包同样是加密的（`try_compress_and_encrypt`），所以要先解密。
    // 与 RPC 不同的是：**顺序号也消耗**，且失败时不能静默丢弃——丢一个
    // 数据包会让 TCP 看起来"卡住但不断"，比直接断开更难排查。
    if (header.packetType === PacketType.Data) {
      this.handleDataPacket(conn, header, frame);
      return;
    }

    if (header.packetType !== PacketType.RpcReq) return;
    if (responder === null) return;
    if ((header.flags & PeerManagerHeaderFlags.ENCRYPTED) === 0) return;

    // 解密：方向按 peer_id 大小（`peer_session.rs:359`），密钥经 HKDF 派生
    const recvKey = deriveTrafficKey(
      conn.rootKey,
      0,
      directionForSender(conn.remotePeerId, this.options.myPeerId),
    );
    let rpc: RpcPacket;
    try {
      rpc = decodeRpcPacket(
        decryptPayload({
          key: recvKey,
          ciphertextWithTail: frame.subarray(16),
          algorithm: this.options.algorithm ?? 'aes-gcm',
        }),
      );
    } catch {
      return; // 解不开的（别的会话/epoch）忽略
    }

    if (
      !rpc.isRequest ||
      rpc.descriptor === null ||
      !rpc.descriptor.protoName.endsWith('OspfRouteRpc')
    ) {
      return;
    }

    this.debug(`收到 OSPF 请求 body=${rpc.body.toString('hex').slice(0, 120)}`);
    // body 是 RpcRequest 包装，业务消息在字段 2 里——直接解会得到全 0
    const innerBody = decodeRpcRequestWrapper(rpc.body);
    const request = decodeSyncRouteInfoRequest(innerBody);

    // 采集对端身份：主机名与虚拟 IP 只出现在它的 RoutePeerInfo 里
    // （`peer_infos` 中 peer_id 等于它自己的那条）。页面靠这些字段
    // 显示"我连上了谁"。
    const learned =
      getBytes(decodeFields(innerBody), SyncRouteInfoRequestField.peerInfos) === null
        ? []
        : decodeRoutePeerInfos(
            getBytes(decodeFields(innerBody), SyncRouteInfoRequestField.peerInfos)!,
          );
    const selfInfo = learned.find((r) => r.peerId === conn.remotePeerId);
    if (selfInfo) {
      if (selfInfo.hostname !== null && selfInfo.hostname !== '') {
        conn.hostname = selfInfo.hostname;
      }
      if (selfInfo.ipv4Addr !== null) conn.ipv4 = selfInfo.ipv4Addr;
    }
    // ── 学拓扑：节点信息 + 连接关系 ──
    // 这是多跳中继的基础：只有知道"谁连着谁"，才能算出到非直连目标的下一跳。
    this.topology.learnPeers(
      learned.map((info) => ({
        peerId: info.peerId,
        ipv4: info.ipv4Addr,
        hostname: info.hostname,
        networkLength: info.networkLength,
      })),
    );
    // 连接关系有两个 oneof 分支，官方不同场景会用不同分支，两种都要解
    const innerFields = decodeFields(innerBody);
    const connPeerListRaw = getBytes(innerFields, SYNC_REQ_FIELD.connPeerList);
    if (connPeerListRaw !== null) {
      for (const row of decodeConnPeerList(connPeerListRaw)) {
        this.topology.learnConnections(row.peerId, row.connectedPeerIds);
      }
    }
    const connBitmapRaw = getBytes(innerFields, SYNC_REQ_FIELD.connBitmap);
    if (connBitmapRaw !== null) {
      const { peerIds, bits } = decodeConnBitmap(connBitmapRaw);
      this.topology.learnConnBitmap(peerIds, bits);
    }
    // 我们与这条连接的对端本身就是直连——这条边必须自己补上，
    // 不能指望对端在 conn_info 里提到我们（它可能只报自己的邻居）
    this.topology.addEdge(this.options.myPeerId, conn.remotePeerId);

    // 对端广播的 peer_infos 里有没有我们？有 = 它的 OSPF 图已经学到本节点
    this.debug(
      `对端 peer_infos: ${JSON.stringify(
        learned.map((r) => ({ id: r.peerId, host: r.hostname })),
      )}`,
    );

    // 应答：业务消息包进 RpcResponse 再进 body（对端按 RpcResponse 解 body）
    // 官方语义（peer_ospf_route.rs:4221-4223）：
    //   session_id   = 应答方自己的会话号（对端由此学习 dst_session_id）
    //   is_initiator = 应答方自己"是不是 initiator"的判断
    // 官方把本连接的 initiator 角色给了自己（它的请求里 is_initiator=true），
    // 所以我们如实回答 false。
    const responseBody = encodeSyncRouteInfoResponse({
      isInitiator: false,
      sessionId: this.mySessionId,
      error: null,
      missingPeerIds: [],
      missingConnPeerIds: [],
    });
    this.sendRpc(conn, buildWrappedRpcResponse(rpc, responseBody), PacketType.RpcResp);
    this.ospfAnswered = true;
    this.callbacks.onOspfAnswered?.({
      remotePeerId: conn.remotePeerId,
      nativeMyPeerId: request.myPeerId,
    });

    // 主动广播自己的路由信息，让对端的 OSPF 图里出现本节点
    if (this.options.advertiseRoute === true) {
      this.advertiseRoute(conn);
      // **还要广播给其他所有连接**：刚才学到的拓扑（比如"B 存在"）
      // 需要让 A 也看到。只在回应请求者时广播的话，A 送来第一个请求时
      // 我们还不知道 B，A 就永远学不到 B——三节点以上无法互相发现。
      this.scheduleTopologyBroadcast();
    }
  }

  /**
   * 拓扑变化后，延迟一小段时间再向所有连接重播。
   *
   * 去抖的原因：多节点同时上线时，OSPF 请求会成串到达，每个都触发一轮
   * 全量广播会产生 O(n²) 的包。合并成一个延迟任务即可。
   */
  private scheduleTopologyBroadcast(): void {
    if (this.topologyBroadcastTimer !== null) return;
    this.topologyBroadcastTimer = setTimeout(() => {
      this.topologyBroadcastTimer = null;
      for (const conn of this.connections) {
        if (this.options.advertiseRoute !== true) continue;
        try {
          this.advertiseRoute(conn);
        } catch (cause) {
          this.callbacks.onError?.(cause as Error);
        }
      }
    }, TOPOLOGY_BROADCAST_DEBOUNCE_MS);
    this.topologyBroadcastTimer.unref?.();
  }

  /** 构造并发送自己的 `SyncRouteInfo` 请求（让对端把本节点加进路由表）。 */
  private advertiseRoute(conn: Connection): void {
    const directPeers = [...this.connections].map((c) => c.remotePeerId);
    // ipv4 是路由安装的必要条件：官方 OSPF 路由表按 IPv4 组织，
    // 无虚拟 IP 的节点进不了路由表（实测踩过：连接/应答都正常，
    // 但对端 peer 列表主机名一直是 peer-<id> 兜底）。
    const ip = this.options.virtualIpv4 ?? null;
    // 版本必须递增，否则对端按"版本更高才接受"的规则丢弃整个更新
    this.topologyVersion += 1;
    const version = this.topologyVersion;

    const route: RoutePeerInfo = {
      peerId: this.options.myPeerId,
      cost: 1,
      hostname: this.options.hostname ?? null,
      version,
      easytierVersion: '2.7.0',
      proxyCidrs: [],
      peerRouteId: Date.now() % 0x7fffffff,
      networkLength: ip === null ? 0 : 24,
      ipv4Addr: ip,
      // 带上我们的 Noise 静态公钥：官方做 relay 握手时需要它
      noiseStaticPubkey: this.staticKeyPair.publicKey,
    };

    // **把所有已知节点都带上**，而不只是自己。
    //
    // 多跳的前提：对端要能通过我们学到"还有哪些节点存在"。只报自己时，
    // 对端的 OSPF 图里永远只有它和本节点，它根本不知道第三个节点，
    // 也就不会把发往第三方的包交给我们转发——中继无从谈起。
    //
    // 自己那条用最新构造的 `route`（含刚更新的 peerRouteId），
    // 其余用拓扑里学到的信息。
    const otherRoutes: RoutePeerInfo[] = this.topology
      .knownPeers()
      .filter((peer) => peer.peerId !== this.options.myPeerId)
      // **不要把接收方自己的信息回给它**。官方在
      // `check_duplicate_peer_id` 里会检查"别人发来的我的信息"：
      // peer_route_id 与本机不同且 version 更高时，判定本机 peer id 被
      // 重复占用并 `panic!`。我们的副本里 peerRouteId/version 都是造出来的，
      // 必然对不上——回给对端等于主动触发它的重复检测。
      .filter((peer) => peer.peerId !== conn.remotePeerId)
      .map((peer) => ({
        peerId: peer.peerId,
        cost: 1,
        hostname: peer.hostname,
        // 同样要用递增版本：对端按"比旧版本高才接受"判断
        version,
        easytierVersion: '2.7.0',
        proxyCidrs: [],
        peerRouteId: peer.peerId,
        networkLength: peer.networkLength,
        ipv4Addr: peer.ipv4,
        noiseStaticPubkey: null,
      }));

    // SyncRouteInfoRequest：my_peer_id(1) + my_session_id(2) + is_initiator(3)
    //                      + peer_infos(4) + conn_peer_list(7, oneof)
    const innerInfos = encodeRoutePeerInfos([route, ...otherRoutes]);

    // conn_info：告诉对端"谁和谁直连"。路由表的下一跳图完全由各节点的
    // conn_info 拼出来——只发 peer_infos 不发 conn_info，图里就没有
    // "TS ↔ 对端"这条边，`get_next_hop` 拿不到下一跳，路由装不上，
    // 对端的 peer 列表里主机名永远是 peer-<id> 兜底。踩过。
    //
    // 用 conn_peer_list 分支（peer_ospf_route.rs:1458 的 update_conn_info
    // 两种 oneof 都支持），语义直白：本节点直连着对端。
    // 连接关系也要广播**全部已知的边**，不只是自己那一条：
    // 对端靠这些边拼出完整拓扑，才能算出"到第三方该经由谁"。
    const connectionRows = this.topology.connectionRows();
    // 兜底：拓扑还没学到边时，至少把自己与直连对端的关系报出去
    if (connectionRows.length === 0 && directPeers.length > 0) {
      connectionRows.push({
        peerId: this.options.myPeerId,
        connectedPeerIds: directPeers,
      });
    }
    const connPeerList = Buffer.concat(
      connectionRows.map((row) =>
        encodeBytesField(
          1, // RouteConnPeerList.peer_conn_infos
          Buffer.concat([
            encodeBytesField(
              1, // PeerConnInfo.peer_id
              // 版本同样要递增：官方 `update_conn_info_one_peer` 只在
              // `peer_id_version.version > old.version` 时才更新
              encodePeerIdVersion(row.peerId, version),
            ),
            ...row.connectedPeerIds.map(
              (peerId) => encodeVarintField(2, peerId), // PeerConnInfo.connected_peer_ids
            ),
          ]),
        ),
      ),
    );

    const body = Buffer.concat([
      encodeVarintField(SYNC_REQ_FIELD.myPeerId, this.options.myPeerId),
      // my_session_id 是 **int64 直接 varint**——不能包一层 bytes（wire type 会
      // 变成 2），prost 解码整个请求失败，广播被静默丢弃。踩过：症状是
      // "连接稳定但对端路由表里主机名一直是 peer-<id>"。
      encodeVarintField64(SYNC_REQ_FIELD.mySessionId, this.mySessionId),
      // 我们不是 initiator（官方把发起角色给了自己）。is_initiator=false 的
      // 首个反向同步会被对端 admission 接受（peer_ospf_route.rs:2239 的分支：
      // dst_session_id==0 && !is_initiator && 对端自认 initiator）；
      // 声称 true 反而会被当成"两个 initiator"拒绝。
      encodeVarintField(SYNC_REQ_FIELD.isInitiator, 0),
      encodeBytesField(SYNC_REQ_FIELD.peerInfos, innerInfos),
      encodeBytesField(SYNC_REQ_FIELD.connPeerList, connPeerList),
    ]);

    const packet = buildOspfSyncRouteRequest({
      fromPeer: this.options.myPeerId,
      toPeer: conn.remotePeerId,
      transactionId: BigInt(Date.now()),
      // 请求方向的 body 同样要包 RpcRequest（与响应方向的 RpcResponse 对称）
      body: encodeRpcRequestWrapper(body),
      networkName: this.options.networkName,
    });
    this.debug(
      `descriptor=${JSON.stringify(packet.descriptor)} ` +
        `body=${body.toString('hex')} ` +
        `自解 peer_infos=${JSON.stringify(
          decodeRoutePeerInfos(innerInfos).map((r) => ({
            id: r.peerId,
            host: r.hostname,
            ver: r.version,
          })),
        )} conn=${connPeerList.toString('hex')}`,
    );
    this.sendRpc(conn, packet, PacketType.RpcReq);
    this.callbacks.onRouteAdvertised?.();
  }

  /** 加密并发送一个 RPC 包（nonce 序列号每连接从 0 递增）。 */
  /**
   * 处理一个加密的业务数据包（`PacketType.Data`）。
   *
   * 载荷是完整 IP 包。解密后交给用户态 TCP 栈；栈把虚拟连接桥接到本机端口，
   * 于是对端在虚拟 IP 上访问本机服务时能真的连通。
   *
   * **解密失败的处置与 RPC 不同**：RPC 解不开就丢弃（可能是别的会话的包），
   * 而 Data 包解不开说明这条连接的密钥/序号已经错位，继续用只会让对端看到
   * "能连上但不通"的假象。这里记一条日志并丢弃——不主动断连，因为序号错位
   * 也可能是我们有 bug，断连会掩盖它。
   */
  private handleDataPacket(
    conn: Connection,
    header: { flags: number; toPeerId: number; forwardCounter: number },
    frame: Buffer,
  ): void {
    if ((header.flags & PeerManagerHeaderFlags.ENCRYPTED) === 0) {
      // 未加密的 Data 包只有非 secure 模式才有；本实现始终走 secure，
      // 收到这种包说明对端配置不一致
      this.callbacks.onError?.(
        new Error('收到未加密的 Data 包——对端可能关掉了 secure mode'),
      );
      return;
    }

    const recvKey = deriveTrafficKey(
      conn.rootKey,
      0,
      directionForSender(conn.remotePeerId, this.options.myPeerId),
    );

    let ipPacket: Buffer;
    try {
      ipPacket = decryptPayload({
        key: recvKey,
        ciphertextWithTail: frame.subarray(16),
        algorithm: this.options.algorithm ?? 'aes-gcm',
      });
    } catch (e) {
      this.callbacks.onError?.(
        new Error(`Data 包解密失败：${(e as Error).message}`),
      );
      return;
    }

    // ── 中继：包头指定的目标不是我们 → 转给下一跳 ──
    //
    // 这是多跳的关键。对端 A 想访问 B（A 与 B 不直连，都连着我们），
    // 它会把包发给我们、`to_peer_id` 填 B。我们必须把它转出去，
    // 而不是当成"发给自己的数据"去解析 IP 头。
    //
    // `to_peer_id == 0` 表示"按目标 IP 路由"，那是发给我们自己的。
    if (header.toPeerId !== 0 && header.toPeerId !== this.options.myPeerId) {
      // 转发计数防环：每跳 +1，超过上限说明拓扑有环或路由不对
      const nextCounter = header.forwardCounter + 1;
      if (nextCounter > MAX_FORWARD_HOPS) {
        this.callbacks.onDataPlaneLog?.(
          `中继跳数超过上限（${nextCounter}），丢弃：目标 ${header.toPeerId}`,
        );
        return;
      }
      this.sendDataPacket(ipPacket, {
        toPeerId: header.toPeerId,
        forwardCounter: nextCounter,
      });
      return;
    }

    this.dispatchIpPacket(ipPacket);
  }

  /**
   * 按 IP 协议号把包分发给对应的处理器。
   *
   * 顺序有讲究：**ICMP 先处理**——它是无状态的 echo 应答，不该因为
   * TCP/UDP 栈的会话状态而受影响（`ping` 要能随时通）。
   */
  private dispatchIpPacket(rawPacket: Buffer): void {
    // 分片必须先重组：分片的重组结果才是能交给 TCP/UDP/ICMP 的完整包。
    // 否则带分片的包会在各栈里被判"总长不对"而丢弃，症状是**大包静默消失**。
    const reassembled = this.reassembler.accept(rawPacket);
    if (reassembled === null) return; // 分片还没齐
    const ipPacket = reassembled.packet;

    const header = decodeIpv4Header(ipPacket);
    if (header === null) return;

    if (header.protocol === IpProtocol.ICMP) {
      const reply = buildIcmpEchoReply(
        ipPacket,
        this.options.virtualIpv4 ?? '',
        header.src,
      );
      if (reply !== null) {
        this.sendDataPacket(reply);
      } else {
        this.callbacks.onDataPlaneLog?.(
          `丢弃非 echo-request 的 ICMP（type 不在支持范围）`,
        );
      }
      return;
    }

    if (header.protocol === IpProtocol.UDP) {
      if (this.udpStack === null) {
        this.callbacks.onDataPlaneLog?.(
          `收到 UDP 包但未配置 UDP 映射（${header.src} → ${header.dst}）；` +
            `DNS 走 UDP，需要配 udpForwards 才能解析域名`,
        );
        return;
      }
      this.udpStack.handleIpPacket(ipPacket);
      return;
    }

    if (header.protocol === IpProtocol.TCP) {
      if (this.tcpStack === null) {
        this.callbacks.onDataPlaneLog?.('收到 TCP 包但未配置 TCP 映射');
        return;
      }
      this.tcpStack.handleIpPacket(ipPacket);
      return;
    }

    this.callbacks.onDataPlaneLog?.(
      `丢弃不支持协议的 IP 包 protocol=${header.protocol}`,
    );
  }

  /** 用户态 TCP 栈（懒创建：只有配置了端口映射才有意义）。 */
  private tcpStack: TcpStack | null = null;
  /** 用户态 UDP 转发（DNS 走它）。 */
  private udpStack: UdpStack | null = null;
  /**
   * IP 分片重组。
   *
   * 无条件创建（不受 portForwards 影响）：分片可能出现在任何协议上，
   * 而且"分片没重组"的症状是大包静默消失，事后无法从日志看出原因。
   */
  private readonly reassembler = new IpReassembler({
    log: (message) => this.callbacks.onDataPlaneLog?.(message),
  });
  /**
   * 虚拟网络拓扑（从 OSPF 消息里学）。
   *
   * 多跳中继的基础：靠它算出"到非直连目标该经由哪个邻居转发"。
   */
  private readonly topology: PeerTopology;
  /** 拓扑变化后的去抖广播定时器（见 `scheduleTopologyBroadcast`） */
  private topologyBroadcastTimer: NodeJS.Timeout | null = null;
  /**
   * 拓扑广播的版本号，**必须单调递增**。
   *
   * 官方的 `update_peer_infos` 与 `update_conn_info_one_peer` 都按
   * `new.version > old.version` 决定是否接受更新——版本不涨的包会被**静默丢弃**。
   * 我一开始对所有节点都写死 `version: 1`，于是：
   *
   * - 第一次广播被接受（对端还没有这些条目）
   * - 之后拓扑再变化（比如第三个节点上线），同一版本的更新全被忽略
   *
   * 症状是"先连上的对端永远学不到后连上的节点"，非常有误导性。
   */
  private topologyVersion = 1;

  /**
   * 启用数据面：把虚拟 IP 上的端口桥接到本机端口。
   *
   * 每个 `{ virtualPort, localPort }` 表示"对端访问我虚拟 IP 的 virtualPort
   * 时，把连接转给本机 127.0.0.1:localPort"。这就是组网的实际用途——
   * follower 通过虚拟 IP 访问 master 的管理界面（8787）。
   */
  enableDataPlane(options: {
    /** TCP 端口映射：虚拟端口 → 本机端口 */
    tcp?: Array<{ virtualPort: number; localPort: number }>;
    /** UDP 端口映射：虚拟端口 → 目标（DNS 常指向 systemd-resolved 的 127.0.0.53） */
    udp?: Array<{ virtualPort: number; targetHost: string; targetPort: number }>;
  }): void {
    const tcpForwards = options.tcp ?? [];
    const udpForwards = options.udp ?? [];
    if (tcpForwards.length === 0 && udpForwards.length === 0) return;
    // 没有虚拟 IP 时**不能**开数据面：我们会用自己的 IP 作为回包的源地址，
    // 而 `0.0.0.0` 不是合法源地址，对端会判为无效并丢弃——症状是
    // "端口映射配了、TCP 能建立、但一收数据就卡住"，极难定位。
    // 明确拒绝并说清原因，比开一个坏的数据面好。
    if (this.options.virtualIpv4 === undefined || this.options.virtualIpv4 === '') {
      throw new Error(
        '启用数据面需要先配置本机的虚拟 IP（networking.ipv4）——' +
          '它是回包的源地址，留空会让对端丢弃我们的数据',
      );
    }
    if (tcpForwards.length > 0) {
      if (this.tcpStack === null) {
        this.tcpStack = new TcpStack({
          localIp: this.options.virtualIpv4,
          bridgeHost: '127.0.0.1',
          sendIpPacket: (packet) => this.sendDataPacket(packet),
          log: (message) => this.callbacks.onDataPlaneLog?.(message),
        });
        this.tcpStack.start();
      }
      for (const forward of tcpForwards) {
        this.tcpStack.listen(forward.virtualPort, forward.localPort);
      }
    }

    if (udpForwards.length > 0) {
      if (this.udpStack === null) {
        this.udpStack = new UdpStack({
          localIp: this.options.virtualIpv4,
          // 兜底目标；每个端口通过 listen() 自带目标，这个值基本不会用到
          forwardHost: '127.0.0.1',
          sendIpPacket: (packet) => this.sendDataPacket(packet),
          log: (message) => this.callbacks.onDataPlaneLog?.(message),
        });
        this.udpStack.start();
      }
      for (const forward of udpForwards) {
        this.udpStack.listen(forward.virtualPort, forward.targetHost, forward.targetPort);
      }
    }
  }

  /** 数据面会话数（诊断用）。 */
  dataPlaneStats(): { tcp: number; udp: number; pendingFragments: number } {
    return {
      tcp: this.tcpStack?.connectionCount() ?? 0,
      udp: this.udpStack?.sessionCount() ?? 0,
      pendingFragments: this.reassembler.pendingGroups(),
    };
  }

  /** 数据面连接数（诊断用）。 */
  dataPlaneConnectionCount(): number {
    return this.tcpStack?.connectionCount() ?? 0;
  }

  /**
   * 把一个 IP 包加密后发给对端。
   *
   * 选哪个连接？当前实现只有单对端场景（组网就是两台机器），所以发给
   * 第一个已连上的对端。多对端时应该按 IP 查路由表——那是 OSPF 的职责，
   * README 里记为已知边界。
   */
  /**
   * 为出站 IP 包选一条连接。
   *
   * 依据是包的**目标 IP**：对端的虚拟 IPv4 从它的 OSPF 广播里采集（`conn.ipv4`），
   * 用它做精确匹配。这样多对端场景下能发对人，而不是总是发给第一个。
   *
   * 三级回退（按"多确定"降序）：
   * 1. 目标 IP 精确匹配某条连接的对端虚拟 IP
   * 2. 都不匹配但**只有一条**连接 —— 单对端组网（两台机器），发它准没错
   * 3. 多条连接且都不匹配 —— 丢弃并记日志。**不能猜**：发错对端会让
   *    数据出现在别人的虚拟网里；而静默丢弃至少是"不通"而不是"串了"。
   */
  private pickConnectionFor(ipPacket: Buffer): {
    conn: Connection | null;
    /** 包头里该填的最终目标 peer_id（多跳时与 conn.remotePeerId 不同） */
    toPeerId: number;
  } {
    const header = decodeIpv4Header(ipPacket);
    const dstIp = header?.dst ?? null;

    // ① 按目标 IP 查拓扑，得到最终目标 peer_id
    const dstPeerId = dstIp === null ? null : this.topology.peerIdByIpv4(dstIp);
    if (dstPeerId !== null) {
      if (dstPeerId === this.options.myPeerId) {
        // 目标是自己：不该走网络（可能是我们广告的 IP 被误用）
        this.callbacks.onDataPlaneLog?.(
          `目标 IP ${dstIp} 是本机虚拟 IP，丢弃（不应回环发送）`,
        );
        return { conn: null, toPeerId: dstPeerId };
      }
      // ② 算下一跳：多跳时 nextHop ≠ 最终目标
      const hop = this.topology.nextHop(dstPeerId);
      if (hop !== null && hop !== this.options.myPeerId) {
        const conn = this.connectionFor(hop);
        if (conn !== null) {
          if (hop !== dstPeerId) {
            this.callbacks.onDataPlaneLog?.(
              `多跳转发：目标 ${dstPeerId} 经由邻居 ${hop}`,
            );
          }
          // 包头填**最终目标**，中间节点靠 to_peer_id 继续转发
          return { conn, toPeerId: dstPeerId };
        }
      }
    }

    // ③ 拓扑里没有该 IP（对端还没广播）→ 退回直连匹配
    const { peer, reason } = selectPeerForPacket(
      [...this.connections],
      dstIp,
    );
    if (reason === 'ambiguous') {
      this.callbacks.onDataPlaneLog?.(
        `多条连接但目标 IP ${dstIp ?? '未知'} 无匹配，丢弃该包（不猜，避免发错对端）`,
      );
    }
    return { conn: peer, toPeerId: peer?.remotePeerId ?? 0 };
  }

  /** 找一条到指定 peer 的连接（没有则 null）。 */
  private connectionFor(peerId: number): Connection | null {
    for (const conn of this.connections) {
      if (conn.remotePeerId === peerId) return conn;
    }
    return null;
  }

  private sendDataPacket(ipPacket: Buffer, relay?: { toPeerId: number; forwardCounter: number }): void {
    let conn: Connection | null;
    let toPeerId: number;
    let forwardCounter = 0;

    if (relay !== undefined) {
      // 中继：目标由包头指定，我们只负责找"到该目标的下一跳"
      toPeerId = relay.toPeerId;
      forwardCounter = relay.forwardCounter;
      const hop = this.topology.nextHop(toPeerId);
      conn =
        hop === null || hop === this.options.myPeerId
          ? null
          : this.connectionFor(hop);
      if (conn === null) {
        this.callbacks.onDataPlaneLog?.(
          `中继失败：目标 ${toPeerId} 无可用下一跳，丢弃`,
        );
        return;
      }
    } else {
      const picked = this.pickConnectionFor(ipPacket);
      conn = picked.conn;
      toPeerId = picked.toPeerId;
    }

    if (conn === null) {
      this.callbacks.onDataPlaneLog?.('发送数据包时没有匹配的连接，丢弃');
      return;
    }

    const sendKey = deriveTrafficKey(
      conn.rootKey,
      0,
      directionForSender(this.options.myPeerId, conn.remotePeerId),
    );
    const ciphertext = encryptPayload({
      key: sendKey,
      payload: ipPacket,
      epoch: 0,
      seq: conn.sendSeq,
      algorithm: this.options.algorithm ?? 'aes-gcm',
    });
    conn.sendSeq += 1n;

    const framed = framePacket(ciphertext, {
      fromPeerId: this.options.myPeerId,
      toPeerId,
      packetType: PacketType.Data,
      flags: PeerManagerHeaderFlags.ENCRYPTED,
      forwardCounter,
    });
    this.callbacks.onDataPlaneLog?.(
      `发送数据包 ${ipPacket.length}B → 下一跳 peer=${conn.remotePeerId}` +
        (toPeerId !== conn.remotePeerId ? `（最终目标 ${toPeerId}）` : '') +
        ` seq=${conn.sendSeq - 1n}`,
    );
    conn.socket.write(framed);
  }

  private sendRpc(conn: Connection, packet: RpcPacket, packetType: PacketType): void {
    const sendKey = deriveTrafficKey(
      conn.rootKey,
      0,
      directionForSender(this.options.myPeerId, conn.remotePeerId),
    );
    const ciphertext = encryptPayload({
      key: sendKey,
      payload: encodeRpcPacket(packet),
      epoch: 0,
      seq: conn.sendSeq,
      algorithm: this.options.algorithm ?? 'aes-gcm',
    });
    conn.sendSeq += 1n;

    conn.socket.write(
      framePacket(ciphertext, {
        fromPeerId: this.options.myPeerId,
        toPeerId: conn.remotePeerId,
        packetType,
        flags: PeerManagerHeaderFlags.ENCRYPTED,
      }),
    );
  }
}
