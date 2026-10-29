import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NetworkingRuntime } from '../src/networking/runtime';
import { defaultNetworkingConfig } from '../src/domain/networking';
import type { Logger } from '../src/logger';

/**
 * **自研引擎作为默认主引擎**的端到端验收。
 *
 * 与 `easytierAcceptor.test.ts` 的区别很关键：那个测试直接构造
 * `EasyTierAcceptor`，验证的是**协议实现**；本测试走 `NetworkingRuntime`，
 * 验证的是**产品路径**——用户把 `engine` 设成默认的 `builtin`、点"启动组网"，
 * 官方节点能不能真的连上并完成路由同步。
 *
 * 为什么两者都要有：协议实现能通 ≠ 接线正确。端口从配置读到了吗？
 * 身份稳定吗？`status()` 的 running/peerCount 反映的是真实连接吗？
 * 这些只有走 runtime 才能验证。
 *
 * ## 判据
 *
 * 1. `runtime.start()` 之后 `status().running === true` 且 `engine === 'builtin'`
 * 2. 官方节点连上、`peerCount` 变正（自研引擎确实在服务）
 * 3. `peers()` 里出现官方节点的主机名（OSPF 广播被对方接受并回灌）
 * 4. 没有静默降级（`degradedFrom === null`）
 *
 * ## 跳过条件
 *
 * 原生模块未编译、或拿不到非回环 IPv4（EasyTier 会拦截 127.0.0.1）。
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

/** 静默 logger：这个测试只关心结果，不关心日志文本。 */
function silentLogger(): Logger {
  const noop = (): void => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

const HOST = localIPv4();
const MODULE = nativeModulePath();
const CAN_RUN = HOST !== null && MODULE !== null;

const NETWORK_NAME = `builtin-${Date.now().toString(36)}`;
const NETWORK_SECRET = `secret-${Math.random().toString(36).slice(2)}`;
const LISTEN_PORT = 14100 + Math.floor(Math.random() * 400);
const NATIVE_IPV4 = '10.126.201.2/24';

let runtime: NetworkingRuntime;
let child: ChildProcess | null = null;
const output: string[] = [];
/** 本机侧是否已能看到对端（由 beforeAll 里的轮询维护） */
let officialSeen = false;
const pollers: NodeJS.Timeout[] = [];

/** 等某个条件成立，超时返回 false。 */
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
  const json = raw.slice(raw.indexOf('STATUS ') + 'STATUS '.length);
  try {
    return JSON.parse(json) as { peerCount: number; hostnames: string[] };
  } catch {
    return null;
  }
}

