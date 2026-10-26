/**
 * EasyTier 的路由信息（RoutePeerInfo）。
 *
 * 对照 `easytier-proto/proto/peer_rpc.proto:22`。
 *
 * ## 这是什么
 *
 * EasyTier 的成员之间用类似 OSPF 的方式交换路由：每个节点广播自己看到的
 * 邻居与代价（cost），全网据此算出到每个 peer 的下一跳。`RoutePeerInfo`
 * 就是这条广播里的一个条目。
 *
 * ## 我们用它做什么
 *
 * 本服务不需要实现完整的 SPF 计算（那是 EasyTier 内核的事），只需要：
 * 1. **解析**对端广播的路由，用于在界面上展示"网络里有谁、怎么连上的"
 * 2. 在诊断时判断"某台机器是否可达，以及经过几跳"
 *
 * 所以这里实现完整的编解码，但不实现路由计算。
 *
 * ## 字段号必须与官方一致
 *
 * 全部对照 proto 定义，并通过官方 oracle 的真实序列化字节验证
 * （`server/test/easytierOracle.test.ts`）。
 */

import {
  decodeFields,
  encodeBytesField,
  encodeStringField,
  encodeVarintField,
  getAllBytes,
  getBytes,
  getVarint,
} from './protobuf';

/**
 * `RoutePeerInfo` 的字段号。
 *
 * 单独列成常量而不是散落在编解码里：这些数字是线上格式，
 * 与官方不一致就无法通信，集中一处便于对照 proto 检查。
 */
export const RoutePeerInfoField = {
  peerId: 1,
  instId: 2,
  cost: 3,
  ipv4Addr: 4,
  proxyCidrs: 5,
  hostname: 6,
  udpNatType: 7,
  lastUpdate: 8,
  version: 9,
  easytierVersion: 10,
  featureFlag: 11,
  peerRouteId: 12,
  networkLength: 13,
  quicPort: 14,
  ipv6Addr: 15,
  groups: 16,
  tcpNatType: 17,
  noiseStaticPubkey: 18,
  trustedCredentialPubkeys: 19,
} as const;

/**
 * 路由条目。
 *
 * 只收本服务用得上的字段。未列出的（`inst_id` / `ipv4_addr` / `last_update`
 * / `groups` 等嵌套消息）在**解析时被跳过**，在**编码时不写**——
 * 这是刻意的最小实现：我们只广播自己的基本信息，不假装能构造完整的
 * 内核级路由条目。若将来需要，按 proto 补上即可。
 */
export interface RoutePeerInfo {
  peerId: number;
  cost: number;
  version: number;
  /** 对端主机名（可能没有） */
  hostname: string | null;
  /** 对端声明的 EasyTier 版本字符串 */
  easytierVersion: string;
  /** 该节点代理的网段 */
  proxyCidrs: string[];
  /** 路由条目的稳定标识，用于判断"是不是同一条路由的新版本" */
  peerRouteId: number;
  /** 网络规模（该节点看到的成员数） */
  networkLength: number;
  /** 对端的 Noise 静态公钥，用于 relay 握手（可能没有） */
  noiseStaticPubkey: Buffer | null;
}

/** 编码 `RoutePeerInfo`。proto3 规则：默认值不写。 */
export function encodeRoutePeerInfo(route: RoutePeerInfo): Buffer {
  const parts: Buffer[] = [];

  if (route.peerId !== 0) parts.push(encodeVarintField(RoutePeerInfoField.peerId, route.peerId));
  if (route.cost !== 0) parts.push(encodeVarintField(RoutePeerInfoField.cost, route.cost));
  for (const cidr of route.proxyCidrs) {
    parts.push(encodeStringField(RoutePeerInfoField.proxyCidrs, cidr));
  }
  if (route.hostname !== null) {
    parts.push(encodeStringField(RoutePeerInfoField.hostname, route.hostname));
  }
  if (route.version !== 0) {
    parts.push(encodeVarintField(RoutePeerInfoField.version, route.version));
  }
  if (route.easytierVersion !== '') {
    parts.push(encodeStringField(RoutePeerInfoField.easytierVersion, route.easytierVersion));
  }
  if (route.peerRouteId !== 0) {
    parts.push(encodeVarintField(RoutePeerInfoField.peerRouteId, route.peerRouteId));
  }
  if (route.networkLength !== 0) {
    parts.push(encodeVarintField(RoutePeerInfoField.networkLength, route.networkLength));
  }
  if (route.noiseStaticPubkey !== null) {
    parts.push(encodeBytesField(RoutePeerInfoField.noiseStaticPubkey, route.noiseStaticPubkey));
  }

  return Buffer.concat(parts);
}

