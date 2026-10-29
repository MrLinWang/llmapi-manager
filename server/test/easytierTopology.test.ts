import { describe, expect, it } from 'vitest';
import { PeerTopology, rebuildTopology, type TopologyPeer } from '../src/networking/easytier/topology';

/**
 * 拓扑与下一跳计算（多跳中继的基础）。
 *
 * 之前数据面只发直连对端，三节点以上完全不能用。多跳的前提是能算出
 * "到某个非直连节点，应该经由哪个直连邻居转发"——也就是下一跳。
 *
 * ```
 *      我们(1)
 *      /     \
 *   A(2)     C(4)
 *    |
 *   B(3)        想到 3 → 下一跳必须是 2，不是 4
 * ```
 */

const MY = 1;
const A = 2;
const B = 3;
const C = 4;

function peer(peerId: number, ipv4: string | null): TopologyPeer {
  return { peerId, ipv4, hostname: `p${peerId}`, networkLength: 4 };
}

describe('虚拟网络拓扑', () => {
  it('直连对端的下一跳就是它自己', () => {
    const topology = new PeerTopology(MY);
    topology.addEdge(MY, A);
    expect(topology.nextHop(A)).toBe(A);
  });

  it('两跳目标经由中间节点转发（不是随便挑一个邻居）', () => {
    // 我们─A─B，我们─C。到 B 必须走 A。
    const topology = rebuildTopology(
      MY,
      [peer(MY, '10.0.0.1'), peer(A, '10.0.0.2'), peer(B, '10.0.0.3'), peer(C, '10.0.0.4')],
      [
        { a: MY, b: A },
        { a: A, b: B },
        { a: MY, b: C },
      ],
    );
    expect(topology.nextHop(B)).toBe(A);
    // 这条断言是关键：不能因为 C 也是邻居就选它
    expect(topology.nextHop(B)).not.toBe(C);
  });

  it('三跳也能算出正确的下一跳', () => {
    // 我们─A─B─C
    const topology = new PeerTopology(MY);
    topology.addEdge(MY, A);
    topology.addEdge(A, B);
    topology.addEdge(B, C);
    expect(topology.nextHop(B)).toBe(A);
    expect(topology.nextHop(C)).toBe(A);
  });

  it('目标是自己时返回自己（调用方据此不转发）', () => {
    const topology = new PeerTopology(MY);
    topology.addEdge(MY, A);
    expect(topology.nextHop(MY)).toBe(MY);
  });

  it('不可达返回 null，不瞎猜', () => {
    const topology = new PeerTopology(MY);
    topology.addEdge(MY, A);
    // B 与谁都不连
    topology.learnPeers([peer(B, '10.0.0.3')]);
    expect(topology.nextHop(B)).toBeNull();
  });

  it('按虚拟 IP 能查到 peer_id（发包时靠它找目标）', () => {
    const topology = new PeerTopology(MY);
    topology.learnPeers([peer(A, '10.0.0.2'), peer(B, null)]);
    expect(topology.peerIdByIpv4('10.0.0.2')).toBe(A);
    expect(topology.peerIdByIpv4('10.9.9.9')).toBeNull();
  });

  it('conn_peer_list 形式能建立边', () => {
    const topology = new PeerTopology(MY);
    topology.learnConnections(MY, [A, C]);
    topology.learnConnections(A, [B]);
    expect(topology.nextHop(B)).toBe(A);
  });

  it('conn_bitmap 形式能建立边（LSB 优先位序）', () => {
    // peer_ids = [我们, A, B]，位图表示 我们─A、A─B
    const peerIds = [MY, A, B];
    const n = peerIds.length;
    const bits = Buffer.alloc(Math.ceil((n * n) / 8));
    const setBit = (i: number, j: number) => {
      const k = i * n + j;
      bits[k >> 3] |= 1 << (k & 7);
    };
    // 无向边要两个方向都置位
    setBit(0, 1); setBit(1, 0); // 我们─A
    setBit(1, 2); setBit(2, 1); // A─B

    const topology = new PeerTopology(MY);
    topology.learnConnBitmap(peerIds, bits);
    expect(topology.nextHop(B)).toBe(A);
    expect(topology.edgeCount()).toBe(2);
  });

  it('BFS 不会在环里打转', () => {
    // 三角环：我们─A─B─我们
    const topology = new PeerTopology(MY);
    topology.addEdge(MY, A);
    topology.addEdge(A, B);
    topology.addEdge(B, MY);
    // 两个方向都能到 B，但必须都给出一跳结果（A 或 B 自己是直连）
    expect(topology.nextHop(B)).toBe(B);
  });

  it('connectionRows 导出的边能还原出同样的下一跳', () => {
    const topology = new PeerTopology(MY);
    topology.learnPeers([peer(A, '10.0.0.2'), peer(B, '10.0.0.3')]);
    topology.learnConnections(MY, [A]);
    topology.learnConnections(A, [B]);

    const rows = topology.connectionRows();
    const restored = new PeerTopology(MY);
    for (const row of rows) restored.learnConnections(row.peerId, row.connectedPeerIds);
    expect(restored.nextHop(B)).toBe(A);
  });
});
