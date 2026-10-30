import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EasyTierAcceptor } from '../src/networking/easytier/acceptor';

/**
 * **接受方方向的真实互通测试**：官方原生节点作为发起方，连入 TS 接受方。
 *
 * 这是"自研实现与官方一致"的最后一关。此前的互通测试里 TS 是发起方——
 * 握手能通，但官方随后发来的 OSPF `SyncRouteInfo` 请求永远无法应答
 * （`RpcResp` 只被接受方角色的连接接受，发起方的响应在解密前就被丢弃）。
 *
 * 本测试把角色反过来：
 *
 * - TS 监听端口，官方节点作为发起方连入
 * - TS 完成服务端 Noise 握手（NoiseXXResponder）
 * - 官方发 OSPF 同步请求，TS 以接受方身份应答（合法方向）
 * - TS 广播自己的 RoutePeerInfo，官方的路由表里应出现本节点主机名
 *
 * 通过的判据（从严到松）：
 * 1. 官方的 `sync_route_info` 不再超时（此前每次必现的超时日志消失）
 * 2. 官方的 peer 列表里出现 TS 的主机名（OSPF 图里真的学到了本节点）
 * 3. 官方 peerCount ≥ 1
 *
 * ## 自动跳过的条件
 *
 * 原生模块未编译、或拿不到非回环 IPv4（EasyTier 会拦截 127.0.0.1）。
 * 跳过 ≠ 通过：跳过不证明互通。
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

const HOST = localIPv4();
const MODULE = nativeModulePath();
const CAN_RUN = HOST !== null && MODULE !== null;

const NETWORK_NAME = `acceptor-${Date.now().toString(36)}`;
const NETWORK_SECRET = `secret-${Math.random().toString(36).slice(2)}`;
const TS_PEER_ID = 987654321;
const ACCEPTOR_PORT = 13010 + Math.floor(Math.random() * 500);
const NATIVE_PORT = ACCEPTOR_PORT + 1;

let acceptor: EasyTierAcceptor;
let native: ChildProcess;
const nativeLog: string[] = [];

/** 等待某个条件成立；超时返回最后快照。 */
async function waitFor<T>(
  probe: () => T | null,
  timeoutMs: number,
): Promise<{ ok: boolean; last: T | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = probe();
    if (last !== null) return { ok: true, last };
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, last };
}

interface NativeStatus {
  peerCount: number;
  ipv4: string | null;
  hostnames: string[];
}

function lastNativeStatus(): NativeStatus | null {
  const matches = [...nativeLog.join('').matchAll(/STATUS (\{.*\})/g)];
  if (matches.length === 0) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1]) as NativeStatus;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  if (!CAN_RUN) return;

  acceptor = new EasyTierAcceptor(
    {
      port: ACCEPTOR_PORT,
      myPeerId: TS_PEER_ID,
      networkName: NETWORK_NAME,
      networkSecret: NETWORK_SECRET,
      hostname: 'ts-node',
      virtualIpv4: '10.126.200.1',
      advertiseRoute: true,
      algorithm: 'aes-gcm',
    },
    {
      onOspfAnswered: (info) => {
        process.stdout.write(`[ts-acceptor] OSPF 已应答，native my_peer_id=${info.nativeMyPeerId}\n`);
      },
      onRouteAdvertised: () => {
        process.stdout.write('[ts-acceptor] 路由广播已发出\n');
      },
      onHandshake: (info) => {
        process.stdout.write(`[ts-acceptor] 握手完成，remote=${info.remotePeerId} roleHint=${info.roleHint}\n`);
      },
      onError: (err) => {
        // 连接被断的最常见原因就是这里抛了错——必须打出来，否则只能瞎猜
        process.stdout.write(`[ts-acceptor-error] ${err.message}\n${(err.stack ?? '').split('\n').slice(1, 4).join('\n')}\n`);
      },
    },
  );
  await acceptor.start();

  // 官方节点作为发起方连入；secure mode 开启（它作为客户端也需要自己的静态密钥）
  const script = `
    const m = require(${JSON.stringify(MODULE)});
    (async () => {
      await m.startNode({
        networkName: ${JSON.stringify(NETWORK_NAME)},
        networkSecret: ${JSON.stringify(NETWORK_SECRET)},
        peers: ['tcp://${HOST}:${ACCEPTOR_PORT}'],
        hostname: 'official',
        noTun: true,
        listenPort: ${NATIVE_PORT},
        secureMode: true,
        secureModePrivateKey: 'KetlLhHz8XnpxeNcRgMkGCq3oRV6XakpaiYzzDMKzpE=',
        ipv4: '10.126.200.2/24',
      });
      process.stdout.write('READY\\n');
      let tick = 0;
      setInterval(async () => {
        tick += 1;
        if (tick > 600) process.exit(0);
        try {
          const s = await m.nodeStatus();
          const p = await m.listPeers();
          process.stdout.write('STATUS ' + JSON.stringify({
            peerCount: s.peerCount ?? 0,
            ipv4: s.virtualIpv4 ?? null,
            hostnames: (p || []).map((x) => x.hostname).filter(Boolean),
          }) + '\\n');
        } catch {}
      }, 1000);
    })().catch((e) => {
      process.stderr.write('STARTFAIL ' + (e && e.message ? e.message : String(e)) + '\\n');
      process.exit(1);
    });
  `;
  native = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  native.stdout?.on('data', (chunk: Buffer) => {
    // STATUS 行在 stdout（子进程脚本打印），也要进日志供探针解析——
    // 只存 stderr 的话 waitFor 永远拿不到状态（踩过：探针读错流）。
    nativeLog.push(chunk.toString());
    process.stdout.write(`[official] ${chunk}`);
  });
  native.stderr?.on('data', (chunk: Buffer) => {
    nativeLog.push(chunk.toString());
    if (process.env.EASYTIER_ACCEPTOR_DEBUG) process.stderr.write(`[official-err] ${chunk}`);
  });
});

