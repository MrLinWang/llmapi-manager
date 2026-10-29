/**
 * IPv4 / TCP / UDP / ICMP 头部编解码。
 *
 * # 为什么需要这一层
 *
 * EasyTier 的 `PacketType.Data` 承载的是**完整的 IP 包**（`peer_manager.rs:462`
 * 的 `NicPacketProcessor`：`try_send(HostPacket::from_core_packet(packet))`，
 * 直接投给网卡）。要让自研实现具备数据面，必须能收发并解析这种包。
 *
 * 本文件只做**纯字节编解码**，不涉及状态机与 IO——这样它可以被单元测试
 * 完整覆盖，也让上层（`tcpStack.ts`）能专注于协议状态而不夹带字节细节。
 *
 * # 校验和的坑
 *
 * IPv4 头校验和与 TCP/UDP 校验和都涉及"把校验和字段自身按 0 参与计算"，
 * 且 TCP 的校验和要加**伪首部**（src/dst/协议/长度）。这三处一旦算错，
 * 对端会静默丢弃包——没有任何日志，只表现为"连不上"。
 * 所有校验和都实现为 `internetChecksum` 的变体，并有往返测试固定。
 */

/** IP 协议号。 */
export const IpProtocol = {
  ICMP: 1,
  TCP: 6,
  UDP: 17,
} as const;

export type IpProtocolValue = (typeof IpProtocol)[keyof typeof IpProtocol];

/** TCP 标志位（`tcp.rs` 的 flags 位域）。 */
export const TcpFlags = {
  FIN: 0x01,
  SYN: 0x02,
  RST: 0x04,
  PSH: 0x08,
  ACK: 0x10,
  URG: 0x20,
} as const;

/** 解析后的 IPv4 头。 */
export interface Ipv4Header {
  version: number;
  headerLength: number;
  /** 服务类型（一般 0） */
  dscp: number;
  totalLength: number;
  identification: number;
  /** 不分片标志 */
  dontFragment: boolean;
  /** 还有更多分片 */
  moreFragments: boolean;
  /** 分片偏移（单位 8 字节） */
  fragmentOffset: number;
  ttl: number;
  protocol: number;
  checksum: number;
  src: string;
  dst: string;
}

/** 解析后的 TCP 头。 */
export interface TcpHeader {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  dataOffset: number;
  flags: number;
  window: number;
  checksum: number;
  urgentPointer: number;
}

/** 解析后的 UDP 头。 */
export interface UdpHeader {
  srcPort: number;
  dstPort: number;
  length: number;
  checksum: number;
}

/**
 * 计算 internet 校验和（RFC 1071）。
 *
 * 把数据按 16 位大端累加，进位回卷，最后取反。调用方传入的缓冲区里
 * **校验和字段必须是 0**（或已经包含在累加里）——本函数不做特殊处理，
 * 因为它同时用于"计算"和"验证"两种场景。
 */
export function internetChecksum(data: Buffer): number {
  let sum = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    sum += (data[i] << 8) | data[i + 1];
  }
  // 奇数长度：末字节左移 8 位补齐
  if (data.length % 2 === 1) {
    sum += data[data.length - 1] << 8;
  }
  // 把 32 位进位回卷到 16 位（最多两轮）
  while (sum >> 16) {
    sum = (sum & 0xffff) + (sum >> 16);
  }
  return ~sum & 0xffff;
}

/** 把点分十进制转成 32 位无符号数（大端语义）。 */
export function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`非法 IPv4 地址：${ip}`);
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`非法 IPv4 地址：${ip}`);
    }
    value = ((value << 8) | n) >>> 0;
  }
  return value;
}

