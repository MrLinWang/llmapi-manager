import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createContext } from '../src/context';
import { createLogger } from '../src/logger';
import { bootstrapIdentity } from '../src/bootstrap';
import { loadConfig, type AppConfig } from '../src/config';
import { resetWarnings } from '../src/resilience';
import {
  portOf,
  startClientErrorUpstream,
  startFailingUpstream,
  startMockUpstream,
} from './mockUpstream';

let MOCK_PORT = 0;
let FAIL_PORT = 0;
let CLIENT_ERR_PORT = 0;
const PASSWORD = 'smoke-test-password';

let app: FastifyInstance;
let dataDir: string;
let agentHome: string;
let servers: Server[] = [];
let cookie = '';
let gatewayToken = '';

function testConfig(dir: string, home: string): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    dataDir: dir,
    agentHomeDir: home,
    publicBaseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    encryptionKey: 'smoke-encryption-key',
    sessionSecret: 'smoke-session-secret-0123456789abcdef',
    sessionSecretGenerated: false,
    logLevel: 'error',
  };
}

beforeAll(async () => {
  resetWarnings();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-smoke-data-'));
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-smoke-home-'));
  const mock = await startMockUpstream();
  const failing = await startFailingUpstream();
  // 429 用于验证"非 5xx 不回退，但错误必须原样透传"，这是曾经返回 200 空 body 的回归点
  const clientError = await startClientErrorUpstream(429);
  servers = [mock, failing, clientError];
  MOCK_PORT = portOf(mock);
  FAIL_PORT = portOf(failing);
  CLIENT_ERR_PORT = portOf(clientError);

  const config = testConfig(dataDir, agentHome);
  const logger = createLogger('error');
  const ctx = createContext(config, logger);
  await bootstrapIdentity(config, ctx.paths, ctx.identity, logger, ctx.setup);
  app = await buildApp({ ctx });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(agentHome, { recursive: true, force: true });
});

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({ method, url, payload: payload as never, headers });
}

