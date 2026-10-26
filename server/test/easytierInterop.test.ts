import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HANDSHAKE_MAGIC,
  buildHandshakeRequest,
  decodeHandshakeResponse,
  encodeHandshakeRequest,
  validateHandshakeResponse,
} from '../src/networking/easytier/handshake';
import { extractFrame, framePacket, TCP_TUNNEL_HEADER_SIZE } from '../src/networking/easytier/framing';
import { PacketType, decodeHeader } from '../src/networking/easytier/protocol';
import { networkSecretDigest, sipHash13 } from '../src/networking/easytier/siphash';

/**
 * **真实建连测试**：让 TypeScript 实现与官方 EasyTier 节点握手。
 *
 * 这不是 mock，也不是"结构对不对"的断言——它启动一个真的 EasyTier 节点
 * （编译好的 N-API 原生模块），然后用纯 TS 代码连上去、发握手包、
 * 解析对方的响应。通过了就说明协议实现是真的能互通。
 *
 * ## 几个必须绕过的环境限制
 *
 * 1. **不能连 127.0.0.1**：EasyTier 的虚拟网络栈会接管 loopback，
 *    表现为 `connect timeout` 而对端收不到任何连接。必须用本机真实 IP。
 * 2. **原生模块是单例**：一个 Node 进程只能跑一个 EasyTier 实例，
 *    所以官方节点必须放在**子进程**里。
 * 3. **子进程要活到测试结束**：不能用一次性的 `execSync`。
 *
 * ## 这些测试会自动跳过
 *
 * 原生模块未编译（没有 Rust 工具链的机器）或拿不到本机 IP 时，
 * 整组测试 `skip`——因为"没编译"不是实现错误，不该让 CI 变红。
 * 但要能区分"跳过"与"通过"：跳过的测试不会证明互通性。
 */

/** 找本机非回环 IPv4 地址。连 127.0.0.1 会被虚拟网卡拦截。 */
function localIPv4(): string | null {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

const NATIVE_DIR = path.join(__dirname, '..', '..', 'native', 'easytier-node');
const NATIVE_MODULE = path.join(NATIVE_DIR, 'index.js');

/** 原生模块是否可用（编译过才有 .node 文件）。 */
function nativeModuleAvailable(): boolean {
  try {
    return fs.existsSync(NATIVE_MODULE);
  } catch {
    return false;
  }
}

const HOST = localIPv4();
const available = nativeModuleAvailable() && HOST !== null;

interface OfficialNode {
  process: ChildProcess;
  port: number;
  stop(): Promise<void>;
}

/**
 * 在子进程里启动一个官方 EasyTier 节点，等它就绪。
 *
 * `noTun: true` 让它走用户态协议栈，从而**不需要 CAP_NET_ADMIN**
 * （容器里通常没有）。这也是唯一能在无特权环境做真实建连测试的方式。
 */
async function startOfficialNode(options: {
  networkName: string;
  networkSecret: string;
  port: number;
  hostname: string;
}): Promise<OfficialNode> {
  const script = `
const m = require(${JSON.stringify(NATIVE_MODULE)});
(async () => {
  await m.startNode({
    networkName: ${JSON.stringify(options.networkName)},
    networkSecret: ${JSON.stringify(options.networkSecret)},
    peers: [],
    hostname: ${JSON.stringify(options.hostname)},
    noTun: true,
    listenPort: ${options.port},
  });
  console.log('READY');
  // 保持存活直到父进程杀掉
  await new Promise((resolve) => setTimeout(resolve, 120000));
  process.exit(0);
})().catch((e) => { console.error('SRVERR ' + e.message); process.exit(1); });
`;

  const child = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  // 等待 READY 标记（最多 20 秒——首次启动要建很多内部结构）
  const started = await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, 20_000);

    child.stdout?.on('data', (chunk) => {
      if (chunk.toString().includes('READY') && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
    child.on('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
  });

  if (!started) {
    child.kill('SIGKILL');
    throw new Error(`官方节点启动失败。stderr 片段：\n${stderr.slice(0, 800)}`);
  }

  return {
    process: child,
    port: options.port,
    async stop() {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        setTimeout(resolve, 2000);
      });
    },
  };
}

/**
 * 连到官方节点，发一个握手请求，返回原始响应字节。
 */
