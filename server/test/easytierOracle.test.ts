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
