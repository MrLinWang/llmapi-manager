/**
 * 最小 protobuf 编解码（wire format）。
 *
 * ## 为什么自己写而不引第三方库
 *
 * 只需要几个固定 message 的编解码，引入 `protobufjs` 会带来：
 * schema 文件管理、异步初始化、以及"库版本决定行为"的不确定性。
 * 而这几十行代码的行为是**完全确定的**，且能被官方 oracle 的字节逐条验证
 * （见 `server/test/easytierOracle.test.ts`）——这比依赖一个库更可信。
 *
 * ## 正确性依据
 *
 * 所有行为都对照 `easytier-proto` 的真实序列化输出验证，包括：
 * - varint 编码（含大数：`expiry_unix` 这类 int64）
 * - length-delimited 的 tag + 长度 + 内容
 * - **proto3 不序列化默认值**（`peer_id = 0` 不出现在字节里）
 * - `optional` 字段的 presence 有意义（`reusable: false` 与"未设置"不同）
 *
 * 最后一条最容易错：proto3 里普通标量字段取默认值时不写，但 `optional`
 * 标量一旦被显式设置（哪怕是 false/0），**必须写出来**。混为一谈会导致
 * 我们生成的凭证 HMAC 与官方对不上。
 */

/** protobuf 的 wire type。只实现用得到的两种。 */
export const WireType = {
  VARINT: 0,
  LENGTH_DELIMITED: 2,
} as const;

export type WireTypeValue = (typeof WireType)[keyof typeof WireType];

/** 编码 varint。负数按 protobuf 规则要编码成 64 位补码（10 字节）。 */
export function encodeVarint(value: number): Buffer {
  // protobuf 的 int64 用补码表示负数（10 字节），但 int32 用 5 字节。
  // 本文件用到的负数场景只有 int64（expiry_unix 可能是负数），
  // 所以按 64 位处理。
  const bytes: number[] = [];
  let big = BigInt(value);

  if (big < 0n) {
    // 转成无符号 64 位补码
    big += 1n << 64n;
  }

  while (big > 0x7fn) {
    bytes.push(Number((big & 0x7fn) | 0x80n));
    big >>= 7n;
  }
  bytes.push(Number(big));
  return Buffer.from(bytes);
}

/** 解码 varint，返回数值与消耗的字节数。 */
export function decodeVarint(buffer: Buffer, offset = 0): { value: number; bytes: number } {
  let result = 0n;
  let shift = 0n;
  let index = offset;

  while (index < buffer.length) {
    const byte = buffer[index];
    result |= BigInt(byte & 0x7f) << shift;
    index += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error('varint 过长（超过 10 字节），数据可能已损坏');
  }

  // 处理 64 位补码负数
  const asNumber = result > 0x7fffffffffffffffn ? Number(result - (1n << 64n)) : Number(result);
  return { value: asNumber, bytes: index - offset };
}

/** 字段 tag = (fieldNumber << 3) | wireType */
export function encodeTag(fieldNumber: number, wireType: WireTypeValue): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

export interface DecodedField {
  fieldNumber: number;
  wireType: number;
  /** VARINT 时是该数值；LENGTH_DELIMITED 时是内容字节 */
  value: number | Buffer;
}

/**
 * 把一个 message 的字节拆成字段列表。
 *
 * 这是解码的基础：调用方按字段号取值，未知字段会被保留（proto 的前向兼容
 * 要求"不认识就跳过"，而不是报错）。
 */
export function decodeFields(buffer: Buffer): DecodedField[] {
  const fields: DecodedField[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const tagResult = decodeVarint(buffer, offset);
    offset += tagResult.bytes;
    const fieldNumber = tagResult.value >>> 3;
    const wireType = tagResult.value & 0x07;
    if (fieldNumber === 0) throw new Error('字段号为 0，数据不可能合法');

    if (wireType === WireType.VARINT) {
      const varint = decodeVarint(buffer, offset);
      offset += varint.bytes;
      fields.push({ fieldNumber, wireType, value: varint.value });
    } else if (wireType === WireType.LENGTH_DELIMITED) {
      const lengthResult = decodeVarint(buffer, offset);
      offset += lengthResult.bytes;
      const length = lengthResult.value;
      if (offset + length > buffer.length) {
        throw new Error(`字段 ${fieldNumber} 声明长度 ${length} 超出剩余字节`);
      }
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else {
      // 本 schema 里没有 64bit/32bit 定长字段；遇到说明数据来源不对，
      // 静默跳过会让后续字段全部错位，所以直接报错更安全。
      throw new Error(`不支持的 wire type ${wireType}（字段 ${fieldNumber}）`);
    }
  }
  return fields;
}

/** 编码 length-delimited 字段（string 或 bytes）。 */
export function encodeBytesField(fieldNumber: number, value: Buffer): Buffer {
  return Buffer.concat([
    encodeTag(fieldNumber, WireType.LENGTH_DELIMITED),
    encodeVarint(value.length),
    value,
  ]);
}

/** 编码 string 字段（UTF-8）。 */
export function encodeStringField(fieldNumber: number, value: string): Buffer {
  return encodeBytesField(fieldNumber, Buffer.from(value, 'utf8'));
}

/**
 * 编码 varint 字段。
 *
 * **调用方负责决定是否写默认值**：proto3 的普通标量取默认值时不写，
 * 而 `optional` 标量显式设置后必须写（哪怕是 0/false）。
 * 这个区别由各 message 的编码函数自己处理，不放在这里统一判断——
 * 因为只有具体 schema 才知道字段是不是 optional。
 */
export function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, WireType.VARINT), encodeVarint(value)]);
}

/** 从字段列表里取第一个匹配字段的 varint 值。 */
export function getVarint(fields: DecodedField[], fieldNumber: number): number | null {
  const hit = fields.find((f) => f.fieldNumber === fieldNumber && f.wireType === WireType.VARINT);
  return hit ? (hit.value as number) : null;
}

/** 从字段列表里取第一个匹配字段的字节内容。 */
export function getBytes(fields: DecodedField[], fieldNumber: number): Buffer | null {
  const hit = fields.find(
    (f) => f.fieldNumber === fieldNumber && f.wireType === WireType.LENGTH_DELIMITED,
  );
  return hit ? (hit.value as Buffer) : null;
}

/** 取所有同名 length-delimited 字段（repeated 用）。 */
export function getAllBytes(fields: DecodedField[], fieldNumber: number): Buffer[] {
  return fields
    .filter((f) => f.fieldNumber === fieldNumber && f.wireType === WireType.LENGTH_DELIMITED)
    .map((f) => f.value as Buffer);
}

/** 取所有同名 varint 字段（repeated 用）。 */
export function getAllVarints(fields: DecodedField[], fieldNumber: number): number[] {
  return fields
    .filter((f) => f.fieldNumber === fieldNumber && f.wireType === WireType.VARINT)
    .map((f) => f.value as number);
}
