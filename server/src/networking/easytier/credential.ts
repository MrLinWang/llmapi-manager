/**
 * EasyTier 的凭证（credential）实现。
 *
 * 对照 `easytier-proto/src/peer_rpc.rs:48` 与
 * `easytier-core/src/peers/credential_manager.rs`。
 *
 * ## 凭证是什么
 *
 * 网络密钥（`network_secret`）是所有成员共享的准入门槛。凭证机制在此之上
 * 提供**可撤销、可限权、可过期**的次级凭据：
 *
 * - 网络里持密钥的管理节点签发凭证（一对 X25519 密钥 + 权限声明）
 * - 普通节点只需持有凭证即可加入，**不需要知道网络密钥**
 * - 撤销/过期只影响该凭证，不必更换全网密钥
 *
 * ## 签名公式（必须逐字节一致，否则对方验签失败）
 *
 * ```
 * HMAC-SHA256(
 *   key = network_secret,
 *   msg = "easytier credential proof" || protobuf_encode(TrustedCredentialPubkey)
 * )
 * ```
 *
 * 两个容易错的点：
 * 1. **被签名的是 protobuf 序列化结果**，不是任何字段拼接的字符串。
 * 2. **前缀是固定字面量的一部分**，漏掉或改一个字符都会导致验签失败，
 *    而对方的错误信息只会说"验签失败"，不会说是前缀错了。
 *
 * ## 验证方式
 *
 * `server/test/easytierOracle.test.ts` 用官方实现生成的固定测试向量
 * （密钥、字段、protobuf 字节、HMAC 全部对照），所以这里的实现不是
 * "看起来合理"，而是与官方产出的字节相同。
 */

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  decodeFields,
  encodeBytesField,
  encodeStringField,
  encodeVarintField,
  getBytes,
  getAllBytes,
  getVarint,
} from './protobuf';

/** 签名前缀。官方写死在 `peer_rpc.rs:54`，改一个字符就验签失败。 */
export const CREDENTIAL_HMAC_PREFIX = Buffer.from('easytier credential proof', 'utf8');

/** X25519 密钥长度。 */
export const X25519_KEY_BYTES = 32;

/**
 * 凭证内容。字段顺序与
 * `TrustedCredentialPubkey`（`peer_rpc.proto:8`）一致。
 */
export interface TrustedCredential {
  /** X25519 公钥，32 字节 */
  pubkey: Buffer;
  /** 该凭证所属的 ACL 组 */
  groups: string[];
  /** 是否允许该节点转发他人流量 */
  allowRelay: boolean;
  /** 过期时间（Unix 秒） */
  expiryUnix: number;
  /** 允许代理的网段 */
  allowedProxyCidrs: string[];
  /**
   * 是否允许同一凭证被多个节点同时使用。
   *
   * **注意这是一处 `optional` 字段**（proto 里写 `optional bool reusable = 6`），
   * 所以"未设置"与"设为 false"是**不同的字节**。不能把它当成普通 bool 处理，
   * 否则生成的 protobuf 与官方不同、HMAC 对不上。
   */
  reusable: boolean | null;
}

/**
 * 编码 `TrustedCredentialPubkey`。
 *
 * proto3 规则：普通标量字段取默认值时不写；`optional` 字段只要显式设置过就写。
 * 具体到本 message：
 * - `pubkey`（bytes, 1）：空则不写
 * - `groups`（repeated, 2）：每项都写（空列表不写）
 * - `allow_relay`（bool, 3）：**false 不写**
 * - `expiry_unix`（int64, 4）：**0 不写**
 * - `allowed_proxy_cidrs`（repeated, 5）：每项都写
 * - `reusable`（optional bool, 6）：`null` 不写；`false` **要写 0**
 */
export function encodeCredential(credential: TrustedCredential): Buffer {
  const parts: Buffer[] = [];

  if (credential.pubkey.length > 0) {
    parts.push(encodeBytesField(1, credential.pubkey));
  }
  for (const group of credential.groups) {
    parts.push(encodeStringField(2, group));
  }
  // proto3：false 是默认值，不写
  if (credential.allowRelay) {
    parts.push(encodeVarintField(3, 1));
  }
  // proto3：0 是默认值，不写
  if (credential.expiryUnix !== 0) {
    parts.push(encodeVarintField(4, credential.expiryUnix));
  }
  for (const cidr of credential.allowedProxyCidrs) {
    parts.push(encodeStringField(5, cidr));
  }
  // optional：presence 有意义。null 表示"未设置"，false 表示"显式设为 false"。
  if (credential.reusable !== null) {
    parts.push(encodeVarintField(6, credential.reusable ? 1 : 0));
  }

  return Buffer.concat(parts);
}

/** 解码 `TrustedCredentialPubkey`。未知字段被跳过（proto 的前向兼容要求）。 */
export function decodeCredential(buffer: Buffer): TrustedCredential {
  const fields = decodeFields(buffer);
  const reusableValue = getVarint(fields, 6);
  return {
    pubkey: getBytes(fields, 1) ?? Buffer.alloc(0),
    groups: getAllBytes(fields, 2).map((b) => b.toString('utf8')),
    allowRelay: getVarint(fields, 3) === 1,
    expiryUnix: getVarint(fields, 4) ?? 0,
    allowedProxyCidrs: getAllBytes(fields, 5).map((b) => b.toString('utf8')),
    // 字段不存在 → null（未设置）；存在 → 布尔值
    reusable: reusableValue === null ? null : reusableValue !== 0,
  };
}

