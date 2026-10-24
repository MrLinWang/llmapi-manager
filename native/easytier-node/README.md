# easytier-node

EasyTier 的 [napi-rs](https://napi.rs/) 绑定，让 llmapi-manager 在自己的 Node 进程里
跑一个 EasyTier 实例，用于多设备配置同步的组网层。

> ## ⚠️ 未在本地编译验证
>
> 开发这个 crate 的机器上**没有 Rust 工具链**（`cargo` / `rustc` 都不存在），
> 因此**没有任何一行代码经过编译或运行验证**。
>
> 降低风险的办法：所有 EasyTier API 的签名都逐个对照 `ref/EasyTier/` 的实际源码确认过，
> 位置写在下文的"已核对的源码位置"一节，也写在代码注释里调用点的旁边。
> napi-rs 的版本号与 feature 名则是查 crates.io 的真实发布数据确认的。
>
> **第一次真正构建时，最可能出现问题的地方**（按可能性排序）见文末"首次构建时重点看"。

## 这是什么

把 EasyTier 作为 Rust 库链进 Node 原生模块（`.node`），从而：

- **协议复用官方实现** —— 不是自己实现一遍 P2P 组网，因此天然兼容官方中继服务器
  以及其它用官方客户端的节点；
- **同进程内运行** —— 不需要额外拉起一个 `easytier-core` 子进程，不用管进程生命周期
  与端口约定；
- **配置走 `TomlConfig` 而不是命令行** —— 参数可审计、不经 shell（详见
  `src/lib.rs` 的 `build_config`）。

## 对外接口

```ts
// src/lib.rs 里的 #[napi] 导出
export interface NodeOptions {
  networkName: string    // EasyTier 网络名，同网络节点必须一致
  networkSecret: string  // 网络密钥（绝不写日志、绝不落盘）
  peers: string[]        // 已知对端 URI，如 "tcp://public.easytier.cn:11010"
  hostname: string       // 本节点在虚拟网络里显示的名字
  ipv4?: string          // 期望虚拟 IP（CIDR），不填则交给 EasyTier 分配
}

export interface NodeStatus {
  running: boolean
  virtualIpv4?: string
  peerCount: number
}

export interface PeerInfo {
  hostname: string
  ipv4?: string
  latencyMs?: number   // 实测 RTT，取自 PeerConnStats.latency_us
  tunnel?: string      // 隧道类型，如 "tcp" / "udp" / "wg"
}

export declare function startNode(options: NodeOptions): Promise<void>
export declare function stopNode(): Promise<void>
export declare function nodeStatus(): Promise<NodeStatus>
export declare function listPeers(): Promise<PeerInfo[]>
```

（napi-rs 默认把 Rust 的 `snake_case` 转成 JS 的 `camelCase`，
所以 `start_node` 在 JS 侧是 `startNode`。）

### 行为约定

| 场景 | 行为 |
| --- | --- |
| 重复调用 `startNode` | 返回 `Ok`，**不重建、不报错**（幂等） |
| 未启动时 `stopNode` | 返回 `Ok`（幂等） |
| 未启动时 `nodeStatus` | `{ running: false, peerCount: 0 }`，**不抛错** |
| 未启动时 `listPeers` | `[]` |
| Rust 侧 panic | 转成 JS 异常，**不让 Node 进程 abort** |

## 依赖来源（⚠️ 与任务描述的差异，重要）

任务描述写的是 `easytier = "2.7"`。**这一行无法使用**，已核实原因如下：

1. **crates.io 上 `easytier` 的最高版本是 2.0.3**（2024-10-13 发布）。
   不存在 2.7.x。`crates.io/api/v1/crates/easytier` 的 versions 列表共 10 条，最高 2.0.3。
2. **`easytier-core` 与 `easytier-proto` 从未发布到 crates.io**（查询直接 not found）。
   2.7 时代的多 crate 结构只存在于 git 仓库。
3. **两个版本的 API 根本不兼容**：
   - `2.0.3`：单 crate，`mod instance;` 是**私有**的，没有 `easytier-core` 依赖，
     也没有 `create_native_instance`。
   - `2.7`（git）：多 crate 工作区，`create_native_instance` / `TomlConfig` /
     `NativeCoreInstance` 都在 `easytier` + `easytier-core` 里。

所以 `Cargo.toml` 用的是 **git 依赖 + 精确 rev**：

```toml
easytier = { git = "https://github.com/EasyTier/EasyTier.git",
             rev = "82dd835c268f6c21405325cdf041e11682e975d0", ... }
```

锁的 `82dd835c` 是 **main 分支 2026-10-24 的 tip**，也正是 `ref/EasyTier/`
里那份源码的 commit（`git log -1` 一致）。它比 tag `v2.7.0`（`8b7f1f01`）多 **54** 个提交。

### 由此带来的兼容风险（必须知道）

本 crate 用到的 `FlagsPatch` / `patch_flags` API **不在 v2.7.0 tag 里**，
它来自 PR #2585（commit `250c2ad8`，"refactor(config): preserve explicit flags with
FlagsPatch and derive CLI arguments from schema"），目前只在 main 上。

即：**本 crate 依赖一个未发布的分支快照**。两条路：

- **锁 main（当前选择）** —— 能编译，但上游 main 一变动就得跟着改 rev。
- **改用 tag `v2.7.0`** —— 需要把 `build_config` 里设置 TUN 名的那段从
  `patch_flags(FlagsPatch { dev_name: Some(..), .. })` 改成：

  ```rust
  // v2.7.0 的 Flags = proto::common::FlagsInConfig，字段可直接赋值
  let mut flags = config.get_flags();
  flags.dev_name = TUN_DEVICE_NAME.to_owned();
  config.set_flags(flags);
  ```

  因为 v2.7.0 的 `get_flags()` 返回完整结构（`flags_struct.unwrap_or_default()`），
  改一个字段再 `set_flags` 回去不会丢其它默认值。

若要发版对外分发，建议**改用 tag + 上面那段 `set_flags` 写法**，避免依赖分支快照。

## Feature 选择

只开必要的，其余全关（对照 `ref/EasyTier/easytier/Cargo.toml:323` 的 `[features]`）。

| 开启 | 为什么 |
| --- | --- |
| `tun` | 需要建虚拟网卡（`llmapi0`），这是组网的前提 |
| `wireguard` | 走 WireGuard 隧道（wg）的节点互通 |
| `quic` | QUIC 传输，官方公共中继常用 |
| `aes-gcm` | 加密算法后端（不依赖 OpenSSL，省掉 libssl 的编译/分发麻烦） |

| 关闭 | 为什么 |
| --- | --- |
| `cli` | 库模式不需要命令行界面 |
| `magic-dns` | 本服务不需要 EasyTier 提供 DNS |
| `upnp` | 自动端口映射，服务化部署里通常由用户自己做 |
| `icmp-proxy` / `socks5` / `kcp` / `websocket` | 本用例用不到的转发与传输方式 |

体积与编译时间的收益大致与关闭的 feature 数量成正比；`socks5` 会连带拉入
`smoltcp`，`websocket` 会拉入 rustls 全家桶，关掉它们省得最多。

### 关于 `management` / `management-rpc`

**故意不开。** `native_instance_manager()` 被 `#[cfg(feature = "management-rpc")]`
门控（`factory.rs:38`），而 `InstanceManager` 的职责是"管理多个实例 + 配置文件生命周期"。
本服务是"一进程一实例、配置由自己持有"，用它是多余的一层。

本 crate 直接用 `create_native_instance`（`factory.rs:52`，**无 feature 门控**），
它接受 `TomlConfig` 并返回 `Arc<NativeCoreInstance>`，正好够用。

> 这也是对任务描述的一处修正：原任务把 `native_instance_manager()` 列为要点，
> 但它需要额外 feature，且对本用例是多余的。

## 构建

### 前置依赖

**通用**

- Rust 工具链。EasyTier 工作区声明 `rust-version = "1.95"`、`edition = "2024"`
  （`ref/EasyTier/Cargo.toml:21-22`），所以**建议直接装 1.95 或更新**，
  更老的工具链会在编译 easytier 时报 edition 不支持。
- Node.js ≥ 16（用 `napi8` ABI；Node 18/20/22 都可以）。
- `@napi-rs/cli` 3.x（`npm i -D @napi-rs/cli`），用于产出 `.node` 与打包。

**Linux**

- `build-essential`（cc、make）—— 有 `ring` / `tun` 等需要编译 C/汇编的依赖。
- `libssl-dev` + `pkg-config` —— 即使选了 `aes-gcm`，依赖树里仍有组件会去找
  OpenSSL 头文件；缺它是最常见的 `openssl-sys` 构建失败原因。
- **TUN 需要 root 或 `CAP_NET_ADMIN`**：

  ```bash
  sudo setcap cap_net_admin+ep $(which node)   # 或者直接用 root 跑
  ```

  没有这个能力时，`start_node` 会在建 TUN 时报权限错误。

**macOS**

- Xcode Command Line Tools（`xcode-select --install`）。
- 首次建 TUN 会弹系统授权框，或需要以 root 运行。

**Windows**

- 需要 **wintun.dll**（[wintun.net](https://www.wintun.net/)），放到
  `node.exe` 同目录或 `C:\Windows\System32`。EasyTier 的 `tun` 依赖在 Windows 上
  正是找它，缺了会在建虚拟网卡时失败。
- 需要 Rust 的 **MSVC** toolchain（`stable-x86_64-pc-windows-msvc`）+ Visual Studio
  Build Tools（含 C++ 桌面开发负载）。

### 命令

```bash
cd native/easytier-node

# 1) 一次性的依赖检查（不编译）
cargo metadata --format-version 1 > /dev/null

# 2) 直接编译，确认 Rust 侧能过
cargo build --release

# 3) 用 napi-rs 打包成 .node 并生成 JS 绑定
npx napi build --platform --release
```

第 2 步是关键：**先 `cargo build` 再 `napi build`**。`napi build` 会顺手生成
`index.js` / `index.d.ts`，但 Rust 侧的编译错误在 `cargo build` 阶段看最清楚
（`napi build` 的输出更杂）。

产物：`easytier-node.<平台>.node` + `index.js` + `index.d.ts`。

### 第一次构建会很慢

EasyTier 的依赖树约 **1128 个 crate**（含 `ring`、`quinn`、`rustls`、`tun` 等）。
首次 `cargo build --release` 在普通开发机上通常需要 **10–30 分钟**，
磁盘占用可达数 GB。这不是卡住了。

## 已核对的源码位置

每个 API 调用点旁边的注释里都有对应位置。汇总如下（路径相对 `ref/EasyTier/`，
行号已逐行 `sed -n` 核对过）：

| API | 位置 |
| --- | --- |
| `create_native_instance(config: TomlConfig) -> anyhow::Result<Arc<NativeCoreInstance>>` | `easytier/src/instance/factory.rs:52` |
| `native_instance_manager()`（需 `management-rpc`，本 crate 不用） | `easytier/src/instance/factory.rs:38-39` |
| `CoreInstance::start(self: &Arc<Self>) -> anyhow::Result<()>` | `easytier-core/src/instance/lifecycle.rs:225` |
| `CoreInstance::stop(self: &Arc<Self>)`（返回 `()`，不是 Result） | `easytier-core/src/instance/lifecycle.rs:279` |
| `CoreInstance` 的 `Drop`（cancel + request_shutdown + request_stop） | `easytier-core/src/instance/mod.rs:1009` |
| `ConfigLoader` trait（set_* 方法集合） | `easytier-core/src/config/toml.rs:28` |
| `TomlConfig::default()` = `new_from_str("")` | `easytier-core/src/config/toml.rs:501` |
| `NetworkIdentity::new(name, secret)` | `easytier-core/src/config/toml.rs:263` |
| `PeerConfig { uri, peer_public_key }` | `easytier-core/src/config/toml.rs:281` |
| `set_hostname` 声明 / 实现 | `toml.rs:33` / `toml.rs:671` |
| `set_ipv4(Option<cidr::Ipv4Inet>)` 声明 / 实现 | `toml.rs:42` / `toml.rs:698` |
| `set_peers(Vec<PeerConfig>)` 声明 / 实现 | `toml.rs:93` / `toml.rs:867` |
| `set_listeners(Vec<Url>)` 声明 / 实现 | `toml.rs:96` / `toml.rs:875` |
| `patch_flags(FlagsPatch)` 声明 / 实现 | `toml.rs:110` / `toml.rs:911` |
| `FlagsPatch` 由 `#[optionize(object = FlagsPatch)]` 生成 | `easytier-proto/build/main.rs:163` |
| `Flags::resolve(patch)` = 默认值 + 显式值 | `easytier-proto/src/common.rs:66` |
| `is_ready()`（state == Running） | `easytier-core/src/instance/management.rs:84` |
| `peer_snapshots() -> Vec<PeerSnapshot>` | `easytier-core/src/instance/management.rs:96` |
| `node_snapshot() -> NodeSnapshot` | `easytier-core/src/instance/management.rs:100` |
| `route_snapshots() -> Vec<Route>` | `easytier-core/src/instance/management.rs:113` |
| `PeerSnapshot` / `NodeSnapshot` 字段 | `easytier-core/src/peers/peer_manager.rs:90` / `:98` |
| `get_latency_ms()`（真实的 RTT 取值方式，读 `latency_us`） | `easytier-proto/src/api.rs:179` |
| `list_peer_route_pair`（peer 与 route 靠 `peer_id` 关联） | `easytier-proto/src/api.rs:272` |
| `Ipv4Inet` 的 `Display`（可直接 `to_string()`） | `easytier-proto/src/common.rs:258` |
| proto `Route`（`path_latency` / `ipv4_addr` / `hostname`） | `easytier-proto/proto/core_peer.proto:42,44,48` |
| proto `PeerConnInfo.tunnel` / `is_closed` | `easytier-proto/proto/core_peer.proto:23,28` |
| proto `PeerConnStats.latency_us` | `easytier-proto/proto/core_peer.proto:15` |
| proto `TunnelInfo.tunnel_type` | `easytier-proto/proto/common.proto:235` |
| proto `Flags.dev_name`（默认空串） | `easytier-proto/proto/common.proto:10` |

对照的另一份实现：`easytier-contrib/easytier-ohrs/`（HarmonyOS 的 NAPI 绑定）。
它的**结构**可参考（`build.rs` 调 `napi_build_ohos::setup()`，本 crate 换成
`napi_build::setup()`），但它依赖 `easytier-ohos-core` 的 `INSTANCE_MANAGER`
全局单例，那套东西在通用平台上不存在，所以**只能借结构、不能照搬调用**。

## 设计取舍

### 单例用 `Mutex<Option<Arc<..>>>`

- `CoreInstance::start/stop` 的签名都是 `self: &Arc<Self>`，所以必须存 `Arc`。
- 用 `tokio::sync::Mutex` 而不是 `RwLock`：`start`/`stop` 必须串行，
  两个并发的 `stop` 会把 `stop_on_runtime` 里的状态机推到未定义的交错上。
- `stop_node` **故意把锁持有到停机结束**：并发的 `start_node` 应当等旧实例
  完全拆完再建新的，否则两个实例会抢同一个 TUN 名 `llmapi0`。代价是停机期间
  `nodeStatus` / `listPeers` 会阻塞（最多约 3.6 秒）。

### 停机分段等待

`STOP_GRACE_STEPS_MS = [800, 1200, 1600]`，语义对齐 SIGTERM。
实现上用 `tokio::pin!` + `&mut` 对**同一个** future 反复加更长的超时，
而不是每档重新 `instance.stop()`：

- `timeout` 到期会丢弃被包的 future，丢弃 `stop` 会打断状态机（TUN 拆到一半就返回，
  留下脏设备）；
- 用 `Pin<&mut F>` 反复轮询，进度是累积的；最后仍没等到就交给 `Drop`
  （它会 `cancel.cancel()` + `request_shutdown()`）做强制清理。

### 延迟取 `latency_us`，不取 `path_latency`

容易踩的坑：`Route.path_latency` **不是毫秒**，它是 OSPF 的**路由开销**
（`peer_ospf_route.rs:448` 里由 `costs % AVOID_RELAY_COST` 算出）。
官方 CLI 展示延迟时也是优先用 `get_latency_ms()`（`easytier-proto/src/api.rs:179`），
它读 `PeerConnStats.latency_us` 再 `/1000`。本 crate 照抄同一套取值顺序：
优先 `default_conn_id` 指向的连接 → 否则所有连接里最小的 `latency_us` → 都没有报 `None`。

### TUN 设备名固定 `llmapi0`

便于用户识别"这是 llmapi-manager 建的网卡"，也便于清理：
`ip link del llmapi0`。

### 不监听本地端口

`set_listeners(Vec::new())`。只用作出站客户端，开监听会占端口并把自己暴露成中继候选。
注意 `get_listeners()` 返回 `Option<Vec<Url>>`，`None` 与空 `Vec` 语义不同：
CLI 在 `None` 时会补默认的 `11010` 监听（`easytier/src/core.rs:758`），
所以这里明确给**空列表**而不是留 `None`。

## 安全约束

- **`network_secret` 绝不写日志、绝不落盘。** 它只在 `build_config` 里被消费一次
  （构造 `NetworkIdentity`），不复制进任何其它结构、不进错误信息、不进返回值。
  持久化由 server 侧负责（那边同样不应存明文）。
- 配置走 `TomlConfig` 的 setter，不拼命令行 —— 可审计、不经 shell。
- panic 在同步边界转成 `napi::Error`，不让它跨 FFI 使进程 abort。

## 首次构建时重点看

因为没编译过，按"最可能出问题"排序，逐条排查：

1. **`FlagsPatch` 字段名**。`FlagsPatch` 是由 `optionize` 从 proto `Flags`
   自动生成的（`easytier-proto/build/main.rs:163`），字段名应与 `Flags` 一致
   （`dev_name`）。若报"no field `dev_name`"，说明生成的补丁结构命名不同
   —— 改成 `set_flags` 写法（见上文"兼容风险"）。
2. **`napi::Result` / `napi::Error::from_reason` 的路径**。napi 3.x 里
   `napi::Result` 是 `Result<T, napi::Error>` 的别名，`from_reason` 接受 `impl Into<String>`。
   若签名不匹配，检查是否启用了 `error_anyhow` feature（`anyhow::Error` 的自动转换靠它）。
3. **`easytier::common::config::{ConfigLoader, NetworkIdentity, PeerConfig, TomlConfig}`
   这组导入是否都在**。`TomlConfig` / `NetworkIdentity` / `PeerConfig` 来自
   `pub use easytier_core::config::toml::*`（`easytier/src/common/config.rs:15`），
   `ConfigLoader` trait 必须 `use` 进来才能调 `set_*`。
4. **`instance.start()` 的借用**。签名是 `self: &Arc<Self>`，调用处必须是 `Arc`
   （`create_native_instance` 返回的就是 `Arc`，所以 `instance.start()` 应能自动取 `&Arc`）。
   若报 method not found，显式写 `Arc::clone(&instance).start()` 或
   `let arc = instance.clone(); arc.start()`。
5. **TUN 权限**。编译过了但运行时 `start_node` 失败，先看是不是 CAP_NET_ADMIN / root
   （Linux）或 wintun.dll（Windows）。
6. **工具链版本**。easytier 要 `edition 2024` + `rust-version 1.95`，老工具链会在
   编译依赖时就失败，报错信息通常很直接（"edition 2024 is not supported"）。
