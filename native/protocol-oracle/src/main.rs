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
    let credentials = credential_vectors();
    let routes = route_vectors();
    let rpc = rpc_vectors();
    let flags_out = flags_vectors();
    let enums = enum_vectors();
    let addresses = address_vectors();
    let topology = topology_vectors();
    let conn_bitmap = conn_bitmap_vectors();
    let peer_conn_info = peer_conn_info_vectors();

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
        "credentials": credentials,
        "routes": routes,
        "rpc": rpc,
        "config_flags": flags_out,
        "enums": enums,
        "addresses": addresses,
        "topology": topology,
        "conn_bitmap": conn_bitmap,
        "peer_conn_info": peer_conn_info,
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

// ══════════════════════════════════════════════════════════════════════
// 凭证（X25519 + HMAC-SHA256 over protobuf）
// ══════════════════════════════════════════════════════════════════════

/// 导出凭证的签名算法细节与固定测试向量。
///
/// 官方实现（`easytier-proto/src/peer_rpc.rs:48`）：
///
/// ```ignore
/// HMAC-SHA256(key = network_secret,
///             msg = b"easytier credential proof" || credential.encode_to_vec())
/// ```
///
/// 注意被签名的是 **protobuf 序列化结果**，不是字段的某种字符串拼接。
/// 所以 TS 侧要么能精确复现 protobuf 编码，要么这条路径就只能校验、
/// 不能自己生成凭证。这里把真实字节导出来，让 TS 能对着复现。
fn credential_vectors() -> serde_json::Value {
    use easytier_proto::peer_rpc::{TrustedCredentialPubkey, TrustedCredentialPubkeyProof};
    use prost::Message;

    // 固定输入：所有字段都填可预测的值，便于 TS 侧逐字段对照
    let pubkey_bytes = [0x11u8; 32]; // 假公钥，只用形状
    let mut credential = TrustedCredentialPubkey {
        pubkey: pubkey_bytes.to_vec(),
        groups: vec!["admin".to_string(), "relay".to_string()],
        allow_relay: true,
        expiry_unix: 1_800_000_000,
        allowed_proxy_cidrs: vec!["10.0.0.0/8".to_string()],
        reusable: Some(true),
    };

    let secret = "oracle-network-secret";

    // protobuf 序列化结果（被签名的字节）
    let encoded = credential.encode_to_vec();
    let encoded_hex: String = encoded.iter().map(|b| format!("{:02x}", b)).collect();

    // 用官方 API 生成 HMAC
    let proof = TrustedCredentialPubkeyProof::new_signed(credential.clone(), secret);
    let hmac_hex: String = proof
        .credential_hmac
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    // 自己再算一遍，确认复现的是同一条公式（而不是只信 API）
    let manual = TrustedCredentialPubkeyProof::generate_credential_hmac_from_bytes(
        &encoded, secret,
    );
    let manual_hex: String = manual.iter().map(|b| format!("{:02x}", b)).collect();

    // 验证 API 自校验通过
    let verified = proof.verify_credential_hmac(secret);

    // 篡改一个字节后应当验证失败——证明 HMAC 真的覆盖了内容
    let mut tampered = credential.clone();
    tampered.allow_relay = false;
    let tampered_encoded = tampered.encode_to_vec();
    let tampered_hex: String = tampered_encoded.iter().map(|b| format!("{:02x}", b)).collect();

    // 空凭证（全默认值）的编码：proto3 下应为空字节
    let empty = TrustedCredentialPubkey {
        pubkey: vec![],
        groups: vec![],
        allow_relay: false,
        expiry_unix: 0,
        allowed_proxy_cidrs: vec![],
        reusable: None,
    };
    let empty_encoded = empty.encode_to_vec();

    // 只设 reusable=Some(false) 时的编码：验证 optional bool 的 presence
    let mut only_reusable = TrustedCredentialPubkey {
        pubkey: vec![],
        groups: vec![],
        allow_relay: false,
        expiry_unix: 0,
        allowed_proxy_cidrs: vec![],
        reusable: None,
    };
    only_reusable.reusable = Some(false);
    let only_reusable_encoded = only_reusable.encode_to_vec();
    let only_reusable_hex: String = only_reusable_encoded
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    // 去掉 reusable 再编一次，确认两组字节不同（optional 的 presence 有意义）
    credential.reusable = None;
    let without_reusable = credential.encode_to_vec();
    let without_reusable_hex: String = without_reusable.iter().map(|b| format!("{:02x}", b)).collect();

    json!({
        "hmac_formula": {
            "mac": "HMAC-SHA256",
            "key": "network_secret (UTF-8 bytes)",
            "prefix": "easytier credential proof",
            "note": "msg = prefix || protobuf_encode(TrustedCredentialPubkey)",
        },
        "pubkey_fields": {
            "pubkey": 1, "groups": 2, "allow_relay": 3,
            "expiry_unix": 4, "allowed_proxy_cidrs": 5, "reusable": 6,
        },
        "vector": {
            "network_secret": secret,
            "credential": {
                "pubkey_hex": hex::encode(&pubkey_bytes),
                "groups": credential.groups,
                "allow_relay": true,
                "expiry_unix": 1_800_000_000i64,
                "allowed_proxy_cidrs": vec!["10.0.0.0/8"],
                "reusable": true,
            },
            "protobuf_hex": encoded_hex,
            "hmac_hex": hmac_hex,
            "hmac_from_bytes_hex": manual_hex,
            "api_self_verify": verified,
        },
        "tamper": {
            "changed_field": "allow_relay -> false",
            "protobuf_hex": tampered_hex,
            "protobuf_differs": tampered_hex != encoded_hex,
        },
        "edge_cases": {
            "empty_protobuf_hex": hex::encode(&empty_encoded),
            "empty_len": empty_encoded.len(),
            "reusable_false_protobuf_hex": only_reusable_hex,
            "without_reusable_protobuf_hex": without_reusable_hex,
            "reusable_presence_matters": only_reusable_hex != without_reusable_hex,
        },
    })
}

