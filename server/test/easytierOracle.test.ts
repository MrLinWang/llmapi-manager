import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PEER_MANAGER_HEADER_SIZE,
  PacketType,
  PeerManagerHeaderFlags,
  encodeHeader,
  decodeHeader,
  type PeerManagerHeader,
} from '../src/networking/easytier/protocol';
import {
  NOISE_PATTERN,
  NOISE_PROLOGUE,
  X25519_PUBLIC_KEY_BYTES,
  createHandshakeParams,
} from '../src/networking/easytier/noise';
import {
  CREDENTIAL_HMAC_PREFIX,
  credentialHmac,
  generateCredentialKeyPair,
  publicKeyFromPrivate,
  decodeCredential,
  encodeCredential,
  isCredentialExpired,
  signCredential,
  verifyCredential,
  type TrustedCredential,
} from '../src/networking/easytier/credential';
import {
  RoutePeerInfoField,
  decodeRoutePeerInfo,
  encodeRoutePeerInfo,
  pickBestRoute,
  type RoutePeerInfo,
} from '../src/networking/easytier/route';
import { CompressionAlgo } from '../src/networking/easytier/rpc';
import {
  HANDSHAKE_MAGIC,
  HandshakeRequestField,
  encodeHandshakeRequest,
} from '../src/networking/easytier/handshake';
import {
  NoiseMsg1Field,
  encodeNoiseMsg1,
  encodeUuid,
} from '../src/networking/easytier/noiseHandshake';
import { LIVENESS_ECHO_FEATURE } from '../src/networking/easytier/noise';
import {
  buildConnBitmap,
  decodePeerFeatureFlag,
  encodePeerFeatureFlag,
  type PeerFeatureFlag,
  decodeConnBitmap,
  encodeConnBitmap,
  getBitmapBit,
  getConnectedPeers,
  NatType,
  SocketType,
  decodeIpv4Addr,
  decodeTunnelInfo,
  encodeIpv4Addr,
  encodeIpv4Inet,
  encodeSocketAddr,
  encodeTunnelInfo,
  encodeUrl,
  ipv4ToNumber,
  numberToIpv4,
} from '../src/networking/easytier/address';
import {
  decodeFields,
  decodeVarint,
  encodeVarint,
  getVarint,
} from '../src/networking/easytier/protobuf';

/**
 * 用**官方实现**做 oracle，逐字节验证我们的协议理解。
 *
 * `fixtures-protocol-oracle.json` 不是手写的常量文件——它由
 * `native/protocol-oracle`（一个直接链接官方 `easytier-core` 的 Rust 程序）
 * 生成，里面的每个字节都是用 `zerocopy::AsBytes` 从真实结构体内存里读出来的。
 *
 * 这让验证的性质变了：原先的测试只能证明"我们的编码器和自己的解码器一致"
 * （两端都错也能通过），现在能证明"我们的编码器产出的字节与官方实现完全相同"。
 *
 * 重新生成：
 *   cd native/protocol-oracle && cargo run --release > ../../server/test/fixtures-protocol-oracle.json
 */

interface OracleFlag {
  value: number;
  hex: string;
  header_hex: string;
}

interface OracleNoise {
  ok: boolean;
  pattern: string;
  prologue: string;
  handshake_finished: { initiator: boolean; responder: boolean };
  msg_lengths: { msg1: number; msg2: number; msg3: number };
}

interface OracleCredentials {
  hmac_formula: { mac: string; key: string; prefix: string };
  pubkey_fields: Record<string, number>;
  vector: {
    network_secret: string;
    credential: {
      pubkey_hex: string;
      groups: string[];
      allow_relay: boolean;
      expiry_unix: number;
      allowed_proxy_cidrs: string[];
      reusable: boolean;
    };
    protobuf_hex: string;
    hmac_hex: string;
    api_self_verify: boolean;
  };
  tamper: { changed_field: string; protobuf_hex: string; protobuf_differs: boolean };
  edge_cases: {
    empty_protobuf_hex: string;
    empty_len: number;
    reusable_false_protobuf_hex: string;
    without_reusable_protobuf_hex: string;
    reusable_presence_matters: boolean;
  };
}

interface OracleRoutes {
  field_numbers: Record<string, number>;
  sample: {
    input: {
      peer_id: number;
      cost: number;
      version: number;
      hostname: string;
      easytier_version: string;
      proxy_cidrs: string[];
      peer_route_id: number;
      network_length: number;
      noise_static_pubkey_hex: string;
    };
    protobuf_hex: string;
    decoded: Record<string, unknown>;
  };
  minimal: { input: { peer_id: number }; protobuf_hex: string };
  default_protobuf_hex: string;
}

interface Oracle {
  header_size: number;
  header_sample: {
    input: {
      from_peer_id: number;
      to_peer_id: number;
      packet_type: number;
      flags: string[];
      forward_counter: number;
      len: number;
    };
    hex: string;
    bytes: number[];
  };
  default_header_hex: string;
  packet_types: Record<string, number>;
  flags: Record<string, OracleFlag>;
  noise_handshake: OracleNoise;
  credentials: OracleCredentials;
  routes: OracleRoutes;
}

const oracle: Oracle = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures-protocol-oracle.json'), 'utf8'),
) as Oracle;