afterAll(async () => {
  // 完整落盘：排查"路由信息没被对端采纳"这类问题只能靠看它的全量日志
  if (nativeLog.length > 0) {
    // 不能用写死的 /tmp：Windows 上没有这个目录，会抛 ENOENT 把清理流程打断
    fs.writeFileSync(path.join(os.tmpdir(), 'native-acceptor.log'), nativeLog.join(''));
  }
  await acceptor?.close();
  native?.kill('SIGTERM');
  setTimeout(() => native?.kill('SIGKILL'), 1500).unref();
});

describe.skipIf(!CAN_RUN)('EasyTier 接受方：官方节点作为发起方连入', () => {
  it(
    '握手完成且 OSPF 同步请求被成功应答',
    async () => {
      // 就绪信号：官方节点连入并完成握手（acceptor 记录）
      const handshake = await waitFor(
        () => (acceptor['connections']?.size ?? 0) >= 1 ? { connected: true } : null,
        20_000,
      );
      expect(handshake.ok, '官方节点未在 20 秒内连入').toBe(true);

      // OSPF：官方发起 SyncRouteInfo，TS 应答
      const answered = await waitFor(() => (acceptor.hasAnsweredOspf() ? true : null), 15_000);
      expect(answered.ok, '15 秒内未应答任何 OSPF 同步请求').toBe(true);
    },
    60_000,
  );

  it(
    '官方的 sync_route_info 不再超时（此前每次必现）',
    async () => {
      // OSPF 应答之后再等几秒：若应答无效，官方每 3 秒会打一条超时错误
      await new Promise((r) => setTimeout(r, 8_000));
      const log = nativeLog.join('');
      const timeouts = (log.match(/sync_route_info failed/g) ?? []).length;
      expect(
        timeouts,
        `官方仍报 ${timeouts} 次 sync_route_info 超时，说明应答未被接受`,
      ).toBe(0);
    },
    30_000,
  );

  // 最终一关的根因（2026-10-29 已解决）：`OSPF_SERVICE` 常量还带着早期
  // 的错误假设——protoName 带包名（应为 `OspfRouteRpc`）、methodIndex 0
  // （应为 1）。这两个值最早靠猜，当时没有任何调用能走到服务匹配层，
  // 错了也不暴露；dump 真实包才纠正。另需 domainName=网络名 与
  // 广播带 ipv4_addr（路由安装的必要条件）。
  it(
    '官方的路由表里学到本节点（主机名 ts-node 出现在 peer 列表）',
    async () => {
      const { ok, last } = await waitFor(() => {
        const status = lastNativeStatus();
        if (status !== null && status.hostnames.includes('ts-node')) return status;
        return null;
      }, 20_000);
      expect(
        ok,
        `官方未学到 ts-node。最终状态：${JSON.stringify(last)}`,
      ).toBe(true);
      expect(last?.peerCount ?? 0).toBeGreaterThanOrEqual(1);
    },
    40_000,
  );
});