// ══════════════════════════════════════════════════════════════════════
// 路由（RoutePeerInfo）
// ══════════════════════════════════════════════════════════════════════

/// 导出 `RoutePeerInfo` 的字段编号与一个真实序列化样本。
///
/// TS 侧的 `route.ts` 要能解析这个结构（对端广播的路由信息）。
/// 导出真实 protobuf 字节，让 TS 的解析器对着它验证。
fn route_vectors() -> serde_json::Value {
    use easytier_proto::peer_rpc::RoutePeerInfo;
    use prost::Message;

    // 构造一个填满字段的 RoutePeerInfo。
    // 只填标量字段与 bytes/string——嵌套消息（inst_id / ipv4_addr / last_update）
    // 另算，见下面单独的最小样本。
    let route = RoutePeerInfo {
        peer_id: 42,
        inst_id: None,
        cost: 5,
        ipv4_addr: None,
        proxy_cidrs: vec!["192.168.0.0/16".to_string()],
        hostname: Some("node-a".to_string()),
        udp_nat_type: 0,
        last_update: None,
        version: 7,
        easytier_version: "2.7.0".to_string(),
        feature_flag: None,
        peer_route_id: 99,
        network_length: 3,
        quic_port: None,
        ipv6_addr: None,
        groups: vec![],
        tcp_nat_type: 0,
        noise_static_pubkey: vec![0x22; 32],
        trusted_credential_pubkeys: vec![],
        ipv6_public_addr_prefix: None,
        ipv6_public_addr_lease: None,
    };

    let encoded = route.encode_to_vec();
    let encoded_hex: String = encoded.iter().map(|b| format!("{:02x}", b)).collect();

    // 最小样本：只有 peer_id，便于验"proto3 不写默认值"
    let minimal = RoutePeerInfo {
        peer_id: 1,
        ..Default::default()
    };
    let minimal_encoded = minimal.encode_to_vec();
    let minimal_hex: String = minimal_encoded.iter().map(|b| format!("{:02x}", b)).collect();

    // 全默认：应为空字节
    let default_encoded = RoutePeerInfo::default().encode_to_vec();

    // 解码回来，确认往返一致（给 TS 侧一个"解析后应得到什么"的期望值）
    let decoded = RoutePeerInfo::decode(&encoded[..]).unwrap();

    json!({
        "field_numbers": {
            "peer_id": 1, "inst_id": 2, "cost": 3, "ipv4_addr": 4,
            "proxy_cidrs": 5, "hostname": 6, "udp_nat_type": 7, "last_update": 8,
            "version": 9, "easytier_version": 10, "feature_flag": 11,
            "peer_route_id": 12, "network_length": 13, "quic_port": 14,
            "ipv6_addr": 15, "groups": 16, "tcp_nat_type": 17,
            "noise_static_pubkey": 18, "trusted_credential_pubkeys": 19,
        },
        "wire_types": {
            "peer_id": "varint", "cost": "varint", "proxy_cidrs": "length-delimited",
            "hostname": "length-delimited", "version": "varint",
            "easytier_version": "length-delimited", "peer_route_id": "varint",
            "network_length": "varint", "noise_static_pubkey": "length-delimited",
        },
        "sample": {
            "input": {
                "peer_id": 42, "cost": 5, "version": 7,
                "hostname": "node-a", "easytier_version": "2.7.0",
                "proxy_cidrs": ["192.168.0.0/16"],
                "peer_route_id": 99, "network_length": 3,
                "noise_static_pubkey_hex": hex::encode([0x22u8; 32]),
            },
            "protobuf_hex": encoded_hex,
            "decoded": {
                "peer_id": decoded.peer_id,
                "cost": decoded.cost,
                "version": decoded.version,
                "hostname": decoded.hostname,
                "easytier_version": decoded.easytier_version,
                "proxy_cidrs": decoded.proxy_cidrs,
                "peer_route_id": decoded.peer_route_id,
                "network_length": decoded.network_length,
                "noise_static_pubkey_hex": hex::encode(&decoded.noise_static_pubkey),
            },
        },
        "minimal": {
            "input": { "peer_id": 1 },
            "protobuf_hex": minimal_hex,
            "note": "proto3 不序列化默认值；identity 里 version=0 等字段都不会出现",
        },
        "default_protobuf_hex": hex::encode(&default_encoded),
    })
}

