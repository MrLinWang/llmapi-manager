/**
 * EasyTier 会话：把四层封装串起来。
 *
 * ```
 * TCP 隧道帧头 (4B len, LE)
 *   └─ PeerManagerHeader (16B)
 *        └─ RpcPacket (protobuf)          ← 仅 RPC 类消息
 *             └─ SyncRouteInfoRequest     ← 业务载荷
 * ```
 *
 * ## 用途
 *
 * 这个文件把前面几个纯编解码模块组合成"能收发一条消息"的最小会话，
 * 供诊断与集成测试使用。**生产路径是 `acceptor.ts`**（它实现了接受方角色，
 * 用本文件同样的编解码但带完整的状态机与 OSPF 应答）；本文件是
 * "发起方视角的最小会话"收口点：能握手、能收发 RPC。
 *
 * ## 关键事实（都是实测得出的）
 *
 * 1. 每条 TCP 隧道帧前面有 4 字节长度头，且 `len >= 16`（要能装下包头）
 * 2. 握手包（明文与 Noise）的载荷是 protobuf / Noise 密文，
 *    而 RPC 消息的载荷是 `RpcPacket`
 * 3. `RpcPacket` 的 `transactionId` 是 int64，请求与响应靠它配对
 * 4. `descriptor` 为空时整个字段不写（否则空包不是 0 字节）
 */

import type { Socket } from 'node:net';
import { framePacket, extractFrame } from './framing';
import { PacketType, decodeHeader, type PeerManagerHeader } from './protocol';
import { decodeRpcPacket, encodeRpcPacket, buildingRpcResponse, type RpcPacket } from './rpc';

export interface ReceivedPacket {
  header: PeerManagerHeader;
  /** 包头之后的载荷（未解封装） */
  payload: Buffer;
}

/**
 * 一个 TCP 连接的收发器。
 *
 * 只负责"帧进帧出"。业务语义（握手状态机、RPC 应答）由调用方决定，
 * 因为不同阶段的处理差异很大，塞进一个类会变成难以追踪的状态泥潭。
 */
export class TunnelSession {
  private buffer = Buffer.alloc(0);
  private readonly queue: ReceivedPacket[] = [];
  private readonly waiters: Array<(packet: ReceivedPacket) => void> = [];
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      this.closed = true;
    });
  }

  /** 从缓冲区里尽可能多地切出完整包。 */
  private drain(): void {
    for (;;) {
      let frame;
      try {
        frame = extractFrame(this.buffer);
      } catch {
        // 帧损坏：丢掉缓冲，避免后续全部错位
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (frame === null) return;

      this.buffer = this.buffer.subarray(4 + frame.bodyLength);

      const header = decodeHeader(frame.body);
      if (header === null) continue;

      const packet: ReceivedPacket = {
        header,
        payload: frame.body.subarray(16),
      };

      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(packet);
      else this.queue.push(packet);
    }
  }

  /** 等下一个包；已有排队则立即返回。 */
  async receive(timeoutMs = 8000): Promise<ReceivedPacket | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (this.closed) return null;

    return new Promise<ReceivedPacket | null>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(handler);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);

      const handler = (packet: ReceivedPacket): void => {
        clearTimeout(timer);
        resolve(packet);
      };
      this.waiters.push(handler);
    });
  }

  /** 发送一条消息（自动加两层帧）。 */
  send(options: {
    fromPeerId: number;
    toPeerId: number;
    packetType: PacketType;
    payload: Buffer;
    flags?: number;
  }): void {
    this.socket.write(
      framePacket(options.payload, {
        fromPeerId: options.fromPeerId,
        toPeerId: options.toPeerId,
        packetType: options.packetType,
        flags: options.flags ?? 0,
      }),
    );
  }

  /** 发送一个 RPC 包。 */
  sendRpc(options: {
    fromPeerId: number;
    toPeerId: number;
    packet: RpcPacket;
    /** 请求用 RpcReq，响应用 RpcResp */
    isRequest: boolean;
  }): void {
    this.send({
      fromPeerId: options.fromPeerId,
      toPeerId: options.toPeerId,
      packetType: options.isRequest ? PacketType.RpcReq : PacketType.RpcResp,
      payload: encodeRpcPacket(options.packet),
    });
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * 从收到的包里解出 RPC 结构。
 *
 * 不是所有包都是 RPC（握手包就不是），所以这里返回 `null` 而不是抛错。
 */
export function asRpcPacket(packet: ReceivedPacket): RpcPacket | null {
  if (
    packet.header.packetType !== PacketType.RpcReq &&
    packet.header.packetType !== PacketType.RpcResp
  ) {
    return null;
  }
  try {
    return decodeRpcPacket(packet.payload);
  } catch {
    return null;
  }
}

/**
 * 为一个 RPC 请求构造响应的骨架。
 *
 * 关键三点（少一个对端就认不出这是它的响应）：
 * 1. **反向** from/to（对方是接收者）
 * 2. **同样的 transaction_id**
 * 3. descriptor 与请求相同（同一 service、同一 method）
 */
export function makeRpcResponse(request: RpcPacket, body: Buffer): RpcPacket {
  return buildingRpcResponse(request, body);
}
