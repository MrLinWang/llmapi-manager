# TypeScript 版 EasyTier 协议实现

**这是默认的主引擎（`engine: 'builtin'`）。**

`native/easytier-node/`（Rust 库 + N-API）保留为**备用引擎**
（`engine: 'native'`），它不是被取代，而是分工不同：

| | `builtin`（本目录，默认主） | `native`（备用） |
| --- | --- | --- |
| 依赖 | 无（纯 TS） | 需 Rust 工具链编译 |
| 本仓库可读可改 | ✅ | 需读 Rust |
| 握手 / 加密 / RPC / OSPF 路由 | ✅ 已实测 | ✅ |
| NAT 穿透 / 打洞 | ❌ 未实现 | ✅ |
| 端口转发 | ❌ 未实现 | ✅ |
| 多跳中继选路 | ❌ 未实现 | ✅ |
| 虚拟网卡（TUN） | ❌ 不创建 | ✅ |

**证据边界必须说清**：本实现的"已实测"指握手（双向角色）、数据面加解密、
RPC 双向、OSPF 同步与路由广播都在真实官方节点上跑通了。但 NAT 穿透、
MTU 协商、端口转发、多跳中继**没有实现**——这些场景请切 `engine: 'native'`。

为什么把它做成默认：它是本仓库自己的代码，出问题能读能改，也不要求用户
先装 Rust 工具链；而绝大多数"两台机器互连做配置同步"的场景只需要
TCP 直连可达。

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
| `dataPlane.ts` | HKDF traffic key 派生 + AES-GCM 加解密 | 密钥派生对照独立实现；**成功解密对端真实 RPC** |
| `rpc.ts` | `RpcPacket` / `RpcDescriptor` / `RpcResponse` / `error.Error` | oracle 逐字节对照 |
| `address.ts` | IPv4/Inet/SocketAddr/Url/TunnelInfo、连接位图、能力标志 | oracle 逐字节对照 |
| `ospf.ts` | `SecureChannel`：解密对端 RPC（✅）；回应 OSPF 请求（⚠️ 不可用）| 见下方"能力边界" |

## 能力边界：哪些能用、哪些不能

这张表比"实现了什么"更重要——避免后续维护者误用。

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| 明文握手（`HandshakeRequest`，发起方） | ✅ 可用 | 与真实节点握手成功 |
| Noise XX 握手（发起方） | ✅ 可用 | 与真实节点完成握手 |
| Noise XX 握手（**接受方**，`acceptor.ts`） | ✅ 可用 | 官方节点作为发起方连入，`NetworkSecretConfirmed` |
| 解密对端加密 RPC | ✅ 可用 | 正确解码官方 OSPF 请求（peer_id 等字段全对） |
| 应答 OSPF 同步请求（**接受方角色**） | ✅ 可用 | 事务号精确匹配、无 inflight miss、无 sync 超时 |
| Ping/Pong 保活 | ✅ 可用 | 连接长期稳定，不再每秒重连 |
| OSPF 路由广播 | ✅ 可用 | 官方路由表列出 TS 条目，peer 列表主机名 `ts-node` |
| **数据面**（`PacketType.Data`） | ✅ 可用 | 官方节点经虚拟网络连到桥接的本机服务，TCP 握手真实完成 |
| 用户态 TCP 栈 | ✅ 可用 | 三次握手/数据传输/关闭/重传，7 项测试含真实 socket 往返 |
| UDP / ICMP | ❌ 未实现 | 见"已知边界" |
| IP 分片重组 | ❌ 未实现 | 收到分片包直接丢弃 |
| TCP 拥塞控制 | ❌ 未实现 | 固定窗口，大流量长连接吞吐低于理想值 |

### 为什么"回应 OSPF"不可用

不是字段没调对，而是与官方的**连接角色模型**冲突。

对端在解密前会做这个检查（`peer_conn.rs:205`）：

```rust
if from_peer_id != peer_id { return Some(Ok(data)); }  // 不解密，直接放行
```

`peer_id` 实测等于对端**自己的** `my_peer_id`，于是：

| `from_peer_id` | 结果 |
| --- | --- |
| 本节点 id（语义正确） | 检查不通过 → 静默丢弃或当明文放行 |
| 对端 id（能进解密分支） | 通过检查，但密钥方向对不上 → `secure decrypt failed` |

穷举 6 种（方向 × from × to）组合均失败；且 `rpc/client.rs:183` 的
"Received non-response packet" 一次都没出现，说明包**从未到达 RPC 层**。

官方把连接分为发起方/接受方，`RpcResp` 只由接受方回给发起方。
`ospf.ts` 的 `SecureChannel` 是**发起方**视角，它去回 `RpcResp` 会撞上那个检查。

