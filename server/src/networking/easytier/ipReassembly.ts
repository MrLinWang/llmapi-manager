/**
 * IPv4 分片重组：把被切成多片的大 IP 包重新拼成一个完整包。
 *
 * # 为什么需要
 *
 * 之前收到 `more_fragments` 或 `fragment_offset != 0` 的包**直接丢弃**。
 * 后果：任何超过路径 MTU 的包都会静默消失。虚拟网络里 MTU 通常 1380，
 * 所以：
 *
 * - 大 UDP 数据报（DNS 的 EDNS0 响应、QUIC 握手）会失败
 * - 大 ICMP（`ping -s 2000`）会失败
 * - TCP 有 MSS 协商所以能避开，但**如果对端把 MSS 设得比路径 MTU 大**，
 *   分片就会出现，然后连接表现为"小请求正常、大响应卡死"
 *
 * 这些症状都不指向"分片没重组"——所以必须实现。
 *
 * # 算法（RFC 791 / RFC 815）
 *
 * 分片按 `(源IP, 目的IP, 标识符, 协议)` 四元组归组。每组维护已收到的
 * 字节区间，收到覆盖 `[0, totalLength)` 的全部区间后拼成完整包。
 *
 * 三个必须处理的坑：
 *
 * 1. **偏移量单位是 8 字节**，不是字节。`fragment_offset * 8` 才是真实偏移。
 * 2. **只有第一片带 IP 头**。后续分片是从 IP 头之后开始的数据，所以重组时
 *    要把「第一片的头 + 按偏移拼好的载荷」重新组合，而不是简单拼接各分片载荷。
 * 3. **总长只能从最后一个分片推导**。这是最容易搞错的一点：每个分片的
 *    `totalLength` 都只描述**它自己**（头 + 本片载荷），首片也一样。
 *    所以"完整载荷有多长"必须靠 `MF=0` 的那一片算：
 *    `offset + 本片载荷长度`。踩过：一开始从首片取总长，结果永远拼不齐。
 */

import { decodeIpv4Header } from './ip';

/** 一个正在重组中的分片组。 */
interface FragmentGroup {
  /** 第一片的 IP 头（用于还原完整包；后续分片的头没有意义） */
  header: Buffer | null;
  /**
   * 完整载荷总长。
   *
   * 只能从 **`MF=0` 的那一片**（最后一片）推导：`offset + 本片载荷长度`。
   * 不能从首片的 `totalLength` 取——那只描述首片自己。
   */
  totalPayloadLength: number | null;
  /** 已收到的载荷片段：按偏移记录 */
  pieces: Array<{ offset: number; data: Buffer }>;
  /** 首片到达时间，用于超时清理 */
  createdAt: number;
  /** 最近一次收到分片的时间 */
  lastActivityAt: number;
}

export interface IpReassemblerOptions {
  /** 单组分片的超时（毫秒）。超时后整组丢弃 */
  timeoutMs?: number;
  /** 同时在重组的分片组上限，防止被伪造分片打爆内存 */
  maxGroups?: number;
  /** 单个完整包的长度上限 */
  maxPacketSize?: number;
  log?: (message: string) => void;
}

/**
 * 分片重组器。
 *
 * 无状态的部分（能否重组）在这里，存储由调用方持有——`IpReassembler`
 * 自己维护组表，因为清理超时是它的职责。
 */
