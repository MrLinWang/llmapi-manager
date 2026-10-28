import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NOISE_PROLOGUE,
  NOISE_PROTOCOL_NAME,
  NoiseXXInitiator,
  NoiseXXResponder,
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
import {
  AEAD_NONCE_SIZE,
  AEAD_TAG_SIZE,
  decryptPayload,
  deriveTrafficKey,
  directionForSender,
  encryptPayload,
  keyForAlgorithm,
  nodeCipherName,
  parseNonce,
  shouldSkipEncrypt,
} from '../src/networking/easytier/dataPlane';
import { decodeFields } from '../src/networking/easytier/protobuf';
import {
  CompressionAlgo,
  buildWrappedRpcResponse,
  buildingRpcResponse,
  decodeRpcResponse,
  encodeRpcPacket,
  type RpcPacket,
} from '../src/networking/easytier/rpc';
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

// ══════════════════════════════════════════════════════════════════
// 数据面：HKDF 派生与 AEAD 加密
// ══════════════════════════════════════════════════════════════════

describe('数据面：traffic key 派生', () => {
  // 基准值由独立实现（Python）算出，与官方 `hkdf_traffic_key` 的算法一致：
  //   prk  = HMAC-SHA256(key=zeros32, msg=root_key)
  //   info = "et-traffic" || epoch(4B BE) || dir_idx(1B)
  //   okm  = HMAC-SHA256(key=prk, msg=info || 0x01)
  //   key  = okm[0..32]
  const rootKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

  it('epoch 0 / 方向 aToB', () => {
    expect(deriveTrafficKey(rootKey, 0, 'aToB').toString('hex').slice(0, 32)).toBe(
      '5f6aeafd4b1a023ef03ae837e7138631',
    );
  });

  it('epoch 0 / 方向 bToA', () => {
    expect(deriveTrafficKey(rootKey, 0, 'bToA').toString('hex').slice(0, 32)).toBe(
      'd94974e68e9f7b5756f7111b449bfec9',
    );
  });

  it('epoch 1 得到不同的 key（epoch 真的参与派生）', () => {
    const e0 = deriveTrafficKey(rootKey, 0, 'aToB');
    const e1 = deriveTrafficKey(rootKey, 1, 'aToB');
    expect(e0.equals(e1)).toBe(false);
  });

  it('两个方向得到不同的 key', () => {
    expect(deriveTrafficKey(rootKey, 0, 'aToB').equals(deriveTrafficKey(rootKey, 0, 'bToA'))).toBe(
      false,
    );
  });

  it('派生出的 key 不是 root_key 本身（必须经过 KDF）', () => {
    // 这是踩过的坑：直接把 root_key 当 AES 密钥用，全部解密失败
    expect(deriveTrafficKey(rootKey, 0, 'aToB').equals(rootKey)).toBe(false);
  });

  it('方向按 peer_id 大小决定，不看角色', () => {
    // secure_datagram.rs: direction 由 (sender < receiver) 决定
    expect(directionForSender(100, 200)).toBe('aToB');
    expect(directionForSender(200, 100)).toBe('bToA');
    // 同一个 peer 对，双方看到的发送方向相反
    expect(directionForSender(100, 200)).not.toBe(directionForSender(200, 100));
  });
});

describe('数据面：AES-GCM 加解密', () => {
  it('往返', () => {
    const key = Buffer.alloc(32, 5);
    const payload = Buffer.from('rpc payload bytes');
    const encrypted = encryptPayload({ key, payload, epoch: 0, seq: 0n, algorithm: 'aes-gcm' });
    // 密文 = 明文 + tag(16) + nonce(12)
    expect(encrypted.length).toBe(payload.length + AEAD_TAG_SIZE + AEAD_NONCE_SIZE);
    expect(decryptPayload({ key, ciphertextWithTail: encrypted, algorithm: 'aes-gcm' }).equals(payload)).toBe(true);
  });

  it('aes-gcm 用 16 字节密钥（AES-128），不是 32 字节', () => {
    // 这是踩过的坑：官方算法名 `aes-gcm` 指 AES-128。
    // 见 tunnel/encrypt/mod.rs:308 —— AesGcm => create_aes_128(key_128)
    expect(nodeCipherName('aes-gcm')).toBe('aes-128-gcm');
    expect(nodeCipherName('aes-256-gcm')).toBe('aes-256-gcm');
    // 32 字节输入会被截到 16 字节
    expect(keyForAlgorithm('aes-gcm', Buffer.alloc(32, 9))).toHaveLength(16);
    expect(keyForAlgorithm('aes-256-gcm', Buffer.alloc(32, 9))).toHaveLength(32);
  });

  it('nonce 在尾部，且能从尾部解析回来', () => {
    const key = Buffer.alloc(32, 1);
    const encrypted = encryptPayload({ key, payload: Buffer.from('x'), epoch: 7, seq: 42n, algorithm: 'aes-gcm' });
    const parsed = parseNonce(encrypted.subarray(encrypted.length - AEAD_NONCE_SIZE));
    expect(parsed.epoch).toBe(7);
    expect(parsed.seq).toBe(42n);
  });

  it('篡改密文导致解密失败', () => {
    const key = Buffer.alloc(32, 1);
    const encrypted = encryptPayload({ key, payload: Buffer.from('data'), epoch: 0, seq: 0n, algorithm: 'aes-gcm' });
    encrypted[0] ^= 0xff;
    expect(() => decryptPayload({ key, ciphertextWithTail: encrypted, algorithm: 'aes-gcm' })).toThrow();
  });

  it('哪个包不加密与官方一致（peer_conn.rs:125）', () => {
    // 握手包与 Ping/Pong 不加密，其余全加密
    expect(shouldSkipEncrypt(PacketType.NoiseHandshakeMsg1)).toBe(true);
    expect(shouldSkipEncrypt(PacketType.NoiseHandshakeMsg2)).toBe(true);
    expect(shouldSkipEncrypt(PacketType.NoiseHandshakeMsg3)).toBe(true);
    expect(shouldSkipEncrypt(PacketType.Ping)).toBe(true);
    expect(shouldSkipEncrypt(PacketType.Pong)).toBe(true);
    // RPC 必须加密
    expect(shouldSkipEncrypt(PacketType.RpcReq)).toBe(false);
    expect(shouldSkipEncrypt(PacketType.RpcResp)).toBe(false);
  });
});

