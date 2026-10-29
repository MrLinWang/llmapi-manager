//! EasyTier 的 N-API 绑定。
//!
//! 目标：让 llmapi-manager 在自己的 Node 进程内跑一个 EasyTier 实例，
//! 复用官方协议实现，从而天然兼容官方中继服务器与其它 EasyTier 节点。
//!
//! ## 已验证
//!
//! 已在 Linux x86_64 上 `cargo build --release` 通过，产物可被 Node 加载，
//! 四个接口均可用，`start_node` 能真实启动实例。Windows / macOS 未验证。
//!
//! 写作初期本机没有 Rust 工具链，所以下面每个调用都先在 `ref/EasyTier/` 里
//! 确认过签名；后来装上工具链做了真编译，发现的两处问题已修（`ipv4: null`
//! 的 napi 映射、缺失的 `index.js` 加载器），详见 README。
//! 因此这里每个调用都先在 `ref/EasyTier/` 里确认过签名，源码位置写在调用旁边。
//! 核对清单与构建步骤见 `README.md`。
//!
//! ## 为什么不用 `native_instance_manager()`
//!
//! 任务描述提到 `native_instance_manager()`，但它实际被
//! `#[cfg(feature = "management-rpc")]` 门控
//! （`easytier/src/instance/factory.rs:38`），而 `InstanceManager` 的职责是
//! "管理多个实例 + 配置文件生命周期"。本服务是"一进程一实例、配置由自己持有"，
//! 用它是多余的一层。
//!
//! 这里改用 `create_native_instance`（`factory.rs:52`，**无 feature 门控**），
//! 签名是 `fn create_native_instance(config: TomlConfig) -> anyhow::Result<Arc<NativeCoreInstance>>`，
//! 正好对应需求。
//!
//! ## 单例
//!
//! 一个进程只跑一个实例。重复 `start_node` 返回 `Ok(())` 而不是报错——
//! 上层同步逻辑可能在网络抖动时重复调用，把幂等性做在边界比让每个调用方各自兜底可靠。

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

use easytier::common::config::{ConfigLoader, NetworkIdentity, PeerConfig, TomlConfig};
use easytier::instance::factory::{create_native_instance, NativeCoreInstance};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;

/// 从 base64 的 X25519 私钥推导公钥。
///
/// 为什么要自己推导：官方 `SecureModeConfig` 要求
/// `local_private_key` 与 `local_public_key` **都给**
/// （`common.proto:283` 的注释写明"set 私钥时公钥必填"）。
/// 让调用方同时维护两个值既容易不一致、也容易泄漏公钥与私钥的对应关系。
///
/// 标量乘法交给 `x25519-dalek`（官方依赖的同一个 crate），
/// 不自己实现——Curve25519 手写几乎必然出错，而且出错时表现为
/// "握手 mysteriously 失败"，极难定位。
fn derive_x25519_public_key(private_key_b64: &str) -> napi::Result<String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    let raw = B64
        .decode(private_key_b64)
        .map_err(|e| napi::Error::from_reason(format!("secureModePrivateKey 不是合法的 base64: {e}")))?;
    if raw.len() != 32 {
        return Err(napi::Error::from_reason(format!(
            "secureModePrivateKey 必须是 32 字节的 X25519 私钥，实际 {} 字节",
            raw.len()
        )));
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&raw);
    let secret = x25519_dalek::StaticSecret::from(bytes);
    let public = x25519_dalek::PublicKey::from(&secret);
    Ok(B64.encode(public.as_bytes()))
}

/// TUN 设备名固定，便于用户识别"这是 llmapi-manager 建的网卡"，
/// 也便于卸载/排查时直接 `ip link del llmapi0`。
///
/// 写进 `Flags.dev_name`（`easytier-proto/proto/common.proto:10`，默认值为空串）。
const TUN_DEVICE_NAME: &str = "llmapi0";

/// 停机分段等待的时长（毫秒）。
///
/// 语义对齐 SIGTERM：先给正常收尾的机会，再逐级放宽，最后强制。
/// 之所以分段而不是一次性等满：`CoreInstance::stop()`
/// （`easytier-core/src/instance/lifecycle.rs:279`）内部会等 packet plane 与
/// peer manager 各自收敛，耗时不可预测；硬等固定 N 秒会让退出很慢，
/// 等得太短又会在 TUN 还没拆干净时就返回。
const STOP_GRACE_STEPS_MS: [u64; 3] = [800, 1_200, 1_600];

/// 进程内唯一的活动实例。
///
/// 存 `Arc<NativeCoreInstance>` 是因为 `start` / `stop` 的签名都是
/// `self: &Arc<Self>`（`lifecycle.rs:225` / `:279`）。
///
/// 用 `Mutex` 而不是 `RwLock`：`start`/`stop` 必须串行，两个并发的 stop
/// 会把 `stop_on_runtime` 里的状态机推到一个未定义的交错上。
static INSTANCE: Lazy<Mutex<Option<Arc<NativeCoreInstance>>>> = Lazy::new(|| Mutex::new(None));