/**
 * 解码 `RoutePeerInfo`。
 *
 * 未知字段被静默跳过——proto 的前向兼容要求如此：将来上游加了新字段，
 * 我们不该因此拒绝解析整个路由广播。
 */
export function decodeRoutePeerInfo(buffer: Buffer): RoutePeerInfo {
  const fields = decodeFields(buffer);
  const hostnameBytes = getBytes(fields, RoutePeerInfoField.hostname);
  const pubkeyBytes = getBytes(fields, RoutePeerInfoField.noiseStaticPubkey);

  return {
    peerId: getVarint(fields, RoutePeerInfoField.peerId) ?? 0,
    cost: getVarint(fields, RoutePeerInfoField.cost) ?? 0,
    version: getVarint(fields, RoutePeerInfoField.version) ?? 0,
    hostname: hostnameBytes === null ? null : hostnameBytes.toString('utf8'),
    easytierVersion: getBytes(fields, RoutePeerInfoField.easytierVersion)?.toString('utf8') ?? '',
    proxyCidrs: getAllBytes(fields, RoutePeerInfoField.proxyCidrs).map((b) => b.toString('utf8')),
    peerRouteId: getVarint(fields, RoutePeerInfoField.peerRouteId) ?? 0,
    networkLength: getVarint(fields, RoutePeerInfoField.networkLength) ?? 0,
    noiseStaticPubkey: pubkeyBytes,
  };
}

/**
 * 编码 `RoutePeerInfos`（repeated 包一层，字段号 1）。
 *
 * 对照 `peer_rpc.proto` 的 `message RoutePeerInfos { repeated RoutePeerInfo items = 1; }`。
 * 路由广播用这个外层消息装多条条目。
 */
export function encodeRoutePeerInfos(routes: RoutePeerInfo[]): Buffer {
  return Buffer.concat(
    routes.map((route) => encodeBytesField(1, encodeRoutePeerInfo(route))),
  );
}

/** 解码 `RoutePeerInfos`。 */
export function decodeRoutePeerInfos(buffer: Buffer): RoutePeerInfo[] {
  return getAllBytes(decodeFields(buffer), 1).map((item) => decodeRoutePeerInfo(item));
}

/**
 * 从一组路由条目里挑出"到目标 peer 的最优路径"。
 *
 * 注意：这**不是**完整的 SPF 计算。真实的 EasyTier 内核会跑 OSPF 算出
 * 完整的路由表；这里只是一个辅助判断——在同一目标有多条路由条目时，
 * 取 cost 最小的那条。
 *
 * 若传入的是完整路由表，这个函数给出的结论与内核一致（因为内核广播的
 * 每条条目本身就带着算好的 cost）。若只有邻居信息，则不能当路由表用。
 */
export function pickBestRoute(routes: RoutePeerInfo[], targetPeerId: number): RoutePeerInfo | null {
  const candidates = routes.filter((route) => route.peerId === targetPeerId);
  if (candidates.length === 0) return null;

  // cost 相同时用 peerRouteId 兜底，保证结果稳定（不依赖输入顺序）
  return candidates.reduce((best, current) => {
    if (current.cost < best.cost) return current;
    if (current.cost === best.cost && current.peerRouteId < best.peerRouteId) return current;
    return best;
  });
}