**这个限制已经由 `acceptor.ts` 解决**：它实现 Noise 握手的服务端方向
（`do_noise_handshake_as_server` 的镜像）、admission 校验与 OSPF 应答，
站到了合法的应答方一侧，并已用官方节点实测通过（见下面"接受方方向的实测记录"）。

所以：**生产用 `acceptor.ts`，`ospf.ts` 的 `handleOspfRequest` 只是协议参考。**
它的返回值只表示"识别到并尝试回应了"，不代表对端接受。

## 接受方方向的实测记录（2026-10-29）

`easytierAcceptor.test.ts` 让官方节点作为发起方连入 TS 监听端口：

```
[ts-acceptor] 握手完成，remote=... roleHint=1
[ts-acceptor] OSPF 已应答，native my_peer_id=...
STATUS {"peerCount":1,"hostnames":["peer-987654321"]}
Tests: 2 passed（握手+OSPF 应答；无 sync 超时）
```

### 实现接受方时抓出的五个真实 bug

1. **int64 精度**：官方事务号约 ±3e17，超出 JS number（2^53）精确范围，
   按 number 读会偏差个位数——对端按事务号精确匹配请求与响应，差 1 就静默丢弃。
   `transactionId`/`session_id` 已全部改为 bigint 通路
   （`encodeVarintBig`/`decodeVarintBig`/`getVarintBig`）。
2. **Pong 回显丢帧长前缀**：收帧循环返回的是去掉 4 字节长度前缀的 body，
   原样写回会被对端当成"帧长 19 亿"，报 `body too long` 断连。
3. **请求方向的包装层**：`RpcPacket.body` 里是 `RpcRequest{request}`，
   与响应方向的 `RpcResponse` 对称。漏掉这层，官方解码整包失败但无日志。
4. **OSPF 会话语义**：响应的 `session_id` 是**应答方自己的会话号**
   （`peer_ospf_route.rs:4221`），不是回显；`is_initiator` 是应答方自己的视角。
   回显会被判 "session id mismatch, clear saved info"。
5. **conn_info 缺失**：路由表的下一跳图由各节点的 conn_info 拼成，
   只发 peer_infos 图里没有边，路由装不上。

### 最后一关的根因（已解决）

`OSPF_SERVICE` 常量带着早期假设：protoName 带包名 + methodIndex 0。
官方注册表按 `(domain, service, proto)` 三元组精确匹配，带包名的 key
查不到服务，报 `InvalidService`（响应里能直接看到）。另需
`domainName=网络名` 与广播带 `ipv4_addr`。修正后官方 peer 列表出现
`ts-node`，广播响应 `error=null`。

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
③ 数据面解密         ✅ 能解密对端的加密 RPC 请求
④ 数据面加密应答     ⚠️ 已能发出，但对端未确认（见下）
```

### 已实证的成果

解密对端真实 OSPF 请求成功，拿到明文：

```
RPC OspfRouteRpc method=1 txn=8162031826263190000
body: 12ab0108b49bfce00f10efa1ec8ee4dab8fed30118012a150a06...
  → field 1 = my_peer_id    field 3 = is_initiator
  → field 5 = conn_bitmap
