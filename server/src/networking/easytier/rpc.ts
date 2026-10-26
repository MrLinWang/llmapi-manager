/**
 * EasyTier 的 RPC 框架封装。
 *
 * 对照 `easytier-proto/proto/common.proto:151`（`RpcPacket`）与
 * `:95`（`RpcDescriptor`）。
 *
 * ## 为什么需要它
 *
 * OSPF 路由同步（`SyncRouteInfo`）**不是**裸 protobuf 包，而是走
 * EasyTier 自己的 RPC 框架。要回应它，必须把请求包成 `RpcPacket`。
 *
 * 这与前面几层的关系：
 *
 * ```
 * TCP 隧道帧头 (4B len)
 *   └─ PeerManagerHeader (16B, type=RpcReq)
 *        └─ RpcPacket (protobuf)
 *             ├─ descriptor  ← 定位 service/method
 *             └─ body        ← 真正的 SyncRouteInfoRequest
 * ```
 *
 * ## descriptor 的真实取值
 *
 * 靠读代码生成器推演容易错一位，所以这些值是用 `native/protocol-oracle`
 * 从官方类型直接导出的（见 fixtures 里的 `rpc.ospf_sync_route_info`）：
 *
 * ```
 * proto_name   = "peer_rpc.OspfRouteRpc"
 * service_name = "OspfRouteRpc"
 * method_index = 0            ← SyncRouteInfo 是唯一方法
 * domain_name  = ""           ← 空（不区分 domain）
 * ```
 */

import {
  decodeFields,
  encodeBytesField,
  encodeStringField,
  encodeVarintField,
  getBytes,
  getVarint,
} from './protobuf';

/** `RpcDescriptor` 字段号（`common.proto:95`）。 */
export const RpcDescriptorField = {
  domainName: 1,
  protoName: 2,
  serviceName: 3,
  methodIndex: 4,
} as const;

export interface RpcDescriptor {
  /** 允许同一 service 在不同 domain 注册多次；本用途为空 */
  domainName: string;
  /** 带 package 的完整名，如 `peer_rpc.OspfRouteRpc` */
  protoName: string;
  /** 不带 package 的服务名，如 `OspfRouteRpc` */
  serviceName: string;
  /** 方法在服务里的索引 */
  methodIndex: number;
}

/** `RpcPacket` 字段号（`common.proto:151`）。 */
export const RpcPacketField = {
  fromPeer: 1,
  toPeer: 2,
  transactionId: 3,
  descriptor: 4,
  body: 5,
  isRequest: 6,
  totalPieces: 7,
  pieceIdx: 8,
  traceId: 9,
  compressionInfo: 10,
} as const;

export interface RpcPacket {
  fromPeer: number;
  toPeer: number;
  /** 请求与响应靠它配对。**是 int64**，所以可能超过 32 位 */
  transactionId: number;
  /**
   * 服务定位信息。
   *
   * `null` 表示不带 descriptor——proto3 里 message 字段为 None 时**整个字段不写**，
   * 所以全空的 `RpcPacket` 编码出来是 **0 字节**（官方 oracle 实测如此）。
   * 我最初总是写入 descriptor，导致空包多出 23 字节。
   */
  descriptor: RpcDescriptor | null;
  /** 业务载荷（如 SyncRouteInfoRequest 的编码） */
  body: Buffer;
  isRequest: boolean;
  /** 分片信息；不分片时都是 0 */
  totalPieces: number;
  pieceIdx: number;
  traceId: number;
  /**
   * 压缩信息。
   *
   * **不能省略**：`CompressionAlgoPb` 里 `Invalid = 0`、`None = 1`、`Zstd = 2`，
   * 所以 proto3 的"默认值不写"在这里会写出 `Invalid`（=0）——
   * 对端看到 algo 是 Invalid 会直接拒掉整个包
   * （`rpc/packet.rs:16` 的 `accepted_compression_algo` 永远返回 None 或 Zstd，
   * 从不返回 Invalid）。
   *
   * 这是"响应已发出但对端毫无反应"的又一个原因：包结构看起来完整，
   * 但 algo=Invalid 让它在更早的解析阶段就被丢掉了。
   */
  compressionInfo: { algo: number; acceptedAlgo: number } | null;
}

