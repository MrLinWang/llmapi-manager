/**
 * 用户态 UDP 转发：让虚拟网络里的 UDP 流量（**尤其是 DNS**）真的能通。
 *
 * # 为什么必须做
 *
 * 之前只做 TCP，UDP 被显式丢弃。后果非常具体：**DNS 走 UDP**，所以对端
 * 在虚拟网内解析任何域名都失败。而"连得上但域名解析不了"的排查方向是
 * resolv.conf / DNS 服务器地址——真正的原因（我们把 UDP 丢了）反而看不到。
 *
 * # 与 TCP 的差别（决定了实现思路）
 *
 * UDP 无连接、无握手、无重传、无序。所以这里不需要状态机，只需要一个
 * **会话表**：记住"哪个虚拟四元组对应哪个本机 socket"，这样本机服务的
 * 回包才知道该发给谁。
 *
 * ```
 * 虚拟 10.x.x.2:53000 ──DNS query──▶ 虚拟 10.x.x.1:53
 *                                      │ 查会话表，没有就建一个
 *                                      ▼
 *                                  udp socket → 127.0.0.1:53
 * 虚拟 10.x.x.2:53000 ◀──DNS reply────┤
 * ```
 *
 * # 已知边界（如实记录）
 *
 * - 不做 UDP 分片（IP 层的分片由 `ipReassembly.ts` 处理，但超大会话仍可能失败）
 * - 不转发广播/组播（只在点对点虚拟网络里工作）
 * - 会话按空闲时间回收；DNS 这种一问一答的短会话能正常工作，
 *   长时间无响应的流式 UDP（如某些游戏/QUIC）可能因会话过期而中断
 */

import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  IpProtocol,
  buildIpv4Packet,
  buildUdpDatagram,
  decodeIpv4Header,
  decodeUdpHeader,
} from './ip';

/** 一个 UDP 会话（虚拟四元组 ↔ 本机 socket）。 */
interface UdpSession {
  remoteIp: string;
  remotePort: number;
  localIp: string;
  localPort: number;
  socket: dgram.Socket;
  lastActivityAt: number;
  /** 建立过程中的错误（诊断用） */
  error: string | null;
}

export interface UdpStackOptions {
  /** 本机在虚拟网络里的 IP */
  localIp: string;
  /**
   * 默认转发目标主机。
   *
   * **保留但不再是唯一来源**：`listen()` 可以逐端口指定目标。
   * 这个字段只在调用方没给目标时用作兜底。
   */
  forwardHost: string;
  /** 会话空闲多久后回收（毫秒） */
  idleTimeoutMs?: number;
  /** 发出 IP 包的出口 */
  sendIpPacket: (packet: Buffer) => void;
  log?: (message: string) => void;
}

/**
 * 用户态 UDP 转发器。
 *
 * 与 `TcpStack` 并列：两者都吃 IP 包，但 UDP 的语义简单得多——收到就转发，
 * 不维护序列号与窗口。
 */
