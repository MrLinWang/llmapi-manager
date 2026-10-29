/**
 * 已建立 Noise 会话的连接通道，以及 OSPF 同步应答的**实验性**实现。
 *
 * # 状态：部分能力已验证，应答能力**不可用于生产**
 *
 * 这个文件把"已验证"与"未验证"分成两块，请看 `SecureChannel` 的类注释。
 *
 * - ✅ **已验证**：解密对端的加密 RPC、派生 traffic key、编码/解码 `RpcPacket`
 * - ⚠️ **未验证**：回一个 `SyncRouteInfoResponse` 让对端接受
 *
 * 未验证的部分不是"再调几个字段"就能通的，而是与官方的**连接角色模型**
 * 冲突。详见下面 `handleOspfRequest` 的说明。这个结论是穷举实验得出的，
 * 不是猜测。
 */

import {
  buildWrappedRpcResponse,
  decodeRpcPacket,
  decodeSyncRouteInfoRequest,
  encodeRpcPacket,
  encodeSyncRouteInfoResponse,
  type RpcPacket,
} from './rpc';
import { PacketType, hasFlag, PeerManagerHeaderFlags } from './protocol';
import { decryptPayload, deriveTrafficKey, directionForSender, encryptPayload } from './dataPlane';
import { framePacket } from './framing';
import type { Socket } from 'node:net';
import type { ReceivedPacket } from './session';

export interface SecureChannelOptions {
  /** 本节点的 peer id（握手时在 Msg1 里声明的那个） */
  myPeerId: number;
  /** 握手协商出的对端连接级 peer_id，用于**加解密的方向判断** */
  remotePeerId: number;
  /** 从 Noise Msg2 拿到的 `root_key_32` */
  rootKey: Buffer;
  /** Msg2 的 `server_encryption_algorithm`，实测是 `aes-gcm` */
  algorithm: string;
  /** 初始 epoch（Msg2 的 `initial_epoch`，实测为 0） */
  epoch?: number;
}

/**
 * 一条已完成 Noise 握手的连接，能收发加密的 RPC。
 *
 * ## 哪些能力经过实证
 *
 * **解密（可靠）**：能成功解开官方节点发来的加密 `RpcReq`。这是硬证据——
 * 拿到过真实的 `SyncRouteInfoRequest` 明文，字段全部对得上：
 *
 * ```
 * field 1 varint = 4229893556     ← my_peer_id（对端自己）
 * field 2 varint = 15275333...    ← my_session_id
 * field 3 varint = 1              ← is_initiator
 * field 5 bytes(21) = ...         ← conn_bitmap
 * ```
 *
 * 这条路径依赖三件事，都已验证：HKDF 派生 traffic key、`aes-gcm` 是 AES-128、
 * 方向按 peer_id 大小判定。
 *
 * **应答（不可用）**：加密应答能发出去，但对端**不接受**。见
 * `handleOspfRequest` 的说明。
 */
export class SecureChannel {
  private sendSeq = 0n;

  constructor(
    private readonly socket: Socket,
    private readonly options: SecureChannelOptions,
  ) {}

  /** 接收方向（对端发给我）的密钥。 */
  private receiveKey(): Buffer {
    return deriveTrafficKey(
      this.options.rootKey,
      this.options.epoch ?? 0,
      directionForSender(this.options.remotePeerId, this.options.myPeerId),
    );
  }

  /** 发送方向（我发给对端）的密钥。 */
  private sendKey(): Buffer {
    return deriveTrafficKey(
      this.options.rootKey,
      this.options.epoch ?? 0,
      directionForSender(this.options.myPeerId, this.options.remotePeerId),
    );
  }

  /**
   * 解密一个收到的载荷，返回明文字节。
   *
   * 用于观察对端发了什么——这是本模块**最可靠**的能力。
   */
  decrypt(payload: Buffer): Buffer {
    return decryptPayload({
      key: this.receiveKey(),
      ciphertextWithTail: payload,
      algorithm: this.options.algorithm,
    });
  }

  /**
   * 尝试把收到的包解成 `RpcPacket`。
   *
   * 返回 `null` 表示不是加密 RPC（或是别的东西）——调用方应当忽略而不是报错：
   * 同一连接上还有 Ping/Pong 等控制包，解不开是正常情况。
   */
  decodeRpc(packet: ReceivedPacket): RpcPacket | null {
    if (!hasFlag(packet.header, PeerManagerHeaderFlags.ENCRYPTED)) return null;
    try {
      return decodeRpcPacket(this.decrypt(packet.payload));
    } catch {
      return null;
    }
  }

