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
  /**
   * 伪首部信息。
   *
   * `payload` 必须传：TCP 校验和覆盖**头部 + 载荷**，只算头部会让所有
   * 带数据的段校验和错误，对端静默丢弃——症状是"握手正常、发数据没反应"。
   * 踩过：`tcpChecksum(buf, pseudo)` 只传了 20 字节头部，而 `tcpLength`
   * 却按含载荷的段长传，两者不一致。
   */
  pseudo: { src: string; dst: string; payload?: Buffer },
  /** TCP 选项（会被补齐到 4 字节边界）。SACK 靠它协商与上报 */
  options?: TcpOption[],
): Buffer {
  const optionsBuffer =
    options === undefined || options.length === 0 ? Buffer.alloc(0) : encodeTcpOptions(options);
  if (optionsBuffer.length > 40) {
    throw new Error(`TCP 选项过长（${optionsBuffer.length} 字节，上限 40）`);
  }
  const headerLength = 20 + optionsBuffer.length;
  const buf = Buffer.alloc(headerLength);
  buf.writeUInt16BE(header.srcPort, 0);
  buf.writeUInt16BE(header.dstPort, 2);
  buf.writeUInt32BE(header.seq >>> 0, 4);
  buf.writeUInt32BE(header.ack >>> 0, 8);
  // data offset 以 4 字节为单位
  buf[12] = (headerLength / 4) << 4;
  buf[13] = header.flags;
  buf.writeUInt16BE(header.window, 14);
  buf.writeUInt16BE(0, 16); // 校验和先留 0
  buf.writeUInt16BE(header.urgentPointer ?? 0, 18);
  if (optionsBuffer.length > 0) optionsBuffer.copy(buf, 20);

  // 校验和必须覆盖头部与载荷整体
  const payload = pseudo.payload ?? Buffer.alloc(0);
  const checksum = tcpChecksum(buf, {
    src: pseudo.src,
    dst: pseudo.dst,
    tcpLength: headerLength + payload.length,
    payload,
  });
  buf.writeUInt16BE(checksum, 16);
  return buf;
}

/** TCP 选项类型号（IANA）。 */
export const TcpOptionKind = {
  /** 选项列表结束 */
  END: 0,
  /** 无操作（用于对齐） */
  NOP: 1,
  /** 最大段长 */
  MSS: 2,
  /** 允许 SACK（只在 SYN/SYN-ACK 里） */
  SACK_PERMITTED: 4,
  /** SACK 块 */
  SACK: 5,
  /** 窗口扩大因子 */
  WINDOW_SCALE: 3,
} as const;

/** 一个 TCP 选项。 */
export type TcpOption =
  | { kind: typeof TcpOptionKind.END }
  | { kind: typeof TcpOptionKind.NOP }
  | { kind: typeof TcpOptionKind.MSS; mss: number }
  | { kind: typeof TcpOptionKind.SACK_PERMITTED }
  /** SACK 块：每个都是 `[left, right)` 的**实际序列号**（不是相对值） */
  | { kind: typeof TcpOptionKind.SACK; blocks: Array<{ left: number; right: number }> }
  | { kind: typeof TcpOptionKind.WINDOW_SCALE; shift: number };

/**
 * 编码 TCP 选项，并补齐到 4 字节边界。
 *
 * 补齐用 `NOP` 还是 `END` 有讲究：`END` 之后的字节被忽略，
 * 而 `NOP` 会被当作独立选项跳过。规范允许两者，这里用 `END`（更省）。
 */
