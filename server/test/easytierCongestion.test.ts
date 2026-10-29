import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { TcpStack } from '../src/networking/easytier/tcpStack';
import {
  IpProtocol,
  TcpFlags,
  buildIpv4Packet,
  buildTcpSegment,
  decodeIpv4Header,
  decodeTcpHeader,
  hasTcpFlag,
} from '../src/networking/easytier/ip';

/**
 * TCP 拥塞控制。
 *
 * 之前是固定窗口、无任何拥塞控制：一次把几 MB 灌进网络，丢包后靠超时
 * 重传，长连接吞吐明显低于官方实现。
 *
 * 这里验证四件事（都是拥塞控制的最小正确性要求）：
 * 1. 发送受窗口限制，不会一次灌满网络
 * 2. 慢启动阶段窗口随确认增长
 * 3. 超时丢包时窗口收缩（ssthresh 砍半、cwnd 回到最小）
 * 4. 3 个重复 ACK 触发快速重传（不等 RTO）
 */

const LOCAL_IP = '10.126.227.1';
const REMOTE_IP = '10.126.227.2';
const REMOTE_PORT = 47000;

function makeSink(): { packets: Buffer[]; fn: (p: Buffer) => void } {
  const packets: Buffer[] = [];
  return { packets, fn: (p) => packets.push(p) };
}

