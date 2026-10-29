import { describe, expect, it } from 'vitest';
import { IpReassembler, fragmentIpPacket } from '../src/networking/easytier/ipReassembly';
import {
  IpProtocol,
  buildIpv4Packet,
  buildUdpDatagram,
  decodeIpv4Header,
  decodeUdpHeader,
  isBroadcastOrMulticast,
} from '../src/networking/easytier/ip';

/**
 * UDP 分片（发送侧）与广播/组播判定。
 *
 * 这两项之前都是缺的：
 * - **UDP 分片**：`fragmentIpPacket` 实现了但**发送路径从没调用过**，
 *   所以超过 MTU 的 UDP 数据报（DNS 的 EDNS0 大响应、QUIC 握手）发不出去。
 * - **广播/组播**：mDNS（224.0.0.251）、SSDP、服务发现都依赖它。
 *   点对点虚拟网络里没有链路层广播，必须逐个对端转发。
 */

const SRC = '10.126.229.1';
const DST = '10.126.229.2';
const MTU = 1380;

/** 构造一个超 MTU 的 UDP 数据报（模拟 DNS 大响应）。 */
function bigUdpPacket(payloadSize: number): Buffer {
  const payload = Buffer.alloc(payloadSize);
  for (let i = 0; i < payloadSize; i += 1) payload[i] = i % 251;
  return buildIpv4Packet({
    src: SRC,
    dst: DST,
    protocol: IpProtocol.UDP,
    payload: buildUdpDatagram({
      srcPort: 53,
      dstPort: 53000,
      payload,
      srcIp: SRC,
      dstIp: DST,
    }),
    identification: 0x7788,
  });
}

describe('UDP 发送侧分片', () => {
  it('超 MTU 的 UDP 数据报被切成多片，每片不超过 MTU', () => {
    const packet = bigUdpPacket(3500);
    expect(packet.length).toBeGreaterThan(MTU);

    const fragments = fragmentIpPacket(packet, MTU);
    expect(fragments.length).toBeGreaterThan(1);
    for (const fragment of fragments) {
      // 每片都必须 ≤ MTU，否则底层还会再分片或直接丢
      expect(fragment.length).toBeLessThanOrEqual(MTU);
      const header = decodeIpv4Header(fragment)!;
      // 除最后一片外都带 MF 标志
      const isLast = fragment === fragments[fragments.length - 1];
      expect(header.moreFragments).toBe(!isLast);
    }
  });

  it('切开的碎片经重组后与原 UDP 数据报逐字节一致', () => {
    const packet = bigUdpPacket(3000);
    const fragments = fragmentIpPacket(packet, MTU);

    const reassembler = new IpReassembler();
    let restored: Buffer | null = null;
    // 乱序送入：真实网络不保证分片顺序
    for (const fragment of [...fragments].reverse()) {
      const result = reassembler.accept(fragment);
      if (result !== null && result.complete) restored = result.packet;
    }

    expect(restored).not.toBeNull();
    expect(restored!.equals(packet)).toBe(true);
    // 重组后要能正常解出 UDP 头与载荷
    const ip = decodeIpv4Header(restored!)!;
    const udp = decodeUdpHeader(restored!.subarray(ip.headerLength))!;
    expect(udp.srcPort).toBe(53);
    expect(udp.dstPort).toBe(53000);
    expect(udp.length).toBe(8 + 3000);
  });

  it('不超过 MTU 的包不切（避免无谓开销）', () => {
    // 发送路径的判断是 `length > mtu`，边界要严格大于
    const small = bigUdpPacket(1000);
    expect(small.length).toBeLessThan(MTU);
    expect(fragmentIpPacket(small, MTU).length).toBe(1);
  });
});

describe('广播 / 组播判定', () => {
  it('受限广播 255.255.255.255', () => {
    expect(isBroadcastOrMulticast('255.255.255.255')).toBe(true);
  });

  it('组播段 224.0.0.0/4（mDNS 224.0.0.251 在内）', () => {
    expect(isBroadcastOrMulticast('224.0.0.251')).toBe(true);
    expect(isBroadcastOrMulticast('224.0.0.1')).toBe(true);
    expect(isBroadcastOrMulticast('239.255.255.250')).toBe(true);
  });

  it('子网广播（主机位全 1）', () => {
    // /24 的广播地址
    expect(isBroadcastOrMulticast('10.126.229.255', 24)).toBe(true);
    // /16 的广播地址
    expect(isBroadcastOrMulticast('10.126.255.255', 16)).toBe(true);
  });

  it('普通单播地址不算广播', () => {
    expect(isBroadcastOrMulticast('10.126.229.1', 24)).toBe(false);
    expect(isBroadcastOrMulticast('10.126.229.2', 24)).toBe(false);
    // 224 以下是单播段
    expect(isBroadcastOrMulticast('223.255.255.1')).toBe(false);
    // 240 以上是保留段，不是组播
    expect(isBroadcastOrMulticast('240.0.0.1')).toBe(false);
  });

  it('prefix=32 时不做子网广播判断（没有主机位）', () => {
    expect(isBroadcastOrMulticast('10.126.229.255', 32)).toBe(false);
  });
});
