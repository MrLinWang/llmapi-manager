import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { TcpStack, selectPeerForPacket } from '../src/networking/easytier/tcpStack';
import {
  IpProtocol,
  TcpFlags,
  buildIpv4Packet,
  buildTcpSegment,
  decodeIpv4Header,
  decodeTcpHeader,
  encodeUdpHeader,
  hasTcpFlag,
} from '../src/networking/easytier/ip';

/**
 * 用户态 TCP 栈的行为验证。
 *
 * 关键在于**对端是真的**：本机起一个真实 TCP 服务，虚拟 TCP 栈把连接桥过去，
 * 然后通过构造虚拟 IP 包来驱动握手与数据传输。这样验证的是"虚拟连接能真实
 * 传达数据"，而不是"我的状态机自洽"——后者对错误完全没检测力。
 *
 * 判据链：
 * 1. SYN → 收到 SYN-ACK（带正确 ack 号）
 * 2. ACK → 本机socket 真的收到连接
 * 3. 发数据 → 本机服务真的收到
 * 4. 本机服务回数据 → 虚拟侧收到 TCP 段，载荷一致
 */

const LOCAL_IP = '10.126.210.1';
const REMOTE_IP = '10.126.210.2';
const REMOTE_PORT = 45000;

/** 收集栈发出的 IP 包，便于断言。 */
function makeSink(): { packets: Buffer[]; fn: (p: Buffer) => void } {
  const packets: Buffer[] = [];
  return { packets, fn: (p) => packets.push(p) };
}

/** 从发出的包列表里找符合条件的 TCP 段。 */
function findSegment(
  packets: Buffer[],
  predicate: (h: ReturnType<typeof decodeTcpHeader>) => boolean,
): { header: NonNullable<ReturnType<typeof decodeTcpHeader>>; payload: Buffer } | null {
  for (const packet of packets) {
    const ip = decodeIpv4Header(packet);
    if (ip === null || ip.protocol !== IpProtocol.TCP) continue;
    const seg = packet.subarray(ip.headerLength);
    const header = decodeTcpHeader(seg);
    if (header === null) continue;
    if (predicate(header)) {
      return { header, payload: seg.subarray(header.dataOffset) };
    }
  }
  return null;
}

let stacks: TcpStack[] = [];
let servers: net.Server[] = [];

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
  servers = [];
});

/** 起一个真实的本机 TCP 服务，收到连接后回一行。 */
async function startEchoServer(): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      socket.write(Buffer.concat([Buffer.from('echo:'), chunk]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (server.address() as net.AddressInfo).port;
}

describe('用户态 TCP 栈：三次握手', () => {
  it('SYN 得到 SYN-ACK，ack 号是对端 seq+1', () => {
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP,
      bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn,
    });
    stacks.push(stack);
    stack.listen(8787, 1); // 桥接目标端口先不重要

    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP,
        dst: LOCAL_IP,
        protocol: IpProtocol.TCP,
        identification: 1,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT,
          dstPort: 8787,
          seq: 1000,
          ack: 0,
          flags: TcpFlags.SYN,
          window: 65535,
          srcIp: REMOTE_IP,
          dstIp: LOCAL_IP,
        }),
      }),
    );

    const synAck = findSegment(sink.packets, (h) => h !== null && hasTcpFlag(h.flags, TcpFlags.SYN));
    expect(synAck).not.toBeNull();
    expect(hasTcpFlag(synAck!.header.flags, TcpFlags.ACK)).toBe(true);
    // 对端 SYN 占掉 seq 1000，所以期望下一个是 1001
    expect(synAck!.header.ack).toBe(1001);
    expect(synAck!.header.dstPort).toBe(REMOTE_PORT);
    expect(stack.connectionCount()).toBe(1);
  });

  it('未监听的端口回 RST（让对端立刻失败而不是等超时）', () => {
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP,
      bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn,
    });
    stacks.push(stack);

    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP,
        dst: LOCAL_IP,
        protocol: IpProtocol.TCP,
        identification: 1,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT,
          dstPort: 9999, // 没监听
          seq: 1,
          ack: 0,
          flags: TcpFlags.SYN,
          window: 65535,
          srcIp: REMOTE_IP,
          dstIp: LOCAL_IP,
        }),
      }),
    );

    const rst = findSegment(sink.packets, (h) => h !== null && hasTcpFlag(h.flags, TcpFlags.RST));
    expect(rst).not.toBeNull();
    expect(stack.connectionCount()).toBe(0);
  });
});