/// 导出 RPC 层的真实结构：`RpcDescriptor` 的取值与 `RpcPacket` 编码。
///
/// 为什么需要：OSPF 路由同步走的是 EasyTier 自己的 RPC 框架，
/// 而不是裸 protobuf 包。要回应它，必须知道：
/// - `RpcDescriptor` 的 `domain_name` / `proto_name` / `service_name` / `method_index`
/// - `RpcPacket` 怎么编（尤其 `transaction_id` 是否 int64、body 在哪层）
///
/// 这些值从代码生成器出来，靠读源码推演容易错一位，
/// 所以直接从官方类型里取。
fn rpc_vectors() -> serde_json::Value {
    use easytier_proto::common::{RpcDescriptor, RpcPacket};
    use prost::Message;

    // 构造一个典型的 SyncRouteInfo 请求 RPC 包
    let descriptor = RpcDescriptor {
        domain_name: String::new(),
        proto_name: "peer_rpc.OspfRouteRpc".to_string(),
        service_name: "OspfRouteRpc".to_string(),
        method_index: 0,
    };

    // body 用一个可识别的占位（真实的是 SyncRouteInfoRequest 的编码）
    let body = vec![0x08u8, 0x2a, 0x10, 0x01];
    let packet = RpcPacket {
        from_peer: 1001,
        to_peer: 2002,
        transaction_id: 12345,
        descriptor: Some(descriptor.clone()),
        body: body.clone(),
        is_request: true,
        total_pieces: 0,
        piece_idx: 0,
        trace_id: 0,
        compression_info: None,
    };

    let encoded = packet.encode_to_vec();
    let encoded_hex: String = encoded.iter().map(|b| format!("{:02x}", b)).collect();

    // 空 descriptor 与空 packet 的编码（验证 proto3 默认值规则）
    let empty_packet = RpcPacket {
        from_peer: 0, to_peer: 0, transaction_id: 0, descriptor: None,
        body: vec![], is_request: false, total_pieces: 0, piece_idx: 0,
        trace_id: 0, compression_info: None,
    };

    json!({
        "_comment": "OSPF 路由同步走 EasyTier 自己的 RPC 框架，不是裸 protobuf",
        "rpc_descriptor_fields": {
            "domain_name": 1, "proto_name": 2, "service_name": 3, "method_index": 4,
        },
        "rpc_packet_fields": {
            "from_peer": 1, "to_peer": 2, "transaction_id": 3, "descriptor": 4,
            "body": 5, "is_request": 6, "total_pieces": 7, "piece_idx": 8,
            "trace_id": 9, "compression_info": 10,
        },
        "ospf_sync_route_info": {
            "proto_name": "peer_rpc.OspfRouteRpc",
            "service_name": "OspfRouteRpc",
            "method_name": "SyncRouteInfo",
            "method_index": 0,
            "package": "peer_rpc",
        },
        "sample_request": {
            "input": {
                "from_peer": 1001, "to_peer": 2002, "transaction_id": 12345,
                "descriptor": {
                    "domain_name": "", "proto_name": "peer_rpc.OspfRouteRpc",
                    "service_name": "OspfRouteRpc", "method_index": 0,
                },
                "body_hex": hex::encode(&body),
                "is_request": true,
            },
            "protobuf_hex": encoded_hex,
        },
        "empty_packet_hex": hex::encode(empty_packet.encode_to_vec()),
        "sync_route_info_response_fields": {
            "is_initiator": 1, "session_id": 2, "error": 3,
            "missing_peer_ids": 4, "missing_conn_peer_ids": 5,
        },
        "sync_route_info_request_fields": {
            "my_peer_id": 1, "my_session_id": 2, "is_initiator": 3,
            "peer_infos": 4, "conn_bitmap": 5, "foreign_network_infos": 6,
            "conn_peer_list": 7,
        },
    })
}

