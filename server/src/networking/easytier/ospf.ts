/**
 * OSPF 路由同步的最小应答。
 *
 * ## 这一步解决什么问题
 *
 * Noise 握手完成后，对端会立刻发起 `SyncRouteInfo` RPC 同步路由拓扑，
 * 超时 3 秒（`peer_ospf_route.rs:3528`）。不应答时日志会持续出现：
 *
 * ```
 * sync_route_info failed ret=Err(Timeout(...)) my_peer_id=X dst_peer_id=Y
 * ```
 *
 * 应答后这条错误消失，对端认为拓扑同步完成、本节点在线。
 *
 * ## 我实际收到的请求（解密后）
 *
 * ```
 * field 1 varint = 4229893556     ← my_peer_id（对端自己）
 * field 2 varint = 15275333...    ← my_session_id
 * field 3 varint = 1              ← is_initiator
 * field 5 bytes(21) = ...         ← conn_bitmap（oneof conn_info）
 * ```
 *
 * ## 这一步"完成"意味着什么
 *
 * 它让**建连流程完整走通**：握手完成 + 对端认可本节点 + 开始收数据。
 * 但真正的 OSPF 收敛（把拓扑算成路由表、给系统提供可路由的虚拟网络）
 * 是 EasyTier 内核的职责，本实现不做，也不需要——我们的目的是
 * "作为一个节点存在于网络中"，而不是自己当路由器。
 *
 * ## 三个必须精确的细节（任一错就继续超时）
 *
 * 1. **方向按 peer_id 大小定**，不是按客户端/服务端角色
 * 2. **密钥要经 HKDF 派生**（`deriveTrafficKey`），不是 root_key 本身
 * 3. **算法 `aes-gcm` = AES-128**，不是 AES-256
 */