export function encodeTcpOptions(options: TcpOption[]): Buffer {
  const parts: Buffer[] = [];
  for (const option of options) {
    switch (option.kind) {
      case TcpOptionKind.END:
        parts.push(Buffer.from([TcpOptionKind.END]));
        break;
      case TcpOptionKind.NOP:
        parts.push(Buffer.from([TcpOptionKind.NOP]));
        break;
      case TcpOptionKind.MSS: {
        const buf = Buffer.alloc(4);
        buf[0] = TcpOptionKind.MSS;
        buf[1] = 4;
        buf.writeUInt16BE(option.mss, 2);
        parts.push(buf);
        break;
      }
      case TcpOptionKind.SACK_PERMITTED:
        parts.push(Buffer.from([TcpOptionKind.SACK_PERMITTED, 2]));
        break;
      case TcpOptionKind.WINDOW_SCALE:
        parts.push(Buffer.from([TcpOptionKind.WINDOW_SCALE, 3, option.shift]));
        break;
      case TcpOptionKind.SACK: {
        // 每个块 8 字节（left/right 各 4 字节），选项头 2 字节
        const count = Math.min(option.blocks.length, 4);
        const buf = Buffer.alloc(2 + count * 8);
        buf[0] = TcpOptionKind.SACK;
        buf[1] = buf.length;
        for (let i = 0; i < count; i += 1) {
          buf.writeUInt32BE(option.blocks[i].left >>> 0, 2 + i * 8);
          buf.writeUInt32BE(option.blocks[i].right >>> 0, 6 + i * 8);
        }
        parts.push(buf);
        break;
      }
    }
  }
  let merged = Buffer.concat(parts);
  // 补齐到 4 字节边界
  const padding = (4 - (merged.length % 4)) % 4;
  if (padding > 0) {
    merged = Buffer.concat([merged, Buffer.alloc(padding, TcpOptionKind.END)]);
  }
  return merged;
}

/**
 * 解析 TCP 选项。
 *
 * 必须容忍格式问题：`END` 之后全部忽略、长度字段非法时停止解析
 * （不能抛错——一个坏选项不该让整条连接失败）。
 */
export function decodeTcpOptions(buffer: Buffer): TcpOption[] {
  const options: TcpOption[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const kind = buffer[offset];
    if (kind === TcpOptionKind.END) break;
    if (kind === TcpOptionKind.NOP) {
      offset += 1;
      continue;
    }
    // 其余选项都有长度字节
    if (offset + 1 >= buffer.length) break;
    const length = buffer[offset + 1];
    if (length < 2 || offset + length > buffer.length) break;
    const body = buffer.subarray(offset + 2, offset + length);
    switch (kind) {
      case TcpOptionKind.MSS:
        if (body.length >= 2) {
          options.push({ kind: TcpOptionKind.MSS, mss: body.readUInt16BE(0) });
        }
        break;
      case TcpOptionKind.SACK_PERMITTED:
        options.push({ kind: TcpOptionKind.SACK_PERMITTED });
        break;
      case TcpOptionKind.WINDOW_SCALE:
        if (body.length >= 1) {
          options.push({ kind: TcpOptionKind.WINDOW_SCALE, shift: body[0] });
        }
        break;
      case TcpOptionKind.SACK: {
        const blocks: Array<{ left: number; right: number }> = [];
        for (let i = 0; i + 8 <= body.length; i += 8) {
          blocks.push({
            left: body.readUInt32BE(i),
            right: body.readUInt32BE(i + 4),
          });
        }
        options.push({ kind: TcpOptionKind.SACK, blocks });
        break;
      }
      default:
        // 未知选项：按长度跳过（RFC 1122 要求）
        break;
    }
    offset += length;
  }
  return options;
}

