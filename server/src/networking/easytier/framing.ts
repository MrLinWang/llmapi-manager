/**
 * TCP 隧道的帧封装。
 *
 * ## 为什么需要它（这里踩过一个很典型的坑）
 *
 * 最初我按 `peer_conn.rs:560` 的 `req.encode_to_vec()` 认为握手包就是裸
 * protobuf，直接写进 socket。对端返回：
 *
 * ```
 * InvalidPacket("body too long")
 * ```
 *
 * 因为 TCP 隧道是**带帧头**的（`tunnel/framed.rs:68`）：它先读 4 字节长度，
 * 把那个位置的字节当成 `body_len`。裸 protobuf 的第一个字节正好是
 * 字段 tag（例如 `0x08`），于是被当成"长度 8"或某个更大的数，
 * 与剩余字节对不上就报 `body too long`。
 *
 * `encode_to_vec()` 只说明"握手内容本身是 protobuf"，不说明"整条 TCP 流
 * 里它就是全部"——中间还有一层帧。
 *
 * ## 完整结构
 *
 * ```
 * ┌────────────────┬──────────────────────┬─────────────────┐
 * │ TCPTunnelHeader│ PeerManagerHeader    │ 载荷             │
 * │ 4 字节 len (LE)│ 16 字节              │ protobuf         │
 * └────────────────┴──────────────────────┴─────────────────┘
 *                  └────────── len 覆盖这部分 ──────────┘
 * ```
 *
 * 两个约束（`framed.rs:70-77`）：
 * - `len` 是**小端** u32（`U32<DefaultEndian>`，同包头）
 * - `len` 必须 ≥ `PEER_MANAGER_HEADER_SIZE`(16)，否则报 `body too short`
 */

import { PEER_MANAGER_HEADER_SIZE, PacketType, encodeHeader } from './protocol';

/** TCP 隧道帧头大小：一个 u32。 */
export const TCP_TUNNEL_HEADER_SIZE = 4;

/**
 * 打包一条 TCP 隧道帧。
 *
 * @param payload 载荷（握手时是 protobuf 字节）
 * @param options.peerManagerHeader 是否在载荷前加 `PeerManagerHeader`。
 *   握手包**需要**（对端要求 `len >= 16`）；某些控制包可能不需要。
 */
export function framePacket(
  payload: Buffer,
  options: {
    fromPeerId: number;
    toPeerId: number;
    packetType: PacketType;
    flags?: number;
    forwardCounter?: number;
    peerManagerHeader?: boolean;
  },
): Buffer {
  const withHeader = options.peerManagerHeader ?? true;

  const body = withHeader
    ? Buffer.concat([
        encodeHeader({
          fromPeerId: options.fromPeerId,
          toPeerId: options.toPeerId,
          packetType: options.packetType,
          flags: options.flags ?? 0,
          forwardCounter: options.forwardCounter ?? 0,
          // 包头里的 len 是"包头之后的载荷长度"
          len: payload.length,
        }),
        payload,
      ])
    : payload;

  const tunnelHeader = Buffer.alloc(TCP_TUNNEL_HEADER_SIZE);
  tunnelHeader.writeUInt32LE(body.length, 0);

  return Buffer.concat([tunnelHeader, body]);
}

export interface FramedPacket {
  /** 帧头声明的 body 长度 */
  bodyLength: number;
  /** 完整 body（含 PeerManagerHeader 与载荷） */
  body: Buffer;
}

/**
 * 从接收缓冲里切出一帧。
 *
 * 返回 `null` 表示数据还不够（半包），调用方应继续等待——这与
 * `extract_one_packet` 的行为一致（`framed.rs:64` 的 `return None`）。
 */
export function extractFrame(buffer: Buffer, maxPacketSize = 4 * 1024 * 1024): FramedPacket | null {
  if (buffer.length < TCP_TUNNEL_HEADER_SIZE) return null;

  const bodyLength = buffer.readUInt32LE(0);
  if (bodyLength > maxPacketSize) {
    throw new Error(`帧长度 ${bodyLength} 超过上限 ${maxPacketSize}，数据可能已损坏`);
  }
  if (bodyLength < PEER_MANAGER_HEADER_SIZE) {
    throw new Error(
      `帧长度 ${bodyLength} 小于包头大小 ${PEER_MANAGER_HEADER_SIZE}（对端要求 body_len >= 16）`,
    );
  }
  if (buffer.length < TCP_TUNNEL_HEADER_SIZE + bodyLength) return null;

  return {
    bodyLength,
    body: buffer.subarray(TCP_TUNNEL_HEADER_SIZE, TCP_TUNNEL_HEADER_SIZE + bodyLength),
  };
}
