import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAgentWrites,
  applyJsonWrites,
  buildPreviewEntries,
  revertAgentWrites,
  type DesiredWrites,
} from '../src/agents/patch';
import { applyTomlEdits, readTomlScalar } from '../src/agents/toml';
import { AGENT_DEFINITIONS } from '../src/agents/registry';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-agent-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('JSON 补丁', () => {
  it('只改目标键，保留其他内容', () => {
    const original = JSON.stringify(
      {
        permissions: { allow: ['Bash'] },
        env: { KEEP_ME: 'yes', ANTHROPIC_MODEL: 'old' },
      },
      null,
      2,
    );
    const next = applyJsonWrites(original, [
      { path: 'env.ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:8787' },
      { path: 'env.ANTHROPIC_MODEL', value: 'lmm-alpha/gpt-x' },
    ]);
    const parsed = JSON.parse(next);
    expect(parsed.permissions).toEqual({ allow: ['Bash'] });
    expect(parsed.env.KEEP_ME).toBe('yes');
    expect(parsed.env.ANTHROPIC_MODEL).toBe('lmm-alpha/gpt-x');
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
  });

  it('同名非对象值时报错而不是覆盖', () => {
    expect(() =>
      applyJsonWrites(JSON.stringify({ env: 'not-an-object' }), [
        { path: 'env.ANTHROPIC_MODEL', value: 'x' },
      ]),
    ).toThrow(/不是对象/);
  });

  it('原文件损坏时抛错，不写空文件', () => {
    expect(() => applyJsonWrites('{ broken', [{ path: 'a', value: 'b' }])).toThrow();
  });
});

describe('Agent 预览脱敏', () => {
  it('凭据类键只返回掩码，不返回完整令牌', () => {
    const token = 'lmm_abcdefghijklmnopqrstuvwxyz1234';
    const entries = buildPreviewEntries(AGENT_DEFINITIONS.codex, 'auth', null, [
      { path: 'OPENAI_API_KEY', value: token },
    ]);

    expect(entries[0].next).not.toBe(token);
    expect(entries[0].next).not.toContain('abcdefghij');
    expect(entries[0].next.endsWith('1234')).toBe(true);
  });

  it('普通配置值保持原样', () => {
    const entries = buildPreviewEntries(AGENT_DEFINITIONS.codex, 'config', null, [
      { path: 'model', value: 'lmm-packycode/gpt-5.1' },
      {
        path: 'base_url',
        value: 'http://127.0.0.1:8787/v1',
        table: 'model_providers.llmapi',
      },
    ]);

    expect(entries[0].next).toBe('lmm-packycode/gpt-5.1');
    expect(entries[1].next).toBe('http://127.0.0.1:8787/v1');
  });
});

describe('TOML 补丁', () => {
  it('只改我们拥有的键，保留其他行与注释', () => {
    const original = [
      '# 用户自己的注释',
      'model_provider = "other"',
      'model = "old"',
      '',
      '[model_providers.other]',
      'name = "Other"',
      '',
      '[mcp_servers.demo]',
      'command = "demo"',
      '',
    ].join('\n');

    const next = applyTomlEdits(original, [
      { key: 'model_provider', value: 'llmapi' },
      { key: 'model', value: 'lmm-alpha/gpt-x' },
      { key: 'base_url', value: 'http://127.0.0.1:8787/v1', table: 'model_providers.llmapi' },
      { key: 'wire_api', value: 'responses', table: 'model_providers.llmapi' },
    ]);

    expect(next).toContain('# 用户自己的注释');
    expect(next).toContain('[model_providers.other]');
    expect(next).toContain('[mcp_servers.demo]');
    expect(readTomlScalar(next, 'model_provider')).toBe('llmapi');
    expect(readTomlScalar(next, 'model')).toBe('lmm-alpha/gpt-x');
    expect(readTomlScalar(next, 'base_url', 'model_providers.llmapi')).toBe(
      'http://127.0.0.1:8787/v1',
    );
    expect(readTomlScalar(next, 'wire_api', 'model_providers.llmapi')).toBe('responses');
  });

  it('新建文件时也能生成完整结构', () => {
    const next = applyTomlEdits('', [
      { key: 'model_provider', value: 'llmapi' },
      { key: 'name', value: 'LLM API Manager', table: 'model_providers.llmapi' },
    ]);
    expect(readTomlScalar(next, 'model_provider')).toBe('llmapi');
    expect(readTomlScalar(next, 'name', 'model_providers.llmapi')).toBe('LLM API Manager');
  });
});

