/**
 * EasyTier 的 peer 握手（明文握手包）。
 *
 * 对照 `easytier-core/src/peers/conn/peer_conn.rs`。
 *
 * ## 握手流程
 *
 * ```
 * 客户端                                   服务端
 *   |--- HandshakeRequest (裸 protobuf) --->|
 *   |<-- HandshakeResponse (裸 protobuf) ---|
 *   |--- Noise Msg1 ---> ... 三轮 ... ---->
 * ```
 *
 * 第一步是**明文**的 `HandshakeRequest`，里面带 `network_secret_digest`
 * 用于双方确认"网络名和密钥是否一致"——这就是为什么必须精确复现
 * Rust 的 `DefaultHasher`（见 `siphash.ts`）。
 *
 * ## 关键常量
 *
 * - `MAGIC = 0xd1e1a5e1`（`peer_conn.rs:65`）：版本隔离。
 *   对不上说明协议代次不同，必须直接结束而不是继续握手。
 * - 包体是**裸 protobuf**，没有外层包头（`peer_conn.rs:560` 的 `encode_to_vec()`）。
 *   这一点容易搞错：其它消息（数据面）才带 16 字节 `PeerManagerHeader`。
 */

import { decodeFields, encodeBytesField, encodeStringField, encodeVarintField, getAllBytes, getBytes, getVarint } from './protobuf';
import { networkSecretDigest } from './siphash';

/** 握手魔数（`peer_conn.rs:65`）。 */
export const HANDSHAKE_MAGIC = 0xd1e1a5e1;

/** 本实现声称的协议版本。 */
export const HANDSHAKE_VERSION = 1;

/**
 * 本实现支持的特性。
 *
 * `liveness-echo-v1` 是官方日志里实际出现的值（`features: ["liveness-echo-v1"]`）。
 * 声明它表示"我支持回声探测"，对端据此决定是否做延迟测量。
 * 少声明不影响握手成功，但会让对端不做延迟统计。
 */
export const HANDSHAKE_FEATURES = ['liveness-echo-v1'] as const;

/** `HandshakeRequest` 的字段号（`peer_rpc.proto:319`）。 */
export const HandshakeRequestField = {
  magic: 1,
  myPeerId: 2,
  version: 3,
  features: 4,
  networkName: 5,
  networkSecretDigest: 6,
} as const;

/**
 * `HandshakeResponse` 的字段号（`peer_rpc.proto`，与 Request 不同）。
 *
 * 注意：响应里 `network_name` 是字段 5、`network_secret_digest` 是字段 6，
 * 与请求的 5/6 相同，但**没有** `features` 之外的差异——
 * 这里单独定义一份是为了让"响应"与"请求"的语义分开，避免将来混淆。
 */
export const HandshakeResponseField = {
  magic: 1,
  myPeerId: 2,
  version: 3,
  features: 4,
  networkName: 5,
  networkSecretDigest: 6,
} as const;

export interface HandshakeResponse {
  magic: number;
  myPeerId: number;
  version: number;
  features: string[];
  networkName: string;
  networkSecretDigest: Buffer;
}

/** 解码 `HandshakeResponse`。结构上同 Request，但语义是"对方的答复"。 */
export function decodeHandshakeResponse(buffer: Buffer): HandshakeResponse {
  const fields = decodeFields(buffer);
  return {
    magic: getVarint(fields, HandshakeResponseField.magic) ?? 0,
    myPeerId: getVarint(fields, HandshakeResponseField.myPeerId) ?? 0,
    version: getVarint(fields, HandshakeResponseField.version) ?? 0,
    features: getAllBytes(fields, HandshakeResponseField.features).map((b) => b.toString('utf8')),
    networkName:
      getBytes(fields, HandshakeResponseField.networkName)?.toString('utf8') ?? '',
    networkSecretDigest:
      getBytes(fields, HandshakeResponseField.networkSecretDigest) ?? Buffer.alloc(0),
  };
}

/**
 * 校验对端响应。
 *
 * 与请求校验同样三项（magic / 网络名 / 摘要），因为响应里也带着这些，
 * 可以用它二次确认"对面确实是同一个网络的节点"，而不是某个中间人或错误配置。
 */
export function validateHandshakeResponse(
  response: HandshakeResponse,
  expected: { networkName: string; networkSecret: string },
): string | null {
  if (response.magic !== HANDSHAKE_MAGIC) {
    return `响应魔数不匹配（收到 0x${response.magic.toString(16)}）`;
  }
  if (response.networkName !== expected.networkName) {
    return `响应网络名不匹配（收到 "${response.networkName}"，期望 "${expected.networkName}"）`;
  }
  const expectedDigest = networkSecretDigest(expected.networkName, expected.networkSecret);
  if (!response.networkSecretDigest.equals(expectedDigest)) {
    return '响应里的密钥摘要不匹配';
  }
  return null;
}

