import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { TcpStack } from '../src/networking/easytier/tcpStack';
import {
  IpProtocol,
  TcpFlags,
  TcpOptionKind,
  buildIpv4Packet,
  buildTcpSegment,
  decodeIpv4Header,
  decodeTcpHeader,
  decodeTcpOptions,
  hasTcpFlag,
} from '../src/networking/easytier/ip';

/**
 * TCP SACK（选择性确认）。
 *
 * 没有 SACK 时，丢包后只能整段重传或等超时——大窗口下极其浪费。
 * SACK 让接收方告诉发送方"这些区间我收到了"，发送方只补真正缺的那块。
 *
 * 这个测试同时固定了一个被修掉的真 bug：**接收路径原本完全不做序列号
 * 校验**（注释写着"序列号校验"但代码只做 `recvNext += len`）。网络一乱序，
 * 写进本机 socket 的字节顺序就错了——而 TCP 承诺的是有序字节流。
 */

const LOCAL_IP = '10.126.232.1';
const REMOTE_IP = '10.126.232.2';
const REMOTE_PORT = 48000;
const LOCAL_PORT = 8787;

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

/** 起一个本机服务，把收到的字节累积到 `received`。 */
async function startSinkServer(): Promise<{ port: number; received: () => string }> {
  let buffer = '';
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    port: (server.address() as net.AddressInfo).port,
    received: () => buffer,
  };
}

/** 从发出的包里找带指定选项的 TCP 段。 */
function findSegment(
  packets: Buffer[],
  predicate: (header: ReturnType<typeof decodeTcpHeader>, options: ReturnType<typeof decodeTcpOptions>) => boolean,
): { header: NonNullable<ReturnType<typeof decodeTcpHeader>>; options: ReturnType<typeof decodeTcpOptions> } | null {
  for (const packet of packets) {
    const ip = decodeIpv4Header(packet);
    if (ip === null || ip.protocol !== IpProtocol.TCP) continue;
    const seg = packet.subarray(ip.headerLength);
    const header = decodeTcpHeader(seg);
    if (header === null) continue;
    const options =
      header.dataOffset > 20 ? decodeTcpOptions(seg.subarray(20, header.dataOffset)) : [];
    if (predicate(header, options)) return { header, options };
  }
  return null;
}

/** 带 SACK_PERMITTED 的握手，返回 nextSeq 与 ourSeq。 */
function handshakeWithSack(
  stack: TcpStack,
  sink: { packets: Buffer[] },
): { nextSeq: number; ourSeq: number } {
  const synOptions = [{ kind: TcpOptionKind.SACK_PERMITTED } as const];
  stack.handleIpPacket(
    buildIpv4Packet({
      src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 1,
      payload: buildTcpSegment({
        srcPort: REMOTE_PORT, dstPort: LOCAL_PORT, seq: 1000, ack: 0,
        flags: TcpFlags.SYN, window: 65535, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
        tcpOptions: [...synOptions],
      }),
    }),
  );
  const synAck = findSegment(sink.packets, (h) => hasTcpFlag(h!.flags, TcpFlags.SYN))!;
  const ourSeq = (synAck.header.seq + 1) >>> 0;

  stack.handleIpPacket(
    buildIpv4Packet({
      src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 2,
      payload: buildTcpSegment({
        srcPort: REMOTE_PORT, dstPort: LOCAL_PORT, seq: 1001, ack: ourSeq,
        flags: TcpFlags.ACK, window: 65535, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
      }),
    }),
  );
  return { nextSeq: 1001, ourSeq };
}

