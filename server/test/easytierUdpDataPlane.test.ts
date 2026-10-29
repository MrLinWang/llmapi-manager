import { spawn, type ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NetworkingRuntime } from '../src/networking/runtime';
import { defaultNetworkingConfig } from '../src/domain/networking';
import { resolveSystemDnsServer } from '../src/networking/easytier/udpStack';
import type { Logger } from '../src/logger';

/**
 * **UDP 数据面端到端验收：DNS 在虚拟网络里真的能用**。
 *
 * 这条测试回答的是一个非常具体的问题：对端在虚拟网内解析域名，能成功吗？
 * 之前不能——`acceptor` 对 UDP 直接丢弃，而 DNS 走 UDP。
 *
 * ```
 * 本测试进程                  官方节点                 自研引擎            真实 DNS
 *   │ DNS query ──────────▶ 127.0.0.1:15353
 *   │                       │ udp 端口转发 ──────▶ 虚拟 10.x.x.1:53
 *   │                       │                        │ 转发 ────────▶ 127.0.0.53:53
 *   │                       │                        │◀────────────── reply
 *   │◀────────────────────────────────────────────── reply
 * ```
 *
 * 判据必须是「拿到 DNS 应答且事务 ID 匹配」：只断言"发出了包"没有意义，
 * 只断言"收到字节"也不够——必须确认那是我们这次查询的应答。
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

function silentLogger(): Logger {
  const noop = (): void => {};
  const verbose = process.env.EASYTIER_UDP_DEBUG === '1';
  const emit = (tag: string) => (message: unknown) => {
    const line = `[udp-${tag}] ${String(message)}\n`;
    logs.push(line);
    if (verbose) process.stdout.write(line);
  };
  const logger = {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    debug: noop,
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

const logs: string[] = [];

const HOST = localIPv4();
const MODULE = nativeModulePath();
const CAN_RUN = HOST !== null && MODULE !== null;

const NETWORK_NAME = `udp-${Date.now().toString(36)}`;
const NETWORK_SECRET = `secret-${Math.random().toString(36).slice(2)}`;
const LISTEN_PORT = 14500 + Math.floor(Math.random() * 300);
const NATIVE_PORT = LISTEN_PORT + 1;
/** 官方节点上的本地 UDP 入口 */
const LOCAL_DNS_PORT = 15300 + Math.floor(Math.random() * 100);
const TS_IPV4 = '10.126.250.1';
const NATIVE_IPV4 = '10.126.250.2/24';
const DNS_ID = 0x5a5a;

let runtime: NetworkingRuntime;
let child: ChildProcess | null = null;
const output: string[] = [];

/** 构造最小 DNS 查询（example.com A）。 */
function buildDnsQuery(id: number): Buffer {
  const labels = ['example', 'com'];
  const size = 12 + labels.reduce((n, label) => n + 1 + label.length, 0) + 5;
  const query = Buffer.alloc(size);
  query.writeUInt16BE(id, 0);
  query.writeUInt16BE(0x0100, 2);
  query.writeUInt16BE(1, 4);
  let offset = 12;
  for (const label of labels) {
    query[offset] = label.length;
    offset += 1;
    query.write(label, offset);
    offset += label.length;
  }
  query[offset] = 0;
  offset += 1;
  query.writeUInt16BE(1, offset);
  query.writeUInt16BE(1, offset + 2);
  return query;
}

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