/**
 * 计算凭证的 HMAC。
 *
 * `HMAC-SHA256(key = networkSecret, msg = PREFIX || protobuf(credential))`
 */
export function credentialHmac(credential: TrustedCredential, networkSecret: string): Buffer {
  return createHmac('sha256', Buffer.from(networkSecret, 'utf8'))
    .update(CREDENTIAL_HMAC_PREFIX)
    .update(encodeCredential(credential))
    .digest();
}

/** 凭证 + 其签名，对应 `TrustedCredentialPubkeyProof`。 */
export interface TrustedCredentialProof {
  credential: TrustedCredential;
  hmac: Buffer;
}

/** 签发：编码、签名、返回 proof。对应官方 `new_signed`。 */
export function signCredential(
  credential: TrustedCredential,
  networkSecret: string,
): TrustedCredentialProof {
  return { credential, hmac: credentialHmac(credential, networkSecret) };
}

/** 编码 `TrustedCredentialPubkeyProof`（credential=1, hmac=2）。 */
export function encodeCredentialProof(proof: TrustedCredentialProof): Buffer {
  return Buffer.concat([
    encodeBytesField(1, encodeCredential(proof.credential)),
    encodeBytesField(2, proof.hmac),
  ]);
}

/**
 * 验签。对应官方 `verify_credential_hmac`。
 *
 * 用 `timingSafeEqual` 而不是 `===`：虽然这是网络上一个公开可见的签名，
 * 时序攻击的实际风险很低，但验签路径统一用常数时间比较是更好的默认值——
 * 免得将来有人把这里的模式复制到别的、真正需要常数时间的地方。
 */
export function verifyCredential(proof: TrustedCredentialProof, networkSecret: string): boolean {
  const expected = credentialHmac(proof.credential, networkSecret);
  if (expected.length !== proof.hmac.length) return false;
  return timingSafeEqual(expected, proof.hmac);
}

/** 凭证是否已过期。`nowUnix` 便于测试注入。 */
export function isCredentialExpired(
  credential: TrustedCredential,
  nowUnix: number = Math.floor(Date.now() / 1000),
): boolean {
  // expiry 为 0 视为"不过期"——与官方一致（proto 默认值语义）
  return credential.expiryUnix !== 0 && credential.expiryUnix < nowUnix;
}

/**
 * 生成一对 X25519 密钥。
 *
 * Node 没有直接暴露 raw X25519 私钥的生成接口，但可以：
 * 1. 用 `generateKeyPairSync('x25519')` 生成
 * 2. 导出 JWK 拿到 base64url 编码的 d（私钥）与 x（公钥）
 *
 * 用 JWK 而不是 DER/PEM 是因为 JWK 里的 d/x 正好是 32 字节原始值，
 * 而 protobuf 里要的就是这个原始 32 字节。
 */
export function generateCredentialKeyPair(): { privateKey: Buffer; publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');

  const privJwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x?: string };

  if (typeof privJwk.d !== 'string' || typeof pubJwk.x !== 'string') {
    throw new Error('X25519 密钥导出失败：JWK 里没有 d/x 字段');
  }

  return {
    privateKey: Buffer.from(privJwk.d, 'base64url'),
    publicKey: Buffer.from(pubJwk.x, 'base64url'),
  };
}

/**
 * 从原始 32 字节 X25519 私钥恢复公钥。
 *
 * 用途：配置文件里只存私钥（或不存），需要时导出公钥放进凭证广播。
 * 通过 JWK 导入再由 Node 计算，避免自己实现 Curve25519 标量乘法。
 */
export function publicKeyFromPrivate(privateKey: Buffer): Buffer {
  if (privateKey.length !== X25519_KEY_BYTES) {
    throw new Error(`X25519 私钥必须是 ${X25519_KEY_BYTES} 字节，实际 ${privateKey.length}`);
  }

  // 从**裸 32 字节私钥**导出公钥，Node 没有直接接口：
  // - `createPrivateKey({ format: 'jwk', key: { d } })` 会报 ERR_INVALID_ARG_TYPE，
  //   因为 Node 的 JWK 导入要求 `x`（公钥）同时存在。
  // - 而只有私钥时恰恰不知道 `x` —— 这正是要算的东西。
  //
  // 可行的办法是把它封装成 PKCS#8 DER。X25519 的 PKCS#8 结构是固定的：
  //
  //   30 2e                                     SEQUENCE (46 字节)
  //      02 01 00                                version = 0
  //      30 05 06 03 2b 65 6e                    AlgorithmIdentifier: 1.3.101.110 (X25519)
  //      04 22 04 20 <32字节私钥>                 OCTET STRING { OCTET STRING { key } }
  //
  // 也就是"16 字节固定前缀 + 32 字节私钥"。这样标量乘法交给 OpenSSL，
  // 我们不必自己实现 Curve25519（自己写几乎必然出错，且没有对照物）。
  const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
  const der = Buffer.concat([PKCS8_X25519_PREFIX, privateKey]);

  const privateKeyObject = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKeyObject = createPublicKey(privateKeyObject);
  const jwk = publicKeyObject.export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string') {
    throw new Error('从私钥导出公钥失败：JWK 里没有 x 字段');
  }
  return Buffer.from(jwk.x, 'base64url');
}