/** 伪首部 + 段的 TCP 校验和。 */
export function tcpChecksum(
  segment: Buffer,
  pseudo: { src: string; dst: string; tcpLength: number; payload?: Buffer },
): number {
  const pseudoHeader = Buffer.alloc(12);
  pseudoHeader.writeUInt32BE(ipToInt(pseudo.src), 0);
  pseudoHeader.writeUInt32BE(ipToInt(pseudo.dst), 4);
  pseudoHeader[8] = 0; // 保留
  pseudoHeader[9] = IpProtocol.TCP;
  pseudoHeader.writeUInt16BE(pseudo.tcpLength, 10);
  // 载荷必须参与计算——只算头部是本文件曾经的真实 bug
  const body =
    pseudo.payload === undefined ? segment : Buffer.concat([segment, pseudo.payload]);
  return internetChecksum(Buffer.concat([pseudoHeader, body]));
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

/**
 * 计算 UDP 校验和（含伪首部）。
 *
 * UDP 的校验和规则比 TCP 特殊：**算出来是 0 时要写成 0xffff**。
 * 因为线上 0 表示"发送方未计算校验和"，接收方会跳过校验——把真实的
 * 校验结果 0 原样写进去，等于声明"不校验"，对端就可能接受被篡改的包。
 *
 * 返回 0 表示调用方应当省略校验（仅在数据本身不需要校验时）。
 */
export function udpChecksum(
  header: Buffer,
  payload: Buffer,
  pseudo: { src: string; dst: string },
): number {
  const udpLength = header.length + payload.length;
  const pseudoHeader = Buffer.alloc(12);
  pseudoHeader.writeUInt32BE(ipToInt(pseudo.src), 0);
  pseudoHeader.writeUInt32BE(ipToInt(pseudo.dst), 4);
  pseudoHeader[8] = 0;
  pseudoHeader[9] = IpProtocol.UDP;
  pseudoHeader.writeUInt16BE(udpLength, 10);
  const sum = internetChecksum(Buffer.concat([pseudoHeader, header, payload]));
  // 0 在 UDP 里表示"未计算"，所以真实结果 0 必须写成 0xffff
  return sum === 0 ? 0xffff : sum;
}

/**
 * 编码 UDP 头（8 字节）。
 *
 * 传了 `pseudo` 就会算校验和（推荐——不少实现会丢弃校验和为 0 的包）；
 * 不传则填 0 表示"未计算"，IPv4 下这是合法的。
 */
export function encodeUdpHeader(header: {
  srcPort: number;
  dstPort: number;
  length: number;
  checksum?: number;
  /** 传了就自动计算校验和 */
  pseudo?: { src: string; dst: string; payload: Buffer };
}): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt16BE(header.srcPort, 0);
  buf.writeUInt16BE(header.dstPort, 2);
  buf.writeUInt16BE(header.length, 4);
  let checksum = header.checksum ?? 0;
  if (header.pseudo !== undefined) {
    checksum = udpChecksum(buf, header.pseudo.payload, {
      src: header.pseudo.src,
      dst: header.pseudo.dst,
    });
  }
  buf.writeUInt16BE(checksum, 6);
  return buf;
}

/** 构造一个完整 UDP 数据报（UDP 头 + 载荷，不含 IP 头），校验和已填。 */
export function buildUdpDatagram(options: {
  srcPort: number;
  dstPort: number;
  payload: Buffer;
  srcIp: string;
  dstIp: string;
}): Buffer {
  const header = encodeUdpHeader({
    srcPort: options.srcPort,
    dstPort: options.dstPort,
    length: 8 + options.payload.length,
    pseudo: { src: options.srcIp, dst: options.dstIp, payload: options.payload },
  });
  return Buffer.concat([header, options.payload]);
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
  /** TCP 选项（SACK 协商与上报） */
  tcpOptions?: TcpOption[];
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
    { src: options.srcIp, dst: options.dstIp, payload },
    options.tcpOptions,
  );
  return Buffer.concat([header, payload]);
}

/** 这个 TCP 段是否带某个标志。 */
export function hasTcpFlag(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

/**
 * 这个地址是不是"要发给所有人"（广播或组播）。
 *
 * 虚拟网络里这两种流量的用途：
 * - **广播**（`255.255.255.255` 或子网广播如 `10.126.126.255`）：
 *   DHCP、ARP 代理、服务发现（mDNS 走组播）
 * - **组播**（`224.0.0.0/4`）：mDNS（`224.0.0.251`）、SSDP 等
 *
 * 处理方式与单播完全不同：单播要算下一跳，广播/组播必须**发给所有对端**
 * （在点对点虚拟网络里，没有真正的链路层广播，只能逐个转发）。
 *
 * `networkPrefix` 用于识别子网广播（例如本机 `10.126.126.1/24` 的广播是
 * `10.126.126.255`）。传 null 时只认 `255.255.255.255` 与组播段。
 */
export function isBroadcastOrMulticast(ip: string, networkPrefix = 24): boolean {
  const value = ipToInt(ip);
  // 受限广播：255.255.255.255
  if (value === 0xffffffff) return true;
  // 组播：224.0.0.0/4（首字节 224-239）
  if ((value >>> 24) >= 224 && (value >>> 24) <= 239) return true;
  // 子网广播：主机位全 1
  if (networkPrefix > 0 && networkPrefix < 32) {
    const hostBits = 32 - networkPrefix;
    const hostMask = hostBits === 32 ? 0xffffffff : (1 << hostBits) - 1;
    if ((value & hostMask) === hostMask) return true;
  }
  return false;
}
