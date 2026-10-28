import type { zhOverview } from '../zh/overview';

/** 英文侧声明成 `typeof zhOverview`：漏键或多键都会编译失败。 */
export const enOverview: typeof zhOverview = {
  header: {
    eyebrow: 'Runtime overview',
    description:
      'Gateway traffic for today plus the latest requests, so you can tell at a glance whether aggregation works.',
  },
  filter: {
    label: 'Filter by provider',
    all: 'All providers',
  },
  stats: {
    today: 'Requests today',
    todayHint: 'Counted from gateway request logs',
    successRate: 'Success rate',
    successHint_one: '{{count}} successful request',
    successHint_other: '{{count}} successful requests',
    avgLatency: 'Average latency',
    avgLatencyHint: 'Average upstream latency across all requests',
  },
  logs: {
    title: 'Recent requests',
    desc: 'The latest 50 gateway calls from today; fallback requests are flagged separately.',
    count_one: '{{count}} record',
    count_other: '{{count}} records',
    empty: 'No requests yet. Point a client at the gateway URL and calls will show up here.',
    noProvider: '—',
    badgeAlias: 'Alias',
    badgeFallback: 'Fallback',
    stream: 'Streaming',
    nonStream: 'Non-streaming',
    table: {
      time: 'Time',
      path: 'Endpoint',
      model: 'Model',
      provider: 'Provider',
      status: 'Status',
      latency: 'Latency',
      kind: 'Type',
    },
  },
};