export class IpReassembler {
  private readonly groups = new Map<string, FragmentGroup>();
  private readonly options: Required<Omit<IpReassemblerOptions, 'log'>> &
    Pick<IpReassemblerOptions, 'log'>;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: IpReassemblerOptions = {}) {
    this.options = {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxGroups: options.maxGroups ?? 128,
      maxPacketSize: options.maxPacketSize ?? 65_535,
      ...(options.log === undefined ? {} : { log: options.log }),
    };
  }

  /** 当前正在重组的组数（诊断用）。 */
  pendingGroups(): number {
    return this.groups.size;
  }

  start(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweepExpired(), 5_000);
    this.sweepTimer.unref?.();
  }

  close(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.groups.clear();
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, group] of this.groups) {
      if (now - group.lastActivityAt <= this.options.timeoutMs) continue;
      this.log(`分片组超时丢弃（${key}，已收 ${group.pieces.length} 片）`);
      this.groups.delete(key);
    }
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /**
   * 处理一个 IP 包。
   *
   * - 不是分片 → 返回原包（`complete: false`，调用方继续正常处理）
   * - 是分片但还没齐 → 返回 null（调用方什么都不做）
   * - 是分片且已齐 → 返回重组后的完整体
   */
  accept(packet: Buffer): { packet: Buffer; complete: boolean } | null {
    const header = decodeIpv4Header(packet);
    if (header === null) return null;

    const isFragment = header.moreFragments || header.fragmentOffset !== 0;
    if (!isFragment) {
      // 非分片原样放行，顺带清掉可能残留的同 id 组
      // （标识符被复用是允许的，但复用时旧组已无意义）
      return { packet, complete: false };
    }

    const key = `${header.src}->${header.dst}|id=${header.identification}|proto=${header.protocol}`;
    let group = this.groups.get(key);

    if (group === undefined) {
      if (this.groups.size >= this.options.maxGroups) {
        // 组太多了：丢掉最老的一组，避免被伪造分片打爆内存
        const oldest = [...this.groups.entries()].sort(
          (a, b) => a[1].lastActivityAt - b[1].lastActivityAt,
        )[0];
        if (oldest !== undefined) {
          this.log(`分片组过多，淘汰最老的一组（${oldest[0]}）`);
          this.groups.delete(oldest[0]);
        }
      }
      group = {
        header: null,
        totalPayloadLength: null,
        pieces: [],
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      this.groups.set(key, group);
    }

    group.lastActivityAt = Date.now();

    const payloadLength = header.totalLength - header.headerLength;
    if (payloadLength <= 0) return null;
    const payload = packet.subarray(
      header.headerLength,
      Math.min(header.totalLength, packet.length),
    );

    // **偏移量单位是 8 字节**
    const offset = header.fragmentOffset * 8;

    // 只有 offset 0 的分片带真正的 IP 头（后续分片的头是各片自己的）
    if (offset === 0) {
      group.header = packet.subarray(0, header.headerLength);
    }
    // 总长只能从 **最后一片**（MF=0）推导：它给出"载荷到这里结束"
    if (!header.moreFragments) {
      group.totalPayloadLength = offset + payloadLength;
    }

    // 重复分片：同偏移已有数据就跳过（可能是对端重传）
    if (group.pieces.some((piece) => piece.offset === offset)) {
      return null;
    }
    group.pieces.push({ offset, data: Buffer.from(payload) });

    const assembled = this.tryAssemble(key, group);
    return assembled;
  }

  /** 尝试把已收到的分片拼成完整包；不齐返回 null。 */
  private tryAssemble(
    key: string,
    group: FragmentGroup,
  ): { packet: Buffer; complete: boolean } | null {
    if (group.header === null || group.totalPayloadLength === null) {
      // 首片还没到，无法知道总长
      return null;
    }

    // 按偏移排序，检查是否覆盖 [0, totalPayloadLength)
    const sorted = [...group.pieces].sort((a, b) => a.offset - b.offset);
    let cursor = 0;
    for (const piece of sorted) {
      if (piece.offset > cursor) {
        // 中间有空洞
        return null;
      }
      cursor = Math.max(cursor, piece.offset + piece.data.length);
    }
    if (cursor < group.totalPayloadLength) return null;

    // 齐了：拼载荷
    const payload = Buffer.alloc(group.totalPayloadLength);
    for (const piece of sorted) {
      const end = Math.min(piece.offset + piece.data.length, group.totalPayloadLength);
      if (piece.offset >= group.totalPayloadLength) continue;
      piece.data.copy(payload, piece.offset, 0, end - piece.offset);
    }

    const totalLength = group.header.length + payload.length;
    if (totalLength > this.options.maxPacketSize) {
      this.log(`重组后的包过大（${totalLength}B），丢弃该组`);
      this.groups.delete(key);
      return null;
    }

    this.groups.delete(key);

    // 重建 IP 头：总长改成完整包长度，清掉分片标志与偏移
    const header = Buffer.from(group.header);
    header.writeUInt16BE(totalLength, 2);
    // flags(3bit) + fragmentOffset(13bit)：清掉 MF 与偏移，保留 DF
    const flagsAndOffset = header.readUInt16BE(6) & 0x4000;
    header.writeUInt16BE(flagsAndOffset, 6);
    // 头变了（总长+标志），校验和必须重算
    header.writeUInt16BE(0, 10);
    header.writeUInt16BE(computeHeaderChecksum(header), 10);

    this.log(`分片重组完成：${sorted.length} 片 → ${totalLength}B`);
    return { packet: Buffer.concat([header, payload]), complete: true };
  }
}

/** 计算 IPv4 头校验和（与 `ip.ts` 的 `internetChecksum` 同算法，避免循环依赖）。 */
function computeHeaderChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i + 1 < header.length; i += 2) {
    sum += (header[i] << 8) | header[i + 1];
  }
  while (sum >> 16) {
    sum = (sum & 0xffff) + (sum >> 16);
  }
  return ~sum & 0xffff;
}

/**
 * 把一个 IP 包切成多个分片（测试用，也可用于将来实现发送侧分片）。
 *
 * 分片规则：除最后一片外，每片载荷长度必须是 **8 的倍数**
 * （因为 offset 字段以 8 字节为单位）。
 */
export function fragmentIpPacket(packet: Buffer, mtu: number): Buffer[] {
  const header = decodeIpv4Header(packet);
  if (header === null) throw new Error('不是合法的 IPv4 包');

  const headerBytes = packet.subarray(0, header.headerLength);
  const payload = packet.subarray(
    header.headerLength,
    Math.min(header.totalLength, packet.length),
  );

  // 每片能带的载荷 = MTU - IP头，向下取整到 8 的倍数
  const maxFragmentPayload = Math.floor((mtu - header.headerLength) / 8) * 8;
  if (maxFragmentPayload <= 0) throw new Error(`MTU ${mtu} 太小，放不下 IP 头`);

  const fragments: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += maxFragmentPayload) {
    const chunk = payload.subarray(offset, offset + maxFragmentPayload);
    const isLast = offset + chunk.length >= payload.length;
    const fragmentHeader = Buffer.from(headerBytes);
    fragmentHeader.writeUInt16BE(header.headerLength + chunk.length, 2);
    const baseFlags = fragmentHeader.readUInt16BE(6) & 0x4000; // 保留 DF
    const moreFragments = isLast ? 0 : 0x2000;
    fragmentHeader.writeUInt16BE(baseFlags | moreFragments | (offset / 8), 6);
    fragmentHeader.writeUInt16BE(0, 10);
    fragmentHeader.writeUInt16BE(computeHeaderChecksum(fragmentHeader), 10);
    fragments.push(Buffer.concat([fragmentHeader, chunk]));
  }
  return fragments;
}
