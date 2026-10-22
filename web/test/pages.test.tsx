import { describe, expect, it } from 'vitest';

/**
 * 冒烟用前端测试：用 jsdom 渲染真实页面组件，断言关键文案与交互元素存在。
 * 通过 stub 全局 fetch 复用真实的 api 封装，从而验证 API 契约与页面装配。
 */

type RouteMap = Record<string, unknown>;

const providers = [
  {
    id: 'p_1',
    name: 'Mock OpenAI',
    providerKey: 'mock-openai',
    apiType: 'openai',
    baseUrl: 'http://127.0.0.1:18899',
    models: ['gpt-x', 'gpt-x-mini'],
    enabled: true,
    priority: 0,
    createdBy: 'u_owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    apiKeyMasked: 'sk-********cret',
    apiKeyTail: 'cret',
    hasApiKey: true,
    lastTest: {
      at: '2026-01-01T00:00:00.000Z',
      ok: true,
      latencyMs: 42,
      models: ['gpt-x'],
    },
  },
];

const routes: RouteMap = {
  '/api/auth/me': {
    user: { id: 'u_owner', tenantId: 't_default', role: 'owner', username: 'owner' },
    permissions: [
      'providers:read',
      'providers:write',
      'gateway:read',
      'gateway:write',
      'agents:read',
      'agents:apply',
      'logs:read',
      'settings:read',
      'settings:write',
    ],
    allPermissions: ['providers:read', 'providers:write'],
  },
  '/api/health': { ok: true, warnings: [], gatewayBaseUrl: 'http://127.0.0.1:8787/v1' },
  '/api/setup/status': {
    needsSetup: false,
    defaultUsername: 'admin',
    rules: { minUsernameLength: 3, maxUsernameLength: 32, minPasswordLength: 8 },
  },
  '/api/providers': { providers },
  '/api/models': {
    prefix: 'lmm-',
    aliases: [
      {
        alias: 'lmm-mock-openai/gpt-x',
        providerId: 'p_1',
        providerKey: 'mock-openai',
        providerName: 'Mock OpenAI',
        apiType: 'openai',
        upstreamModel: 'gpt-x',
      },
    ],
    default: { providerId: 'p_1', providerName: 'Mock OpenAI', model: 'gpt-x' },
    gateway: {
      baseUrl: 'http://127.0.0.1:8787/v1',
      token: {
        exists: true,
        prefix: 'lmm_abcd',
        tail: 'wxyz',
        masked: 'lmm_abcd************wxyz',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
  },
  '/api/agents': {
    agents: [
      {
        id: 'codex',
        name: 'Codex CLI',
        description: '写入 ~/.codex',
        applied: false,
      },
      {
        id: 'claude-code',
        name: 'Claude Code',
        description: '写入 ~/.claude',
        applied: true,
        appliedAt: '2026-01-01T00:00:00.000Z',
        appliedBy: 'u_owner',
      },
    ],
  },
  '/api/stats': { total: 12, success: 11, successRate: 91.7, avgLatencyMs: 320 },
  '/api/logs': {
    logs: [
      {
        tenantId: 't_default',
        at: '2026-01-01T00:00:00.000Z',
        path: '/v1/chat/completions',
        requestedModel: 'lmm-mock-openai/gpt-x',
        upstreamModel: 'gpt-x',
        providerId: 'p_1',
        providerName: 'Mock OpenAI',
        mode: 'alias',
        stream: false,
        status: 200,
        latencyMs: 111,
        fallback: false,
      },
    ],
  },
};

/**
 * 默认按 routes 返回；个别用例可以用 overrides 临时改某条路径的响应，
 * 例如"服务尚未初始化"的场景。
 */
let overrides: RouteMap = {};

function setOverrides(next: RouteMap): void {
  overrides = next;
}

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.split('?')[0];
    const body = path in overrides ? overrides[path] : routes[path];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      text: async () => JSON.stringify(body ?? { error: { code: 'not_found' } }),
    } as Response;
  }) as typeof fetch;
}

installFetch();