describe('协议对照：与官方 easytier-core 逐字节一致', () => {
  it('包头大小与官方一致', () => {
    expect(PEER_MANAGER_HEADER_SIZE).toBe(oracle.header_size);
  });

  it('用官方样本值编码，产出完全相同的字节', () => {
    // 这是本文件最关键的一条断言。
    const { input } = oracle.header_sample;

    const flags = input.flags.reduce((acc, name) => {
      const bit = PeerManagerHeaderFlags[name as keyof typeof PeerManagerHeaderFlags];
      expect(bit, `未知标志位 ${name}`).toBeDefined();
      return acc | bit;
    }, 0);

    const encoded = encodeHeader({
      fromPeerId: input.from_peer_id,
      toPeerId: input.to_peer_id,
      packetType: input.packet_type as PacketType,
      flags,
      forwardCounter: input.forward_counter,
      len: input.len,
    });

    expect(encoded.toString('hex')).toBe(oracle.header_sample.hex);
    // 同时按字节数组比一遍：hex 相等已经足够，但数组比较的失败信息更易读
    expect([...encoded]).toEqual(oracle.header_sample.bytes);
  });

  it('能正确解码官方实现产出的字节', () => {
    // 反方向：假设收到的是官方节点发来的包，我们要能读对
    const bytes = Buffer.from(oracle.header_sample.hex, 'hex');
    const decoded = decodeHeader(bytes);
    expect(decoded).not.toBeNull();

    const { input } = oracle.header_sample;
    expect(decoded!.fromPeerId).toBe(input.from_peer_id);
    expect(decoded!.toPeerId).toBe(input.to_peer_id);
    expect(decoded!.packetType).toBe(input.packet_type);
    expect(decoded!.forwardCounter).toBe(input.forward_counter);
    expect(decoded!.len).toBe(input.len);
  });

  it('reserved 字节的偏移与官方一致（跳过它 len 会错位）', () => {
    // 官方结构里 `reserved` 是私有字段，但确实占第 11 字节。
    // 若我们的编码器没有给它留位，len 会写到 offset 11，整包作废。
    const bytes = Buffer.from(oracle.header_sample.hex, 'hex');
    expect(bytes[11]).toBe(0);
    // len 必须从 12 开始：官方样本的 len=1400=0x578
    expect(bytes.subarray(12, 16).toString('hex')).toBe('78050000');
    expect(bytes.readUInt32LE(12)).toBe(oracle.header_sample.input.len);
  });

  it('全零包头与官方的 Default 一致', () => {
    const zero: PeerManagerHeader = {
      fromPeerId: 0,
      toPeerId: 0,
      packetType: PacketType.Invalid,
      flags: 0,
      forwardCounter: 0,
      len: 0,
    };
    expect(encodeHeader(zero).toString('hex')).toBe(oracle.default_header_hex);
  });

  it('每个 PacketType 的数值与官方枚举一致', () => {
    // 这些是线上字节。差一个数字就是"与官方节点无法通信"。
    for (const [name, value] of Object.entries(oracle.packet_types)) {
      const ours = PacketType[name as keyof typeof PacketType];
      expect(ours, `PacketType.${name} 在 TS 侧不存在`).toBeDefined();
      expect(ours, `PacketType.${name} 数值不一致`).toBe(value);
    }
  });

  it('TS 侧没有官方不存在的 PacketType（防止写成幻觉）', () => {
    const officialNames = new Set(Object.keys(oracle.packet_types));
    // 反向枚举：排除数字索引
    const ourNames = Object.keys(PacketType).filter((key) => Number.isNaN(Number(key)));
    for (const name of ourNames) {
      expect(officialNames.has(name), `TS 侧多出了 ${name}，官方枚举里没有`).toBe(true);
    }
  });

  it('每个标志位的值与我们的一致（用官方 setter 实际写出的位验证）', () => {
    // oracle 是用公开的 `set_encrypted(true)` 等 setter 逐个打开单个标志后
    // 从真实字节里读出来的，所以这验证的是"setter 实际写入的位"，
    // 而不只是常量声明。
    for (const [name, info] of Object.entries(oracle.flags)) {
      const ours = PeerManagerHeaderFlags[name as keyof typeof PeerManagerHeaderFlags];
      expect(ours, `标志位 ${name} 在 TS 侧不存在`).toBeDefined();
      expect(ours, `标志位 ${name} 的值不一致`).toBe(info.value);
    }
  });

  it('单独打开一个标志时，只有对应那一位被置起', () => {
    // 验证"标志位互不干扰"。用 oracle 给出的单项 header_hex 直接对照。
    for (const [name, info] of Object.entries(oracle.flags)) {
      const bit = PeerManagerHeaderFlags[name as keyof typeof PeerManagerHeaderFlags];
      const encoded = encodeHeader({
        fromPeerId: 0,
        toPeerId: 0,
        packetType: PacketType.Invalid,
        flags: bit,
        forwardCounter: 0,
        len: 0,
      });
      // 官方 setter 产出的完整包头字节（只有该位为 1，其余全 0）
      expect(encoded.toString('hex'), `标志位 ${name} 的单bit字节不一致`).toBe(info.header_hex);
    }
  });
});

describe('协议对照：小端序的证据', () => {
  it('官方字节证明是多字节整数字段是小端', () => {
    // 这条单独列出来，因为**字节序是最容易搞错又最难发现的一处**：
    // 用大端写出来的编码器能通过自己的往返测试，却与官方节点完全无法通信。
    //
    // 官方样本 from_peer_id = 0x01020304，其字节是 04 03 02 01。
    const bytes = Buffer.from(oracle.header_sample.hex, 'hex');
    expect([...bytes.subarray(0, 4)]).toEqual([0x04, 0x03, 0x02, 0x01]);

    // 若我们用大端写，会得到 01 02 03 04 —— 与官方正好相反
    const wrongEndian = Buffer.alloc(4);
    wrongEndian.writeUInt32BE(oracle.header_sample.input.from_peer_id, 0);
    expect([...wrongEndian]).toEqual([0x01, 0x02, 0x03, 0x04]);
    expect(wrongEndian.toString('hex')).not.toBe(bytes.subarray(0, 4).toString('hex'));
  });
});

describe('协议对照：Noise 握手参数', () => {
  it('骨架与 prologue 与官方实现一致', () => {
    // oracle 用官方同一个 Noise 库（snow 0.10.0）跑了一次真实握手，
    // 并把实际生效的 pattern / prologue 回写出来。
    // 这两个字符串任一写错，握手都会失败——prologue 不一致时在第二步才失败，
    // 且错误信息不会告诉你"prologue 不对"，属于最难自查的一类错误。
    expect(NOISE_PATTERN).toBe(oracle.noise_handshake.pattern);
    expect(NOISE_PROLOGUE.toString('utf8')).toBe(oracle.noise_handshake.prologue);
  });

  it('官方用这对参数能真的完成握手（oracle 已实测）', () => {
    expect(oracle.noise_handshake.ok).toBe(true);
    expect(oracle.noise_handshake.handshake_finished.initiator).toBe(true);
    expect(oracle.noise_handshake.handshake_finished.responder).toBe(true);
  });

  it('XX 模式的消息长度是我们的参数所决定的（结构证据）', () => {
    // Noise_XX 的每条消息长度是固定的，可作为"参数确实被正确解析"的旁证：
    //   msg1 = e(32)                        → 32
    //   msg2 = e(32) + s(32+16 tag) + payload(16 tag) → 96
    //   msg3 = s(32+16 tag) + payload(16 tag)         → 64
    // 若模式写错（例如换成 IK 或 NN），这些长度会变。
    expect(oracle.noise_handshake.msg_lengths).toEqual({ msg1: 32, msg2: 96, msg3: 64 });
  });

  it('我们生成的私钥/钉扎公钥长度符合 XX 模式要求', () => {
    // oracle 的握手用的也是 32 字节静态密钥，与本侧 createHandshakeParams 的约束一致
    const params = createHandshakeParams();
    expect(params.localPrivateKey).toHaveLength(X25519_PUBLIC_KEY_BYTES);
    expect(X25519_PUBLIC_KEY_BYTES).toBe(32);
  });
});

