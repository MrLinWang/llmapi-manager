import { describe, expect, it } from 'vitest';
import {
  PEER_MANAGER_HEADER_SIZE,
  PacketType,
  PeerManagerHeaderFlags,
  decodeHeader,
  encodeHeader,
  hasFlag,
  isHandshakePacket,
  setFlag,
  type PeerManagerHeader,
} from '../src/networking/easytier/protocol';
import { PeerParseError, normalizePeers, parsePeer, validatePeer } from '../src/networking/easytier/peer';
import {
  LIVENESS_ECHO_FEATURE,
  NOISE_PATTERN,
  NOISE_PROLOGUE,
  X25519_PUBLIC_KEY_BYTES,
  createHandshakeParams,
  createNoiseMsg1,
} from '../src/networking/easytier/noise';

/**
 * EasyTier 协议层的对照测试。
 *
 * 这些断言的作用是把"我们对协议的理解"变成可检验的东西。每一条都对应
 * `ref/EasyTier/` 里的某处源码——如果哪天上游改了协议，这些测试会先失败，
 * 而不是等到两台机器连不上才发现。
 */

describe('EasyTier 协议：包头编解码', () => {
  const sample: PeerManagerHeader = {
    fromPeerId: 0x01020304,
    toPeerId: 0x0a0b0c0d,
    packetType: PacketType.Data,
    flags: PeerManagerHeaderFlags.ENCRYPTED | PeerManagerHeaderFlags.LATENCY_FIRST,
    forwardCounter: 3,
    len: 1400,
  };

  it('包头固定 16 字节（对照 PeerManagerHeader 的 repr(C, packed)）', () => {
    // 布局：u32 + u32 + u8 + u8 + u8 + u8(reserved) + u32 = 16
    expect(PEER_MANAGER_HEADER_SIZE).toBe(16);
    expect(encodeHeader(sample)).toHaveLength(16);
  });

  it('往返编解码保持所有字段', () => {
    const decoded = decodeHeader(encodeHeader(sample));
    expect(decoded).toEqual(sample);
  });

  it('字节序是 little-endian（DefaultEndian = LittleEndian）', () => {
    // 这条最容易搞错：用大端写出来的包能通过自己的往返测试，
    // 却与官方节点完全无法通信。所以直接断言线上字节。
    const buffer = encodeHeader({ ...sample, fromPeerId: 0x01020304 });
    expect([...buffer.subarray(0, 4)]).toEqual([0x04, 0x03, 0x02, 0x01]);

    const lenBuffer = encodeHeader({ ...sample, len: 0x00000100 });
    expect([...lenBuffer.subarray(12, 16)]).toEqual([0x00, 0x01, 0x00, 0x00]);
  });

  it('reserved 字节必须占位，否则 len 会错位', () => {
    const buffer = encodeHeader(sample);
    // 第 11 字节是 Rust 里的私有 reserved 字段
    expect(buffer[11]).toBe(0);
    // len 从第 12 字节开始——如果 reserved 被优化掉，这里会读到 0
    expect(buffer.readUInt32LE(12)).toBe(1400);
  });

  it('数据不足 16 字节时返回 null（半包）', () => {
    expect(decodeHeader(Buffer.alloc(15))).toBeNull();
    expect(decodeHeader(Buffer.alloc(0))).toBeNull();
  });

  it('PacketType 数值与 Rust 枚举一致', () => {
    // 这些是线上字节，改一个数字就意味着与官方节点无法通信
    expect(PacketType.Invalid).toBe(0);
    expect(PacketType.Data).toBe(1);
    expect(PacketType.HandShake).toBe(2);
    expect(PacketType.Ping).toBe(4);
    expect(PacketType.NoiseHandshakeMsg1).toBe(13);
    expect(PacketType.NoiseHandshakeMsg2).toBe(14);
    expect(PacketType.NoiseHandshakeMsg3).toBe(15);
    expect(PacketType.RelayHandshake).toBe(20);
  });

  it('标志位与 PeerManagerHeaderFlags 的 bitflags 一致', () => {
    expect(PeerManagerHeaderFlags.ENCRYPTED).toBe(0b0000_0001);
    expect(PeerManagerHeaderFlags.COMPRESSED).toBe(0b0001_0000);
    expect(PeerManagerHeaderFlags.LIVENESS_ECHO).toBe(0b1000_0000);
  });

  it('标志位读写不互相干扰', () => {
    const encrypted = setFlag(sample, PeerManagerHeaderFlags.EXIT_NODE, true);
    expect(hasFlag(encrypted, PeerManagerHeaderFlags.ENCRYPTED)).toBe(true);
    expect(hasFlag(encrypted, PeerManagerHeaderFlags.EXIT_NODE)).toBe(true);

    const cleared = setFlag(encrypted, PeerManagerHeaderFlags.ENCRYPTED, false);
    expect(hasFlag(cleared, PeerManagerHeaderFlags.ENCRYPTED)).toBe(false);
    expect(hasFlag(cleared, PeerManagerHeaderFlags.EXIT_NODE)).toBe(true);
  });

  it('握手包判定与 peer_conn.rs 的判定一致', () => {
    expect(isHandshakePacket(PacketType.NoiseHandshakeMsg1)).toBe(true);
    expect(isHandshakePacket(PacketType.NoiseHandshakeMsg3)).toBe(true);
    expect(isHandshakePacket(PacketType.RelayHandshake)).toBe(true);
    expect(isHandshakePacket(PacketType.RelayHandshakeAck)).toBe(true);
    // 数据包不是握手包
    expect(isHandshakePacket(PacketType.Data)).toBe(false);
    expect(isHandshakePacket(PacketType.Ping)).toBe(false);
  });
});