import {
  buildingRpcResponse,
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

export interface OspfSessionOptions {
  myPeerId: number;
  /** 连接级 peer_id（握手协商出的，用于 RPC 的 from/to 配对） */
  remotePeerId: number;
  /**
   * 对端在虚拟网络里的 my_peer_id。
   *
   * 与 `remotePeerId` **不是同一个值**，用途也不同：
   * - 加解密的**方向判断**用连接级 peer_id
   * - 包头里的 `to_peer_id` 必须用 my_peer_id，否则对端不解密直接丢包
   */
  remoteMyPeerId?: number;
  /** 从 Noise Msg2 拿到的 `root_key_32` */
  rootKey: Buffer;
  /** Msg2 的 `server_encryption_algorithm`，实测是 `aes-gcm` */
  algorithm: string;
  /** 初始 epoch（Msg2 的 `initial_epoch`，实测为 0） */
  epoch?: number;
}

/**
 * 一个已建立 Noise 会话的连接，能收发加密的 RPC。
 *
 * 这是"自研实现"的收口点：握手完成后用它跟对端交换加密消息。
 */
export class SecureChannel {
  private sendSeq = 0n;

  constructor(
    private readonly socket: Socket,
    private readonly options: OspfSessionOptions,
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

  /** 解密一个收到的载荷（返回明文 RPC 字节）。 */
  decrypt(payload: Buffer): Buffer {
    return decryptPayload({
      key: this.receiveKey(),
      ciphertextWithTail: payload,
      algorithm: this.options.algorithm,
    });
  }

  /**
   * 加密并发送一个 RPC 包。
   *
   * 加密后的布局是 `密文 || tag(16) || nonce(12)`，并且必须把
   * `PeerManagerHeader` 的 `ENCRYPTED` 标志置位——否则对端会拿它当明文解，
   * 直接认证失败。
   */
  /**
   * 发送一个 RPC 包。
   *
   * **包头里的 to_peer_id 必须等于对端的 my_peer_id**，而不是对端的
   * "连接级 peer_id"。这两个值是不同的：
   *
   * - `my_peer_id`：节点在虚拟网络里的身份（每个节点自己生成）
   * - 连接级 peer_id：握手协商出来的、用于这条连接上标识对端
   *
   * 对端在解密前会先检查 `hdr.to_peer_id != my_peer_id` 就**直接放行不解密**
   * （`peer_conn.rs:214`），于是我们的加密包被当成明文包丢掉——
   * 表现为"响应已发出但对端仍超时"，且日志里没有任何错误。
   *
   * 这个值由调用方通过 `remoteMyPeerId` 传入（从对端 RPC 的 to_peer 读，
   * 或从它广播的路由信息里读）。
   */
  /**
   * 发送一个 RPC 包，显式指定包头里的 `to_peer_id`。
   *
   * 必须用对端请求里的 `from_peer_id`，原因见 `handleOspfRequest` 里的说明。
   */
  sendRpcTo(packet: RpcPacket, toPeerId: number): void {
    const plaintext = encodeRpcPacket(packet);
    const ciphertext = encryptPayload({
      key: this.sendKey(),
      payload: plaintext,
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

  sendRpc(packet: RpcPacket): void {
    const plaintext = encodeRpcPacket(packet);
    const ciphertext = encryptPayload({
      key: this.sendKey(),
      payload: plaintext,
      epoch: this.options.epoch ?? 0,
      seq: this.sendSeq,
      algorithm: this.options.algorithm,
    });
    this.sendSeq += 1n;

    this.socket.write(
      framePacket(ciphertext, {
        fromPeerId: this.options.myPeerId,
        // 用对端的 my_peer_id，不是连接级 peer_id（见上面那段说明）
        toPeerId: this.options.remoteMyPeerId ?? this.options.remotePeerId,
        packetType: packet.isRequest ? PacketType.RpcReq : PacketType.RpcResp,
        flags: PeerManagerHeaderFlags.ENCRYPTED,
      }),
    );
  }

  /**
   * 尝试把收到的包当作 OSPF 同步请求处理。
   *
   * 返回 `true` 表示已识别并回应；`false` 表示不是 OSPF 请求（或解不开）。
   */
  handleOspfRequest(packet: ReceivedPacket): boolean {
    // 只处理加密的 RpcReq
    if (packet.header.packetType !== PacketType.RpcReq) return false;
    if (!hasFlag(packet.header, PeerManagerHeaderFlags.ENCRYPTED)) return false;

    let rpc: RpcPacket;
    try {
      rpc = decodeRpcPacket(this.decrypt(packet.payload));
    } catch {
      // 解不开就忽略：可能是别的 epoch/会话的消息，不该当成错误
      return false;
    }

    // 识别 OSPF 同步请求。
    //
    // **注意实际值与我最初的假设不同**（这是靠打印真实包才发现的）：
    //
    // | 字段 | 我假设 | 实际 |
    // | --- | --- | --- |
    // | protoName | `peer_rpc.OspfRouteRpc` | **`OspfRouteRpc`**（不带包名）|
    // | domainName | `""` | **网络名**（如 `e2e`）|
    // | methodIndex | 0 | **1** |
    //
    // 所以判定只认 `serviceName`/`protoName` 里的 `OspfRouteRpc`，
    // 不比对 domain（它随网络名变化）也不比对 methodIndex
    // （不同版本的同步方法索引可能不同）。
    if (!rpc.isRequest || rpc.descriptor === null) return false;
    const isOspf =
      rpc.descriptor.protoName.endsWith('OspfRouteRpc') ||
      rpc.descriptor.serviceName === 'OspfRouteRpc';
    if (!isOspf) return false;

    const request = decodeSyncRouteInfoRequest(rpc.body);


    // 回显 is_initiator 与 session_id 即可完成这次同步。
    // 不填 missing_peer_ids 表示"我没有缺失的拓扑数据"。
    const responseBody = encodeSyncRouteInfoResponse({
      isInitiator: request.isInitiator,
      sessionId: request.mySessionId,
      error: null,
      missingPeerIds: [],
      missingConnPeerIds: [],
    });

    // 响应的包头 from/to **直接由请求的 to/from 反转得到**，
    // 这样无论对端用哪个 id（连接级还是 my_peer_id），回程都能对上——
    // 因为对端自己发的请求里 from 就是"它希望被回复的地址"。
    //
    // 踩过的坑：我先用了连接级 peer_id 当 to，对端在解密前检查
    // `hdr.to_peer_id == 自己的 my_peer_id` 不通过就**直接放行不解密**，
    // 于是加密包被当明文丢掉，表现为"响应已发但对端仍超时"且无任何错误日志。
    this.sendRpcTo(buildingRpcResponse(rpc, responseBody), rpc.fromPeer);
    return true;
  }
}