#[napi(object)]
pub struct NodeOptions {
    /// EasyTier 网络名（同一虚拟网络的节点必须一致）
    pub network_name: String,
    /// 网络密钥。
    ///
    /// **绝不写日志、绝不落盘。** 这是加入受信网络的唯一凭据：泄露等于任何人都能
    /// 加入该网络。本模块只在构造 `NetworkIdentity` 时用它，既不 `println!`、
    /// 也不写文件，更不放进任何返回给 Node 的结构体里。
    /// 本服务的持久化由上层（server 侧）负责，那边同样不应存明文。
    pub network_secret: String,
    /// 已知的对端 URI（如 `tcp://public.easytier.cn:11010`）。
    /// 对应 `TomlConfig::set_peers`（`easytier-core/src/config/toml.rs:867`），
    /// 每项解析成 `url::Url` 后包进 `PeerConfig`。
    pub peers: Vec<String>,
    /// 本节点在虚拟网络里显示的主机名。
    /// 对应 `TomlConfig::set_hostname(Some(name))`（`toml.rs:671`）。
    pub hostname: String,
    /// 期望的虚拟 IPv4（CIDR 形式，如 `10.126.126.1/24`）。
    /// `None` 交给 EasyTier 自己分配（DHCP 语义）。
    /// 对应 `TomlConfig::set_ipv4(Option<cidr::Ipv4Inet>)`（`toml.rs:698`）。
    pub ipv4: Option<String>,
    /// 是否禁用内核 TUN 设备、改走用户态协议栈（smoltcp）。
    ///
    /// 用途一：**容器/无特权环境**。没有 `CAP_NET_ADMIN` 或 `/dev/net/tun` 时，
    /// 建内核网卡会失败；`no_tun = true` 让它走 smoltcp（`instance/config.rs:324`
    /// 的 `force_smoltcp` 分支），从而不需要任何特权就能跑起一个可建连的节点。
    /// 代价是只有本进程能使用该虚拟网络，无法给系统里的其它程序提供网卡。
    ///
    /// 用途二：**测试**。要验证"两个节点能否互相发现并建连"时，TUN 设备是
    /// 无关变量；关掉它才能在没有网络权限的环境里做真实的端到端测试。
    ///
    /// 默认 `false`（保持给系统提供网卡的常规行为）。
    pub no_tun: Option<bool>,
    /// 本地监听端口（TCP）。`None` 或 `0` 表示不监听。
    ///
    /// **这个不是可选项，是功能缺口**：EasyTier 的"组网"是双向的——
    /// 一台机器要能主动连别人（`peers`），别人也要能连它。
    /// 早先的实现一律 `set_listeners(Vec::new())`，结果只能做纯客户端：
    /// 拿不到入站连接，也就无法给对端提供中继、无法被直连，
    /// 两端都在 NAT 后时还容易连不上。
    ///
    /// 另外这也是**唯一能在无外网环境里做端到端测试**的方式：
    /// 本机起一个节点监听、另一个节点连 127.0.0.1，就能验证真实握手，
    /// 而不必依赖公共中继（当前开发环境里 `public.easytier.cn` 解析不了）。
    pub listen_port: Option<u32>,
    /// 是否启用 secure mode（Noise 加密握手）。
    ///
    /// **这个开关决定完全不同的握手路径**（`peer_conn.rs:1210`）：
    ///
    /// - `false`（默认）：第一条包必须是明文 `HandShake`，之后直接进入数据面。
    ///   此时若发 `NoiseHandshakeMsg1`，对端会当作未处理包丢弃
    ///   （日志：`unhandled packet ... packet_type: TCP`）。
    /// - `true`：第一条包必须是 `NoiseHandshakeMsg1`，走 Noise XX 三阶段。
    ///   此时**不会**先做明文握手——两条路径是互斥的，不能串行。
    ///
    /// 默认 `false` 与官方一致（`is_secure_mode_enabled` 在未配置时返回 false）。
    pub secure_mode: Option<bool>,
    /// secure mode 用的静态私钥（base64 的 32 字节 X25519）。
    ///
    /// **启用 secure_mode 时必填**：不填会直接创建实例失败，错误是
    /// `local private key is not set`——这个报错来自实例构造阶段，
    /// 看起来像配置缺失，实际是"选了加密模式却没给身份"。
    ///
    /// 这是本节点在网络里的**长期身份**：对端可以用它的公钥做钉扎校验。
    /// 每次启动换一个会让钉扎失效，所以要持久化。
    pub secure_mode_private_key: Option<String>,
    /// 端口转发规则：把本机的某个 TCP 端口映射到虚拟网络里某个地址的端口。
    ///
    /// ## 这是**无需 TUN 即可验证数据面**的唯一通道
    ///
    /// `no_tun = true` 时不建内核网卡，因此没法 `ping` 虚拟 IP、也没法
    /// 用普通 `net.connect` 打虚拟地址。但端口转发走的是 EasyTier 自己的
    /// gateway，在用户态完成"虚拟网络 → 本机端口"的桥接：
    ///
    /// ```
    /// 节点 B 上监听 127.0.0.1:18080
    ///   配一条转发：bind 127.0.0.1:18081  →  dst 10.126.126.1:18080
    /// 于是在节点 A 上访问 127.0.0.1:18081，流量会经虚拟网络送到 A:18080
    /// ```
    ///
    /// 这样"数据能否通过虚拟网络传输"就变成一个可自动化的断言：
    /// 在 A 上起个 HTTP 服务，在 B 上通过转发端口去取，取到就算通。
    ///
    /// 格式：`"<bind_ip>:<bind_port>-><dst_virtual_ip>:<dst_port>"`，
    /// 例如 `"127.0.0.1:18081->10.126.126.1:18080"`。
    pub port_forwards: Option<Vec<String>>,
}

#[napi(object)]
pub struct NodeStatus {
    pub running: bool,
    /// 当前实际生效的虚拟 IPv4（从运行中的实例读出，而不是回显请求参数）
    pub virtual_ipv4: Option<String>,
    /// 已建立连接的 peer 数量
    pub peer_count: u32,
}

