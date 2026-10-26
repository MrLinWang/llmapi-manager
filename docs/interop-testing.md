# 怎么验证"真的能建连"

仓库里有两类验证，作用不同，**不能互相替代**：

| 方式 | 验证什么 | 运行成本 | 何时跑 |
| --- | --- | --- | --- |
| `protocolSelfCheck()` | 编出的**字节**对不对 | 毫秒，无需联网 | 随时 |
| `scripts/interop-check.mjs` | 对端**真的接受**了、网络真的形成了（控制面）| 约 10–40 秒，需要两个进程 | 改了网络相关代码后 |
| `scripts/dataplane-check.mjs` | 数据能否通过虚拟网络传输（数据面）| ⚠️ 当前环境不可用，见第八节 | 有可用 gateway 时 |

自检通过只能说明"我们的编码正确"；建连成功才能说明"整个交互是通的"。
协议字段错了可能被对端宽容忽略，这类问题只有真实建连才能暴露。

## 一、前置：编译原生模块

```bash
cd native/easytier-node
npx napi build --platform --release
```

需要 Rust 工具链。产物是 `easytier-node.<platform>-<arch>.node`，`index.js`
会自动找它。

**没编译也不影响其它功能**：设备互联会降级为不可用并给出可操作提示
（`NetworkingRuntime.availability()`），配置同步照常工作。

若 `napi build` 因 `~/.npm` 只读而失败（容器/受限环境常见），可直接复制产物：

```bash
cp target/release/libeasytier_node.so easytier-node.linux-x64-gnu.node
```

## 二、跑双节点互通测试

```bash
node scripts/interop-check.mjs
```

成功时输出：

```
双节点互通测试
  本机 IP    172.38.8.91
  网络名     interop-mvp0hlej
  节点 A     端口 11010
  节点 B     端口 11011 → 连 172.38.8.91:11010

  节点 A 已就绪（监听中）
  节点 B 已就绪（主动连接 A）

结果
  ✅ 建连成功
     B 看到 1 个对端：node-a
```

### 常用参数

```bash
node scripts/interop-check.mjs --ipv4 10.126.126   # 同时验证虚拟 IP 分配
node scripts/interop-check.mjs --timeout 60        # 网络慢时放宽
node scripts/interop-check.mjs --port 12000        # 端口被占用时换一组
node scripts/interop-check.mjs --verbose           # 看 EasyTier 自己的日志
node scripts/interop-check.mjs --keep-logs         # 保留日志文件
```

## 三、判据是什么

**不是**"两个进程都起来了"——那只证明进程没崩。真正的判据是：

1. B 的 `peerCount` 达到 1
2. B 的 peer 列表里出现 A 的主机名（`node-a`）
3. （推荐）A 也能看到 B —— 双向可见，说明不是单向误报

脚本要求 1+2；`--verbose` 能看到 3。实测输出：

```
[A] STATUS {"peerCount":1,"hostnames":["node-b"]}
[B] STATUS {"peerCount":1,"hostnames":["node-a"]}
```

## 四、四个必须知道的环境限制

这些都是踩过的坑，不理解会浪费很多时间排查：

### 1. 不能用 `127.0.0.1`

EasyTier 的虚拟网络栈会接管 loopback，表现为 `connect timeout`，
**而对端什么日志都没有**（连接根本没到）。脚本会自动找本机非回环 IPv4。

### 2. 原生模块是单例

一个 Node 进程只能跑一个实例。同一进程里连续 `startNode` 两次，
第二次是幂等的空操作——你拿到的还是同一个节点，不会变成两个。
所以脚本用**两个子进程**。

### 3. 不写 `listenPort` 就没有监听

没有监听端口时，对端连不进来、也不会报错。脚本里两个节点都显式给了端口。

### 4. `ipv4` 必须完全省略，不能传 `null`

napi 把 `Option<String>` 映射成"可省略但不可为 null"。传 `null` 会抛：

```
Failed to convert JavaScript value `Null` into rust type String
```

这个错误看起来像 Rust 代码写错了，实际是 JS 侧传值问题。

## 五、`noTun` 模式下的虚拟 IP

脚本默认用 `noTun: true`（容器里没有 `CAP_NET_ADMIN`，建不了内核网卡）。
这个模式**不写内核网卡**，未显式指定 `ipv4` 时不会分配到地址，
`nodeStatus().virtualIpv4` 就是 `null`——**这是预期行为，不是缺陷**。

要验证 IP 分配，用 `--ipv4` 显式指定：

```bash
node scripts/interop-check.mjs --ipv4 10.126.126
# A 的虚拟 IP：10.126.126.1/24
# B 的虚拟 IP：10.126.126.2/24
```

需要**真的能 ping 通虚拟 IP** 时，必须去掉 `noTun` 并要求有网络权限
（`CAP_NET_ADMIN` 或 root），脚本不覆盖这种用法。

## 六、为什么不放进 `npm test`

