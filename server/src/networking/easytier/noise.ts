/**
 * EasyTier 的 Noise 握手模型（TypeScript 侧）。
 *
 * 对照 `easytier-core/src/peers/conn/peer_conn.rs:785` 的
 * `do_noise_handshake_as_client`。
 *
 * ## 已核实的握手参数
 *
 * | 项 | 值 | 源码位置 |
 * | --- | --- | --- |
 * | 握手模式 | `Noise_XX_25519_ChaChaPoly_SHA256` | `peer_conn.rs:788` |
 * | prologue | `easytier-peerconn-noise` | `peer_conn.rs:786` |
 * | 消息 | Msg1 / Msg2 / Msg3 三个包 | `PeerConnNoiseMsg1Pb` 等 |
 * | Msg1 载荷 | version + network_name + session_generation + conn_id + 加密算法 + features | `peer_conn.rs:810-818` |
 *
 * ## 这个模块的定位
 *
 * 它把"握手需要哪些参数、每个参数从哪来"显式固化下来，供两条路径共用：
 * - 原生模块（Rust）：参数由 Rust 侧自己组，这里只作为对照基准
 * - TypeScript 备用实现：直接产生这些参数
 *
 * 更重要的是**可测试**：Noise 参数写错一个字符（例如模式名拼错、prologue 不一致）
 * 在两台机器上表现为握手超时，极难定位。这里用断言把字符串钉死。
 */

import { randomBytes } from 'node:crypto';

/** 握手模式。拼错一个字符就会握手超时且没有任何提示。 */
export const NOISE_PATTERN = 'Noise_XX_25519_ChaChaPoly_SHA256';

/**
 * prologue。Noise 用它在握手哈希里混入应用层上下文，
 * 双方不一致时握手在第二步就会失败。
 */
export const NOISE_PROLOGUE = Buffer.from('easytier-peerconn-noise', 'utf8');

/** XX 模式下 X25519 静态公钥长度。 */
export const X25519_PUBLIC_KEY_BYTES = 32;

/** ChaChaPoly 的认证标签长度（每个加密消息尾部）。 */
export const CHACHPOLY_TAG_BYTES = 16;

export interface HandshakeParams {
  pattern: string;
  prologue: Buffer;
  /** 本地静态密钥对。snow 默认要求 32 字节私钥 */
  localPrivateKey: Buffer;
  /** 可选的对端公钥钉扎，用于防止中间人 */
  pinnedRemotePublicKey: Buffer | null;
}

/**
 * 生成握手参数。
 *
 * `pinnedRemotePublicKey` 对应 Rust 侧的 `get_pinned_remote_static_pubkey_b64()`：
 * 配置里给了 `peer_public_key` 时用它做钉扎，否则走纯 XX 模式（无钉扎）。
 */
export function createHandshakeParams(options?: {
  localPrivateKey?: Buffer;
  pinnedRemotePublicKey?: Buffer | null;
}): HandshakeParams {
  const key = options?.localPrivateKey ?? randomBytes(X25519_PUBLIC_KEY_BYTES);
  if (key.length !== X25519_PUBLIC_KEY_BYTES) {
    throw new Error(
      `X25519 私钥必须是 ${X25519_PUBLIC_KEY_BYTES} 字节，实际 ${key.length} 字节`,
    );
  }
  const pinned = options?.pinnedRemotePublicKey ?? null;
  if (pinned !== null && pinned.length !== X25519_PUBLIC_KEY_BYTES) {
    throw new Error(
      `钉扎的对端公钥必须是 ${X25519_PUBLIC_KEY_BYTES} 字节，实际 ${pinned.length} 字节`,
    );
  }
  return {
    pattern: NOISE_PATTERN,
    prologue: NOISE_PROLOGUE,
    localPrivateKey: key,
    pinnedRemotePublicKey: pinned,
  };
}

/**
 * 握手第一步的载荷（`PeerConnNoiseMsg1Pb`）。
 *
 * 字段名保持与 proto 一致，便于对照；`connId` 是 UUID v4。
 */
export interface NoiseMsg1 {
  version: string;
  networkName: string;
  sessionGeneration: number | null;
  connId: string;
  /** 加密算法标识，由各自配置决定；null 表示用默认 */
  clientEncryptionAlgorithm: string | null;
  features: string[];
}

/**
 * `LIVENESS_ECHO_FEATURE`。Rust 侧在 Msg1 里固定带上它，
 * 表示本节点支持 liveness echo。漏掉不影响握手成功，
 * 但会让对端不做回声探测，表现为延迟统计缺失。
 */
export const LIVENESS_ECHO_FEATURE = 'liveness_echo';

export function createNoiseMsg1(input: {
  version: string;
  networkName: string;
  sessionGeneration?: number | null;
  encryptionAlgorithm?: string | null;
}): NoiseMsg1 {
  if (input.networkName.trim() === '') {
    throw new Error('networkName 不能为空——它是网络隔离的依据');
  }
  return {
    version: input.version,
    networkName: input.networkName,
    sessionGeneration: input.sessionGeneration ?? null,
    connId: randomUUIDv4(),
    clientEncryptionAlgorithm: input.encryptionAlgorithm ?? null,
    // 与 Rust 侧一致：固定带上 liveness echo 能力
    features: [LIVENESS_ECHO_FEATURE],
  };
}

/**
 * 生成 UUID v4。
 *
 * 用 `node:crypto.randomUUID` 而不是自己拼——手拼的 UUID 很容易漏掉
 * 版本位与变体位，`Uuid::from` 在 Rust 侧可能仍然接受，
 * 但会让 `conn_id` 的语义变得不明确。
 */
function randomUUIDv4(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  return randomUUID();
}