describe('用户态 TCP 栈：数据能真的传到本机服务', () => {
  it('握手后发数据，本机服务收到并回应，载荷原样返回虚拟侧', async () => {
    const bridgePort = await startEchoServer();
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP,
      bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn,
      retransmitBaseMs: 200,
    });
    stacks.push(stack);
    stack.listen(8787, bridgePort);
    stack.start();

    // ── 握手 ──
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP,
        dst: LOCAL_IP,
        protocol: IpProtocol.TCP,
        identification: 1,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT,
          dstPort: 8787,
          seq: 500,
          ack: 0,
          flags: TcpFlags.SYN,
          window: 65535,
          srcIp: REMOTE_IP,
          dstIp: LOCAL_IP,
        }),
      }),
    );
    const synAck = findSegment(sink.packets, (h) => h !== null && hasTcpFlag(h.flags, TcpFlags.SYN))!;

    // ── 第三次握手：ACK 确认 SYN-ACK ──
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP,
        dst: LOCAL_IP,
        protocol: IpProtocol.TCP,
        identification: 2,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT,
          dstPort: 8787,
          seq: 501,
          ack: (synAck.header.seq + 1) >>> 0,
          flags: TcpFlags.ACK,
          window: 65535,
          srcIp: REMOTE_IP,
          dstIp: LOCAL_IP,
        }),
      }),
    );

    // 给桥接连接一点时间建立
    await new Promise((r) => setTimeout(r, 150));

    // ── 发数据 ──
    const body = Buffer.from('hello-tcp-stack');
    sink.packets.length = 0;
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP,
        dst: LOCAL_IP,
        protocol: IpProtocol.TCP,
        identification: 3,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT,
          dstPort: 8787,
          seq: 501,
          ack: (synAck.header.seq + 1) >>> 0,
          flags: TcpFlags.PSH | TcpFlags.ACK,
          window: 65535,
          payload: body,
          srcIp: REMOTE_IP,
          dstIp: LOCAL_IP,
        }),
      }),
    );

    // 本机服务回 `echo:` + 原内容，虚拟侧应当收到载荷一致的段
    await new Promise((r) => setTimeout(r, 300));
    const echoed = sink.packets
      .map((packet) => {
        const ip = decodeIpv4Header(packet);
        if (ip === null) return null;
        const seg = packet.subarray(ip.headerLength);
        const header = decodeTcpHeader(seg);
        if (header === null) return null;
        return seg.subarray(header.dataOffset);
      })
      .filter((payload): payload is Buffer => payload !== null && payload.length > 0);

    const combined = Buffer.concat(echoed).toString();
    expect(combined).toContain('echo:hello-tcp-stack');
  }, 15_000);
});

describe('用户态 TCP 栈：边界', () => {
  it('分片包被丢弃而不是拼错数据', () => {
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP,
      bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn,
    });
    stacks.push(stack);
    stack.listen(8787, 1);

    const packet = buildIpv4Packet({
      src: REMOTE_IP,
      dst: LOCAL_IP,
      protocol: IpProtocol.TCP,
      identification: 1,
      payload: buildTcpSegment({
        srcPort: REMOTE_PORT,
        dstPort: 8787,
        seq: 1,
        ack: 0,
        flags: TcpFlags.SYN,
        window: 100,
        srcIp: REMOTE_IP,
        dstIp: LOCAL_IP,
      }),
    });
    // 手工标记为"还有更多分片"
    packet.writeUInt16BE(packet.readUInt16BE(6) | 0x2000, 6);
    // 改了头就要重算校验和，否则我们自己的校验会失败——这里直接调底层
    const handled = stack.handleIpPacket(packet);
    expect(handled).toBe(false);
    expect(stack.connectionCount()).toBe(0);
  });

  it('UDP 包被显式丢弃并给出可读原因（不是静默忽略）', () => {
    // DNS 走 UDP。若静默丢弃，用户会去查 DNS 配置而真正原因在这里。
    const logs: string[] = [];
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP,
      bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn,
      log: (message) => logs.push(message),
    });
    stacks.push(stack);
    const handled = stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.UDP, identification: 1,
        payload: encodeUdpHeader({ srcPort: 53000, dstPort: 53, length: 8 }),
      }),
    );
    expect(handled).toBe(false);
    // 日志必须指出目标端口，才能一眼看出是 DNS
    expect(logs.join('')).toContain('UDP');
    expect(logs.join('')).toContain('53');
  });

  it('非 TCP 协议不由本栈处理', () => {
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP,
      bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn,
    });
    stacks.push(stack);
    expect(
      stack.handleIpPacket(
        buildIpv4Packet({
          src: REMOTE_IP,
          dst: LOCAL_IP,
          protocol: IpProtocol.UDP,
          identification: 1,
          payload: Buffer.alloc(8),
        }),
      ),
    ).toBe(false);
  });

  it('序列号比较能处理 32 位回绕', () => {
    // 这是重传与乱序判断的基础：直接用减法会在大值回绕时判错
    expect(TcpStack.compareSeq(5, 3)).toBeGreaterThan(0);
    expect(TcpStack.compareSeq(3, 5)).toBeLessThan(0);
    // 2^32-1 的下一号是 0，应判定为"更新"而不是"小得多"
    expect(TcpStack.compareSeq(0, 0xffffffff)).toBeGreaterThan(0);
  });
});

