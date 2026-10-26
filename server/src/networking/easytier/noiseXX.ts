/**
 * Noise_XX_25519_ChaChaPoly_SHA256 的实现（TypeScript）。
 *
 * 对照 Noise Protocol Framework 规范（revision 34）与 EasyTier 的参数选择
 * （`peer_conn.rs:788`、prologue 在 `:786`）。
 *
 * ## 为什么自己实现而不引库
 *
 * Node 生态里的 Noise 库都是围绕 TCP/TLS 传输场景设计的，接口形如
 * "给一个 socket，我帮你握手完"。而这里需要的是**手动逐步驱动**：
 * 每一步的消息要走 EasyTier 自己的 `PeerManagerHeader` 封装，
 * 中间还要取 `get_handshake_hash()` 做 `secret_proof`。
 * 这种用法与那些库的抽象不匹配，自己按规范实现反而更直接。
 *
 * 所有原语都用 `node:crypto`（OpenSSL），**不自己写密码学**：
 * - X25519 ECDH：`diffieHellman()`
 * - ChaCha20-Poly1305：`createCipheriv('chacha20-poly1305')`
 * - SHA256 / HMAC：`createHash` / `createHmac`
 *
 * ## XX 模式的消息流
 *
 * ```
 * -> e                          (32 字节)
 * <- e, ee, s, es                (96 字节)
 * -> s, se                       (64 字节)
 * ```
 *
 * 小写是临时密钥，大写是静态密钥；`ee` 表示"两个临时密钥做 DH"，
 * 依此类推。XX 的特点是**双方静态公钥都是加密传输的**（在后两条消息里），
 * 所以能提供身份隐藏——中间人看不到谁在连谁。
 *
 * ## 长度为什么是 32/96/64
 *
 * - Msg1 = e(32)
 * - Msg2 = e(32) + s(32) + tag(16) + tag(16) = 96
 * - Msg3 = s(32) + tag(16) + tag(16) = 64
 *
 * 这三个数值已被官方实现实测确认（`easytierOracle` 里跑过完整三轮）。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto';

/** Noise 参数。与官方一致，改一个字符就握不上手。 */
export const NOISE_PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256';

/** prologue。双方不一致时在第二条消息就失败，且错误不说原因。 */
export const NOISE_PROLOGUE = Buffer.from('easytier-peerconn-noise', 'utf8');

/** ChaChaPoly 认证标签长度。 */
const TAG_SIZE = 16;

/** X25519 公钥/私钥长度。 */
const KEY_SIZE = 32;

/** SHA256 输出长度。 */
const HASH_SIZE = 32;

/** HKDF（RFC 5869）——Noise 用 HKDF-SHA256 派生密钥。 */
function hkdf(chainingKey: Buffer, ikm: Buffer, numOutputs: 2 | 3): Buffer[] {
  // Noise 的 HKDF 与 RFC 5869 的 extract-then-expand 一致，
  // 盐是 chaining key、输入密钥材料是 ikm。
  const output = Buffer.from(hkdfSync('sha256', ikm, chainingKey, Buffer.alloc(0), numOutputs * HASH_SIZE) as ArrayBuffer);
  return Array.from({ length: numOutputs }, (_, i) =>
    output.subarray(i * HASH_SIZE, (i + 1) * HASH_SIZE),
  );
}

