/**
 * peer 地址（中继服务器）的解析与规范化。
 *
 * 对照 `easytier-core/src/config/toml.rs:281` 的 `PeerConfig { uri: url::Url, ... }`：
 * 官方用的是标准 URL 解析，因此这里的规则要与 `url::Url::parse` 一致，
 * 而不是自己发明一套宽松语法。
 *
 * 为什么要单独一个模块：用户手填中继地址是最容易出错的一步
 * （漏 scheme、写 `host:port`、多打空格）。在保存时就校验并给出明确提示，
 * 比让 EasyTier 在启动时吐一个内部错误好得多。
 */

/** 官方支持的传输协议。对照 `tunnel/` 下的实现与 feature 列表。 */
export const PEER_SCHEMES = [
  'tcp',
  'udp',
  'wg',
  'quic',
  'wss',
  'ws',
  'ring',
  'txt',
] as const;

export type PeerScheme = (typeof PEER_SCHEMES)[number];

export interface ParsedPeer {
  scheme: PeerScheme;
  host: string;
  port: number;
  /** 规范化后的字符串，用于去重与落盘 */
  normalized: string;
}

export class PeerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerParseError';
  }
}

/**
 * 解析一个 peer 地址。
 *
 * 与 `url::Url::parse` 的行为保持一致：
 * - `tcp://host:port` 合法
 * - 缺 scheme（`host:port`）**不合法** —— 官方也要求写 scheme，
 *   但用户手填时最容易漏，所以这里给出可操作的提示而不是笼统的"格式错误"
 * - port 必须在 1–65535
 */
export function parsePeer(raw: string): ParsedPeer {
  const text = raw.trim();
  if (text === '') throw new PeerParseError('中继地址不能为空');

  if (!text.includes('://')) {
    throw new PeerParseError(
      `中继地址缺少协议前缀：${text}。应写成 tcp://主机:端口，例如 tcp://public.easytier.cn:11010`,
    );
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PeerParseError(`中继地址格式不合法：${text}`);
  }

  const scheme = url.protocol.replace(/:$/, '') as PeerScheme;
  if (!(PEER_SCHEMES as readonly string[]).includes(scheme)) {
    throw new PeerParseError(
      `不支持的协议 ${scheme}；可用：${PEER_SCHEMES.join(' / ')}`,
    );
  }

  const host = url.hostname;
  if (host === '') throw new PeerParseError(`中继地址缺少主机名：${text}`);

  if (url.port === '') {
    throw new PeerParseError(`中继地址缺少端口：${text}。例如 tcp://${host}:11010`);
  }
  const port = Number.parseInt(url.port, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new PeerParseError(`端口超出范围（1-65535）：${url.port}`);
  }

  return {
    scheme,
    host,
    port,
    normalized: `${scheme}://${host}:${port}`,
  };
}

/**
 * 规范化一组 peer 地址：解析、去重、保持顺序。
 *
 * 去重是必要的：重复的中继地址会让 EasyTier 建多条到同一节点的连接，
 * 在界面上的节点列表里表现为"同一个节点出现多次"。
 */
export function normalizePeers(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const parsed = parsePeer(item);
    if (seen.has(parsed.normalized)) continue;
    seen.add(parsed.normalized);
    out.push(parsed.normalized);
  }
  return out;
}

/** 校验但不抛异常，供界面实时提示用。 */
export function validatePeer(raw: string): { ok: boolean; error: string | null; normalized: string | null } {
  try {
    const parsed = parsePeer(raw);
    return { ok: true, error: null, normalized: parsed.normalized };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      normalized: null,
    };
  }
}