async function handshakeWith(options: {
  host: string;
  port: number;
  peerId: number;
  networkName: string;
  networkSecret: string;
}): Promise<Buffer> {
  const request = buildHandshakeRequest({
    myPeerId: options.peerId,
    networkName: options.networkName,
    networkSecret: options.networkSecret,
  });

  // 必须整帧发送：4 字节隧道长度头 + 16 字节 PeerManagerHeader + protobuf。
  // 只发裸 protobuf 会让对端把字段 tag 当成长度，报 InvalidPacket("body too long")。
  const framed = framePacket(encodeHandshakeRequest(request), {
    fromPeerId: options.peerId,
    toPeerId: 0,
    packetType: PacketType.HandShake,
  });

  return new Promise<Buffer>((resolve, reject) => {
    const socket = net.connect(options.port, options.host, () => socket.write(framed));

    let received = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      // 收到一帧就够验证握手了
      try {
        if (extractFrame(received) !== null) {
          socket.destroy();
          resolve(received);
        }
      } catch (cause) {
        socket.destroy();
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });

    socket.on('error', (cause) => reject(cause));
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error(`握手超时，已收到 ${received.length} 字节`));
    });
  });
}

// ══════════════════════════════════════════════════════════════════
// SipHash / digest：不依赖原生模块，永远运行
// ══════════════════════════════════════════════════════════════════

