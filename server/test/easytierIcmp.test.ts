import { describe, expect, it } from 'vitest';
import { IcmpType, buildIcmpEchoReply, buildIcmpEchoRequest } from '../src/networking/easytier/icmp';
import { IpProtocol, decodeIpv4Header, internetChecksum } from '../src/networking/easytier/ip';

/**
 * ICMP echo 应答（`ping` 能不能通）。
 *
 * 单独测它的理由：`ping` 是用户判断"虚拟网通不通"的第一个动作。
 * 如果它不通，用户会去查路由、查对端在线状态、查 MTU——全都不对，
 * 真正的原因只是没实现 ICMP。
 */

const REMOTE_IP = '10.126.240.2';
const LOCAL_IP = '10.126.240.1';

describe('ICMP echo 应答', () => {
  it('echo request 变成 echo reply，载荷原样保留', () => {
    const payload = Buffer.from('ping-payload-123');
    const request = buildIcmpEchoRequest({
      srcIp: REMOTE_IP,
      dstIp: LOCAL_IP,
      identifier: 0x1234,
      sequence: 7,
      payload,
    });

    const reply = buildIcmpEchoReply(request, LOCAL_IP, REMOTE_IP);
    expect(reply).not.toBeNull();

    const ip = decodeIpv4Header(reply!);
    expect(ip).not.toBeNull();
    // 地址必须对调
    expect(ip!.src).toBe(LOCAL_IP);
    expect(ip!.dst).toBe(REMOTE_IP);
    expect(ip!.protocol).toBe(IpProtocol.ICMP);

    const icmp = reply!.subarray(ip!.headerLength);
    // 类型必须从 8（request）变成 0（reply）
    expect(icmp[0]).toBe(IcmpType.ECHO_REPLY);
    expect(icmp[1]).toBe(0);
    // 标识符与序列号必须保留——ping 靠它们匹配请求与响应
    expect(icmp.readUInt16BE(4)).toBe(0x1234);
    expect(icmp.readUInt16BE(6)).toBe(7);
    // 载荷原样（ping 里含时间戳，改了就算不出 RTT）
    expect(icmp.subarray(8).toString()).toBe('ping-payload-123');
  });

  it('应答的校验和正确（自验证为 0）', () => {
    const request = buildIcmpEchoRequest({
      srcIp: REMOTE_IP,
      dstIp: LOCAL_IP,
      identifier: 1,
      sequence: 1,
      payload: Buffer.from('abc'),
    });
    const reply = buildIcmpEchoReply(request, LOCAL_IP, REMOTE_IP)!;
    const ip = decodeIpv4Header(reply)!;
    const icmp = reply.subarray(ip.headerLength);
    // 含校验和字段的整条 ICMP 消息再算一次应为 0
    expect(internetChecksum(icmp)).toBe(0);
  });

  it('非 echo request 返回 null（其余 ICMP 类型不由本实现处理）', () => {
    const request = buildIcmpEchoRequest({
      srcIp: REMOTE_IP,
      dstIp: LOCAL_IP,
      identifier: 1,
      sequence: 1,
      payload: Buffer.alloc(0),
    });
    // 改成"目的不可达"
    const ip = decodeIpv4Header(request)!;
    request[ip.headerLength] = IcmpType.DEST_UNREACHABLE;
    expect(buildIcmpEchoReply(request, LOCAL_IP, REMOTE_IP)).toBeNull();
  });

  it('截断的包不会崩，返回 null', () => {
    expect(buildIcmpEchoReply(Buffer.alloc(10), LOCAL_IP, REMOTE_IP)).toBeNull();
    const request = buildIcmpEchoRequest({
      srcIp: REMOTE_IP, dstIp: LOCAL_IP, identifier: 1, sequence: 1, payload: Buffer.alloc(0),
    });
    // 砍掉 ICMP 头的一部分
    expect(buildIcmpEchoReply(request.subarray(0, 24), LOCAL_IP, REMOTE_IP)).toBeNull();
  });
});
