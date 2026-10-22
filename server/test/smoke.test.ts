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

  it('聚合别名按约定格式生成', async () => {
    const response = await call('GET', '/api/models', undefined, { cookie });
    const body = response.json();
    expect(body.aliases.map((item: { alias: string }) => item.alias)).toEqual([
      'lmm-mock-openai/gpt-x',
      'lmm-mock-openai/gpt-x-mini',
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
      model: 'lmm-mock-openai/gpt-x',
      messages: [],
    });
    expect(response.statusCode).toBe(401);
  });

  it('别名请求转发到指定供应商并改写模型名', async () => {
    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'lmm-mock-openai/gpt-x-mini', messages: [{ role: 'user', content: 'hi' }] },
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
      { model: 'lmm-mock-openai/gpt-x', messages: [] },
      { 'x-api-key': gatewayToken },
    );
    expect(response.statusCode).toBe(200);
  });

  it('流式请求逐块返回 SSE', async () => {
    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'lmm-mock-openai/gpt-x', stream: true, messages: [] },
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
      { model: 'lmm-mock-openai/gpt-x', messages: [{ role: 'user', content: 'x' }] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe('mock reply');
  });

  it('未知别名返回 400 且不回落', async () => {
    const response = await call(
      'POST',
      '/v1/chat/completions',
      { model: 'lmm-nobody/gpt-x', messages: [] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('未知供应商');
  });

  it('/v1/messages 命中 openai 供应商时返回 501', async () => {
    const response = await call(
      'POST',
      '/v1/messages',
      { model: 'lmm-mock-openai/gpt-x', messages: [] },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(501);
    expect(response.json().error.message).toContain('协议转换');
  });

  it('/v1/responses 命中 openai 供应商时返回 501（不再无脑直通）', async () => {
    // responses 从"不限制协议"改为严格匹配后，openai 上游必须被拦住，
    // 否则会把 Responses 请求当成 Chat 请求发给上游，症状是上游报参数错误。
    const response = await call(
      'POST',
      '/v1/responses',
      { model: 'lmm-mock-openai/gpt-x', input: 'hi' },
      { authorization: `Bearer ${gatewayToken}` },
    );
    expect(response.statusCode).toBe(501);
    expect(response.json().error.message).toContain('协议转换');
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
      { model: 'lmm-mock-responses/gpt-resp', input: 'hi' },
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
      { model: 'lmm-mock-responses/gpt-resp', messages: [] },
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
      'lmm-mock-openai/gpt-x',
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

  it('没有可用 responses 供应商时 Codex 回落 chat，wire_api 与所选协议一致', async () => {
    // 若仍硬写 wire_api=responses，而 /v1/responses 又严格要求 responses 上游，
    // 配置与网关就会互相矛盾（Codex 发 responses 请求却被 501）。
    // 这里临时禁用 responses 供应商来模拟"只有 openai"的环境。
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
      expect(preview.statusCode).toBe(200);
      const entries = preview
        .json()
        .files.flatMap((file: { entries: Array<{ key: string; next: string }> }) => file.entries);
      const wire = entries.find(
        (item: { key: string }) => item.key === '[model_providers.llmapi] wire_api',
      );
      expect(wire.next).toBe('chat');
      // 模型应指向某个 openai 供应商（不绑定具体是哪家——优先级会随其他用例变化），
      // 关键是不能指向 responses 供应商。
      const model = entries.find((item: { key: string }) => item.key === 'model');
      expect(model.next).toMatch(/^lmm-/);
      expect(model.next).not.toContain('lmm-mock-responses/');
    } finally {
      // 恢复，避免影响后续用例对 responses 供应商的假设
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

    const backups = fs.readdirSync(
      path.join(dataDir, 'tenants', 't_default', 'backups', 'codex'),
    );
    expect(backups.length).toBe(1);

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
    const entries = preview
      .json()
      .files.flatMap((file: { entries: Array<{ key: string; next: string }> }) => file.entries);
    const wire = entries.find(
      (item: { key: string }) => item.key === '[model_providers.llmapi] wire_api',
    );
    expect(wire.next).toBe('responses');
    // 模型必须指向 responses 供应商的别名
    const model = entries.find((item: { key: string }) => item.key === 'model');
    expect(model.next).toContain('lmm-mock-responses/');
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
    expect(parsed.env.ANTHROPIC_MODEL).toBe('lmm-mock-anthropic/claude-x');
  });

  it('Claude Code 可通过网关调用 anthropic 供应商', async () => {
    const response = await call(
      'POST',
      '/v1/messages',
      { model: 'lmm-mock-anthropic/claude-x', messages: [{ role: 'user', content: 'hi' }] },
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