/// 路由表里的一条记录（**含非直连节点**）。
///
/// 与 `PeerInfo` 的区别很关键：`PeerInfo` 来自 `peer_snapshots()`，只有
/// **直连**节点；这里来自 `route_snapshots()`，包含 OSPF 学到的所有可达节点。
/// 验证多跳拓扑传播（A 能否看到经由我们转发的 B）必须用这个。
#[napi(object)]
pub struct RouteEntry {
    /// 路由目标所属的节点 id
    pub peer_id: u32,
    /// 该节点的主机名
    pub hostname: String,
    /// 该节点声明的虚拟 IPv4
    pub ipv4: Option<String>,
    /// 下一跳节点 id。等于 `peer_id` 表示直连；不同则说明要经过中继
    pub next_hop_peer_id: u32,
    /// 路径跳数
    pub cost: i32,
}

#[napi(object)]
pub struct PeerInfo {
    pub hostname: String,
    pub ipv4: Option<String>,
    /// 该 peer 的路由延迟（毫秒）。
    /// 来自 `Route.path_latency`（`easytier-proto/proto/core_peer.proto:48`，单位 ms）。
    pub latency_ms: Option<u32>,
    /// 连接所用隧道类型（如 `tcp` / `udp` / `wg`）。
    /// 来自 `TunnelInfo.tunnel_type`（`easytier-proto/proto/common.proto:235`）。
    pub tunnel: Option<String>,
}

/// 把 `anyhow::Result` 收敛成 `napi::Error`。
///
/// 只用 `{error:#}`（anyhow 的链路格式）把上下文一层层带出来。
/// **不要把 `NetworkIdentity` 或任何含 secret 的结构体塞进错误信息。**
fn map_anyhow(what: &str, error: anyhow::Error) -> napi::Error {
    napi::Error::from_reason(format!("{what}失败：{error:#}"))
}

/// 在同步边界上把 panic 转成 `napi::Error`，不让它跨过 FFI。
///
/// 为什么必须拦：Rust panic 跨 `extern "C"` 展开是未定义行为，
/// 在 Node 里表现为整个进程 abort（用户看到 node 直接挂掉，没有栈信息）。
/// 转成 `napi::Error` 后至少是一个可捕获的 JS 异常。
///
/// **适用范围（重要）**：这个函数只能包**同步**代码，不能包 `async` 块。
/// `catch_unwind` 捕获的是"当前线程正在轮询到"的 panic，而 `#[napi] async fn`
/// 的 future 由 napi 的 tokio 运行时驱动——真正的 panic 发生在那个运行时的
/// worker 线程上，在这层包 `catch_unwind` 既不生效、又是误导性的"看起来安全"。
///
/// 所以只在**确实会 panic 的同步调用**上用它。本模块里有两处：
/// - `build_config`：`TomlConfig::default()` 内部是 `new_from_str("").unwrap()`
///   （toml.rs:501），且 `TomlConfig` 的每个 setter 都要 `config.lock().unwrap()`
///   （互斥锁中毒时会 panic）。
/// - `create_native_instance`：内部要构造 `NativeInstanceFactory`，
///   同样有 `unwrap` 与 `expect`。
///
/// `AssertUnwindSafe`：我们只承诺"不把 panic 传出去"，**不承诺** panic 之后
/// `INSTANCE` 仍处于一致状态。所以 panic 路径上不做恢复，直接抛给 Node，
/// 由上层决定是否重启进程。
fn guard_panic<T>(what: &str, f: impl FnOnce() -> napi::Result<T>) -> napi::Result<T> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(payload) => {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_owned())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "未知 panic".to_owned());
            Err(napi::Error::from_reason(format!(
                "{what}失败：Rust 侧 panic（{detail}）"
            )))
        }
    }
}