describe('前端页面装配', () => {
  it('登录页渲染用户名、口令与登录按钮', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { MemoryRouter, Route, Routes } = await import('react-router-dom');
    const { AuthProvider } = await import('../src/lib/auth');
    const LoginPage = (await import('../src/pages/LoginPage')).default;

    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('LLM API Manager')).toBeTruthy();
    expect(screen.getByLabelText('用户名')).toBeTruthy();
    expect(screen.getByLabelText('口令')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });

  it('供应商页展示脱敏 Key、别名前缀与操作按钮', async () => {
    const { render, screen, waitFor } = await import('@testing-library/react');
    const { AuthProvider } = await import('../src/lib/auth');
    const ProvidersPage = (await import('../src/pages/ProvidersPage')).default;

    render(
      <AuthProvider>
        <ProvidersPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('Mock OpenAI')).toBeTruthy());
    expect(screen.getByText('lmm-mock-openai/')).toBeTruthy();
    expect(screen.getByText('sk-********cret')).toBeTruthy();
    expect(screen.getByRole('button', { name: '新增供应商' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '测试' })).toBeTruthy();
    expect(screen.queryByText('gpt-x-mini')).toBeTruthy();
  });

  it('模型聚合页展示网关地址、脱敏令牌与别名', async () => {
    const { render, screen, waitFor } = await import('@testing-library/react');
    const { AuthProvider } = await import('../src/lib/auth');
    const ModelsPage = (await import('../src/pages/ModelsPage')).default;

    render(
      <AuthProvider>
        <ModelsPage />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('http://127.0.0.1:8787/v1')).toBeTruthy(),
    );
    expect(screen.getByText('lmm_abcd************wxyz')).toBeTruthy();
    expect(screen.getByText('lmm-mock-openai/gpt-x')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重置令牌' })).toBeTruthy();
    // 令牌明文绝不能出现在页面上
    expect(document.body.textContent ?? '').not.toMatch(/lmm_[A-Za-z0-9_-]{20,}/);
  });

  it('Agent 页展示两个 Agent 与状态', async () => {
    const { render, screen, waitFor } = await import('@testing-library/react');
    const { AuthProvider } = await import('../src/lib/auth');
    const AgentsPage = (await import('../src/pages/AgentsPage')).default;

    render(
      <AuthProvider>
        <AgentsPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('Codex CLI')).toBeTruthy());
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('已接管')).toBeTruthy();
    expect(screen.getByText('未接管')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '预览' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: '应用配置' })).toBeTruthy();
  });

  it('概览页展示统计与请求日志', async () => {
    const { render, screen, waitFor } = await import('@testing-library/react');
    const { AuthProvider } = await import('../src/lib/auth');
    const OverviewPage = (await import('../src/pages/OverviewPage')).default;

    render(
      <AuthProvider>
        <OverviewPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('91.7%')).toBeTruthy());
    expect(screen.getByText('320ms')).toBeTruthy();
    expect(screen.getAllByText('lmm-mock-openai/gpt-x').length).toBeGreaterThan(0);
    // 供应商名同时出现在筛选下拉与日志行里
    expect(screen.getAllByText('Mock OpenAI').length).toBeGreaterThan(1);
  });
  it('设置页渲染初始化令牌、用户名与两次口令输入', async () => {
    // 未初始化场景：/api/setup/status 返回 needsSetup: true
    setOverrides({
      '/api/setup/status': {
        needsSetup: true,
        defaultUsername: 'admin',
        rules: { minUsernameLength: 3, maxUsernameLength: 32, minPasswordLength: 8 },
      },
    });
    const { render, screen } = await import('@testing-library/react');
    const { MemoryRouter, Route, Routes } = await import('react-router-dom');
    const { AuthProvider } = await import('../src/lib/auth');
    const SetupPage = (await import('../src/pages/SetupPage')).default;

    render(
      <MemoryRouter initialEntries={['/setup']}>
        <AuthProvider>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('设置管理员账号')).toBeTruthy();
    expect(screen.getByLabelText('初始化令牌')).toBeTruthy();
    expect(screen.getByLabelText('用户名')).toBeTruthy();
    expect(screen.getByLabelText('口令')).toBeTruthy();
    expect(screen.getByLabelText('确认口令')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建管理员并登录' })).toBeTruthy();
    // 页面必须提示令牌从哪里来，否则用户会卡住
    expect(document.body.textContent ?? '').toContain('data/setup.json');
    setOverrides({});
  });
});
