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
    this.staticKeyPair = options.staticPrivateKey
      ? {
          privateKey: options.staticPrivateKey,
          publicKey: publicKeyFromPrivate(options.staticPrivateKey),
        }
      : generateKeyPair();
  }

  /** 开始监听。resolve 表示端口已绑定。 */
  async start(): Promise<void> {
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
    for (const conn of this.connections) conn.socket.destroy();
    this.connections.clear();
    await new Promise<void>((resolve) => {
      if (this.server === null) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
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
      if (process.env.EASYTIER_ACCEPTOR_DEBUG) {
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
          process.stdout.write(
            `[ts-acceptor] 广播响应: txn=${respRpc.transactionId} error=${JSON.stringify(
              unwrapped.error,
            )} payload=${unwrapped.response.toString('hex').slice(0, 60)}\n`,
          );
        } catch (e) {
          process.stdout.write(
            `[ts-acceptor] 广播响应解码失败: ${(e as Error).message}\n`,
          );
        }
      }
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

    if (process.env.EASYTIER_ACCEPTOR_DEBUG) {
      process.stdout.write(
        `[ts-acceptor] 收到 OSPF 请求 body=${rpc.body.toString('hex').slice(0, 120)}\n`,
      );
    }
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
    if (process.env.EASYTIER_ACCEPTOR_DEBUG) {
      // 对端广播的 peer_infos 里有没有我们？有 = 它的 OSPF 图已经学到本节点
      process.stdout.write(
        `[ts-acceptor] 对端 peer_infos: ${JSON.stringify(
          learned.map((r) => ({ id: r.peerId, host: r.hostname })),
        )}\n`,
      );
    }

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
    }
  }

  /** 构造并发送自己的 `SyncRouteInfo` 请求（让对端把本节点加进路由表）。 */
  private advertiseRoute(conn: Connection): void {
    const directPeers = [...this.connections].map((c) => c.remotePeerId);
    // ipv4 是路由安装的必要条件：官方 OSPF 路由表按 IPv4 组织，
    // 无虚拟 IP 的节点进不了路由表（实测踩过：连接/应答都正常，
    // 但对端 peer 列表主机名一直是 peer-<id> 兜底）。
    const ip = this.options.virtualIpv4 ?? null;
    const route: RoutePeerInfo = {
      peerId: this.options.myPeerId,
      cost: 1,
      hostname: this.options.hostname ?? null,
      version: 1,
      easytierVersion: '2.7.0',
      proxyCidrs: [],
      peerRouteId: Date.now() % 0x7fffffff,
      networkLength: ip === null ? 0 : 24,
      ipv4Addr: ip,
      // 带上我们的 Noise 静态公钥：官方做 relay 握手时需要它
      noiseStaticPubkey: this.staticKeyPair.publicKey,
    };

    // SyncRouteInfoRequest：my_peer_id(1) + my_session_id(2) + is_initiator(3)
    //                      + peer_infos(4) + conn_peer_list(7, oneof)
    const innerInfos = encodeRoutePeerInfos([route]);

    // conn_info：告诉对端"谁和谁直连"。路由表的下一跳图完全由各节点的
    // conn_info 拼出来——只发 peer_infos 不发 conn_info，图里就没有
    // "TS ↔ 对端"这条边，`get_next_hop` 拿不到下一跳，路由装不上，
    // 对端的 peer 列表里主机名永远是 peer-<id> 兜底。踩过。
    //
    // 用 conn_peer_list 分支（peer_ospf_route.rs:1458 的 update_conn_info
    // 两种 oneof 都支持），语义直白：本节点直连着对端。
    const connPeerList = Buffer.concat([
      encodeBytesField(
        1, // RouteConnPeerList.peer_conn_infos
        Buffer.concat([
          encodeBytesField(
            1, // PeerConnInfo.peer_id
            encodePeerIdVersion(this.options.myPeerId, 1),
          ),
          ...directPeers.map(
            (peerId) => encodeVarintField(2, peerId), // PeerConnInfo.connected_peer_ids
          ),
        ]),
      ),
    ]);

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
    if (process.env.EASYTIER_ACCEPTOR_DEBUG) {
      process.stdout.write(
        `[ts-acceptor] descriptor=${JSON.stringify(packet.descriptor)}\n` +
        `[ts-acceptor] 广播 body=${body.toString('hex')}\n` +
          `[ts-acceptor] 自解 peer_infos=${JSON.stringify(
            decodeRoutePeerInfos(innerInfos).map((r) => ({
              id: r.peerId,
              host: r.hostname,
              ver: r.version,
            })),
          )} conn=${connPeerList.toString('hex')}\n`,
      );
    }
    this.sendRpc(conn, packet, PacketType.RpcReq);
    this.callbacks.onRouteAdvertised?.();
  }

  /** 加密并发送一个 RPC 包（nonce 序列号每连接从 0 递增）。 */
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
