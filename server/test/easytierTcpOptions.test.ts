import { describe, expect, it } from 'vitest';
import {
  TcpOptionKind,
  buildTcpSegment,
  decodeTcpHeader,
  decodeTcpOptions,
  encodeTcpOptions,
  internetChecksum,
  ipToInt,
} from '../src/networking/easytier/ip';

/**
 * TCP 选项编解码（SACK 的基础）。
 *
 * 之前完全没有选项支持：`dataOffset` 固定写死 5（20 字节头），所以
 * **没法协商或上报 SACK**。而 SACK 是"只重传真正丢的那段"的前提——
 * 没有它只能靠重复 ACK 猜或等超时。
 *
 * 三个容易错的地方：
 * 1. `dataOffset` 必须随选项长度变化（单位是 4 字节）
 * 2. 选项必须补齐到 4 字节边界
 * 3. 校验和要覆盖包含选项的整个头部
 */

const SRC = '10.126.231.1';
const DST = '10.126.231.2';

describe('TCP 选项编解码', () => {
  it('SACK permitted 往返（SYN 里协商用）', () => {
    const encoded = encodeTcpOptions([{ kind: TcpOptionKind.SACK_PERMITTED }]);
    // kind=4, length=2，再补 2 字节 END 对齐到 4
    expect(encoded.length).toBe(4);
    const decoded = decodeTcpOptions(encoded);
    expect(decoded).toEqual([{ kind: TcpOptionKind.SACK_PERMITTED }]);
  });

  it('SACK 块往返（上报乱序到达的区间）', () => {
    const blocks = [
      { left: 1000, right: 2000 },
      { left: 3000, right: 3500 },
    ];
    const encoded = encodeTcpOptions([{ kind: TcpOptionKind.SACK, blocks }]);
    // 2 + 2*8 = 18，补齐到 20
    expect(encoded.length).toBe(20);
    const decoded = decodeTcpOptions(encoded);
    expect(decoded).toEqual([{ kind: TcpOptionKind.SACK, blocks }]);
  });

  it('MSS 与窗口扩大因子能往返', () => {
    const encoded = encodeTcpOptions([
      { kind: TcpOptionKind.MSS, mss: 1340 },
      { kind: TcpOptionKind.WINDOW_SCALE, shift: 7 },
    ]);
    const decoded = decodeTcpOptions(encoded);
    expect(decoded).toContainEqual({ kind: TcpOptionKind.MSS, mss: 1340 });
    expect(decoded).toContainEqual({ kind: TcpOptionKind.WINDOW_SCALE, shift: 7 });
  });

  it('选项补齐到 4 字节边界', () => {
    for (const options of [
      [{ kind: TcpOptionKind.NOP } as const],
      [{ kind: TcpOptionKind.MSS, mss: 1400 } as const],
      [{ kind: TcpOptionKind.SACK, blocks: [{ left: 1, right: 2 }] } as const],
    ]) {
      expect(encodeTcpOptions([...options]).length % 4).toBe(0);
    }
  });

  it('格式错误的选项不会抛错，只是停止解析', () => {
    // 一个坏选项不该让整条连接失败
    const malformed = Buffer.from([TcpOptionKind.MSS, 1, 0, 0]); // length < 2
    expect(() => decodeTcpOptions(malformed)).not.toThrow();
    expect(decodeTcpOptions(malformed)).toEqual([]);
  });

  it('END 之后的字节被忽略', () => {
    const withGarbage = Buffer.concat([
      encodeTcpOptions([{ kind: TcpOptionKind.SACK_PERMITTED }]),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
    ]);
    const decoded = decodeTcpOptions(withGarbage);
    expect(decoded).toEqual([{ kind: TcpOptionKind.SACK_PERMITTED }]);
  });
});

describe('带选项的 TCP 段', () => {
  it('dataOffset 随选项长度变化', () => {
    const withoutOptions = buildTcpSegment({
      srcPort: 1, dstPort: 2, seq: 0, ack: 0,
      flags: 0x02, window: 100, srcIp: SRC, dstIp: DST,
    });
    expect(decodeTcpHeader(withoutOptions)!.dataOffset).toBe(20);

    const withOptions = buildTcpSegment({
      srcPort: 1, dstPort: 2, seq: 0, ack: 0,
      flags: 0x02, window: 100, srcIp: SRC, dstIp: DST,
      tcpOptions: [
        { kind: TcpOptionKind.MSS, mss: 1340 },
        { kind: TcpOptionKind.SACK_PERMITTED },
      ],
    });
    // 4 + 4 = 8 字节选项 → 头部 28 字节
    expect(decodeTcpHeader(withOptions)!.dataOffset).toBe(28);
  });

  it('带选项时校验和仍然正确（覆盖整个头）', () => {
    const segment = buildTcpSegment({
      srcPort: 1, dstPort: 2, seq: 0, ack: 0,
      flags: 0x02, window: 100, srcIp: SRC, dstIp: DST,
      tcpOptions: [{ kind: TcpOptionKind.SACK, blocks: [{ left: 100, right: 200 }] }],
    });
    const pseudo = Buffer.alloc(12);
    pseudo.writeUInt32BE(ipToInt(SRC), 0);
    pseudo.writeUInt32BE(ipToInt(DST), 4);
    pseudo[9] = 6;
    pseudo.writeUInt16BE(segment.length, 10);
    expect(internetChecksum(Buffer.concat([pseudo, segment]))).toBe(0);
  });

  it('载荷与选项同时存在时都能正确解出', () => {
    const payload = Buffer.from('hello');
    const segment = buildTcpSegment({
      srcPort: 1, dstPort: 2, seq: 0, ack: 0,
      flags: 0x18, window: 100, payload,
      srcIp: SRC, dstIp: DST,
      tcpOptions: [{ kind: TcpOptionKind.SACK, blocks: [{ left: 1, right: 2 }] }],
    });
    const header = decodeTcpHeader(segment)!;
    expect(segment.subarray(header.dataOffset).toString()).toBe('hello');
    const options = decodeTcpOptions(segment.subarray(20, header.dataOffset));
    expect(options[0].kind).toBe(TcpOptionKind.SACK);
  });
});
