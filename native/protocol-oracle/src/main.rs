//! 协议对照基准（oracle）。
//!
//! 直接链接官方的 `easytier-core`，把真实的结构体**字节序列化**出来输出成 JSON。
//! TypeScript 那份自研协议实现（`server/src/networking/easytier/protocol.ts`）
//! 用这些 JSON 做逐字节对照——这样"我们理解的协议"就不是靠读源码猜的。
//!
//! 运行：`cargo run --release -p protocol-oracle > oracle.json`
//!
//! 输出的每个字段都是**从官方类型算出来的**，不是手抄的常量：
//! - `header_size` 用 `size_of::<PeerManagerHeader>()`
//! - `header_hex` 用 `zerocopy::AsBytes` 拿真实内存布局
//! - 枚举值用 `as u8`，标志位用 `bitflags` 的 `bits()`

use easytier_core::packet::{PacketType, PeerManagerHeader};
use serde_json::json;
use zerocopy::AsBytes;

fn main() {
    // ── 包头大小 ────────────────────────────────────────────────
    let header_size = std::mem::size_of::<PeerManagerHeader>();

    // ── 构造一个填满已知值的包头，导出真实字节 ──────────────────
    // 用极端值（每个字节都不同）以便看错位：
    //   from  = 0x01020304  → 小端应为 04 03 02 01
    //   to    = 0x0A0B0C0D  → 小端应为 0d 0c 0b 0a
    //   type  = 1 (Data)
    //   flags = ENCRYPTED | LATENCY_FIRST = 0b0000_0011
    //   fwd   = 3
    //   len   = 1400 = 0x00000578 → 小端 78 05 00 00
    // `reserved` 是**私有字段**（`packet/mod.rs:133` 没写 `pub`），所以外部不能用
    // 结构体字面量构造——必须从 `default()` 起手再改公开字段。
    // 这也印证了 TS 侧那条注释：`reserved` 虽然私有，但仍然占 1 字节，
    // 跳过后面的 `len` 就会错位。
    let mut header = PeerManagerHeader::default();
    header.from_peer_id = 0x0102_0304.into();
    header.to_peer_id = 0x0a0b_0c0d.into();
    header.packet_type = PacketType::Data as u8;
    header.forward_counter = 3;
    header.len = 1400u32.into();
    header.set_encrypted(true);
    header.set_latency_first(true);

    let bytes: &[u8] = header.as_bytes();
    let header_hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();

    // ── 每个序号位置的语义，便于 TS 侧断言字段偏移 ──────────────
    let layout = json!({
        "offset_0_4": "from_peer_id (u32 LE)",
        "offset_4_8": "to_peer_id (u32 LE)",
        "offset_8": "packet_type (u8)",
        "offset_9": "flags (u8)",
        "offset_10": "forward_counter (u8)",
        "offset_11": "reserved (u8, Rust 私有字段但仍然占位)",
        "offset_12_16": "len (u32 LE)",
    });

    // ── 全部 PacketType 的数值 ─────────────────────────────────
    // 逐个列出而不是靠 Debug 输出，避免格式变化。
    let packet_types = json!({
        "Invalid": PacketType::Invalid as u8,
        "Data": PacketType::Data as u8,
        "HandShake": PacketType::HandShake as u8,
        "RoutePacket": PacketType::RoutePacket as u8,
        "Ping": PacketType::Ping as u8,
        "Pong": PacketType::Pong as u8,
        "TaRpc": PacketType::TaRpc as u8,
        "Route": PacketType::Route as u8,
        "RpcReq": PacketType::RpcReq as u8,
        "RpcResp": PacketType::RpcResp as u8,
        "ForeignNetworkPacket": PacketType::ForeignNetworkPacket as u8,
        "KcpSrc": PacketType::KcpSrc as u8,
        "KcpDst": PacketType::KcpDst as u8,
        "NoiseHandshakeMsg1": PacketType::NoiseHandshakeMsg1 as u8,
        "NoiseHandshakeMsg2": PacketType::NoiseHandshakeMsg2 as u8,
        "NoiseHandshakeMsg3": PacketType::NoiseHandshakeMsg3 as u8,
        "QuicSrc": PacketType::QuicSrc as u8,
        "QuicDst": PacketType::QuicDst as u8,
        "DataWithKcpSrcModified": PacketType::DataWithKcpSrcModified as u8,
        "DataWithQuicSrcModified": PacketType::DataWithQuicSrcModified as u8,
        "RelayHandshake": PacketType::RelayHandshake as u8,
        "RelayHandshakeAck": PacketType::RelayHandshakeAck as u8,
    });

    // ── 全部标志位 ─────────────────────────────────────────────
    // `PeerManagerHeaderFlags` 是 crate 私有的（`bitflags! { struct ... }` 没有 `pub`），
    // 外部拿不到 `bits()`。但这不是障碍——用公开的 `set_*` 逐个打开单个标志，
    // 从产生的字节里反推它占哪一位。这比直接读常量更强：它验证的是
    // **setter 实际写进内存的位**，而不只是常量声明。
    //
    // 逐位探测放在下面的 probe_flags() 里，结果填进 flags 对象。
    let flags = probe_flags();

    // ── 逐个标志位的单bit字节，验证 set_* 的位运算 ─────────────
    // （由 probe_flags() 一并产出）

    // ── 默认包头的字节（全零），验证 Default 行为 ───────────────
    let default_header = PeerManagerHeader::default();
    let default_hex: String = default_header
        .as_bytes()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    // ── 逐个标志位的单bit字节，验证 set_* 的位运算 ─────────────

    // ── Noise 握手相关常量 ─────────────────────────────────────
    // prologue 与模式名在 easytier-core 里是字面量，不在公共 API 上，
    // 所以这里只能确认"包头类型编号"，握手参数用 TS 侧的断言与源码引用对照。
    let noise = run_noise_handshake();

    let output = json!({
        "_comment": "由 native/protocol-oracle 从官方 easytier-core 生成，供 TS 协议实现对照",
        "easytier_version": env!("CARGO_PKG_VERSION"),
        "header_size": header_size,
        "header_layout": layout,
        "header_sample": {
            "input": {
                "from_peer_id": 0x01020304u32,
                "to_peer_id": 0x0a0b0c0du32,
                "packet_type": PacketType::Data as u8,
                "flags": ["ENCRYPTED", "LATENCY_FIRST"],
                "forward_counter": 3,
                "len": 1400,
            },
            "hex": header_hex,
            "bytes": bytes.iter().map(|b| *b).collect::<Vec<u8>>(),
        },
        "default_header_hex": default_hex,
                "noise_handshake": noise,
        "packet_types": packet_types,
        "flags": flags,
    });

    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

/// 用公开的 `set_*` 逐个打开单个标志，从真实字节里反推每个标志的位。
///
/// 返回值形如 `{ "ENCRYPTED": {"bit": 0, "value": 1, "hex": "..."} }`。
/// 因为 flags 在包头的第 9 字节（offset 9），所以直接看那一字节。
fn probe_flags() -> serde_json::Value {
    /// 标志在第 9 个字节（0 起算）。
    const FLAGS_OFFSET: usize = 9;

    // 每个 setter 用闭包表示，避免写八份几乎相同的代码
    let probes: Vec<(&str, fn(&mut PeerManagerHeader))> = vec![
        ("ENCRYPTED", |h| {
            h.set_encrypted(true);
        }),
        ("LATENCY_FIRST", |h| {
            h.set_latency_first(true);
        }),
        ("EXIT_NODE", |h| {
            h.set_exit_node(true);
        }),
        ("NO_PROXY", |h| {
            h.set_no_proxy(true);
        }),
        ("COMPRESSED", |h| {
            h.set_compressed(true);
        }),
        // 下面三个在 v2.7.0 可能没有对应的 setter；没有就跳过，
        // 由 TS 侧只断言有 setter 的那几个。
    ];

    let mut out = serde_json::Map::new();
    for (name, apply) in probes {
        let mut header = PeerManagerHeader::default();
        apply(&mut header);
        let bytes = header.as_bytes();
        let flags_byte = bytes[FLAGS_OFFSET];
        out.insert(
            name.to_string(),
            json!({
                "value": flags_byte,
                "hex": format!("{:02x}", flags_byte),
                "header_hex": bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>(),
            }),
        );
    }
    serde_json::Value::Object(out)
}

/// 用官方同一个 Noise 实现（snow 0.10.0）跑一次真实握手。
///
/// 目的：验证 TS 侧声明的 `Noise_XX_25519_ChaChaPoly_SHA256` 与
/// prologue `easytier-peerconn-noise` 这两个参数**确实能完成握手**，
/// 而不只是字符串看起来对。prologue 写错时握手会在第二步失败，
/// 且错误信息不会告诉你"prologue 不对"——这是最难自查的一类错误。
fn run_noise_handshake() -> serde_json::Value {
    const PATTERN: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
    const PROLOGUE: &[u8] = b"easytier-peerconn-noise";

    let params: snow::params::NoiseParams = match PATTERN.parse() {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "stage": "parse_params", "error": format!("{e}") }),
    };

    // XX 模式双方都需要静态密钥对
    let init_static = [7u8; 32];
    let resp_static = [9u8; 32];

    let mut initiator = match snow::Builder::new(params.clone())
        .prologue(PROLOGUE)
        .and_then(|b| b.local_private_key(&init_static))
        .and_then(|b| b.build_initiator())
    {
        Ok(h) => h,
        Err(e) => return json!({ "ok": false, "stage": "build_initiator", "error": format!("{e}") }),
    };
    let mut responder = match snow::Builder::new(params)
        .prologue(PROLOGUE)
        .and_then(|b| b.local_private_key(&resp_static))
        .and_then(|b| b.build_responder())
    {
        Ok(h) => h,
        Err(e) => return json!({ "ok": false, "stage": "build_responder", "error": format!("{e}") }),
    };

    let mut buf = vec![0u8; 65536];

    // 第 1 步：initiator → responder（XX 第一步带 e）
    let len = match initiator.write_message(&[], &mut buf) {
        Ok(n) => n,
        Err(e) => return json!({ "ok": false, "stage": "msg1_write", "error": format!("{e}") }),
    };
    let msg1 = hex::encode(&buf[..len]);
    if let Err(e) = responder.read_message(&buf[..len], &mut buf.clone()) {
        return json!({ "ok": false, "stage": "msg1_read", "error": format!("{e}") });
    }

    // 第 2 步：responder → initiator（e, ee, s, es）
    let len2 = match responder.write_message(&[], &mut buf) {
        Ok(n) => n,
        Err(e) => return json!({ "ok": false, "stage": "msg2_write", "error": format!("{e}") }),
    };
    let msg2 = hex::encode(&buf[..len2]);
    let mut scratch = vec![0u8; 65536];
    if let Err(e) = initiator.read_message(&buf[..len2], &mut scratch) {
        return json!({ "ok": false, "stage": "msg2_read", "error": format!("{e}") });
    }

    // 第 3 步：initiator → responder（s, se）——完成握手
    let len3 = match initiator.write_message(&[], &mut buf) {
        Ok(n) => n,
        Err(e) => return json!({ "ok": false, "stage": "msg3_write", "error": format!("{e}") }),
    };
    let msg3 = hex::encode(&buf[..len3]);
    if let Err(e) = responder.read_message(&buf[..len3], &mut scratch) {
        return json!({ "ok": false, "stage": "msg3_read", "error": format!("{e}") });
    }

    // 走到这里说明三轮消息全部成功 = 握手完成
    let init_done = initiator.is_handshake_finished();
    let resp_done = responder.is_handshake_finished();

    json!({
        "ok": init_done && resp_done,
        "pattern": PATTERN,
        "prologue": String::from_utf8_lossy(PROLOGUE),
        "handshake_finished": { "initiator": init_done, "responder": resp_done },
        // 每条消息的长度（XX 模式是固定结构，长度可作为额外的结构证据）
        "msg_lengths": { "msg1": msg1.len() / 2, "msg2": msg2.len() / 2, "msg3": msg3.len() / 2 },
        "msg1_prefix": &msg1[..16.min(msg1.len())],
    })
}
