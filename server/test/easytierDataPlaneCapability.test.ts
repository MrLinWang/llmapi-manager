import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PacketType } from '../src/networking/easytier/protocol';

/**
 * **自研引擎的数据面能力**。
 *
 * 这个文件原先叫 `easytierDataPlaneGap.test.ts`，固定的是"没有数据面"这一
 * 事实（`acceptor.ts` 只放行 RpcReq，`PacketType.Data` 被丢弃，且自研侧没有
 * 用户态协议栈）。补齐数据面之后，它改为固定**新的事实**——并且刻意保留
 * "必须显式处理 Data"这条断言：将来若有人误删分支，测试会立刻失败。
 *
 * 能力现状：
 * - ✅ 控制面：握手（双向角色）、加密、RPC、OSPF 路由同步
 * - ✅ 数据面：`Data` 包承载完整 IP 包 → 用户态 TCP 栈 → 桥接到本机端口
 * - ❌ 未实现：UDP、ICMP、IP 分片重组、拥塞控制（见 README 的已知边界）
 */
describe('自研引擎的数据面能力', () => {
  const acceptorSource = fs.readFileSync(
    path.join(__dirname, '../src/networking/easytier/acceptor.ts'),
    'utf8',
  );

  it('acceptor 显式处理 PacketType.Data，而不是丢弃', () => {
    // 这是数据面存在的直接证据。删掉这个分支会让虚拟网络里的真实流量
    // 全部静默丢弃——症状是"能连上、但没有任何数据回来"。
    expect(acceptorSource).toContain('if (header.packetType === PacketType.Data)');
    expect(acceptorSource).toContain('handleDataPacket');
    // 且必须交给用户态 TCP 栈
    expect(acceptorSource).toContain('this.tcpStack?.handleIpPacket');
  });

  it('数据面数据包是加密的（与 RPC 同一套 dataPlane）', () => {
    // Data 包在 secure mode 下经会话层加密；按明文发会被对端当垃圾丢掉
    expect(acceptorSource).toMatch(/handleDataPacket[\s\S]{0,600}decryptPayload/);
    expect(acceptorSource).toMatch(/sendDataPacket[\s\S]{0,600}encryptPayload/);
  });

  it('协议层定义了 Data 类型，值为 1', () => {
    // Data=1 是 EasyTier 承载业务流量的类型（`peer_manager.rs:462`）
    expect(PacketType.Data).toBe(1);
  });

  it('用户态 TCP 栈存在，且以真实本机 socket 为桥接目标', () => {
    const tcpStack = fs.readFileSync(
      path.join(__dirname, '../src/networking/easytier/tcpStack.ts'),
      'utf8',
    );
    // 桥接是这件事的关键：虚拟连接必须落到真实 socket 上，
    // 否则"通了"只是状态机自洽，没有任何服务可达
    expect(tcpStack).toContain('net.connect');
    expect(tcpStack).toContain('bridgeHost');
    // TCP 状态机的核心状态必须都在
    for (const state of ['synReceived', 'established', 'finWait1', 'closeWait', 'lastAck']) {
      expect(tcpStack).toContain(state);
    }
  });

  it('IP 头编解码与校验和实现存在', () => {
    const ip = fs.readFileSync(
      path.join(__dirname, '../src/networking/easytier/ip.ts'),
      'utf8',
    );
    expect(ip).toContain('internetChecksum');
    // TCP 校验和必须含伪首部——漏了会被对端静默丢弃
    expect(ip).toContain('tcpChecksum');
    expect(ip).toContain('pseudo');
  });

  it('未实现的能力在 README 里明确列出，不假装完整', () => {
    const readme = fs.readFileSync(
      path.join(__dirname, '../src/networking/easytier/README.md'),
      'utf8',
    );
    // 这些是真实缺口，必须写在边界里
    expect(readme).toMatch(/UDP|udp/);
    expect(readme).toMatch(/分片|fragment/i);
    expect(readme).toMatch(/拥塞|congestion/i);
  });
});
