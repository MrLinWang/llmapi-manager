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

控制面通了（`peerCount` 到 1）不等于数据能过。要验证数据面，需要一条
**能在用户态走的通道**。

### 方案一：端口转发（当前环境不可用）

EasyTier 有个 port-forward gateway，能把本机端口映射到虚拟网络内的地址，
理论上不需要 TUN 就能验证：

```
节点 B 配转发：127.0.0.1:18081 → 10.126.126.1:18080
在 B 上访问 127.0.0.1:18081，流量经虚拟网络到达 A 的服务
```

`scripts/dataplane-check.mjs` 就是按这个思路写的（含内容校验，
不只验证"能连上"）。

**但在当前环境实测不工作**：gateway 不绑定端口。

这不是脚本或调用方式的问题，做过对照实验：

| 怀疑点 | 实测结果 |
| --- | --- |
| `set_port_forwards` 调用方式 | 去掉原生模块，用纯 Rust 直接调，同样不绑定 |
| 配置没写进去 | 回读确认规则存在、地址正确 |
| `no_tun = true` 导致 | `no_tun` 是否为 true 都不绑定 |
| `smoltcp` feature 缺失 | `cargo tree` 确认 `proxy-smoltcp-stack` 已启用 |
| `gateway_enabled` / `startup_plan.gateway` | 源码里默认都是 true |
| 绑定慢 | 等 17 秒仍不绑定 |

且 EasyTier 日志里**没有任何 gateway 相关输出**——既没成功也没报错。

> 这是 EasyTier v2.7.0 在 `create_native_instance` 路径下的行为，
> 尚未查到根因。若上游修复或找到正确的启用方式，脚本不需要改。

### 方案二：真实 TUN（需要特权）

去掉 `noTun`，用 root 或 `CAP_NET_ADMIN` 运行，然后直接验证虚拟 IP：

```bash
# 两个节点都要 noTun: false，且能建 /dev/net/tun
# 然后：
ping 10.126.126.2
nc -zv 10.126.126.2 8080
```

前提条件（缺一不可）：

- `/dev/net/tun` 存在
- 进程有 `CAP_NET_ADMIN`
- 或者说：以 root 运行

容器里通常需要 `--cap-add=NET_ADMIN --device /dev/net/tun`。

**本仓库的开发环境不具备这些条件**（非 root、无 `/dev/net/tun`、
`CapEff` 全零），所以这条路径没有在此验证过。

### 判断该用哪个

```bash
# 有没有 TUN 能力
ls /dev/net/tun && grep CapEff /proc/self/status
```

- 能建 TUN → 用方案二，最直接
- 不能 → 方案一目前不可用，数据面验证只能推迟
