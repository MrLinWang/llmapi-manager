import { describe, expect, it } from 'vitest';
import {
  IpProtocol,
  TcpFlags,
  buildIpv4Packet,
  buildTcpSegment,
  decodeIpv4Header,
  decodeTcpHeader,
  decodeUdpHeader,
  encodeIpv4Header,
  encodeUdpHeader,
  hasTcpFlag,
  intToIp,
  internetChecksum,
  ipToInt,
  tcpChecksum,
} from '../src/networking/easytier/ip';

/**
 * IP / TCP 编解码的字节级验证。
 *
 * 这一层的错误**不会报错**，只会让对端静默丢弃包，表现为"连不上"。
 * 所以校验和、字节序这类东西必须用**已知正确的参考值**固定住，
 * 不能只做"自己编自己解"的往返测试——那对抵消性的错误毫无检测力。
 */
describe('IPv4 地址转换', () => {
  it('点分十进制与 32 位整数互转', () => {
    expect(ipToInt('10.126.200.1')).toBe(0x0a7ec801);
    expect(intToIp(0x0a7ec801)).toBe('10.126.200.1');
    expect(ipToInt('0.0.0.0')).toBe(0);
    expect(ipToInt('255.255.255.255')).toBe(0xffffffff);
  });

  it('非法地址抛错而不是静默返回 0', () => {
    expect(() => ipToInt('1.2.3')).toThrow();
    expect(() => ipToInt('1.2.3.256')).toThrow();
    expect(() => ipToInt('a.b.c.d')).toThrow();
  });
});

describe('internet 校验和', () => {
  it('对全零数据的结果是 0xffff', () => {
    expect(internetChecksum(Buffer.alloc(20))).toBe(0xffff);
  });

  it('校验和自验证：把自己填进去后整体校验为 0', () => {
    // 这是 RFC 1071 的性质：包含校验和字段的整个头再算一次结果为 0。
    // 用它验证"计算"与"验证"两条路径一致，比硬编码一个魔数更可靠。
    const header = encodeIpv4Header({
      totalLength: 40,
      identification: 0x1234,
      protocol: IpProtocol.TCP,
      src: '10.0.0.1',
      dst: '10.0.0.2',
    });
    expect(internetChecksum(header)).toBe(0);
  });

  it('奇数长度也能正确处理', () => {
    // 长度 3：0x0102 与 0x0300 累加
    const sum = internetChecksum(Buffer.from([0x01, 0x02, 0x03]));
    expect(sum).toBe(~((0x0102 + 0x0300) & 0xffff) & 0xffff);
  });
});

describe('IPv4 头', () => {
  it('编码后能被解码回来，字段全对', () => {
    const buf = encodeIpv4Header({
      totalLength: 60,
      identification: 0xabcd,
      protocol: IpProtocol.TCP,
      ttl: 64,
      src: '10.126.200.1',
      dst: '10.126.200.2',
      dontFragment: true,
    });
    expect(buf.length).toBe(20);

    const decoded = decodeIpv4Header(buf);
    expect(decoded).not.toBeNull();
    expect(decoded!.version).toBe(4);
    expect(decoded!.headerLength).toBe(20);
    expect(decoded!.totalLength).toBe(60);
    expect(decoded!.identification).toBe(0xabcd);
    expect(decoded!.protocol).toBe(IpProtocol.TCP);
    expect(decoded!.ttl).toBe(64);
    expect(decoded!.src).toBe('10.126.200.1');
    expect(decoded!.dst).toBe('10.126.200.2');
    expect(decoded!.dontFragment).toBe(true);
    expect(decoded!.moreFragments).toBe(false);
  });

  it('版本不是 4 时返回 null（调用方据此丢弃）', () => {
    const buf = encodeIpv4Header({
      totalLength: 20,
      identification: 1,
      protocol: IpProtocol.TCP,
      src: '1.1.1.1',
      dst: '2.2.2.2',
    });
    buf[0] = 0x65; // version 6
    expect(decodeIpv4Header(buf)).toBeNull();
  });

  it('长度不足 20 字节返回 null', () => {
    expect(decodeIpv4Header(Buffer.alloc(19))).toBeNull();
  });
});

