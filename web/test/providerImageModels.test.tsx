import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/lib/auth';
import { ProviderForm } from '../src/components/ProviderForm';
import type { Provider } from '../src/lib/types';

/**
 * 「生图模型」输入框的真实渲染核验。
 *
 * 这组用例专门钉住"用户能在界面上找到并操作它"这件事——
 * 单元测试与类型检查都发现不了"框被挪走了 / 渲染到看不见的地方"。
 */

const baseProvider: Provider = {
  id: 'p_1',
  name: 'OpenDesign',
  providerKey: 'opendesign',
  apiType: 'responses',
  baseUrl: 'https://amr-link.open-design.ai/v1',
  models: ['deepseek-v4.1-flash'],
  imageModels: ['gpt-image-2'],
  enabled: true,
  priority: 0,
  createdBy: 'u_owner',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  apiKeyMasked: 'sk-********abcd',
  apiKeyTail: 'abcd',
  hasApiKey: true,
};

function renderForm(provider?: Provider) {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <ProviderForm provider={provider} onSaved={() => {}} onCancel={() => {}} />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('供应商表单：生图模型框', () => {
  it('新增供应商时就有「生图模型」标签与输入框', () => {
    const { container } = renderForm();
    const view = within(container);
    // 标签文案必须出现：这是用户找到这个框的唯一线索
    expect(container.textContent).toContain('生图模型（可选）');
    const input = view.getByLabelText('生图模型（可选）') as HTMLInputElement;
    expect(input).toBeTruthy();
    // label 的 htmlFor 必须指向这块输入框，否则点标签聚焦不到它
    expect(input.id).toBeTruthy();
  });

  it('编辑已保存的供应商时，生图模型渲染在自己的框里', () => {
    const { container } = renderForm(baseProvider);
    const view = within(container);
    expect(view.queryByLabelText('移除生图模型 gpt-image-2')).toBeTruthy();
    // 对话模型的模型不会跑到生图框里
    expect(view.queryByLabelText('移除模型 deepseek-v4.1-flash')).toBeTruthy();
    expect(view.queryByLabelText('移除生图模型 deepseek-v4.1-flash')).toBeNull();
  });

  it('在生图框里输入并回车可以添加片段，且不污染对话模型', () => {
    const { container } = renderForm(baseProvider);
    const view = within(container);
    const input = view.getByLabelText('生图模型（可选）') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'seedream-5.0' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(view.queryByLabelText('移除生图模型 seedream-5.0')).toBeTruthy();
    // 关键：不能同时出现在对话模型框里
    expect(view.queryByLabelText('移除模型 seedream-5.0')).toBeNull();
  });

  it('两个框各有一个「从上游获取模型」按钮', () => {
    renderForm(baseProvider);
    const buttons = screen.getAllByRole('button', { name: '从上游获取模型' });
    expect(buttons).toHaveLength(2);
  });
});