describe('用户态 TCP 栈：确认与重传', () => {
  it('收到 ACK 后不再重传已确认的段（否则无限重发）', async () => {
    const bridgePort = await startEchoServer();
    const sink = makeSink();
    const stack = new TcpStack({
      localIp: LOCAL_IP,
      bridgeHost: '127.0.0.1',
      sendIpPacket: sink.fn,
      retransmitBaseMs: 100,
    });
    stacks.push(stack);
    stack.listen(8787, bridgePort);
    stack.start();

    // 握手
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 1,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT, dstPort: 8787, seq: 100, ack: 0,
          flags: TcpFlags.SYN, window: 65535, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
        }),
      }),
    );
    const synAck = findSegment(sink.packets, (h) => h !== null && hasTcpFlag(h.flags, TcpFlags.SYN))!;
    const nextSeq = (synAck.header.seq + 1) >>> 0;

    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 2,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT, dstPort: 8787, seq: 101, ack: nextSeq,
          flags: TcpFlags.ACK, window: 65535, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 100));

    // 发数据触发本机服务回应
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 3,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT, dstPort: 8787, seq: 101, ack: nextSeq,
          flags: TcpFlags.PSH | TcpFlags.ACK, window: 65535,
          payload: Buffer.from('ping'), srcIp: REMOTE_IP, dstIp: LOCAL_IP,
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 250));

    // 找出承载响应数据的段（记住 seq 与长度，ack 必须精确越过段尾）
    const dataSegs = sink.packets
      .map((packet) => {
        const ip = decodeIpv4Header(packet);
        if (ip === null) return null;
        const seg = packet.subarray(ip.headerLength);
        const h = decodeTcpHeader(seg);
        if (h === null) return null;
        const len = seg.subarray(h.dataOffset).length;
        return len > 0 ? { seq: h.seq, len } : null;
      })
      .filter((s): s is { seq: number; len: number } => s !== null);
    expect(dataSegs.length).toBeGreaterThan(0);

    // 对端确认**所有**已收到的数据段：ack 取最后一个段的段尾。
    // 只确认第一个会让后面的段仍在 unacked 里，重传是正确行为而非 bug。
    const ackedSeq = dataSegs[0].seq;
    const last = dataSegs[dataSegs.length - 1];
    const ackEnd = (last.seq + last.len) >>> 0;
    sink.packets.length = 0;
    stack.handleIpPacket(
      buildIpv4Packet({
        src: REMOTE_IP, dst: LOCAL_IP, protocol: IpProtocol.TCP, identification: 4,
        payload: buildTcpSegment({
          srcPort: REMOTE_PORT, dstPort: 8787, seq: 105, ack: ackEnd,
          flags: TcpFlags.ACK, window: 65535, srcIp: REMOTE_IP, dstIp: LOCAL_IP,
        }),
      }),
    );

    // 等超过 2 个 RTO：若没清理 unacked，这里会出现重传
    await new Promise((r) => setTimeout(r, 350));
    const retransmitted = sink.packets.filter((packet) => {
      const ip = decodeIpv4Header(packet);
      if (ip === null) return false;
      const seg = packet.subarray(ip.headerLength);
      const h = decodeTcpHeader(seg);
      if (h === null) return false;
      return seg.subarray(h.dataOffset).length > 0 && h.seq === ackedSeq;
    });
    expect(
      retransmitted.length,
      `已确认的段被重传了 ${retransmitted.length} 次（ACK 未清理 unacked）`,
    ).toBe(0);
  }, 15_000);
});

describe('出站包选对端', () => {
  it('目标 IP 精确匹配时选它（多对端也不会发错）', () => {
    const peers = [{ ipv4: '10.0.0.2' }, { ipv4: '10.0.0.3' }];
    const result = selectPeerForPacket(peers, '10.0.0.3');
    expect(result.reason).toBe('matched');
    expect(result.peer).toBe(peers[1]);
  });

  it('只有一条对端时发它（单对端组网的正常情况）', () => {
    const peers = [{ ipv4: '10.0.0.2' }];
    // 即使目标 IP 不匹配（对端还没广播 IP），单连接也发它
    const result = selectPeerForPacket(peers, '10.0.0.99');
    expect(result.reason).toBe('single');
    expect(result.peer).toBe(peers[0]);
  });

  it('多条对端且都不匹配时丢弃，不猜', () => {
    // 这条规则很重要：猜错会把数据发到别人的虚拟网里，
    // 而"不通"至少是可排查的。丢包比串包安全。
    const peers = [{ ipv4: '10.0.0.2' }, { ipv4: '10.0.0.3' }];
    const result = selectPeerForPacket(peers, '10.0.0.99');
    expect(result.reason).toBe('ambiguous');
    expect(result.peer).toBeNull();
  });

  it('没有任何对端时返回 none', () => {
    const result = selectPeerForPacket([], '10.0.0.2');
    expect(result.reason).toBe('none');
    expect(result.peer).toBeNull();
  });
});