describe('TCP 头', () => {
  const pseudo = { src: '10.126.200.1', dst: '10.126.200.2', tcpLength: 20 };

  it('编码后能解码回来，字段全对', () => {
    const buf = buildTcpSegment({
      srcPort: 8080,
      dstPort: 8787,
      seq: 1000,
      ack: 2000,
      flags: TcpFlags.SYN | TcpFlags.ACK,
      window: 65535,
      srcIp: pseudo.src,
      dstIp: pseudo.dst,
    });
    const decoded = decodeTcpHeader(buf);
    expect(decoded).not.toBeNull();
    expect(decoded!.srcPort).toBe(8080);
    expect(decoded!.dstPort).toBe(8787);
    expect(decoded!.seq).toBe(1000);
    expect(decoded!.ack).toBe(2000);
    expect(decoded!.window).toBe(65535);
    expect(decoded!.dataOffset).toBe(20);
    expect(hasTcpFlag(decoded!.flags, TcpFlags.SYN)).toBe(true);
    expect(hasTcpFlag(decoded!.flags, TcpFlags.ACK)).toBe(true);
    expect(hasTcpFlag(decoded!.flags, TcpFlags.FIN)).toBe(false);
  });

  it('校验和含伪首部，且自验证为 0', () => {
    // 这是最容易漏的地方：只对 TCP 段算校验和（不含伪首部）会被对端丢弃。
    // 用"伪首部 + 段"整体再算一次结果为 0 来固定。
    const buf = buildTcpSegment({
      srcPort: 1234,
      dstPort: 5678,
      seq: 1,
      ack: 0,
      flags: TcpFlags.SYN,
      window: 1024,
      srcIp: pseudo.src,
      dstIp: pseudo.dst,
    });
    const pseudoHeader = Buffer.alloc(12);
    pseudoHeader.writeUInt32BE(ipToInt(pseudo.src), 0);
    pseudoHeader.writeUInt32BE(ipToInt(pseudo.dst), 4);
    pseudoHeader[9] = IpProtocol.TCP;
    pseudoHeader.writeUInt16BE(20, 10);
    expect(internetChecksum(Buffer.concat([pseudoHeader, buf]))).toBe(0);
  });

  it('带载荷时伪首部长度包含载荷', () => {
    const payload = Buffer.from('hello');
    const buf = buildTcpSegment({
      srcPort: 1,
      dstPort: 2,
      seq: 0,
      ack: 0,
      flags: TcpFlags.PSH | TcpFlags.ACK,
      window: 100,
      payload,
      srcIp: pseudo.src,
      dstIp: pseudo.dst,
    });
    expect(buf.length).toBe(20 + payload.length);
    // 校验和必须用 25 的段长算；用 20 会得到不同的值
    const wrong = tcpChecksum(buf, { ...pseudo, tcpLength: 20 });
    const right = tcpChecksum(buf, { ...pseudo, tcpLength: 25 });
    expect(wrong).not.toBe(right);
  });
});

describe('UDP 头', () => {
  it('编码后能解码回来', () => {
    const buf = encodeUdpHeader({ srcPort: 5353, dstPort: 53, length: 8 + 10 });
    const decoded = decodeUdpHeader(buf);
    expect(decoded).not.toBeNull();
    expect(decoded!.srcPort).toBe(5353);
    expect(decoded!.dstPort).toBe(53);
    expect(decoded!.length).toBe(18);
  });

  it('长度不足 8 字节返回 null', () => {
    expect(decodeUdpHeader(Buffer.alloc(7))).toBeNull();
  });
});

describe('完整 IP 包构造', () => {
  it('IP 头 + TCP 段能拆回来（这是数据面的基本单元）', () => {
    const tcp = buildTcpSegment({
      srcPort: 40000,
      dstPort: 8787,
      seq: 7,
      ack: 8,
      flags: TcpFlags.ACK,
      window: 500,
      payload: Buffer.from('payload'),
      srcIp: '10.126.200.1',
      dstIp: '10.126.200.2',
    });
    const ip = buildIpv4Packet({
      src: '10.126.200.1',
      dst: '10.126.200.2',
      protocol: IpProtocol.TCP,
      payload: tcp,
      identification: 42,
    });

    const ipHeader = decodeIpv4Header(ip);
    expect(ipHeader).not.toBeNull();
    expect(ipHeader!.totalLength).toBe(ip.length);
    expect(ipHeader!.protocol).toBe(IpProtocol.TCP);
    expect(ipHeader!.src).toBe('10.126.200.1');

    const tcpHeader = decodeTcpHeader(ip.subarray(ipHeader!.headerLength));
    expect(tcpHeader!.dstPort).toBe(8787);
    // 载荷内容必须原样保留
    const payload = ip.subarray(ipHeader!.headerLength + tcpHeader!.dataOffset);
    expect(payload.toString()).toBe('payload');
  });

  it('IP 头校验和自验证为 0', () => {
    const ip = buildIpv4Packet({
      src: '10.126.200.1',
      dst: '10.126.200.2',
      protocol: IpProtocol.UDP,
      payload: Buffer.from('x'),
      identification: 1,
    });
    expect(internetChecksum(ip.subarray(0, 20))).toBe(0);
  });
});