describe('network_secret_digest 与 Rust DefaultHasher 一致', () => {
  // 基准值由 Rust 程序算出（见 native/protocol-oracle 的说明）。
  // 这不是"自己和自己一致"，而是与官方依赖的哈希函数一致。
  it('SipHash-1-3 匹配 Rust DefaultHasher（空输入）', () => {
    expect(sipHash13(Buffer.alloc(0))).toBe(15130871412783076140n);
  });

  it('SipHash-1-3 匹配 Rust DefaultHasher（3 字节）', () => {
    expect(sipHash13(Buffer.from('abc'))).toBe(13851880170939887858n);
  });

  it('SipHash-1-3 匹配 Rust DefaultHasher（整块 16 字节）', () => {
    expect(sipHash13(Buffer.from('0123456789abcdef'))).toBe(2108444454683020324n);
  });

  it('network_secret_digest 与官方算法一致（含滚动喂回）', () => {
    // 官方实现每轮把已生成的摘要前缀再喂回 hasher，这一点最容易漏。
    expect(networkSecretDigest('rna', 'sss').toString('hex')).toBe(
      '95d1e8307c64c8880783a787f3577cac3ee31b249340f095464ac9b9da5b27ae',
    );
    expect(networkSecretDigest('realnet', 'shared-secret-xyz').toString('hex')).toBe(
      'c712e8052cef0b0e18794aa38ebad5fab7e24809304bbe8ba06edf4ba5c11ca5',
    );
  });

  it('不同密钥得到不同摘要', () => {
    expect(networkSecretDigest('net', 'a').toString('hex')).not.toBe(
      networkSecretDigest('net', 'b').toString('hex'),
    );
  });

  it('不同网络名得到不同摘要（即使密钥相同）', () => {
    expect(networkSecretDigest('net-a', 'same').toString('hex')).not.toBe(
      networkSecretDigest('net-b', 'same').toString('hex'),
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// 帧封装：不依赖原生模块，永远运行
// ══════════════════════════════════════════════════════════════════

describe('TCP 隧道帧封装', () => {
  it('帧头是 4 字节小端长度，值等于 body 长度', () => {
    const payload = Buffer.from('hello');
    const framed = framePacket(payload, {
      fromPeerId: 1,
      toPeerId: 2,
      packetType: PacketType.Data,
    });
    // 4 字节长度头 + 16 字节包头 + 5 字节载荷
    expect(framed.length).toBe(TCP_TUNNEL_HEADER_SIZE + 16 + payload.length);
    expect(framed.readUInt32LE(0)).toBe(16 + payload.length);
  });

  it('往返：packet 能被 extractFrame 切回来', () => {
    const payload = Buffer.from('payload-bytes');
    const framed = framePacket(payload, {
      fromPeerId: 7,
      toPeerId: 8,
      packetType: PacketType.HandShake,
    });
    const frame = extractFrame(framed);
    expect(frame).not.toBeNull();
    expect(frame!.bodyLength).toBe(16 + payload.length);

    const header = decodeHeader(frame!.body);
    expect(header?.packetType).toBe(PacketType.HandShake);
    expect(header?.fromPeerId).toBe(7);
    expect(header?.toPeerId).toBe(8);
    expect(header?.len).toBe(payload.length);
  });

  it('半包返回 null（等待更多数据）', () => {
    const framed = framePacket(Buffer.from('abc'), {
      fromPeerId: 1,
      toPeerId: 0,
      packetType: PacketType.Data,
    });
    expect(extractFrame(framed.subarray(0, 2))).toBeNull();
    expect(extractFrame(framed.subarray(0, framed.length - 1))).toBeNull();
  });

  it('长度小于包头大小时报错（对端要求 body_len >= 16）', () => {
    const bad = Buffer.alloc(8);
    bad.writeUInt32LE(4, 0);
    expect(() => extractFrame(bad)).toThrow(/小于包头/);
  });

  it('长度超上限时报错', () => {
    const bad = Buffer.alloc(8);
    bad.writeUInt32LE(1024 * 1024 * 1024, 0);
    expect(() => extractFrame(bad)).toThrow(/超过上限/);
  });
});

// ══════════════════════════════════════════════════════════════════
// 真实建连：需要编译好的原生模块 + 本机 IP
// ══════════════════════════════════════════════════════════════════

describe.skipIf(!available)('与官方 EasyTier 节点真实握手', () => {
  const NETWORK_NAME = 'ts-integration';
  const NETWORK_SECRET = 'integration-secret-123';
  const PORT = 11900;
  const MY_PEER_ID = 123456789;

  let node: OfficialNode | null = null;

  beforeAll(async () => {
    node = await startOfficialNode({
      networkName: NETWORK_NAME,
      networkSecret: NETWORK_SECRET,
      port: PORT,
      hostname: 'official-node',
    });
    // 节点打印 READY 时监听已建立，但内部路由表还需要一点时间
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 40_000);

  afterAll(async () => {
    await node?.stop();
  }, 10_000);

  it('官方节点接受了我们的握手并返回有效响应', async () => {
    const raw = await handshakeWith({
      host: HOST!,
      port: PORT,
      peerId: MY_PEER_ID,
      networkName: NETWORK_NAME,
      networkSecret: NETWORK_SECRET,
    });

    // 1. 拆帧
    const frame = extractFrame(raw);
    expect(frame, `未收到完整帧，原始字节：${raw.toString('hex')}`).not.toBeNull();

    // 2. 拆包头：必须是 HandShake 类型
    const header = decodeHeader(frame!.body);
    expect(header).not.toBeNull();
    expect(header!.packetType).toBe(PacketType.HandShake);

    // 3. 拆握手响应
    const payloadStart = 16;
    const response = decodeHandshakeResponse(frame!.body.subarray(payloadStart));

    // 4. 三项核心校验
    // magic：证明对端认出这是同代协议
    expect(response.magic).toBe(HANDSHAKE_MAGIC);
    // 网络名：证明它在同一个虚拟网络里
    expect(response.networkName).toBe(NETWORK_NAME);
    // 摘要：**证明我们的 SipHash 实现与官方一致**。
    // 这是整条链上最难的一环——摘要由官方用 Rust DefaultHasher 算出，
    // 我们必须在 TS 里逐位复现，否则这里必然不等。
    expect(response.networkSecretDigest.toString('hex')).toBe(
      networkSecretDigest(NETWORK_NAME, NETWORK_SECRET).toString('hex'),
    );

    // 5. 用提供的校验函数再过一遍（覆盖错误路径之外的正向路径）
    expect(
      validateHandshakeResponse(response, {
        networkName: NETWORK_NAME,
        networkSecret: NETWORK_SECRET,
      }),
    ).toBeNull();
  }, 30_000);

  it('错误的网络密钥会被对端拒绝或不予正常响应', async () => {
    // 用错误的密钥：摘要不同，对端要么断开、要么返回的摘要与我们算的不同。
    // 这里断言"不能通过 validateHandshakeResponse"，而不是断言具体行为——
    // 因为对端的处理方式（直接断开 vs 回错误摘要）属于实现细节。
    let outcome: 'rejected' | 'digest-mismatch' | 'timeout' = 'timeout';
    try {
      const raw = await handshakeWith({
        host: HOST!,
        port: PORT,
        peerId: MY_PEER_ID + 1,
        networkName: NETWORK_NAME,
        networkSecret: 'totally-wrong-secret',
      });
      const frame = extractFrame(raw);
      if (frame === null) {
        outcome = 'rejected';
      } else {
        const response = decodeHandshakeResponse(frame.body.subarray(16));
        const problem = validateHandshakeResponse(response, {
          networkName: NETWORK_NAME,
          networkSecret: 'totally-wrong-secret',
        });
        outcome = problem === null ? 'digest-mismatch' : 'rejected';
      }
    } catch {
      outcome = 'timeout';
    }
    // 关键：错误密钥绝不能"看起来成功"
    expect(outcome).not.toBe('digest-mismatch');
  }, 30_000);
});

// 当原生模块不可用时，显式记一条跳过原因，避免"绿了但其实没测"
describe('真实建连测试的前置条件', () => {
  it('环境说明', () => {
    if (!nativeModuleAvailable()) {
      console.warn(
        '[skip] 原生模块未编译，真实建连测试已跳过。' +
          '运行 `cd native/easytier-node && npx napi build --platform --release` 后可启用。',
      );
    } else if (HOST === null) {
      console.warn('[skip] 找不到非回环 IPv4 地址，真实建连测试已跳过。');
    }
    expect(true).toBe(true);
  });
});
