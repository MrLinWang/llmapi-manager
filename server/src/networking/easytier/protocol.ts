/**
 * EasyTier 线协议的 TypeScript 实现（备用实现 / 互通验证用）。
 *
 * ## 为什么会有这个文件
 *
 * 生产路径是 `native/easytier-node/`（Rust 库 + N-API），它直接复用官方实现，
 * 兼容性天然成立。但那条路需要 Rust 工具链，本地无法编译验证。
 *
 * 于是这里再实现一份纯 TypeScript 的协议层，作用有两个：
 * 1. **备用**：原生模块不可用、或平台不支持时，仍有一套可走通的实现
 * 2. **验证**：协议字段、包头字节布局、握手流程都可以用单元测试精确断言。
 *    这让"我们理解的协议"可以被检验，而不是只靠读 Rust 源码的印象。
 *
 * ## 兼容性的诚实边界
 *
 * 下面这些已经按 `ref/EasyTier/` 的源码逐字段核对：
 * - `PeerManagerHeader` 的字节布局（`packet/mod.rs`，16 字节，`#[repr(C, packed)]`）
 * - `PacketType` 枚举值与 `PeerManagerHeaderFlags` 位标志
 * - 握手算法 `Noise_XX_25519_ChaChaPoly_SHA256`（`peers/conn/peer_conn.rs:788`）
 * - peer 地址格式 `protocol://host:port`（`url::Url::parse`）
 *
 * 但**完整互通仍需要**：OSPF 路由广播（`peer_rpc.proto` 的 `RoutePeerInfo`）、
 * 凭证体系（X25519 + HMAC）、以及各隧道实现（tcp/udp/wg/quic）的细节。
 * 这些没有在这一份实现里全部完成——见 `route.ts` 与 `node.ts` 里的说明。
 */

/** 包头固定 16 字节。对照 `PeerManagerHeader` 的 `#[repr(C, packed)]` 布局。 */
export const PEER_MANAGER_HEADER_SIZE = 16;

/**
 * 包类型。数值必须与 `packet/mod.rs` 的 `PacketType` 完全一致——
 * 这些是线上字节，改一个数字就意味着与官方节点无法通信。
 */
export enum PacketType {
  Invalid = 0,
  Data = 1,
  HandShake = 2,
  RoutePacket = 3,
  Ping = 4,
  Pong = 5,
  TaRpc = 6,
  Route = 7,
  RpcReq = 8,
  RpcResp = 9,
  ForeignNetworkPacket = 10,
  KcpSrc = 11,
  KcpDst = 12,
  NoiseHandshakeMsg1 = 13,
  NoiseHandshakeMsg2 = 14,
  NoiseHandshakeMsg3 = 15,
  QuicSrc = 16,
  QuicDst = 17,
  DataWithKcpSrcModified = 18,
  DataWithQuicSrcModified = 19,
  RelayHandshake = 20,
  RelayHandshakeAck = 21,
}

/** 标志位。对照 `PeerManagerHeaderFlags` 的 bitflags 定义。 */
export const PeerManagerHeaderFlags = {
  ENCRYPTED: 0b0000_0001,
  LATENCY_FIRST: 0b0000_0010,
  EXIT_NODE: 0b0000_0100,
  NO_PROXY: 0b0000_1000,
  COMPRESSED: 0b0001_0000,
  LIVENESS_PROBE: 0b0010_0000,
  NOT_SEND_TO_TUN: 0b0100_0000,
  LIVENESS_ECHO: 0b1000_0000,
} as const;

export interface PeerManagerHeader {
  fromPeerId: number;
  toPeerId: number;
  packetType: PacketType;
  flags: number;
  forwardCounter: number;
  /** 载荷长度（不含包头） */
  len: number;
}

/**
 * 编码包头。
 *
 * 字段顺序与宽度严格照 `PeerManagerHeader`：
 * `from_peer_id: u32 | to_peer_id: u32 | packet_type: u8 | flags: u8 |
 *  forward_counter: u8 | reserved: u8 | len: u32`
 *
 * **字节序是 little-endian**：Rust 侧写的是 `U32<DefaultEndian>`，而
 * `packet/mod.rs:18` 定义 `type DefaultEndian = LittleEndian`。这一点很容易搞错——
 * 用大端写出来的包能通过自己的往返测试，却与官方节点完全无法通信。
 *
 * 注意 `reserved` 是**私有字段**（Rust 里没写 `pub`），但仍然占 1 字节——
 * 布局里它必须存在，否则后面的 `len` 会错位。
 */
export function encodeHeader(header: PeerManagerHeader): Buffer {
  const buffer = Buffer.alloc(PEER_MANAGER_HEADER_SIZE);
  buffer.writeUInt32LE(header.fromPeerId >>> 0, 0);
  buffer.writeUInt32LE(header.toPeerId >>> 0, 4);
  buffer.writeUInt8(header.packetType, 8);
  buffer.writeUInt8(header.flags & 0xff, 9);
  buffer.writeUInt8(header.forwardCounter & 0xff, 10);
  buffer.writeUInt8(0, 11); // reserved
  buffer.writeUInt32LE(header.len >>> 0, 12);
  return buffer;
}

/** 解码包头。数据不足 16 字节时返回 null（半包，等更多数据）。 */
export function decodeHeader(buffer: Buffer): PeerManagerHeader | null {
  if (buffer.length < PEER_MANAGER_HEADER_SIZE) return null;
  return {
    fromPeerId: buffer.readUInt32LE(0),
    toPeerId: buffer.readUInt32LE(4),
    packetType: buffer.readUInt8(8) as PacketType,
    flags: buffer.readUInt8(9),
    forwardCounter: buffer.readUInt8(10),
    // byte 11 是 reserved，读出来丢弃
    len: buffer.readUInt32LE(12),
  };
}

export function hasFlag(header: PeerManagerHeader, flag: number): boolean {
  return (header.flags & flag) !== 0;
}

export function setFlag(
  header: PeerManagerHeader,
  flag: number,
  enabled: boolean,
): PeerManagerHeader {
  return {
    ...header,
    flags: enabled ? header.flags | flag : header.flags & ~flag,
  };
}

/** 是否是握手包。对照 `peer_conn.rs:126` 的判定。 */
export function isHandshakePacket(type: PacketType): boolean {
  return (
    type === PacketType.NoiseHandshakeMsg1 ||
    type === PacketType.NoiseHandshakeMsg2 ||
    type === PacketType.NoiseHandshakeMsg3 ||
    type === PacketType.RelayHandshake ||
    type === PacketType.RelayHandshakeAck
  );
}