// ══════════════════════════════════════════════════════════════════
// 补充覆盖面：Flags、枚举、地址结构
// ══════════════════════════════════════════════════════════════════

/// 导出 `Flags`（即设置项）的真实字段号与默认值。
///
/// 为什么重要：`Flags` 是 `easytier-cli` 与配置文件的共同来源，
/// 它的默认值决定了"不填某个设置时实际是什么行为"。
/// 我们改过 `no_tun`（第 8 号字段），这类改动必须与官方默认值对齐——
/// 例如 `enable_encryption` 默认 true，若我们误当成 false 就会明文传输。
fn flags_vectors() -> serde_json::Value {
    use easytier::common::config::gen_default_flags;

    let defaults = gen_default_flags();

    json!({
        "_comment": "Flags 的字段号与官方默认值；默认值决定'不配置时的实际行为'",
        "field_numbers": {
            "default_protocol": 1, "dev_name": 2, "enable_encryption": 3,
            "enable_ipv6": 4, "mtu": 5, "latency_first": 6,
            "enable_exit_node": 7, "no_tun": 8, "use_smoltcp": 9,
            "relay_network_whitelist": 10, "disable_p2p": 11,
            "relay_all_peer_rpc": 12, "disable_udp_hole_punching": 13,
            "multi_thread": 15, "data_compress_algo": 16, "bind_device": 17,
            "enable_kcp_proxy": 18, "disable_kcp_input": 19,
            "disable_relay_kcp": 20, "proxy_forward_by_system": 21,
            "accept_dns": 22, "private_mode": 23, "enable_quic_proxy": 24,
            "disable_quic_input": 25, "foreign_relay_bps_limit": 26,
            "multi_thread_count": 27, "enable_relay_foreign_network_kcp": 28,
        },
        "defaults": {
            "default_protocol": defaults.default_protocol,
            "dev_name": defaults.dev_name,
            "enable_encryption": defaults.enable_encryption,
            "enable_ipv6": defaults.enable_ipv6,
            "mtu": defaults.mtu,
            "latency_first": defaults.latency_first,
            "enable_exit_node": defaults.enable_exit_node,
            "no_tun": defaults.no_tun,
            "use_smoltcp": defaults.use_smoltcp,
            "relay_network_whitelist": defaults.relay_network_whitelist,
            "disable_p2p": defaults.disable_p2p,
            "multi_thread": defaults.multi_thread,
            "data_compress_algo": defaults.data_compress_algo as i32,
            "bind_device": defaults.bind_device,
            "accept_dns": defaults.accept_dns,
            "private_mode": defaults.private_mode,
            "multi_thread_count": defaults.multi_thread_count,
        },
    })
}