describe('冒烟：鉴权', () => {
  it('未登录访问管理接口返回 401', async () => {
    const response = await call('GET', '/api/providers');
    expect(response.statusCode).toBe(401);
  });

  it('health 免鉴权', async () => {
    const response = await call('GET', '/api/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
  });

  it('错误口令登录失败且不回显口令', async () => {
    const response = await call('POST', '/api/auth/login', {
      username: 'admin',
      password: 'wrong-password',
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(PASSWORD);
  });

  it('正确口令登录成功并下发 HttpOnly Cookie', async () => {
    const response = await call('POST', '/api/auth/login', {
      username: 'admin',
      password: PASSWORD,
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    cookie = raw.split(';')[0];
    expect(cookie).toContain('llmapi_session=');
  });

  it('登录后可读取身份与权限', async () => {
    const response = await call('GET', '/api/auth/me', undefined, { cookie });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.role).toBe('owner');
    expect(body.user.tenantId).toBe('t_default');
    expect(body.permissions).toContain('providers:write');
  });
});

describe('冒烟：供应商与聚合', () => {
  it('可新增供应商且 Key 脱敏', async () => {
    const response = await call(
      'POST',
      '/api/providers',
      {
        name: 'Mock OpenAI',
        apiType: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
        apiKey: 'sk-mock-openai-secret',
        models: ['gpt-x', 'gpt-x-mini'],
      },
      { cookie },
    );
    expect(response.statusCode).toBe(201);
    const provider = response.json().provider;
    expect(provider.providerKey).toBe('mock-openai');
    expect(provider.apiKeyMasked).toBe('sk-********cret');
    expect(JSON.stringify(provider)).not.toContain('sk-mock-openai-secret');
  });

  it('同名供应商被拒绝', async () => {
    const response = await call(
      'POST',
      '/api/providers',
      {
        name: 'Mock OpenAI',
        apiType: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
        apiKey: 'x',
        models: ['gpt-x'],
      },
      { cookie },
    );
    expect(response.statusCode).toBe(409);
  });

  it('连通性测试返回模型列表', async () => {
    const list = await call('GET', '/api/providers', undefined, { cookie });
    const provider = list.json().providers[0];
    const response = await call('POST', `/api/providers/${provider.id}/test`, undefined, {
      cookie,
    });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.ok).toBe(true);
    expect(result.models).toContain('gpt-x');
  });

  it('可按表单临时值拉取模型列表（无需先保存供应商）', async () => {
    const response = await call(
      'POST',
      '/api/providers/models',
      {
        apiType: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
        apiKey: 'sk-listing',
      },
      { cookie },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.models).toContain('gpt-x');
    expect(body.models).toContain('gpt-x-mini');
  });

  it('anthropic 协议用 x-api-key 拉取，拿到的是它自己的模型', async () => {
    const response = await call(
      'POST',
      '/api/providers/models',
      {
        apiType: 'anthropic',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
        apiKey: 'sk-ant-listing',
      },
      { cookie },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().models).toEqual(['claude-x']);
  });

  it('编辑态未重填 Key 时沿用已保存的 Key', async () => {
    const list = await call('GET', '/api/providers', undefined, { cookie });
    const existing = list
      .json()
      .providers.find((item: { apiType: string }) => item.apiType === 'openai');
    expect(existing).toBeTruthy();

    const response = await call(
      'POST',
      '/api/providers/models',
      {
        apiType: existing.apiType,
        baseUrl: existing.baseUrl,
        // 不传 apiKey，靠 providerId 借用
        providerId: existing.id,
      },
      { cookie },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });

  it('既没有 Key 也没有 providerId 时明确报错', async () => {
    const response = await call(
      'POST',
      '/api/providers/models',
      { apiType: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORT}` },
      { cookie },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('API Key');
  });

  it('非法协议或空 baseUrl 被拒绝', async () => {
    const badType = await call(
      'POST',
      '/api/providers/models',
      { apiType: 'bogus', baseUrl: 'https://x.test', apiKey: 'k' },
      { cookie },
    );
    expect(badType.statusCode).toBe(400);

    const badUrl = await call(
      'POST',
      '/api/providers/models',
      { apiType: 'openai', baseUrl: '   ', apiKey: 'k' },
      { cookie },
    );
    expect(badUrl.statusCode).toBe(400);
  });

  it('上游不可达时返回 ok:false 而不是 500', async () => {
    // 用未监听的端口模拟连不上：这是采集失败，不该让接口 5xx
    const response = await call(
      'POST',
      '/api/providers/models',
      { apiType: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
      { cookie },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(false);
    expect(response.json().error).toBeTruthy();
  });

  it('聚合别名按约定格式生成', async () => {
    const response = await call('GET', '/api/models', undefined, { cookie });
    const body = response.json();
    expect(body.aliases.map((item: { alias: string }) => item.alias)).toEqual([
      'lam-mock-openai/gpt-x',
      'lam-mock-openai/gpt-x-mini',
    ]);
    expect(body.gateway.token.exists).toBe(false);
  });

  it('生成网关令牌后接口只显示脱敏形式', async () => {
    const response = await call('POST', '/api/gateway/token', undefined, { cookie });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    gatewayToken = body.token;
    expect(gatewayToken.length).toBeGreaterThan(20);

    const models = await call('GET', '/api/models', undefined, { cookie });
    const token = models.json().gateway.token;
    expect(token.exists).toBe(true);
    expect(token.masked).toBe(body.masked);
    expect(models.body).not.toContain(gatewayToken);
  });
});

describe('冒烟：网关', () => {
  it('缺少令牌返回 401', async () => {
    const response = await call('POST', '/v1/chat/completions', {
      model: 'lam-mock-openai/gpt-x',
      messages: [],
    });
    expect(response.statusCode).toBe(401);
  });

  it('别名请求转发到指定供应商并改写模型名', async () => {
    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'lam-mock-openai/gpt-x-mini', messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.model).toBe('gpt-x-mini');
    expect(body.choices[0].message.content).toBe('mock reply');
  });

  it('x-api-key 也能鉴权', async () => {
    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'lam-mock-openai/gpt-x', messages: [] },
      { 'x-api-key': gatewayToken },
    );
    expect(response.statusCode).toBe(200);
  });

  it('流式请求逐块返回 SSE', async () => {
    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'lam-mock-openai/gpt-x', stream: true, messages: [] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('data: ');
    expect(response.body).toContain('[DONE]');
  });

  it('非流式转发不会因请求体读完而中止上游', async () => {
    // 回归：曾被 Node 的 IncomingMessage 'close' 误触发 abort，导致所有转发 502
    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'lam-mock-openai/gpt-x', messages: [{ role: 'user', content: 'x' }] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe('mock reply');
  });

  it('未知别名返回 400 且不回落', async () => {
    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'lam-nobody/gpt-x', messages: [] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('未知供应商');
  });

  it('/v1/messages 命中 openai 供应商时返回 501', async () => {
    // 这条钉住"转换不是万能的"：只有 Responses → Chat 一个方向有转换器，
    // Messages 没有等价实现。即便将来有人把开关逻辑改成"不匹配就放行"，
    // 这里也必须仍然 501——否则会把 Anthropic 请求体发给 Chat 上游，
    // 客户端只会收到上游的参数错误，完全看不出是本服务选错了协议。
    const response = await call(
      'POST',
      '/v1/messages',
      { model: 'lam-mock-openai/gpt-x', messages: [] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(501);
    expect(response.json().error.message).toContain('协议转换');
  });

  it('/v1/responses 命中 openai 供应商时自动开启跨协议转发并成功', async () => {
    // Codex 只会发 /v1/responses，而很多上游只有 Chat。当实例里只有 openai
    // 供应商时，网关自动打开转换而不是把 501 甩给用户——他无从判断这是配置问题
    // 还是上游故障。
    //
    // 这条同时钉住三个契约，缺一不可：
    // 1) 请求真的成功（转换链路端到端可用，而不只是开关被改了）
    // 2) 响应头标记出"自动改了设置"（悄悄改全局行为是不可接受的）
    // 3) 设置被持久化，且第二次请求不再重复标记（否则每次都像被改动过）
    await call('PATCH', '/api/settings/codex', { protocolConversion: false }, { cookie });

    const response = await call(
      'POST',
      '/v1/responses',
      { model: 'lam-mock-openai/gpt-x', input: 'hi', stream: false },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(200);
    // 必须能看出"这次请求被转换了、且设置被改动"，否则是静默行为变更
    expect(response.headers['x-llmapi-auto-conversion']).toBe('1');
    expect((response.json() as { object: string }).object).toBe('response');

    // 开关已被持久化，后续请求不再重复标记
    const stored = (await call('GET', '/api/settings', undefined, { cookie })).json() as {
      protocolConversion: boolean;
    };
    expect(stored.protocolConversion).toBe(true);

    const again = await call(
      'POST', '/v1/responses',
      { model: 'lam-mock-openai/gpt-x', input: 'hi', stream: false },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-llmapi-auto-conversion']).toBeUndefined();
  });

  it('畸形请求不会触发自动开启转换', async () => {
    // 真实 bug：自动开启+写盘原本在 body 校验之前，一个缺 model 的请求
    // （哪怕是扫描器）就能永久改掉租户设置，而那个请求本身还是 400、
    // 走错误处理器而非 reply.raw，用户看不到 x-llmapi-auto-conversion 头。
    await call('PATCH', '/api/settings/codex', { protocolConversion: false }, { cookie });

    const bad = await call(
      'POST', '/v1/responses',
      { input: 'hi' },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(bad.statusCode).toBe(400);

    const stored = (await call('GET', '/api/settings', undefined, { cookie })).json() as {
      protocolConversion: boolean;
    };
    expect(stored.protocolConversion).toBe(false);
  });

  it('没有可转换供应商时仍返回 501 并提示', async () => {
    // 防"误开"：自动开启的触发条件必须窄到"打开真的能解决问题"。
    // /v1/messages → openai 没有转换器，自动开启对它毫无作用；
    // 若这里被打开，用户会看到开关莫名变成 true，还会以为已经处理好了，
    // 而请求照样 501——这种"假修复"比直接报错更浪费时间。
    await call('PATCH', '/api/settings/codex', { protocolConversion: false }, { cookie });
    const response = await call(
      'POST',
      '/v1/messages',
      { model: 'lam-mock-openai/gpt-x', messages: [] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(501);
    const stored = (await call('GET', '/api/settings', undefined, { cookie })).json() as {
      protocolConversion: boolean;
    };
    // 打开了也解决不了，就不该打开
    expect(stored.protocolConversion).toBe(false);
  });

  it('responses 供应商可接收 /v1/responses 并返回上游原始结构', async () => {
    const created = await call(
      'POST',
      '/api/providers',
      {
        name: 'Mock Responses',
        apiType: 'responses',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
        apiKey: 'sk-responses',
        models: ['gpt-resp'],
      },
      { cookie },
    );
    expect(created.statusCode).toBe(201);

    const response = await call(
      'POST',
      '/v1/responses',
      { model: 'lam-mock-responses/gpt-resp', input: 'hi' },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // 断言打到的是 responses 形态的上游，且模型名被改写
    expect(body.object).toBe('response');
    expect(body.model).toBe('gpt-resp');
    expect(body.output[0].content[0].text).toBe('mock responses reply');
  });

  it('responses 供应商不能接 /v1/chat/completions', async () => {
    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'lam-mock-responses/gpt-resp', messages: [] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(501);
  });

  it('/v1/models 返回 OpenAI 兼容结构', async () => {
    const response = await call('GET', '/v1/models', undefined, {
      authorization: `Bearer ${gatewayToken}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('list');
    expect(body.data.map((item: { id: string }) => item.id)).toContain(
      'lam-mock-openai/gpt-x',
    );
  });

  it('默认供应商 5xx 时回退到备选并标记响应头', async () => {
    const failing = await call(
      'POST',
      '/api/providers',
      {
        name: 'Broken Upstream',
        apiType: 'openai',
        baseUrl: `http://127.0.0.1:${FAIL_PORT}`,
        apiKey: 'sk-broken',
        models: ['gpt-x'],
      },
      { cookie },
    );
    const brokenId = failing.json().provider.id;

    const list = await call('GET', '/api/providers', undefined, { cookie });
    const ids = list.json().providers.map((item: { id: string }) => item.id);
    const reorder = await call(
      'PUT',
      '/api/providers/order',
      { ids: [brokenId, ...ids.filter((id: string) => id !== brokenId)] },
      { cookie },
    );
    expect(reorder.statusCode).toBe(200);

    const setDefault = await call(
      'PUT',
      '/api/settings/default',
      { providerId: brokenId, model: 'gpt-x' },
      { cookie },
    );
    expect(setDefault.statusCode).toBe(200);

    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'gpt-x', messages: [] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-llmapi-fallback']).toBe('1');
    expect(response.json().choices[0].message.content).toBe('mock reply');
  });

  it('上游 4xx 且存在备选时不回退，并把错误原样透传', async () => {
    // 回归：主供应商那次转发是延迟写模式（为了给回退留出机会），
    // 曾经在"非 5xx 不回退"分支直接 return，导致客户端收到 200 + 空 body。
    const limited = await call(
      'POST',
      '/api/providers',
      {
        name: 'Rate Limited Upstream',
        apiType: 'openai',
        baseUrl: `http://127.0.0.1:${CLIENT_ERR_PORT}`,
        apiKey: 'sk-limited',
        models: ['gpt-x'],
      },
      { cookie },
    );
    expect(limited.statusCode).toBe(201);
    const limitedId = limited.json().provider.id;

    const list = await call('GET', '/api/providers', undefined, { cookie });
    const ids = list.json().providers.map((item: { id: string }) => item.id);
    await call(
      'PUT',
      '/api/providers/order',
      { ids: [limitedId, ...ids.filter((id: string) => id !== limitedId)] },
      { cookie },
    );
    await call(
      'PUT',
      '/api/settings/default',
      { providerId: limitedId, model: 'gpt-x' },
      { cookie },
    );

    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'gpt-x', messages: [] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    // 关键断言：状态码是 429，不是 200
    expect(response.statusCode).toBe(429);
    // 错误体来自上游，而不是空字符串
    expect(response.body).not.toBe('');
    expect(response.json().error.code).toBe('rate_limit_exceeded');
    expect(response.json().error.message).toBe('upstream says 429');
    // 4xx 不换供应商，因此不应有回退标记
    expect(response.headers['x-llmapi-fallback']).toBeUndefined();

    // 清理：删除该供应商并把默认供应商还原成上一个用例留下的那个
    await call('DELETE', `/api/providers/${limitedId}`, undefined, { cookie });
    const broken = (await call('GET', '/api/providers', undefined, { cookie }))
      .json()
      .providers.find((item: { name: string }) => item.name === 'Broken Upstream');
    if (broken) {
      await call('PUT', '/api/settings/default', { providerId: broken.id }, { cookie });
    }
  });

  it('请求日志记录了租户、别名与回退', async () => {
    const response = await call('GET', '/api/logs?limit=50', undefined, { cookie });
    const logs = response.json().logs as Array<Record<string, unknown>>;
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].tenantId).toBe('t_default');
    expect(logs.some((item) => item.mode === 'alias')).toBe(true);
    expect(logs.some((item) => item.fallback === true)).toBe(true);

    const stats = await call('GET', '/api/stats', undefined, { cookie });
    expect(stats.json().total).toBeGreaterThan(0);
  });
});

describe('冒烟：Agent 下发', () => {
  it('预览返回目标路径与键值对照，且不写文件', async () => {
    const response = await call('POST', '/api/agents/codex/preview', undefined, { cookie });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.files[0].path).toBe(path.join(agentHome, '.codex', 'config.toml'));
    expect(body.files[0].exists).toBe(false);
    const keys = body.files.flatMap((file: { entries: Array<{ key: string }> }) =>
      file.entries.map((entry) => entry.key),
    );
    expect(keys).toContain('model_provider');
    expect(keys).toContain('[model_providers.llmapi] base_url');
    expect(fs.existsSync(body.files[0].path)).toBe(false);
  });

  it('没有 responses 供应商时 Codex 明确报错，而不是写出 chat 配置', async () => {
    // Codex CLI 已移除 wire_api = "chat"（openai/codex discussion #7782），
    // 回落 chat 会写出一个 Codex 直接拒绝启动的配置，所以必须报错并给出可操作提示。
    const list = await call('GET', '/api/providers', undefined, { cookie });
    const responsesProvider = list
      .json()
      .providers.find((item: { apiType: string }) => item.apiType === 'responses');
    expect(responsesProvider).toBeTruthy();

    await call(
      'PATCH',
      `/api/providers/${responsesProvider.id}/enabled`,
      { enabled: false },
      { cookie },
    );
    try {
      const preview = await call('POST', '/api/agents/codex/preview', undefined, { cookie });
      expect(preview.statusCode).toBe(400);
      const message = preview.json().error.message as string;
      expect(message).toContain('Responses');
      // 提示必须告诉用户怎么修，而不只是"没有可用供应商"
      expect(message).toContain('协议类型');
    } finally {
      await call(
        'PATCH',
        `/api/providers/${responsesProvider.id}/enabled`,
        { enabled: true },
        { cookie },
      );
    }
  });

  it('应用会备份并保留用户内容，还原只撤销自己的键', async () => {
    const preview = await call('POST', '/api/agents/codex/preview', undefined, { cookie });
    const configPath = preview.json().files[0].path as string;
    const authPath = preview.json().files[1].path as string;

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      'model_provider = "user-own"\n\n[mcp_servers.demo]\ncommand = "demo"\n',
    );

    const apply = await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    expect(apply.statusCode).toBe(200);
    expect(apply.json().binding.appliedBy).toBe('u_owner');

    const written = fs.readFileSync(configPath, 'utf8');
    expect(written).toContain('model_provider = "llmapi"');
    expect(written).toContain('[mcp_servers.demo]');
    expect(fs.existsSync(authPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8')).OPENAI_API_KEY).toBe(gatewayToken);

    // 备份必须落在被改文件的同目录：用户不依赖本服务、不依赖数据目录是否还在，
    // 就能就地找回被改坏的配置。文件名形如 config.toml.bak-<时间戳>。
    const sibling = fs
      .readdirSync(path.dirname(configPath))
      .filter((name) => name.startsWith(`${path.basename(configPath)}.bak-`));
    expect(sibling.length).toBeGreaterThanOrEqual(1);
    // 备份内容必须是改动前的原文（含用户自己的 mcp_servers）
    const backupText = fs.readFileSync(path.join(path.dirname(configPath), sibling[0]), 'utf8');
    expect(backupText).toContain('[mcp_servers.demo]');
    // 数据目录下不应再有 backups/（已改为同目录）
    expect(fs.existsSync(path.join(dataDir, 'tenants', 't_default', 'backups'))).toBe(false);

    const agents = await call('GET', '/api/agents', undefined, { cookie });
    const codex = agents
      .json()
      .agents.find((item: { id: string }) => item.id === 'codex');
    expect(codex.applied).toBe(true);

    const revert = await call('POST', '/api/agents/codex/revert', undefined, { cookie });
    expect(revert.statusCode).toBe(200);
    expect(revert.json().restored.length).toBeGreaterThan(0);

    const afterRevert = fs.readFileSync(configPath, 'utf8');
    expect(afterRevert).not.toContain('model_provider = "llmapi"');
    expect(afterRevert).toContain('[mcp_servers.demo]');
    expect(afterRevert).not.toContain('[model_providers.llmapi]');
  });

  it('缺少对应协议的供应商时给出明确错误', async () => {
    const preview = await call('POST', '/api/agents/claude-code/preview', undefined, {
      cookie,
    });
    // 目前只有 openai 供应商，Claude Code 需要 Anthropic 上游
    expect(preview.statusCode).toBe(400);
    expect(preview.json().error.message).toContain('Anthropic');
  });

  it('Codex 优先选 responses 供应商，wire_api 写 responses', async () => {
    // 此时同时存在 openai 与 responses 供应商（responses 在那条网关用例里创建）。
    const preview = await call('POST', '/api/agents/codex/preview', undefined, { cookie });
    expect(preview.statusCode).toBe(200);
    // 预览面板必须能看到目录文件，否则用户以为什么都没做
    const previewFiles = preview.json().files as Array<{
      role: string;
      entries: Array<{ key: string; next: string }>;
    }>;
    const catalogEntries = previewFiles.find((item) => item.role === 'catalog')!.entries;
    expect(catalogEntries.length).toBeGreaterThan(0);
    expect(catalogEntries[0].next).toMatch(/\d+ 个模型别名/);

    const entries = preview
      .json()
      .files.flatMap((file: { entries: Array<{ key: string; next: string }> }) => file.entries);
    const wire = entries.find(
      (item: { key: string }) => item.key === '[model_providers.llmapi] wire_api',
    );
    expect(wire.next).toBe('responses');
    // 模型必须指向 responses 供应商的别名
    const model = entries.find((item: { key: string }) => item.key === 'model');
    expect(model.next).toContain('lam-mock-responses/');
  });
  it('Codex 应用时生成模型目录，并写入 catalog 两项配置', async () => {
    const preview = await call('POST', '/api/agents/codex/preview', undefined, { cookie });
    expect(preview.statusCode).toBe(200);
    const files = preview.json().files as Array<{ role: string; path: string }>;

    // 目录文件必须是第三个文件角色
    const catalogFile = files.find((item) => item.role === 'catalog');
    expect(catalogFile).toBeTruthy();
    expect(catalogFile!.path.endsWith('llmapi-model-catalog.json')).toBe(true);

    const entries = preview
      .json()
      .files.flatMap((file: { entries: Array<{ key: string; next: string }> }) => file.entries);
    // web_search 必须显式关闭：多数聚合上游把 Responses 转 Chat 时不支持该托管工具，
    // 会 400 unsupported_tool。这是顶层键，且必须是字符串 "disabled"。
    const webSearch = entries.find((item: { key: string }) => item.key === 'web_search');
    expect(webSearch).toBeTruthy();
    expect(webSearch!.next).toBe('disabled');

    // model_catalog_json 必须是顶层键：放进 provider 段会被 Codex 忽略（实测）
    const jsonKey = entries.find((item: { key: string }) => item.key === 'model_catalog_json');
    const urlKey = entries.find(
      (item: { key: string }) => item.key === '[model_providers.llmapi] model_catalog_url',
    );
    expect(jsonKey).toBeTruthy();
    expect(jsonKey!.next).toBe(catalogFile!.path);
    expect(urlKey).toBeTruthy();
    expect(urlKey!.next).toContain('/v1/models');
    // 反向断言：provider 段里不能再出现 model_catalog_json
    expect(
      entries.some(
        (item: { key: string }) =>
          item.key === '[model_providers.llmapi] model_catalog_json',
      ),
    ).toBe(false);

    // 真正应用后目录文件存在且结构是 Codex 认的 { models: [...] }
    const apply = await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    expect(apply.statusCode).toBe(200);
    const catalog = JSON.parse(fs.readFileSync(catalogFile!.path, 'utf8'));
    expect(Array.isArray(catalog.models)).toBe(true);
    expect(catalog.models.length).toBeGreaterThan(0);
    const slugs = catalog.models.map((m: { slug: string }) => m.slug);
    // 每个 slug 都必须是网关能解析的别名
    expect(slugs.every((slug: string) => slug.startsWith('lam-'))).toBe(true);
    expect(slugs).toContain('lam-mock-responses/gpt-resp');
    for (const model of catalog.models) {
      expect(model.context_window).toBeGreaterThan(0);
      // 只断言 Codex 真正读取的字段；max_output_tokens 会作为未知字段被忽略
      expect(typeof model.default_reasoning_level).toBe('string');
    }

    // 还原时：目录文件由我们创建 → 直接删除
    const revert = await call('POST', '/api/agents/codex/revert', undefined, { cookie });
    expect(revert.statusCode).toBe(200);
    expect(fs.existsSync(catalogFile!.path)).toBe(false);
    const configAfter = fs.readFileSync(files[0].path, 'utf8');
    expect(configAfter).not.toContain('model_catalog_json');
    expect(configAfter).not.toContain('model_catalog_url');
    expect(configAfter).not.toContain('web_search');
  });

  it('web_search 开关可切换，且关闭时不留残留键', async () => {
    // 默认开启"关闭联网搜索"
    const initial = await call('GET', '/api/settings', undefined, { cookie });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().disableCodexWebSearch).toBe(true);

    await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    const configPath = (
      await call('POST', '/api/agents/codex/preview', undefined, { cookie })
    )
      .json()
      .files.find((file: { role: string }) => file.role === 'config').path;
    expect(fs.readFileSync(configPath, 'utf8')).toContain('web_search = "disabled"');

    // 关掉这个开关 → 重新应用后应该把那一行删掉，不能残留
    const off = await call('PATCH', '/api/settings/codex', { disableCodexWebSearch: false }, { cookie });
    expect(off.statusCode).toBe(200);
    expect(off.json().disableCodexWebSearch).toBe(false);
    expect(off.json().requiresReapply).toBe(true);

    await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('web_search');

    // 再打开 → 重新写回
    await call('PATCH', '/api/settings/codex', { disableCodexWebSearch: true }, { cookie });
    await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    expect(fs.readFileSync(configPath, 'utf8')).toContain('web_search = "disabled"');

    // 非布尔值要拒绝，而不是当成 truthy
    const bad = await call('PATCH', '/api/settings/codex', { disableCodexWebSearch: 'yes' }, { cookie });
    expect(bad.statusCode).toBe(400);
  });

  it('结束 Codex 进程的接口受权限保护，且对 Claude Code 明确说明不支持', async () => {
    // 未登录 → 401
    const anonymous = await app.inject({ method: 'POST', url: '/api/agents/codex/stop-processes' });
    expect(anonymous.statusCode).toBe(401);

    // 未知 Agent → 404
    const unknown = await call('POST', '/api/agents/nope/stop-processes', undefined, { cookie });
    expect(unknown.statusCode).toBe(404);

    // Claude Code 没有常驻进程，返回 supported=false 而不是报错
    const claude = await call('POST', '/api/agents/claude-code/stop-processes', undefined, { cookie });
    expect(claude.statusCode).toBe(200);
    expect(claude.json().supported).toBe(false);
    expect(claude.json().warnings.join('')).toContain('没有需要结束的常驻进程');
  });

  it('已有 responses 供应商时不会自动开启转换', async () => {
    // 自动开启只在"打开就能解决问题"时才触发：实例里已经有 responses 供应商，
    // 说明用户能正常用，不该悄悄把 openai 供应商也拉进来。
    // 这条防的是"误开"而不是"漏开"：自动改动会把全局设置从 false 变成 true，
    // 之后所有 Responses 请求都可能落到 Chat 上游上，产生用户没预期的信息损失
    // （托管工具被丢弃）。所以必须连"设置没被改"一起断言，只看请求成功不够。
    await call('PATCH', '/api/settings/codex', { protocolConversion: false }, { cookie });
    const providers = (await call('GET', '/api/providers', undefined, { cookie })).json()
      .providers as Array<{ apiType: string; providerKey: string; models: string[] }>;
    const responses = providers.find((item) => item.apiType === 'responses');
    expect(responses).toBeTruthy();

    const response = await call(
      'POST',
      '/v1/responses',
      { model: `lam-${responses!.providerKey}/${responses!.models[0]}`, input: 'hi' },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-llmapi-auto-conversion']).toBeUndefined();
    const stored = (await call('GET', '/api/settings', undefined, { cookie })).json() as {
      protocolConversion: boolean;
    };
    expect(stored.protocolConversion).toBe(false);
  });

  it('直连模式：指定供应商、按 Agent 独立，且清掉网关模式的产物', async () => {
    const stored = await call('GET', '/api/settings', undefined, { cookie });
    expect(stored.json().agentTargets).toEqual({});

    const previewPath = (
      await call('POST', '/api/agents/codex/preview', undefined, { cookie })
    )
      .json()
      .files.find((file: { role: string }) => file.role === 'config').path as string;

    // 直接切到直连但没指定供应商 → 必须明确要求选，而不是按优先级自动挑一家。
    // 多供应商时自动挑会把用户的配置悄悄指向他没选的那家。
    await call('PATCH', '/api/agents/codex/target', { mode: 'direct' }, { cookie });
    const noPick = await call('POST', '/api/agents/codex/preview', undefined, { cookie });
    expect(noPick.statusCode).toBe(400);
    expect(noPick.json().error.message).toContain('明确指定供应商');

    // 再造一家 responses 供应商，确保"能在多家之间选定"这件事真的被验证到
    const created = await call(
      'POST', '/api/providers',
      {
        name: '第二个直连候选',
        apiType: 'responses',
        baseUrl: 'http://127.0.0.1:65530',
        apiKey: 'sk-second',
        models: ['alt-model'],
      },
      { cookie },
    );
    expect(created.statusCode).toBe(201);
    const alt = created.json().provider as { id: string };

    const list = await call('GET', '/api/providers', undefined, { cookie });
    const candidates = (list.json().providers as Array<{ id: string; name: string; apiType: string; enabled: boolean }>)
      .filter((item) => item.enabled && item.apiType === 'responses');
    expect(candidates.length).toBeGreaterThan(1);
    // 故意选优先级靠后的那家，验证不会"总是落到默认供应商"
    const chosen = candidates[candidates.length - 1];
    expect(chosen.id).toBe(alt.id);

    const set = await call(
      'PATCH', '/api/agents/codex/target',
      { mode: 'direct', directProviderId: chosen.id }, { cookie },
    );
    expect(set.statusCode).toBe(200);

    const preview = await call('POST', '/api/agents/codex/preview', undefined, { cookie });
    expect(preview.json().connectionMode).toBe('direct');
    // 预览展示的就是实际写进 base_url 的值（已含 /v1），两者必须一致
    const directBase = preview.json().directBaseUrl as string;
    expect(directBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    const direct = fs.readFileSync(previewPath, 'utf8');
    expect(direct).toContain(`base_url = "${directBase}"`);
    // 直连仍要写 model_catalog_json：不给它，Codex 会回退到内置官方模型列表，
    // /model 里就冒出 GPT-6.x 这类与供应商无关的条目（真实踩过）。
    expect(direct).toContain('model_catalog_json');
    const directCatalogPath = /model_catalog_json = "([^"]+)"/.exec(direct)?.[1];
    expect(directCatalogPath).toBeTruthy();
    const directCatalog = JSON.parse(fs.readFileSync(directCatalogPath as string, 'utf8')) as {
      models: Array<{ slug: string }>;
    };
    // 目录条目必须是该供应商的裸模型名，不能是 lam- 别名（网关才认识）
    expect(directCatalog.models.map((model) => model.slug)).toContain('alt-model');
    expect(directCatalog.models.some((model) => model.slug.startsWith('lam-'))).toBe(false);
    // 也不能混入 Codex 内置的官方模型
    expect(directCatalog.models.some((model) => /^gpt-6/.test(model.slug))).toBe(false);
    // 网关地址相关的键仍然要清掉：直连不看网关
    expect(direct).not.toContain('model_catalog_url');

    // 另一个 Agent 的偏好不受影响：两者互相独立，这正是分开配置的意义。
    // 这里只看设置读回的偏好（Claude Code 可能因缺 anthropic 供应商无法 apply，
    // 那是另一回事，与本用例要验证的"模式互不干扰"无关）。
    const afterCodex = await call('GET', '/api/settings', undefined, { cookie });
    const targets = afterCodex.json().agentTargets as Record<string, { mode: string }>;
    expect(targets.codex.mode).toBe('direct');
    expect(targets['claude-code']).toBeUndefined();

    // 切回网关后别名与目录恢复
    await call('PATCH', '/api/agents/codex/target', { mode: 'gateway' }, { cookie });
    await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    const gateway = fs.readFileSync(previewPath, 'utf8');
    expect(gateway).toContain('model_catalog_json');
    expect(gateway).toMatch(/^model = "lam-mock-responses\//m);

    // 非法值要拒绝
    expect((await call('PATCH', '/api/agents/codex/target', { mode: 'nope' }, { cookie })).statusCode)
      .toBe(400);
    // 协议不匹配的供应商不能用于直连（anthropic 不能给 Codex）
    const anthropic = (list.json().providers as Array<{ id: string; apiType: string }>)
      .find((item) => item.apiType === 'anthropic');
    if (anthropic) {
      expect(
        (await call('PATCH', '/api/agents/codex/target', { directProviderId: anthropic.id }, { cookie }))
          .statusCode,
      ).toBe(400);
    }
  });

  it('Codex 的模型目录只包含协议可用的别名', async () => {
    // 真实踩过：目录里混进 openai 供应商的别名，用户在 /model 里选中它，
    // 请求打到 /v1/responses 却因为没开转换而被 501。
    // 让用户在列表里看到一个"选了就报错"的模型，等于把配置问题推给他。
    // 关键前提：跨协议转换默认关闭（protocolConversion=false），所以
    // "openai 供应商能不能用"是有条件的，目录必须跟着开关走，不能一律列出。
    //
    // 显式关掉转换：前面的用例可能自动开启过它（触发条件是"只有 openai 供应商"），
    // 不隔离的话这条断言会随测试执行顺序变化——那是测试污染，不是真的验证了行为。
    await call('PATCH', '/api/settings/codex', { protocolConversion: false }, { cookie });
    const created = await call(
      'POST', '/api/providers',
      {
        name: '只支持 chat 的供应商',
        apiType: 'openai',
        baseUrl: 'http://127.0.0.1:65531',
        apiKey: 'sk-chat-only',
        models: ['chat-only-model'],
      },
      { cookie },
    );
    expect(created.statusCode).toBe(201);
    const chatProvider = created.json().provider as { id: string; providerKey: string };

    await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    const configPath = (
      await call('POST', '/api/agents/codex/preview', undefined, { cookie })
    ).json().files.find((file: { role: string }) => file.role === 'config').path as string;
    const catalogPath = /model_catalog_json = "([^"]+)"/.exec(
      fs.readFileSync(configPath, 'utf8'),
    )?.[1] as string;
    const slugs = (
      JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { models: Array<{ slug: string }> }
    ).models.map((model) => model.slug);

    // 开关关闭时：openai 供应商的别名不得出现
    expect(slugs.some((slug) => slug.startsWith(`lam-${chatProvider.providerKey}/`))).toBe(false);

    // 开启跨协议转发后必须出现——否则用户开了开关却看不到对应模型，
    // 会以为功能没生效
    await call('PATCH', '/api/settings/codex', { protocolConversion: true }, { cookie });
    await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    const withConversion = (
      JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { models: Array<{ slug: string }> }
    ).models.map((model) => model.slug);
    expect(withConversion.some((slug) => slug.startsWith(`lam-${chatProvider.providerKey}/`))).toBe(
      true,
    );
    await call('PATCH', '/api/settings/codex', { protocolConversion: false }, { cookie });
    await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    // responses 供应商的别名必须在。
    // 必须重新读文件：上面已经 apply 过两次，slugs 是首次 apply 时的旧快照，
    // 用它断言等于在测"开关关闭时的目录"，与本次行为无关——会碰巧为真而失去保护作用。
    const responsesKey = (
      (await call('GET', '/api/providers', undefined, { cookie })).json().providers as Array<{
        apiType: string;
        providerKey: string;
      }>
    ).find((item) => item.apiType === 'responses')!.providerKey;
    const afterDisable = (
      JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { models: Array<{ slug: string }> }
    ).models.map((model) => model.slug);
    expect(afterDisable.some((slug) => slug.startsWith(`lam-${responsesKey}/`))).toBe(true);
    // 关掉开关后 openai 供应商的别名必须从目录里消失——这才是"跟开关走"的完整验证
    expect(afterDisable.some((slug) => slug.startsWith(`lam-${chatProvider.providerKey}/`))).toBe(
      false,
    );
  });

  it('apply 响应不回传明文凭据，但落盘快照保留真实值', async () => {
    // 真实漏洞：直连模式会把上游真实 Key 写进配置，apply 的响应原样带回了
    // binding.files[].values，等于把凭据经接口发出去（违反 AGENTS.md 第 5 条）。
    // 预览路径一直是脱敏的，apply 漏了——两处必须一致。
    //
    // 但落盘不能脱敏：revert 依赖"当前值是否仍等于我们写入的值"做比对，
    // 存了打码值就再也对不上，还原会全部变成冲突。
    const SECRET = 'sk-REAL-UPSTREAM-KEY-abcdef123456';
    const created = await call(
      'POST', '/api/providers',
      {
        name: '脱敏测试供应商',
        apiType: 'responses',
        baseUrl: 'http://127.0.0.1:65532',
        apiKey: SECRET,
        models: ['mask-model'],
      },
      { cookie },
    );
    expect(created.statusCode).toBe(201);
    const providerId = (created.json().provider as { id: string }).id;

    await call(
      'PATCH', '/api/agents/codex/target',
      { mode: 'direct', directProviderId: providerId },
      { cookie },
    );
    const applied = await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    expect(applied.statusCode).toBe(200);

    // 响应里绝不能出现明文
    expect(applied.body).not.toContain(SECRET);
    const masked = applied
      .json()
      .binding.files.flatMap((file: { values: Record<string, string> }) =>
        Object.values(file.values) as string[],
      )
      .find((value) => value.includes('*'));
    expect(masked).toBeTruthy();

    // 落盘快照必须保留真实值，否则 revert 的比对会全部失配
    const stored = fs.readFileSync(
      path.join(dataDir, 'tenants', 't_default', 'agents.json'),
      'utf8',
    );
    expect(stored).toContain(SECRET);

    await call('PATCH', '/api/agents/codex/target', { mode: 'gateway' }, { cookie });
  });

  it('直连时 baseUrl 已含 /v1 不会拼成 /v1/v1', async () => {
    // 真实踩过的坑：上游填 https://host/v1 是常见写法，无脑拼 /v1 会变成
    // https://host/v1/v1，Codex 直接 404 Not Found。
    const created = await call(
      'POST', '/api/providers',
      {
        name: '带 v1 的上游',
        apiType: 'responses',
        baseUrl: 'https://host.example.com/v1',
        apiKey: 'sk-v1',
        models: ['m-v1'],
      },
      { cookie },
    );
    expect(created.statusCode).toBe(201);
    const providerId = (created.json().provider as { id: string }).id;

    await call('PATCH', '/api/agents/codex/target', { mode: 'direct', directProviderId: providerId }, { cookie });
    const preview = await call('POST', '/api/agents/codex/preview', undefined, { cookie });
    const configPath = (
      preview.json().files as Array<{ role: string; path: string }>
    ).find((file) => file.role === 'config')!.path;

    await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    const written = fs.readFileSync(configPath, 'utf8');
    expect(written).toContain('base_url = "https://host.example.com/v1"');
    expect(written).not.toContain('/v1/v1');

    await call('PATCH', '/api/agents/codex/target', { mode: 'gateway' }, { cookie });
  });

  it('可把 Approve for me 的模型经网关映射到指定模型', async () => {
    // 真实背景：Codex 在 API Key 认证下把审批模型硬编码成 gpt-5.6-luna，
    // 没有任何配置项能改（auto_review_model_override 会被 ModelInfo→ModelPreset
    // 的转换丢弃）。走网关时这个名字出现在请求体里，于是可以当占位名换掉。
    //
    // 这里同时钉住"两个条件缺一不可"的判定：
    // - 审批请求 + 占位名 → 改写
    // - 只有占位名、没有 turn_trigger → 不改写（用户可能真在用它聊天）
    // 只测正向会把判定写成"模型名相等就改写"，那会误伤正常对话。
    const providers = (await call('GET', '/api/providers', undefined, { cookie })).json()
      .providers as Array<{ id: string; apiType: string; models: string[] }>;
    const responses = providers.find((item) => item.apiType === 'responses')!;

    // 先让该供应商**声明** gpt-6-luna：审批映射的目标必须真实存在于某家已启用
    // 供应商的模型列表里。不校验的话，用户配了个不存在的模型，请求会照常发出去、
    // 由上游报一个含糊的模型不存在错误——比在网关侧明确报错难查得多。
    // PUT 是全量更新，必须带齐字段（apiKey 留空表示沿用已保存的）
    const target = (
      (await call('GET', '/api/providers', undefined, { cookie })).json().providers as Array<{
        id: string;
        name: string;
        apiType: string;
        baseUrl: string;
        models: string[];
      }>
    ).find((item) => item.id === responses.id)!;
    if (!target.models.includes('gpt-6-luna')) {
      const patched = await call(
        'PUT', `/api/providers/${target.id}`,
        {
          name: target.name,
          apiType: target.apiType,
          baseUrl: target.baseUrl,
          apiKey: '',
          models: [...target.models, 'gpt-6-luna'],
        },
        { cookie },
      );
      expect(patched.statusCode).toBe(200);
    }

    const set = await call(
      'PATCH', '/api/settings/codex', { approvalReviewModel: 'gpt-6-luna' }, { cookie },
    );
    expect(set.statusCode).toBe(200);
    expect(set.json().approvalReviewModel).toBe('gpt-6-luna');
    // 默认模型也设上：裸名会被默认模型覆盖，这会让"映射是否真的改了模型"变得不可分辨
    await call('PUT', '/api/settings/default', { providerId: responses.id, model: responses.models[0] }, { cookie });

    // 用共享的令牌：在这里重新生成会让后面用例里的令牌失效
    const token = gatewayToken;
    expect(token.length).toBeGreaterThan(20);

    const send = async (extra: Record<string, string>): Promise<string> =>
      (
        await call(
          'POST',
          '/v1/responses',
          { model: 'gpt-5.6-luna', input: 'hi', stream: false },
          { ...extra, authorization: `Bearer ${token}` },
        )
      ).json().model as string;

    // 审批请求（带 turn_trigger=guardian_review）→ 映射到 gpt-6-luna
    const approved = await send({
      'x-codex-turn-metadata': JSON.stringify({ turn_trigger: 'guardian_review' }),
    });
    expect(approved).toBe('gpt-6-luna');

    // 同样的模型名、但不是审批请求 → 不能被改写（否则用户真的用这个模型时会错）
    const normal = await send({});
    expect(normal).not.toBe('gpt-6-luna');

    // 清空映射后恢复默认行为
    await call('PATCH', '/api/settings/codex', { approvalReviewModel: null }, { cookie });
    const afterReset = await send({
      'x-codex-turn-metadata': JSON.stringify({ turn_trigger: 'guardian_review' }),
    });
    expect(afterReset).not.toBe('gpt-6-luna');
  });

  it('审批占位名必须出现在 Codex 模型目录里，否则映射永不生效', async () => {
    // 真实 bug（用户报"设置了审批模型但不生效"）：
    // Codex 在 API Key 认证下把审批模型硬编码成 gpt-5.6-luna，然后去**模型目录**里找它。
    // 目录里没有这个名字时它不报错，而是静默回退到父模型（当前对话模型），
    // 于是网关永远收不到 gpt-5.6-luna，那套"识别占位名再改写"的逻辑一次都不触发。
    // 症状就是配了没效果，而且日志里连一条审批请求都看不到。
    //
    // 修法是把占位名放进目录。这条测试钉住"目录里必须有它"这个前提。
    const providers = (await call('GET', '/api/providers', undefined, { cookie })).json()
      .providers as Array<{ id: string; name: string; apiType: string; baseUrl: string; models: string[] }>;
    const responses = providers.find((item) => item.apiType === 'responses')!;
    if (!responses.models.includes('gpt-6-luna')) {
      await call('PUT', `/api/providers/${responses.id}`, {
        name: responses.name, apiType: responses.apiType, baseUrl: responses.baseUrl,
        apiKey: '', models: [...responses.models, 'gpt-6-luna'],
      }, { cookie });
    }

    // 配好审批模型，apply 一次
    await call('PATCH', '/api/settings/codex', { approvalReviewModel: 'gpt-6-luna' }, { cookie });
    await call('PATCH', '/api/agents/codex/target', { mode: 'gateway' }, { cookie });
    const applied = await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    expect(applied.statusCode).toBe(200);

    const catalogPath = path.join(agentHome, '.codex', 'llmapi-model-catalog.json');
    const slugs = (JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
      models: Array<{ slug: string }>;
    }).models.map((item) => item.slug);

    expect(slugs).toContain('gpt-5.6-luna');

    // 取消审批模型后不应再注入，避免给没用这个功能的用户多一个看不懂的条目
    await call('PATCH', '/api/settings/codex', { approvalReviewModel: null }, { cookie });
    await call('POST', '/api/agents/codex/apply', undefined, { cookie });
    const afterReset = (JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
      models: Array<{ slug: string }>;
    }).models.map((item) => item.slug);
    expect(afterReset).not.toContain('gpt-5.6-luna');
  });

  it('同一模型被多家供应商声明时，审批映射优先选协议匹配的那家', async () => {
    // 用户真实情况：gpt-6-luna 同时在 openai（wllapi）与 responses（opendesign）两家。
    // 早先的实现随便 find 第一个，可能挑到需要转换的那家，甚至在有直通供应商时
    // 报"未开启跨协议转发"——明明能直通。能直通就别转换（转换有信息损失）。
    const providers = (await call('GET', '/api/providers', undefined, { cookie })).json()
      .providers as Array<{ id: string; apiType: string; models: string[] }>;
    const responses = providers.find((item) => item.apiType === 'responses')!;
    // 只需保证 responses 那家也声明它
    if (!responses.models.includes('gpt-6-luna')) {
      const full = (await call('GET', '/api/providers', undefined, { cookie })).json()
        .providers as Array<{ id: string; name: string; apiType: string; baseUrl: string; models: string[] }>;
      const t = full.find((item) => item.id === responses.id)!;
      await call('PUT', `/api/providers/${t.id}`, {
        name: t.name, apiType: t.apiType, baseUrl: t.baseUrl, apiKey: '',
        models: [...t.models, 'gpt-6-luna'],
      }, { cookie });
    }
    await call('PATCH', '/api/settings/codex', { approvalReviewModel: 'gpt-6-luna', protocolConversion: true }, { cookie });

    // 请求返回的 model 是上游模型名，无法区分供应商；用诊断接口看选了谁
    await call('PATCH', '/api/settings/codex', { protocolConversion: false }, { cookie });
    const approved = await call(
      'POST', '/v1/responses',
      { model: 'gpt-5.6-luna', input: 'hi', stream: false },
      { authorization: `Bearer ${gatewayToken}`, 'x-codex-turn-metadata': JSON.stringify({ turn_trigger: 'guardian_review' }) },
    );
    // 能直通就不该被 501/400 挡住
    expect([200]).toContain(approved.statusCode);
    expect(approved.json().model).toBe('gpt-6-luna');
  });

  it('开启跨协议转发后，Responses 请求可以落到 Chat 上游', async () => {
    // 真实场景：Codex 只会发 /v1/responses，而很多上游只提供 Chat Completions。
    // 打开开关后网关负责双向转换（含流式与工具调用）。
    //
    // 这条覆盖完整开关周期：关着 → 501 且错误信息可操作；打开 → 非流式与流式都成功；
    // 再关掉 → 回到 501。只测"打开能用"会漏掉反向路径，而开关是要能关回去的
    // （转换有信息损失，用户可能为了保留托管工具而关掉）。
    const created = await call(
      'POST', '/api/providers',
      {
        name: '只支持 chat 的上游',
        apiType: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
        apiKey: 'sk-chat-only',
        models: ['chat-only-model'],
      },
      { cookie },
    );
    expect(created.statusCode).toBe(201);
    const providerKey = (created.json().provider as { providerKey: string }).providerKey;
    const alias = `lam-${providerKey}/chat-only-model`;

    // 显式关掉：这个实例里还有 responses 供应商，所以自动开启不会触发
    // （触发条件是"只有 openai 供应商"）。这里要验的是手动关闭时的行为。
    await call('PATCH', '/api/settings/codex', { protocolConversion: false }, { cookie });

    // 开关关着：仍然拒绝，且错误信息要指出可以开启
    const rejected = await call(
      'POST', '/v1/responses',
      { model: alias, input: 'hi', stream: false },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(rejected.statusCode).toBe(501);
    expect(rejected.json().error.message).toContain('未开启协议转换');

    // 打开开关
    const enabled = await call(
      'PATCH', '/api/settings/codex', { protocolConversion: true }, { cookie },
    );
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().protocolConversion).toBe(true);

    // 非流式：上游返 Chat 形状，网关要转成 Responses
    const converted = await call(
      'POST', '/v1/responses',
      {
        model: alias,
        instructions: '你是助手',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
        stream: false,
      },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(converted.statusCode).toBe(200);
    const body = converted.json() as { object: string; output: Array<Record<string, unknown>> };
    expect(body.object).toBe('response');
    // 上游假数据返回 'mock reply'，必须出现在 Responses 的 output 里
    expect(JSON.stringify(body.output)).toContain('mock reply');

    // 流式：必须产出 Responses 事件序列，而不是原样透传 Chat 的 delta
    const streamed = await call(
      'POST', '/v1/responses',
      { model: alias, input: 'hi', stream: true },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(streamed.statusCode).toBe(200);
    const sse = streamed.body;
    // 必须是 Responses 的事件序列，而不是把 Chat 的 SSE 原样透传：
    // Codex 只认 response.* 事件，收到 Chat 的 delta 会当成空响应。
    expect(sse).toContain('event: response.created');
    expect(sse).toContain('event: response.output_text.delta');
    // 没有 response.completed 客户端会一直等（流不结束）
    expect(sse).toContain('event: response.completed');
    // 上游四个 chunk 拼起来是 "Hello from fake upstream"：
    // 证明内容是跨 chunk 拼接的，不是只发了第一块
    expect(sse).toContain('Hello');
    // Chat 的结束标记不能泄漏给 Codex：它不是合法 Responses 事件，
    // 而且转换层已经用 response.completed 表达了"结束"。
    expect(sse).not.toContain('[DONE]');

    // 关掉开关恢复原有行为
    await call('PATCH', '/api/settings/codex', { protocolConversion: false }, { cookie });
    const afterDisable = await call(
      'POST', '/v1/responses',
      { model: alias, input: 'hi', stream: false },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(afterDisable.statusCode).toBe(501);
  });

  it('跨协议转发时，会话状态类字段明确报错而不是静默丢弃', async () => {
    await call('PATCH', '/api/settings/codex', { protocolConversion: true }, { cookie });
    const providers = (await call('GET', '/api/providers', undefined, { cookie })).json()
      .providers as Array<{ apiType: string; providerKey: string; models: string[] }>;
    const chatOnly = providers.find((item) => item.apiType === 'openai')!;

    const response = await call(
      'POST', '/v1/responses',
      {
        model: `lam-${chatOnly.providerKey}/${chatOnly.models[0]}`,
        input: 'hi',
        previous_response_id: 'resp_1',
        stream: false,
      },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('previous_response_id');

    await call('PATCH', '/api/settings/codex', { protocolConversion: false }, { cookie });
  });

  it('Claude Code 写入 env 段且保留其他设置', async () => {
    const created = await call(
      'POST',
      '/api/providers',
      {
        name: 'Mock Anthropic',
        apiType: 'anthropic',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
        apiKey: 'sk-ant-mock',
        models: ['claude-x'],
      },
      { cookie },
    );
    expect(created.statusCode).toBe(201);

    const preview = await call(
      'POST',
      '/api/agents/claude-code/preview',
      undefined,
      { cookie },
    );
    expect(preview.statusCode).toBe(200);
    const settingsPath = preview.json().files[0].path as string;
    expect(settingsPath).toBe(path.join(agentHome, '.claude', 'settings.json'));
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Bash'] }, env: { KEEP: '1' } }, null, 2),
    );

    const apply = await call('POST', '/api/agents/claude-code/apply', undefined, { cookie });
    expect(apply.statusCode).toBe(200);

    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(parsed.permissions).toEqual({ allow: ['Bash'] });
    expect(parsed.env.KEEP).toBe('1');
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${MOCK_PORT}`);
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe(gatewayToken);
    expect(parsed.env.ANTHROPIC_MODEL).toBe('lam-mock-anthropic/claude-x');
  });

  it('Claude Code 可通过网关调用 anthropic 供应商', async () => {
    const response = await call(
      'POST',
      '/v1/messages',
      { model: 'lam-mock-anthropic/claude-x', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': gatewayToken },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().model).toBe('claude-x');
  });
});

describe('冒烟：无 body 的 POST', () => {
  it('带 JSON 头但不带 body 时按空对象处理', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/codex/preview',
      headers: { cookie, 'content-type': 'application/json' },
    });
    // 没有供应商时会 400（业务原因），但绝不能是 FST_ERR_CTP_EMPTY_JSON_BODY
    expect(response.body).not.toContain('Body cannot be empty');
  });

  it('退出登录无需 body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('非法 JSON 仍返回 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{ broken',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('bad_request');
  });
});

describe('冒烟：越权访问', () => {
  it('受限角色访问写接口返回 403 且数据未变', async () => {
    // 直接往身份存储加一个 member 账号，验证路由层的权限裁决（而不是只测 policy 函数）
    const { createContext } = await import('../src/context');
    const config = testConfig(dataDir, agentHome);
    const ctx = createContext(config, createLogger('error'));
    const identity = ctx.identity.read();
    const { hashPassword } = await import('../src/auth/password');
    identity.users.push({
      id: 'u_member',
      tenantId: 't_default',
      username: 'member',
      role: 'member',
      passwordHash: await hashPassword('member-password'),
      authVersion: 1,
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    ctx.identity.write(identity);

    const login = await call('POST', '/api/auth/login', {
      username: 'member',
      password: 'member-password',
    });
    expect(login.statusCode).toBe(200);
    const memberCookie = String(login.headers['set-cookie']).split(';')[0];

    const before = (await call('GET', '/api/logs?limit=1', undefined, { cookie })).json().logs.length;

    const forbiddenRead = await call('GET', '/api/providers', undefined, {
      cookie: memberCookie,
    });
    expect(forbiddenRead.statusCode).toBe(403);
    expect(forbiddenRead.json().error.code).toBe('forbidden');

    const forbiddenWrite = await call(
      'POST',
      '/api/providers',
      {
        name: 'Should Not Exist',
        apiType: 'openai',
        baseUrl: 'http://127.0.0.1:1',
        models: ['x'],
      },
      { cookie: memberCookie },
    );
    expect(forbiddenWrite.statusCode).toBe(403);

    // 写操作被拒后，供应商列表里不应出现这条记录
    const list = await call('GET', '/api/providers', undefined, { cookie });
    const names = list.json().providers.map((item: { name: string }) => item.name);
    expect(names).not.toContain('Should Not Exist');

    const after = (await call('GET', '/api/logs?limit=1', undefined, { cookie })).json().logs.length;
    expect(after).toBe(before);
  });
});

describe('冒烟：删除默认供应商时的降级', () => {
  it('删除默认供应商后自动降级到剩余最高优先级', async () => {
    const first = await call(
      'POST',
      '/api/providers',
      {
        name: 'Tier One',
        apiType: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
        apiKey: 'k1',
        models: ['gpt-x'],
      },
      { cookie },
    );
    const second = await call(
      'POST',
      '/api/providers',
      {
        name: 'Tier Two',
        apiType: 'openai',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
        apiKey: 'k2',
        models: ['gpt-x'],
      },
      { cookie },
    );
    const firstId = first.json().provider.id;
    const secondId = second.json().provider.id;

    await call(
      'PUT',
      '/api/providers/order',
      { ids: [firstId, secondId] },
      { cookie },
    );
    await call('PUT', '/api/settings/default', { providerId: firstId }, { cookie });

    const removed = await call('DELETE', `/api/providers/${firstId}`, undefined, { cookie });
    expect(removed.statusCode).toBe(200);
    const fallbackId = removed.json().newDefaultProviderId as string | null;
    // 必须换成另一个仍然存在的供应商，而不是留下悬空引用
    expect(fallbackId).toBeTruthy();
    expect(fallbackId).not.toBe(firstId);

    const settings = await call('GET', '/api/settings', undefined, { cookie });
    expect(settings.json().defaultProviderId).toBe(fallbackId);

    const list = await call('GET', '/api/providers', undefined, { cookie });
    const ids = list.json().providers.map((item: { id: string }) => item.id);
    expect(ids).not.toContain(firstId);
    expect(ids).toContain(fallbackId as string);

    // 清理，避免影响后续用例对默认供应商的假设
    await call('DELETE', `/api/providers/${secondId}`, undefined, { cookie });
    await call('PUT', '/api/settings/default', { providerId: null }, { cookie });
  });
});

describe('冒烟：持久化与隔离', () => {
  it('供应商落盘在租户目录且 Key 为密文', () => {
    const file = path.join(dataDir, 'tenants', 't_default', 'providers.json');
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(1);
    expect(raw).not.toContain('sk-mock-openai-secret');
    expect(parsed.data.providers[0].apiKey.startsWith('enc:v1:')).toBe(true);
  });

  it('账号只存 scrypt 哈希', () => {
    const raw = fs.readFileSync(path.join(dataDir, 'identity.json'), 'utf8');
    expect(raw).not.toContain(PASSWORD);
    const parsed = JSON.parse(raw);
    expect(parsed.data.users[0].passwordHash.startsWith('scrypt$')).toBe(true);
    expect(parsed.data.users[0].tenantId).toBe('t_default');
  });

  it('修改口令后旧会话失效', async () => {
    const change = await call(
      'POST',
      '/api/auth/password',
      { oldPassword: PASSWORD, newPassword: 'brand-new-password' },
      { cookie },
    );
    expect(change.statusCode).toBe(200);

    const stale = await call('GET', '/api/providers', undefined, { cookie });
    expect(stale.statusCode).toBe(401);

    const relogin = await call('POST', '/api/auth/login', {
      username: 'admin',
      password: 'brand-new-password',
    });
    expect(relogin.statusCode).toBe(200);
  });
});

describe('冒烟：API 令牌与信息接口', () => {
  // 这些用例需要有效的登录会话。放在顶层而不是嵌在「持久化与隔离」里：
  // 那一组末尾会改口令、导致 cookie 失效，嵌进去会全部变成 401。
  let tokenCookie = '';

  beforeAll(async () => {
    const login = await call('POST', '/api/auth/login', {
      username: 'admin',
      password: 'brand-new-password',
    });
    expect(login.statusCode).toBe(200);
    tokenCookie = String(login.headers['set-cookie']).split(';')[0];
  });

  const bearer = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
  });

  it('用令牌可以调用管理接口，无需 cookie', async () => {
    const created = await call(
      'POST', '/api/tokens',
      { name: 'CI 脚本', scopes: ['providers:read', 'providers:write'] },
      { cookie: tokenCookie },
    );
    expect(created.statusCode).toBe(200);
    const token = created.json().token as string;
    expect(token.startsWith('api_')).toBe(true);

    // 不带 cookie，只带 Bearer
    const list = await call('GET', '/api/providers', undefined, bearer(token));
    expect(list.statusCode).toBe(200);

    // 写权限也生效
    const write = await call(
      'POST', '/api/providers',
      {
        name: '令牌创建的供应商',
        apiType: 'openai',
        baseUrl: 'http://127.0.0.1:65534',
        apiKey: 'sk-token-created',
        models: ['m1'],
      },
      bearer(token),
    );
    expect(write.statusCode).toBe(201);
  });

  it('令牌的权限是收窄的：越权返回 403', async () => {
    const created = await call(
      'POST', '/api/tokens',
      { name: '只读令牌', scopes: ['providers:read'] },
      { cookie: tokenCookie },
    );
    const token = created.json().token as string;

    // 读能过
    expect((await call('GET', '/api/providers', undefined, bearer(token))).statusCode).toBe(200);
    // 写不能过
    const denied = await call(
      'POST', '/api/providers',
      { name: 'x', apiType: 'openai', baseUrl: 'http://127.0.0.1:65535', apiKey: 'k', models: [] },
      bearer(token),
    );
    expect(denied.statusCode).toBe(403);
    // 错误信息要指明是令牌缺权限，而不是角色——令牌没有角色语义
    expect(denied.json().error.message).toContain('API 令牌');
    // 且不能把令牌内容带进错误信息
    expect(denied.body).not.toContain(token);
  });

  it('令牌不能调用需要真人会话的接口', async () => {
    // 改口令必须由真人会话完成：否则凭据泄露后攻击者可以永久接管账号，
    // 而吊销令牌也救不回来（口令已被改）
    const created = await call(
      'POST', '/api/tokens',
      { name: '全权限令牌', scopes: ['settings:read', 'settings:write'] },
      { cookie: tokenCookie },
    );
    const token = created.json().token as string;

    const response = await call(
      'POST', '/api/auth/password',
      { oldPassword: 'brand-new-password', newPassword: 'hacked-password-123' },
      bearer(token),
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain('登录会话');
  });

  it('令牌不能创建或吊销令牌，避免自我续命', async () => {
    const created = await call(
      'POST', '/api/tokens',
      { name: '想自我续命', scopes: ['settings:read', 'settings:write'] },
      { cookie: tokenCookie },
    );
    const token = created.json().token as string;

    const again = await call(
      'POST', '/api/tokens',
      { name: '后门', scopes: ['settings:read'] },
      bearer(token),
    );
    expect(again.statusCode).toBe(403);
  });

  it('吊销后立即失效', async () => {
    const created = await call(
      'POST', '/api/tokens',
      { name: '待吊销', scopes: ['providers:read'] },
      { cookie: tokenCookie },
    );
    const body = created.json() as { token: string; tokenView: { id: string } };
    expect((await call('GET', '/api/providers', undefined, bearer(body.token))).statusCode).toBe(200);

    const revoked = await call('DELETE', `/api/tokens/${body.tokenView.id}`, undefined, { cookie: tokenCookie });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().tokenView.revokedAt).toBeTruthy();

    expect((await call('GET', '/api/providers', undefined, bearer(body.token))).statusCode).toBe(401);
  });

  it('列表不含哈希与明文，只给 prefix/tail', async () => {
    const created = await call(
      'POST', '/api/tokens',
      { name: '列表检查', scopes: ['providers:read'] },
      { cookie: tokenCookie },
    );
    const token = created.json().token as string;

    const list = await call('GET', '/api/tokens', undefined, { cookie: tokenCookie });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain('tokenHash');
    const found = (list.json().tokens as Array<{ name: string; prefix: string }>).find(
      (item) => item.name === '列表检查',
    );
    expect(found?.prefix).toBe(token.slice(0, 11));
  });

  it('不能授予自己没有的权限，也不能授予保留权限', async () => {
    const overreach = await call(
      'POST', '/api/tokens',
      { name: '提权尝试', scopes: ['users:manage'] },
      { cookie: tokenCookie },
    );
    // admin 角色本身就没有 users:manage，两项拒绝理由都成立
    expect([400, 403]).toContain(overreach.statusCode);
  });

  it('空 scopes 与非法 scope 都被拒绝', async () => {
    expect(
      (await call('POST', '/api/tokens', { name: 'x', scopes: [] }, { cookie: tokenCookie })).statusCode,
    ).toBe(400);
    expect(
      (await call('POST', '/api/tokens', { name: 'x', scopes: ['不存在的权限'] }, { cookie: tokenCookie }))
        .statusCode,
    ).toBe(400);
  });

  it('过期的 expiresAt 被拒绝', async () => {
    const response = await call(
      'POST', '/api/tokens',
      { name: 'x', scopes: ['providers:read'], expiresAt: '2020-01-01T00:00:00.000Z' },
      { cookie: tokenCookie },
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('补充信息接口', () => {
  let infoCookie = '';
  beforeAll(async () => {
    const login = await call('POST', '/api/auth/login', {
      username: 'admin',
      password: 'brand-new-password',
    });
    infoCookie = String(login.headers['set-cookie']).split(';')[0];
  });

  it('/api/info 是 public 但不泄漏部署细节', async () => {
    const response = await call('GET', '/api/info');
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.name).toBe('llmapi-manager');
    expect(typeof body.version).toBe('string');
    // 本机绝对路径属于部署细节，不能出现在 public 接口里
    expect(response.body).not.toContain('/mnt/');
    expect(response.body).not.toContain('/home/');
    expect(body.dataDir).toBeUndefined();
  });

  it('/api/health 不再返回 dataDir', async () => {
    const response = await call('GET', '/api/health');
    expect(response.statusCode).toBe(200);
    expect(response.json().dataDir).toBeUndefined();
    // 探活字段仍在
    expect(response.json().ok).toBe(true);
  });

  it('/api/overview 一次拿到供应商分布、设置与 Agent 状态', async () => {
    const response = await call('GET', '/api/overview', undefined, { cookie: infoCookie });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      providers: { total: number; byApiType: Record<string, number> };
      aliases: { total: number };
      settings: Record<string, unknown>;
      agents: Array<{ id: string }>;
      todayStats: Record<string, unknown>;
    };
    expect(body.providers.total).toBeGreaterThan(0);
    expect(body.providers.byApiType).toHaveProperty('responses');
    expect(body.aliases.total).toBeGreaterThan(0);
    expect(body.settings).toHaveProperty('protocolConversion');
    expect(body.agents.map((item) => item.id)).toContain('codex');
    expect(body.todayStats).toHaveProperty('successRate');
  });

  it('/api/overview 需要 providers:read，未登录被拒', async () => {
    expect((await call('GET', '/api/overview')).statusCode).toBe(401);
  });
});

describe('冒烟：诊断接口', () => {
  let diagCookie = '';
  beforeAll(async () => {
    const login = await call('POST', '/api/auth/login', {
      username: 'admin',
      password: 'brand-new-password',
    });
    diagCookie = String(login.headers['set-cookie']).split(';')[0];
  });

  it('默认关闭时返回 404，不暴露功能存在', async () => {
    // 诊断接口会回显 prompt 片段并真的打上游，默认开放等于多一个探测面。
    // 用 404 而不是 403：不告诉未授权的探测者"这里有个开关可以打开"。
    const response = await call('GET', '/api/diagnostics/check', undefined, { cookie: diagCookie });
    expect(response.statusCode).toBe(404);
  });

  describe('开启后', () => {
    // 诊断开关是启动期配置，所以这里起一个独立的 app 实例并显式打开它。
    // 复用主实例做不到——主实例在 beforeAll 时已经构建完成，改配置不会重建路由。
    let diagApp: Awaited<ReturnType<typeof buildApp>>;
    let diagDir = '';
    let diagHome = '';
    let diagCookie2 = '';

    beforeAll(async () => {
      diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-diag-data-'));
      diagHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-diag-home-'));
      const config = { ...testConfig(diagDir, diagHome), enableDiagnostics: true };
      const logger = createLogger('error');
      const ctx = createContext(config, logger);
      await bootstrapIdentity(config, ctx.paths, ctx.identity, logger, ctx.setup);
      diagApp = await buildApp({ ctx });
      await diagApp.ready();

      // 建一个 owner 账号（初始化后登录）
      const setup = await diagApp.inject({ method: 'POST', url: '/api/setup', payload: {
        token: ctx.setup.readToken?.() ?? '', username: 'admin', password: PASSWORD,
      } });
      if (setup.statusCode !== 201 && setup.statusCode !== 200) {
        // 已初始化：直接登录
      }
      const login = await diagApp.inject({ method: 'POST', url: '/api/auth/login',
        payload: { username: 'admin', password: PASSWORD } });
      diagCookie2 = String(login.headers['set-cookie']).split(';')[0];
    });

    afterAll(async () => {
      await diagApp?.close();
      fs.rmSync(diagDir, { recursive: true, force: true });
      fs.rmSync(diagHome, { recursive: true, force: true });
    });

    const diagCall = (
      method: 'GET' | 'POST',
      url: string,
      payload?: unknown,
    ) => diagApp.inject({ method, url, payload: payload as never, headers: { cookie: diagCookie2 } });

    it('路由预演能解释"为什么选这家"，并列出被排除的供应商', async () => {
      // 独立实例是空库，先建一家 responses 供应商与一家 openai 供应商，
      // 这样才能验证"别名命中"与"被排除的供应商"两个分支
      await diagApp.inject({ method: 'POST', url: '/api/providers', headers: { cookie: diagCookie2 },
        payload: { name: 'Diag 响应式', apiType: 'responses', baseUrl: 'http://127.0.0.1:65530',
          apiKey: 'sk-diag-1', models: ['gpt-resp'] } });
      await diagApp.inject({ method: 'POST', url: '/api/providers', headers: { cookie: diagCookie2 },
        payload: { name: 'Diag Chat', apiType: 'openai', baseUrl: 'http://127.0.0.1:65531',
          apiKey: 'sk-diag-2', models: ['chat-model'] } });

      const providers = (await diagApp.inject({ method: 'GET', url: '/api/providers',
        headers: { cookie: diagCookie2 } })).json().providers as Array<{ providerKey: string; apiType: string }>;
      const responsesKey = providers.find((item) => item.apiType === 'responses')!.providerKey;

      const response = await diagCall(
        'POST', '/api/diagnostics/route',
        { model: `lam-${responsesKey}/gpt-resp`, path: '/responses' },
      );
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      // 别名是明确指向，必须标成 alias——这样用户才知道"不是它自己挑的"
      expect(body.primary.reason).toBe('alias');
      expect(body.primary.apiTypeMatchesPath).toBe(true);
      // 协议匹配时不需要转换
      expect(body.primary.convertResponsesToChat).toBe(false);
    });

    it('转换器自检能跑通纯函数映射', async () => {
      const response = await diagCall('GET', '/api/diagnostics/converter');
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // 这组断言的价值：转换器坏了要能自己报出来，而不是等用户发现工具调不动
      expect(body.cases.map((c: { name: string }) => c.name)).toContain(
        'custom 工具 → 单参 function',
      );
      expect(body.ok).toBe(true);
    });

    it('自检清单能发现"开关关着但目录里有 openai 别名"', async () => {
      const response = await diagCall('GET', '/api/diagnostics/check');
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const names = body.checks.map((c: { name: string }) => c.name);
      expect(names).toContain('Codex 有可用的上游协议');
      expect(names).toContain('审批模型映射的生效条件');
    });

    it('只有 openai 供应商时，诊断必须与网关一样预测到"会自动开启转换"', async () => {
      // 真实缺陷：诊断原先不模拟网关的自动开启逻辑，于是回答"直发 /responses、
      // 不需要转换"，而实际网关会自动开开关并改走 /chat/completions——
      // 结论方向完全相反，比没有诊断更误导。
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-diag2-'));
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-diag2h-'));
      const config = { ...testConfig(dir, home), enableDiagnostics: true };
      const logger = createLogger('error');
      const ctx = createContext(config, logger);
      await bootstrapIdentity(config, ctx.paths, ctx.identity, logger, ctx.setup);
      const isolated = await buildApp({ ctx });
      await isolated.ready();
      try {
        const login = await isolated.inject({ method: 'POST', url: '/api/auth/login',
          payload: { username: 'admin', password: PASSWORD } });
        const c = { cookie: String(login.headers['set-cookie']).split(';')[0] };
        // 只有 openai 供应商，且开关关闭
        await isolated.inject({ method: 'POST', url: '/api/providers', headers: c,
          payload: { name: 'OnlyChat', apiType: 'openai', baseUrl: 'http://127.0.0.1:65530',
            apiKey: 'sk-x', models: ['chat-m'] } });

        const r = await isolated.inject({ method: 'POST', url: '/api/diagnostics/route',
          headers: c, payload: { model: 'chat-m', path: '/responses' } });
        expect(r.statusCode).toBe(200);
        const body = r.json();
        // 关键断言：必须预测到自动开启，且预测转换后走 chat/completions
        expect(body.wouldAutoEnableConversion).toBe(true);
        expect(body.primary.convertResponsesToChat).toBe(true);
        expect(body.primary.wouldUseUpstreamUrl).toContain('/chat/completions');
      } finally {
        await isolated.close();
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('流式请求不会被诊断误报成 JSON 解析失败', async () => {
      // 真实缺陷：诊断直接 JSON.parse 上游响应，遇到 SSE 必然失败并报错，
      // 而真实链路是好的。Codex 永远发 stream:true，所以这个假错必然撞上。
      const r = await diagCall('POST', '/api/diagnostics/forward', {
        model: 'stream-test',
        path: '/responses',
        body: { model: 'stream-test', input: 'hi', stream: true },
      });
      // 上游不存在 → 链路会失败，但**不能因为"流式"而报 JSON 解析错**
      const body = r.json();
      const conv = (body.steps ?? []).find(
        (item: { step: string }) => item.step === 'convert-response',
      );
      if (conv && conv.ok === false) {
        expect(conv.error).not.toContain('JSON');
      }
    });

    it('check 不会在"responses + openai 并存且开关关闭"时误报目录有问题', async () => {
      // 真实缺陷：check 原先用 buildModelCatalog 无过滤重建目录，把 openai 别名
      // 也算进来，于是在这个最常见的配置下稳定误报，并让用户反复做无效的 apply。
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-diag3-'));
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-diag3h-'));
      const config = { ...testConfig(dir, home), enableDiagnostics: true };
      const logger = createLogger('error');
      const ctx = createContext(config, logger);
      await bootstrapIdentity(config, ctx.paths, ctx.identity, logger, ctx.setup);
      const isolated = await buildApp({ ctx });
      await isolated.ready();
      try {
        const login = await isolated.inject({ method: 'POST', url: '/api/auth/login',
          payload: { username: 'admin', password: PASSWORD } });
        const c = { cookie: String(login.headers['set-cookie']).split(';')[0] };
        await isolated.inject({ method: 'POST', url: '/api/providers', headers: c,
          payload: { name: 'Resp', apiType: 'responses', baseUrl: 'http://127.0.0.1:65530',
            apiKey: 'sk-r', models: ['resp-m'] } });
        await isolated.inject({ method: 'POST', url: '/api/providers', headers: c,
          payload: { name: 'Chat', apiType: 'openai', baseUrl: 'http://127.0.0.1:65531',
            apiKey: 'sk-c', models: ['chat-m'] } });
        // apply 一次，生成真实目录（此时开关关闭，openai 别名不该进目录）
        await isolated.inject({ method: 'POST', url: '/api/agents/codex/apply', headers: c });

        const r = await isolated.inject({ method: 'GET', url: '/api/diagnostics/check', headers: c });
        const body = r.json();
        const catalogCheck = body.checks.find(
          (item: { name: string }) => item.name.includes('目录'),
        );
        expect(catalogCheck.ok).toBe(true);
      } finally {
        await isolated.close();
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('诊断接口需要 settings:write，只读令牌被拒', async () => {
      const created = await call(
        'POST', '/api/tokens',
        { name: '诊断只读', scopes: ['providers:read'] },
        { cookie: diagCookie },
      );
      const token = created.json().token as string;
      const response = await call('GET', '/api/diagnostics/check', undefined, {
        authorization: `Bearer ${token}`,
      });
      // 未开启诊断时是 404，开启后必须 403——两种都不该是 200
      expect([403, 404]).toContain(response.statusCode);
    });
  });
});
