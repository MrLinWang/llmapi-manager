# TypeScript 版 EasyTier 协议实现

**这是备用实现 + 协议参考，不是生产路径的主选。**

生产路径是 `native/easytier-node/`（Rust 库 + N-API），它直接复用官方实现，
兼容性天然成立。这里的 TS 实现用于：

1. **备用**：原生模块不可用的平台可以走这条路
2. **验证**：把"协议长什么样"变成可断言的测试（见下面的验证方式）

## 已实现并与官方对齐的部分

| 模块 | 内容 | 验证方式 |
| --- | --- | --- |
| `protocol.ts` | `PeerManagerHeader`（16 字节）、22 个 `PacketType`、8 个标志位 | oracle 逐字节对照 |
| `protobuf.ts` | 最小 protobuf 编解码（varint / length-delimited） | oracle + 边界用例 |
| `siphash.ts` | SipHash-1-3（Rust `DefaultHasher`）+ `network_secret_digest` | 与 Rust 实测值一致 |
| `noise.ts` | Noise 参数（`Noise_XX_25519_ChaChaPoly_SHA256` + prologue） | 官方用同参数跑通三轮握手 |
| `credential.ts` | X25519 + `TrustedCredentialPubkey` + HMAC 签发/验签 | oracle 字节与 HMAC 完全相同 |
| `route.ts` | `RoutePeerInfo` 编解码 | oracle 逐字节对照 |
| `framing.ts` | TCP 隧道帧（4 字节长度 + 16 字节包头） | 与官方节点实测互通 |
| `handshake.ts` | `HandshakeRequest` / `Response` 编解码与校验 | **与真实节点握手成功** |
| `noiseXX.ts` | Noise_XX_25519_ChaChaPoly_SHA256 完整实现 | 与 snow（官方同款）三轮握手成功 |
| `noiseHandshake.ts` | Noise Msg1/2/3 编解码 + `secret_proof` | **与真实节点完成 Noise 握手** |

## 关键验证：真实建连

`server/test/easytierInterop.test.ts` 会启动一个**真的 EasyTier 节点**
（编译好的原生模块，跑在子进程里），然后用纯 TS 代码连上去握手，
断言对方的响应里 `magic` / `network_name` / `network_secret_digest` 全部正确。

摘要那项尤其关键：它是官方用 Rust `DefaultHasher` 算出来的，
我们必须在 TS 里逐位复现 SipHash-1-3 才能对上。

## 踩过的四个坑（都是"看起来合理但完全不同"）

1. **SipRound 写成对称形式**：SipHash 的 SIPROUND 是四组不同旋转量的串联操作，
   写成"两两配对"会得到一个自洽但错误的 hash。用官方 SipHash-2-4 测试向量一验就露馅。
2. **握手包不是裸 protobuf**：TCP 隧道有 4 字节长度帧头，直接写 protobuf 会让对端
   把字段 tag 当长度，报 `InvalidPacket("body too long")`。
3. **`optional bool` 当普通 bool**：proto3 里 `optional` 显式设为 `false` 也必须写出来，
   否则 HMAC 与官方不同。
4. **不能用 127.0.0.1 测**：EasyTier 的虚拟网络栈会接管 loopback，
   表现为 `connect timeout` 而对端收不到任何连接。必须用本机真实 IP。

## 关于两条互斥的握手路径（重要）

EasyTier 有**两条互斥**的握手路径，由对端的 secure mode 决定
（`peer_conn.rs:1210`）：

| 对端 secure mode | 第一条包必须是 | 之后 |
| --- | --- | --- |
| `false`（默认） | 明文 `HandShake` | 直接进数据面，**不再有 Noise** |
| `true` | `NoiseHandshakeMsg1` | Noise XX 三段，然后进数据面 |

**不能"先明文握手再 Noise"**。我最初按串行理解实现，对端把 Noise Msg1
当作未处理包丢掉（日志 `unhandled packet ... packet_type: TCP`）。

## 现在的进度

```
① 明文握手           ✅ 与真实节点互通
② Noise XX 三段      ✅ 与真实节点互通（secure mode）
③ 数据面             ❌ 未实现
```

第 ② 步通过后的证据：对端不再报任何握手错误，而是开始向我同步路由
（`sync_route_info failed ... dst_peer_id=<my id> e=Timeout`）——
它已经把我当成合法节点，只是我还没实现 OSPF 应答。

## 还没实现

- 数据面：加密帧的收发（Noise `Split()` 之后的双向密钥已能导出，但没用起来）
- OSPF 路由广播的应答与收敛
- 除 TCP 之外的隧道（udp / wg / quic / ws）

也就是说：**能建连到"双方认可为合法节点"，但还不能传流量**。
