import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
// 必须在任何组件渲染前导入：它在模块加载时就完成 i18next 初始化并同步好 <html lang>，
// 否则首帧会显示键名，或 lang 属性与界面语言不一致。
import './i18n';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 节点');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
