import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NetworkingRuntime } from '../src/networking/runtime';
import { defaultNetworkingConfig } from '../src/domain/networking';
import type { Logger } from '../src/logger';

/**
 * **三节点拓扑传播**：两个官方节点通过自研引擎互相发现。
 *
 * 这是多跳中继的前提。之前不行——我们的 OSPF 广播只报自己，所以：
 *
 * ```
 * A ←→ 我们 ←→ B      A 的 OSPF 图里只有 {A, 我们}，它永远不知道 B 存在
 * ```
 *
 * 单跳场景（A 只访问我们的服务）没问题，但 A 想访问 B 时，A 根本不会
 * 把包交给我们转发——它没有到 B 的路由。
 *
 * 修复后我们把**全部已知节点与连接关系**都广播出去，于是：
 *
 * ```
 * A 的图：A ─ 我们 ─ B     → A 到 B 的下一跳 = 我们（交给我们转发）
 * ```
 *
 * 判据：A 的 peer 列表里出现 B 的主机名（反之亦然）。主机名只会在对端
 * 真的把 B 的 RoutePeerInfo 学到路由表后才会出现——这是"拓扑传播成功"
 * 的直接证据，而不是"我们发了包"的间接推测。
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

const protocolLogs: string[] = [];

function silentLogger(): Logger {
  const noop = (): void => {};
  const verbose = process.env.EASYTIER_HOP_DEBUG === '1';
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: (message: unknown) => {
      protocolLogs.push(String(message));
      if (verbose) process.stdout.write(`[hop] ${String(message)}\n`);
    },
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

const HOST = localIPv4();
const MODULE = nativeModulePath();
const CAN_RUN = HOST !== null && MODULE !== null;

const NETWORK_NAME = `hop-${Date.now().toString(36)}`;
const NETWORK_SECRET = `secret-${Math.random().toString(36).slice(2)}`;
const LISTEN_PORT = 14700 + Math.floor(Math.random() * 200);
const TS_IPV4 = '10.126.228.1';

let runtime: NetworkingRuntime;
const children: ChildProcess[] = [];
const outputs: { A: string[]; B: string[] } = { A: [], B: [] };

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}

/** 从某个官方节点的输出里取最后一次 STATUS 的 hostnames。 */
function hostnamesFor(which: 'A' | 'B'): string[] {
  const lines = outputs[which].filter((line) => line.includes('STATUS '));
  if (lines.length === 0) return [];
  const raw = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(
      raw.slice(raw.indexOf('STATUS ') + 'STATUS '.length),
    ) as { hostnames?: string[]; routes?: Array<{ host: string }> };
    // 合并：直连的（hostnames）与非直连的（routes）都算"学到了"
    return [
      ...(parsed.hostnames ?? []),
      ...(parsed.routes ?? []).map((r) => r.host),
    ].filter((name) => name !== '' && name !== undefined);
  } catch {
    return [];
  }
}

/** 取某个官方节点的路由表。 */
function routesFor(which: 'A' | 'B'): Array<{ host: string; next: number; cost: number }> {
  const lines = outputs[which].filter((line) => line.includes('STATUS '));
  if (lines.length === 0) return [];
  const raw = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(
      raw.slice(raw.indexOf('STATUS ') + 'STATUS '.length),
    ) as { routes?: Array<{ host: string; next: number; cost: number }> };
    return parsed.routes ?? [];
  } catch {
    return [];
  }
}