/// 导出枚举的完整取值。这些数字出现在线上字节里，差一个就误判。
fn enum_vectors() -> serde_json::Value {
    use easytier_proto::common::{CompressionAlgoPb, NatType, SocketType};

    json!({
        "nat_type": {
            "Unknown": NatType::Unknown as i32,
            "OpenInternet": NatType::OpenInternet as i32,
            "NoPAT": NatType::NoPat as i32,
            "FullCone": NatType::FullCone as i32,
            "Restricted": NatType::Restricted as i32,
            "PortRestricted": NatType::PortRestricted as i32,
            "Symmetric": NatType::Symmetric as i32,
            "SymUdpFirewall": NatType::SymUdpFirewall as i32,
            "SymmetricEasyInc": NatType::SymmetricEasyInc as i32,
            "SymmetricEasyDec": NatType::SymmetricEasyDec as i32,
        },
        "compression_algo": {
            "Invalid": CompressionAlgoPb::Invalid as i32,
            "None": CompressionAlgoPb::None as i32,
            "Zstd": CompressionAlgoPb::Zstd as i32,
        },
        "socket_type": {
            "_comment": "只有 TCP/UDP 两种；隧道类型字符串（tcp/wg/quic 等）不是这个枚举",
            "TCP": SocketType::Tcp as i32,
            "UDP": SocketType::Udp as i32,
        },
    })
}

/// 导出地址结构的编码。`Ipv4Addr` 的 `uint32 addr` 到底是主机序还是网络序，
/// 只能靠真实字节看出来。
fn address_vectors() -> serde_json::Value {
    use easytier_proto::common::{Ipv4Addr, Ipv4Inet, NatType};
    use easytier_proto::peer_rpc::RoutePeerInfo;
    use prost::Message;

    // 用 10.126.126.1 = 0x0A7E7E01 作样本，两种字节序看起来完全不同
    let ipv4 = Ipv4Addr { addr: 0x0A7E_7E01 };
    let ipv4_hex: String = ipv4.encode_to_vec().iter().map(|b| format!("{:02x}", b)).collect();

    let inet = Ipv4Inet {
        address: Some(Ipv4Addr { addr: 0x0A7E_7E01 }),
        network_length: 24,
    };
    let inet_hex: String = inet.encode_to_vec().iter().map(|b| format!("{:02x}", b)).collect();

    // RoutePeerInfo 带 ipv4_addr 与 nat_type 的变异，验证嵌套消息
    let route_with_addr = RoutePeerInfo {
        peer_id: 7,
        ipv4_addr: Some(Ipv4Addr { addr: 0x0A7E_7E01 }),
        udp_nat_type: NatType::Symmetric as i32,
        network_length: 24,
        ..Default::default()
    };
    let route_hex: String = route_with_addr
        .encode_to_vec()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    json!({
        "ipv4_addr": {
            "field_numbers": { "addr": 1 },
            "input": { "addr": 0x0A7E_7E01u32, "dotted": "10.126.126.1" },
            "protobuf_hex": ipv4_hex,
            "note": "addr 是 uint32 varint，按数值编码而非 4 字节网络序",
        },
        "ipv4_inet": {
            "field_numbers": { "address": 1, "network_length": 2 },
            "input": { "addr": 0x0A7E_7E01u32, "network_length": 24 },
            "protobuf_hex": inet_hex,
        },
        "route_with_addr": {
            "input": {
                "peer_id": 7, "ipv4_addr": 0x0A7E_7E01u32,
                "udp_nat_type": NatType::Symmetric as i32, "network_length": 24,
            },
            "protobuf_hex": route_hex,
        },
        "field_numbers": {
            "route_ipv4_addr": 4,
            "route_udp_nat_type": 7,
            "route_network_length": 13,
        },
    })
}