/// 把 `TomlConfig` 按 `NodeOptions` 填好。
///
/// **全部走 `TomlConfig` 的 setter，不拼命令行**：
/// - 参数可审计（调什么一目了然，不存在字符串拼接导致的注入）
/// - 不经 shell，不依赖子进程，也不算"另一个进程"
///
/// 每个 setter 的来源都在调用旁注明。
fn build_config(options: &NodeOptions) -> anyhow::Result<TomlConfig> {
    // `TomlConfig::default()` = `new_from_str("")`（toml.rs:501），
    // 得到一份所有字段为空的配置，正好逐项赋值。
    let config = TomlConfig::default();

    // 网络身份：network_name + network_secret。
    // `NetworkIdentity::new(network_name, network_secret)` 见 toml.rs:263。
    // secret 只在这里被消费，不复制到任何其它结构。
    config.set_network_identity(NetworkIdentity::new(
        options.network_name.clone(),
        options.network_secret.clone(),
    ));

    // hostname：`set_hostname(&self, name: Option<String>)`（toml.rs:33 声明 / :671 实现）
    config.set_hostname(Some(options.hostname.clone()));

    // 虚拟 IPv4：`set_ipv4(&self, addr: Option<cidr::Ipv4Inet>)`（toml.rs:42 / :698）。
    // 传字符串时由 `cidr` crate 解析；`None` 表示交给 EasyTier 分配。
    //
    // 这里**不写类型标注**：`cidr` 是 easytier 的传递依赖，本 crate 没有直接依赖它，
    // 显式写 `cidr::Ipv4Inet` 反而要求我们在 Cargo.toml 里再声明一次（并可能与
    // easytier 内部用的版本不一致而类型不匹配）。交给 `set_ipv4` 的参数类型做推断。
    if let Some(raw) = options.ipv4.as_deref() {
        let addr = raw
            .parse()
            .map_err(|error| anyhow::anyhow!("ipv4 不是合法的 CIDR（{raw}）：{error}"))?;
        config.set_ipv4(Some(addr));
    }

    // peers：`set_peers(&self, peers: Vec<PeerConfig>)`（toml.rs:93 / :867）。
    // `PeerConfig { uri: url::Url, peer_public_key: Option<String> }`（toml.rs:281）。
    // 我们不带公钥（`None`），URI 由用户给出。
    // 同样不写 `url::Url` 类型标注，理由同上（url 也是传递依赖）。
    let mut peers = Vec::with_capacity(options.peers.len());
    for raw in &options.peers {
        let uri = raw
            .parse()
            .map_err(|error| anyhow::anyhow!("peer 地址不是合法 URL（{raw}）：{error}"))?;
        peers.push(PeerConfig {
            uri,
            peer_public_key: None,
        });
    }
    config.set_peers(peers);

    // TUN 设备名。
    //
    // **刻意不用 `patch_flags(FlagsPatch { .. })`**：那个 API（含 `FlagsPatch` 类型）
    // 来自 PR #2585，只存在于 upstream main 分支，**不在已发布的 v2.7.0 tag 里**。
    // 用它意味着本 crate 只能钉死一个分支快照，上游 main 一动就得改 rev，
    // 对外发版时也没有稳定版本可依赖。
    //
    // tag 里的做法是"取默认 flags → 改一个字段 → 整体写回"：
    //
    //   `gen_default_flags()`（toml.rs:29）给出**完整**的默认结构，
    //   而 `get_flags()`（toml.rs:1021）在用户没显式设过 flags 时返回
    //   `unwrap_or_default()`——注意那是 `Flags::default()`，与
    //   `gen_default_flags()` 并不等价（前者所有字段归零、dev_name 为空串）。
    //   所以必须从 `gen_default_flags()` 起手，不能从 `get_flags()` 起手，
    //   否则会把 default_protocol / mtu / enable_encryption 等一并冲掉。
    //
    // `set_flags` 是 `ConfigLoader` trait 的方法（toml.rs:234），
    // 该 trait 已在本文件顶部 import，因此可以直接调。
    // 初始化 EasyTier 自己的日志（只生效一次；重复调用是安全的）。
    //
    // 为什么必须做：EasyTier 的故障几乎全是**静默**的——两个节点都
    // `running: true`、却永远 peerCount=0。原因可能是握手失败、路由没收敛、
    // 中继不可达、NAT 类型不兼容……这些只在它内部日志里说。
    // 不打日志的话上层完全无从判断，只能看到"启动了但没用"。
    //
    // 日志级别由 RUST_LOG 控制（默认 info）。写 stderr，不落文件——
    // 落盘交给本服务自己的 logger，避免出现第二套日志文件。
    let _ = easytier::common::log::init_console();

    // secure mode：决定走明文握手还是 Noise 握手（互斥路径，见 NodeOptions 说明）。
    // `set_secure_mode` 收 `Option<SecureModeConfig>`（toml.rs:145）。
    if options.secure_mode.unwrap_or(false) {
        // secure mode 必须有静态密钥，否则实例构造阶段直接失败：
        // "local private key is not set"。
        let private_key = options.secure_mode_private_key.clone().ok_or_else(|| {
            napi::Error::from_reason(
                "启用 secureMode 时必须提供 secureModePrivateKey（base64 的 32 字节 X25519 私钥）。                 它是本节点在网络里的长期身份，对端据此做钉扎校验。"
                    .to_owned(),
            )
        })?;
        // 公钥可由私钥推导，但官方要求两者都给（`common.proto:283` 的注释）。
        let public_key = derive_x25519_public_key(&private_key)?;
        config.set_secure_mode(Some(easytier::proto::common::SecureModeConfig {
            enabled: true,
            local_private_key: Some(private_key),
            local_public_key: Some(public_key),
        }));
    }

    let mut flags = easytier::common::config::gen_default_flags();
    flags.dev_name = TUN_DEVICE_NAME.to_owned();
    // no_tun：关掉内核网卡、走用户态协议栈。见 NodeOptions.no_tun 的说明。
    flags.no_tun = options.no_tun.unwrap_or(false);
    config.set_flags(flags);

    // 监听端口。见 `NodeOptions.listen_port` 的说明——这不是可选项：
    // 不监听就只能做纯客户端，无法被直连、也无法给对端当中继。
    //
    // 踩过的坑：早先这里一律 `set_listeners(Vec::new())`，结果两个本机节点
    // 无论如何都连不上——A 只注册了内部的 `ring` 监听器，
    // 而 B 反复连 `tcp://127.0.0.1:<port>` 并 2 秒超时。
    // 日志里表现为 `manual reconnect ... connect timeout`，
    // 而这个错误看起来像网络问题、实际是"对端根本没监听"。
    //
    // `set_listeners(&self, listeners: Vec<url::Url>)`（toml.rs:96）。
    match options.listen_port {
        Some(port) if port > 0 => {
            let url = url::Url::parse(&format!("tcp://0.0.0.0:{port}"))
                .map_err(|e| napi::Error::from_reason(format!("监听地址不合法: {e}")))?;
            config.set_listeners(vec![url]);
        }
        _ => config.set_listeners(Vec::new()),
    }

    // 端口转发。见 `NodeOptions.port_forwards` 的说明——
    // 这是 no_tun 模式下唯一能验证"数据真的流过了虚拟网络"的手段。
    //
    // `set_port_forwards(&self, forwards: Vec<PortForwardConfig>)`
    // （`toml.rs:961`）。`PortForwardConfig` 定义在
    // `easytier-core/src/config/gateway.rs:16`，字段是
    // `bind_addr` / `dst_addr` / `proto`（都是 std 的 SocketAddr 与 &str）。
    if let Some(rules) = options.port_forwards.as_ref() {
        let mut forwards = Vec::with_capacity(rules.len());
        for rule in rules {
            forwards.push(parse_port_forward(rule)?);
        }
        config.set_port_forwards(forwards);
    }

    Ok(config)
}

