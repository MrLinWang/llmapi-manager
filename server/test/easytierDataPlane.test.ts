import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NetworkingRuntime } from '../src/networking/runtime';
import { defaultNetworkingConfig } from '../src/domain/networking';
import type { Logger } from '../src/logger';

/**
 * **数据面端到端验收**：官方节点通过虚拟 IP 访问自研引擎桥接的本机服务。
 *
 * 这是"组网到底有没有用"的最终判据。控制面通过（握手 + OSPF 路由）只证明
 * 两个节点互相看见了；真实用途是 follower 访问 master 的管理界面，
 * 那条路径走 `PacketType.Data`，必须由用户态 TCP 栈承载。
 *
 * ```
 * 官方节点                    自研引擎                本机真实服务
 *  10.126.220.2:xxxxx
 *      │ SYN ───────────────▶ 虚拟 10.126.220.1:8787
 *      │                        │── 桥接 ──────────▶ 127.0.0.1:18999
 *      │◀──────────── HTTP 响应 │◀─────────────────
 * ```
 *
 * 判据：官方节点在虚拟 IP 上发起的 TCP 连接**收到了真实服务的响应内容**。
 * 只断言"连接建立"是不够的——SYN-ACK 由我们伪造都能通过，必须看到回程数据。
 */

function localIPv4(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function nativeModulePath(): string | null {
  const file = path.join(
    __dirname,
    '../../native/easytier-node/easytier-node.linux-x64-gnu.node',
  );
  return fs.existsSync(file) ? file : null;
}

/** 所有子进程输出与日志行，断言靠它判断事件是否发生 */
const output: string[] = [];

function silentLogger(): Logger {
  const noop = (): void => {};
  const verbose = process.env.EASYTIER_DP_DEBUG === '1';
  const emit = (tag: string) => (message: string) => {
    // 日志必须同时进 output 数组：断言靠它判断"桥接是否建立""响应是否发出"。
    // 只 write 到 stdout 的话测试拿不到（踩过：断言永远 false）。
    output.push(`[dp-${tag}] ${message}\n`);
    if (verbose) process.stdout.write(`[dp-${tag}] ${message}\n`);
  };
  const logger = {
    info: (msg: unknown) => emit('info')(String(msg)),
    warn: (msg: unknown) => emit('warn')(String(msg)),
    error: (msg: unknown) => emit('error')(String(msg)),
    debug: noop,
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

const HOST = localIPv4();
const MODULE = nativeModulePath();
const CAN_RUN = HOST !== null && MODULE !== null;

const NETWORK_NAME = `dp-${Date.now().toString(36)}`;
const NETWORK_SECRET = `secret-${Math.random().toString(36).slice(2)}`;
const LISTEN_PORT = 14300 + Math.floor(Math.random() * 300);
const NATIVE_PORT = LISTEN_PORT + 1;
/** 官方节点上的本地入口端口，转发到虚拟网内的自研引擎 */
const LOCAL_PROBE_PORT = 18400 + Math.floor(Math.random() * 100);
const BRIDGE_PORT = 18999 + Math.floor(Math.random() * 50);
const TS_IPV4 = '10.126.220.1';
const NATIVE_IPV4 = '10.126.220.2/24';

/** 本机真实服务：回一段可辨识的内容。 */
const RESPONSE_BODY = 'HELLO-FROM-BRIDGED-SERVICE';

let runtime: NetworkingRuntime;
let child: ChildProcess | null = null;
let bridgeServer: net.Server | null = null;

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 150);
    };
    tick();
  });
}

function lastStatus(): { peerCount: number; hostnames: string[] } | null {
  const lines = output.filter((line) => line.includes('STATUS '));
  if (lines.length === 0) return null;
  const raw = lines[lines.length - 1];
  try {
    return JSON.parse(raw.slice(raw.indexOf('STATUS ') + 'STATUS '.length)) as {
      peerCount: number;
      hostnames: string[];
    };
  } catch {
    return null;
  }
}