describe.skipIf(!CAN_RUN)('自研引擎作为主引擎（走 NetworkingRuntime）', () => {
  beforeAll(async () => {
    runtime = new NetworkingRuntime(silentLogger());

    const config = {
      ...defaultNetworkingConfig(),
      engine: 'builtin' as const,
      enabled: true,
      networkName: NETWORK_NAME,
      networkSecret: NETWORK_SECRET,
      hostname: 'ts-builtin',
      ipv4: '10.126.201.1',
      listenPort: LISTEN_PORT,
    };

    await runtime.start(config);

    // 官方节点作为发起方连入自研引擎。
    // 用内联脚本而不是 fixture 文件：与 easytierAcceptor.test.ts 保持一致，
    // 参数直接插值进去，读的人一眼能看出实际连的是哪个地址。
    const script = `
      const m = require(${JSON.stringify(MODULE)});
      (async () => {
        await m.startNode({
          networkName: ${JSON.stringify(NETWORK_NAME)},
          networkSecret: ${JSON.stringify(NETWORK_SECRET)},
          peers: ['tcp://${HOST}:${LISTEN_PORT}'],
          hostname: 'official-builtin',
          noTun: true,
          listenPort: ${LISTEN_PORT + 1},
          secureMode: true,
          secureModePrivateKey: 'KetlLhHz8XnpxeNcRgMkGCq3oRV6XakpaiYzzDMKzpE=',
          ipv4: ${JSON.stringify(NATIVE_IPV4)},
        });
        process.stdout.write('READY\\n');
        let tick = 0;
        setInterval(async () => {
          tick += 1;
          if (tick > 900) process.exit(0);
          try {
            const s = await m.nodeStatus();
            const p = await m.listPeers();
            process.stdout.write('STATUS ' + JSON.stringify({
              peerCount: s.peerCount ?? 0,
              ipv4: s.virtualIpv4 ?? null,
              hostnames: (p || []).map((x) => x.hostname).filter(Boolean),
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
      // STATUS 在 stdout，必须一起收——只收 stderr 会让探针永远拿不到状态
      output.push(chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output.push(chunk.toString());
    });

    // 后台轮询本机侧的 peers()：对端身份来自它的 OSPF 广播，需要等一轮同步。
    // 用轮询而不是一次性断言，避免把"还没同步完"误判成"不支持"。
    const poller = setInterval(() => {
      void runtime
        .peers()
        .then((list) => {
          if (list.some((peer) => peer.hostname !== undefined && peer.hostname !== '')) {
            officialSeen = true;
          }
        })
        .catch(() => {
          // 轮询期间的瞬时错误不影响判定
        });
    }, 500);
    pollers.push(poller);
  }, 120_000);

  afterAll(async () => {
    for (const poller of pollers) clearInterval(poller);
    child?.kill('SIGKILL');
    await runtime?.stop();
  });

  it('引擎是 builtin 且没有降级', () => {
    const config = {
      ...defaultNetworkingConfig(),
      engine: 'builtin' as const,
      enabled: true,
      networkName: NETWORK_NAME,
      listenPort: LISTEN_PORT,
    };
    const availability = runtime.availability('builtin');
    expect(availability.engine).toBe('builtin');
    expect(availability.degradedFrom).toBeNull();
    // 自研引擎没有编译依赖，不该因为"原生模块缺失"而不可用
    expect(availability.builtinAvailable).toBe(true);
    void config;
  });

  it('官方节点连上，status 反映真实连接数', async () => {
    const connected = await waitFor(
      () => lastStatus() !== null && lastStatus()!.peerCount >= 1,
      60_000,
    );
    expect(connected, `官方未连上。最终状态：${JSON.stringify(lastStatus())}`).toBe(true);

    const config = {
      ...defaultNetworkingConfig(),
      engine: 'builtin' as const,
      enabled: true,
      networkName: NETWORK_NAME,
      listenPort: LISTEN_PORT,
      ipv4: '10.126.201.1',
    };
    const status = await runtime.status(config);
    expect(status.running).toBe(true);
    // 注意：这里断言的是**自研引擎自己的连接数**，不是官方那边看到的。
    // 两边都看到 1 才说明是双向确认过的同一对连接。
    expect(status.peerCount).toBeGreaterThanOrEqual(1);
    expect(status.functional).toBe(true);
  }, 90_000);

  it('官方学到本机主机名（自研引擎的 OSPF 广播被接受）', async () => {
    // 官方 `listPeers()` 列的是**它的对端**，也就是本机 `ts-builtin`。
    // 所以这里期望出现的是我们自己的名字——它出现在对方列表里，
    // 正是"我们的 RoutePeerInfo 被对方路由表接受"的直接证据。
    const learned = await waitFor(
      () =>
        lastStatus() !== null && lastStatus()!.hostnames.includes('ts-builtin'),
      60_000,
    );
    expect(
      learned,
      `官方未学到本机主机名。最终状态：${JSON.stringify(lastStatus())}`,
    ).toBe(true);
  }, 90_000);

  it('本机 peers() 能列出官方节点（反向可见）', async () => {
    // 反向：自研引擎这一侧也要能说出"我连上了谁"。
    // 主机名来自对端 OSPF 广播里的 RoutePeerInfo，所以可能需要等一轮同步。
    const peers = await waitFor(
      () => officialSeen,
      60_000,
    );
    expect(peers, '本机未能列出官方节点').toBe(true);
    const list = await runtime.peers();
    expect(list.length).toBeGreaterThanOrEqual(1);
    // tunnel 固定报 tcp——自研引擎目前只实现 TCP 隧道
    expect(list[0].tunnel).toBe('tcp');
  }, 90_000);
});

/**
 * 端口被占时的诊断质量。
 *
 * 这条**不依赖原生模块**，所以不跳过。它验的是"失败可被诊断"：
 * 同一个 runtime 里第二次用同一端口启动，必须报出可操作的说明，
 * 而不是让用户对着 `running: false` 猜。
 */
describe('自研引擎的启动失败必须可诊断', () => {
  it('端口已占用时给出可操作的错误，状态里也带上原因', async () => {
    const rt = new NetworkingRuntime(silentLogger());
    const port = 15200 + Math.floor(Math.random() * 300);
    const base = {
      ...defaultNetworkingConfig(),
      engine: 'builtin' as const,
      enabled: true,
      networkName: `conflict-${Date.now().toString(36)}`,
      networkSecret: 'secret-x',
      hostname: 'ts-conflict',
      listenPort: port,
    };

    await rt.start(base);
    // 第二个实例抢同一端口：必须失败且说明是端口问题
    const rt2 = new NetworkingRuntime(silentLogger());
    let message = '';
    try {
      await rt2.start(base);
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain(String(port));

    // 失败后 status 不能只说 running:false，要带上原因
    const status = await rt2.status(base);
    expect(status.running).toBe(false);
    expect(status.functionalReason).toContain(String(port));

    await rt.stop();
  }, 30_000);
});