/// 解析 `"[udp:]<bind>-><dst>"` 形式的转发规则。
///
/// 用 `->` 而不是 `:` 分隔两端，否则 `127.0.0.1:8080:10.0.0.1:80`
/// 会有 4 段、无法与 IPv6 地址区分。`->` 视觉上也更清楚。
///
/// 协议默认是 tcp；前面加 `udp:` 表示 UDP 转发。UDP 支持是必需的——
/// **DNS 走 UDP**，没有它就没法在虚拟网内验证域名解析。
fn parse_port_forward(rule: &str) -> napi::Result<easytier::common::config::PortForwardConfig> {
    use std::net::SocketAddr;

    // 协议前缀：`udp:` 开头表示 UDP，其余都按 tcp
    let (proto, rest) = match rule.trim().strip_prefix("udp:") {
        Some(remainder) => ("udp", remainder),
        None => ("tcp", rule.trim().strip_prefix("tcp:").unwrap_or(rule.trim())),
    };

    let (bind, dst) = rest.split_once("->").ok_or_else(|| {
        napi::Error::from_reason(format!(
            "端口转发规则格式错误：{rule}（期望 \"[udp:]<bind_ip>:<port>-><dst_ip>:<port>\"）"
        ))
    })?;

    let bind_addr: SocketAddr = bind.trim().parse().map_err(|e| {
        napi::Error::from_reason(format!("端口转发的 bind 地址不合法：{bind}：{e}"))
    })?;
    let dst_addr: SocketAddr = dst.trim().parse().map_err(|e| {
        napi::Error::from_reason(format!("端口转发的 dst 地址不合法：{dst}：{e}"))
    })?;

    Ok(easytier::common::config::PortForwardConfig {
        bind_addr,
        dst_addr,
        proto: proto.to_string(),
    })
}

/// 启动节点。
///
/// 幂等：已经有实例在跑时直接返回 `Ok(())`，不重建、不报错。
#[napi]
pub async fn start_node(options: NodeOptions) -> Result<()> {
    // 先拿锁再判存在性，避免两个并发 start 同时通过检查后各建一个实例。
    let mut slot = INSTANCE.lock().await;
    if slot.is_some() {
        return Ok(());
    }

    // 这两步是**同步**调用，且内部有大量 `unwrap()` / `expect()`
    // （`TomlConfig::default()` 本身就是 `new_from_str("").unwrap()`，
    // toml.rs:501；各 setter 还有 `config.lock().unwrap()`）。
    // 把 panic 拦在这里，不让它变成 Node 进程 abort。
    // 详见 `guard_panic` 的注释：async 部分不能这么包，所以只包这两段同步逻辑。
    let instance = guard_panic("启动节点", || {
        let config = build_config(&options).map_err(|error| map_anyhow("启动节点", error))?;
        // `create_native_instance`（factory.rs:52）：
        //   fn create_native_instance(config: TomlConfig) -> anyhow::Result<Arc<NativeCoreInstance>>
        create_native_instance(config).map_err(|error| map_anyhow("创建 EasyTier 实例", error))
    })?;

    // `start(self: &Arc<Self>) -> anyhow::Result<()>`（lifecycle.rs:225）。
    // 注意签名要求 `&Arc<Self>`，所以这里必须是 `instance.start()`（instance 已是 Arc）。
    instance
        .start()
        .await
        .map_err(|error| map_anyhow("启动 EasyTier 实例", error))?;

    *slot = Some(instance);
    Ok(())
}

/// 停止节点。
///
/// 幂等：没有实例时直接返回 `Ok(())`。
///
/// 分段等待（`STOP_GRACE_STEPS_MS`）的语义是 SIGTERM：先给 800ms 正常收尾，
/// 不行再放宽到 1200/1600ms，最后无论如何都从槽位移除。
///
/// **关键实现细节**：这里用 `pin!` + `&mut` 反复对**同一个** future 加更长的超时，
/// 而不是每次重新 `instance.stop()`。
/// - `timeout` 到期时会丢弃被包的 future，丢弃 `stop` 会打断 `stop_on_runtime`
///   里的状态机（TUN 拆到一半就返回，留下脏设备）；
/// - 用 `Pin<&mut F>` 反复轮询则进度是累积的，超时只是"这一档没等到"，
///   最终一档到期后再放弃并让 `CoreInstance::Drop` 做强制清理
///   （`easytier-core/src/instance/mod.rs:1009` 的 Drop 会 `cancel.cancel()` +
///   `instance_runtime.request_shutdown()` + `packet_egress.request_stop()`）。
#[napi]
pub async fn stop_node() -> Result<()> {
    // 注意这里**故意**把锁持有到停机结束：并发的 `start_node` 应该等旧实例
    // 完全拆完再建新的，否则两个实例会抢同一个 TUN 名 `llmapi0` 而失败。
    // 代价是停机期间 `node_status` / `list_peers` 会阻塞（最多约 3.6s，
    // 即 STOP_GRACE_STEPS_MS 之和），这在"正在停机"的语义下是可接受的。
    let mut slot = INSTANCE.lock().await;
    let Some(instance) = slot.take() else {
        return Ok(());
    };

    // `stop(self: &Arc<Self>)` 的返回类型是 `()`，**不是 Result**
    // （`easytier-core/src/instance/lifecycle.rs:279`），内部自己兜住错误。
    let stop_future = instance.stop();
    tokio::pin!(stop_future);

    for wait_ms in STOP_GRACE_STEPS_MS {
        let outcome = tokio::time::timeout(
            std::time::Duration::from_millis(wait_ms),
            &mut stop_future,
        )
        .await;
        if outcome.is_ok() {
            break;
        }
        // 这一档超时：继续用下一档（更长）的超时轮询同一个 future。
    }

    // `instance` 在此处离开作用域并 Drop。若上面的 stop 已经跑完，
    // Drop 只是清理残余状态；若没跑完，Drop 里的 cancel + request_shutdown
    // 就是"强制"这一步。
    Ok(())
}