export interface HandshakeRequest {
  magic: number;
  myPeerId: number;
  version: number;
  features: string[];
  networkName: string;
  /** 32 字节摘要，见 `siphash.ts` */
  networkSecretDigest: Buffer;
}

/**
 * 编码 `HandshakeRequest`（裸 protobuf）。
 *
 * proto3 规则照常：默认值不写。但这里三个标量都不会是 0
 * （magic 是常量、myPeerId 非 0、version 是 1），所以实际都会写出来。
 */
export function encodeHandshakeRequest(request: HandshakeRequest): Buffer {
  const parts: Buffer[] = [];

  if (request.magic !== 0) {
    parts.push(encodeVarintField(HandshakeRequestField.magic, request.magic));
  }
  if (request.myPeerId !== 0) {
    parts.push(encodeVarintField(HandshakeRequestField.myPeerId, request.myPeerId));
  }
  if (request.version !== 0) {
    parts.push(encodeVarintField(HandshakeRequestField.version, request.version));
  }
  for (const feature of request.features) {
    parts.push(encodeStringField(HandshakeRequestField.features, feature));
  }
  if (request.networkName !== '') {
    parts.push(encodeStringField(HandshakeRequestField.networkName, request.networkName));
  }
  if (request.networkSecretDigest.length > 0) {
    parts.push(
      encodeBytesField(HandshakeRequestField.networkSecretDigest, request.networkSecretDigest),
    );
  }

  return Buffer.concat(parts);
}

/** 解码 `HandshakeRequest`。 */
export function decodeHandshakeRequest(buffer: Buffer): HandshakeRequest {
  const fields = decodeFields(buffer);
  return {
    magic: getVarint(fields, HandshakeRequestField.magic) ?? 0,
    myPeerId: getVarint(fields, HandshakeRequestField.myPeerId) ?? 0,
    version: getVarint(fields, HandshakeRequestField.version) ?? 0,
    features: getAllBytes(fields, HandshakeRequestField.features).map((b) => b.toString('utf8')),
    networkName: getBytes(fields, HandshakeRequestField.networkName)?.toString('utf8') ?? '',
    networkSecretDigest: getBytes(fields, HandshakeRequestField.networkSecretDigest) ?? Buffer.alloc(0),
  };
}

/**
 * 构造一个握手请求。
 *
 * `networkSecretDigest` 由网络名与密钥算出——对端用它判断密钥是否匹配，
 * 所以算法必须与官方逐位一致（`siphash.ts` 里有 SipHash-1-3 的实现与验证）。
 */
export function buildHandshakeRequest(input: {
  myPeerId: number;
  networkName: string;
  networkSecret: string;
  version?: number;
  features?: readonly string[];
}): HandshakeRequest {
  return {
    magic: HANDSHAKE_MAGIC,
    myPeerId: input.myPeerId,
    version: input.version ?? HANDSHAKE_VERSION,
    features: [...(input.features ?? HANDSHAKE_FEATURES)],
    networkName: input.networkName,
    networkSecretDigest: networkSecretDigest(input.networkName, input.networkSecret),
  };
}

/**
 * 校验对端握手请求是否可接受。
 *
 * 返回 null 表示接受，否则返回拒绝原因（给人看的）。
 *
 * 三项检查缺一不可：
 * - magic 不符 → 协议代次不同，后续格式也可能不同，必须断开
 * - 网络名不符 → 不是同一个虚拟网络
 * - 摘要不符 → 密钥不对（这也可能是网络名对但密钥错）
 */
export function validateHandshakeRequest(
  request: HandshakeRequest,
  expected: { networkName: string; networkSecret: string },
): string | null {
  if (request.magic !== HANDSHAKE_MAGIC) {
    return `握手魔数不匹配（收到 0x${request.magic.toString(16)}，期望 0x${HANDSHAKE_MAGIC.toString(16)}），协议版本可能不同`;
  }
  if (request.networkName !== expected.networkName) {
    return `网络名不匹配（收到 "${request.networkName}"，期望 "${expected.networkName}"）`;
  }
  const expectedDigest = networkSecretDigest(expected.networkName, expected.networkSecret);
  if (!request.networkSecretDigest.equals(expectedDigest)) {
    return '网络密钥不匹配（摘要不同）';
  }
  return null;
}

/**
 * 生成一个随机的 peer id。
 *
 * EasyTier 里 peer id 是 32 位无符号整数，用于在虚拟网络内标识节点。
 * 0 有特殊含义（`PeerId::default()`），所以避开。
 */
export function randomPeerId(): number {
  // 用 crypto 的随机源而不是 Math.random：peer id 参与路由计算，
  // 可预测的 id 会在多节点场景下增加冲突概率。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  const value = randomBytes(4).readUInt32BE(0);
  // 避开 0（默认值）与 0xFFFFFFFF（广播/保留）
  if (value === 0 || value === 0xffffffff) return randomPeerId();
  return value;
}