/** 编码 `RpcDescriptor`。 */
export function encodeRpcDescriptor(descriptor: RpcDescriptor): Buffer {
  const parts: Buffer[] = [];
  if (descriptor.domainName !== '') {
    parts.push(encodeStringField(RpcDescriptorField.domainName, descriptor.domainName));
  }
  if (descriptor.protoName !== '') {
    parts.push(encodeStringField(RpcDescriptorField.protoName, descriptor.protoName));
  }
  if (descriptor.serviceName !== '') {
    parts.push(encodeStringField(RpcDescriptorField.serviceName, descriptor.serviceName));
  }
  if (descriptor.methodIndex !== 0) {
    parts.push(encodeVarintField(RpcDescriptorField.methodIndex, descriptor.methodIndex));
  }
  return Buffer.concat(parts);
}

/** 解码 `RpcDescriptor`。 */
export function decodeRpcDescriptor(buffer: Buffer): RpcDescriptor {
  const fields = decodeFields(buffer);
  return {
    domainName: getBytes(fields, RpcDescriptorField.domainName)?.toString('utf8') ?? '',
    protoName: getBytes(fields, RpcDescriptorField.protoName)?.toString('utf8') ?? '',
    serviceName: getBytes(fields, RpcDescriptorField.serviceName)?.toString('utf8') ?? '',
    methodIndex: getVarint(fields, RpcDescriptorField.methodIndex) ?? 0,
  };
}

/** 编码 `RpcPacket`。 */
export function encodeRpcPacket(packet: RpcPacket): Buffer {
  const parts: Buffer[] = [];
  if (packet.fromPeer !== 0) {
    parts.push(encodeVarintField(RpcPacketField.fromPeer, packet.fromPeer));
  }
  if (packet.toPeer !== 0) {
    parts.push(encodeVarintField(RpcPacketField.toPeer, packet.toPeer));
  }
  if (packet.transactionId !== 0) {
    parts.push(encodeVarintField(RpcPacketField.transactionId, packet.transactionId));
  }
  if (packet.descriptor !== null) {
    parts.push(encodeBytesField(RpcPacketField.descriptor, encodeRpcDescriptor(packet.descriptor)));
  }
  if (packet.body.length > 0) {
    parts.push(encodeBytesField(RpcPacketField.body, packet.body));
  }
  if (packet.isRequest) {
    parts.push(encodeVarintField(RpcPacketField.isRequest, 1));
  }
  if (packet.totalPieces !== 0) {
    parts.push(encodeVarintField(RpcPacketField.totalPieces, packet.totalPieces));
  }
  if (packet.pieceIdx !== 0) {
    parts.push(encodeVarintField(RpcPacketField.pieceIdx, packet.pieceIdx));
  }
  if (packet.traceId !== 0) {
    parts.push(encodeVarintField(RpcPacketField.traceId, packet.traceId));
  }
  if (packet.compressionInfo !== null) {
    parts.push(encodeBytesField(RpcPacketField.compressionInfo, encodeCompressionInfo(packet.compressionInfo)));
  }
  return Buffer.concat(parts);
}