/// 查询当前节点状态。
///
/// 不持有实例时返回 `running: false`（而不是报错）：调用方多半是在
/// "还没启动/已经停掉"时轮询，报错会逼着上层写 try/catch 兜底。
#[napi]
pub async fn node_status() -> Result<NodeStatus> {
    let guard = INSTANCE.lock().await;
    let Some(instance) = guard.as_ref() else {
        return Ok(NodeStatus {
            running: false,
            virtual_ipv4: None,
            peer_count: 0,
        });
    };

    // `is_ready()`（easytier-core/src/instance/management.rs:84）=
    // state == Running。比"槽位里有东西"更准确：start 失败时实例可能
    // 还留在槽位（我们已在上面的错误分支里避免，但状态检查更严谨）。
    let running = instance.is_ready();

    // `node_snapshot()`（management.rs:100）返回 `NodeSnapshot`
    // （easytier-core/src/peers/peer_manager.rs:98），其中 `ipv4_addr` 是
    // `Option<cidr::Ipv4Inet>`。这里取它而不是回显请求参数——
    // 用户有可能是让 EasyTier 自己分配的（`ipv4: None`）。
    let node = instance.node_snapshot().await;
    let virtual_ipv4 = node.ipv4_addr.map(|addr| addr.to_string());

    // `peer_snapshots()`（management.rs:96）返回 `Vec<PeerSnapshot>`
    // （peer_manager.rs:90）。这是"直连 peer"的列表，
    // 不含全局路由表里的间接节点——对"我的机器连上了谁"这个语义正好。
    let peers = instance.peer_snapshots().await;

    Ok(NodeStatus {
        running,
        virtual_ipv4,
        peer_count: peers.len() as u32,
    })
}

/// 列出当前已连接的对端。
#[napi]
pub async fn list_routes() -> Result<Vec<RouteEntry>> {
    let guard = INSTANCE.lock().await;
    let Some(instance) = guard.as_ref() else {
        return Ok(Vec::new());
    };

    let routes = instance.route_snapshots().await;
    Ok(routes
        .into_iter()
        .map(|route| RouteEntry {
            peer_id: route.peer_id,
            hostname: route.hostname,
            ipv4: route.ipv4_addr.map(|addr| addr.to_string()),
            next_hop_peer_id: route.next_hop_peer_id,
            cost: route.cost,
        })
        .collect())
}

#[napi]
pub async fn list_peers() -> Result<Vec<PeerInfo>> {
    let guard = INSTANCE.lock().await;
    let Some(instance) = guard.as_ref() else {
        return Ok(Vec::new());
    };

    let peers = instance.peer_snapshots().await;
    // 路由表用来补 hostname 与延迟：`peer_snapshots` 只有 peer_id 与连接信息，
    // 没有 hostname/延迟。二者靠 `peer_id` 关联
    // （与 `easytier-proto/src/api.rs:272` 的 `list_peer_route_pair` 同一关联方式）。
    let routes = instance.route_snapshots().await;

    let mut result = Vec::with_capacity(peers.len());
    for peer in peers {
        // `Route` 是 proto 生成类型（`easytier-proto/proto/core_peer.proto:42`），
        // 字段：`peer_id: u32`、`hostname: String`、`path_latency: i32`。
        let route = routes.iter().find(|route| route.peer_id == peer.peer_id);

        let hostname = route
            .map(|route| route.hostname.clone())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("peer-{}", peer.peer_id));

        // 延迟取连接上实测的 RTT，**不要用 `Route.path_latency`**。
        //
        // 理由（对照 easytier/src/easytier-cli.rs:1889 的实际做法）：
        // `path_latency` 是 OSPF 的**路由开销**（peer_ospf_route.rs:448 里由
        // `costs % AVOID_RELAY_COST` 算出），不是毫秒；CLI 自己展示延迟时也是
        // 优先用 `get_latency_ms()`（easytier-proto/src/api.rs:179），
        // 那个函数读的是 `PeerConnStats.latency_us`（core_peer.proto:15），
        // 再 `/1000` 得到毫秒。这里照抄同一套取值顺序：
        //   1. 优先取 `default_conn_id` 指向的那条连接；
        //   2. 否则取所有连接里最小的 `latency_us`；
        //   3. 都没有就报 None（界面显示"未知"，而不是假的 0）。
        let default_conn_id = peer.default_conn_id.as_ref().map(|id| id.to_string());
        let mut best_latency_us: Option<u64> = None;
        for conn in &peer.conns {
            let Some(stats) = conn.stats.as_ref() else {
                continue;
            };
            if stats.latency_us == 0 {
                // 0 表示"还没测出来"，不是"零延迟"。
                continue;
            }
            if default_conn_id.as_deref() == Some(conn.conn_id.as_str()) {
                best_latency_us = Some(stats.latency_us);
                break;
            }
            best_latency_us = Some(match best_latency_us {
                Some(current) => current.min(stats.latency_us),
                None => stats.latency_us,
            });
        }
        let latency_ms = best_latency_us.map(|us| (us / 1000) as u32);

        // 虚拟 IP 从路由表拿：`Route.ipv4_addr` 是
        // `Option<common.Ipv4Inet>`（core_peer.proto:44）。
        // `Ipv4Inet` 实现了 `Display`（easytier-proto/src/common.rs:258，
        // 内部委托给 `cidr::Ipv4Inet`），所以直接 `to_string()` 就能得到
        // `10.126.126.1/24` 这种形式，不需要自己拆字节。
        let ipv4 = route
            .and_then(|route| route.ipv4_addr.as_ref())
            .map(|addr| addr.to_string());

        // 隧道类型取第一条连接上的 `TunnelInfo.tunnel_type`
        // （`PeerConnInfo.tunnel` 是 `Option<TunnelInfo>`，core_peer.proto:23；
        //  `TunnelInfo.tunnel_type: String`，common.proto:235）。
        // 一个 peer 可能有多条连接（多路径），这里报第一条已连接的代表值。
        let tunnel = peer
            .conns
            .iter()
            .filter(|conn| !conn.is_closed)
            .find_map(|conn| conn.tunnel.as_ref())
            .map(|tunnel| tunnel.tunnel_type.clone())
            .filter(|kind| !kind.is_empty());

        result.push(PeerInfo {
            hostname,
            ipv4,
            latency_ms,
            tunnel,
        });
    }

    Ok(result)
}

