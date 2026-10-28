import type { ParseKeys, TFunction } from 'i18next';
import type { ApiType } from './types';

/**
 * 文案键名的类型。
 *
 * 用 i18next 的 `ParseKeys<'translation'>` 而不是 `Parameters<TFunction>[0]`：
 * 后者的首参是"键或键数组或模板串"的联合，拿它去调 `t()` 会反过来触发
 * "参数不匹配"——类型虽然宽，却用不起来。`ParseKeys` 是真正收敛后的键联合，
 * 拼错的键在 `tsc` 阶段就报错。
 */
export type MessageKey = ParseKeys<'translation'>;

const ROLE_KEYS: Record<string, MessageKey> = {
  owner: 'labels.roles.owner',
  admin: 'labels.roles.admin',
  member: 'labels.roles.member',
};

/**
 * 角色名的展示文案。
 *
 * 传 `t` 而不是在内部 import 全局 i18n 实例：组件里用 `useTranslation()` 拿到的
 * `t` 会订阅语言变化并在切换时触发重渲染；直接用全局实例只有"下一次渲染"才生效，
 * 表现为"点了切换，页面要再点一下才变"。
 */
export function roleLabel(t: TFunction, role: string | undefined): string {
  if (!role) return '';
  const key = ROLE_KEYS[role];
  return key ? t(key) : role;
}

/**
 * 协议类型的展示文案，单一来源。
 *
 * 三个选项统一成「<厂商> 兼容（<API 形态>）」句式：
 * 它们描述的都是"某厂商协议的兼容上游"，括号里才是真正区分路由的 API 形态。
 * 下拉框、表格徽标、报错文案都从这里取，避免各处自行拼字符串导致口径不一。
 *
 * `value` 是机器标识（决定路由），`labelKey` / `shortKey` 才是文案键：
 * 把两者分开，翻译时就不可能误改到决定行为的枚举值。
 */
export interface ApiTypeMeta {
  value: ApiType;
  /** 下拉框等需要完整说明的地方 */
  labelKey: MessageKey;
  /** 表格徽标等空间紧张的地方 */
  shortKey: MessageKey;
  /** 该协议对应的网关路径，用于提示"这个供应商接哪条路" */
  path: string;
}

export const API_TYPE_META: readonly ApiTypeMeta[] = [
  {
    value: 'openai',
    labelKey: 'labels.apiTypes.openai.label',
    shortKey: 'labels.apiTypes.openai.short',
    path: '/v1/chat/completions',
  },
  {
    value: 'responses',
    labelKey: 'labels.apiTypes.responses.label',
    shortKey: 'labels.apiTypes.responses.short',
    path: '/v1/responses',
  },
  {
    value: 'anthropic',
    labelKey: 'labels.apiTypes.anthropic.label',
    shortKey: 'labels.apiTypes.anthropic.short',
    path: '/v1/messages',
  },
];

const META_BY_VALUE = new Map<string, ApiTypeMeta>(
  API_TYPE_META.map((item) => [item.value, item]),
);

/** 完整协议说明，如「OpenAI 兼容（Chat Completions）」。 */
export function apiTypeLabel(t: TFunction, apiType: string | undefined): string {
  if (!apiType) return '';
  const meta = META_BY_VALUE.get(apiType);
  // 未知协议回退原始值：服务端将来新增协议时，界面显示标识符也好过空白。
  return meta ? t(meta.labelKey) : apiType;
}

/** 表格徽标用的短名，如 `Chat` / `Responses` / `Messages`。 */
export function apiTypeShort(t: TFunction, apiType: string | undefined): string {
  if (!apiType) return '';
  const meta = META_BY_VALUE.get(apiType);
  return meta ? t(meta.shortKey) : apiType;
}

/**
 * 权限名 → 文案键。
 *
 * 权限标识符里带 `:`（`providers:read`），而 i18next 把 `:` 当命名空间分隔符，
 * 所以不能直接用标识符当键。这里显式建表而不是字符串替换：
 * 新增权限时漏加一行会走下面的回退分支（界面显示原始标识符），能被一眼发现；
 * 自动把 `:` 换成 `.` 则会悄悄生成一个不存在的键、显示成键名。
 */
const PERMISSION_KEYS: Record<string, MessageKey> = {
  'providers:read': 'labels.permissions.providersRead',
  'providers:write': 'labels.permissions.providersWrite',
  'gateway:read': 'labels.permissions.gatewayRead',
  'gateway:write': 'labels.permissions.gatewayWrite',
  'agents:read': 'labels.permissions.agentsRead',
  'agents:apply': 'labels.permissions.agentsApply',
  'logs:read': 'labels.permissions.logsRead',
  'settings:read': 'labels.permissions.settingsRead',
  'settings:write': 'labels.permissions.settingsWrite',
  'users:manage': 'labels.permissions.usersManage',
  'tenants:manage': 'labels.permissions.tenantsManage',
};

export function permissionLabel(t: TFunction, permission: string): string {
  const key = PERMISSION_KEYS[permission];
  return key ? t(key) : permission;
}

/** 供契约测试使用：权限清单必须与字典一一对应。 */
export const PERMISSION_IDS = Object.keys(PERMISSION_KEYS);
