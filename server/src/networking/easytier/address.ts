/**
 * EasyTier 的地址与拓扑结构编解码。
 *
 * 对照 `easytier-proto/proto/common.proto` 的
 * `Ipv4Addr` / `Ipv4Inet` / `SocketAddr` / `Url` / `TunnelInfo`。
 *
 * ## 一个容易搞错的点：`Ipv4Addr.addr` 是 uint32 varint
 *
 * 它**不是** 4 字节网络序的定长字段，而是标准的 protobuf varint。
 * 例如 `10.126.126.1`：
 *
 * ```
 * 点分表示    10.126.126.1
 * 数值        0x0A7E7E01 = 176061953
 * protobuf    08 81 FC F9 53
 *                    └─ varint(176061953)，5 字节含 continuation bit
 * ```
 *
 * 所以"把 IP 转成 4 字节再写进去"是错的；必须转成 u32 数值再 varint 编码。
 * 同理解码时要按 varint 读，不能按 `readUInt32BE` 读——后者会把
 * continuation bit 当成数据的一部分，得到完全错误的值。
 */

import {
  decodeFields,
  encodeBytesField,
  encodeStringField,
  encodeVarintField,
  getAllBytes,
  getBytes,
  getVarint,
} from './protobuf';

/** `Ipv4Addr` 字段号（`common.proto:191`）。 */
export const Ipv4AddrField = { addr: 1 } as const;

/** 把一个 IPv4 点分地址转成 u32 数值（主机序，即 `u32::from_be_bytes`）。 */
export function ipv4ToNumber(dotted: string): number {
  const parts = dotted.split('.');
  if (parts.length !== 4) throw new Error(`IPv4 地址必须四段：${dotted}`);
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`IPv4 段不是数字：${part}`);
    const num = Number.parseInt(part, 10);
    if (num > 255) throw new Error(`IPv4 段超过 255：${part}`);
    // 左移相当于按大端拼装，得到的数值与 Rust 的 u32::from_be_bytes 一致
    value = value * 256 + num;
  }
  return value;
}

