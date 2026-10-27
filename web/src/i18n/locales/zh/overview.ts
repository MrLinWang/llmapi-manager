/**
 * 概览页：今日统计、最近请求日志。
 *
 * 标题复用 `app.nav.overview`；日志表格里的徽标（别名/回退/流式）也在这里，
 * 因为它们是这个页面独有的展示概念。
 *
 * 时间列必须用 `web/src/i18n/format.ts` 的 `formatTime`，不要用 `toLocaleTimeString()`：
 * 后者跟随浏览器语言，会和界面语言不一致。
 */
export const zhOverview = {
  header: {
    eyebrow: '运行概览',
    description: '今日网关调用情况与最近请求，快速判断聚合链路是否正常。',
  },
  filter: {
    label: '按供应商筛选',
    all: '全部供应商',
  },
  stats: {
    today: '今日请求',
    todayHint: '按网关请求日志统计',
    successRate: '成功率',
    successHint_one: '成功 {{count}} 次',
    successHint_other: '成功 {{count}} 次',
    avgLatency: '平均耗时',
    avgLatencyHint: '全部请求的平均上游耗时',
  },
  logs: {
    title: '最近请求',
    desc: '今日网关调用的最近 50 条记录，回退请求会单独标记。',
    count_one: '{{count}} 条',
    count_other: '{{count}} 条',
    empty: '还没有请求记录。把客户端指向网关地址后即可看到调用。',
    /** 日志里没有供应商时的占位符，保持一个破折号 */
    noProvider: '—',
    badgeAlias: '别名',
    badgeFallback: '回退',
    stream: '流式',
    nonStream: '非流式',
    table: {
      time: '时间',
      path: '接口',
      model: '模型',
      provider: '供应商',
      status: '状态',
      latency: '耗时',
      kind: '类型',
    },
  },
};