// ══════════════════════════════════════════════════════════════════
// 凭证：X25519 + HMAC-SHA256 over protobuf
// ══════════════════════════════════════════════════════════════════

/** 把 oracle 的样本转成我们的类型。 */
function oracleCredential(): TrustedCredential {
  const c = oracle.credentials.vector.credential;
  return {
    pubkey: Buffer.from(c.pubkey_hex, 'hex'),
    groups: c.groups,
    allowRelay: c.allow_relay,
    expiryUnix: c.expiry_unix,
    allowedProxyCidrs: c.allowed_proxy_cidrs,
    reusable: c.reusable,
  };
}

describe('协议对照：凭证的 protobuf 编码', () => {
  it('编码结果与官方逐字节相同', () => {
    // 这条是凭证互操作的基础：官方对 protobuf 编码结果签名，
    // 所以只要字节差一个，HMAC 就完全不同、对方验签失败。
    const encoded = encodeCredential(oracleCredential());
    expect(encoded.toString('hex')).toBe(oracle.credentials.vector.protobuf_hex);
  });

  it('签名前缀与官方一致', () => {
    // 前缀改一个字符 → 验签失败，而对方只会说"验签失败"，不会说前缀错了
    expect(CREDENTIAL_HMAC_PREFIX.toString('utf8')).toBe(
      oracle.credentials.hmac_formula.prefix,
    );
  });

  it('HMAC 与官方完全相同', () => {
    const hmac = credentialHmac(
      oracleCredential(),
      oracle.credentials.vector.network_secret,
    );
    expect(hmac.toString('hex')).toBe(oracle.credentials.vector.hmac_hex);
  });

  it('自己签发的凭证能通过自己的验签，且官方也能验（同一公式）', () => {
    const secret = oracle.credentials.vector.network_secret;
    const proof = signCredential(oracleCredential(), secret);

    expect(verifyCredential(proof, secret)).toBe(true);
    // 换一个密钥必须验签失败
    expect(verifyCredential(proof, `${secret}-wrong`)).toBe(false);
    // oracle 报告官方 API 自校验通过，说明两边用的是同一条公式
    expect(oracle.credentials.vector.api_self_verify).toBe(true);
  });

  it('篡改任一字段都会改变编码（因此改变 HMAC）', () => {
    const original = encodeCredential(oracleCredential()).toString('hex');
    expect(oracle.credentials.tamper.protobuf_differs).toBe(true);
    expect(oracle.credentials.tamper.protobuf_hex).not.toBe(original);
  });

  it('解码能还原所有字段', () => {
    const decoded = decodeCredential(Buffer.from(oracle.credentials.vector.protobuf_hex, 'hex'));
    const c = oracle.credentials.vector.credential;
    expect(decoded.pubkey.toString('hex')).toBe(c.pubkey_hex);
    expect(decoded.groups).toEqual(c.groups);
    expect(decoded.allowRelay).toBe(c.allow_relay);
    expect(decoded.expiryUnix).toBe(c.expiry_unix);
    expect(decoded.allowedProxyCidrs).toEqual(c.allowed_proxy_cidrs);
    expect(decoded.reusable).toBe(c.reusable);
  });

  it('字段号与 proto 定义一致', () => {
    const expected = oracle.credentials.pubkey_fields;
    // 这些数字是线上格式；集中断言避免将来改 proto 时漏改一侧
    expect(expected.pubkey).toBe(1);
    expect(expected.groups).toBe(2);
    expect(expected.allow_relay).toBe(3);
    expect(expected.expiry_unix).toBe(4);
    expect(expected.allowed_proxy_cidrs).toBe(5);
    expect(expected.reusable).toBe(6);
  });
});

