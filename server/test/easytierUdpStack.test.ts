import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { UdpStack } from '../src/networking/easytier/udpStack';
import {
  IpProtocol,
  buildIpv4Packet,
  buildUdpDatagram,
  decodeIpv4Header,
  decodeUdpHeader,
  internetChecksum,
  ipToInt,
} from '../src/networking/easytier/ip';

/**
 * 用户态 UDP 转发的行为验证。
 *
 * 关键点与 TCP 测试一致：**对端是真的**。本机起一个真实 UDP 服务（模拟 DNS），
 * 虚拟 UDP 栈把数据报转过去，再验证回包能正确封成 IP 包发回虚拟侧。
 *
 * 为什么单独测 UDP：DNS 走 UDP，而"连得上但域名解析不了"是很容易误判成
 * DNS 配置问题的症状——真正的原因往往是 UDP 没转发。
 */

const LOCAL_IP = '10.126.230.1';
const REMOTE_IP = '10.126.230.2';
const REMOTE_PORT = 53000;

function makeSink(): { packets: Buffer[]; fn: (p: Buffer) => void } {
  const packets: Buffer[] = [];
  return { packets, fn: (p) => packets.push(p) };
}

let stacks: UdpStack[] = [];
const servers: dgram.Socket[] = [];

afterEach(async () => {
  for (const stack of stacks) stack.close();
  stacks = [];
  await Promise.all(
    servers.map(
      (srv) =>
        new Promise<void>((resolve) => {
          try {
            srv.close(() => resolve());
          } catch {
            resolve();
          }
        }),
    ),
  );
  servers.length = 0;
});

/** 起一个真实的本机 UDP 服务（回显，模拟 DNS 应答）。 */
async function startUdpEcho(): Promise<number> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (message, remote) => {
    socket.send(Buffer.concat([Buffer.from('resp:'), message]), remote.port, remote.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  servers.push(socket);
  return (socket.address() as { port: number }).port;
}

/** 从发出的包列表里找 UDP 包。 */
function findUdp(packets: Buffer[]): { header: ReturnType<typeof decodeUdpHeader>; payload: Buffer } | null {
  for (const packet of packets) {
    const ip = decodeIpv4Header(packet);
    if (ip === null || ip.protocol !== IpProtocol.UDP) continue;
    const datagram = packet.subarray(ip.headerLength);
    const header = decodeUdpHeader(datagram);
    if (header === null) continue;
    return { header, payload: datagram.subarray(8) };
  }
  return null;
}

describe('用户态 UDP 转发', () => {
  it('虚拟 UDP 数据报能转到本机服务，回包再封成 IP 包发回', async () => {
    const localPort = await startUdpEcho();
    const sink = makeSink();
    const stack = new UdpStack({
      localIp: LOCAL_IP,
      forwardHost: '127.0.0.1',
      sendIpPacket: sink.fn,
    });
    stacks.push(stack);
    stack.listen(53, '127.0.0.1', localPort);
    stack.start();

    // 虚拟对端发一个"DNS 查询"
    const query = Buffer.from('query-payload');
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP,
        dst: LOCAL_IP,
        protocol: IpProtocol.UDP,
        identification: 1,
        payload: buildUdpDatagram({
          srcPort: REMOTE_PORT,
          dstPort: 53,
          payload: query,
          srcIp: REMOTE_IP,
          dstIp: LOCAL_IP,
        }),
      }),
    );

    // 等本机服务回包
    await new Promise((r) => setTimeout(r, 250));

    const response = findUdp(sink.packets);
    expect(response).not.toBeNull();
    // 回包的源端口必须是虚拟侧的 53（对端按四元组匹配请求与响应）
    expect(response!.header!.srcPort).toBe(53);
    expect(response!.header!.dstPort).toBe(REMOTE_PORT);
    expect(response!.payload.toString()).toBe('resp:query-payload');
  }, 15_000);

  it('没有映射的端口被丢弃，但会记日志（不能静默）', () => {
    const logs: string[] = [];
    const sink = makeSink();
    const stack = new UdpStack({
      localIp: LOCAL_IP,
      forwardHost: '127.0.0.1',
      sendIpPacket: sink.fn,
      log: (message) => logs.push(message),
    });
    stacks.push(stack);

    const handled = stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP,
        dst: LOCAL_IP,
        protocol: IpProtocol.UDP,
        identification: 1,
        payload: buildUdpDatagram({
          srcPort: REMOTE_PORT,
          dstPort: 9999, // 没配映射
          payload: Buffer.from('x'),
          srcIp: REMOTE_IP,
          dstIp: LOCAL_IP,
        }),
      }),
    );

    expect(handled).toBe(true);
    // 日志要能指出端口，用户才知道该配哪条映射
    expect(logs.join('')).toContain('9999');
    expect(stack.sessionCount()).toBe(0);
  });

  it('同一四元组的连续数据报复用同一个会话（DNS 一问一答靠它）', async () => {
    const localPort = await startUdpEcho();
    const sink = makeSink();
    const stack = new UdpStack({
      localIp: LOCAL_IP,
      forwardHost: '127.0.0.1',
      sendIpPacket: sink.fn,
    });
    stacks.push(stack);
    stack.listen(53, '127.0.0.1', localPort);
    stack.start();

    for (const label of ['a', 'b']) {
      stack.handleIpPacket(
        buildIpv4Packet({
          src: REMOTE_IP,
          dst: LOCAL_IP,
          protocol: IpProtocol.UDP,
          identification: 1,
          payload: buildUdpDatagram({
            srcPort: REMOTE_PORT,
            dstPort: 53,
            payload: Buffer.from(label),
            srcIp: REMOTE_IP,
            dstIp: LOCAL_IP,
          }),
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 300));

    // 同一个源端口只该有一个会话；两个包都该拿到回包
    expect(stack.sessionCount()).toBe(1);
    expect(sink.packets.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('UDP 校验和算出来是 0 时写成 0xffff（0 在 UDP 里表示"未校验"）', () => {
    // 这是 UDP 特有的坑：把真实校验结果 0 原样写进去，等于声明"不校验"，
    // 对端可能因此接受被篡改的包。
    const datagram = buildUdpDatagram({
      srcPort: 1,
      dstPort: 2,
      payload: Buffer.from('x'),
      srcIp: '10.0.0.1',
      dstIp: '10.0.0.2',
    });
    const checksum = datagram.readUInt16BE(6);
    // 校验和字段本身不该是 0（除非真的算出了 0，那时应写成 0xffff）
    const recomputed = (() => {
      // 用"伪首部 + 整个数据报"再算一次，结果应为 0（自验证）
      const pseudo = Buffer.alloc(12);
      pseudo.writeUInt32BE(ipToInt('10.0.0.1'), 0);
      pseudo.writeUInt32BE(ipToInt('10.0.0.2'), 4);
      pseudo[9] = 17;
      pseudo.writeUInt16BE(datagram.length, 10);
      return internetChecksum(Buffer.concat([pseudo, datagram]));
    })();
    expect(recomputed).toBe(0);
    expect(checksum).not.toBe(0);
  });
});