双节点测试需要两个进程、真实网络、几十秒等待，还会留下临时进程。
放进日常测试会让 `npm test` 变慢且不稳定（端口冲突、防火墙、CI 环境差异）。

所以它是个**手动脚本**：改了网络相关代码后跑一次。日常测试里保留的是：
- `protocolSelfCheck()` 的契约测试（快、无副作用）
- `easytierInterop.test.ts`（TS 实现与官方节点握手，环境不满足时自动跳过）

## 七、排错顺序

建连失败时按这个顺序查，从最可能到最不可能：

1. **看 EasyTier 自己的日志**：`--verbose`。它的故障几乎全是静默的
   （两个节点都 running 却 peerCount=0），原因只在它内部日志里。
2. **确认端口通**：`nc -zv <ip> <port>`。防火墙拦了是最常见原因。
3. **确认网络名与密钥一致**：脚本每次生成随机值，只有同一次运行内一致；
   手工测试时网络名或密钥写错会表现为"连不上但没报错"。
4. **确认没用 loopback**：见上面第 1 条。
5. **确认端口没被占用**：`ss -lntp | grep <port>`。

## 八、数据面（数据能否通过虚拟网络传输）

控制面通了（`peerCount` 到 1）不等于数据能过。数据面要单独验证。

### 前提：原生模块必须启用 `socks5` feature

`native/easytier-node/Cargo.toml` 的 `easytier` 依赖里必须有 `"socks5"`。

这一点**极易踩坑**：`socks5` 名字看起来只与 SOCKS5 代理有关，实际它门控
整个 port-forward gateway。源码两处：

```rust
// easytier/src/instance/config.rs:52
gateway_enabled: cfg!(feature = "socks5"),

// easytier-core/src/instance/config.rs:311 —— 转发规则在这里被清空
port_forwards: if host.ignore_unsupported_config && !host.gateway_enabled {
    Vec::new()
} else {
    config.get_port_forwards()
}
```

缺这个 feature 的症状**完全没有指向性**：

- `set_port_forwards()` 写入成功
- `config.get_port_forwards()` 回读得到规则
- `CoreInstanceConfig::from_toml()` 之后也还在
- 但端口永远不监听
- EasyTier 日志里没有任何 gateway 输出，既没成功也没报错

排查时先确认这一条，能省掉大量时间。

### 运行

```bash
node scripts/dataplane-check.mjs
```

实测输出：

```
  控制面已建连（B 看到 node-a）
  转发端口就绪（127.0.0.1:18081）

  开始传输 65536 字节……

结果
  ✅ 数据成功通过虚拟网络传输
     收到 65536 字节，耗时 4ms
     约 16000 KiB/s
     内容校验：✅ 一致
```

大数据量：

```bash
node scripts/dataplane-check.mjs --size 1048576
# 收到 1048576 字节，耗时 11ms，约 93091 KiB/s，内容校验一致
```

### 它验证了什么

四个维度，都做了实测：

| 维度 | 内容 | 实测结果 |
| --- | --- | --- |
| 单向传输 | B 经虚拟网络取 A 的数据 | ✅ 65536 字节 / 3ms |
| 内容完整性 | 逐字节比对 `i % 251` 序列 | ✅ 一致（能发现数据损坏，不只是连接失败）|
| 连接复用 | 连续多轮新连接 | ✅ 5/5 轮 |
| 并发 | 同时多条连接 | ✅ 8/8 条 |

大数据量实测：1 MiB × 5 轮 × 8 并发，约 100 MB/s，内容全部一致。

### 为什么只测单向

`port_forward` 的语义是**「本机入口 → 虚拟网络对端地址」**：

```toml
[[port_forward]]
bind_addr = "0.0.0.0:11011"        # 本机入口
dst_addr = "192.168.94.33:11011"   # 虚拟网络上要去的地址
proto = "tcp"
```

反向（让 A 主动访问 B 上的服务）要求 **B 的服务挂在 B 的虚拟地址上**，
而 `noTun` 模式没有内核网卡承载虚拟地址——`bind` 虚拟 IP 会失败
（实测 `Connection refused`）。

所以双向验证需要真实 TUN。这是 `noTun` 模式的固有限制，不是 bug。

### 原理

`noTun` 模式没有内核网卡，无法 ping 虚拟 IP。改用 EasyTier 自己的
port-forward gateway，全程用户态：

```
节点 A 监听虚拟网络里的 10.126.126.1:18080
节点 B 配转发：127.0.0.1:18081 → 10.126.126.1:18080
在 B 上访问 127.0.0.1:18081，流量经虚拟网络到达 A 的服务
```

### 备选：真实 TUN

需要能 ping 虚拟 IP 时，去掉 `noTun` 并要求：

- `/dev/net/tun` 存在
- 有 `CAP_NET_ADMIN`（或 root）

容器里需要 `--cap-add=NET_ADMIN --device /dev/net/tun`。
本仓库开发环境不具备这些条件（非 root、无 `/dev/net/tun`、`CapEff` 全零），
所以走的是端口转发这条路。