/** 起一个官方节点（作为我们的直连对端）。 */
function startOfficial(options: {
  which: 'A' | 'B';
  hostname: string;
  ipv4: string;
  listenPort: number;
}): ChildProcess {
  const script = `
    const m = require(${JSON.stringify(MODULE)});
    (async () => {
      await m.startNode({
        networkName: ${JSON.stringify(NETWORK_NAME)},
        networkSecret: ${JSON.stringify(NETWORK_SECRET)},
        peers: ['tcp://${HOST}:${LISTEN_PORT}'],
        hostname: ${JSON.stringify(options.hostname)},
        noTun: true,
        listenPort: ${options.listenPort},
        secureMode: true,
        secureModePrivateKey: 'KetlLhHz8XnpxeNcRgMkGCq3oRV6XakpaiYzzDMKzpE=',
        ipv4: ${JSON.stringify(options.ipv4)},
      });
      process.stdout.write('READY\\n');
      let tick = 0;
      setInterval(async () => {
        tick += 1;
        if (tick > 900) process.exit(0);
        try {
          const s = await m.nodeStatus();
          const p = await m.listPeers();
          // **路由表**才是拓扑是否被接受的判据：listPeers 只列直连节点，
          // 而多跳目标永远不会是直连的
          const routes = typeof m.listRoutes === 'function' ? await m.listRoutes() : [];
          process.stdout.write('STATUS ' + JSON.stringify({
            peerCount: s.peerCount ?? 0,
            hostnames: (p || []).map((x) => x.hostname).filter(Boolean),
            routes: (routes || []).map((r) => ({
              host: r.hostname,
              next: r.nextHopPeerId,
              cost: r.cost,
            })),
          }) + '\\n');
        } catch {}
      }, 500);
    })().catch((e) => {
      process.stderr.write('STARTFAIL ' + (e && e.message ? e.message : String(e)) + '\\n');
      process.exit(1);
    });
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const bucket = outputs[options.which];
  child.stdout?.on('data', (chunk: Buffer) => bucket.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => bucket.push(chunk.toString()));
  return child;
}

describe.skipIf(!CAN_RUN)('三节点拓扑传播（多跳中继的前提）', () => {
  beforeAll(async () => {
    runtime = new NetworkingRuntime(silentLogger());
    await runtime.start({
      ...defaultNetworkingConfig(),
      engine: 'builtin',
      enabled: true,
      networkName: NETWORK_NAME,
      networkSecret: NETWORK_SECRET,
      hostname: 'ts-relay',
      ipv4: TS_IPV4,
      listenPort: LISTEN_PORT,
      portForwards: [],
      udpForwards: [],
    });

    children.push(
      startOfficial({
        which: 'A',
        hostname: 'official-A',
        ipv4: '10.126.228.2/24',
        listenPort: LISTEN_PORT + 1,
      }),
    );
    children.push(
      startOfficial({
        which: 'B',
        hostname: 'official-B',
        ipv4: '10.126.228.3/24',
        listenPort: LISTEN_PORT + 2,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    await runtime?.stop();
  });

  it('两个官方节点都连上了我们', async () => {
    const ok = await waitFor(
      () => hostnamesFor('A').includes('ts-relay') && hostnamesFor('B').includes('ts-relay'),
      60_000,
    );
    expect(
      ok,
      `控制面未通。A=${JSON.stringify(hostnamesFor('A'))} B=${JSON.stringify(hostnamesFor('B'))}`,
    ).toBe(true);
  }, 90_000);

  it('A 通过我们学到 B（拓扑传播成功）', async () => {
    // 关键判据：A 的 peer 列表里出现 official-B。
    // 主机名只在对端把 B 的 RoutePeerInfo 真的装进路由表后才会显示，
    // 所以这条断言直接证明"我们广播的拓扑被接受了"。
    const learned = await waitFor(
      () => hostnamesFor('A').includes('official-B'),
      90_000,
    );
    expect(
      learned,
      `A 未学到 B：${JSON.stringify(hostnamesFor('A'))}。` +
        `说明我们广播的 peer_infos / conn_info 没被接受。`,
    ).toBe(true);
  }, 120_000);

  it('A 路由表里 B 的 cost 是 2（说明确实经过我们中转，不是直连）', async () => {
    // 这条断言比"学到 B"更强：它排除了"A 与 B 偷偷直连"的可能。
    // cost=1 是直连，cost=2 才是经我们一跳到 B。
    const routes = routesFor('A');
    const viaRelay = routes.find((route) => route.host === 'official-B');
    expect(viaRelay, `A 的路由表里没有 official-B：${JSON.stringify(routes)}`).toBeDefined();
    expect(viaRelay!.cost).toBe(2);
    // 下一跳必须是我们（ts-relay 的 peer id），不是 B 自己
    const relayRoute = routes.find((route) => route.host === 'ts-relay');
    expect(relayRoute).toBeDefined();
    expect(viaRelay!.next).toBe(relayRoute!.next);
  }, 30_000);

  it('B 也通过我们学到 A（双向传播）', async () => {
    const learned = await waitFor(
      () => hostnamesFor('B').includes('official-A'),
      90_000,
    );
    expect(
      learned,
      `B 未学到 A：${JSON.stringify(hostnamesFor('B'))}`,
    ).toBe(true);
  }, 120_000);

  it('我们自己的拓扑里也有两个对端（本地视图一致）', async () => {
    const peers = await runtime.peers();
    const names = peers.map((peer) => peer.hostname);
    expect(names).toContain('official-A');
    expect(names).toContain('official-B');
  }, 30_000);
});