describe.skipIf(!CAN_RUN)('UDP 数据面：虚拟网络里的 DNS 解析', () => {
  beforeAll(async () => {
    const systemDns = resolveSystemDnsServer();
    // 本机解析器必须可达，否则测试失败的原因会和 UDP 无关，容易误判
    logs.push(`[udp] 系统解析器 = ${systemDns}\n`);

    runtime = new NetworkingRuntime(silentLogger());
    await runtime.start({
      ...defaultNetworkingConfig(),
      engine: 'builtin',
      enabled: true,
      networkName: NETWORK_NAME,
      networkSecret: NETWORK_SECRET,
      hostname: 'ts-udp',
      ipv4: TS_IPV4,
      listenPort: LISTEN_PORT,
      // 只要 UDP：这条测试专门验证 DNS
      portForwards: [],
      udpForwards: [{ virtualPort: 53, targetHost: '', targetPort: 53 }],
    });

    const script = `
      const m = require(${JSON.stringify(MODULE)});
      (async () => {
        await m.startNode({
          networkName: ${JSON.stringify(NETWORK_NAME)},
          networkSecret: ${JSON.stringify(NETWORK_SECRET)},
          peers: ['tcp://${HOST}:${LISTEN_PORT}'],
          hostname: 'official-udp',
          noTun: true,
          listenPort: ${NATIVE_PORT},
          secureMode: true,
          secureModePrivateKey: 'KetlLhHz8XnpxeNcRgMkGCq3oRV6XakpaiYzzDMKzpE=',
          ipv4: ${JSON.stringify(NATIVE_IPV4)},
          // udp: 前缀是本轮给原生模块新加的能力——官方端口转发支持
          // proto=udp，但之前我们只暴露了 tcp
          portForwards: ['udp:127.0.0.1:${LOCAL_DNS_PORT}->${TS_IPV4}:53'],
        });
        process.stdout.write('READY\\n');
        let tick = 0;
        setInterval(async () => {
          tick += 1;
          if (tick > 900) process.exit(0);
          try {
            const s = await m.nodeStatus();
            process.stdout.write('STATUS ' + JSON.stringify({
              peerCount: s.peerCount ?? 0,
            }) + '\\n');
          } catch {}
        }, 500);
      })().catch((e) => {
        process.stderr.write('STARTFAIL ' + (e && e.message ? e.message : String(e)) + '\\n');
        process.exit(1);
      });
    `;
    child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => {
      output.push(chunk.toString());
      if (process.env.EASYTIER_UDP_DEBUG === '1') process.stdout.write(`[off] ${chunk}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output.push(chunk.toString());
      if (process.env.EASYTIER_UDP_DEBUG === '1') process.stdout.write(`[off-err] ${chunk}`);
    });
  }, 120_000);

  afterAll(async () => {
    child?.kill('SIGKILL');
    await runtime?.stop();
  });

  it('官方节点连上（UDP 转发的前提是控制面已通）', async () => {
    const ok = await waitFor(
      () => output.some((line) => line.includes('STATUS ') && line.includes('"peerCount":1')),
      60_000,
    );
    expect(ok, `控制面未通。日志尾部：${output.slice(-4).join('')}`).toBe(true);
  }, 90_000);

  it('经虚拟网络完成真实 DNS 解析（拿到匹配事务 ID 的应答）', async () => {
    // 再等一会让 OSPF 同步把对端放进路由表，否则 UDP 包会被丢
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const socket = dgram.createSocket('udp4');
    const reply = await new Promise<Buffer | null>((resolve) => {
      let settled = false;
      socket.on('message', (message) => {
        if (settled) return;
        settled = true;
        socket.close();
        resolve(message);
      });
      socket.on('error', () => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // 已关闭
        }
        resolve(null);
      });
      socket.send(buildDnsQuery(DNS_ID), LOCAL_DNS_PORT, '127.0.0.1', (err) => {
        if (err !== null) {
          settled = true;
          resolve(null);
        }
      });
      // DNS 走整条虚拟链路，给足时间；超时说明 UDP 转发没打通
      setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // 已关闭
        }
        resolve(null);
      }, 15_000);
    });

    expect(
      reply,
      `没有收到 DNS 应答（UDP 转发未打通）。数据面日志：\n${logs.filter((l) => l.includes('udp')).join('')}`,
    ).not.toBeNull();

    // 事务 ID 必须匹配：确认这是**我们这次查询**的应答，而不是别处漏进来的包
    expect(reply!.readUInt16BE(0)).toBe(DNS_ID);
    // ANCOUNT > 0 说明真的解析出了记录，而不只是一个空应答
    const answerCount = reply!.readUInt16BE(6);
    expect(answerCount).toBeGreaterThan(0);
  }, 120_000);
});
