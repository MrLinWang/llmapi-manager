/**
 * 数据面加密（AES-256-GCM）。
 *
 * 对照 `easytier-core/src/tunnel/encrypt/aes_gcm.rs:89` 与
 * `tunnel/secure_datagram.rs:690`。
 *
 * ## 帧格式
 *
 * ```
 * payload' = AES-256-GCM(明文 payload, nonce, aad=空)
 * 线上字节 = payload' || tag(16B) || nonce(12B)
 * ```
 *
 * 且发送时把 `PeerManagerHeader` 的 `ENCRYPTED` 标志置位。
 *
 * ## nonce 的构成
 *
 * nonce 12 字节 = `epoch(4B, 大端) || seq(8B, 大端)`，由
 * `secure_datagram.rs:698` 的 `next_nonce` 产生，解密时从尾部读回
 * （`:718-719`）。所以接收方不需要自己维护计数器——这是设计上的便利，
 * 但代价是 nonce 在线上明文可见（AEAD 的安全性不依赖 nonce 保密，
 * 只要求不重复）。
 *
 * ## 方向
 *
 * `SecureDatagramDirection` 按 **peer_id 大小**决定（`peer_session.rs:360`）：
 * 发送方 id 小则是 AToB，否则 BToA。这**不是**按"客户端/服务端"分的——
 * 两个方向各有独立的密钥与序列号空间，用错方向会解密失败。
 *
 * ## 哪些包不加密
 *
 * `peer_conn.rs:125` 的 `should_skip_encrypt`：三个 Noise 握手包、
 * 两个 Relay 握手包、Ping、Pong。其余全部加密。
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';

/** 认证标签长度。对照 `packet/mod.rs:346` 的 `AeadTail<16, 12>`。 */
export const AEAD_TAG_SIZE = 16;

/** nonce 长度。 */
export const AEAD_NONCE_SIZE = 12;

/** 尾部总长度 = tag + nonce。 */
export const AEAD_TAIL_SIZE = AEAD_TAG_SIZE + AEAD_NONCE_SIZE;

/**
 * 由 epoch 与 seq 构造 nonce。
 *
 * 都是**大端**（`secure_datagram.rs:718-719` 用 `from_be_bytes` 读回）。
 */
export function buildNonce(epoch: number, seq: bigint): Buffer {
  const nonce = Buffer.alloc(AEAD_NONCE_SIZE);
  nonce.writeUInt32BE(epoch >>> 0, 0);
  nonce.writeBigUInt64BE(seq, 4);
  return nonce;
}

/** 从 nonce 解出 epoch 与 seq。 */
export function parseNonce(nonce: Buffer): { epoch: number; seq: bigint } {
  if (nonce.length !== AEAD_NONCE_SIZE) {
    throw new Error(`nonce 必须是 ${AEAD_NONCE_SIZE} 字节，实际 ${nonce.length}`);
  }
  return {
    epoch: nonce.readUInt32BE(0),
    seq: nonce.readBigUInt64BE(4),
  };
}

/**
 * 加密一个载荷。
 *
 * 返回 `密文 || tag || nonce`，与官方 `StandardAeadTail` 的布局一致。
 *
 * 注意 AAD 是**空**（`aes_gcm.rs:114` 传的 `&[]`）——不是包头，也不是 nonce。
 * 这一点容易想当然：很多 AEAD 用法会把头部当 AAD 以防篡改，
 * 这里官方没有这么做。加错了会导致对端解密失败。
 */
