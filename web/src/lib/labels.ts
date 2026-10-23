import type { ApiType } from './types';

const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
};

export function roleLabel(role: string | undefined): string {
  if (!role) return '';
  return ROLE_LABELS[role] ?? role;
}

/**
 * 协议类型的展示文案，单一来源。
 *
 * 三个选项统一成「<厂商> 兼容（<API 形态>）」句式：
 * 它们描述的都是"某厂商协议的兼容上游"，括号里才是真正区分路由的 API 形态。
 * 下拉框、表格徽标、报错文案都从这里取，避免各处自行拼字符串导致口径不一。
 */
export interface ApiTypeMeta {
  value: ApiType;
  /** 下拉框等需要完整说明的地方 */
  label: string;
  /** 表格徽标等空间紧张的地方 */
  short: string;
  /** 该协议对应的网关路径，用于提示"这个供应商接哪条路" */
  path: string;
}

export const API_TYPE_META: readonly ApiTypeMeta[] = [
  {
    value: 'openai',
    label: 'OpenAI 兼容（Chat Completions）',
    short: 'Chat',
    path: '/v1/chat/completions',
  },
  {
    value: 'responses',
    label: 'OpenAI 兼容（Responses）',
    short: 'Responses',
    path: '/v1/responses',
  },
  {
    value: 'anthropic',
    label: 'Anthropic 兼容（Messages）',
    short: 'Messages',
    path: '/v1/messages',
  },
];

const META_BY_VALUE = new Map<string, ApiTypeMeta>(
  API_TYPE_META.map((item) => [item.value, item]),
);

export function apiTypeShort(apiType: string | undefined): string {
  if (!apiType) return '';
  return META_BY_VALUE.get(apiType)?.short ?? apiType;
}

/**
 * 权限名的中文说明。
 *
 * 界面上一律显示 `权限名 + 说明`：只给 `providers:write` 这类标识符，
 * 用户无法判断勾选后到底能干什么，而这里勾错是要授权出去的。
 */
const PERMISSION_LABELS: Record<string, string> = {
  'providers:read': '读取供应商',
  'providers:write': '增删改供应商',
  'gateway:read': '读取网关地址与令牌状态',
  'gateway:write': '重置网关令牌',
  'agents:read': '读取 Agent 配置',
  'agents:apply': '下发与还原 Agent 配置',
  'logs:read': '读取请求日志与统计',
  'settings:read': '读取设置',
  'settings:write': '修改设置',
  'users:manage': '管理用户',
  'tenants:manage': '管理租户',
};

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}