/** 解码 `RpcPacket`。 */
export function decodeRpcPacket(buffer: Buffer): RpcPacket {
  const fields = decodeFields(buffer);
  const descriptorBytes = getBytes(fields, RpcPacketField.descriptor);
  return {
    fromPeer: getVarint(fields, RpcPacketField.fromPeer) ?? 0,
    toPeer: getVarint(fields, RpcPacketField.toPeer) ?? 0,
    transactionId: getVarint(fields, RpcPacketField.transactionId) ?? 0,
    descriptor: descriptorBytes === null ? null : decodeRpcDescriptor(descriptorBytes),
    body: getBytes(fields, RpcPacketField.body) ?? Buffer.alloc(0),
    isRequest: (getVarint(fields, RpcPacketField.isRequest) ?? 0) !== 0,
    totalPieces: getVarint(fields, RpcPacketField.totalPieces) ?? 0,
    pieceIdx: getVarint(fields, RpcPacketField.pieceIdx) ?? 0,
    traceId: getVarint(fields, RpcPacketField.traceId) ?? 0,
    compressionInfo: decodeCompressionInfoOrNull(getBytes(fields, RpcPacketField.compressionInfo)),
  };
}

/** `CompressionAlgoPb` 取值（`common.proto:136`）。 */
export const CompressionAlgo = {
  Invalid: 0,
  None: 1,
  Zstd: 2,
} as const;

/** `RpcCompressionInfo` 字段号（`common.proto:142`）。 */
export const RpcCompressionInfoField = { algo: 1, acceptedAlgo: 2 } as const;

export interface RpcCompressionInfo {
  /** 本包内容用的压缩算法。**必须是 None(1) 或 Zstd(2)，不能是 Invalid(0)** */
  algo: number;
  /** 我方能接受的算法 */
  acceptedAlgo: number;
}

export function encodeCompressionInfo(info: RpcCompressionInfo): Buffer {
  const parts: Buffer[] = [];
  // 即使为 0 也要显式写出——见 compressionInfo 字段的说明
  parts.push(encodeVarintField(RpcCompressionInfoField.algo, info.algo));
  if (info.acceptedAlgo !== 0) {
    parts.push(encodeVarintField(RpcCompressionInfoField.acceptedAlgo, info.acceptedAlgo));
  }
  return Buffer.concat(parts);
}

function decodeCompressionInfoOrNull(buffer: Buffer | null): RpcCompressionInfo | null {
  if (buffer === null) return null;
  const fields = decodeFields(buffer);
  return {
    algo: getVarint(fields, RpcCompressionInfoField.algo) ?? 0,
    acceptedAlgo: getVarint(fields, RpcCompressionInfoField.acceptedAlgo) ?? 0,
  };
}

/**
 * OSPF 路由服务的 descriptor 常量。
 *
 * 这些值来自官方代码生成器的实际输出（不是猜的）：
 * 见 `fixtures-protocol-oracle.json` 的 `rpc.ospf_sync_route_info`。
 */
export const OSPF_SERVICE = {
  protoName: 'peer_rpc.OspfRouteRpc',
  serviceName: 'OspfRouteRpc',
  /** `SyncRouteInfo` 在服务里的索引 */
  syncRouteInfoMethodIndex: 0,
} as const;

/** 构造一个 OSPF `SyncRouteInfo` 的请求 RPC 包。 */
export function buildOspfSyncRouteRequest(options: {
  fromPeer: number;
  toPeer: number;
  transactionId: number;
  body: Buffer;
}): RpcPacket {
  return {
    fromPeer: options.fromPeer,
    toPeer: options.toPeer,
    transactionId: options.transactionId,
    descriptor: {
      domainName: '',
      protoName: OSPF_SERVICE.protoName,
      serviceName: OSPF_SERVICE.serviceName,
      methodIndex: OSPF_SERVICE.syncRouteInfoMethodIndex,
    },
    body: options.body,
    isRequest: true,
    totalPieces: 0,
    pieceIdx: 0,
    traceId: 0,
    compressionInfo: { algo: CompressionAlgo.None, acceptedAlgo: CompressionAlgo.None },
  };
}

/**
 * `SyncRouteInfoResponse` 字段号（`peer_rpc.proto:131`）。
 *
 * 回应时最主要是把 `is_initiator` 与 `session_id` 回显回去——
 * 对端靠这两个值确认"这个响应属于我发起的那次同步"。
 */
