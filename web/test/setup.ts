import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

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