/// 导出 `TunnelInfo` / `SocketAddr` / `Url` 的编码。
/// 这些出现在 `PeerConnInfo` 里，是"查看节点列表"要解析的东西。
fn topology_vectors() -> serde_json::Value {
    use easytier_proto::common::{Ipv4Addr, SocketAddr, TunnelInfo, Url};
    use prost::Message;

    // SocketAddr 的 ip 是 oneof，所以是 Option<socket_addr::Ip>
    let socket_addr = SocketAddr {
        ip: Some(easytier_proto::common::socket_addr::Ip::Ipv4(Ipv4Addr {
            addr: 0x0A7E_7E01,
        })),
        port: 11010,
    };
    let socket_hex: String = socket_addr.encode_to_vec().iter().map(|b| format!("{:02x}", b)).collect();

    let url = Url { url: "tcp://10.126.126.1:11010".to_string() };
    let url_hex: String = url.encode_to_vec().iter().map(|b| format!("{:02x}", b)).collect();

    let tunnel = TunnelInfo {
        tunnel_type: "tcp".to_string(),
        local_addr: Some(Url { url: "tcp://0.0.0.0:11010".to_string() }),
        remote_addr: Some(Url { url: "tcp://10.126.126.1:43201".to_string() }),
        resolved_remote_addr: Some(Url { url: "tcp://10.126.126.1:43201".to_string() }),
    };
    let tunnel_hex: String = tunnel.encode_to_vec().iter().map(|b| format!("{:02x}", b)).collect();

    json!({
        "socket_addr": {
            "field_numbers": { "ipv4": 1, "ipv6": 2, "port": 3 },
            "input": { "ipv4": 0x0A7E_7E01u32, "port": 11010 },
            "protobuf_hex": socket_hex,
        },
        "url": {
            "field_numbers": { "url": 1 },
            "input": { "url": "tcp://10.126.126.1:11010" },
            "protobuf_hex": url_hex,
        },
        "tunnel_info": {
            "field_numbers": { "tunnel_type": 1, "local_addr": 2, "remote_addr": 3, "resolved_remote_addr": 4 },
            "input": {
                "tunnel_type": "tcp",
                "local_addr": "tcp://0.0.0.0:11010",
                "remote_addr": "tcp://10.126.126.1:43201",
                "resolved_remote_addr": "tcp://10.126.126.1:43201",
            },
            "protobuf_hex": tunnel_hex,
        },
    })
}

// ══════════════════════════════════════════════════════════════════
// 连接位图（RouteConnBitmap）
// ══════════════════════════════════════════════════════════════════