describe('TCP SACK', () => {
  it('对端 SYN 带 SACK_PERMITTED 时，我们的 SYN-ACK 也宣告 SACK 支持', async () => {
    const server = await startSinkServer();
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP, bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn, retransmitBaseMs: 60_000,
    });
    stacks.push(stack);
    stack.listen(LOCAL_PORT, server.port);
    stack.start();

    handshakeWithSack(stack, sink);

    const synAck = findSegment(sink.packets, (h) => hasTcpFlag(h!.flags, TcpFlags.SYN));
    expect(synAck).not.toBeNull();
    const kinds = synAck!.options.map((option) => option.kind);
    // 双向同意才生效：只在 SYN-ACK 里也带 SACK_PERMITTED，对端才会发 SACK 块
    expect(kinds).toContain(TcpOptionKind.SACK_PERMITTED);
    // 顺带宣告 MSS，让对端别发超长段
    expect(kinds).toContain(TcpOptionKind.MSS);
  }, 15_000);

  it('乱序数据被缓存而不是乱序交付（有序字节流承诺）', async () => {
    const server = await startSinkServer();
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP, bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn, retransmitBaseMs: 60_000,
    });
    stacks.push(stack);
    stack.listen(LOCAL_PORT, server.port);
    stack.start();

    const hs = handshakeWithSack(stack, sink);
    await new Promise((r) => setTimeout(r, 200));

    // 先发第二段（序列号靠后），再发第一段——模拟网络乱序
    const second = Buffer.from('SECOND');
    const first = Buffer.from('FIRST-');
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 3,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT, dstPort: LOCAL_PORT,
          seq: (hs.nextSeq + first.length) >>> 0, ack: hs.ourSeq,
          flags: TcpFlags.PSH | TcpFlags.ACK, window: 65535,
          payload: second, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    // 此时第二段还在缓存里，本机服务不该收到它
    expect(server.received()).toBe('');

    // 补上第一段后，两段按正确顺序一起交付
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 4,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT, dstPort: LOCAL_PORT,
          seq: hs.nextSeq, ack: hs.ourSeq,
          flags: TcpFlags.PSH | TcpFlags.ACK, window: 65535,
          payload: first, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(server.received()).toBe('FIRST-SECOND');
  }, 15_000);

  it('乱序到达时用 SACK 块上报收到的区间', async () => {
    const server = await startSinkServer();
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP, bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn, retransmitBaseMs: 60_000,
    });
    stacks.push(stack);
    stack.listen(LOCAL_PORT, server.port);
    stack.start();

    const hs = handshakeWithSack(stack, sink);
    await new Promise((r) => setTimeout(r, 200));
    sink.packets.length = 0;

    // 发一段"未来"数据（跳过第一段）
    const gap = 100;
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 3,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT, dstPort: LOCAL_PORT,
          seq: (hs.nextSeq + gap) >>> 0, ack: hs.ourSeq,
          flags: TcpFlags.PSH | TcpFlags.ACK, window: 65535,
          payload: Buffer.from('EARLY'), srcIp: REMOTE_IP, dstIp: LOCAL_IP,
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 100));

    // ACK 里必须带 SACK 块，指明"从 nextSeq+gap 开始我收到了"
    const ack = findSegment(sink.packets, (_h, options) =>
      options.some((option) => option.kind === TcpOptionKind.SACK),
    );
    expect(ack, '乱序到达时没有上报 SACK 块').not.toBeNull();
    const sack = ack!.options.find((option) => option.kind === TcpOptionKind.SACK);
    expect(sack!.kind).toBe(TcpOptionKind.SACK);
    if (sack!.kind === TcpOptionKind.SACK) {
      const block = sack!.blocks[0];
      expect(block.left).toBe((hs.nextSeq + gap) >>> 0);
      expect(block.right).toBe((hs.nextSeq + gap + 5) >>> 0);
    }
  }, 15_000);

  it('对端用 SACK 告知已收到后，不再重传那些数据', async () => {
    // 起一个会发大量数据的服务，让 unacked 里有多段
    const payload = Buffer.alloc(6000, 0x42);
    const server = net.createServer((socket) => {
      socket.write(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);

    const sink = makeSink();
    const logs: string[] = [];
    const stack = new TcpStack({
      localIp: LOCAL_IP, bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn,
      // RTO 很短：如果 SACK 过滤失效，会看到大量重传
      retransmitBaseMs: 150,
      log: (m) => logs.push(m),
    });
    stacks.push(stack);
    stack.listen(LOCAL_PORT, (server.address() as net.AddressInfo).port);
    stack.start();

    const hs = handshakeWithSack(stack, sink);
    await new Promise((r) => setTimeout(r, 300));
    // 必须**按 seq 去重**：RTO 很短（150ms），在快照时刻之前已经发生过
    // 超时重传，`sink.packets` 里同一个 seq 会出现多次。
    // 踩过：直接取最后一个元素当"最大末尾"，取到的可能是重复的短段，
    // 导致 SACK 块的右边界比实际发送范围小，于是误判"实现没过滤"。
    const rawSegs = sink.packets
      .map((packet) => {
        const ip = decodeIpv4Header(packet);
        if (ip === null) return null;
        const seg = packet.subarray(ip.headerLength);
        const header = decodeTcpHeader(seg);
        if (header === null) return null;
        const len = seg.subarray(header.dataOffset).length;
        return len > 0 ? { seq: header.seq, len } : null;
      })
      .filter((s): s is { seq: number; len: number } => s !== null);

    const bySeq = new Map<number, number>();
    for (const seg of rawSegs) bySeq.set(seg.seq, Math.max(bySeq.get(seg.seq) ?? 0, seg.len));
    const dataSegs = [...bySeq.entries()]
      .map(([seq, len]) => ({ seq, len }))
      .sort((a, b) => a.seq - b.seq);
    expect(dataSegs.length).toBeGreaterThan(1);

    // 确认第一段；对**其余段**用 SACK 告知"都收到了"。
    // 右边界取所有段的**最大末尾**，而不是"最后一个元素"。
    const first = dataSegs[0];
    const maxEnd = Math.max(...dataSegs.map((d) => d.seq + d.len)) >>> 0;
    sink.packets.length = 0;
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 9,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT, dstPort: LOCAL_PORT,
          seq: hs.nextSeq, ack: (first.seq + first.len) >>> 0,
          flags: TcpFlags.ACK, window: 65535,
          srcIp: REMOTE_IP, dstIp: LOCAL_IP,
          tcpOptions: [
            {
              kind: TcpOptionKind.SACK,
              blocks: [
                {
                  left: (first.seq + first.len) >>> 0,
                  right: maxEnd,
                },
              ],
            },
          ],
        }),
      }),
    );

    // 等超过若干 RTO：被 SACK 覆盖的段不该重传
    await new Promise((r) => setTimeout(r, 700));
    const retransmitted = sink.packets.filter((packet) => {
      const ip = decodeIpv4Header(packet);
      if (ip === null) return false;
      const seg = packet.subarray(ip.headerLength);
      const header = decodeTcpHeader(seg);
      if (header === null) return false;
      if (seg.subarray(header.dataOffset).length === 0) return false;
      // 落在 SACK 区间内 = 本不该重传
      return dataSegs.some((d) => d.seq === header.seq && d.seq !== first.seq);
    });
    expect(
      retransmitted.length,
      `被 SACK 覆盖的段被重传了 ${retransmitted.length} 次`,
    ).toBe(0);
  }, 20_000);
});
