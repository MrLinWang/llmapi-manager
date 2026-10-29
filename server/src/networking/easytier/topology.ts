/**
 * 虚拟网络拓扑：从 OSPF 消息里学"谁连着谁"，并算出下一跳。
 *
 * # 为什么需要
 *
 * 之前的数据面只会把包发给**直连**的对端：`pickConnectionFor` 按目标 IP
 * 匹配已连接节点的虚拟 IP，匹配不上就丢弃。于是三节点以上完全不能用——
 * A 与 B 都连着我们，但 A 想让 B 收到数据时，我们不知道"该经由谁转发"。
 *
 * # 拓扑信息从哪来
 *
 * EasyTier 的 OSPF 同步（`SyncRouteInfoRequest`）里有两类关键信息：
 *
 * 1. **`peer_infos`**：每个节点的 `RoutePeerInfo`，含 `peer_id`、虚拟
 *    `ipv4_addr`、主机名。由此建立 `peer_id ↔ 虚拟 IP` 的映射。
 * 2. **`conn_info`**：连接关系。两个分支——
 *    - `conn_peer_list`（field 7）：`PeerConnInfo { peer_id, connected_peer_ids }`，
 *      语义直白："这个节点直连着这些节点"。
 *    - `conn_bitmap`（field 5）：`RouteConnBitmap { peer_ids[], bit[] }`，
 *      压缩形式：`peer_ids[i]` 与 `peer_ids[j]` 相连 ⟺ `bit[i*n+j]`（**LSB 优先**）。
 *
 * 我们两种都要能解：官方不同版本/不同场景会用不同分支。
 *
 * # 下一跳怎么算
 *
 * 在无向图上从本节点出发做 BFS，目标节点的**前驱**就是下一跳。
 * 用 BFS 而不是 Dijkstra：虚拟网络的边权基本一致（都是直连一跳），
 * 最少跳数就是最优；而且 BFS 实现简单、结果稳定可测。
 *
 * # 边界
 *
 * - 只处理**单连通**拓扑（不处理分区、不处理环路消除——BFS 天然避免环路）
 * - 拓扑变化（节点下线）只能靠"下次 OSPF 同步时覆盖"，没有主动的老化
 *   机制。这够用，因为 OSPF 本身是周期性同步的。
 */

import { decodeFields, getAllBytes, getAllVarints, getBytes, getVarint } from './protobuf';

/** `RouteConnPeerList` 字段号（`peer_rpc.proto`）。 */
const CONN_PEER_LIST_FIELD = { peerConnInfos: 1 } as const;
/** `PeerConnInfo` 字段号。 */
const PEER_CONN_INFO_FIELD = {
  /** 是 `PeerIdVersion`，不是裸 varint */
  peerId: 1,
  connectedPeerIds: 2,
} as const;
/** `PeerIdVersion` 字段号。 */
const PEER_ID_VERSION_FIELD = { peerId: 1, version: 2 } as const;
/** `RouteConnBitmap` 字段号。 */
const CONN_BITMAP_FIELD = { peerIds: 1, bit: 2 } as const;

/** 一条 `conn_peer_list` 条目：谁直连着谁。 */
export interface ConnPeerListRow {
  peerId: number;
  connectedPeerIds: number[];
}

/**
 * 解码 `RouteConnPeerList`。
 *
 * 语义直白：每个条目说"这个 peer 直连着这些 peer"。
 */
export function decodeConnPeerList(buffer: Buffer): ConnPeerListRow[] {
  const rows: ConnPeerListRow[] = [];
  for (const entry of getAllBytes(
    decodeFields(buffer),
    CONN_PEER_LIST_FIELD.peerConnInfos,
  )) {
    const fields = decodeFields(entry);
    const peerIdVersionRaw = getBytes(fields, PEER_CONN_INFO_FIELD.peerId);
    if (peerIdVersionRaw === null) continue;
    const peerId = getVarint(
      decodeFields(peerIdVersionRaw),
      PEER_ID_VERSION_FIELD.peerId,
    );
    if (peerId === null) continue;
    rows.push({
      peerId,
      connectedPeerIds: getAllVarints(fields, PEER_CONN_INFO_FIELD.connectedPeerIds),
    });
  }
  return rows;
}

/**
 * 解码 `RouteConnBitmap`。
 *
 * 压缩形式：`peer_ids[i]` 与 `peer_ids[j]` 相连 ⟺ `bit[i*n+j]`，**LSB 优先**。
 * 位序搞反会让整张图错乱，且不会报错——只会"路由算错"。
 */
export function decodeConnBitmap(buffer: Buffer): {
  peerIds: number[];
  bits: Buffer;
} {
  const fields = decodeFields(buffer);
  return {
    peerIds: getAllVarints(fields, CONN_BITMAP_FIELD.peerIds),
    bits: getBytes(fields, CONN_BITMAP_FIELD.bit) ?? Buffer.alloc(0),
  };
}

/** 一个节点的信息（从 `RoutePeerInfo` 提取我们需要的部分）。 */
export interface TopologyPeer {
  peerId: number;
  ipv4: string | null;
  hostname: string | null;
  /** 该节点声明的网络规模（用于诊断） */
  networkLength: number;
}

/** 连接关系的一条边（无向）。 */
interface Edge {
  a: number;
  b: number;
}

/**
 * 虚拟网络拓扑。
 *
 * 无状态 IO：只吃数据、只算下一跳。由 `EasyTierAcceptor` 持有并更新。
 */
export class PeerTopology {
  private readonly peers = new Map<number, TopologyPeer>();
  /** 邻接表：peer_id → 与它直连的 peer_id 集合 */
  private readonly adjacency = new Map<number, Set<number>>();
  private readonly ipToPeer = new Map<string, number>();