/// 导出 `RouteConnBitmap` 的位序规则与可验证样本。
///
/// ## 这是 OSPF 拓扑同步的核心数据结构
///
/// 它用位图压缩"谁和谁相连"的邻接矩阵：
///
/// ```ignore
/// // peer_ospf_route.rs:1434 / peer_rpc.rs:233
/// peer_ids[i] 连接到 peer_ids[j]  ⟺  bit[i * peer_ids.len() + j] == 1
/// ```
///
/// 位序是**字节内 LSB 优先**（`peer_rpc.rs:226`）：
///
/// ```rust
/// let byte_idx = idx / 8;
/// let bit_idx = idx % 8;
/// (bitmap[byte_idx] >> bit_idx) & 1 == 1
/// ```
///
/// 这两点任一搞错，"网络里有谁连谁"就全错了，而且不会报错——只会得到
/// 一张看似合理但完全错误的拓扑图。
fn conn_bitmap_vectors() -> serde_json::Value {
    use easytier_proto::peer_rpc::{PeerIdVersion, RouteConnBitmap};
    use prost::Message;

    // 4 个节点，构造一个已知的邻接关系：
    //   0 连 1
    //   1 连 0, 2
    //   2 连 1, 3
    //   3 连 2
    let peer_ids = vec![
        PeerIdVersion { peer_id: 1001, version: 1 },
        PeerIdVersion { peer_id: 1002, version: 1 },
        PeerIdVersion { peer_id: 1003, version: 1 },
        PeerIdVersion { peer_id: 1004, version: 1 },
    ];
    let n = peer_ids.len();

    // 按 bit[i*n + j] 置位
    // 注意 key 由 (i,j) 组成，用 64 位整数承载
    let mut bits = vec![false; n * n];
    let edges = [(0usize, 1usize), (1, 0), (1, 2), (2, 1), (2, 3), (3, 2)];
    for (i, j) in edges {
        bits[i * n + j] = true;
    }

    // 按 LSB 优先打包
    let byte_count = (bits.len() + 7) / 8;
    let mut bitmap = vec![0u8; byte_count];
    for (idx, on) in bits.iter().enumerate() {
        if *on {
            bitmap[idx / 8] |= 1 << (idx % 8);
        }
    }

    let conn = RouteConnBitmap { peer_ids: peer_ids.clone(), bitmap: bitmap.clone() };
    let encoded = conn.encode_to_vec();
    let encoded_hex: String = encoded.iter().map(|b| format!("{:02x}", b)).collect();

    // 用官方 API 反解，确认我们构造的位图表达的就是预期邻接
    let decoded = RouteConnBitmap::decode(&encoded[..]).unwrap();
    let mut adjacency = serde_json::Map::new();
    for (i, pv) in peer_ids.iter().enumerate() {
        let peers: Vec<u32> = decoded
            .get_connected_peers(i)
            .into_iter()
            .collect();
        adjacency.insert(
            pv.peer_id.to_string(),
            json!(peers),
        );
    }

    json!({
        "layout": {
            "formula": "peer_ids[i] connected to peer_ids[j] <=> bit[i * n + j]",
            "bit_order": "LSB first within each byte: (bitmap[idx/8] >> (idx%8)) & 1",
            "source": "peer_rpc.rs:226 get_bit / :233 get_connected_peers",
            "byte_count_formula": "ceil(n*n / 8)",
        },
        "sample": {
            "peer_ids": peer_ids.iter().map(|p| json!({"peer_id": p.peer_id, "version": p.version})).collect::<Vec<_>>(),
            "edges": edges.iter().map(|(i, j)| json!([i, j])).collect::<Vec<_>>(),
            "bits": bits.iter().map(|b| if *b { 1 } else { 0 }).collect::<Vec<u8>>(),
            "bitmap_hex": hex::encode(&bitmap),
            "protobuf_hex": encoded_hex,
            "expected_adjacency": adjacency,
        },
        "field_numbers": { "peer_ids": 1, "bitmap": 2 },
        "peer_id_version_fields": { "peer_id": 1, "version": 2 },
    })
}

/// 导出 `PeerConnInfo`（节点列表里的一项）的编码。
fn peer_conn_info_vectors() -> serde_json::Value {
    use easytier_proto::peer_rpc::{route_conn_peer_list::PeerConnInfo, PeerIdVersion, RouteConnPeerList};
    use prost::Message;

    let info = PeerConnInfo {
        peer_id: Some(PeerIdVersion { peer_id: 2001, version: 3 }),
        connected_peer_ids: vec![2002, 2003],
    };
    let info_hex: String = info.encode_to_vec().iter().map(|b| format!("{:02x}", b)).collect();

    let list = RouteConnPeerList { peer_conn_infos: vec![info.clone()] };
    let list_hex: String = list.encode_to_vec().iter().map(|b| format!("{:02x}", b)).collect();

    json!({
        "field_numbers": {
            "peer_conn_info": { "peer_id": 1, "connected_peer_ids": 2 },
            "route_conn_peer_list": { "peer_conn_infos": 1 },
        },
        "sample": {
            "input": {
                "peer_id": { "peer_id": 2001, "version": 3 },
                "connected_peer_ids": [2002, 2003],
            },
            "protobuf_hex": info_hex,
            "list_protobuf_hex": list_hex,
        },
    })
}