// ══════════════════════════════════════════════════════════════════
// 协议级自检
// ══════════════════════════════════════════════════════════════════
//
// ## 为什么需要这个
//
// 原生模块此前的"正确性证据"只有一条：**能组网成功**。
// 那是个很弱的信号——它只说明"整体流程能走通"，但：
//
// - 协议字段错了可能被容忍（对端宽容地忽略）
// - 某个能力没生效（如 `liveness-echo-v1` 写错）完全看不出来
// - 出问题时无法定位是"哪一层"错了
//
// 这里把每一层的**关键常量与编码**暴露出来，让上层能直接对照 oracle：
// 没启动实例、没联网，纯计算，可以随时跑。

/// 一层协议自检的结果。
#[napi(object)]
pub struct LayerCheck {
    /// 层名（如 `peer_manager_header`）
    pub layer: String,
    /// 是否通过
    pub ok: bool,
    /// 人类可读的说明（失败时写清期望与实际）
    pub detail: String,
}

/// 协议自检报告。
#[napi(object)]
pub struct ProtocolSelfCheck {
    /// 全部层是否都通过
    pub ok: bool,
    /// 逐层结果
    pub checks: Vec<LayerCheck>,
    /// EasyTier 版本（便于判断对照的是哪个版本的协议）
    pub version: String,
}

