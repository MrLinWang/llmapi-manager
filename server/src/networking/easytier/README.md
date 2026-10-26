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

## 还没实现

- Noise 握手之后的数据面（加密帧、路由广播的收发）
- OSPF 路由收敛计算（内核负责，本实现只解析已有条目）
- 除 TCP 之外的隧道（udp / wg / quic / ws）

也就是说：**能建连到"握手完成"，但还不能传数据**。
