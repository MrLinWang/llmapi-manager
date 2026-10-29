/**
 * ICMP echo 应答：让虚拟网络里的 `ping` 能通。
 *
 * # 为什么值得单独做
 *
 * `ping` 是最常用的"通不通"判据。虚拟网内 ping 不通会让人去怀疑路由、
 * 怀疑对端是否在线、怀疑 MTU——而真正的原因只是我们没实现 ICMP。
 * 这属于典型的"症状指向错误方向"。
 *
 * # 实现范围（刻意很窄）
 *
 * 只做 echo request（type 8）→ echo reply（type 0）。这是 ping 需要的
 * 全部，也是唯一有实际诊断价值的部分。**不做**：
 *
 * - 其他 ICMP 类型（目的不可达、超时、重定向）——那是路由器/内核的职责，
 *   虚拟网络里没有对应实体
 * - 分片 ICMP（超长 ping 包会走 IP 分片，由 `ipReassembly.ts` 处理）
 *
 * ICMP 没有端口概念，所以不需要会话表——收到就答，无状态。
 */

import { IpProtocol, buildIpv4Packet, internetChecksum } from './ip';

/** ICMP 类型。 */
export const IcmpType = {
  ECHO_REPLY: 0,
  DEST_UNREACHABLE: 3,
  ECHO_REQUEST: 8,
  TIME_EXCEEDED: 11,
} as const;

/**
 * 把 ICMP echo request 变成 echo reply。
 *
 * 规则（RFC 792）：交换源/目的地址，类型改成 0，**载荷原样保留**
 * （ping 靠载荷里的序列号与时间戳匹配请求与响应），重算校验和。
 *
 * 返回 null 表示这不是 echo request，调用方应自行丢弃。
 */
export function buildIcmpEchoReply(
  ipPacket: Buffer,
  localIp: string,
  remoteIp: string,
): Buffer | null {
  // IP 头长度 = IHL * 4
  if (ipPacket.length < 20) return null;
  const headerLength = (ipPacket[0] & 0x0f) * 4;
  if (headerLength < 20 || ipPacket.length < headerLength + 8) return null;

  const icmp = ipPacket.subarray(headerLength);
  if (icmp[0] !== IcmpType.ECHO_REQUEST) return null;

  // 复制整个 ICMP 消息（头 8 字节 + 载荷），只改类型与校验和
  const reply = Buffer.from(icmp);
  reply[0] = IcmpType.ECHO_REPLY;
  reply[1] = 0; // code
  // 校验和字段先清零再算
  reply.writeUInt16BE(0, 2);
  reply.writeUInt16BE(internetChecksum(reply), 2);

  return buildIpv4Packet({
    src: localIp,
    dst: remoteIp,
    protocol: IpProtocol.ICMP,
    payload: reply,
    identification: (Math.random() * 0xffff) & 0xffff,
  });
}

/** 构造一个 ICMP echo request（测试用，模拟对端 ping 我们）。 */
export function buildIcmpEchoRequest(options: {
  srcIp: string;
  dstIp: string;
  identifier: number;
  sequence: number;
  payload: Buffer;
}): Buffer {
  const head = Buffer.alloc(8);
  head[0] = IcmpType.ECHO_REQUEST;
  head[1] = 0;
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(options.identifier, 4);
  head.writeUInt16BE(options.sequence, 6);
  const message = Buffer.concat([head, options.payload]);
  message.writeUInt16BE(internetChecksum(message), 2);

  return buildIpv4Packet({
    src: options.srcIp,
    dst: options.dstIp,
    protocol: IpProtocol.ICMP,
    payload: message,
    identification: (Math.random() * 0xffff) & 0xffff,
  });
}