  constructor(private readonly myPeerId: number) {}

  /** 本节点 id。 */
  get self(): number {
    return this.myPeerId;
  }

  /**
   * 学到一批节点信息（来自 `SyncRouteInfoRequest.peer_infos`）。
   *
   * 用覆盖而非累加：OSPF 的语义是"这是当前视图"，旧条目应当过期。
   * 但**不能因此丢掉整个拓扑**——只更新出现过的节点。
   */
  learnPeers(infos: readonly TopologyPeer[]): void {
    for (const info of infos) {
      this.peers.set(info.peerId, info);
      if (info.ipv4 !== null) {
        // 同一个 IP 被两个 peer 声明是异常，以最新的为准
        const previous = this.ipToPeer.get(info.ipv4);
        if (previous !== undefined && previous !== info.peerId) {
          this.adjacency.delete(previous);
        }
        this.ipToPeer.set(info.ipv4, info.peerId);
      }
    }
  }

  /** 记录一条"a 与 b 直连"的边。 */
  addEdge(a: number, b: number): void {
    if (a === b) return;
    this.addDirected(a, b);
    this.addDirected(b, a);
  }

  private addDirected(from: number, to: number): void {
    let set = this.adjacency.get(from);
    if (set === undefined) {
      set = new Set<number>();
      this.adjacency.set(from, set);
    }
    set.add(to);
  }

  /** 学到一条 `conn_peer_list` 条目：`from` 直连着 `connected` 中的每个节点。 */
  learnConnections(from: number, connected: readonly number[]): void {
    for (const peerId of connected) {
      this.addEdge(from, peerId);
    }
  }

  /** 学到一条 `conn_bitmap`：按位表示任意两点是否相连。 */
  learnConnBitmap(peerIds: readonly number[], bits: Buffer): void {
    const n = peerIds.length;
    if (n === 0) return;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        // 位序是 **LSB 优先**：第 k 位在 bits[k >> 3] 的 (k & 7) 位
        const bitIndex = i * n + j;
        const byte = bits[bitIndex >> 3];
        if (byte === undefined) continue;
        if ((byte & (1 << (bitIndex & 7))) !== 0) {
          const a = peerIds[i];
          const b = peerIds[j];
          if (a !== undefined && b !== undefined) this.addEdge(a, b);
        }
      }
    }
  }

  /** 按虚拟 IP 查 peer_id。 */
  peerIdByIpv4(ip: string): number | null {
    return this.ipToPeer.get(ip) ?? null;
  }

  /** 取某个节点声明的信息。 */
  getPeer(peerId: number): TopologyPeer | null {
    return this.peers.get(peerId) ?? null;
  }

  /** 已知的全部节点（广播自己的路由时要把它们带上，否则别人学不到）。 */
  knownPeers(): TopologyPeer[] {
    return [...this.peers.values()];
  }

  /**
   * 计算到 `dstPeerId` 的下一跳。
   *
   * - 目标就是自己 → 返回自己（调用方据此判断"不用转发"）
   * - 目标是直连对端 → 返回它
   * - 多跳 → BFS 找最少跳数的前驱
   * - 不可达 → null
   *
   * **注意**：返回的是"应该用哪条连接发出去"的 peer_id，不是最终目标。
   * 包头里的 `to_peer_id` 仍然要填最终目标，中间节点靠它继续转发。
   */
  nextHop(dstPeerId: number): number | null {
    if (dstPeerId === this.myPeerId) return this.myPeerId;

    // BFS：从自己出发，记录每个节点的前驱
    const queue: number[] = [this.myPeerId];
    const visited = new Set<number>([this.myPeerId]);
    const predecessor = new Map<number, number>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbours = this.adjacency.get(current);
      if (neighbours === undefined) continue;

      for (const next of neighbours) {
        if (visited.has(next)) continue;
        visited.add(next);
        predecessor.set(next, current);

        if (next === dstPeerId) {
          // 回溯到"自己的邻居"那一层，就是下一跳
          let hop = next;
          let parent = predecessor.get(hop);
          while (parent !== undefined && parent !== this.myPeerId) {
            hop = parent;
            parent = predecessor.get(hop);
          }
          return hop;
        }
        queue.push(next);
      }
    }
    return null;
  }

  /** 当前拓扑里有多少条边（诊断用）。 */
  edgeCount(): number {
    let sum = 0;
    for (const neighbours of this.adjacency.values()) sum += neighbours.size;
    // 每条无向边被计了两次
    return Math.floor(sum / 2);
  }

  /**
   * 导出可广播的连接关系（给 `conn_peer_list` 用）。
   *
   * 只广播**我们知道的**边：让对端能拼出完整拓扑。
   */
  connectionRows(): Array<{ peerId: number; connectedPeerIds: number[] }> {
    const rows: Array<{ peerId: number; connectedPeerIds: number[] }> = [];
    for (const [peerId, neighbours] of this.adjacency) {
      if (neighbours.size === 0) continue;
      rows.push({ peerId, connectedPeerIds: [...neighbours] });
    }
    return rows;
  }

  /** 清空拓扑（组网停止时调用）。 */
  clear(): void {
    this.peers.clear();
    this.adjacency.clear();
    this.ipToPeer.clear();
  }
}

/** 从序列化的边列表恢复（测试与持久化用）。 */
export function rebuildTopology(
  myPeerId: number,
  peers: readonly TopologyPeer[],
  edges: readonly Edge[],
): PeerTopology {
  const topology = new PeerTopology(myPeerId);
  topology.learnPeers(peers);
  for (const edge of edges) topology.addEdge(edge.a, edge.b);
  return topology;
}