/** 把 32 位无符号数转成点分十进制。 */
export function intToIp(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

/** 解析 IPv4 头。非法或非 IPv4 返回 null（调用方应丢弃该包）。 */
export function decodeIpv4Header(buffer: Buffer): Ipv4Header | null {
  if (buffer.length < 20) return null;
  const versionAndIhl = buffer[0];
  const version = versionAndIhl >>> 4;
  if (version !== 4) return null;
  const headerLength = (versionAndIhl & 0x0f) * 4;
  if (headerLength < 20 || buffer.length < headerLength) return null;

  const flagsAndOffset = buffer.readUInt16BE(6);
  return {
    version,
    headerLength,
    dscp: buffer[1],
    totalLength: buffer.readUInt16BE(2),
    identification: buffer.readUInt16BE(4),
    dontFragment: (flagsAndOffset & 0x4000) !== 0,
    moreFragments: (flagsAndOffset & 0x2000) !== 0,
    fragmentOffset: flagsAndOffset & 0x1fff,
    ttl: buffer[8],
    protocol: buffer[9],
    checksum: buffer.readUInt16BE(10),
    src: intToIp(buffer.readUInt32BE(12)),
    dst: intToIp(buffer.readUInt32BE(16)),
  };
}

/** 编码 IPv4 头（20 字节，不含选项）。校验和自动填好。 */
export function encodeIpv4Header(header: {
  dscp?: number;
  totalLength: number;
  identification: number;
  dontFragment?: boolean;
  protocol: number;
  ttl?: number;
  src: string;
  dst: string;
  /** 分片偏移（单位 8 字节），默认 0 */
  fragmentOffset?: number;
  moreFragments?: boolean;
}): Buffer {
  const buf = Buffer.alloc(20);
  buf[0] = 0x45; // version 4, IHL 5
  buf[1] = header.dscp ?? 0;
  buf.writeUInt16BE(header.totalLength, 2);
  buf.writeUInt16BE(header.identification, 4);
  let flagsAndOffset = header.fragmentOffset ?? 0;
  if (header.dontFragment) flagsAndOffset |= 0x4000;
  if (header.moreFragments) flagsAndOffset |= 0x2000;
  buf.writeUInt16BE(flagsAndOffset, 6);
  buf[8] = header.ttl ?? 64;
  buf[9] = header.protocol;
  // 校验和字段先留 0 参与计算
  buf.writeUInt16BE(0, 10);
  buf.writeUInt32BE(ipToInt(header.src), 12);
  buf.writeUInt32BE(ipToInt(header.dst), 16);
  buf.writeUInt16BE(internetChecksum(buf.subarray(0, 20)), 10);
  return buf;
}

/** 解析 TCP 头。 */
export function decodeTcpHeader(buffer: Buffer): TcpHeader | null {
  if (buffer.length < 20) return null;
  const dataOffset = (buffer[12] >>> 4) * 4;
  if (dataOffset < 20 || buffer.length < dataOffset) return null;
  return {
    srcPort: buffer.readUInt16BE(0),
    dstPort: buffer.readUInt16BE(2),
    seq: buffer.readUInt32BE(4),
    ack: buffer.readUInt32BE(8),
    dataOffset,
    flags: buffer[13],
    window: buffer.readUInt16BE(14),
    checksum: buffer.readUInt16BE(16),
    urgentPointer: buffer.readUInt16BE(18),
  };
}

/**
 * 编码 TCP 头（20 字节，不含选项）。
 *
 * **校验和需要伪首部**（src/dst/协议/零/TCP 长度），所以必须知道 IP 层的
 * 源与目的地址。这是最容易漏的地方——只对 TCP 段算校验和会被对端丢弃。
 */
export function encodeTcpHeader(
  header: {
    srcPort: number;
    dstPort: number;
    seq: number;
    ack: number;
    flags: number;
    window: number;
    urgentPointer?: number;
  },
  /** 伪首部所需的 IP 地址与 TCP 段总长（含头部） */
  pseudo: { src: string; dst: string; tcpLength: number },
): Buffer {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(header.srcPort, 0);
  buf.writeUInt16BE(header.dstPort, 2);
  buf.writeUInt32BE(header.seq >>> 0, 4);
  buf.writeUInt32BE(header.ack >>> 0, 8);
  buf[12] = 5 << 4; // data offset 5（20 字节）
  buf[13] = header.flags;
  buf.writeUInt16BE(header.window, 14);
  buf.writeUInt16BE(0, 16); // 校验和先留 0
  buf.writeUInt16BE(header.urgentPointer ?? 0, 18);
  buf.writeUInt16BE(tcpChecksum(buf, pseudo), 16);
  return buf;
}

/** 伪首部 + 段的 TCP 校验和。 */
export function tcpChecksum(
  segment: Buffer,
  pseudo: { src: string; dst: string; tcpLength: number },
): number {
  const pseudoHeader = Buffer.alloc(12);
  pseudoHeader.writeUInt32BE(ipToInt(pseudo.src), 0);
  pseudoHeader.writeUInt32BE(ipToInt(pseudo.dst), 4);
  pseudoHeader[8] = 0; // 保留
  pseudoHeader[9] = IpProtocol.TCP;
  pseudoHeader.writeUInt16BE(pseudo.tcpLength, 10);
  return internetChecksum(Buffer.concat([pseudoHeader, segment]));
}

/** 解析 UDP 头。 */
export function decodeUdpHeader(buffer: Buffer): UdpHeader | null {
  if (buffer.length < 8) return null;
  return {
    srcPort: buffer.readUInt16BE(0),
    dstPort: buffer.readUInt16BE(2),
    length: buffer.readUInt16BE(4),
    checksum: buffer.readUInt16BE(6),
  };
}

/** 编码 UDP 头（8 字节）。校验和为 0 表示"未计算"，IPv4 下合法。 */
export function encodeUdpHeader(header: {
  srcPort: number;
  dstPort: number;
  length: number;
  checksum?: number;
}): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt16BE(header.srcPort, 0);
  buf.writeUInt16BE(header.dstPort, 2);
  buf.writeUInt16BE(header.length, 4);
  buf.writeUInt16BE(header.checksum ?? 0, 6);
  return buf;
}

/**
 * 构造一个完整的 IPv4 包（IP 头 + 载荷）。
 *
 * `identification` 由调用方给——它用于 IP 分片重组，同一个分片组的包
 * 必须共用同一个 id。
 */
export function buildIpv4Packet(options: {
  src: string;
  dst: string;
  protocol: number;
  payload: Buffer;
  identification: number;
  ttl?: number;
}): Buffer {
  const header = encodeIpv4Header({
    totalLength: 20 + options.payload.length,
    identification: options.identification & 0xffff,
    protocol: options.protocol,
    src: options.src,
    dst: options.dst,
    ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
  });
  return Buffer.concat([header, options.payload]);
}

/** 构造一个 TCP 段（TCP 头 + 载荷），不含 IP 头。 */
export function buildTcpSegment(options: {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: number;
  window: number;
  payload?: Buffer;
  /** 伪首部用 */
  srcIp: string;
  dstIp: string;
}): Buffer {
  const payload = options.payload ?? Buffer.alloc(0);
  const header = encodeTcpHeader(
    {
      srcPort: options.srcPort,
      dstPort: options.dstPort,
      seq: options.seq,
      ack: options.ack,
      flags: options.flags,
      window: options.window,
    },
    { src: options.srcIp, dst: options.dstIp, tcpLength: 20 + payload.length },
  );
  return Buffer.concat([header, payload]);
}

/** 这个 TCP 段是否带某个标志。 */
export function hasTcpFlag(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}
