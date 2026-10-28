import { describe, expect, it } from 'vitest';
import { SecureChannel } from '../src/networking/easytier/ospf';
import { PacketType, PeerManagerHeaderFlags } from '../src/networking/easytier/protocol';
import {
  AEAD_NONCE_SIZE,
  decryptPayload,
  deriveTrafficKey,
  directionForSender,
  encryptPayload,
  parseNonce,
} from '../src/networking/easytier/dataPlane';
import {
  decodeRpcPacket,
  decodeRpcResponse,
  encodeRpcPacket,
  type RpcPacket,
} from '../src/networking/easytier/rpc';
import type { Socket } from 'node:net';

/**
 * 一个只记录写入、不真的发网络的假 socket。
 *
 * 用它就能在不起真实节点的情况下断言"发出去的字节是什么"——
 * 这正是这个模块**唯一可靠**的部分：编码与加密。
 */
function fakeSocket(): { socket: Socket; written: Buffer[] } {
  const written: Buffer[] = [];
  const socket = {
    write: (data: Buffer) => {
      written.push(Buffer.from(data));
      return true;
    },
  } as unknown as Socket;
  return { socket, written };
}

const ROOT_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const MY_PEER_ID = 100;
const REMOTE_PEER_ID = 200;

function makeChannel(): { channel: SecureChannel; written: Buffer[] } {
  const { socket, written } = fakeSocket();
  const channel = new SecureChannel(socket, {
    myPeerId: MY_PEER_ID,
    remotePeerId: REMOTE_PEER_ID,
    rootKey: ROOT_KEY,
    algorithm: 'aes-gcm',
    epoch: 0,
  });
  return { channel, written };
}

/** 造一个加密的 RpcReq 载荷，模拟对端发来的请求。 */
function encryptedRequest(rpc: RpcPacket): Buffer {
  // 对端发给我的方向
  const key = deriveTrafficKey(
    ROOT_KEY,
    0,
    directionForSender(REMOTE_PEER_ID, MY_PEER_ID),
  );
  return encryptPayload({
    key,
    payload: encodeRpcPacket(rpc),
    epoch: 0,
    seq: 0n,
    algorithm: 'aes-gcm',
  });
}

function ospfRequest(overrides: Partial<RpcPacket> = {}): RpcPacket {
  return {
    fromPeer: REMOTE_PEER_ID,
    toPeer: MY_PEER_ID,
    transactionId: 12345n,
    descriptor: {
      domainName: 'testnet',
      protoName: 'OspfRouteRpc',
      serviceName: 'OspfRouteRpc',
      methodIndex: 1,
    },
    // SyncRouteInfoRequest: field1=my_peer_id, field2=session_id, field3=is_initiator
    body: Buffer.from([0x08, 0xc8, 0x01, 0x10, 0x2a, 0x18, 0x01]),
    isRequest: true,
    totalPieces: 0,
    pieceIdx: 0,
    traceId: 0,
    compressionInfo: { algo: 1, acceptedAlgo: 1 },
    ...overrides,
  };
}

/**
 * 把 framePacket 产出的帧拆成包头与载荷。
 *
 * 布局是 `[4 字节长度(LE)][16 字节 PeerManagerHeader][载荷]`——
 * 长度字段在最前面，包头紧随其后。
 */
function splitFrame(frame: Buffer): {
  header: { fromPeerId: number; toPeerId: number; packetType: number; flags: number };
  payload: Buffer;
} {
  const bodyLength = frame.readUInt32LE(0);
  expect(frame.length).toBe(4 + bodyLength);

  const h = frame.subarray(4, 4 + 16);
  const header = {
    fromPeerId: h.readUInt32LE(0),
    toPeerId: h.readUInt32LE(4),
    packetType: h[8],
    flags: h[9],
  };
  return { header, payload: frame.subarray(4 + 16) };
}

describe('SecureChannel：解密（已验证的能力）', () => {
  it('能解开对端的加密 RpcPacket', () => {
    const { channel } = makeChannel();
    const sent = ospfRequest();

    const packet = channel.decodeRpc({
      header: { packetType: PacketType.RpcReq, flags: PeerManagerHeaderFlags.ENCRYPTED } as never,
      payload: encryptedRequest(sent),
    } as never);

    expect(packet).not.toBeNull();
    expect(packet?.transactionId).toBe(sent.transactionId);
    expect(packet?.descriptor?.serviceName).toBe('OspfRouteRpc');
    expect(packet?.body.equals(sent.body)).toBe(true);
  });

  it('未加密的包返回 null（不抛错）', () => {
    const { channel } = makeChannel();
    const result = channel.decodeRpc({
      header: { packetType: PacketType.RpcReq, flags: 0 } as never,
      payload: Buffer.from('whatever'),
    } as never);
    expect(result).toBeNull();
  });

  it('解不开的载荷返回 null（Ping 等控制包会被忽略）', () => {
    const { channel } = makeChannel();
    const result = channel.decodeRpc({
      header: { packetType: PacketType.RpcReq, flags: PeerManagerHeaderFlags.ENCRYPTED } as never,
      payload: Buffer.alloc(64, 0xff),
    } as never);
    expect(result).toBeNull();
  });
});