describe('Agent 应用与还原', () => {
  it('应用前备份、还原后保留用户改动', () => {
    const dir = tempDir();
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = JSON.stringify({ env: { KEEP: '1', ANTHROPIC_MODEL: 'old' } }, null, 2);
    fs.writeFileSync(settingsPath, original);

    const writes: Partial<Record<'config', DesiredWrites[]>> = {
      config: [
        { path: 'env.ANTHROPIC_BASE_URL', value: 'http://gw' },
        { path: 'env.ANTHROPIC_MODEL', value: 'lmm-alpha/gpt-x' },
      ],
    };
    const backupsDir = path.join(dir, 'backups');
    const results = applyAgentWrites({
      agentId: 'claude-code',
      definition: AGENT_DEFINITIONS['claude-code'],
      paths: { config: settingsPath, auth: undefined },
      writes,
      backupsDir,
    });

    expect(results).toHaveLength(1);
    expect(results[0].backupPath).toBeTruthy();
    expect(fs.readFileSync(results[0].backupPath as string, 'utf8')).toBe(original);

    const applied = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(applied.env.KEEP).toBe('1');
    expect(applied.env.ANTHROPIC_MODEL).toBe('lmm-alpha/gpt-x');

    // 用户手改了其中一个键
    applied.env.ANTHROPIC_MODEL = 'user-changed';
    fs.writeFileSync(settingsPath, JSON.stringify(applied, null, 2));

    const revert = revertAgentWrites(AGENT_DEFINITIONS['claude-code'], [
      { role: 'config', path: settingsPath, values: results[0].values },
    ]);

    expect(revert.restored).toContain('env.ANTHROPIC_BASE_URL');
    expect(revert.conflicts.map((item) => item.key)).toContain('env.ANTHROPIC_MODEL');

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(after.env.ANTHROPIC_MODEL).toBe('user-changed');
    expect(after.env.KEEP).toBe('1');
  });

  it('目标文件不存在时创建最小文件', () => {
    const dir = tempDir();
    const configPath = path.join(dir, '.codex', 'config.toml');
    const results = applyAgentWrites({
      agentId: 'codex',
      definition: AGENT_DEFINITIONS.codex,
      paths: { config: configPath, auth: undefined },
      writes: {
        config: [
          { path: 'model_provider', value: 'llmapi' },
          { path: 'model', value: 'lmm-alpha/gpt-x' },
        ],
      },
      backupsDir: path.join(dir, 'backups'),
    });

    expect(results[0].created).toBe(true);
    expect(results[0].backupPath).toBeNull();
    const content = fs.readFileSync(configPath, 'utf8');
    expect(readTomlScalar(content, 'model_provider')).toBe('llmapi');
  });

  it('还原时删除由我们创建且已变空的文件', () => {
    const dir = tempDir();
    const configPath = path.join(dir, '.codex', 'config.toml');
    const authPath = path.join(dir, '.codex', 'auth.json');

    const results = applyAgentWrites({
      agentId: 'codex',
      definition: AGENT_DEFINITIONS.codex,
      paths: { config: configPath, auth: authPath },
      writes: {
        config: [{ path: 'model_provider', value: 'llmapi' }],
        auth: [{ path: 'OPENAI_API_KEY', value: 'lmm_token' }],
      },
      backupsDir: path.join(dir, 'backups'),
    });
    expect(results.every((item) => item.created)).toBe(true);

    const revert = revertAgentWrites(
      AGENT_DEFINITIONS.codex,
      results.map((item) => ({
        role: item.role,
        path: item.filePath,
        values: item.values,
        created: item.created,
      })),
    );

    expect(revert.conflicts).toHaveLength(0);
    expect(revert.restored.length).toBeGreaterThan(0);
    // 不留空壳文件
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it('还原时保留原本就存在的文件（即使内容变空）', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, 'model_provider = "llmapi"\n');

    const results = applyAgentWrites({
      agentId: 'codex',
      definition: AGENT_DEFINITIONS.codex,
      paths: { config: configPath, auth: undefined },
      writes: { config: [{ path: 'model_provider', value: 'llmapi' }] },
      backupsDir: path.join(dir, 'backups'),
    });
    expect(results[0].created).toBe(false);

    revertAgentWrites(AGENT_DEFINITIONS.codex, [
      { role: 'config', path: configPath, values: results[0].values, created: false },
    ]);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('还原 TOML 时只移除仍等于写入值的键', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        'model_provider = "llmapi"',
        'model = "lmm-alpha/gpt-x"',
        '',
        '[model_providers.llmapi]',
        'base_url = "http://gw/v1"',
        '',
        '[mcp_servers.demo]',
        'command = "demo"',
        '',
      ].join('\n'),
    );

    const revert = revertAgentWrites(AGENT_DEFINITIONS.codex, [
      {
        role: 'config',
        path: configPath,
        values: {
          model_provider: 'llmapi',
          model: 'lmm-alpha/gpt-x',
          '[model_providers.llmapi] base_url': 'http://gw/v1',
        },
      },
    ]);

    const after = fs.readFileSync(configPath, 'utf8');
    expect(revert.conflicts).toHaveLength(0);
    expect(readTomlScalar(after, 'model_provider')).toBeNull();
    expect(readTomlScalar(after, 'model')).toBeNull();
    expect(readTomlScalar(after, 'base_url', 'model_providers.llmapi')).toBeNull();
    // 无关配置必须留存
    expect(after).toContain('[mcp_servers.demo]');
  });
});