describe.skipIf(!CAN_RUN)('数据面：官方节点通过虚拟 IP 访问自研引擎桥接的服务', () => {
  beforeAll(async () => {
    // 本机真实服务（模拟 master 的管理界面）
    bridgeServer = net.createServer((socket) => {
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${RESPONSE_BODY.length}\r\n\r\n${RESPONSE_BODY}`);
    });
    await new Promise<void>((resolve) => bridgeServer!.listen(BRIDGE_PORT, '127.0.0.1', resolve));

    runtime = new NetworkingRuntime(silentLogger());
    await runtime.start({
      ...defaultNetworkingConfig(),
      engine: 'builtin',
      enabled: true,
      networkName: NETWORK_NAME,
      networkSecret: NETWORK_SECRET,
      hostname: 'ts-dp',
      ipv4: TS_IPV4,
      listenPort: LISTEN_PORT,
      // 虚拟 IP 上的 8787 桥接到本机测试服务
      portForwards: [{ virtualPort: 8787, localPort: BRIDGE_PORT }],
    });

    const script = `
      const net = require('node:net');
      const m = require(${JSON.stringify(MODULE)});
      (async () => {
        await m.startNode({
          networkName: ${JSON.stringify(NETWORK_NAME)},
          networkSecret: ${JSON.stringify(NETWORK_SECRET)},
          peers: ['tcp://${HOST}:${LISTEN_PORT}'],
          hostname: 'official-dp',
          noTun: true,
          listenPort: ${NATIVE_PORT},
          secureMode: true,
          secureModePrivateKey: 'KetlLhHz8XnpxeNcRgMkGCq3oRV6XakpaiYzzDMKzpE=',
          ipv4: ${JSON.stringify(NATIVE_IPV4)},
          // 关键：官方节点在 noTun 模式下用 smoltcp，虚拟 IP **不挂在操作系统
          // 网络栈**上，所以从 Node 直接 net.connect(虚拟IP) 不会经过 EasyTier。
          // 必须用端口转发：在官方节点本机监听一个端口，转发到虚拟网内的目标。
          // 这才是"用虚拟网络访问对端服务"的真实用法。
          portForwards: ['127.0.0.1:${LOCAL_PROBE_PORT}->${TS_IPV4}:8787'],
        });
        process.stdout.write('READY\\n');
        let tick = 0;
        let decided = false;
        setInterval(async () => {
          tick += 1;
          if (tick > 900) process.exit(0);
          try {
            const s = await m.nodeStatus();
            const p = await m.listPeers();
            process.stdout.write('STATUS ' + JSON.stringify({
              peerCount: s.peerCount ?? 0,
              virtualIpv4: s.virtualIpv4 ?? null,
              hostnames: (p || []).map((x) => x.hostname).filter(Boolean),
            }) + '\\n');
          } catch {}
          if (!decided && (await m.nodeStatus()).peerCount > 0) {
            decided = true;
            // 等 OSPF 同步让对端进路由表
            setTimeout(() => {
              // 连官方节点的**本地入口**，由它转发进虚拟网络
              const sock = net.connect({ host: '127.0.0.1', port: ${LOCAL_PROBE_PORT} });
              sock.setTimeout(15000);
              let buf = '';
              sock.on('connect', () => process.stdout.write('DATA CONNECT\\n'));
              sock.on('data', (chunk) => { buf += chunk.toString(); });
              sock.on('timeout', () => {
                process.stdout.write('DATA TIMEOUT\\n');
                sock.destroy();
              });
              sock.on('error', (e) => process.stdout.write('DATA ERROR ' + e.code + '\\n'));
              sock.on('close', () => {
                process.stdout.write('DATA BODY ' + JSON.stringify(buf) + '\\n');
              });
            }, 6000);
          }
        }, 500);
      })().catch((e) => {
        process.stderr.write('STARTFAIL ' + (e && e.message ? e.message : String(e)) + '\\n');
        process.exit(1);
      });
    `;
    child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => {
      output.push(chunk.toString());
      if (process.env.EASYTIER_DP_DEBUG === '1') process.stdout.write(`[off-out] ${chunk}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output.push(chunk.toString());
      if (process.env.EASYTIER_DP_DEBUG === '1') process.stdout.write(`[off-err] ${chunk}`);
    });
  }, 120_000);

  afterAll(async () => {
    child?.kill('SIGKILL');
    await runtime?.stop();
    await new Promise<void>((resolve) => {
      if (bridgeServer === null) return resolve();
      bridgeServer.close(() => resolve());
    });
  });

  it('官方节点能看到本机（控制面先通）', async () => {
    const ok = await waitFor(
      () => lastStatus() !== null && lastStatus()!.peerCount >= 1,
      60_000,
    );
    expect(ok, `控制面未通：${JSON.stringify(lastStatus())}`).toBe(true);
  }, 90_000);

  it('官方节点在虚拟 IP 上连到桥接服务（TCP 握手经虚拟网络真实完成）', async () => {
    // 判据：官方节点的连接建立成功。这一条已经证明整条链路的**去程**通了：
    //   SYN 从官方节点出发 → 加密成 Data 包 → 我们解密 → 用户态 TCP 栈
    //   → 回 SYN-ACK → 官方节点收到并完成握手 → 本机桥接 socket 建立
    // 少任何一环，官方侧都只会看到超时。
    const connected = await waitFor(() => output.some((l) => l.includes('DATA CONNECT')), 90_000);
    expect(
      connected,
      `虚拟 IP 上的 TCP 握手未完成。日志尾部：${output.slice(-6).join('')}`,
    ).toBe(true);

    const errors = output.filter((l) => l.includes('DATA ERROR') || l.includes('DATA TIMEOUT'));
    expect(errors.join('')).toBe('');

    // 桥接也必须真的建立——握手成功但桥接失败时，后续数据会无处可去
    const bridgeEstablished = await waitFor(
      () => output.some((l) => l.includes('桥接已建立')),
      30_000,
    );
    expect(bridgeEstablished, '虚拟连接没有桥接到本机服务').toBe(true);
  }, 120_000);

  it('回程数据被封装发往虚拟对端', async () => {
    // 断言我们这侧的出口行为：响应数据被封装并发往虚拟对端。
    // 端到端"官方真的收到"由下面那条测试验证。
    const sentBack = await waitFor(
      () => output.some((l) => l.includes('发送数据包')) &&
            output.some((l) => /发送数据包 \d{3,}B/.test(l)),
      60_000,
    );
    expect(sentBack, '响应数据没有被封装发往虚拟对端').toBe(true);
  }, 90_000);

  it('官方节点收到完整的响应体内容（端到端打通）', async () => {
    const bodyLine = output.find((l) => l.includes('DATA BODY'));
    expect(bodyLine, '没有收到任何响应体').toBeDefined();
    expect(bodyLine!).toContain(RESPONSE_BODY);
  }, 120_000);
});
