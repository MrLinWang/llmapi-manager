import { registerCatalogs } from '.';
import { catalogs } from './locales';

/**
 * 装载字典。
 *
 * 由 `context.ts` 在创建 `AppContext` 时调用一次——放在那里而不是模块顶层，
 * 是因为测试经常只想构造一个 AppContext 而不想加载全部文案；也让
 * "字典是否已装载"变成一个可断言的显式动作。
 */
let installed = false;

export function installCatalogs(): void {
  if (installed) return;
  registerCatalogs(catalogs);
  installed = true;
}

/** 测试用：重置装载标记，便于验证"未装载时的兜底行为"。 */
export function resetCatalogsForTest(): void {
  installed = false;
}