describe('SecureChannel：加密发送', () => {
  it('发出的包带 ENCRYPTED 标志且类型正确', () => {
    const { channel, written } = makeChannel();
    channel.sendRpcTo(ospfRequest({ isRequest: false }), REMOTE_PEER_ID);

    expect(written).toHaveLength(1);
    const { header } = splitFrame(written[0]);
    expect((header as { flags: number }).flags).toBe(PeerManagerHeaderFlags.ENCRYPTED);
    expect((header as { packetType: number }).packetType).toBe(PacketType.RpcResp);
  });

  it('包头 from 用本节点 id，to 用传入值', () => {
    const { channel, written } = makeChannel();
    channel.sendRpcTo(ospfRequest({ isRequest: false }), 999);

    const { header } = splitFrame(written[0]);
    expect((header as { fromPeerId: number }).fromPeerId).toBe(MY_PEER_ID);
    expect((header as { toPeerId: number }).toPeerId).toBe(999);
  });

  it('载荷能被接收方用反方向密钥解开（往返自洽）', () => {
    const { channel, written } = makeChannel();
    channel.sendRpcTo(ospfRequest({ isRequest: false }), REMOTE_PEER_ID);

    const { payload } = splitFrame(written[0]);
    // 对端解我的包，用的是 (我 -> 对端) 方向
    const peerKey = deriveTrafficKey(
      ROOT_KEY,
      0,
      directionForSender(MY_PEER_ID, REMOTE_PEER_ID),
    );
    const plain = decryptPayload({ key: peerKey, ciphertextWithTail: payload, algorithm: 'aes-gcm' });
    const decoded = decodeRpcPacket(plain);
    expect(decoded.isRequest).toBe(false);
  });

  it('seq 递增：连续两条消息的 nonce 不同', () => {
    const { channel, written } = makeChannel();
    channel.sendRpcTo(ospfRequest({ isRequest: false }), REMOTE_PEER_ID);
    channel.sendRpcTo(ospfRequest({ isRequest: false }), REMOTE_PEER_ID);

    const nonceOf = (frame: Buffer) => {
      const { payload } = splitFrame(frame);
      return parseNonce(payload.subarray(payload.length - AEAD_NONCE_SIZE));
    };
    expect(nonceOf(written[0]).seq).toBe(0n);
    expect(nonceOf(written[1]).seq).toBe(1n);
  });
});

describe('SecureChannel：OSPF 请求识别', () => {
  it('识别 OspfRouteRpc 并尝试回应', () => {
    const { channel, written } = makeChannel();
    const handled = channel.handleOspfRequest({
      header: { packetType: PacketType.RpcReq, flags: PeerManagerHeaderFlags.ENCRYPTED } as never,
      payload: encryptedRequest(ospfRequest()),
    } as never);

    expect(handled).toBe(true);
    expect(written).toHaveLength(1);
  });

  it('按 protoName 后缀识别（官方实际不带包名）', () => {
    const { channel } = makeChannel();
    const withPackageName = ospfRequest();
    withPackageName.descriptor = { ...withPackageName.descriptor!, protoName: 'peer_rpc.OspfRouteRpc' };

    expect(
      channel.handleOspfRequest({
        header: { packetType: PacketType.RpcReq, flags: PeerManagerHeaderFlags.ENCRYPTED } as never,
        payload: encryptedRequest(withPackageName),
      } as never),
    ).toBe(true);
  });

  it('非 OSPF 的 RPC 不回应', () => {
    const { channel, written } = makeChannel();
    const other = ospfRequest();
    other.descriptor = { domainName: '', protoName: 'OtherRpc', serviceName: 'OtherRpc', methodIndex: 0 };

    expect(
      channel.handleOspfRequest({
        header: { packetType: PacketType.RpcReq, flags: PeerManagerHeaderFlags.ENCRYPTED } as never,
        payload: encryptedRequest(other),
      } as never),
    ).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('非请求（RpcResp）不回应', () => {
    const { channel, written } = makeChannel();
    expect(
      channel.handleOspfRequest({
        header: { packetType: PacketType.RpcReq, flags: PeerManagerHeaderFlags.ENCRYPTED } as never,
        payload: encryptedRequest(ospfRequest({ isRequest: false })),
      } as never),
    ).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('回应的 body 是包装过的 RpcResponse，不是裸业务消息', () => {
    const { channel, written } = makeChannel();
    channel.handleOspfRequest({
      header: { packetType: PacketType.RpcReq, flags: PeerManagerHeaderFlags.ENCRYPTED } as never,
      payload: encryptedRequest(ospfRequest()),
    } as never);

    const { header, payload } = splitFrame(written[0]);
    expect((header as { packetType: number }).packetType).toBe(PacketType.RpcResp);

    // 用对端视角解回来
    const peerKey = deriveTrafficKey(ROOT_KEY, 0, directionForSender(MY_PEER_ID, REMOTE_PEER_ID));
    const rpc = decodeRpcPacket(decryptPayload({ key: peerKey, ciphertextWithTail: payload, algorithm: 'aes-gcm' }));

    // body 解一层 RpcResponse，里面才是 SyncRouteInfoResponse
    const unwrapped = decodeRpcResponse(rpc.body);
    expect(unwrapped.response.length).toBeGreaterThan(0);
    expect(unwrapped.error).toBeNull();
  });
});
