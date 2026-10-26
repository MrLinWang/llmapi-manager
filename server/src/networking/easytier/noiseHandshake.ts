/**
 * EasyTier 的 Noise 握手（握手之后的三阶段密钥协商）。
 *
 * 对照 `easytier-core/src/peers/conn/peer_conn.rs:785` 起的
 * `do_noise_handshake_as_client` / `do_noise_handshake_as_server`。
 *
 * ## 与明文握手的区别（容易混淆，务必分清）
 *
 * 完整建连有**两层**握手：
 *
 * ```
 * ① 明文 HandshakeRequest/Response   ← 确认网络名与密钥摘要
 * ② Noise XX 三阶段                  ← 协商加密密钥、验证持有密钥
 * ③ 数据面（加密帧）                  ← 实际传数据
 * ```
 *
 * 这两层是独立的消息序列。`handshake.ts` 管第 ①层，本文件管第 ②层。
 * 早先实测通过的"与官方节点握手成功"只到第 ①层结束——那时候还不能传数据。
 *
 * ## Noise 参数（已实测可跑通）
 *
 * - 模式：`Noise_XX_25519_ChaChaPoly_SHA256`
 * - prologue：`easytier-peerconn-noise`
 * - 三轮：Msg1(32B) → Msg2(96B) → Msg3(64B)
 *
 * 这三个长度是 XX 模式的固定结构，可作为参数被正确解析的旁证。
 *
 * ## 消息内容
 *
 * 每轮的 protobuf **先被 Noise 加密**，再塞进 `PeerManagerHeader` 的载荷：
 *
 * ```
 * payload = hs.write_message(protobuf_bytes)
 * packet  = PeerManagerHeader{type=NoiseHandshakeMsgN} || payload
 * ```
 *
 * （`peer_conn.rs:676-684`）
 */

import { createHmac } from 'node:crypto';
import {
  decodeFields,
  encodeBytesField,
  encodeStringField,
  encodeVarintField,
  getAllBytes,
  getBytes,
  getVarint,
} from './protobuf';

/**
 * `secret_proof` 的前缀。
 *
 * 对照 `context.rs:41` 的 `SECRET_PROOF_PREFIX`。
 * 与凭证的 `"easytier credential proof"` 是**两个不同的前缀**，
 * 用错会导致对端验证失败却只报"proof mismatch"。
 */
export const SECRET_PROOF_PREFIX = Buffer.from('easytier secret proof', 'utf8');

/**
 * 计算 `secret_proof`。
 *
 * ```
 * HMAC-SHA256(key = network_secret, msg = "easytier secret proof" || handshake_hash)
 * ```
 *
 * `handshake_hash` 是 Noise 握手进行到当时的哈希（`snow` 的
 * `get_handshake_hash()`），它绑定本次会话——所以 proof 无法被重放。
 *
 * 这一点是安全上的关键：如果只用 `HMAC(secret, 常量)`，抓包者可以重放。
 * 掺入会话哈希后，每次连接的 proof 都不同。
 */
export function secretProof(networkSecret: string, handshakeHash: Buffer): Buffer {
  return createHmac('sha256', Buffer.from(networkSecret, 'utf8'))
    .update(SECRET_PROOF_PREFIX)
    .update(handshakeHash)
    .digest();
}

/** 验证对端发来的 `secret_proof`。常数时间比较，避免时序侧信道。 */
export function verifySecretProof(
  networkSecret: string,
  handshakeHash: Buffer,
  remoteProof: Buffer,
): boolean {
  const expected = secretProof(networkSecret, handshakeHash);
  if (expected.length !== remoteProof.length) return false;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
  return timingSafeEqual(expected, remoteProof);
}

/**
 * `PeerConnNoiseMsg1Pb` 的字段号（`peer_rpc.proto:352`）。
 *
 * 客户端发出的第一步：声明版本、网络名、连接标识。
 */
export const NoiseMsg1Field = {
  version: 1,
  aNetworkName: 2,
  aSessionGeneration: 3,
  aConnId: 4,
  clientEncryptionAlgorithm: 5,
  features: 6,
} as const;

export interface NoiseMsg1 {
  version: number;
  aNetworkName: string;
  aSessionGeneration: number | null;
  /** UUID，用于把后续消息与这次连接对应起来 */
  aConnId: Uint8Array;
  clientEncryptionAlgorithm: string;
  features: string[];
}