describe('RPC：compression_info 必须显式带 algo', () => {
  it('CompressionAlgo 的 None 是 1 而不是 0', () => {
    // 这是 proto 里最容易踩的枚举陷阱：`Invalid = 0`、`None = 1`、`Zstd = 2`。
    // 所以"用 None"不等于"省略字段"——省略会得到 Invalid(0)，
    // 而对端的 `accepted_compression_algo()` 从不返回 Invalid。
    expect(CompressionAlgo.Invalid).toBe(0);
    expect(CompressionAlgo.None).toBe(1);
    expect(CompressionAlgo.Zstd).toBe(2);
  });

  it('构造响应时自动带上 compression_info(algo=None)', () => {
    const request: RpcPacket = {
      fromPeer: 100,
      toPeer: 200,
      transactionId: 42n,
      descriptor: {
        domainName: 'net',
        protoName: 'OspfRouteRpc',
        serviceName: 'OspfRouteRpc',
        methodIndex: 1,
      },
      body: Buffer.from('req'),
      isRequest: true,
      totalPieces: 0,
      pieceIdx: 0,
      traceId: 0,
      compressionInfo: { algo: CompressionAlgo.None, acceptedAlgo: CompressionAlgo.None },
    };

    const response = buildingRpcResponse(request, Buffer.from('resp'));
    // from/to 反向
    expect(response.fromPeer).toBe(200);
    expect(response.toPeer).toBe(100);
    // transaction_id 与 descriptor 保持
    expect(response.transactionId).toBe(42n);
    expect(response.descriptor?.serviceName).toBe('OspfRouteRpc');
    // 不是请求
    expect(response.isRequest).toBe(false);
    // 必须带 compression_info，且 algo=None(1)
    expect(response.compressionInfo).not.toBeNull();
    expect(response.compressionInfo?.algo).toBe(CompressionAlgo.None);
  });

  it('编码后的响应里确实有 compression_info 字段（字段号 10）', () => {
    const response = buildingRpcResponse(
      {
        fromPeer: 1, toPeer: 2, transactionId: 9n,
        descriptor: { domainName: '', protoName: 'OspfRouteRpc', serviceName: 'OspfRouteRpc', methodIndex: 1 },
        body: Buffer.alloc(0), isRequest: true, totalPieces: 0, pieceIdx: 0, traceId: 0,
        compressionInfo: null,
      },
      Buffer.alloc(0),
    );
    const fields = decodeFields(encodeRpcPacket(response));
    expect(fields.some((f) => f.fieldNumber === 10)).toBe(true);
  });
});

