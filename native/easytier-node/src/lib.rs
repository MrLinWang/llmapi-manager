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
}

#[napi(object)]
pub struct NodeStatus {
    pub running: bool,
    /// 当前实际生效的虚拟 IPv4（从运行中的实例读出，而不是回显请求参数）
    pub virtual_ipv4: Option<String>,
    /// 已建立连接的 peer 数量
    pub peer_count: u32,
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

    Ok(config)
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
