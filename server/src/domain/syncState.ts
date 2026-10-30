/**
 * 同步基线（`sync-state.json`）。
 *
 * 为什么需要它：只靠 `updatedAt` 判断"谁更新"会在三种情况下出错——
 * 两端改完又改回、时钟不同步、以及"远端没变但本地早就是新值"。三方合并
 * （base / local / remote）能准确回答"这一侧到底改没改"，前提是记住上一次
 * 双方确认过的内容。
 *
 * 存的是**内容哈希**而不是完整内容：基线只需要判断"变没变"，
 * 存完整值会让这份文件成为凭据的第二份副本（供应商里有明文 apiKey）。
 *
 * 这份文件**不暴露任何 API**：它是合并算法的内部状态，用户看到的是冲突列表，
 * 不需要也不应该看到哈希。哈希泄露的信息量很小，但没有展示它的理由。
 */
import type { SyncScope } from './sync';

/** 一条基线：某个 scope 下某条记录的规范内容哈希。 */
export interface SyncStateEntry {
  scope: SyncScope;
  /** 供应商用 id、设置用 'settings'、AgentTarget 用 agentId */
  targetId: string;
  /** 规范内容的 SHA-256（十六进制小写） */
  hash: string;
}

export interface SyncStateData {
  entries: SyncStateEntry[];
  /** 最后一次写入时间，便于排查"基线是什么时候建立的" */
  updatedAt: string;
}

/**
 * 文件信封版本。由 `createJsonFile` 写入，读到更新的版本会被隔离。
 * 与快照的 `schemaVersion` 是两件事：那个描述跨机传输格式，这个描述本地文件格式。
 */
export const SYNC_STATE_SCHEMA_VERSION = 1;

export function defaultSyncStateData(): SyncStateData {
  return { entries: [], updatedAt: new Date().toISOString() };
}

/** 同一 scope/targetId 的基线标识：写入 Map 时避免拼串歧义。 */
export function syncStateKey(scope: SyncScope, targetId: string): string {
  return `${scope}\u0000${targetId}`;
}