export function encryptPayload(options: {
  key: Buffer;
  payload: Buffer;
  epoch: number;
  seq: bigint;
  /** 加密算法名。默认 aes-gcm（= AES-128-GCM，见下） */
  algorithm?: string;
}): Buffer {
  const algorithm = options.algorithm ?? 'aes-gcm';
  const nodeAlgorithm = nodeCipherName(algorithm);
  const key = keyForAlgorithm(algorithm, options.key);
  const nonce = buildNonce(options.epoch, options.seq);

  const cipher = createCipheriv(nodeAlgorithm, key, nonce, {
    authTagLength: AEAD_TAG_SIZE,
  });
  // 官方用空 AAD；不设 setAAD 等同于空
  const body = Buffer.concat([cipher.update(options.payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([body, tag, nonce]);
}

/**
 * 解密一个载荷。
 *
 * 输入是 `密文 || tag || nonce`（线上格式）。
 * nonce 从尾部读，所以调用方不需要自己跟踪计数器。
 */
export function decryptPayload(options: {
  key: Buffer;
  ciphertextWithTail: Buffer;
  /** 加密算法名。默认 aes-gcm（= AES-128-GCM，见下） */
  algorithm?: string;
}): Buffer {
  const algorithm = options.algorithm ?? 'aes-gcm';
  const nodeAlgorithm = nodeCipherName(algorithm);
  const key = keyForAlgorithm(algorithm, options.key);
  const data = options.ciphertextWithTail;
  if (data.length < AEAD_TAIL_SIZE) {
    throw new Error(
      `密文太短（${data.length} 字节），至少要能装下 tag(${AEAD_TAG_SIZE}) + nonce(${AEAD_NONCE_SIZE})`,
    );
  }

  const nonce = data.subarray(data.length - AEAD_NONCE_SIZE);
  const tag = data.subarray(data.length - AEAD_TAIL_SIZE, data.length - AEAD_NONCE_SIZE);
  const body = data.subarray(0, data.length - AEAD_TAIL_SIZE);

  const decipher = createDecipheriv(nodeAlgorithm, key, nonce, {
    authTagLength: AEAD_TAG_SIZE,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * 算法名 → Node 的 cipher 名。
 *
 * **这里有个大坑**：官方算法名 `aes-gcm` 指的是 **AES-128-GCM**，
 * 而 `aes-256-gcm` 才是 AES-256。这一点在
 * `tunnel/encrypt/mod.rs:306-311` 里写得很清楚：
 *
 * ```rust
 * EncryptionAlgorithm::AesGcm => create_aes_128(key_128),      // 用 key[..16]
 * EncryptionAlgorithm::Aes256Gcm => create_aes_256(key_256),   // 用完整 32 字节
 * ```
 *
 * 我一开始假定 32 字节 root_key 就意味着 AES-256，结果所有候选密钥都
 * "解不开"——因为密钥长度与算法都错了。
 */
export function nodeCipherName(algorithm: string): 'aes-128-gcm' | 'aes-256-gcm' {
  switch (algorithm) {
    case 'aes-256-gcm':
      return 'aes-256-gcm';
    case 'aes-gcm':
      return 'aes-128-gcm';
    default:
      throw new Error(
        `不支持的加密算法 "${algorithm}"。本实现只支持 aes-gcm（AES-128）与 aes-256-gcm；` +
          'chacha20 / xor 见 easytier 的 encrypt 模块，需要额外实现。',
      );
  }
}

/** 按算法取对应长度的密钥：aes-gcm 取前 16 字节。 */
export function keyForAlgorithm(algorithm: string, key: Buffer): Buffer {
  if (algorithm === 'aes-gcm') {
    if (key.length < 16) throw new Error(`aes-gcm 需要至少 16 字节密钥，实际 ${key.length}`);
    return key.subarray(0, 16);
  }
  if (algorithm === 'aes-256-gcm') {
    if (key.length !== 32) throw new Error(`aes-256-gcm 需要 32 字节密钥，实际 ${key.length}`);
    return key;
  }
  throw new Error(`不支持的加密算法 "${algorithm}"`);
}

/** 包类型是否跳过加密（`peer_conn.rs:125` 的 `should_skip_encrypt`）。 */
export function shouldSkipEncrypt(packetType: number): boolean {
  // NoiseHandshakeMsg1/2/3 = 13/14/15, RelayHandshake/Ack = 20/21, Ping/Pong = 4/5
  return [13, 14, 15, 20, 21, 4, 5].includes(packetType);
}

/**
 * 会话方向。按 peer_id 大小决定，**不是**按客户端/服务端角色。
 *
 * 对照 `peer_session.rs:352-364` 的 `dir_for_sender`。
 */
export type SecureDirection = 'aToB' | 'bToA';

export function directionForSender(senderPeerId: number, receiverPeerId: number): SecureDirection {
  return senderPeerId < receiverPeerId ? 'aToB' : 'bToA';
}

/**
 * 一路方向的收发密钥。
 *
 * Noise 的 `Split()` 给出两个密钥，但 EasyTier 的数据面并不是直接用它们——
 * 它用 Msg2 里传的 `root_key_32` 作为根密钥，再按 epoch/direction 派生。
 *
 * 本实现简化处理：直接把 `root_key` 当作 AES 密钥用（因为
 * `SecureDatagramSession::new` 收的就是 32 字节 root_key，
 * 而 `get_or_create_encryptor` 在 epoch 0 时用的也是它）。
 *
 * **这是当前实现的已知简化**：如果对端在多 epoch 之间切换（密钥轮换），
 * 本实现不会跟随。单次短会话的场景够用。
 */
export interface DirectionalKeys {
  /** 我发出去用的密钥 */
  send: Buffer;
  /** 我收进来用的密钥 */
  receive: Buffer;
}

/**
 * 秘钥派生的 "info" 前缀。对照 `secure_datagram.rs:399`。
 *
 * 这个字符串是**硬编码在官方实现里的**，改动会直接导致解密失败。
 */
export const TRAFFIC_KEY_INFO_PREFIX = Buffer.from('et-traffic', 'utf8');

/**
 * 派生某个方向、某个 epoch 的实际加密密钥。
 *
 * 对照 `secure_datagram.rs:391` 的 `hkdf_traffic_key`：
 *
 * ```
 * prk  = HMAC-SHA256(key = 32 字节全零盐, msg = root_key)     // HKDF-extract
 * info = "et-traffic" || epoch(4B 大端) || dir_idx(1B)
 * okm  = HMAC-SHA256(key = prk, msg = info || 0x01)           // HKDF-expand 第一块
 * key  = okm[0..32]
 * ```
 *
 * **中间踩过的坑**：我一开始直接把 `root_key` 当 AES 密钥用，
 * 三个候选（root_key / split 的两个 key）全部解密失败。原因就是漏了这层派生
 * ——`root_key` 只是"根"，每个方向每个 epoch 都有各自的 traffic key。
 *
 * 注意 expand 只做一轮（`0x01` 是块索引），因为 32 字节正好一个 SHA256 输出。
 */
export function deriveTrafficKey(rootKey: Buffer, epoch: number, direction: SecureDirection): Buffer {
  if (rootKey.length !== 32) {
    throw new Error(`root_key 必须是 32 字节，实际 ${rootKey.length}`);
  }

  // HKDF-extract：盐为 32 字节零
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');
  const prk = createHmac('sha256', Buffer.alloc(32)).update(rootKey).digest();

  // HKDF-expand：info 里混入 epoch 与方向
  const info = Buffer.concat([
    TRAFFIC_KEY_INFO_PREFIX,
    Buffer.from([(epoch >>> 24) & 0xff, (epoch >>> 16) & 0xff, (epoch >>> 8) & 0xff, epoch & 0xff]),
    Buffer.from([direction === 'aToB' ? 0 : 1]),
  ]);
  const okm = createHmac('sha256', prk).update(info).update(Buffer.from([0x01])).digest();

  return okm.subarray(0, 32);
}

/**
 * 从 Noise 的 Split 结果与 root_key 推导双向密钥。
 *
 * 优先用 Msg2 里的 `root_key_32`（官方 `SecureDatagramSession` 实际使用的根）。
 * 两个方向各有独立 traffic key，按 peer_id 大小决定谁是 aToB。
 */
export function deriveDirectionalKeys(options: {
  myPeerId: number;
  remotePeerId: number;
  rootKey: Buffer | null;
  splitKeys: { sendKey: Buffer; receiveKey: Buffer };
  epoch?: number;
}): DirectionalKeys {
  const epoch = options.epoch ?? 0;
  if (options.rootKey !== null && options.rootKey.length === 32) {
    // 我发送时的方向：由"我"作为发送方决定
    const sendDir = directionForSender(options.myPeerId, options.remotePeerId);
    // 我接收时的方向：由"对端"作为发送方决定
    const receiveDir = directionForSender(options.remotePeerId, options.myPeerId);
    return {
      send: deriveTrafficKey(options.rootKey, epoch, sendDir),
      receive: deriveTrafficKey(options.rootKey, epoch, receiveDir),
    };
  }
  return { send: options.splitKeys.sendKey, receive: options.splitKeys.receiveKey };
}