/**
 * `common.UUID` 的编码。
 *
 * **这不是 16 字节的 bytes 字段**——`common.proto:170` 的定义是：
 *
 * ```proto
 * message UUID {
 *   uint32 part1 = 1;
 *   uint32 part2 = 2;
 *   uint32 part3 = 3;
 *   uint32 part4 = 4;
 * }
 * ```
 *
 * 也就是 4 个 uint32。我最初按"16 字节 bytes"实现，官方节点直接给出了
 * 精确报错：
 *
 * ```
 * DecodeError { description: UnexpectedWireType {
 *   actual: LengthDelimited, expected: Varint },
 *   stack: [("Uuid", "part1"), ("PeerConnNoiseMsg1Pb", "a_conn_id")] }
 * ```
 *
 * 这个错误信息质量很高——它指明了字段路径与 wire type 不匹配。
 * 值得记住：遇到 `UnexpectedWireType` 时，几乎总是把"结构"和"标量"
 * 搞混了（bytes vs uint32），而不是字段号写错。
 *
 * 16 字节 UUID 与这 4 个 uint32 的对应关系：按**大端**切成 4 段，
 * 与 Rust `uuid` crate 的 `as_u32` 语义一致。
 */
export function encodeUuid(uuid: Uint8Array): Buffer {
  if (uuid.length !== 16) {
    throw new Error(`UUID 必须是 16 字节，实际 ${uuid.length}`);
  }
  const view = Buffer.from(uuid);
  const parts: Buffer[] = [];
  for (let i = 0; i < 4; i += 1) {
    const part = view.readUInt32BE(i * 4);
    // proto3：0 不写（虽然实际几乎不会出现全零的一段）
    if (part !== 0) parts.push(encodeVarintField(i + 1, part));
  }
  // 全零 UUID 会编码成空 message，这是合法的
  return Buffer.concat(parts);
}

/** 解码 `common.UUID`（4 个 uint32 → 16 字节）。 */
export function decodeUuid(buffer: Buffer): Uint8Array {
  const fields = decodeFields(buffer);
  const out = Buffer.alloc(16);
  for (let i = 0; i < 4; i += 1) {
    out.writeUInt32BE(getVarint(fields, i + 1) ?? 0, i * 4);
  }
  return new Uint8Array(out);
}

/** 编码 `PeerConnNoiseMsg1Pb`。 */
export function encodeNoiseMsg1(msg: NoiseMsg1): Buffer {
  const parts: Buffer[] = [];

  if (msg.version !== 0) {
    parts.push(encodeVarintField(NoiseMsg1Field.version, msg.version));
  }
  if (msg.aNetworkName !== '') {
    parts.push(encodeStringField(NoiseMsg1Field.aNetworkName, msg.aNetworkName));
  }
  // optional：presence 有意义
  if (msg.aSessionGeneration !== null) {
    parts.push(encodeVarintField(NoiseMsg1Field.aSessionGeneration, msg.aSessionGeneration));
  }
  // aConnId 字段值本身就是一个 UUID message（4 个 uint32），
  // 作为 length-delimited 字段嵌入。
  parts.push(encodeBytesField(NoiseMsg1Field.aConnId, encodeUuid(msg.aConnId)));
  if (msg.clientEncryptionAlgorithm !== '') {
    parts.push(
      encodeStringField(NoiseMsg1Field.clientEncryptionAlgorithm, msg.clientEncryptionAlgorithm),
    );
  }
  for (const feature of msg.features) {
    parts.push(encodeStringField(NoiseMsg1Field.features, feature));
  }

  return Buffer.concat(parts);
}

/**
 * `PeerConnSessionActionPb`（`peer_rpc.proto:345`）。
 */
export const SessionAction = {
  Join: 0,
  Sync: 1,
  Create: 2,
} as const;

/**
 * Noise 握手的状态机。
 *
 * 只覆盖"作为客户端主动连接"这个方向——本服务的用途是主动去连对端，
 * 不需要能接受 Noise 连接（官方节点那一侧由它自己实现）。
 */
export interface NoiseHandshakeState {
  /** 本次连接的 UUID */
  connId: Uint8Array;
  /** 我方的 peer id */
  myPeerId: number;
  /** 对端 peer id（握手期间可能还不知道，为 0） */
  remotePeerId: number;
}

/** 生成本次连接用的 UUID（16 字节）。 */
export function newConnId(): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return new Uint8Array(randomBytes(16));
}

/**
 * 判断两个 `secret_digest` 是否一致。
 *
 * 双方在 Msg2/Msg3 里交换摘要，用来确认"我们用的是同一个网络密钥"
 * ——注意这一层是在 Noise 加密通道内做的二次确认，与第 ① 层明文摘要互为补充：
 * 明文那次防止误连到错误的网络，加密这次防止中间人在明文阶段篡改。
 */
