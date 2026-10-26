# protocol-oracle — 协议对照基准

**这不是产品代码，是测试工具。**

它直接链接官方的 `easytier-core`，把真实结构体的**内存字节**输出成 JSON，
供 `server/src/networking/easytier/`（TypeScript 协议实现）做逐字节对照。

## 为什么需要它

没有它的时候，协议测试只能证明"我们的编码器和自己的解码器一致"——
**两端都错也能通过**。有了它，才能证明"我们产出的字节与官方实现完全相同"。

这个区别是实质性的。开发过程中它已经抓出三个纯靠读源码不会发现的错误：

| 错误 | 后果 |
| --- | --- |
| 字节序写成大端 | 自己的往返测试通过，但与官方节点完全无法通信 |
| 漏掉 `reserved` 占位字节 | `len` 字段错位，整包作废 |
| Noise prologue 不一致 | 握手在第二步失败，且错误信息不说 prologue 不对 |

## 它验证了什么

1. **包头布局**：`size_of::<PeerManagerHeader>()` = 16，以及每个字段的偏移
2. **字节序**：从真实字节反推（`from_peer_id = 0x01020304` → `04 03 02 01`）
3. **PacketType 枚举**：逐个 `as u8` 取真实数值
4. **标志位**：用公开的 `set_encrypted(true)` 等 setter 逐个打开单标志，
   从**写入后的内存**读那一位——验证的是 setter 实际行为，不是常量声明
5. **Noise 握手**：用与官方相同的 `snow 0.10.0` 跑**完整三轮握手**，
   确认 `Noise_XX_25519_ChaChaPoly_SHA256` + prologue 确实能握手成功

## 用法

```bash
cd native/protocol-oracle
cargo run --release > ../../server/test/fixtures-protocol-oracle.json
cd ../.. && npx vitest run --root server test/easytierOracle.test.ts
```

`fixtures-protocol-oracle.json` **应当提交**：它是测试的输入，且有它之后
跑 `npm test` 不需要 Rust 工具链。只有改动 oracle 时才需要重新生成。

## 遇到的私有字段

`PeerManagerHeaderFlags` 是 crate 私有的（`bitflags! { struct ... }` 没写 `pub`），
`reserved` 字段也是私有的。所以：

- 不能直接取 `flags.bits()` → 改用公开的 `set_*` 逐个探测
- 不能用结构体字面量构造 header → 从 `Default::default()` 起手再改公开字段

这两处限制**反向印证了 TypeScript 侧的注释**：`reserved` 虽然私有，
但确实占第 11 字节，跳过它 `len` 就会错位。
