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
  '/api/providers/models': {
    ok: true,
    latencyMs: 42,
    status: 200,
    models: ['gpt-x', 'gpt-x-mini', 'gpt-x-new'],
  },
  '/api/models': {
    prefix: 'lam-',
    aliases: [
      {
        alias: 'lam-mock-openai/gpt-x',
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
        prefix: 'lam_abcd',
        tail: 'wxyz',
        masked: 'lam_abcd************wxyz',
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
        requestedModel: 'lam-mock-openai/gpt-x',
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
    expect(screen.getByText('lam-mock-openai/')).toBeTruthy();
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
    expect(screen.getByText('lam_abcd************wxyz')).toBeTruthy();
    expect(screen.getByText('lam-mock-openai/gpt-x')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重置令牌' })).toBeTruthy();
    // 令牌明文绝不能出现在页面上
    expect(document.body.textContent ?? '').not.toMatch(/lam_[A-Za-z0-9_-]{20,}/);
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
    expect(screen.getAllByText('lam-mock-openai/gpt-x').length).toBeGreaterThan(0);
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
  it('审批模型下拉能区分同名模型属于哪家供应商', async () => {
    // 真实问题：用户的 gpt-6-luna 同时被 openai 与 responses 两家声明，
    // 下拉里两行都写 "gpt-6-luna"，根本看不出区别，而两家结果不同
    // （协议匹配的那家直通，另一家要转换）。
    //
    // 这里断言标签里带上了供应商与"直通/需转换"标记。
    const providers = [
      { id: 'p1', providerKey: 'wllapi', name: 'wllapi', apiType: 'openai', enabled: true,
        baseUrl: 'http://a', models: ['gpt-6-luna', 'kimi-k3'], priority: 1,
        apiKeyMasked: 'sk-***', apiKeyTail: 'abcd', lastTest: null, createdAt: '', updatedAt: '' },
      { id: 'p2', providerKey: 'opendesign', name: 'opendesign', apiType: 'responses', enabled: true,
        baseUrl: 'http://b', models: ['gpt-6-luna'], priority: 2,
        apiKeyMasked: 'sk-***', apiKeyTail: 'efgh', lastTest: null, createdAt: '', updatedAt: '' },
    ];
    setOverrides({
      '/api/providers': { providers },
      '/api/settings': {
        defaultProviderId: null, defaultModel: null, disableCodexWebSearch: true,
        approvalReviewModel: null, protocolConversion: false,
        agentTargets: { codex: { mode: 'gateway', directProviderId: null, directModel: null, autoReviewModel: null } },
        gatewayBaseUrl: 'http://127.0.0.1:8787/v1',
        token: { exists: true, prefix: 'lam_ab', tail: 'cd', masked: 'lam_ab**cd' },
      },
    });
    const { render, cleanup, screen } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { AuthProvider } = await import('../src/lib/auth');
    const AgentsPage = (await import('../src/pages/AgentsPage')).default;

    // 先卸载之前用例留下的组件树：这个测试文件不逐个 cleanup，
    // 残留的 AgentsPage 会让 findByLabelText 命中旧 DOM、读到上一份 providers。
    cleanup();

    render(
      <MemoryRouter>
        <AuthProvider>
          <AgentsPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    // 等到下拉出现
    const select = (await screen.findByLabelText(
      'Approve for me 使用的模型',
    )) as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent ?? '');

    const gptOption = labels.find((text) => text.includes('gpt-6-luna'));
    expect(gptOption).toBeDefined();
    // 必须能看出走哪家、是直通还是需转换
    expect(gptOption).toContain('opendesign');
    expect(gptOption).toContain('直通');
    // 同名被两家声明也要提示，否则用户不知道还有一家
    expect(gptOption).toContain('wllapi');
    // 同名模型只出现一次（设置里只存模型名，重复行会让人以为能选供应商）
    expect(labels.filter((text) => text.startsWith('gpt-6-luna'))).toHaveLength(1);
    setOverrides({});
  });

  it('设置页可管理 API 令牌：只能勾选自己拥有的权限', async () => {
    // 令牌是收窄授权，界面上若能勾选自己没有的权限，用户点下去只会撞 403。
    // 这里断言渲染时就按 can() 过滤——mock 的 me 只给了 settings/providers 等，
    // 没有 users:manage / tenants:manage。
    setOverrides({
      '/api/tokens': {
        tokens: [],
        availableScopes: [
          'providers:read',
          'providers:write',
          'settings:read',
          'settings:write',
          'users:manage',
          'tenants:manage',
        ],
      },
    });
    const { render, screen } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { AuthProvider } = await import('../src/lib/auth');
    const SettingsPage = (await import('../src/pages/SettingsPage')).default;

    render(
      <MemoryRouter>
        <AuthProvider>
          <SettingsPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('API 令牌')).toBeTruthy();
    // 拥有的一项要出现（可能同时出现在"我的权限"里，所以用 findAll）
    expect((await screen.findAllByText('providers:read')).length).toBeGreaterThan(0);
    // 没有的权限不能渲染成可勾选项
    expect(screen.queryByText('users:manage')).toBeNull();
    expect(screen.queryByText('tenants:manage')).toBeNull();
    // 界面必须说明两套令牌的区别，否则用户会拿去调 /v1 发现不通
    expect(document.body.textContent ?? '').toContain('lam_');
    setOverrides({});
  });

  it('协议类型三个选项句式一致，且都能在表格里显示可读短名', async () => {
    const { API_TYPE_META } = await import('../src/lib/labels');
    expect(API_TYPE_META).toHaveLength(3);
    for (const meta of API_TYPE_META) {
      // 统一句式：<厂商> 兼容（<API 形态>）
      expect(meta.label).toMatch(/兼容（.+）$/);
      // 短名不能是原始枚举值
      expect(meta.short).not.toBe(meta.value);
      expect(meta.path.startsWith('/v1/')).toBe(true);
    }
    expect(API_TYPE_META.map((item) => item.value)).toEqual([
      'openai',
      'responses',
      'anthropic',
    ]);
  });
  it('供应商表单提供"从上游获取模型"按钮，Base URL 为空时禁用', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { AuthProvider } = await import('../src/lib/auth');
    const { ProviderForm } = await import('../src/components/ProviderForm');

    render(
      <MemoryRouter>
        <AuthProvider>
          <ProviderForm onSaved={() => {}} onCancel={() => {}} />
        </AuthProvider>
      </MemoryRouter>,
    );

    const button = await screen.findByRole('button', { name: '从上游获取模型' });
    // 还没填 Base URL，按钮应禁用，避免发出必然失败的请求
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
  it('模型以标签片段呈现：可输入添加、点 × 移除', async () => {
    const { render, screen, fireEvent, within } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { AuthProvider } = await import('../src/lib/auth');
    const { ProviderForm } = await import('../src/components/ProviderForm');

    // 注意：vitest globals 关闭时 RTL 不会自动 cleanup，前面用例的 DOM 还在，
    // 所以所有查询都限定在本用例的 container 内。
    const { container } = render(
      <MemoryRouter>
        <AuthProvider>
          <ProviderForm
            provider={{ ...providers[0], models: ['gpt-x', 'gpt-x-mini'] }}
            onSaved={() => {}}
            onCancel={() => {}}
          />
        </AuthProvider>
      </MemoryRouter>,
    );
    const view = within(container);

    // 已保存的模型应作为标签片段渲染（每个都带 × 移除按钮）
    expect(await view.findByLabelText('移除模型 gpt-x')).toBeTruthy();
    expect(view.getByLabelText('移除模型 gpt-x-mini')).toBeTruthy();

    // 输入后回车即添加为新片段
    const input = view.getByLabelText('模型列表') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gpt-brand-new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(view.getByLabelText('移除模型 gpt-brand-new')).toBeTruthy();

    // 点 × 移除该片段
    fireEvent.click(view.getByLabelText('移除模型 gpt-brand-new'));
    expect(view.queryByLabelText('移除模型 gpt-brand-new')).toBeNull();
  });
});