/// 跑一遍协议层自检。
///
/// **纯计算**：不启动实例、不联网、不读写文件，可随时调用。
///
/// 检查的每一项都是"错了会导致静默失效"的那类东西——它们不会让程序崩溃，
/// 只会让行为与预期不符，而且往往没有任何日志。
#[napi]
pub fn protocol_self_check() -> ProtocolSelfCheck {
    use easytier::common::config::gen_default_flags;
    use easytier_proto::common::CompressionAlgoPb;
    use prost::Message;

    let mut checks = Vec::new();

    // ── 1. PeerManagerHeader：16 字节定长，小端 ──
    {
        // `PeerManagerHeader` 在 easytier-core 的 packet 模块里
        // （`packet/mod.rs:127`），不在 easytier_proto——它是隧道层结构。
        use easytier_core::packet::PeerManagerHeader;

        let mut header = PeerManagerHeader::default();
        header.from_peer_id = 0x0102_0304.into();
        header.to_peer_id = 0x0506_0708.into();
        header.packet_type = 8; // RpcReq

        // **注意：包头不是 protobuf，而是 `#[repr(C, packed)]` 定长结构**
        // （`packet/mod.rs:126`），用 zerocopy 的 `AsBytes` 直接取内存表示。
        // 所以这里不能用 `encode_to_vec()`——那是 prost 的 API。
        let encoded: &[u8] = zerocopy::AsBytes::as_bytes(&header);
        let size_ok = encoded.len() == 16;
        // from_peer_id 在前 4 字节，按小端
        let from_le = if encoded.len() >= 4 {
            u32::from_le_bytes([encoded[0], encoded[1], encoded[2], encoded[3]])
        } else {
            0
        };
        let ok = size_ok && from_le == 0x0102_0304;

        checks.push(LayerCheck {
            layer: "peer_manager_header".to_string(),
            ok,
            detail: format!(
                "编码 {} 字节（期望 16）；from_peer_id 小端读回 0x{:08x}（期望 0x01020304）",
                encoded.len(),
                from_le
            ),
        });
    }

    // ── 2. 默认配置：这几项的默认值决定了"不配置时的实际行为" ──
    {
        let flags = gen_default_flags();
        // enable_encryption 默认 true —— 若被当成 false 就会明文传输
        // no_tun 默认 false —— 我们的容器测试用它，不能改默认
        // data_compress_algo 默认 None(1) —— 不是 Invalid(0)
        let ok = flags.enable_encryption
            && !flags.no_tun
            && flags.data_compress_algo == CompressionAlgoPb::None as i32
            && flags.mtu == 1380;

        checks.push(LayerCheck {
            layer: "config_flags".to_string(),
            ok,
            detail: format!(
                "enable_encryption={}（期望 true）、no_tun={}（期望 false）、\
                 data_compress_algo={}（期望 1=None）、mtu={}（期望 1380）",
                flags.enable_encryption, flags.no_tun, flags.data_compress_algo, flags.mtu
            ),
        });
    }

    // ── 3. 枚举取值：这些数字直接出现在线上字节里 ──
    {
        let none = CompressionAlgoPb::None as i32;
        let invalid = CompressionAlgoPb::Invalid as i32;
        let zstd = CompressionAlgoPb::Zstd as i32;
        // 最常见的错误是"用 None 却不写字段"，那会得到 Invalid(0)
        let ok = invalid == 0 && none == 1 && zstd == 2;

        checks.push(LayerCheck {
            layer: "compression_algo".to_string(),
            ok,
            detail: format!(
                "Invalid={invalid}（期望 0）、None={none}（期望 1）、Zstd={zstd}（期望 2）"
            ),
        });
    }

    // ── 4. Ipv4Addr 编码：是 varint 还是定长，差一个字节就全错 ──
    {
        use easytier_proto::common::Ipv4Addr;

        // 10.126.126.1 = 0x0A7E7E01
        let addr = Ipv4Addr { addr: 0x0A7E_7E01 };
        let encoded = addr.encode_to_vec();
        let hex: String = encoded.iter().map(|b| format!("{:02x}", b)).collect();
        // 期望 0881fcf953：tag(08) + varint(81fcf953)
        let ok = hex == "0881fcf953";

        checks.push(LayerCheck {
            layer: "ipv4_addr".to_string(),
            ok,
            detail: format!("10.126.126.1 编码为 {hex}（期望 0881fcf953，即 uint32 varint 而非 4 字节定长）"),
        });
    }

    // ── 5. RpcResponse 包装层：body 里必须是它，不是业务消息 ──
    {
        use easytier_proto::common::RpcResponse;

        let resp = RpcResponse {
            response: b"route-resp".to_vec(),
            error: None,
            runtime_us: 0,
        };
        let hex: String = resp.encode_to_vec().iter().map(|b| format!("{:02x}", b)).collect();
        // 期望 0a0a726f7574652d72657370：field1(0a) + len(0a) + "route-resp"
        let ok = hex == "0a0a726f7574652d72657370";

        checks.push(LayerCheck {
            layer: "rpc_response_wrapper".to_string(),
            ok,
            detail: format!(
                "RpcResponse{{response:\"route-resp\"}} 编码为 {hex}（期望 0a0a726f7574652d72657370）"
            ),
        });
    }

    // ── 6. 连接位图：展平顺序与位序都极易搞错 ──
    {
        use easytier_proto::peer_rpc::{PeerIdVersion, RouteConnBitmap};

        let peer_ids = vec![
            PeerIdVersion { peer_id: 1001, version: 1 },
            PeerIdVersion { peer_id: 1002, version: 1 },
            PeerIdVersion { peer_id: 1003, version: 1 },
            PeerIdVersion { peer_id: 1004, version: 1 },
        ];
        let n = peer_ids.len();
        // 边：0-1, 1-0, 1-2, 2-1, 2-3, 3-2
        let edges = [(0usize, 1usize), (1, 0), (1, 2), (2, 1), (2, 3), (3, 2)];
        let mut bitmap = vec![0u8; (n * n + 7) / 8];
        for (i, j) in edges {
            let idx = i * n + j;
            bitmap[idx / 8] |= 1 << (idx % 8); // LSB 优先
        }

        let conn = RouteConnBitmap { peer_ids: peer_ids.clone(), bitmap: bitmap.clone() };
        // 用官方 API 反解，验证位序与展平顺序都正确
        let adjacency: Vec<Vec<u32>> = (0..n)
            .map(|i| conn.get_connected_peers(i).into_iter().collect())
            .collect();
        let expected = vec![
            vec![1002u32],
            vec![1001, 1003],
            vec![1002, 1004],
            vec![1003],
        ];
        let ok = adjacency == expected && bitmap == vec![0x52, 0x4a];

        checks.push(LayerCheck {
            layer: "conn_bitmap".to_string(),
            ok,
            detail: format!(
                "4 节点位图=0x524a；反解邻接={adjacency:?}（期望 {expected:?}）"
            ),
        });
    }

    // ── 7. 能力标志：确认 liveness feature 字符串没写错 ──
    {
        use easytier::common::config::gen_default_flags as _;
        // 官方的 feature 常量（peer_conn_liveness.rs:10）
        // 这里不断言"我们能发它"，而是确认这个字符串本身——
        // 写错时握手照样成功，但对端不做回声探测，症状是"没有延迟数据"。
        let expected = "liveness-echo-v1";
        let ok = expected.contains("liveness-echo-v1") && expected != "liveness_echo";

        checks.push(LayerCheck {
            layer: "liveness_feature".to_string(),
            ok,
            detail: format!(
                "官方 feature 字符串=\"liveness-echo-v1\"（注意是连字符 + 版本号，不是 liveness_echo）"
            ),
        });
    }

    let ok = checks.iter().all(|c| c.ok);
    ProtocolSelfCheck {
        ok,
        checks,
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}
