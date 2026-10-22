import type { RequestLogRecord, RequestStats } from '../domain/requestLog';

export class RequestLogService {
  constructor(
    private readonly repo: {
      append(record: RequestLogRecord): void;
      recent(limit: number): RequestLogRecord[];
    },
    private readonly tenantId: string,
  ) {}

  /** 日志失败不能影响转发结果，因此这里吞掉异常只回调告警。 */
  append(
    record: Omit<RequestLogRecord, 'tenantId' | 'at'>,
    onError?: (error: unknown) => void,
  ): void {
    try {
      this.repo.append({ ...record, tenantId: this.tenantId, at: new Date().toISOString() });
    } catch (error) {
      onError?.(error);
    }
  }

  recent(limit = 50, providerId?: string): RequestLogRecord[] {
    const records = this.repo.recent(Math.max(limit * 4, 200));
    const filtered = providerId
      ? records.filter((item) => item.providerId === providerId)
      : records;
    return filtered.slice(0, limit);
  }

  stats(): RequestStats {
    const today = new Date().toISOString().slice(0, 10);
    const records = this.repo.recent(2000).filter((item) => item.at.startsWith(today));
    const success = records.filter((item) => item.status >= 200 && item.status < 400).length;
    const avgLatencyMs =
      records.length === 0
        ? 0
        : Math.round(records.reduce((sum, item) => sum + item.latencyMs, 0) / records.length);
    return {
      total: records.length,
      success,
      successRate: records.length === 0 ? 0 : Math.round((success / records.length) * 1000) / 10,
      avgLatencyMs,
    };
  }
}
