import { describe, expect, it } from 'vitest';
import { IpReassembler, fragmentIpPacket } from '../src/networking/easytier/ipReassembly';
import {
  IpProtocol,
  buildIpv4Packet,
  decodeIpv4Header,
  internetChecksum,
} from '../src/networking/easytier/ip';

/**
 * IPv4 分片重组。
 *
 * 之前分片包被直接丢弃，症状是"小请求正常、大响应卡死"——而这个症状
 * 完全不指向"分片没重组"，所以必须用测试把行为固定住。
 *
 * 三个必须验证的坑：
 * 1. 偏移量单位是 **8 字节**（不是字节）
 * 2. 只有第一片带真正的 IP 头（含总长）
 * 3. 重组后要重算头校验和并清掉分片标志
 */

const SRC = '10.126.226.1';
const DST = '10.126.226.2';

function makeBigPacket(payloadSize: number): Buffer {
  // 载荷用可辨识的递增字节，重组后能逐字节比对
  const payload = Buffer.alloc(payloadSize);
  for (let i = 0; i < payloadSize; i += 1) payload[i] = i % 251;
  return buildIpv4Packet({
    src: SRC,
    dst: DST,
    protocol: IpProtocol.UDP,
    payload,
    identification: 0x4321,
  });
}

describe('IPv4 分片重组', () => {
  it('大包被切分后能原样拼回（逐字节一致）', () => {
    const original = makeBigPacket(3000);
    const fragments = fragmentIpPacket(original, 1000);
    // MTU 1000、IP 头 20 → 每片 976 字节载荷，3000 载荷需要 4 片
    expect(fragments.length).toBeGreaterThan(1);

    const reassembler = new IpReassembler();
    let result: { packet: Buffer; complete: boolean } | null = null;
    for (const fragment of fragments) {
      const piece = reassembler.accept(fragment);
      if (piece !== null && piece.complete) result = piece;
    }

    expect(result).not.toBeNull();
    // 完整包必须与原始包逐字节相同（含 IP 头）
    expect(result!.packet.equals(original)).toBe(true);
  });

  it('乱序到达也能拼回（网络不保证分片顺序）', () => {
    const original = makeBigPacket(2000);
    const fragments = fragmentIpPacket(original, 800);
    // 倒序送入
    const shuffled = [...fragments].reverse();

    const reassembler = new IpReassembler();
    let result: { packet: Buffer; complete: boolean } | null = null;
    for (const fragment of shuffled) {
      const piece = reassembler.accept(fragment);
      if (piece !== null && piece.complete) result = piece;
    }

    expect(result).not.toBeNull();
    expect(result!.packet.equals(original)).toBe(true);
  });

  it('缺片时返回 null（不能把不完整的包交给上层）', () => {
    const original = makeBigPacket(2000);
    const fragments = fragmentIpPacket(original, 800);

    const reassembler = new IpReassembler();
    // 故意跳过中间一片
    for (let i = 0; i < fragments.length; i += 1) {
      if (i === 1) continue;
      const piece = reassembler.accept(fragments[i]);
      // 永远不该返回 complete
      expect(piece === null || !piece.complete).toBe(true);
    }
    expect(reassembler.pendingGroups()).toBe(1);
  });

  it('首片未到时无法完成（总长只在首片里）', () => {
    const original = makeBigPacket(2000);
    const fragments = fragmentIpPacket(original, 800);

    const reassembler = new IpReassembler();
    // 只送非首片
    for (let i = 1; i < fragments.length; i += 1) {
      expect(reassembler.accept(fragments[i])).toBeNull();
    }
    // 最后补首片才能完成
    const final = reassembler.accept(fragments[0]);
    expect(final).not.toBeNull();
    expect(final!.complete).toBe(true);
    expect(final!.packet.equals(original)).toBe(true);
  });

  it('重组后清掉分片标志并重算头校验和', () => {
    const original = makeBigPacket(1600);
    const fragments = fragmentIpPacket(original, 700);
    const reassembler = new IpReassembler();
    let result: { packet: Buffer; complete: boolean } | null = null;
    for (const fragment of fragments) {
      const piece = reassembler.accept(fragment);
      if (piece !== null && piece.complete) result = piece;
    }
    expect(result).not.toBeNull();

    const header = decodeIpv4Header(result!.packet)!;
    // 重组后不该再是分片
    expect(header.moreFragments).toBe(false);
    expect(header.fragmentOffset).toBe(0);
    expect(header.totalLength).toBe(result!.packet.length);
    // 头变了就必须重算校验和，否则上层校验会失败
    expect(internetChecksum(result!.packet.subarray(0, header.headerLength))).toBe(0);
  });

  it('重复分片被忽略，不会让载荷错乱', () => {
    const original = makeBigPacket(1600);
    const fragments = fragmentIpPacket(original, 700);
    const reassembler = new IpReassembler();

    let result: { packet: Buffer; complete: boolean } | null = null;
    for (const fragment of fragments) {
      const piece = reassembler.accept(fragment);
      if (piece !== null && piece.complete) result = piece;
      // 同一片再送一次（模拟对端重传）
      reassembler.accept(fragment);
    }

    expect(result).not.toBeNull();
    expect(result!.packet.equals(original)).toBe(true);
  });

  it('非分片包原样放行（complete=false，表示不需重组）', () => {
    const small = makeBigPacket(100);
    const reassembler = new IpReassembler();
    const result = reassembler.accept(small);
    expect(result).not.toBeNull();
    expect(result!.complete).toBe(false);
    expect(result!.packet).toBe(small);
  });

  it('组数超过上限时淘汰最老的组（防伪造分片打爆内存）', () => {
    const reassembler = new IpReassembler({ maxGroups: 2 });
    const make = (id: number) => {
      const packet = buildIpv4Packet({
        src: SRC, dst: DST, protocol: IpProtocol.UDP,
        payload: Buffer.alloc(100, 1), identification: id,
      });
      return fragmentIpPacket(packet, 60)[1]; // 取非首片，不会完成
    };
    reassembler.accept(make(1));
    reassembler.accept(make(2));
    reassembler.accept(make(3));
    // 上限 2，第三个进来时淘汰了一个
    expect(reassembler.pendingGroups()).toBeLessThanOrEqual(2);
  });
});