/** u32 数值 → IPv4 点分地址。 */
export function numberToIpv4(value: number): string {
  if (value < 0 || value > 0xffffffff) throw new Error(`超出 u32 范围：${value}`);
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/** 编码 `Ipv4Addr`。proto3：addr 为 0 时不写（但 0.0.0.0 是合法地址，需调用方注意）。 */
export function encodeIpv4Addr(dotted: string): Buffer {
  return encodeVarintField(Ipv4AddrField.addr, ipv4ToNumber(dotted));
}

/** 解码 `Ipv4Addr`。 */
export function decodeIpv4Addr(buffer: Buffer): string {
  const fields = decodeFields(buffer);
  return numberToIpv4(getVarint(fields, Ipv4AddrField.addr) ?? 0);
}

/** `Ipv4Inet` 字段号（`common.proto:207`）。 */
export const Ipv4InetField = { address: 1, networkLength: 2 } as const;

export interface Ipv4Inet {
  /** 点分地址 */
  address: string;
  /** 网段长度（如 24） */
  networkLength: number;
}

/** 编码 `Ipv4Inet`。 */
export function encodeIpv4Inet(inet: Ipv4Inet): Buffer {
  const parts: Buffer[] = [];
  const addr = ipv4ToNumber(inet.address);
  if (addr !== 0) {
    parts.push(encodeBytesField(Ipv4InetField.address, encodeVarintField(Ipv4AddrField.addr, addr)));
  }
  if (inet.networkLength !== 0) {
    parts.push(encodeVarintField(Ipv4InetField.networkLength, inet.networkLength));
  }
  return Buffer.concat(parts);
}

/** 解码 `Ipv4Inet`。 */
export function decodeIpv4Inet(buffer: Buffer): Ipv4Inet {
  const fields = decodeFields(buffer);
  const addrBytes = getBytes(fields, Ipv4InetField.address);
  return {
    address: addrBytes === null ? '0.0.0.0' : decodeIpv4Addr(addrBytes),
    networkLength: getVarint(fields, Ipv4InetField.networkLength) ?? 0,
  };
}

/** `SocketAddr` 字段号（`common.proto:226`）。注意 ip 是 oneof。 */
export const SocketAddrField = { ipv4: 1, ipv6: 2, port: 3 } as const;

export interface SocketAddr {
  ipv4: string | null;
  port: number;
}

/** 编码 `SocketAddr`（只支持 ipv4 分支）。 */
export function encodeSocketAddr(addr: SocketAddr): Buffer {
  const parts: Buffer[] = [];
  if (addr.ipv4 !== null) {
    parts.push(encodeBytesField(SocketAddrField.ipv4, encodeIpv4Addr(addr.ipv4)));
  }
  if (addr.port !== 0) {
    parts.push(encodeVarintField(SocketAddrField.port, addr.port));
  }
  return Buffer.concat(parts);
}

/** 解码 `SocketAddr`。oneof 里只有 ipv4 被我们实现（ipv6 暂不支持）。 */
export function decodeSocketAddr(buffer: Buffer): SocketAddr {
  const fields = decodeFields(buffer);
  const ipv4Bytes = getBytes(fields, SocketAddrField.ipv4);
  return {
    ipv4: ipv4Bytes === null ? null : decodeIpv4Addr(ipv4Bytes),
    port: getVarint(fields, SocketAddrField.port) ?? 0,
  };
}

/** `Url` 字段号（`common.proto:224`）。 */
export const UrlField = { url: 1 } as const;

export function encodeUrl(url: string): Buffer {
  return encodeStringField(UrlField.url, url);
}

export function decodeUrl(buffer: Buffer): string {
  return getBytes(decodeFields(buffer), UrlField.url)?.toString('utf8') ?? '';
}

/** `TunnelInfo` 字段号（`common.proto:234`）。 */
export const TunnelInfoField = {
  tunnelType: 1,
  localAddr: 2,
  remoteAddr: 3,
  resolvedRemoteAddr: 4,
} as const;

export interface TunnelInfo {
  /** `tcp` / `udp` / `wg` / `quic` / `ws` 等（这是字符串，不是 SocketType 枚举） */
  tunnelType: string;
  localAddr: string | null;
  remoteAddr: string | null;
  resolvedRemoteAddr: string | null;
}

export function encodeTunnelInfo(info: TunnelInfo): Buffer {
  const parts: Buffer[] = [];
  if (info.tunnelType !== '') {
    parts.push(encodeStringField(TunnelInfoField.tunnelType, info.tunnelType));
  }
  if (info.localAddr !== null) {
    parts.push(encodeBytesField(TunnelInfoField.localAddr, encodeUrl(info.localAddr)));
  }
  if (info.remoteAddr !== null) {
    parts.push(encodeBytesField(TunnelInfoField.remoteAddr, encodeUrl(info.remoteAddr)));
  }
  if (info.resolvedRemoteAddr !== null) {
    parts.push(
      encodeBytesField(TunnelInfoField.resolvedRemoteAddr, encodeUrl(info.resolvedRemoteAddr)),
    );
  }
  return Buffer.concat(parts);
}

export function decodeTunnelInfo(buffer: Buffer): TunnelInfo {
  const fields = decodeFields(buffer);
  const local = getBytes(fields, TunnelInfoField.localAddr);
  const remote = getBytes(fields, TunnelInfoField.remoteAddr);
  const resolved = getBytes(fields, TunnelInfoField.resolvedRemoteAddr);
  return {
    tunnelType: getBytes(fields, TunnelInfoField.tunnelType)?.toString('utf8') ?? '',
    localAddr: local === null ? null : decodeUrl(local),
    remoteAddr: remote === null ? null : decodeUrl(remote),
    resolvedRemoteAddr: resolved === null ? null : decodeUrl(resolved),
  };
}

/**
 * `NatType` 枚举（`common.proto:177`）。
 *
 * 这些值出现在路由广播的 `udp_nat_type` / `tcp_nat_type` 里，
 * 用于判断"这个节点是否适合当直连对端"。
 */
export const NatType = {
  Unknown: 0,
  OpenInternet: 1,
  NoPAT: 2,
  FullCone: 3,
  Restricted: 4,
  PortRestricted: 5,
  Symmetric: 6,
  SymUdpFirewall: 7,
  SymmetricEasyInc: 8,
  SymmetricEasyDec: 9,
} as const;

/**
 * `SocketType` 枚举（`common.proto:264`）。
 *
 * **只有 TCP/UDP 两种**。隧道类型字符串（`tcp`/`wg`/`quic`…）不是这个枚举——
 * 这一点容易混淆，因为它们看起来是同一类概念。
 */
export const SocketType = { TCP: 0, UDP: 1 } as const;

/**
 * 连接位图（`RouteConnBitmap`）。
 *
 * ## 这是 OSPF 拓扑同步的核心结构
 *
 * 它把"谁和谁相连"的邻接矩阵压缩成位图：
 *
 * ```
 * peer_ids[i] 连到 peer_ids[j]  ⟺  bit[i * n + j] == 1
 * 位序：字节内 LSB 优先  →  (bitmap[idx/8] >> (idx%8)) & 1
 * ```
 *
 * 对照 `peer_rpc.rs:226`（`get_bit`）与 `:233`（`get_connected_peers`）。
 *
 * ## 两处都极易搞错，且错了不会报错
 *
 * 1. **展平顺序**：`i * n + j` 是行优先的邻接矩阵。若误用 `j * n + i`
 *    （列优先），得到的是转置矩阵——在对称的连通关系里看起来"差不多对"，
 *    但有向连接（如 A 能看到 B 而 B 看不到 A）会完全颠倒。
 * 2. **位序**：LSB 优先而非 MSB 优先。搞反时相邻节点的位置会镜像，
 *    拓扑图看起来"有连接但连错了人"。
 *
 * 这类错误不会抛异常，只会给出一张错误但自洽的拓扑——所以必须靠
 * 官方向量对照（本文件的测试就是这么做的）。
 */
export interface RouteConnBitmap {
  /** 节点列表；位图的行列都对应这个列表的索引 */
  peerIds: Array<{ peerId: number; version: number }>;
  /** 位图原始字节 */
  bitmap: Buffer;
}

/** 读取第 idx 位（LSB 优先）。 */
export function getBitmapBit(bitmap: Buffer, idx: number): boolean {
  const byteIdx = Math.floor(idx / 8);
  if (byteIdx >= bitmap.length) return false;
  return ((bitmap[byteIdx] >> (idx % 8)) & 1) === 1;
}

/** 设置第 idx 位（LSB 优先）。 */
export function setBitmapBit(bitmap: Buffer, idx: number): void {
  const byteIdx = Math.floor(idx / 8);
  bitmap[byteIdx] |= 1 << (idx % 8);
}

/** 解码 `RouteConnBitmap`。*/
export function decodeConnBitmap(buffer: Buffer): RouteConnBitmap {
  const fields = decodeFields(buffer);
  const peerIds = getAllBytes(fields, 1).map((item) => {
    const f = decodeFields(item);
    return { peerId: getVarint(f, 1) ?? 0, version: getVarint(f, 2) ?? 0 };
  });
  return { peerIds, bitmap: getBytes(fields, 2) ?? Buffer.alloc(0) };
}

/** 编码 `RouteConnBitmap`。*/
export function encodeConnBitmap(bitmap: RouteConnBitmap): Buffer {
  const parts: Buffer[] = [];
  for (const pv of bitmap.peerIds) {
    const inner: Buffer[] = [];
    if (pv.peerId !== 0) inner.push(encodeVarintField(1, pv.peerId));
    if (pv.version !== 0) inner.push(encodeVarintField(2, pv.version));
    parts.push(encodeBytesField(1, Buffer.concat(inner)));
  }
  if (bitmap.bitmap.length > 0) {
    parts.push(encodeBytesField(2, bitmap.bitmap));
  }
  return Buffer.concat(parts);
}

/**
 * 解出某个节点连接了哪些节点。
 *
 * `peerIdx * peerIds.length + idx` —— 行优先展平的邻接矩阵。
 */
export function getConnectedPeers(state: RouteConnBitmap, peerIdx: number): number[] {
  const result: number[] = [];
  const n = state.peerIds.length;
  for (let idx = 0; idx < n; idx += 1) {
    if (getBitmapBit(state.bitmap, peerIdx * n + idx)) {
      result.push(state.peerIds[idx].peerId);
    }
  }
  return result;
}

/** 从一组边构造位图（便于测试与构造自己的拓扑）。 */
export function buildConnBitmap(
  peerIds: Array<{ peerId: number; version: number }>,
  edges: Array<[number, number]>,
): RouteConnBitmap {
  const n = peerIds.length;
  const bitmap = Buffer.alloc(Math.ceil((n * n) / 8));
  for (const [i, j] of edges) {
    setBitmapBit(bitmap, i * n + j);
  }
  return { peerIds, bitmap };
}