```

这证明数据面的密钥派生与 AEAD 实现是正确的——能解开官方加密的数据。

### 四个只有真跑才会发现的关键事实

| 我最初的假设 | 实际 |
| --- | --- |
| 密钥直接用 root_key | **必须经 HKDF 派生**（`"et-traffic"‖epoch‖dir`）|
| 算法 32 字节 → AES-256 | `aes-gcm` = **AES-128**，只用 key[..16] |
| descriptor `peer_rpc.OspfRouteRpc` / method 0 | **`OspfRouteRpc`** / method **1**，domain 是网络名 |
| 方向按客户端/服务端 | **按 peer_id 大小**（sender < receiver 即 aToB）|

### 剩余问题（诚实记录：未解决）

加密应答已发出，但对端仍报 `sync_route_info failed ... Timeout`。

**已确认无误的部分**（这些都有实证）：

| 项 | 证据 |
| --- | --- |
| 密钥派生 | 能成功解密对端的真实加密 RPC |
| 加密算法 `aes-gcm` = AES-128 | 同上（用 AES-128 才解得开，256 失败）|
| 方向按 peer_id 大小 | 解密时用 `bToA` 才对 |
| `RpcPacket` 编解码 | 与 oracle 逐字节一致 |
| 响应字段（反向 from/to、同 txn、is_request=false） | 手工核对过 |

**已排除的假设**：

- `to_peer_id` 用连接级 peer_id / 对端 RPC 的 from / 对端的 my_peer_id
  —— 三种都试过，都超时
- 加密 vs 不加密 —— 都试过，对端**都没有任何相关日志**
- `transaction_id` 回显、`ENCRYPTED` 标志、seq 起点（从 0 递增）

**这一轮新查明的事实**：

1. **`compression_info` 必须显式带 `algo`**
   `CompressionAlgoPb` 里 `Invalid=0 / None=1 / Zstd=2`，所以"用 None"
   **不等于**"省略字段"——省略会得到 Invalid(0)，而对端的
   `accepted_compression_algo()`（`rpc/packet.rs:16`）从不返回 Invalid。
   已修复并加了回归测试。

2. **对端的 `my_peer_id` 可以从 Ping 包的 `from` 字段读到**
   Ping 是明文不加密的，包头里 `from` 就是它的 `my_peer_id`。
   这解决了"to_peer_id 该填什么"的疑问（但填对了仍不成功）。

3. **解密失败会被静默丢弃，完全没有日志**
   `peer_conn.rs:229` 的 `return None`。这解释了为什么所有失败尝试都是
   "响应已发但无任何反应"——**这类问题只能靠对照成功案例排查**，
   不能靠看日志。

4. **官方响应确实是 `from=请求的 to`、`to=请求的 from`**
   `rpc/server.rs:291` 明确如此，我的实现正确。

5. **`after_received` 的 `from_peer_id` 检查是根因所在**
   （`peer_conn.rs:205`）
   ```rust
   if from_peer_id != peer_id { return Some(Ok(data)); }  // 不解密，直接放行
   ```
   这里的 `peer_id` 是**对端自己记录的"这条连接的对端 id"**，
   在本场景下等于它自己的 `my_peer_id`（实测两者相同）。
   所以：
   - `from_peer_id = 我的 id`（正确语义）→ **检查不通过 → 静默丢弃或当明文放行**
   - `from_peer_id = 对端 id` → 检查通过 → 进入解密，但**密钥方向对不上**

   这就是死结：语义正确的 from 进不了解密分支，能进解密分支的 from 语义错误。

### 结论：这条路径在官方连接模型下走不通

官方把连接分成"发起方/接受方"两种角色，`RpcResp` 只由**接受方**回给发起方。
我们作为**发起方（客户端）**去回 RpcResp，即使字段全对，也会被
`after_received` 的 `from_peer_id` 检查挡掉——因为那一项期望的是
"接受方视角的对端 id"。

**要真正走通数据面，正确做法是让本实现充当"接受方"**：
自己监听端口，等官方节点来连我们，然后按接受方的角色回 RpcResp。
这需要实现 Noise 握手的**服务端**方向（`do_noise_handshake_as_server`），
而不是现在的客户端方向。

**这条路后来走通了**：`noiseXX.ts` 的 `NoiseXXResponder` + `acceptor.ts`。
过程中发现五个真实 bug（int64 精度、Pong 帧长前缀、`RpcRequest` 包装层、
OSPF 会话语义、conn_info 缺失），详见"接受方方向的实测记录"一节。

## 数据面是怎么实现的

EasyTier 的 `PacketType.Data` 载荷是**完整 IP 包**（`peer_manager.rs:462`：
官方把它直接投给网卡或 smoltcp）。官方在 `noTun` 模式下靠 smoltcp 提供
用户态协议栈；自研实现没有 Rust 依赖，所以自己实现了一条更窄的路径：

```
官方节点（虚拟 10.x.x.2）        自研引擎                    本机真实服务
   │ SYN ─────────────────────▶ 解密 → ip.ts 解析
   │                             → tcpStack.ts（TCP 状态机）
   │◀─────────────── SYN-ACK      → net.connect(127.0.0.1:port)
   │ ACK / data ───────────────▶  → socket.write()
   │◀────────────── 响应数据       → 封 IP 包 → 加密 → Data 包