/** X25519 原始私钥 → KeyObject（PKCS#8 封装，同 credential.ts 的做法）。 */
function x25519PrivateKeyObject(raw: Buffer) {
  const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** X25519 原始私钥 → 公钥。 */
function x25519PublicFromPrivate(raw: Buffer): Buffer {
  const pub = createPublicKey(x25519PrivateKeyObject(raw));
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string') throw new Error('X25519 公钥导出失败');
  return Buffer.from(jwk.x, 'base64url');
}

/** X25519 原始公钥 → KeyObject（SPKI DER 封装）。 */
function x25519PublicKeyObject(raw: Buffer) {
  if (raw.length !== KEY_SIZE) {
    throw new Error(`X25519 公钥必须是 ${KEY_SIZE} 字节，实际 ${raw.length}`);
  }
  const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** 生成 X25519 密钥对（原始 32 字节）。 */
export function generateKeyPair(): { privateKey: Buffer; publicKey: Buffer } {
  // Node 的类型定义里 `generateKeyPairSync` 的重载比较窄，
  // 但运行时 `'x25519'` 是合法参数（ED25519/X25519 都支持）。
  const pair = generateKeyPairSync('x25519');
  const privateKey = pair.privateKey as import('node:crypto').KeyObject;
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  if (typeof jwk.d !== 'string') throw new Error('X25519 私钥导出失败');
  const raw = Buffer.from(jwk.d, 'base64url');
  return { privateKey: raw, publicKey: x25519PublicFromPrivate(raw) };
}

/** 计算 X25519 共享密钥。 */
function dh(privateKey: Buffer, publicKey: Buffer): Buffer {
  return Buffer.from(diffieHellman({ privateKey: x25519PrivateKeyObject(privateKey), publicKey: x25519PublicKeyObject(publicKey) }));
}

/** ChaCha20-Poly1305 加密（返回 密文||tag）。 */
export function encryptWithAd(key: Buffer, nonce: Buffer, plaintext: Buffer, ad: Buffer): Buffer {
  // Noise 的 nonce 是 8 字节，但 ChaChaPoly 要 12 字节（前 4 字节为零）。
  const iv = Buffer.concat([Buffer.alloc(4), nonce]);
  const cipher = createCipheriv('chacha20-poly1305', key, iv, { authTagLength: TAG_SIZE });
  cipher.setAAD(ad, { plaintextLength: plaintext.length });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

/** ChaCha20-Poly1305 解密（输入 密文||tag）。 */
export function decryptWithAd(key: Buffer, nonce: Buffer, ciphertext: Buffer, ad: Buffer): Buffer {
  if (ciphertext.length < TAG_SIZE) throw new Error('密文太短，缺少认证标签');
  const iv = Buffer.concat([Buffer.alloc(4), nonce]);
  const tag = ciphertext.subarray(ciphertext.length - TAG_SIZE);
  const body = ciphertext.subarray(0, ciphertext.length - TAG_SIZE);
  const decipher = createDecipheriv('chacha20-poly1305', key, iv, { authTagLength: TAG_SIZE });
  decipher.setAAD(ad, { plaintextLength: body.length });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Noise 握手的内部状态。 */
interface SymmetricState {
  chainingKey: Buffer;
  hash: Buffer;
  cipherKey: Buffer | null;
  nonce: number;
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** 把数据混入 handshake hash。 */
function mixHash(state: SymmetricState, data: Buffer): void {
  state.hash = sha256(Buffer.concat([state.hash, data]));
}

/** 把密钥材料混入 chaining key，并派生新的 cipher key。 */
function mixKey(state: SymmetricState, ikm: Buffer): void {
  const [ck, tempK] = hkdf(state.chainingKey, ikm, 2);
  state.chainingKey = ck;
  state.cipherKey = tempK;
  state.nonce = 0;
}

/** 加密并混入哈希（Noise 的 encryptAndHash）。 */
function encryptAndHash(state: SymmetricState, plaintext: Buffer): Buffer {
  if (state.cipherKey === null) {
    // 未协商密钥时明文传输，但仍混入哈希
    mixHash(state, plaintext);
    return plaintext;
  }
  const nonce = Buffer.alloc(8);
  nonce.writeBigUInt64LE(BigInt(state.nonce));
  const ciphertext = encryptWithAd(state.cipherKey, nonce, plaintext, state.hash);
  state.nonce += 1;
  mixHash(state, ciphertext);
  return ciphertext;
}

/** 解密并按哈希校验（Noise 的 decryptAndHash）。 */
function decryptAndHash(state: SymmetricState, ciphertext: Buffer): Buffer {
  if (state.cipherKey === null) {
    mixHash(state, ciphertext);
    return ciphertext;
  }
  const nonce = Buffer.alloc(8);
  nonce.writeBigUInt64LE(BigInt(state.nonce));
  const plaintext = decryptWithAd(state.cipherKey, nonce, ciphertext, state.hash);
  state.nonce += 1;
  mixHash(state, ciphertext);
  return plaintext;
}

/**
 * XX 模式的发起方（客户端）。
 *
 * 用法：
 * ```
 * const client = new NoiseXXInitiator(prologue);
 * const msg1 = client.writeMessage();          // 发给对端
 * client.readMessage(msg2);                    // 读对端第二条
 * const msg3 = client.writeMessage();          // 发给对端，握手完成
 * const { sendKey, receiveKey } = client.finalize();
 * ```
 */
export class NoiseXXInitiator {
  private readonly state: SymmetricState;
  private readonly ephemeralPrivate: Buffer;
  private readonly ephemeralPublic: Buffer;
  private readonly staticPrivate: Buffer;
  private readonly staticPublic: Buffer;
  private step = 0;

  constructor(
    prologue: Buffer = NOISE_PROLOGUE,
    staticKeyPair?: { privateKey: Buffer; publicKey: Buffer },
  ) {
    const kp = staticKeyPair ?? generateKeyPair();
    this.staticPrivate = kp.privateKey;
    this.staticPublic = kp.publicKey;

    const eph = generateKeyPair();
    this.ephemeralPrivate = eph.privateKey;
    this.ephemeralPublic = eph.publicKey;

    // 初始化：h = HASH(protocol_name padded), ck = h
    const protocolName = Buffer.from(NOISE_PROTOCOL_NAME, 'utf8');
    const padded = Buffer.concat([protocolName, Buffer.alloc(Math.max(0, 32 - protocolName.length))]);
    const initialHash = protocolName.length <= 32 ? padded : sha256(protocolName);

    this.state = {
      chainingKey: Buffer.from(initialHash),
      hash: Buffer.from(initialHash),
      cipherKey: null,
      nonce: 0,
    };

    // 混入 prologue：h = HASH(h || prologue)
    mixHash(this.state, prologue);
  }

  /** 当前握手哈希（用于 `secret_proof`）。 */
  getHandshakeHash(): Buffer {
    return this.state.hash;
  }

  /** 我方静态公钥（握手完成后可用来做钉扎校验）。 */
  getLocalStaticPublicKey(): Buffer {
    return this.staticPublic;
  }

  /**
   * 生成下一条要发送的消息。
   *
   * 第 1 条：`-> e`
   * 第 2 条（内部第 2 次调用）：`-> s, se`
   */
  writeMessage(payload: Buffer = Buffer.alloc(0)): Buffer {
    if (this.step === 0) {
      // -> e
      this.step = 1;
      const parts: Buffer[] = [this.ephemeralPublic];
      mixHash(this.state, this.ephemeralPublic);

      // XX 模式第一轮没有 DH（还不知道对端的 e）

      parts.push(this.encryptPayload(payload));
      return Buffer.concat(parts);
    }

    if (this.step === 2) {
      // -> s, se
      this.step = 3;
      const parts: Buffer[] = [];

      // 加密我方静态公钥
      const encStatic = this.encryptAndHashLocal(this.staticPublic);
      parts.push(encStatic);

      // se：我方静态 × 对端临时
      const se = dh(this.staticPrivate, this.remoteEphemeral!);
      mixKey(this.state, se);

      parts.push(this.encryptPayload(payload));
      return Buffer.concat(parts);
    }

    throw new Error(`Noise XX 发起方在步骤 ${this.step} 不应发送消息`);
  }

  private remoteEphemeral: Buffer | null = null;

  /**
   * 处理对端发来的消息。
   *
   * 第 1 条（对端的 msg2）：`<- e, ee, s, es`
   */
  readMessage(message: Buffer): Buffer {
    if (this.step !== 1) {
      throw new Error(`Noise XX 发起方在步骤 ${this.step} 不应接收消息`);
    }

    let offset = 0;

    // e（对端临时公钥）
    this.remoteEphemeral = message.subarray(offset, offset + KEY_SIZE);
    offset += KEY_SIZE;
    mixHash(this.state, this.remoteEphemeral);

    // ee：我方临时 × 对端临时
    const ee = dh(this.ephemeralPrivate, this.remoteEphemeral);
    mixKey(this.state, ee);

    // s（对端静态公钥，加密传输）
    const encStatic = message.subarray(offset, offset + KEY_SIZE + TAG_SIZE);
    offset += KEY_SIZE + TAG_SIZE;
    this.remoteStatic = this.decryptAndHashLocal(encStatic);

    // es：我方临时 × 对端静态
    const es = dh(this.ephemeralPrivate, this.remoteStatic);
    mixKey(this.state, es);

    // payload
    const rest = message.subarray(offset);
    const payload = rest.length > 0 ? this.decryptAndHashLocal(rest) : Buffer.alloc(0);

    this.step = 2;
    return payload;
  }

  private remoteStatic: Buffer | null = null;

  /** 对端静态公钥（握手完成后用于钉扎校验）。 */
  getRemoteStaticPublicKey(): Buffer | null {
    return this.remoteStatic;
  }

  /**
   * 握手完成，导出双向密钥。
   *
   * Noise 的 `Split()`：从 chaining key 派生两个 key，
   * 一个用于发送、一个用于接收（方向相反，避免nonce 重用）。
   */
  finalize(): { sendKey: Buffer; receiveKey: Buffer } {
    if (this.step !== 3) {
      throw new Error(`Noise XX 握手未完成（步骤 ${this.step}）`);
    }
    const [k1, k2] = hkdf(this.state.chainingKey, Buffer.alloc(0), 2);
    // 发起方：k1 用于发送，k2 用于接收
    return { sendKey: k1, receiveKey: k2 };
  }

  private encryptAndHashLocal(plaintext: Buffer): Buffer {
    return encryptAndHash(this.state, plaintext);
  }

  private decryptAndHashLocal(ciphertext: Buffer): Buffer {
    return decryptAndHash(this.state, ciphertext);
  }

  private encryptPayload(payload: Buffer): Buffer {
    return encryptAndHash(this.state, payload);
  }
}
