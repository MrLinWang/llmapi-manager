import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import i18n from '../src/i18n';

/**
 * 每个用例后卸载 React 树。
 *
 * 为什么需要显式做：`globals: false` 时 React Testing Library **不会**自动注册
 * 清理钩子（它靠全局的 `afterEach` 探测），于是上一个用例渲染的 DOM 会留在
 * `document` 里。后果是后续用例的 `screen.getByText(...)` 可能命中上一份组件树——
 * 表现为"单独跑通过、整个文件跑失败"，或读到上一个用例的 mock 数据。
 *
 * 之前两条用例是靠 `within(container)` 限定查询范围绕过的，属于治标：
 * 只要有人写 `screen.getBy...` 就会踩。集中在这里做一次，所有用例都受益。
 */
afterEach(() => {
  cleanup();
});

/**
 * 每个用例前把界面语言固定成中文。
 *
 * 两个原因，缺一个都会变成"偶发失败"：
 * 1. jsdom 的 `navigator.language` 是 `en-US`，而 i18n 初始化时按浏览器语言选语言。
 *    不固定的话，现有那批断言中文文案的用例会整片变红——而这个失败与被测代码无关。
 * 2. 用例之间会通过语言切换互相污染（前一个用例切到 English，后一个没切回来）。
 *
 * 需要测英文的用例在自己的用例里显式 `await i18n.changeLanguage('en')`，
 * 不要依赖环境默认值。
 */
beforeEach(async () => {
  await i18n.changeLanguage('zh');
});
