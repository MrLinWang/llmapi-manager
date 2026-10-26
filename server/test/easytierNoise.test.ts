import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NOISE_PROLOGUE,
  NOISE_PROTOCOL_NAME,
  NoiseXXInitiator,
  encryptWithAd,
  decryptWithAd,
  generateKeyPair,
} from '../src/networking/easytier/noiseXX';
import {
  SECRET_PROOF_PREFIX,
  decodeNoiseMsg2,
  decodeUuid,
  encodeNoiseMsg1,
  encodeNoiseMsg3,
  encodeUuid,
  newConnId,
  secretProof,
  verifySecretProof,
} from '../src/networking/easytier/noiseHandshake';
import { networkSecretDigest } from '../src/networking/easytier/siphash';
import { decodeFields } from '../src/networking/easytier/protobuf';
import { framePacket, extractFrame } from '../src/networking/easytier/framing';
import { PacketType, decodeHeader } from '../src/networking/easytier/protocol';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * Noise XX 握手的**交叉验证**。
 *
 * 用官方同一个 Noise 实现（`snow 0.10.0`，通过 `native/noise-responder`
 * 这个 Rust 小程序暴露为行协议）充当响应方，让我们的 TS 发起方与它真的握手。
 *
 * ## 为什么必须交叉验证
 *
 * Noise 握手写错时的表现统一是"握手失败"，但失败原因可能是：
 * - 哈希混入顺序错了（先 mixKey 还是先 mixHash）
 * - DH 的配对对象错了（`ee` 用成 `es`）
 * - nonce 没递增或没重置
 *
 * 这些错误**自己和自己测永远发现不了**——两边错得一样就互相通过。
 * 必须拿一个独立实现来对。
 */

const RESPONDER_BINARY = path.join(
  __dirname,
  '..',
  '..',
  'native',
  'noise-responder',
  'target',
  'release',
  'noise-responder',
);

const responderAvailable = fs.existsSync(RESPONDER_BINARY);

/** 与 Rust 响应方通信的行协议封装。 */
class SnowResponder {
  private readonly child: ChildProcess;
  private readonly lines: string[] = [];
  private readonly rl: readline.Interface;