  /**
   * 加密并发送一个 RPC 包。
   *
   * ## 加密细节（均已验证）
   *
   * - 布局是 `密文 || tag(16) || nonce(12)`，nonce 在**尾部**
   * - `nonce = epoch(4B BE) || seq(8B BE)`，seq 每个方向独立从 0 递增
   * - 必须置 `ENCRYPTED` 标志，否则对端会拿它当明文解、直接认证失败
   *
   * ## 包头里的 id
   *
   * `toPeerId` 需要显式传入，因为**对端检查的字段随场景而变**，
   * 没有一个总是正确的取值（见 `handleOspfRequest`）。
   */
  sendRpcTo(packet: RpcPacket, toPeerId: number): void {
    const ciphertext = encryptPayload({
      key: this.sendKey(),
      payload: encodeRpcPacket(packet),
      epoch: this.options.epoch ?? 0,
      seq: this.sendSeq,
      algorithm: this.options.algorithm,
    });
    this.sendSeq += 1n;

    this.socket.write(
      framePacket(ciphertext, {
        fromPeerId: this.options.myPeerId,
        toPeerId,
        packetType: packet.isRequest ? PacketType.RpcReq : PacketType.RpcResp,
        flags: PeerManagerHeaderFlags.ENCRYPTED,
      }),
    );
  }

  /**
   * 尝试回应一个 OSPF 同步请求。
   *
   * # ⚠️ 这个能力**经实测不可用**，不要在生产里依赖
   *
   * 它能正确识别请求、构造出结构正确的响应并加密发出，但**对端不会接受**。
   * 原因是官方的连接角色模型，而不是字段填错：
   *
   * 对端在解密前会先做这个检查（`peer_conn.rs:205`）：
   *
   * ```rust
   * if from_peer_id != peer_id { return Some(Ok(data)); }  // 不解密，直接放行
   * ```
   *
   * `peer_id` 是"这条连接的对端 id"，实测等于对端**自己的** `my_peer_id`。
   * 于是形成死结：
   *
   * | `from_peer_id` 取值 | 结果 |
   * | --- | --- |
   * | 本节点 id（语义正确） | 检查不通过 → 静默丢弃，或当明文放行 |
   * | 对端 id（能进解密分支） | 通过了检查，但密钥方向对不上 → `secure decrypt failed` |
   *
   * 我穷举了 6 种（方向 × from × to）组合，无一成功。而
   * `rpc/client.rs:183` 的 "Received non-response packet" 日志一次都没出现，
   * 说明包**根本没有到达 RPC 层**。
   *
   * ## 为什么这不是"再试试"能解决的
   *
   * 官方把连接分为**发起方 / 接受方**，`RpcResp` 只由接受方回给发起方。
   * 本实现是发起方（主动连出去），去回 `RpcResp` 会撞上上面那个检查。
   *
   * 真要打通，必须让本实现充当**接受方**：自己监听端口等官方节点连进来，
   * 并用 Noise 握手的服务端方向（`do_noise_handshake_as_server`）。
   *
   * **这条路已经走通，但不在本文件**：见 `acceptor.ts`（它用
   * `NoiseXXResponder` 实现服务端方向 + admission 校验 + OSPF 应答，
   * 已用官方节点实测通过）。本方法保留下来是为了**记录结论**，不是可用功能。
   * 返回 `true` 只表示"识别到并尝试回应了"，不代表对端接受了它。
   *
   * 一句话：**生产用 `acceptor.ts`，这里的 `handleOspfRequest` 只是协议参考。**
   */
  handleOspfRequest(packet: ReceivedPacket): boolean {
    if (packet.header.packetType !== PacketType.RpcReq) return false;

    const rpc = this.decodeRpc(packet);
    if (rpc === null || !rpc.isRequest || rpc.descriptor === null) return false;

    // 识别 OSPF 同步请求的实测定论（与最初的假设不同）：
    //
    // | 字段 | 假设 | 实际 |
    // | --- | --- | --- |
    // | protoName | `peer_rpc.OspfRouteRpc` | `OspfRouteRpc`（不带包名）|
    // | domainName | `""` | 网络名（如 `e2e`）|
    // | methodIndex | 0 | 1 |
    //
    // 所以只认服务名，不比对 domain（随网络名变）与 methodIndex（版本相关）。
    const isOspf =
      rpc.descriptor.protoName.endsWith('OspfRouteRpc') ||
      rpc.descriptor.serviceName === 'OspfRouteRpc';
    if (!isOspf) return false;

    const request = decodeSyncRouteInfoRequest(rpc.body);

    // 回显 is_initiator 与 session_id 即可完成这次同步；
    // 不填 missing_peer_ids 表示"我没有缺失的拓扑数据"。
    const responseBody = encodeSyncRouteInfoResponse({
      isInitiator: request.isInitiator,
      sessionId: request.mySessionId,
      error: null,
      missingPeerIds: [],
      missingConnPeerIds: [],
    });

    // 注意必须走 buildWrappedRpcResponse：业务消息要先包进 RpcResponse
    // 再放进 RpcPacket.body。对端是 `RpcResponse::decode(rpc_packet.body)`
    // （`rpc/client.rs:387`），直接放业务消息会让它解出错误的东西。
    this.sendRpcTo(buildWrappedRpcResponse(rpc, responseBody), rpc.fromPeer);
    return true;
  }
}
