import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.tsx'],
    environment: 'jsdom',
    // 保持关闭：用例里都显式 import describe/it/expect，不依赖全局变量。
    // 注意它同时意味着 RTL 不会自动 cleanup（它靠探测全局 afterEach），
    // 所以必须由 setupFiles 显式注册——否则上一个用例的 DOM 会留到下一个用例。
    globals: false,
    setupFiles: ['./test/setup.ts'],
  },
});
