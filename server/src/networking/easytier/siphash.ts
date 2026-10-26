/**
 * SipHash-1-3，与 Rust `std::collections::hash_map::DefaultHasher` 完全一致。
 *
 * ## 为什么需要它
 *
 * EasyTier 的 `network_secret_digest` 用 Rust 的 `DefaultHasher` 算出来
 * （`easytier-core/src/config/mod.rs:192` 的 `generate_digest_from_str`）。
 * 这个 32 字节日志出现在**握手的第一个包里**，对端用它判断
 * "双方的网络名与密钥是否一致"——算错就等于密钥不匹配，握手直接失败。
 *
 * 要生成能被官方节点接受的握手，必须逐位复现它。
 *
 * ## 关键事实：它是确定性的
 *
 * 直觉上会担心 `DefaultHasher` 带随机种子（`RandomState` 确实随机）。
 * 但 `DefaultHasher::new()` 是**固定种子 (k0=0, k1=0) 的 SipHash-1-3**：
 *
 * ```rust
 * let mut h = DefaultHasher::new();  // 每次都是同一个种子
 * h.write(b"rna"); h.write(b"sss");
 * h.finish()                          // 跨进程、跨运行都相同
 * ```
 *
 * 这一点已实测确认（同一程序运行两次、以及不同进程之间结果一致）。
 * 如果它真的随机，跨机器互通在原理上就不可能——而 EasyTier 是能互通的，
 * 所以它必须确定。
 *
 * ## 算法
 *
 * SipHash-1-3：每轮压缩 1 次、最终化 3 次。密钥两个 64 位字，
 * 输入按 8 字节小端分组。Rust 的 `Hasher::write` 会对同一次调用的字节流
 * 做"末尾 0x00–0xff 标记 + 补零到 8 字节"，所以多次 `write` 与一次写出
 * 等长字节**结果相同**（这也是官方代码能分两次 write 网络名与密钥的原因）。
 */

/** 64 位掩码，避免 BigInt 之外用 JS number 丢精度。这里统一用 BigInt。 */
const MASK64 = 0xffffffffffffffffn;

/** 循环左移。 */
function rotl(x: bigint, b: bigint): bigint {
  return ((x << b) | (x >> (64n - b))) & MASK64;
}

/**
 * SipRound。
 *
 * **这里曾经写错过，值得记下来**：SipHash 的 SIPROUND 不是"两两配对做
 * add-rotate-xor"（那样写出来像是 4 个对称的半轮），而是**四组独立的
 * 操作串联**，每组的参与变量与旋转量都不同：
 *
 * ```
 * v0 += v1; v1 = rotl(v1, 13); v1 ^= v0; v0 = rotl(v0, 32);
 * v2 += v3; v3 = rotl(v3, 16); v3 ^= v2;
 * v0 += v3; v3 = rotl(v3, 21); v3 ^= v0;
 * v2 += v1; v1 = rotl(v1, 17); v1 ^= v2; v2 = rotl(v2, 32);
 * ```
 *
 * 写成对称形式会得到一个"看起来合理"的 hash，且自身往返一致，
 * 但用官方的 SipHash-2-4 测试向量一验就露馅（4 条全错）。
 * 这也是为什么要有外部向量对照，而不是只测自洽。
 */
function sipRound(v0: bigint, v1: bigint, v2: bigint, v3: bigint): [bigint, bigint, bigint, bigint] {
  let a = v0;
  let b = v1;
  let c = v2;
  let d = v3;

  a = (a + b) & MASK64;
  b = rotl(b, 13n);
  b ^= a;
  a = rotl(a, 32n);

  c = (c + d) & MASK64;
  d = rotl(d, 16n);
  d ^= c;

  a = (a + d) & MASK64;
  d = rotl(d, 21n);
  d ^= a;

  c = (c + b) & MASK64;
  b = rotl(b, 17n);
  b ^= c;
  c = rotl(c, 32n);

  return [a, b, c, d];
}

/** 从 Buffer 按小端读 64 位。 */
function readU64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

/**
 * 计算 SipHash-1-3。
 *
 * `data` 是完整输入字节流。Rust 的 `Hasher::write` 可以被调用多次，
 * 但等价于把所有字节拼起来写一次（`write` 只影响结尾标记，不影响分块）。
 * 所以调用方先把 `network_name` 与 `network_secret` 拼起来即可。
 */
export function sipHash13(data: Buffer, k0 = 0n, k1 = 0n): bigint {
  let v0 = 0x736f6d6570736575n ^ k0;
  let v1 = 0x646f72616e646f6dn ^ k1;
  let v2 = 0x6c7967656e657261n ^ k0;
  let v3 = 0x7465646279746573n ^ k1;

  const len = data.length;
  const fullBlocks = Math.floor(len / 8);

  // 处理完整的 8 字节块
  for (let i = 0; i < fullBlocks; i += 1) {
    const m = readU64LE(data, i * 8);
    v3 ^= m;
    // SipHash-1-3：压缩 1 轮
    [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    v0 ^= m;
  }

  // 处理尾部：Rust 的写法是"剩余字节 + (len << 56 的低字节)"
  // 具体来说，把剩余字节按小端放进一个 64 位字，
  // 最高字节放总长度的低 8 位。
  const remaining = data.subarray(fullBlocks * 8);
  let b = BigInt(len & 0xff) << 56n;
  for (let i = 0; i < remaining.length; i += 1) {
    b |= BigInt(remaining[i]) << BigInt(8 * i);
  }

  v3 ^= b;
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  v0 ^= b;

  // 最终化：3 轮
  v2 ^= 0xffn;
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);

  return (v0 ^ v1 ^ v2 ^ v3) & MASK64;
}

/**
 * 复现 EasyTier 的 `network_secret_digest`。
 *
 * 官方实现（`config/mod.rs:192`）：
 *
 * ```rust
 * let mut hasher = DefaultHasher::new();
 * hasher.write(str1.as_bytes());   // network_name
 * hasher.write(str2.as_bytes());   // network_secret
 * let shard_count = 32 / 8;        // 4
 * for i in 0..shard_count {
 *     digest[i*8..(i+1)*8].copy_from_slice(&hasher.finish().to_be_bytes());
 *     hasher.write(&digest[..(i+1)*8]);   // 把已生成的摘要再喂回去
 * }
 * ```
 *
 * 注意三点，任一漏掉都会得到不同的摘要：
 * 1. 每轮之后把**已生成的摘要前缀**再喂给 hasher（"滚动"）
 * 2. 每轮取的是 `finish()` 的**大端**字节
 * 3. 共 4 轮（32 字节 / 8）
 */
export function networkSecretDigest(networkName: string, networkSecret: string): Buffer {
  const input = Buffer.concat([
    Buffer.from(networkName, 'utf8'),
    Buffer.from(networkSecret, 'utf8'),
  ]);

  const digest = Buffer.alloc(32);
  // 用一个可增量的方式模拟"写一部分、finish、再写、再 finish"。
  // SipHash 的 finish 不改变内部状态，所以可以先算 hash，
  // 再把摘要前缀追加到输入后面重新算——但那样复杂度是平方级的。
  // 这里直接维护"当前输入"，每次追加后重算（4 轮，输入最长 32 字节，开销可忽略）。
  let current = input;

  for (let round = 0; round < 4; round += 1) {
    const hash = sipHash13(current);
    // 大端写入 8 字节
    digest.writeBigUInt64BE(hash, round * 8);
    // 把已生成的前缀再喂回去
    current = Buffer.concat([current, digest.subarray(0, (round + 1) * 8)]);
  }

  return digest;
}