export const SyncRouteInfoResponseField = {
  isInitiator: 1,
  sessionId: 2,
  error: 3,
  missingPeerIds: 4,
  missingConnPeerIds: 5,
} as const;

export interface SyncRouteInfoResponse {
  isInitiator: boolean;
  sessionId: number;
  error: number | null;
  missingPeerIds: number[];
  missingConnPeerIds: number[];
}

/** 解码 `SyncRouteInfoRequest`（我们收到的那个）。 */
export interface SyncRouteInfoRequest {
  myPeerId: number;
  mySessionId: number;
  isInitiator: boolean;
  /** 对端看到的路由条目（原始字节，暂不逐条解析） */
  peerInfosRaw: Buffer | null;
}

export const SyncRouteInfoRequestField = {
  myPeerId: 1,
  mySessionId: 2,
  isInitiator: 3,
  peerInfos: 4,
  foreignNetworkInfos: 6,
} as const;

export function decodeSyncRouteInfoRequest(buffer: Buffer): SyncRouteInfoRequest {
  const fields = decodeFields(buffer);
  return {
    myPeerId: getVarint(fields, SyncRouteInfoRequestField.myPeerId) ?? 0,
    mySessionId: getVarint(fields, SyncRouteInfoRequestField.mySessionId) ?? 0,
    isInitiator: (getVarint(fields, SyncRouteInfoRequestField.isInitiator) ?? 0) !== 0,
    peerInfosRaw: getBytes(fields, SyncRouteInfoRequestField.peerInfos),
  };
}

/**
 * 编码 `SyncRouteInfoResponse`。
 *
 * 最小可用的回应：回显 `is_initiator` 与 `session_id`。
 * 不填 `missing_peer_ids` 表示"我没有缺失的路由数据"。
 *
 * 注意：这只是让对端不再超时、完成一次拓扑同步握手。
 * 真正的 OSPF 收敛（把拓扑算成路由表）是另一件事，本实现不做。
 */
export function encodeSyncRouteInfoResponse(response: SyncRouteInfoResponse): Buffer {
  const parts: Buffer[] = [];
  if (response.isInitiator) {
    parts.push(encodeVarintField(SyncRouteInfoResponseField.isInitiator, 1));
  }
  if (response.sessionId !== 0) {
    parts.push(encodeVarintField(SyncRouteInfoResponseField.sessionId, response.sessionId));
  }
  if (response.error !== null) {
    parts.push(encodeVarintField(SyncRouteInfoResponseField.error, response.error));
  }
  for (const id of response.missingPeerIds) {
    parts.push(encodeVarintField(SyncRouteInfoResponseField.missingPeerIds, id));
  }
  for (const id of response.missingConnPeerIds) {
    parts.push(encodeVarintField(SyncRouteInfoResponseField.missingConnPeerIds, id));
  }
  return Buffer.concat(parts);
}

/**
 * 为一个请求构造响应包。
 *
 * 三处必须与请求对应，少一个对端就认不出这是它的响应：
 * 1. **from/to 反向**——请求方变成接收者
 * 2. **相同的 transaction_id**——请求与响应靠它配对
 * 3. **相同的 descriptor**——同一 service、同一 method
 *
 * `isRequest` 设为 `false`，否则对端会把它当成又一个请求。
 */
export function buildingRpcResponse(request: RpcPacket, body: Buffer): RpcPacket {
  return {
    fromPeer: request.toPeer,
    toPeer: request.fromPeer,
    transactionId: request.transactionId,
    descriptor: request.descriptor,
    body,
    isRequest: false,
    totalPieces: 0,
    pieceIdx: 0,
    traceId: request.traceId,
    // 必须带 compression_info，且 algo 用 None(1) 而不是 Invalid(0)。
    // 见 RpcPacket.compressionInfo 的说明。
    compressionInfo: { algo: CompressionAlgo.None, acceptedAlgo: CompressionAlgo.None },
  };
}