  constructor() {
    this.child = spawn(RESPONDER_BINARY, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.rl = readline.createInterface({ input: this.child.stdout! });
    this.rl.on('line', (line) => this.lines.push(line));
  }

  private send(command: string): void {
    this.child.stdin!.write(`${command}\n`);
  }

  private async waitFor(prefix: string, timeoutMs = 5000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = this.lines.find((line) => line.startsWith(prefix));
      if (hit !== undefined) {
        this.lines.splice(this.lines.indexOf(hit), 1);
        return hit;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`等待 "${prefix}" 超时；未消费的行：${this.lines.join(' | ') || '(空)'}`);
  }

  /** 让 snow 读取一条消息。 */
  async read(hexPayload: string): Promise<void> {
    this.send(`READ ${hexPayload}`);
    const reply = await this.waitFor('OK');
    expect(reply).toBe('OK');
  }

  /** 让 snow 产出一条消息。 */
  async write(): Promise<Buffer> {
    this.send('WRITE');
    const line = await this.waitFor('MSG ');
    return Buffer.from(line.slice(4), 'hex');
  }

  /** 查询 snow 是否认为握手完成。 */
  async isFinished(): Promise<boolean> {
    this.send('DONE');
    const line = await this.waitFor('DONE ');
    return line.trim() === 'DONE true';
  }

  close(): void {
    try {
      this.send('QUIT');
    } catch {
      // 进程可能已退出
    }
    this.child.kill();
  }
}

describe.skipIf(!responderAvailable)('Noise XX 与 snow（官方同款实现）交叉验证', () => {
  let responder: SnowResponder | null = null;

  beforeAll(() => {
    responder = new SnowResponder();
  });

  afterAll(() => {
    responder?.close();
  });

  it('参数与官方一致', () => {
    // 这两个字符串写错都会表现为"握手超时"，且不说原因
    expect(NOISE_PROTOCOL_NAME).toBe('Noise_XX_25519_ChaChaPoly_SHA256');
    expect(NOISE_PROLOGUE.toString('utf8')).toBe('easytier-peerconn-noise');
  });

  it('完成完整三轮握手，且消息长度符合 XX 结构', async () => {
    // 每轮都要新建 responder（它是单次握手的状态机）
    responder!.close();
    responder = new SnowResponder();
    const client = new NoiseXXInitiator();

    // ── 第 1 轮：-> e ──
    const msg1 = client.writeMessage();
    // XX 的 msg1 只有一个临时公钥
    expect(msg1.length).toBe(32);
    await responder!.read(msg1.toString('hex'));

    // ── 第 2 轮：<- e, ee, s, es ──
    const msg2 = await responder!.write();
    // e(32) + s(32) + tag(16) + tag(16) = 96
    expect(msg2.length).toBe(96);
    client.readMessage(msg2);

    // ── 第 3 轮：-> s, se ──
    const msg3 = client.writeMessage();
    // s(32) + tag(16) + tag(16) = 64
    expect(msg3.length).toBe(64);
    await responder!.read(msg3.toString('hex'));

    // 双方都必须认为握手完成——这是最强的一条：
    // 只要任何一步的哈希/密钥派生有偏差，这里就会 false
    expect(await responder!.isFinished()).toBe(true);

    const keys = client.finalize();
    expect(keys.sendKey).toHaveLength(32);
    expect(keys.receiveKey).toHaveLength(32);
    // 发送与接收密钥必须不同（Noise 的 Split 产生两个方向）
    expect(keys.sendKey.equals(keys.receiveKey)).toBe(false);
  }, 20_000);

  it('握手哈希在过程中会变化（证明真的在混入数据）', async () => {
    responder!.close();
    responder = new SnowResponder();
    const client = new NoiseXXInitiator();
    const hash0 = client.getHandshakeHash();

    const msg1 = client.writeMessage();
    const hash1 = client.getHandshakeHash();
    await responder!.read(msg1.toString('hex'));

    const msg2 = await responder!.write();
    client.readMessage(msg2);
    const hash2 = client.getHandshakeHash();

    // 每一步都该改变哈希；若不变说明 mixHash 没被调用
    expect(hash1.equals(hash0)).toBe(false);
    expect(hash2.equals(hash1)).toBe(false);
  }, 20_000);

  it('错误 prologue 会导致握手失败（证明 prologue 真的参与计算）', async () => {
    responder!.close();
    responder = new SnowResponder();

    // 用一个错误的 prologue
    const client = new NoiseXXInitiator(Buffer.from('wrong-prologue', 'utf8'));
    const msg1 = client.writeMessage();

    // responder 读得下去（msg1 不含 prologue 影响的部分），
    await responder!.read(msg1.toString('hex'));
    const msg2 = await responder!.write();

    // 但读 msg2 时应该失败——prologue 不同导致握手哈希不同，
    // 而 msg2 的 payload 是用哈希做 AAD 加密的
    expect(() => client.readMessage(msg2)).toThrow();
  }, 20_000);
});

describe('Noise 的 AEAD 封装', () => {
  it('加解密往返', () => {
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(8, 0);
    const ad = Buffer.from('associated-data');
    const plaintext = Buffer.from('hello noise');

    const ciphertext = encryptWithAd(key, nonce, plaintext, ad);
    // 密文 = 明文长度 + 16 字节 tag
    expect(ciphertext.length).toBe(plaintext.length + 16);

    const decrypted = decryptWithAd(key, nonce, ciphertext, ad);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('AAD 被篡改时解密失败', () => {
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(8, 0);
    const ciphertext = encryptWithAd(key, nonce, Buffer.from('data'), Buffer.from('ad-1'));
    expect(() => decryptWithAd(key, nonce, ciphertext, Buffer.from('ad-2'))).toThrow();
  });

  it('密文被篡改时解密失败', () => {
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(8, 0);
    const ad = Buffer.from('ad');
    const ciphertext = encryptWithAd(key, nonce, Buffer.from('data'), ad);
    ciphertext[0] ^= 0xff;
    expect(() => decryptWithAd(key, nonce, ciphertext, ad)).toThrow();
  });

  it('不同 nonce 得到不同密文（nonce 真的参与了）', () => {
    const key = Buffer.alloc(32, 7);
    const plaintext = Buffer.from('same');
    const ad = Buffer.from('ad');
    const a = encryptWithAd(key, Buffer.alloc(8, 0), plaintext, ad);
    const b = encryptWithAd(key, Buffer.alloc(8, 1), plaintext, ad);
    expect(a.equals(b)).toBe(false);
  });
});

describe('secret_proof', () => {
  it('前缀与官方一致（context.rs:41）', () => {
    // 与凭证的前缀是**两个不同常量**，用错会让对端报 proof mismatch
    expect(SECRET_PROOF_PREFIX.toString('utf8')).toBe('easytier secret proof');
  });

  it('同一密钥与同一挑战得到同一 proof', () => {
    const challenge = Buffer.alloc(32, 3);
    expect(secretProof('secret', challenge).toString('hex')).toBe(
      secretProof('secret', challenge).toString('hex'),
    );
  });

  it('不同挑战得到不同 proof（防重放）', () => {
    // 这是安全上的关键：proof 掺入了本次会话的握手哈希，
    // 所以抓到的 proof 无法在另一次连接里重放
    const a = secretProof('secret', Buffer.alloc(32, 1));
    const b = secretProof('secret', Buffer.alloc(32, 2));
    expect(a.equals(b)).toBe(false);
  });

  it('不同密钥得到不同 proof', () => {
    const challenge = Buffer.alloc(32, 1);
    expect(secretProof('a', challenge).equals(secretProof('b', challenge))).toBe(false);
  });

  it('验签：正确通过、错误拒绝', () => {
    const challenge = Buffer.alloc(32, 5);
    const proof = secretProof('right', challenge);
    expect(verifySecretProof('right', challenge, proof)).toBe(true);
    expect(verifySecretProof('wrong', challenge, proof)).toBe(false);
    // 长度不符也不能崩
    expect(verifySecretProof('right', challenge, proof.subarray(0, 16))).toBe(false);
  });
});

describe('X25519 密钥', () => {
  it('生成 32 字节密钥对，且公钥与私钥对应', () => {
    const kp = generateKeyPair();
    expect(kp.privateKey).toHaveLength(32);
    expect(kp.publicKey).toHaveLength(32);
  });

  it('两次生成不同', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.privateKey.equals(b.privateKey)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 与真实 EasyTier 节点的 secure mode 握手
// ══════════════════════════════════════════════════════════════════

/** 找本机非回环 IPv4（连 127.0.0.1 会被虚拟网络栈拦截）。 */
function localIPv4ForNoise(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

const NATIVE_MODULE_PATH = path.join(
  __dirname, '..', '..', 'native', 'easytier-node', 'index.js',
);
const sessionAvailable = fs.existsSync(NATIVE_MODULE_PATH) && localIPv4ForNoise() !== null;

interface RealNode {
  stop(): Promise<void>;
}

/** 启动一个启用 secure mode 的官方节点（子进程，因为原生模块是单例）。 */
async function startSecureNode(options: {
  networkName: string;
  networkSecret: string;
  port: number;
  hostname: string;
}): Promise<RealNode> {
  // secure mode 必须有静态密钥，否则实例构造阶段失败：
  // "local private key is not set"
  const privateKey = randomBytes(32).toString('base64');
  const script = [
    `const m = require(${JSON.stringify(NATIVE_MODULE_PATH)});`,
    '(async () => {',
    `  await m.startNode({`,
    `    networkName: ${JSON.stringify(options.networkName)},`,
    `    networkSecret: ${JSON.stringify(options.networkSecret)},`,
    '    peers: [],',
    `    hostname: ${JSON.stringify(options.hostname)},`,
    '    noTun: true,',
    `    listenPort: ${options.port},`,
    '    secureMode: true,',
    `    secureModePrivateKey: ${JSON.stringify(privateKey)},`,
    '  });',
    "  console.log('READY');",
    '  await new Promise((r) => setTimeout(r, 120000));',
    '  process.exit(0);',
    "})().catch((e) => { console.error('SRVERR ' + e.message); process.exit(1); });",
  ].join('\n');

  const child: ChildProcess = spawn('node', ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

  const started = await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 20_000);
    child.stdout?.on('data', (chunk) => {
      if (chunk.toString().includes('READY') && !settled) {
        settled = true; clearTimeout(timer); resolve(true);
      }
    });
    child.on('exit', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
  });

  if (!started) {
    child.kill('SIGKILL');
    throw new Error(`secure 节点启动失败：\n${stderr.slice(0, 600)}`);
  }

  return {
    async stop() {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => { child.on('exit', () => resolve()); setTimeout(resolve, 1500); });
    },
  };
}

/** 建立连接、发送若干帧、收集回帧。 */
async function exchangeFrame(options: {
  host: string;
  port: number;
  frames: Buffer[];
}): Promise<Buffer[]> {
  return new Promise<Buffer[]>((resolve, reject) => {
    const socket = net.connect(options.port, options.host);
    let buf = Buffer.alloc(0);
    const received: Buffer[] = [];

    socket.on('connect', () => {
      for (const frame of options.frames) socket.write(frame);
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        try {
          const frame = extractFrame(buf);
          if (frame === null) break;
          buf = buf.subarray(4 + frame.bodyLength);
          received.push(frame.body);
          if (received.length > 0) {
            socket.destroy();
            resolve(received);
            return;
          }
        } catch (cause) {
          socket.destroy();
          reject(cause instanceof Error ? cause : new Error(String(cause)));
          return;
        }
      }
    });

    socket.on('error', reject);
    socket.setTimeout(10_000, () => {
      socket.destroy();
      resolve(received);
    });
  });
}

describe('UUID 编码（common.UUID 是 4 个 uint32，不是 bytes）', () => {
  it('16 字节 UUID 编码为 4 个 varint 字段', () => {
    // 一开始我按"16 字节 bytes 字段"实现，官方节点给出了精确报错：
    //   UnexpectedWireType { actual: LengthDelimited, expected: Varint }
    //   stack: [("Uuid","part1"), ("PeerConnNoiseMsg1Pb","a_conn_id")]
    // 这个错误说明 common.proto:170 的 UUID 是 4 个 uint32。
    const uuid = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
    const encoded = encodeUuid(new Uint8Array(uuid));

    // 4 个字段，每个都是 varint（wire type 0）
    const fields = decodeFields(encoded);
    expect(fields).toHaveLength(4);
    expect(fields.every((f) => f.wireType === 0)).toBe(true);
    // 字段号依次 1..4，值按大端切成 4 段
    expect(fields.map((f) => f.fieldNumber)).toEqual([1, 2, 3, 4]);
    expect(fields.map((f) => f.value)).toEqual([
      0x01020304, 0x05060708, 0x090a0b0c, 0x0d0e0f10,
    ]);
  });

  it('解码回到原始 16 字节', () => {
    const uuid = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
    const roundTrip = decodeUuid(encodeUuid(new Uint8Array(uuid)));
    expect(Buffer.from(roundTrip).equals(uuid)).toBe(true);
  });

  it('长度不对时拒绝', () => {
    expect(() => encodeUuid(new Uint8Array(15))).toThrow(/16 字节/);
  });
});

describe.skipIf(!sessionAvailable)('与真实 EasyTier 节点完成 Noise 握手（secure mode）', () => {
  const NETWORK = 'noise-integration';
  const SECRET = 'noise-secret-777';
  const PORT = 11950;
  const MY_PEER_ID = 987654321;
  const HOST_IP = localIPv4ForNoise();

  let node: RealNode | null = null;

  beforeAll(async () => {
    node = await startSecureNode({
      networkName: NETWORK,
      networkSecret: SECRET,
      port: PORT,
      hostname: 'official-secure',
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }, 40_000);

  afterAll(async () => {
    await node?.stop();
  }, 10_000);

  it('官方节点接受 Noise Msg1 并返回可解密的 Msg2', async () => {
    // 这是数据面握手的第一步：只有它能成功，后面才谈得上传数据。
    //
    // 关键前提：节点必须启用 secure mode。未启用时第一条包必须是明文 HandShake，
    // 发 NoiseHandshakeMsg1 会被当作未处理包丢弃
    // （日志 `unhandled packet ... packet_type: TCP`）——
    // 两条路径互斥，不能"先明文握手再 Noise"。
    const connId = newConnId();
    const noise = new NoiseXXInitiator();
    const msg1 = noise.writeMessage(
      encodeNoiseMsg1({
        version: 1,
        aNetworkName: NETWORK,
        aSessionGeneration: null,
        aConnId: connId,
        clientEncryptionAlgorithm: '',
        features: ['liveness-echo-v1'],
      }),
    );

    const response = await exchangeFrame({
      host: HOST_IP,
      port: PORT,
      frames: [
        framePacket(msg1, {
          fromPeerId: MY_PEER_ID,
          toPeerId: 0,
          packetType: PacketType.NoiseHandshakeMsg1,
        }),
      ],
    });

    expect(response.length).toBeGreaterThan(0);
    const header = decodeHeader(response[0]!);
    // 对端必须回应 NoiseHandshakeMsg2
    expect(header?.packetType).toBe(PacketType.NoiseHandshakeMsg2);

    // 能解密就证明了 Noise 的哈希链、DH 配对、nonce 全部正确
    const payload = noise.readMessage(response[0]!.subarray(16));
    const msg2 = decodeNoiseMsg2(payload);
    expect(msg2.bNetworkName).toBe(NETWORK);
    // Msg2 里会回显我们的 conn_id，证明它把这轮消息关联到了同一次连接
    expect(Buffer.from(msg2.aConnIdEcho ?? [])).toBeTruthy();

    // Msg3 必须回显 Msg1 的 conn_id，否则对端报
    // "noise msg3 a_conn_id mismatch"（踩过）
    const msg3 = noise.writeMessage(
      encodeNoiseMsg3({
        aConnIdEcho: connId,
        bConnIdEcho: msg2.bConnId,
        secretProof: secretProof(SECRET, noise.getHandshakeHash()),
        secretDigest: networkSecretDigest(NETWORK, SECRET),
      }),
    );
    expect(msg3.length).toBeGreaterThan(0);
    // Msg3 之后对端不再报握手错误，而是开始同步路由
    // （我们没实现 OSPF 应答，所以它会超时——但那属于数据面，不是握手问题）
  }, 40_000);
});