export function sameSecretDigest(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
  return timingSafeEqual(a, b);
}

/**
 * `PeerConnNoiseMsg3Pb` 的字段号（`peer_rpc.proto:392`）。
 *
 * ```
 * message PeerConnNoiseMsg3Pb {
 *   common.UUID a_conn_id_echo = 1;   // 回显 Msg1 里的 a_conn_id
 *   common.UUID b_conn_id_echo = 2;   // 回显 Msg2 里的 b_conn_id
 *   optional bytes secret_proof_32 = 3;
 *   bytes secret_digest = 4;
 * }
 * ```
 */
export const NoiseMsg3Field = {
  aConnIdEcho: 1,
  bConnIdEcho: 2,
  secretProof32: 3,
  secretDigest: 4,
} as const;

export interface NoiseMsg3 {
  /** **必须回显 Msg1 里的 a_conn_id**，否则对端报 "noise msg3 a_conn_id mismatch" */
  aConnIdEcho: Uint8Array;
  /** 回显 Msg2 里的 b_conn_id（读不到就传 null） */
  bConnIdEcho: Uint8Array | null;
  secretProof: Buffer | null;
  secretDigest: Buffer;
}

/**
 * 编码 `PeerConnNoiseMsg3Pb`。
 *
 * 这最后一条消息承担两件事：
 * 1. **回显两个 conn_id**，把三轮消息绑成一次连接（防重放/防串线）
 * 2. 带上 `secret_proof`（证明持有网络密钥）与 `secret_digest`
 *
 * 踩过的坑：`a_conn_id_echo` 必须回显 **Msg1 里我方生成的 conn_id**。
 * 我曾随手填了个常量，对端精确报错 `noise msg3 a_conn_id mismatch`。
 */
export function encodeNoiseMsg3(msg: NoiseMsg3): Buffer {
  const parts: Buffer[] = [];

  parts.push(encodeBytesField(NoiseMsg3Field.aConnIdEcho, encodeUuid(msg.aConnIdEcho)));
  if (msg.bConnIdEcho !== null) {
    parts.push(encodeBytesField(NoiseMsg3Field.bConnIdEcho, encodeUuid(msg.bConnIdEcho)));
  }
  if (msg.secretProof !== null) {
    parts.push(encodeBytesField(NoiseMsg3Field.secretProof32, msg.secretProof));
  }
  if (msg.secretDigest.length > 0) {
    parts.push(encodeBytesField(NoiseMsg3Field.secretDigest, msg.secretDigest));
  }

  return Buffer.concat(parts);
}

/** `PeerConnNoiseMsg2Pb` 的字段号（`peer_rpc.proto:361`）。 */
export const NoiseMsg2Field = {
  bNetworkName: 1,
  roleHint: 2,
  action: 3,
  bSessionGeneration: 4,
  rootKey32: 5,
  initialEpoch: 6,
  bConnId: 7,
  aConnIdEcho: 8,
  secretProof32: 9,
  serverEncryptionAlgorithm: 10,
  features: 11,
} as const;

export interface NoiseMsg2 {
  bNetworkName: string;
  roleHint: number;
  action: number;
  bSessionGeneration: number;
  bConnId: Uint8Array;
  aConnIdEcho: Uint8Array | null;
  secretProof: Buffer | null;
  features: string[];
}

/** 解码 `PeerConnNoiseMsg2Pb`（这是对端发来的，我们读）。 */
export function decodeNoiseMsg2(buffer: Buffer): NoiseMsg2 {
  const fields = decodeFields(buffer);
  const bConnIdBytes = getBytes(fields, NoiseMsg2Field.bConnId);
  const aEchoBytes = getBytes(fields, NoiseMsg2Field.aConnIdEcho);
  return {
    bNetworkName: getBytes(fields, NoiseMsg2Field.bNetworkName)?.toString('utf8') ?? '',
    roleHint: getVarint(fields, NoiseMsg2Field.roleHint) ?? 0,
    action: getVarint(fields, NoiseMsg2Field.action) ?? 0,
    bSessionGeneration: getVarint(fields, NoiseMsg2Field.bSessionGeneration) ?? 0,
    bConnId: bConnIdBytes === null ? new Uint8Array(16) : decodeUuid(bConnIdBytes),
    aConnIdEcho: aEchoBytes === null ? null : decodeUuid(aEchoBytes),
    secretProof: getBytes(fields, NoiseMsg2Field.secretProof32),
    features: getAllBytes(fields, NoiseMsg2Field.features).map((b) => b.toString('utf8')),
  };
}