export class UdpStack extends EventEmitter {
  private readonly sessions = new Map<string, UdpSession>();
  /** 虚拟端口 → 转发目标（主机 + 端口） */
  private readonly portMap = new Map<number, { host: string; port: number }>();
  private readonly options: Required<
    Pick<UdpStackOptions, 'localIp' | 'forwardHost' | 'idleTimeoutMs'>
  > &
    UdpStackOptions;
  private sweepTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: UdpStackOptions) {
    super();
    this.options = {
      localIp: options.localIp,
      forwardHost: options.forwardHost,
      idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
      sendIpPacket: options.sendIpPacket,
      ...(options.log === undefined ? {} : { log: options.log }),
    };
  }

  /**
   * 把虚拟 IP 上的 `virtualPort` 转发到 `targetHost:targetPort`。
   *
   * 目标不限于本机：DNS 的解析器常在别的地址上（如 systemd-resolved 的
   * `127.0.0.53:53`），写死 `127.0.0.1` 会让 DNS 开箱就不工作。
   */
  listen(virtualPort: number, targetHost: string, targetPort: number): void {
    this.portMap.set(virtualPort, { host: targetHost, port: targetPort });
  }

  /** 当前活跃会话数（诊断用）。 */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** 列出活跃会话（诊断用）。 */
  activeSessions(): Array<{ remote: string; local: string; idleMs: number }> {
    const now = Date.now();
    return [...this.sessions.values()].map((session) => ({
      remote: `${session.remoteIp}:${session.remotePort}`,
      local: `${session.localIp}:${session.localPort}`,
      idleMs: now - session.lastActivityAt,
    }));
  }

  start(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), 10_000);
    this.sweepTimer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const session of this.sessions.values()) {
      try {
        session.socket.close();
      } catch {
        // 已经关掉的 socket 再关会抛，忽略
      }
    }
    this.sessions.clear();
  }

  private sweepIdle(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivityAt <= this.options.idleTimeoutMs) continue;
      this.log(`UDP 会话空闲回收 ${session.remoteIp}:${session.remotePort}`);
      try {
        session.socket.close();
      } catch {
        // 忽略重复关闭
      }
      this.sessions.delete(key);
    }
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /**
   * 处理一个来自虚拟网络的 IP 包。
   *
   * 返回 true 表示消费了这个包（是 UDP）。
   */
  handleIpPacket(packet: Buffer): boolean {
    if (this.closed) return false;
    const ipHeader = decodeIpv4Header(packet);
    if (ipHeader === null) return false;
    if (ipHeader.protocol !== IpProtocol.UDP) return false;

    const datagram = packet.subarray(
      ipHeader.headerLength,
      Math.min(ipHeader.totalLength, packet.length),
    );
    const udpHeader = decodeUdpHeader(datagram);
    if (udpHeader === null) return false;

    // UDP 头的 length 字段是"头 + 载荷"总长；越界说明包被截断
    const declared = Math.min(udpHeader.length, datagram.length);
    const payload = datagram.subarray(8, declared);

    this.forwardToLocal(ipHeader.src, ipHeader.dst, udpHeader, payload);
    return true;
  }

  /** 把虚拟侧的数据报转给本机服务。 */
  private forwardToLocal(
    srcIp: string,
    dstIp: string,
    header: { srcPort: number; dstPort: number },
    payload: Buffer,
  ): void {
    const target = this.portMap.get(header.dstPort);
    if (target === undefined) {
      // 没有映射就没有服务可投递。UDP 没有 RST 概念，只能丢包——但**要记日志**，
      // 否则用户只看到"DNS 超时"，完全不知道是这个端口没配映射。
      this.log(
        `丢弃 UDP ${srcIp}:${header.srcPort} → ${dstIp}:${header.dstPort}（没有该端口的转发规则）`,
      );
      return;
    }

    const key = `${srcIp}:${header.srcPort}->${this.options.localIp}:${header.dstPort}`;
    let session = this.sessions.get(key);

    if (session === undefined) {
      const created = this.createSession(srcIp, dstIp, header, target);
      if (created === null) return;
      this.sessions.set(key, created);
      session = created;
    }

    session.lastActivityAt = Date.now();
    try {
      session.socket.send(payload, target.port, target.host, (err) => {
        if (err !== null) {
          this.log(`UDP 转发失败（${target.host}:${target.port}）—— ${err.message}`);
        }
      });
    } catch (cause) {
      this.log(`UDP 转发异常 —— ${(cause as Error).message}`);
    }
  }

  /** 建一个本机 UDP socket，并把它的回包封成虚拟 IP 包发回去。 */
  private createSession(
    remoteIp: string,
    localIp: string,
    header: { srcPort: number; dstPort: number },
    target: { host: string; port: number },
  ): UdpSession | null {
    const socket = dgram.createSocket('udp4');
    const session: UdpSession = {
      remoteIp,
      remotePort: header.srcPort,
      localIp,
      localPort: header.dstPort,
      socket,
      lastActivityAt: Date.now(),
      error: null,
    };

    socket.on('message', (message) => {
      // 本机服务回包 → 封成 UDP 数据报 + IP 包，发回虚拟对端
      session.lastActivityAt = Date.now();
      const datagram = buildUdpDatagram({
        srcPort: session.localPort,
        dstPort: session.remotePort,
        payload: message,
        srcIp: this.options.localIp,
        dstIp: session.remoteIp,
      });
      this.options.sendIpPacket(
        buildIpv4Packet({
          src: this.options.localIp,
          dst: session.remoteIp,
          protocol: IpProtocol.UDP,
          payload: datagram,
          identification: (Math.random() * 0xffff) & 0xffff,
        }),
      );
    });

    socket.on('error', (err) => {
      // UDP 的错误大多是 ICMP 端口不可达回传。**不要关会话**：
      // 同一个源端口可能马上再发一次（DNS 重试），关掉会让重试也失败。
      session.error = err.message;
      this.log(`UDP socket 错误（${target.host}:${target.port}）—— ${err.message}`);
    });

    // 绑定到随机本地端口；失败时说明本机不可用（如地址族不支持）
    try {
      socket.bind(0);
    } catch (cause) {
      session.error = (cause as Error).message;
      this.log(`UDP socket 绑定失败 —— ${session.error}`);
      return null;
    }

    this.log(
      `新 UDP 会话 ${remoteIp}:${header.srcPort} → 虚拟 ${localIp}:${header.dstPort} → ${target.host}:${target.port}`,
    );
    this.emit('session', {
      remote: `${remoteIp}:${header.srcPort}`,
      localPort: header.dstPort,
    });
    return session;
  }
}

/**
 * 探测本机的 DNS 解析器地址（`/etc/resolv.conf` 的第一个 `nameserver`）。
 *
 * 为什么需要它：DNS 的解析器**通常不是 `127.0.0.1`**。实测这台机器上
 * systemd-resolved 用的是 `127.0.0.53:53`——按"127.0.0.1:53"配默认映射，
 * 虚拟网内的 DNS 开箱就不工作，而症状是"能连对端但域名解析不了"，
 * 排查方向会偏到 resolv.conf 上。
 *
 * 读不到文件（非 Linux、权限不足）时回退到 `127.0.0.1`：让用户自己配，
 * 但至少不会崩。调用方应当把探测结果记日志，方便用户核对。
 */
export function resolveSystemDnsServer(): string {
  try {
    const content = readFileSync('/etc/resolv.conf', 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('nameserver')) continue;
      const parts = trimmed.split(/\s+/);
      const address = parts[1];
      if (address !== undefined && address !== '') {
        // 去掉 IPv6 的 scope 后缀（fe80::1%eth0 → fe80::1）
        return address.split('%')[0];
      }
    }
  } catch {
    // 读不到就用回环地址兜底，由用户显式配置
  }
  return '127.0.0.1';
}