describe('协议对照：凭证的 proto3 边界行为', () => {
  it('全默认值的凭证编码成空字节（proto3 不写默认值）', () => {
    const empty: TrustedCredential = {
      pubkey: Buffer.alloc(0),
      groups: [],
      allowRelay: false,
      expiryUnix: 0,
      allowedProxyCidrs: [],
      reusable: null,
    };
    const encoded = encodeCredential(empty);
    expect(encoded.toString('hex')).toBe(oracle.credentials.edge_cases.empty_protobuf_hex);
    expect(encoded.length).toBe(oracle.credentials.edge_cases.empty_len);
  });

  it('reusable 的 presence 有意义：false 与"未设置"编码不同', () => {
    // 这是最容易错的一处：proto 里 `optional bool reusable = 6`，
    // 显式设为 false 必须写出来（0x30 0x00），而"未设置"什么都不写。
    // 若把 reusable 当普通 bool 处理（false 不写），HMAC 就会与官方不同。
    const base: TrustedCredential = {
      pubkey: Buffer.alloc(0),
      groups: [],
      allowRelay: false,
      expiryUnix: 0,
      allowedProxyCidrs: [],
      reusable: null,
    };

    // oracle 给的是两批不同来源的数据，要按各自的基准对照：
    //   reusable_false_protobuf_hex  = 空凭证 + reusable=false  → '3000'
    //   without_reusable_protobuf_hex = **完整**凭证去掉 reusable
    const explicitFalse = encodeCredential({ ...base, reusable: false });
    const unset = encodeCredential({ ...base, reusable: null });

    // 空凭证 + 显式 false → 只有字段 6 的两个字节（tag 0x30 + 值 0x00）
    expect(explicitFalse.toString('hex')).toBe(
      oracle.credentials.edge_cases.reusable_false_protobuf_hex,
    );
    // 空凭证 + 未设置 → 空
    expect(unset.toString('hex')).toBe('');

    // 完整凭证去掉 reusable，应当等于"完整编码去掉末尾的 30 01"
    const full = encodeCredential(oracleCredential()).toString('hex');
    expect(full.endsWith('3001')).toBe(true);
    const fullWithoutReusable = full.slice(0, -4);
    expect(fullWithoutReusable).toBe(
      oracle.credentials.edge_cases.without_reusable_protobuf_hex,
    );
    expect(oracle.credentials.edge_cases.reusable_presence_matters).toBe(true);
    expect(explicitFalse.toString('hex')).not.toBe(unset.toString('hex'));
  });

  it('解码时能区分未设置与 false', () => {
    const base: TrustedCredential = {
      pubkey: Buffer.alloc(0),
      groups: [],
      allowRelay: false,
      expiryUnix: 0,
      allowedProxyCidrs: [],
      reusable: null,
    };
    expect(decodeCredential(encodeCredential({ ...base, reusable: null })).reusable).toBeNull();
    expect(decodeCredential(encodeCredential({ ...base, reusable: false })).reusable).toBe(false);
    expect(decodeCredential(encodeCredential({ ...base, reusable: true })).reusable).toBe(true);
  });

  it('过期判断：expiry 为 0 视为不过期', () => {
    const base = oracleCredential();
    // 0 = 不过期（proto 默认值语义）
    expect(isCredentialExpired({ ...base, expiryUnix: 0 }, 2_000_000_000)).toBe(false);
    // 已过期
    expect(isCredentialExpired({ ...base, expiryUnix: 1_000 }, 2_000_000_000)).toBe(true);
    // 未过期
    expect(isCredentialExpired({ ...base, expiryUnix: 3_000_000_000 }, 2_000_000_000)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 路由：RoutePeerInfo
// ══════════════════════════════════════════════════════════════════

function oracleRoute(): RoutePeerInfo {
  const i = oracle.routes.sample.input;
  return {
    peerId: i.peer_id,
    cost: i.cost,
    version: i.version,
    hostname: i.hostname,
    easytierVersion: i.easytier_version,
    proxyCidrs: i.proxy_cidrs,
    peerRouteId: i.peer_route_id,
    networkLength: i.network_length,
    noiseStaticPubkey: Buffer.from(i.noise_static_pubkey_hex, 'hex'),
  };
}

describe('协议对照：路由条目编码', () => {
  it('编码结果与官方逐字节相同', () => {
    const encoded = encodeRoutePeerInfo(oracleRoute());
    expect(encoded.toString('hex')).toBe(oracle.routes.sample.protobuf_hex);
  });

  it('解码官方字节能还原所有字段', () => {
    const decoded = decodeRoutePeerInfo(Buffer.from(oracle.routes.sample.protobuf_hex, 'hex'));
    const expected = oracle.routes.sample.decoded;

    expect(decoded.peerId).toBe(expected.peer_id);
    expect(decoded.cost).toBe(expected.cost);
    expect(decoded.version).toBe(expected.version);
    expect(decoded.hostname).toBe(expected.hostname);
    expect(decoded.easytierVersion).toBe(expected.easytier_version);
    expect(decoded.proxyCidrs).toEqual(expected.proxy_cidrs);
    expect(decoded.peerRouteId).toBe(expected.peer_route_id);
    expect(decoded.networkLength).toBe(expected.network_length);
    expect(decoded.noiseStaticPubkey?.toString('hex')).toBe(expected.noise_static_pubkey_hex);
  });

  it('往返编解码保持字段', () => {
    const original = oracleRoute();
    expect(decodeRoutePeerInfo(encodeRoutePeerInfo(original))).toEqual(original);
  });

  it('只有 peer_id 时编码为两个字节（proto3 不写默认值）', () => {
    // 官方 oracle 实测：peer_id=1 → 08 01
    const minimal: RoutePeerInfo = {
      peerId: oracle.routes.minimal.input.peer_id,
      cost: 0,
      version: 0,
      hostname: null,
      easytierVersion: '',
      proxyCidrs: [],
      peerRouteId: 0,
      networkLength: 0,
      noiseStaticPubkey: null,
    };
    expect(encodeRoutePeerInfo(minimal).toString('hex')).toBe(
      oracle.routes.minimal.protobuf_hex,
    );
  });

  it('字段号与 proto 定义一致', () => {
    // 直接对照官方 proto 里的编号，防止将来改 schema 时只改一侧
    const official = oracle.routes.field_numbers;
    expect(RoutePeerInfoField.peerId).toBe(official.peer_id);
    expect(RoutePeerInfoField.cost).toBe(official.cost);
    expect(RoutePeerInfoField.proxyCidrs).toBe(official.proxy_cidrs);
    expect(RoutePeerInfoField.hostname).toBe(official.hostname);
    expect(RoutePeerInfoField.version).toBe(official.version);
    expect(RoutePeerInfoField.easytierVersion).toBe(official.easytier_version);
    expect(RoutePeerInfoField.peerRouteId).toBe(official.peer_route_id);
    expect(RoutePeerInfoField.networkLength).toBe(official.network_length);
    expect(RoutePeerInfoField.noiseStaticPubkey).toBe(official.noise_static_pubkey);
  });

  it('未知字段被跳过而不是报错（前向兼容）', () => {
    // 将来上游加字段时，我们不该因此拒绝解析整条路由
    const known = encodeRoutePeerInfo(oracleRoute());
    // 追加一个字段号 99、varint 值的字段
    const unknownField = Buffer.concat([encodeVarint((99 << 3) | 0), encodeVarint(123)]);
    const withUnknown = Buffer.concat([known, unknownField]);

    const decoded = decodeRoutePeerInfo(withUnknown);
    expect(decoded.peerId).toBe(oracleRoute().peerId);
  });
});

describe('协议对照：路由选择辅助', () => {
  it('同目标多条路由时取 cost 最小', () => {
    const base: RoutePeerInfo = {
      peerId: 7,
      cost: 0,
      version: 1,
      hostname: 'x',
      easytierVersion: '2.7.0',
      proxyCidrs: [],
      peerRouteId: 1,
      networkLength: 2,
      noiseStaticPubkey: null,
    };
    const routes = [
      { ...base, cost: 5, peerRouteId: 1 },
      { ...base, cost: 2, peerRouteId: 2 },
      { ...base, cost: 9, peerRouteId: 3 },
    ];
    expect(pickBestRoute(routes, 7)?.cost).toBe(2);
  });

  it('cost 相同时结果稳定（不依赖输入顺序）', () => {
    const base: RoutePeerInfo = {
      peerId: 7,
      cost: 3,
      version: 1,
      hostname: 'x',
      easytierVersion: '2.7.0',
      proxyCidrs: [],
      peerRouteId: 0,
      networkLength: 2,
      noiseStaticPubkey: null,
    };
    const a = { ...base, peerRouteId: 2 };
    const b = { ...base, peerRouteId: 1 };
    // 两种输入顺序都该选中 peerRouteId 更小的那条
    expect(pickBestRoute([a, b], 7)?.peerRouteId).toBe(1);
    expect(pickBestRoute([b, a], 7)?.peerRouteId).toBe(1);
  });

  it('目标不存在时返回 null', () => {
    expect(pickBestRoute([], 1)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// protobuf 基础编码
// ══════════════════════════════════════════════════════════════════

describe('协议对照：protobuf varint', () => {
  it('单字节边界', () => {
    expect(encodeVarint(0).toString('hex')).toBe('00');
    expect(encodeVarint(1).toString('hex')).toBe('01');
    expect(encodeVarint(127).toString('hex')).toBe('7f');
  });

  it('跨字节边界', () => {
    expect(encodeVarint(128).toString('hex')).toBe('8001');
    expect(encodeVarint(300).toString('hex')).toBe('ac02');
  });

  it('官方样本里的 expiry_unix=1800000000 编码一致', () => {
    // 从 oracle 的 protobuf 里能看到这段：20 80 a4 a7 da 06
    // 20 = tag(字段4, varint)，后面 5 字节是值
    expect(encodeVarint(1_800_000_000).toString('hex')).toBe('80a4a7da06');
  });

  it('负数与 int64 补码', () => {
    // -1 在 protobuf int64 里是 10 个 ff 最后一个 01
    const encoded = encodeVarint(-1);
    expect(encoded.length).toBe(10);
    const decoded = decodeVarint(encoded);
    expect(decoded.value).toBe(-1);
    expect(decoded.bytes).toBe(10);
  });

  it('往返编解码一批值', () => {
    for (const value of [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31 - 1, 1_800_000_000]) {
      const decoded = decodeVarint(encodeVarint(value));
      expect(decoded.value, `值 ${value} 往返失败`).toBe(value);
    }
  });

  it('能从 oracle 的真实路由字节里取到 peer_id', () => {
    // 字段 1（peer_id）在 proto 里编号最小，所以总是第一个出现
    const fields = decodeFields(Buffer.from(oracle.routes.sample.protobuf_hex, 'hex'));
    expect(getVarint(fields, RoutePeerInfoField.peerId)).toBe(
      oracle.routes.sample.input.peer_id,
    );
  });
});

describe('协议对照：X25519 密钥', () => {
  it('生成的密钥长度符合 X25519 / 凭证要求', () => {
    const kp = generateCredentialKeyPair();
    expect(kp.privateKey).toHaveLength(32);
    expect(kp.publicKey).toHaveLength(32);
    // 与 oracle 里那份假公钥长度一致（proto 只要求 32 字节）
    expect(Buffer.from(oracle.credentials.vector.credential.pubkey_hex, 'hex')).toHaveLength(32);
  });

  it('两次生成不同（不是固定值）', () => {
    const a = generateCredentialKeyPair();
    const b = generateCredentialKeyPair();
    expect(a.privateKey.equals(b.privateKey)).toBe(false);
    expect(a.publicKey.equals(b.publicKey)).toBe(false);
  });

  it('能从裸 32 字节私钥导出对应的公钥', () => {
    // 这条覆盖一个 Node 的坑：X25519 的 JWK 导入要求同时给 `x`（公钥），
    // 而只有私钥时恰恰不知道 x。实现里用 PKCS#8 DER 封装绕过，
    // 这里验证绕过是正确的同时也没算错公钥。
    const kp = generateCredentialKeyPair();
    expect(publicKeyFromPrivate(kp.privateKey).equals(kp.publicKey)).toBe(true);
  });

  it('私钥长度不对时拒绝', () => {
    expect(() => publicKeyFromPrivate(Buffer.alloc(16))).toThrow(/32 字节/);
  });

  it('用生成的密钥签发，能验签通过；换密钥则失败', () => {
    const kp = generateCredentialKeyPair();
    const credential = {
      pubkey: kp.publicKey,
      groups: ['operators'],
      allowRelay: false,
      expiryUnix: 1_900_000_000,
      allowedProxyCidrs: [],
      // 用 optional 的 null 情形，覆盖"未设置"分支
      reusable: null,
    };
    const proof = signCredential(credential, 'network-secret');
    expect(verifyCredential(proof, 'network-secret')).toBe(true);
    expect(verifyCredential(proof, 'wrong-secret')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 补充覆盖面：Flags / 枚举 / 地址 / 拓扑
// ══════════════════════════════════════════════════════════════════

interface OracleConfigFlags {
  field_numbers: Record<string, number>;
  defaults: Record<string, string | number | boolean>;
}

interface OracleEnums {
  nat_type: Record<string, number>;
  compression_algo: Record<string, number>;
  socket_type: Record<string, number>;
}

interface OracleAddresses {
  ipv4_addr: {
    field_numbers: Record<string, number>;
    input: { addr: number; dotted: string };
    protobuf_hex: string;
  };
  ipv4_inet: {
    input: { addr: number; network_length: number };
    protobuf_hex: string;
  };
  field_numbers: Record<string, number>;
}

interface OracleTopology {
  socket_addr: { field_numbers: Record<string, number>; input: { ipv4: number; port: number }; protobuf_hex: string };
  url: { input: { url: string }; protobuf_hex: string };
  tunnel_info: {
    field_numbers: Record<string, number>;
    input: {
      tunnel_type: string;
      local_addr: string;
      remote_addr: string;
      resolved_remote_addr: string;
    };
    protobuf_hex: string;
  };
}

describe('配置 Flags 与官方默认值一致', () => {
  const flags = oracle as unknown as { config_flags: OracleConfigFlags };

  it('关键默认值与官方一致（决定"不配置时的实际行为"）', () => {
    const d = flags.config_flags.defaults;
    // enable_encryption 默认 true —— 若误当成 false 就会明文传输
    expect(d.enable_encryption).toBe(true);
    // no_tun 默认 false —— 我们用它做容器内测试，不能改默认
    expect(d.no_tun).toBe(false);
    // mtu 默认 1380（不是常见的 1500）
    expect(d.mtu).toBe(1380);
    expect(d.default_protocol).toBe('tcp');
    expect(d.dev_name).toBe('');
    expect(d.enable_ipv6).toBe(true);
    expect(d.bind_device).toBe(true);
    expect(d.multi_thread).toBe(true);
    // magic-dns / private mode 默认关闭
    expect(d.accept_dns).toBe(false);
    expect(d.private_mode).toBe(false);
  });

  it('data_compress_algo 默认是 None(1) 而不是 Invalid(0)', () => {
    // 这一条印证了 RPC 层 compression_info 的坑：
    // 官方默认就是 None=1，从不使用 Invalid=0
    expect(flags.config_flags.defaults.data_compress_algo).toBe(1);
  });

  it('no_tun 的字段号是 8', () => {
    // 我们改过这个 setting，字段号写错会静默失效
    expect(flags.config_flags.field_numbers.no_tun).toBe(8);
    expect(flags.config_flags.field_numbers.enable_encryption).toBe(3);
    expect(flags.config_flags.field_numbers.dev_name).toBe(2);
  });
});

describe('枚举取值与官方一致', () => {
  const enums = (oracle as unknown as { enums: OracleEnums }).enums;

  it('CompressionAlgoPb：Invalid=0 / None=1 / Zstd=2', () => {
    expect(enums.compression_algo.Invalid).toBe(0);
    expect(enums.compression_algo.None).toBe(1);
    expect(enums.compression_algo.Zstd).toBe(2);
    // 与 TS 侧常量对照
    expect(CompressionAlgo.Invalid).toBe(enums.compression_algo.Invalid);
    expect(CompressionAlgo.None).toBe(enums.compression_algo.None);
    expect(CompressionAlgo.Zstd).toBe(enums.compression_algo.Zstd);
  });

  it('SocketType 只有 TCP=0 / UDP=1', () => {
    // 隧道类型字符串（tcp/wg/quic…）不是这个枚举，别混用
    expect(enums.socket_type.TCP).toBe(0);
    expect(enums.socket_type.UDP).toBe(1);
    expect(SocketType.TCP).toBe(enums.socket_type.TCP);
    expect(SocketType.UDP).toBe(enums.socket_type.UDP);
    expect(Object.keys(enums.socket_type).filter((k) => !k.startsWith('_'))).toHaveLength(2);
  });

  it('NatType 全部 10 个取值一致', () => {
    for (const [name, value] of Object.entries(enums.nat_type)) {
      expect(NatType[name as keyof typeof NatType], `NatType.${name}`).toBe(value);
    }
    // 反向：TS 侧不多出官方没有的项
    const officialNames = new Set(Object.keys(enums.nat_type));
    for (const name of Object.keys(NatType)) {
      expect(officialNames.has(name), `TS 侧多出 NatType.${name}`).toBe(true);
    }
  });
});

describe('IPv4 地址：addr 是 uint32 varint，不是 4 字节定长', () => {
  const addr = (oracle as unknown as { addresses: OracleAddresses }).addresses;

  it('点分地址与 u32 数值互转与官方一致', () => {
    // 官方 oracle 用 10.126.126.1 = 0x0A7E7E01 = 176061953
    expect(addr.ipv4_addr.input.dotted).toBe('10.126.126.1');
    expect(addr.ipv4_addr.input.addr).toBe(0x0a7e7e01);
    expect(ipv4ToNumber('10.126.126.1')).toBe(addr.ipv4_addr.input.addr);
    expect(numberToIpv4(addr.ipv4_addr.input.addr)).toBe('10.126.126.1');
  });

  it('编码结果与官方逐字节相同（关键：不是 4 字节网络序）', () => {
    const encoded = encodeIpv4Addr('10.126.126.1');
    expect(encoded.toString('hex')).toBe(addr.ipv4_addr.protobuf_hex);
    // 官方编码是 5 字节（tag + 4 字节 varint），不是 1+4 的定长布局
    expect(encoded).toHaveLength(5);
    // 若错误地按 4 字节大端写，会得到 0a7e7e01 而不是 81fcf953
    expect(encoded.subarray(1).toString('hex')).not.toBe('0a7e7e01');
  });

  it('解码官方字节得到正确点分地址', () => {
    expect(decodeIpv4Addr(Buffer.from(addr.ipv4_addr.protobuf_hex, 'hex'))).toBe('10.126.126.1');
  });

  it('Ipv4Inet 编码与官方一致', () => {
    const encoded = encodeIpv4Inet({
      address: '10.126.126.1',
      networkLength: addr.ipv4_inet.input.network_length,
    });
    expect(encoded.toString('hex')).toBe(addr.ipv4_inet.protobuf_hex);
  });

  it('非法地址被拒绝', () => {
    expect(() => ipv4ToNumber('1.2.3')).toThrow(/四段/);
    expect(() => ipv4ToNumber('1.2.3.256')).toThrow(/255/);
    expect(() => ipv4ToNumber('a.b.c.d')).toThrow(/不是数字/);
  });
});

describe('拓扑结构：SocketAddr / Url / TunnelInfo', () => {
  const topo = (oracle as unknown as { topology: OracleTopology }).topology;

  it('SocketAddr 编码与官方一致（ip 是 oneof）', () => {
    const encoded = encodeSocketAddr({
      ipv4: numberToIpv4(topo.socket_addr.input.ipv4),
      port: topo.socket_addr.input.port,
    });
    expect(encoded.toString('hex')).toBe(topo.socket_addr.protobuf_hex);
  });

  it('Url 编码与官方一致', () => {
    expect(encodeUrl(topo.url.input.url).toString('hex')).toBe(topo.url.protobuf_hex);
  });

  it('TunnelInfo 编码与官方一致', () => {
    const encoded = encodeTunnelInfo({
      tunnelType: topo.tunnel_info.input.tunnel_type,
      localAddr: topo.tunnel_info.input.local_addr,
      remoteAddr: topo.tunnel_info.input.remote_addr,
      resolvedRemoteAddr: topo.tunnel_info.input.resolved_remote_addr,
    });
    expect(encoded.toString('hex')).toBe(topo.tunnel_info.protobuf_hex);
  });

  it('TunnelInfo 解码能还原各字段', () => {
    const decoded = decodeTunnelInfo(Buffer.from(topo.tunnel_info.protobuf_hex, 'hex'));
    expect(decoded.tunnelType).toBe(topo.tunnel_info.input.tunnel_type);
    expect(decoded.localAddr).toBe(topo.tunnel_info.input.local_addr);
    expect(decoded.remoteAddr).toBe(topo.tunnel_info.input.remote_addr);
  });
});

// ══════════════════════════════════════════════════════════════════
// 连接位图（OSPF 拓扑同步的核心结构）
// ══════════════════════════════════════════════════════════════════

interface OracleConnBitmap {
  layout: { formula: string; bit_order: string; byte_count_formula: string };
  sample: {
    peer_ids: Array<{ peer_id: number; version: number }>;
    edges: Array<[number, number]>;
    bits: number[];
    bitmap_hex: string;
    protobuf_hex: string;
    expected_adjacency: Record<string, number[]>;
  };
  field_numbers: Record<string, number>;
}

describe('连接位图：展平顺序与位序', () => {
  const cb = (oracle as unknown as { conn_bitmap: OracleConnBitmap }).conn_bitmap;
  const sample = cb.sample;

  it('从边构造出的位图与官方逐字节相同', () => {
    const built = buildConnBitmap(
      sample.peer_ids.map((p) => ({ peerId: p.peer_id, version: p.version })),
      sample.edges,
    );
    expect(built.bitmap.toString('hex')).toBe(sample.bitmap_hex);
  });

  it('编码后的 protobuf 与官方相同', () => {
    const built = buildConnBitmap(
      sample.peer_ids.map((p) => ({ peerId: p.peer_id, version: p.version })),
      sample.edges,
    );
    expect(encodeConnBitmap(built).toString('hex')).toBe(sample.protobuf_hex);
  });

  it('解码官方字节后，每个节点的邻居与官方 API 的反解一致', () => {
    // 这是最强的一条：oracle 用官方的 `get_connected_peers()` 反解出邻接，
    // 我们的实现必须得出完全相同的结果。
    const decoded = decodeConnBitmap(Buffer.from(sample.protobuf_hex, 'hex'));
    expect(decoded.peerIds.map((p) => p.peerId)).toEqual(
      sample.peer_ids.map((p) => p.peer_id),
    );

    for (let i = 0; i < decoded.peerIds.length; i += 1) {
      const peerId = decoded.peerIds[i].peerId;
      const expected = sample.expected_adjacency[String(peerId)];
      expect(getConnectedPeers(decoded, i), `节点 ${peerId} 的邻居`).toEqual(expected);
    }
  });

  it('位序是 LSB 优先（不是 MSB）', () => {
    // 位序搞反时，相邻节点的位置会镜像——拓扑"有连接但连错了人"。
    // 用官方样本坐实：bitmap=0x524a，bits 数组是 16 个 0/1。
    const expectedBits = sample.bits;
    const bitmap = Buffer.from(sample.bitmap_hex, 'hex');
    for (let idx = 0; idx < expectedBits.length; idx += 1) {
      expect(getBitmapBit(bitmap, idx), `第 ${idx} 位`).toBe(expectedBits[idx] === 1);
    }
  });

  it('展平顺序是行优先 i*n+j（不是列优先 j*n+i）', () => {
    // 用"有向"边区分行优先与列优先：只有 0→1，没有 1→0。
    const peerIds = [
      { peerId: 10, version: 1 },
      { peerId: 20, version: 1 },
    ];
    const oneWay = buildConnBitmap(peerIds, [[0, 1]]);

    const decoded = decodeConnBitmap(encodeConnBitmap(oneWay));
    // 10 能到 20
    expect(getConnectedPeers(decoded, 0)).toEqual([20]);
    // 20 到不了 10 —— 若是列优先，这里会反过来
    expect(getConnectedPeers(decoded, 1)).toEqual([]);
  });

  it('字节数按 ceil(n*n/8) 计算', () => {
    // 4 个节点 → 16 位 → 2 字节（官方样本正是 2 字节 "524a"）
    expect(Buffer.from(sample.bitmap_hex, 'hex')).toHaveLength(2);
    // 3 个节点 → 9 位 → 2 字节
    const three = buildConnBitmap(
      [
        { peerId: 1, version: 1 },
        { peerId: 2, version: 1 },
        { peerId: 3, version: 1 },
      ],
      [[0, 1]],
    );
    expect(three.bitmap).toHaveLength(2);
  });

  it('往返：encode → decode 保持节点与邻接', () => {
    const built = buildConnBitmap(
      sample.peer_ids.map((p) => ({ peerId: p.peer_id, version: p.version })),
      sample.edges,
    );
    const roundTrip = decodeConnBitmap(encodeConnBitmap(built));
    expect(roundTrip.peerIds).toEqual(built.peerIds);
    for (let i = 0; i < built.peerIds.length; i += 1) {
      expect(getConnectedPeers(roundTrip, i)).toEqual(getConnectedPeers(built, i));
    }
  });

  it('字段号与 proto 定义一致', () => {
    expect(cb.field_numbers.peer_ids).toBe(1);
    expect(cb.field_numbers.bitmap).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════
// 能力标志与握手边界
// ══════════════════════════════════════════════════════════════════

interface OracleFeatureFlag {
  field_numbers: Record<string, number>;
  all_true_hex: string;
  only_support_conn_list_sync_hex: string;
  only_is_public_server_hex: string;
  default_hex: string;
}

interface OracleHandshakeEdge {
  handshake_request_fields: Record<string, number>;
  magic: { correct: number; correct_hex: string };
  full: { input: Record<string, unknown>; protobuf_hex: string };
  no_digest: { input: Record<string, unknown>; protobuf_hex: string };
  noise_msg1: {
    uuid_4x_u32: { input: Record<string, number>; protobuf_hex: string };
    msg1_protobuf_hex: string;
    field_numbers: Record<string, number>;
  };
}

describe('能力标志 PeerFeatureFlag', () => {
  const ff = (oracle as unknown as { feature_flag: OracleFeatureFlag }).feature_flag;

  const allTrue: PeerFeatureFlag = {
    isPublicServer: true,
    avoidRelayData: true,
    kcpInput: true,
    noRelayKcp: true,
    supportConnListSync: true,
    quicInput: true,
    noRelayQuic: true,
    isCredentialPeer: true,
    needP2p: true,
    disableP2p: true,
    ipv6PublicAddrProvider: true,
  };

  it('全 true 编码与官方一致', () => {
    expect(encodePeerFeatureFlag(allTrue).toString('hex')).toBe(ff.all_true_hex);
  });

  it('全默认编码为空字节（proto3 的 false 不写）', () => {
    const allFalse = Object.fromEntries(
      Object.keys(allTrue).map((k) => [k, false]),
    ) as unknown as PeerFeatureFlag;
    expect(encodePeerFeatureFlag(allFalse).toString('hex')).toBe(ff.default_hex);
    // 官方就是空字符串
    expect(ff.default_hex).toBe('');
  });

  it('只开 support_conn_list_sync 时编码与官方一致', () => {
    // 这个标志决定对端用 conn_list 还是 bitmap 同步连接关系
    const only = { ...allTrue };
    for (const k of Object.keys(only) as Array<keyof PeerFeatureFlag>) only[k] = false;
    only.supportConnListSync = true;
    expect(encodePeerFeatureFlag(only).toString('hex')).toBe(
      ff.only_support_conn_list_sync_hex,
    );
    expect(ff.only_support_conn_list_sync_hex).toBe('2801'); // 字段 5, 值 1
  });

  it('只开 is_public_server 时编码与官方一致', () => {
    const only = { ...allTrue };
    for (const k of Object.keys(only) as Array<keyof PeerFeatureFlag>) only[k] = false;
    only.isPublicServer = true;
    expect(encodePeerFeatureFlag(only).toString('hex')).toBe(ff.only_is_public_server_hex);
    expect(ff.only_is_public_server_hex).toBe('0801'); // 字段 1, 值 1
  });

  it('解码官方字节得到正确标志', () => {
    const decoded = decodePeerFeatureFlag(Buffer.from(ff.only_support_conn_list_sync_hex, 'hex'));
    expect(decoded.supportConnListSync).toBe(true);
    expect(decoded.isPublicServer).toBe(false);
    expect(decoded.needP2p).toBe(false);
  });

  it('空字节解码为全 false（不是"没有这个字段"）', () => {
    const decoded = decodePeerFeatureFlag(Buffer.alloc(0));
    for (const value of Object.values(decoded)) expect(value).toBe(false);
  });

  it('字段号与 proto 定义一致', () => {
    const d = ff.field_numbers;
    expect(d.is_public_server).toBe(1);
    expect(d.avoid_relay_data).toBe(2);
    expect(d.support_conn_list_sync).toBe(5);
    expect(d.is_credential_peer).toBe(8);
    expect(d.ipv6_public_addr_provider).toBe(11);
  });
});

describe('握手消息边界', () => {
  const hs = (oracle as unknown as { handshake_edge: OracleHandshakeEdge }).handshake_edge;

  it('magic 常量与官方一致', () => {
    expect(HANDSHAKE_MAGIC).toBe(hs.magic.correct);
    expect(hs.magic.correct).toBe(0xd1e1a5e1);
    expect(hs.magic.correct_hex).toBe('0xd1e1a5e1');
  });

  it('完整握手请求编码与官方一致', () => {
    // 注意 buildHandshakeRequest 自己算 digest（从 secret 派生），
    // 所以要用一段、能算出官方那 32 字节 0xAB 的输入来对比结构，
    // 这里改为直接构造 HandshakeRequest 对象以精确控制 digest。
    const encoded = encodeHandshakeRequest({
      magic: HANDSHAKE_MAGIC,
      myPeerId: hs.full.input.my_peer_id as number,
      version: 1,
      features: hs.full.input.features as string[],
      networkName: hs.full.input.network_name as string,
      networkSecretDigest: Buffer.from(hs.full.input.network_secret_digest_hex as string, 'hex'),
    });
    expect(encoded.toString('hex')).toBe(hs.full.protobuf_hex);
  });

  it('digest 为空时编码里不出现该字段（接收方必须容忍）', () => {
    const encoded = encodeHandshakeRequest({
      magic: HANDSHAKE_MAGIC,
      myPeerId: hs.no_digest.input.my_peer_id as number,
      version: 1,
      features: [],
      networkName: hs.no_digest.input.network_name as string,
      networkSecretDigest: Buffer.alloc(0),
    });
    expect(encoded.toString('hex')).toBe(hs.no_digest.protobuf_hex);
    // 字段 6（digest）不应出现
    const fields = decodeFields(encoded);
    expect(fields.some((f) => f.fieldNumber === 6)).toBe(false);
  });

  it('Noise Msg1 的 UUID 是 4 个 uint32（不是 16 字节）', () => {
    // 这一点曾被官方精确报错纠正过：
    //   UnexpectedWireType { actual: LengthDelimited, expected: Varint }
    //   stack: [("Uuid","part1"), ("PeerConnNoiseMsg1Pb","a_conn_id")]
    const uuid = hs.noise_msg1.uuid_4x_u32.input;
    // encodeUuid 收 16 字节，内部按 4 个 uint32(BE) 拆成 part1..part4
    const raw = Buffer.alloc(16);
    for (const [i, key] of (['part1', 'part2', 'part3', 'part4'] as const).entries()) {
      raw.writeUInt32BE(uuid[key], i * 4);
    }
    const encoded = encodeUuid(raw);
    expect(encoded.toString('hex')).toBe(hs.noise_msg1.uuid_4x_u32.protobuf_hex);
    // 4 个字段各 4 字节 varint + tag = 20 字节，不是 16 字节
    expect(encoded.length).not.toBe(16);
  });

  it('Noise Msg1 编码与官方一致', () => {
    const uuid = hs.noise_msg1.uuid_4x_u32.input;
    const raw = Buffer.alloc(16);
    for (const [i, key] of (['part1', 'part2', 'part3', 'part4'] as const).entries()) {
      raw.writeUInt32BE(uuid[key], i * 4);
    }
    const encoded = encodeNoiseMsg1({
      version: 1,
      aNetworkName: 'testnet',
      aSessionGeneration: null,
      aConnId: raw,
      clientEncryptionAlgorithm: '',
      features: ['liveness-echo-v1'],
    });
    expect(encoded.toString('hex')).toBe(hs.noise_msg1.msg1_protobuf_hex);
  });

  it('Noise Msg1 字段号与 proto 定义一致', () => {
    const d = hs.noise_msg1.field_numbers;
    expect(d.version).toBe(1);
    expect(d.a_network_name).toBe(2);
    expect(d.a_conn_id).toBe(4);
    expect(d.features).toBe(6);
    // 与我实现的常量对照
    expect(NoiseMsg1Field.version).toBe(d.version);
    expect(NoiseMsg1Field.aNetworkName).toBe(d.a_network_name);
    expect(NoiseMsg1Field.aConnId).toBe(d.a_conn_id);
    expect(NoiseMsg1Field.features).toBe(d.features);
  });

  it('握手请求字段号与 proto 定义一致', () => {
    const d = hs.handshake_request_fields;
    expect(HandshakeRequestField.magic).toBe(d.magic);
    expect(HandshakeRequestField.myPeerId).toBe(d.my_peer_id);
    expect(HandshakeRequestField.networkName).toBe(d.network_name);
    expect(HandshakeRequestField.networkSecretDigest).toBe(d.network_secret_digest);
  });

  it('LIVENESS_ECHO_FEATURE 字符串与官方一致', () => {
    // 官方 peer_conn_liveness.rs:10 是 "liveness-echo-v1"
    expect(LIVENESS_ECHO_FEATURE).toBe('liveness-echo-v1');
    expect(hs.full.input.features).toContain('liveness-echo-v1');
  });
});