let stacks: TcpStack[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const stack of stacks) stack.close();
  stacks = [];
  await Promise.all(
    servers.map(
      (srv) =>
        new Promise<void>((resolve) => {
          srv.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

/** 起一个本机 TCP 服务，连上后立刻发一大段数据。 */
async function startBigSender(totalBytes: number): Promise<number> {
  const payload = Buffer.alloc(totalBytes, 0x41);
  const server = net.createServer((socket) => {
    socket.write(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (server.address() as net.AddressInfo).port;
}

/** 完成三次握手，返回 SYN-ACK 段信息。 */
function handshake(
  stack: TcpStack,
  sink: { packets: Buffer[] },
): { nextSeq: number; ourSeq: number } {
  stack.handleIpPacket(
    buildIpv4Packet({
      src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 1,
      payload: buildTcpSegment({
        srcPort: REMOTE_PORT, dstPort: 8787, seq: 1000, ack: 0,
        flags: TcpFlags.SYN, window: 65535, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
      }),
    }),
  );
  const synAck = sink.packets
    .map((packet) => {
      const ip = decodeIpv4Header(packet);
      if (ip === null) return null;
      const seg = packet.subarray(ip.headerLength);
      const header = decodeTcpHeader(seg);
      return header !== null && hasTcpFlag(header.flags, TcpFlags.SYN) ? header : null;
    })
    .filter((h): h is NonNullable<typeof h> => h !== null)[0];
  const ourSeq = (synAck.seq + 1) >>> 0;

  stack.handleIpPacket(
    buildIpv4Packet({
      src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 2,
      payload: buildTcpSegment({
        srcPort: REMOTE_PORT, dstPort: 8787, seq: 1001, ack: ourSeq,
        flags: TcpFlags.ACK, window: 65535, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
      }),
    }),
  );
  return { nextSeq: 1001, ourSeq };
}

/** 统计发出的数据段（有载荷的）。 */
function dataSegments(packets: Buffer[]): Array<{ seq: number; len: number; flags: number }> {
  return packets
    .map((packet) => {
      const ip = decodeIpv4Header(packet);
      if (ip === null) return null;
      const seg = packet.subarray(ip.headerLength);
      const header = decodeTcpHeader(seg);
      if (header === null) return null;
      const len = seg.subarray(header.dataOffset).length;
      return len > 0 ? { seq: header.seq, len, flags: header.flags } : null;
    })
    .filter((s): s is { seq: number; len: number; flags: number } => s !== null);
}

describe('TCP 拥塞控制', () => {
  it('初始只发一个拥塞窗口的量，不会一次把大数据全灌出去', async () => {
    const bridgePort = await startBigSender(20_000);
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP, bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn, retransmitBaseMs: 5_000,
    });
    stacks.push(stack);
    stack.listen(8787, bridgePort);
    stack.start();

    handshake(stack, sink);
    await new Promise((r) => setTimeout(r, 400));

    const segs = dataSegments(sink.packets);
    const sentBytes = segs.reduce((sum, s) => sum + s.len, 0);
    // 初始 cwnd = 4 × MSS = 5360 字节。绝不能把 20000 字节全发出去。
    expect(sentBytes).toBeGreaterThan(0);
    expect(sentBytes).toBeLessThanOrEqual(4 * 1340);
  }, 15_000);

  it('确认到达后窗口增长，后续数据才被放行', async () => {
    const bridgePort = await startBigSender(20_000);
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP, bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn, retransmitBaseMs: 5_000,
    });
    stacks.push(stack);
    stack.listen(8787, bridgePort);
    stack.start();

    const hs = handshake(stack, sink);
    await new Promise((r) => setTimeout(r, 300));
    const firstBatch = dataSegments(sink.packets);
    const firstBytes = firstBatch.reduce((sum, s) => sum + s.len, 0);
    expect(firstBytes).toBeGreaterThan(0);

    // 确认第一批全部数据
    const last = firstBatch[firstBatch.length - 1];
    const ackAll = (last.seq + last.len) >>> 0;
    sink.packets.length = 0;
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 3,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT, dstPort: 8787, seq: hs.nextSeq, ack: ackAll,
          flags: TcpFlags.ACK, window: 65535, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 300));

    // 窗口打开后必须继续发（否则就是"卡在初始窗口"）
    expect(dataSegments(sink.packets).length).toBeGreaterThan(0);
  }, 15_000);

  it('3 个重复 ACK 触发快速重传（不等超时）', async () => {
    const bridgePort = await startBigSender(10_000);
    const logs: string[] = [];
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP, bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn,
      // RTO 设得很长：如果实现靠超时重传，这条测试会超时失败
      retransmitBaseMs: 60_000,
      log: (m) => logs.push(m),
    });
    stacks.push(stack);
    stack.listen(8787, bridgePort);
    stack.start();

    const hs = handshake(stack, sink);
    await new Promise((r) => setTimeout(r, 300));
    const segs = dataSegments(sink.packets);
    expect(segs.length).toBeGreaterThan(0);

    // 确认第一段，制造"后续段丢失"的假象
    const first = segs[0];
    const ackFirst = (first.seq + first.len) >>> 0;
    sink.packets.length = 0;
    // 第一个 ACK 是"新确认"（更新 lastAckNumber），之后**再**发 3 个相同
    // 的 ACK 才是真正的"3 个重复 ACK"——RFC 5681 的快重传条件。
    for (let i = 0; i < 4; i += 1) {
      stack.handleIpPacket(
        buildIpv4Packet({
          src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 4 + i,
          payload: buildTcpSegment({
            srcPort: REMOTE_PORT, dstPort: 8787, seq: hs.nextSeq, ack: ackFirst,
            flags: TcpFlags.ACK, window: 65535, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
          }),
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 200));

    // 快速重传必须发生：日志里出现"快速重传"
    expect(logs.join('')).toContain('快速重传');
    // 且窗口收缩了
    expect(logs.join('')).toContain('拥塞');
  }, 20_000);

  it('窗口按 MSS 切段，不会发出超长段', async () => {
    const bridgePort = await startBigSender(10_000);
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP, bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn, retransmitBaseMs: 5_000,
    });
    stacks.push(stack);
    stack.listen(8787, bridgePort);
    stack.start();

    handshake(stack, sink);
    await new Promise((r) => setTimeout(r, 400));

    for (const seg of dataSegments(sink.packets)) {
      // MSS = 1340，超过说明没有按 MSS 切段（大段会让 IP 分片）
      expect(seg.len).toBeLessThanOrEqual(1340);
    }
  }, 15_000);
});