describe('EasyTier 协议：peer 地址解析', () => {
  it('接受官方的中继地址格式', () => {
    const parsed = parsePeer('tcp://public.easytier.cn:11010');
    expect(parsed.scheme).toBe('tcp');
    expect(parsed.host).toBe('public.easytier.cn');
    expect(parsed.port).toBe(11010);
  });

  it('支持官方列出的传输协议', () => {
    for (const scheme of ['tcp', 'udp', 'wg', 'quic', 'wss']) {
      const parsed = parsePeer(`${scheme}://example.com:11010`);
      expect(parsed.scheme).toBe(scheme);
    }
  });

  it('缺少 scheme 时给出可操作的提示（用户最常犯的错）', () => {
    try {
      parsePeer('public.easytier.cn:11010');
      throw new Error('应该抛错');
    } catch (cause) {
      expect(cause).toBeInstanceOf(PeerParseError);
      // 提示里必须包含正确写法，否则用户只知道错了不知道该怎么改
      expect((cause as Error).message).toContain('tcp://');
    }
  });

  it('缺少端口时报错并给出示例', () => {
    try {
      parsePeer('tcp://example.com');
      throw new Error('应该抛错');
    } catch (cause) {
      expect((cause as Error).message).toContain('端口');
    }
  });

  it('拒绝不支持的协议', () => {
    expect(() => parsePeer('http://example.com:80')).toThrow(PeerParseError);
  });

  it('端口越界被拒', () => {
    expect(() => parsePeer('tcp://example.com:0')).toThrow(PeerParseError);
    expect(() => parsePeer('tcp://example.com:70000')).toThrow(PeerParseError);
  });

  it('规范化后去掉多余空白与默认端口写法', () => {
    expect(parsePeer('  tcp://example.com:11010  ').normalized).toBe('tcp://example.com:11010');
  });

  it('去重时保持顺序', () => {
    const normalized = normalizePeers([
      'tcp://a.com:11010',
      'tcp://b.com:11010',
      'tcp://a.com:11010', // 重复
    ]);
    expect(normalized).toEqual(['tcp://a.com:11010', 'tcp://b.com:11010']);
  });

  it('validatePeer 不抛异常，供界面实时提示用', () => {
    const good = validatePeer('tcp://a.com:11010');
    expect(good.ok).toBe(true);
    expect(good.normalized).toBe('tcp://a.com:11010');

    const bad = validatePeer('a.com');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('tcp://');
  });
});

describe('EasyTier 协议：Noise 握手参数', () => {
  // 这些字符串写错一个字符，表现都是"握手超时"且没有任何提示。
  // 所以直接钉死，改这里必须先确认与 peer_conn.rs 一致。

  it('握手模式与源码一致（peer_conn.rs:788）', () => {
    expect(NOISE_PATTERN).toBe('Noise_XX_25519_ChaChaPoly_SHA256');
  });

  it('prologue 与源码一致（peer_conn.rs:786）', () => {
    expect(NOISE_PROLOGUE.toString('utf8')).toBe('easytier-peerconn-noise');
  });

  it('生成的私钥长度符合 X25519 要求', () => {
    const params = createHandshakeParams();
    expect(params.localPrivateKey).toHaveLength(X25519_PUBLIC_KEY_BYTES);
    expect(params.pattern).toBe(NOISE_PATTERN);
    expect(params.prologue.equals(NOISE_PROLOGUE)).toBe(true);
  });

  it('两次生成的私钥不同（不是固定值）', () => {
    const a = createHandshakeParams();
    const b = createHandshakeParams();
    expect(a.localPrivateKey.equals(b.localPrivateKey)).toBe(false);
  });

  it('拒绝长度不对的私钥与钉扎公钥', () => {
    expect(() => createHandshakeParams({ localPrivateKey: Buffer.alloc(16) })).toThrow(
      /32 字节/,
    );
    expect(() =>
      createHandshakeParams({ pinnedRemotePublicKey: Buffer.alloc(31) }),
    ).toThrow(/32 字节/);
  });

  it('钉扎公钥长度正确时可接受', () => {
    const pinned = Buffer.alloc(32, 7);
    const params = createHandshakeParams({ pinnedRemotePublicKey: pinned });
    expect(params.pinnedRemotePublicKey?.equals(pinned)).toBe(true);
  });

  it('Msg1 载荷包含网络名与 liveness echo 能力（peer_conn.rs:810-818）', () => {
    const msg1 = createNoiseMsg1({ version: '2.7.0', networkName: 'llmapi' });
    expect(msg1.networkName).toBe('llmapi');
    expect(msg1.version).toBe('2.7.0');
    // Rust 侧固定带上这个 feature；漏掉不影响握手但会让对端不做回声探测
    expect(msg1.features).toContain(LIVENESS_ECHO_FEATURE);
  });

  it('conn_id 是合法 UUID v4', () => {
    const msg1 = createNoiseMsg1({ version: '2.7.0', networkName: 'llmapi' });
    expect(msg1.connId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('每次握手生成的 conn_id 不同', () => {
    const a = createNoiseMsg1({ version: '2.7.0', networkName: 'llmapi' });
    const b = createNoiseMsg1({ version: '2.7.0', networkName: 'llmapi' });
    expect(a.connId).not.toBe(b.connId);
  });

  it('网络名为空时拒绝（它是网络隔离的依据）', () => {
    expect(() => createNoiseMsg1({ version: '2.7.0', networkName: '  ' })).toThrow(
      /网络隔离/,
    );
  });
});
