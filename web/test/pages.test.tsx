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
    // language 由下面的 serverLanguage 统一注入（初值 'zh'）：jsdom 的
    // navigator.language 是 en-US，按浏览器语言初始化会让整页渲染成英文，
    // 本文件里断言中文文案的用例会全部变红。
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

/**
 * 记录发出的请求。
 *
 * 语言切换这类"点了之后还要落盘"的交互，只断言界面变了是不够的：
 * 请求根本没发出去、或者发到了错的路径/方法，界面也会因为乐观更新而变化。
 */
let requests: Array<{
  method: string;
  path: string;
  body: string | null;
  headers: Record<string, string>;
}> = [];

/**
 * 服务端当前的界面语言（模拟 settings.json 里那一个字段）。
 *
 * 语言是"服务端为真源"的状态：`/api/auth/me` 返回它，`PATCH /api/settings/language`
 * 改写它。用可变状态而不是固定 mock，才能验证"改完之后刷新仍然是新值"这条
 * ——固定 mock 会让测试在"刷新把语言又拉回旧值"时依然通过。
 */
let serverLanguage: 'zh' | 'en' | null = 'zh';

function setOverrides(next: RouteMap): void {
  overrides = next;
}

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.split('?')[0];
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    requests.push({ method, path, body, headers: (init?.headers ?? {}) as Record<string, string> });

    // 语言设置按真实行为模拟：写入后 `/api/auth/me` 也要跟着返回新值，
    // 否则测不出"刷新之后语言又跳回旧值"这种真实故障。
    if (path === '/api/settings/language' && method === 'PATCH') {
      serverLanguage = (JSON.parse(body ?? '{}') as { language: 'zh' | 'en' | null }).language;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ language: serverLanguage }),
      } as Response;
    }
    if (path === '/api/auth/me' && !(path in overrides)) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ...(routes[path] as object), language: serverLanguage }),
      } as Response;
    }

    const payload = path in overrides ? overrides[path] : routes[path];
    // 约定：`__ndjson` 是流式响应体（逐行事件，例如逐档实测）。
    // 客户端在拿不到 response.body 时会退化为整段文本逐行解析。
    const ndjson = (payload as { __ndjson?: unknown; __delayMs?: unknown } | undefined)
      ?.__ndjson;
    if (typeof ndjson === 'string') {
      // __delayMs 让这条流式响应晚一点返回，便于在测试里观察到"探测中"的进度条；
      // 默认 0，不影响其他用例。
      const delayMs =
        typeof (payload as { __delayMs?: unknown }).__delayMs === 'number'
          ? ((payload as { __delayMs?: number }).__delayMs as number)
          : 0;
      return {
        ok: true,
        status: 200,
        text: async () => {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          return ndjson;
        },
      } as Response;
    }
    // 约定：带 `error` 字段的 payload 视为错误响应，按其中的 statusCode 返回
    const err = (payload as { error?: unknown; statusCode?: number } | undefined)?.error
      ? (payload as { statusCode?: number })
      : undefined;
    return {
      ok: payload !== undefined && err === undefined,
      status: err ? (err.statusCode ?? 400) : payload === undefined ? 404 : 200,
      text: async () => JSON.stringify(payload ?? { error: { code: 'not_found' } }),
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

  it('编辑供应商时可逐档实测：确认后调用接口并展示接受的档位', async () => {
    // 档位相关 UI 已从列表行内移到「编辑供应商」：一个供应商可能有十几个模型，
    // 每行还要带档位与被拒说明，塞进表格那一格会把整行撑坏。
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    requests = [];
    setOverrides({
      '/api/providers/p_1/probe-efforts': {
        __delayMs: 300,
        __ndjson:
          [
            {
              type: 'start',
              total: 6,
              candidates: ['low', 'medium', 'high'],
              models: ['gpt-x', 'gpt-x-mini'],
            },
            { type: 'progress', done: 1, total: 3, model: 'gpt-x', effort: 'low', accepted: true },
            { type: 'progress', done: 2, total: 3, model: 'gpt-x', effort: 'medium', accepted: true },
            { type: 'progress', done: 3, total: 3, model: 'gpt-x', effort: 'high', accepted: true },
            {
              type: 'result',
              provider: providers[0],
              candidates: ['low', 'medium', 'high'],
              models: [
                { model: 'gpt-x', accepted: ['low', 'medium', 'high'], rejected: ['none'] },
              ],
            },
          ]
            .map((event) => JSON.stringify(event))
            .join('\n') + '\n',
      },
    });
    try {
      const { render, screen, fireEvent, waitFor } = await import('@testing-library/react');
      const { AuthProvider } = await import('../src/lib/auth');
      const ProvidersPage = (await import('../src/pages/ProvidersPage')).default;

      render(
        <AuthProvider>
          <ProvidersPage />
        </AuthProvider>,
      );

      await screen.findByText('Mock OpenAI');
      // 档位 UI 现在只在编辑态出现：先进编辑
      fireEvent.click(screen.getByRole('button', { name: '编辑' }));
      fireEvent.click(await screen.findByRole('button', { name: '逐档实测' }));

      // 等待期间必须能看到进度条（不能只显示一句"请稍候"）
      const bar = await waitFor(() => screen.getByRole('progressbar'));
      expect(bar.getAttribute('aria-valuemax')).toBe('18');

      await waitFor(() => expect(screen.getByText('low / medium / high')).toBeTruthy());

      const posted = requests.find(
        (item) =>
          item.method === 'POST' && item.path === '/api/providers/p_1/probe-efforts',
      );
      expect(posted).toBeDefined();
      // 无 body 的 POST 不能带 JSON 头：服务端会把空 body 判成 400
      expect(posted?.headers['content-type']).toBeUndefined();
    } finally {
      window.confirm = originalConfirm;
      setOverrides({});
    }
  });

  it('已落盘的思考档位在编辑表单里常驻可见（不依赖探测动作）', async () => {
    // 数据来自 provider.modelCapabilities，是服务端落盘值：
    // 关掉页面、第二天再打开仍应看得到，不必为看一眼结果重测（几十秒 + 真烧额度）。
    setOverrides({
      '/api/providers': {
        providers: [
          {
            ...providers[0],
            models: ['gpt-x'],
            imageModels: ['gpt-image-2'],
            modelCapabilities: {
              'gpt-x': { supportsReasoning: true, reasoningEfforts: ['low', 'high'] },
              'gpt-image-2': { reasoningEfforts: [] },
            },
          },
        ],
      },
    });
    try {
      const { render, screen, fireEvent } = await import('@testing-library/react');
      const { AuthProvider } = await import('../src/lib/auth');
      const ProvidersPage = (await import('../src/pages/ProvidersPage')).default;

      render(
        <AuthProvider>
          <ProvidersPage />
        </AuthProvider>,
      );

      await screen.findByText('Mock OpenAI');
      fireEvent.click(screen.getByRole('button', { name: '编辑' }));

      // 对话模型探出的档位直接可见，且没有任何探测动作发生
      await screen.findByText('low / high');
      // 生图模型也在同一区块里展示（两份模型清单都要能查到档位）。
      // 它同时出现在模型框与档位块里，所以用 title 定位档位块那一处。
      expect(screen.getAllByText('gpt-image-2').length).toBeGreaterThanOrEqual(2);
      // 空数组语义：测过但一个档位都没被接受 → 明确说明，而不是空白
      expect(screen.getByText('未探测到可用档位，已保留原配置')).toBeTruthy();
    } finally {
      setOverrides({});
    }
  });

  it('没实测过的供应商在编辑表单里给出可做的下一步', async () => {
    setOverrides({ '/api/providers': { providers: [providers[0]] } });
    try {
      const { render, screen, fireEvent } = await import('@testing-library/react');
      const { AuthProvider } = await import('../src/lib/auth');
      const ProvidersPage = (await import('../src/pages/ProvidersPage')).default;

      render(
        <AuthProvider>
          <ProvidersPage />
        </AuthProvider>,
      );

      await screen.findByText('Mock OpenAI');
      fireEvent.click(screen.getByRole('button', { name: '编辑' }));

      // 空白会让人以为这块没实现；明确告诉用户"还没测"
      await screen.findByText('未实测（点「逐档实测」探测）');
    } finally {
      setOverrides({});
    }
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

  it('结束 Codex 进程后的提示包含手动清理命令', async () => {
    // 自动结束是尽力而为：`codex app-server daemon stop` 在配置目录只读时会失败，
    // 非标准位置启动的进程也可能匹配不到。提示里必须给出 `pkill -9 -f codex`，
    // 否则用户看到"已结束"或一句失败原因后不知道下一步该做什么。
    setOverrides({
      '/api/agents/codex/stop-processes': {
        actions: ['已结束 1 个 Codex 客户端进程'],
        killed: 1,
        warnings: [],
        supported: true,
      },
    });
    const { render, screen, waitFor, fireEvent } = await import('@testing-library/react');
    const { AuthProvider } = await import('../src/lib/auth');
    const AgentsPage = (await import('../src/pages/AgentsPage')).default;

    render(
      <AuthProvider>
        <AgentsPage />
      </AuthProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '退出 Codex 进程' }));

    // 逐字断言整句，不做"包含 pkill 就算过"的宽松检查：
    // 用户要的就是这句话，措辞与换行都不能漂。
    await waitFor(() =>
      expect(document.body.textContent ?? '').toContain(
        '也可手动执行 pkill -9 -f codex 来清理相关进程',
      ),
    );
    // 提示里也要保留"重开 Codex 才生效"这一层，不能只剩命令
    expect(document.body.textContent ?? '').toContain('重新打开 Codex 即可加载最新配置');
    setOverrides({});
  });

  it('守护进程 stop 失败、只剩警告时也给出手动清理命令', async () => {
    // 这条响应是从真实后端抓下来的（真机 codex 装好、但 ~/.codex 所在 fs 只读）：
    //   actions: ["本机没有正在运行的 Codex 进程"]
    //   warnings: ["停止守护进程失败：... Read-only file system (os error 30)"]
    // 同时非空时走的是 setMessage 分支，警告内容要能看见，手动命令也不能丢。
    setOverrides({
      '/api/agents/codex/stop-processes': {
        actions: ['本机没有正在运行的 Codex 进程'],
        killed: 0,
        warnings: [
          '停止守护进程失败：WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)',
        ],
        supported: true,
      },
    });
    const { render, screen, waitFor, fireEvent } = await import('@testing-library/react');
    const { AuthProvider } = await import('../src/lib/auth');
    const AgentsPage = (await import('../src/pages/AgentsPage')).default;

    render(
      <AuthProvider>
        <AgentsPage />
      </AuthProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '退出 Codex 进程' }));

    await waitFor(() =>
      expect(document.body.textContent ?? '').toContain(
        '停止守护进程失败：WARNING: proceeding',
      ),
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('也可手动执行 pkill -9 -f codex 来清理相关进程');
    setOverrides({});
  });

  it('结束进程的请求失败时也提示手动清理命令', async () => {
    // 请求本身失败（后端 500 / 路由 404 / 网络断）时用户最需要这条命令：
    // 自动结束根本没跑起来，只剩手动清理这一条路。
    setOverrides({
      '/api/agents/codex/stop-processes': undefined,
    });
    const { render, screen, waitFor, fireEvent } = await import('@testing-library/react');
    const { AuthProvider } = await import('../src/lib/auth');
    const AgentsPage = (await import('../src/pages/AgentsPage')).default;

    render(
      <AuthProvider>
        <AgentsPage />
      </AuthProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '退出 Codex 进程' }));

    await waitFor(() =>
      expect(document.body.textContent ?? '').toContain(
        '也可手动执行 pkill -9 -f codex 来清理相关进程',
      ),
    );
    setOverrides({});
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
        // 两个流式参数：默认值与服务端一致（实测得出的 10 次 / 10 分钟）
        codexStreamMaxRetries: 10, codexStreamIdleTimeoutMs: 600000,
        approvalReviewModel: null, protocolConversion: false,
        agentTargets: { codex: { mode: 'gateway', directProviderId: null, directModel: null, autoReviewModel: null } },
        gatewayBaseUrl: 'http://127.0.0.1:8787/v1',
        token: { exists: true, prefix: 'lam_ab', tail: 'cd', masked: 'lam_ab**cd' },
      },
    });
    const { render, screen } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { AuthProvider } = await import('../src/lib/auth');
    const AgentsPage = (await import('../src/pages/AgentsPage')).default;

    // 不需要手动 cleanup：test/setup.ts 注册了全局 afterEach 清理。
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

    // 两个流式参数要预填服务端已存的值，否则用户会以为没设置过
    const retries = (await screen.findByLabelText('流式重连上限')) as HTMLInputElement;
    const idle = (await screen.findByLabelText('流式空闲超时')) as HTMLInputElement;
    expect(retries.value).toBe('10');
    expect(idle.value).toBe('600000');
    // 范围提示必须写在界面上，否则用户不知道该填多少（Codex 会静默截断超限值）
    expect(document.body.textContent).toContain('允许 0–100');
    expect(document.body.textContent).toContain('允许 1000–3600000');
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
    const i18n = (await import('../src/i18n')).default;
    expect(API_TYPE_META).toHaveLength(3);
    for (const meta of API_TYPE_META) {
      // 文案现在来自字典，断言取 zh / en 两种语言下的实际渲染结果。
      // 统一句式：<厂商> 兼容（<API 形态>）；英文侧用 "OpenAI-compatible (...)"
      const zhLabel = i18n.t(meta.labelKey, { lng: 'zh' });
      const enLabel = i18n.t(meta.labelKey, { lng: 'en' });
      expect(zhLabel).toMatch(/兼容（.+）$/);
      expect(enLabel).toMatch(/-compatible \(.+\)$/);
      // 短名不能是原始枚举值
      expect(i18n.t(meta.shortKey, { lng: 'zh' })).not.toBe(meta.value);
      expect(i18n.t(meta.shortKey, { lng: 'en' })).not.toBe(meta.value);
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

    // 现在有两个这样的按钮：对话模型与生图模型各一个（候选列表互不交叉，
    // 所以两个入口都要有）。两个都必须禁用：还没填 Base URL，
    // 点下去只会发出必然失败的请求。
    const buttons = await screen.findAllByRole('button', { name: '从上游获取模型' });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
  it('生图模型有自己独立的标签框，与对话模型互不干扰', async () => {
    // 两份清单分开存的界面表现：编辑已保存的供应商时，models 与 imageModels
    // 各渲染到自己的框里，不能混在一起（混了就会让图像模型出现在 Codex 的 /model 里）。
    const { render, screen } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { AuthProvider } = await import('../src/lib/auth');
    const { ProviderForm } = await import('../src/components/ProviderForm');

    render(
      <MemoryRouter>
        <AuthProvider>
          <ProviderForm
            provider={{
              ...providers[0],
              models: ['gpt-x'],
              imageModels: ['gpt-image-2'],
            }}
            onSaved={() => {}}
            onCancel={() => {}}
          />
        </AuthProvider>
      </MemoryRouter>,
    );

    // 两个框各自渲染自己的片段，移除按钮的 aria-label 也分开了
    expect(await screen.findByLabelText('移除模型 gpt-x')).toBeTruthy();
    expect(await screen.findByLabelText('移除生图模型 gpt-image-2')).toBeTruthy();
    // 对话模型的移除按钮不该指向生图模型，反之亦然
    expect(screen.queryByLabelText('移除模型 gpt-image-2')).toBeNull();
    expect(screen.queryByLabelText('移除生图模型 gpt-x')).toBeNull();
  });

  it('模型以标签片段呈现：可输入添加、点 × 移除', async () => {
    const { render, screen, fireEvent, within } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { AuthProvider } = await import('../src/lib/auth');
    const { ProviderForm } = await import('../src/components/ProviderForm');

    // 全局 afterEach 已经会 cleanup（见 test/setup.ts），但这里仍用 within(container)
    // 限定查询范围：ProviderForm 里有多个同名 label，限定作用域能让断言更明确地
    // 指向本次渲染的实例，不依赖"document 里恰好只有一份"这个前提。
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

  it('设置页切换界面语言会落盘并立即生效', async () => {
    // 语言偏好存服务端（不是 localStorage）：换浏览器/清缓存后仍应保持。
    // 这里同时钉住三件事：请求真的发出去了（PATCH + 正确 body）、界面立刻切换、
    // 下拉框的值来自服务端设置而不是写死的默认值。
    requests = [];
    const { render, screen, fireEvent, waitFor } = await import('@testing-library/react');
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

    // 等服务端身份（含 language: 'zh'）到位，下拉框才会是受控可用状态
    const select = (await screen.findByLabelText('界面语言')) as HTMLSelectElement;
    // 下拉框的值来自服务端设置（mock 的 me.language = 'zh'），不是写死的默认值
    expect(select.value).toBe('zh');

    fireEvent.change(select, { target: { value: 'en' } });

    // 界面立即切换（LanguageSelect 内部乐观 applyLanguage）
    expect(await screen.findByText('Interface language')).toBeTruthy();

    // 且真的落盘了：PATCH /api/settings/language，body 是 { language: 'en' }
    await waitFor(() => {
      const patched = requests.find(
        (item) => item.method === 'PATCH' && item.path === '/api/settings/language',
      );
      expect(patched).toBeDefined();
      expect(JSON.parse(patched!.body ?? '{}')).toEqual({ language: 'en' });
    });

    // 落盘后要重新拉一次身份：侧边栏那个选择器与这里共用服务端真源，
    // 不刷新就会出现"这里 English、侧边栏中文"。
    await waitFor(() => {
      const meCalls = requests.filter((item) => item.path === '/api/auth/me');
      expect(meCalls.length).toBeGreaterThan(1);
    });
    // 刷新后下拉框仍是新值（不能跳回旧值）
    await waitFor(() => expect(select.value).toBe('en'));

    setOverrides({});
    serverLanguage = 'zh';
  });

  it('请求带上界面语言，且错误里能拿到 messageKey', async () => {
    // 两件事一起钉：
    // 1) 前端必须把当前界面语言放进 Accept-Language，否则登录失败这类
    //    "还没读到租户设置"的报错会永远是中文，而界面已经是英文了；
    // 2) 错误对象要带 messageKey —— 服务端 message 已经按语言渲染好可以直接显示，
    //    但需要精确区分错误类型的代码不该去匹配会变的译文。
    requests = [];
    const { api, ApiError } = await import('../src/lib/api');
    const i18n = (await import('../src/i18n')).default;
    await i18n.changeLanguage('en');

    // 让 /api/providers 返回一个带 messageKey 的错误
    setOverrides({
      '/api/providers': {
        statusCode: 400,
        error: {
          code: 'bad_request',
          message: 'name must be a string',
          messageKey: 'providers.validation.nameType',
        },
      },
    });
    // 上面的 mock 只按路径返回，不区分 GET/POST；这里直接调一个会走该路径的写操作
    let caught: unknown = null;
    try {
      await api.createProvider({ name: '', apiType: 'openai', baseUrl: '', models: [] } as never);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as InstanceType<typeof ApiError>).messageKey).toBe(
      'providers.validation.nameType',
    );

    const sent = requests.find((item) => item.path === '/api/providers');
    expect(sent?.headers['accept-language']).toBe('en');

    setOverrides({});
    await i18n.changeLanguage('zh');
  });

  it('无 settings:write 时语言下拉只读', async () => {
    // member 只有 gateway:read：能看界面语言是什么，但不能改（保存会 403）。
    // 让它可点只会把 403 当成交互反馈。
    setOverrides({
      '/api/auth/me': {
        user: { id: 'u_member', tenantId: 't_default', role: 'member', username: 'member' },
        permissions: ['gateway:read'],
        allPermissions: ['gateway:read'],
        language: 'zh',
      },
      '/api/tokens': { tokens: [], availableScopes: ['gateway:read'] },
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

    const select = (await screen.findByLabelText('界面语言')) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    setOverrides({});
  });
});