```

三块新代码：

- `ip.ts`：IPv4/TCP/UDP 头编解码 + 校验和（含 TCP 的**伪首部**——漏了这个
  会被对端静默丢弃，最难查）
- `tcpStack.ts`：TCP 状态机（三次握手、有序传输、FIN/RST、接收窗口、
  超时重传），并把虚拟连接桥接到本机 socket
- `acceptor.ts` 的 `handleDataPacket` / `sendDataPacket` / `enableDataPlane`：
  把 `Data` 包接进/接出这套栈

配置项 `portForwards` 决定虚拟端口映射到哪个本机端口，默认
`[{ virtualPort: 8787, localPort: 8787 }]`——就是本服务自己的管理界面。

### 实测记录（官方节点驱动）

```
组网对端已连接：peer=...
组网数据面：新连接 10.126.220.2:44047 → 虚拟 10.126.220.1:8787
组网数据面：桥接已建立 → 127.0.0.1:19022
组网数据面：发送数据包 105B → peer=...
[官方] DATA CONNECT
[官方] DATA BODY "HTTP/1.1 200 OK\r\nContent-Length: 26\r\n\r\nHELLO-FROM-BRIDGED-SERVICE"
```

**最后一行是端到端打通的证据**：官方节点在虚拟网络里拿到了本机桥接服务的
完整 HTTP 响应。它证明的不只是"能连上"，而是双向数据都正确穿过
加密隧道、IP/TCP 编解码与桥接。

### 两个只有实测才暴露的 bug

1. **TCP 校验和只算了头部**：`encodeTcpHeader` 调 `tcpChecksum(buf, ...)` 时
   只传 20 字节头部，而伪首部长度按"头+载荷"传。结果**所有带载荷的段校验和
   都错**，对端静默丢弃——症状是"握手完全正常、一发数据就没反应"，
   而且我们自己的往返测试因为两侧用同一个错误实现而"通过"。
   修好后回程数据立刻送达（上面的 `DATA BODY` 就是修复后才有的）。
   固定它的测试用"伪首部 + 整段再算为 0"这个性质，而不是魔数。
2. **ACK 不清理 `unacked`**：每个已确认的段都被无限重传。

### 测试驱动方式（这个坑很值钱）

驱动数据面**必须用官方的端口转发**（`127.0.0.1:<本地>-><虚拟IP>:8787`），
不能从 Node 直接 `net.connect(虚拟IP)`：`noTun` 下虚拟 IP 不挂在操作系统
网络栈上，那个连接根本不经过 EasyTier。症状是"包类型分布里没有 Data"，
极易误判成协议问题。

注意测试必须用官方的**端口转发**（`127.0.0.1:<本地>-><虚拟IP>:8787`）来驱动，
不能用 `net.connect(虚拟IP)`：`noTun` 下虚拟 IP 不挂在操作系统网络栈上，
那个连接根本不会经过 EasyTier（这个坑踩过，症状是"包类型分布里没有 Data"）。

## 还没实现 / 已知边界

按"影响多大"排序，前三条是真的会咬人的：

1. **身份不跨重启持久化**（最需要优先处理）。`runtime.ts` 的 `peerId` 与
   Noise 静态私钥在进程内稳定，但**重启后重新生成**。对端若按
   `noise_static_pubkey` 钉扎了本机，重启后会认为"这是另一个节点"。
   目前的实际影响有限（官方默认不做钉扎校验），但要让本实现当长期在线的
   主引擎，必须把这对密钥落盘（放租户数据目录、经 `ctx.secrets.encode()`）。
2. **组网状态不跨服务重启恢复**。`NetworkingRuntime` 不是单例，
   服务重启后 `status()` 会报 `running: false`，而端口可能仍被上一个进程
   占着。`start()` 失败时会把端口占用转成可操作的说明并记进
   `functionalReason`（有测试固定），但"自动接管已有实例"没做。
3. **只监听、不主动外连**。实现的是接受方角色，拓扑必须是"对端连本机"。
   配置里的 `peers`（中继列表）对 `builtin` 引擎**无效**——它不连中继。
4. **数据面只做 TCP，不做 UDP/ICMP**。所以 DNS（UDP）、`ping`（ICMP）
   在虚拟网内不通。要这些能力请用 `native`。
5. **不做 IP 分片重组**：收到 `more_fragments` 或 `fragment_offset != 0` 的包
   直接丢弃。MTU 1380 以下的正常流量不会触发，但大 UDP 包会。
6. **不做 TCP 拥塞控制**：固定窗口 + 固定 RTO，没有慢启动/拥塞避免。
   小请求（HTTP 页面、API 调用）没问题，**大文件长连接吞吐会明显低于官方**。
7. ~~多对端时数据包发给第一个连接的节点~~ **已修**：`selectPeerForPacket`
   按包的**目标 IP** 与各对端声明的虚拟 IP 做精确匹配；只有一条对端时发它；
   多条且都不匹配时**丢弃而不是猜**（发错对端会把数据串到别人的虚拟网里，
   而"不通"至少可排查）。仍缺的是按 OSPF 多跳路由转发——三节点以上
   跨节点通信需要它，目前只支持直连对端。
8. NAT 穿透 / 打洞、MTU 协商、多跳中继选路：全都没有。
   这些场景请切 `engine: 'native'`。
9. 不创建 TUN 虚拟网卡。数据面靠 `portForwards`（虚拟端口 → 本机端口），
   所以**对端访问的是你显式配置的端口**，不是任意虚拟 IP 上的任意服务。
10. 除 TCP 之外的隧道（udp / wg / quic / ws）。
11. 真正的 OSPF 路由收敛（内核职责，本实现不做）。

**判断"能不能用"的方法**：
- 单对端、TCP 直连可达、只需要 HTTP 访问对端的固定端口（如配置同步）
  → `builtin` 够用且已实测
- 需要 UDP/DNS、`ping` 通、NAT 穿透、多跳、或大流量长连接
  → 必须用 `native`