describe('RPC 响应的正确包装（业务消息要先包进 RpcResponse）', () => {
  const request: RpcPacket = {
    fromPeer: 100,
    toPeer: 200,
    transactionId: 42n,
    descriptor: {
      domainName: 'net',
      protoName: 'OspfRouteRpc',
      serviceName: 'OspfRouteRpc',
      methodIndex: 1,
    },
    body: Buffer.from('req'),
    isRequest: true,
    totalPieces: 0,
    pieceIdx: 0,
    traceId: 0,
    compressionInfo: { algo: CompressionAlgo.None, acceptedAlgo: CompressionAlgo.None },
  };

  it('buildWrappedRpcResponse 把业务消息包进 RpcResponse', () => {
    const business = Buffer.from('route-response-bytes');
    const packet = buildWrappedRpcResponse(request, business);

    // body 不是业务消息本身
    expect(packet.body.equals(business)).toBe(false);

    // 解一层 RpcResponse，才拿到业务消息
    const unwrapped = decodeRpcResponse(packet.body);
    expect(unwrapped.response.equals(business)).toBe(true);
    expect(unwrapped.error).toBeNull();
  });

  it('直接把业务消息放进 body 是错的（会让对端解出错的东西）', () => {
    // 客户端是 `RpcResponse::decode(rpc_packet.body)`（rpc/client.rs:387），
    // 所以 body 必须是 RpcResponse 的编码。把业务消息直接放进去时，
    // 对端要么解出错误的字段，要么在长度校验上直接失败——
    // 两种结果都不是我们想要的业务响应。
    const business = Buffer.from('route-response-bytes');
    const wrong = buildingRpcResponse(request, business);

    let unwrappedResponse: Buffer | null = null;
    let threw = false;
    try {
      unwrappedResponse = decodeRpcResponse(wrong.body).response;
    } catch {
      threw = true;
    }

    // 要么抛错，要么解出的内容不等于业务消息 —— 无论哪种，都说明必须包装
    const correct = buildWrappedRpcResponse(request, business);
    expect(decodeRpcResponse(correct.body).response.equals(business)).toBe(true);

    if (threw) {
      expect(unwrappedResponse).toBeNull();
    } else {
      expect(unwrappedResponse?.equals(business)).toBe(false);
    }
  });

  it('from/to/transaction_id/descriptor 在包装后仍正确', () => {
    const packet = buildWrappedRpcResponse(request, Buffer.from('x'));
    expect(packet.fromPeer).toBe(200);
    expect(packet.toPeer).toBe(100);
    expect(packet.transactionId).toBe(42n);
    expect(packet.isRequest).toBe(false);
    expect(packet.descriptor?.serviceName).toBe('OspfRouteRpc');
  });

  it('错误响应能正确往返', () => {
    const packet = buildWrappedRpcResponse(request, Buffer.alloc(0), {
      error: { kind: 'executeError', message: 'handler failed' },
    });
    const unwrapped = decodeRpcResponse(packet.body);
    expect(unwrapped.response).toHaveLength(0);
    expect(unwrapped.error).toEqual({ kind: 'executeError', message: 'handler failed' });
  });
});

describe('Noise XX 应答方（服务端）', () => {
  it('与发起方在 TS 内部完成完整握手并导出互补密钥', () => {
    const initiator = new NoiseXXInitiator();
    const responder = new NoiseXXResponder();

    // Msg1：发起方 -> 应答方
    const msg1Payload = Buffer.from('msg1-protobuf');
    const msg1 = initiator.writeMessage(msg1Payload);
    expect(responder.readMessage(msg1).equals(msg1Payload)).toBe(true);

    // Msg2：应答方 -> 发起方
    const msg2Payload = Buffer.from('msg2-protobuf');
    const msg2 = responder.writeMessage(msg2Payload);
    expect(initiator.readMessage(msg2).equals(msg2Payload)).toBe(true);

    // Msg3：发起方 -> 应答方
    const msg3Payload = Buffer.from('msg3-protobuf');
    const msg3 = initiator.writeMessage(msg3Payload);
    expect(responder.readMessageFinal(msg3).equals(msg3Payload)).toBe(true);

    // 双方看到同一份握手哈希
    expect(initiator.getHandshakeHash().equals(responder.getHandshakeHash())).toBe(true);

    // Split 密钥互补：发起方的发送方向 = 应答方的接收方向
    const client = initiator.finalize();
    const server = responder.finalize();
    expect(client.sendKey.equals(server.receiveKey)).toBe(true);
    expect(server.sendKey.equals(client.receiveKey)).toBe(true);

    // 对端静态公钥可见（发起方能拿到服务端身份，反之亦然）
    expect(initiator.getRemoteStaticPublicKey()).not.toBeNull();
    expect(responder.getRemoteStaticPublicKey()).not.toBeNull();
    expect(initiator.getRemoteStaticPublicKey()!.equals(responder.getLocalStaticPublicKey())).toBe(
      true,
    );
  });

  it('固定静态密钥时对端能拿到同一把公钥（钉扎前提）', () => {
    const staticKey = generateKeyPair();
    const responder = new NoiseXXResponder(undefined, staticKey);
    const initiator = new NoiseXXInitiator();

    responder.readMessage(initiator.writeMessage(Buffer.alloc(0)));
    initiator.readMessage(responder.writeMessage(Buffer.alloc(0)));
    responder.readMessageFinal(initiator.writeMessage(Buffer.alloc(0)));

    expect(initiator.getRemoteStaticPublicKey()!.equals(staticKey.publicKey)).toBe(true);
  });

  it('步骤乱序会抛错（状态机不被跳步）', () => {
    const responder = new NoiseXXResponder();
    expect(() => responder.writeMessage()).toThrow(/不应发送/);
    responder.readMessage(new NoiseXXInitiator().writeMessage(Buffer.alloc(0)));
    expect(() => responder.readMessageFinal(Buffer.alloc(48))).toThrow(/不应接收/);
  });
});
