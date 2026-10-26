import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NetworkingRuntime } from '../src/networking/runtime';
import type { Logger } from '../src/logger';

/**
 * 这些测试既验证"契约"，也验证"与 oracle 一致"。
 *
 * 重点不是"原生模块有没有编译"（那取决于环境），而是：
 * 1. 未编译时自检返回 null（不是抛错，也不是伪造通过）
 * 2. 编译了的话，自检结果必须与 oracle 的期望字节一致
 */

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

interface Oracle {
  addresses: { ipv4_addr: { protobuf_hex: string } };
  rpc_response: { nesting: { inner_response_hex: string } };
  conn_bitmap: { sample: { bitmap_hex: string } };
  config_flags: { defaults: { data_compress_algo: number; mtu: number } };
  enums: { compression_algo: Record<string, number> };
}

function loadOracle(): Oracle {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures-protocol-oracle.json'), 'utf8'),
  ) as Oracle;
}

describe('原生模块协议自检', () => {
  const runtime = new NetworkingRuntime(logger);
  const result = runtime.protocolSelfCheck();

  it('模块不可用时返回 null（不当成失败，也不伪造通过）', () => {
    // 这个用例在"已编译"和"未编译"两种环境下都必须成立：
    // 要么返回 null，要么返回一份带 checks 的报告。绝不能抛错。
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(Array.isArray(result.checks)).toBe(true);
      expect(result.checks.length).toBeGreaterThan(0);
    }
  });

  it('自检覆盖了每一层协议（模块可用时）', () => {
    if (result === null) return; // 未编译，跳过

    const layers = result.checks.map((c) => c.layer);
    // 这七层是"错了会静默失效"的那一类，缺一层都意味着少了一项保护
    for (const expected of [
      'peer_manager_header',
      'config_flags',
      'compression_algo',
      'ipv4_addr',
      'rpc_response_wrapper',
      'conn_bitmap',
      'liveness_feature',
    ]) {
      expect(layers, `缺少自检层：${expected}`).toContain(expected);
    }
  });

  it('每层都通过（模块可用时）', () => {
    if (result === null) return;

    const failed = result.checks.filter((c) => !c.ok);
    // 失败时把 detail 打出来——那里面写清了期望与实际
    expect(failed.map((c) => `${c.layer}: ${c.detail}`)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('自检结果里的字节与 oracle 一致（模块可用时）', () => {
    if (result === null) return;
    const oracle = loadOracle();

    const byLayer = new Map(result.checks.map((c) => [c.layer, c.detail]));

    // ipv4_addr 层会报出编码后的 hex，应包含 oracle 的期望值
    expect(byLayer.get('ipv4_addr')).toContain(oracle.addresses.ipv4_addr.protobuf_hex);

    // rpc_response_wrapper 同理
    expect(byLayer.get('rpc_response_wrapper')).toContain(
      oracle.rpc_response.nesting.inner_response_hex,
    );

    // conn_bitmap 应报出 0x524a 与 oracle 的 bitmap_hex 一致
    expect(byLayer.get('conn_bitmap')).toContain(`0x${oracle.conn_bitmap.sample.bitmap_hex}`);
  });

  it('config_flags 层能反映官方默认值（模块可用时）', () => {
    if (result === null) return;
    const oracle = loadOracle();
    const detail = result.checks.find((c) => c.layer === 'config_flags')?.detail ?? '';

    // data_compress_algo 默认是 None(1)，这是最容易搞错的一项
    expect(detail).toContain('data_compress_algo=1');
    expect(oracle.config_flags.defaults.data_compress_algo).toBe(1);
    // mtu 默认 1380 而不是常见的 1500
    expect(detail).toContain('mtu=1380');
  });
});

describe('原生模块的 gateway 能力（port-forward 的前提）', () => {
  it('Cargo.toml 启用 socks5 feature（否则 port_forwards 静默失效）', () => {
    // 这条断言防的是"有人清理 feature 列表时误删 socks5"。
    //
    // 为什么值得单独测：`socks5` 名字看起来只与 SOCKS5 代理有关，
    // 实际它门控整个 gateway——
    //   easytier/src/instance/config.rs:52  gateway_enabled: cfg!(feature = "socks5")
    //   easytier-core/src/instance/config.rs:311  据此清空 port_forwards
    //
    // 缺了它时：set_port_forwards 写入成功、回读也有、但端口永不监听，
    // 且日志里没有任何 gateway 输出。症状毫无指向性，排查成本极高。
    const cargoToml = fs.readFileSync(
      path.join(__dirname, '../../native/easytier-node/Cargo.toml'),
      'utf8',
    );

    // 只看 easytier 依赖块的 features 列表
    const easytierBlock = cargoToml.slice(cargoToml.indexOf('easytier = {'));
    const featuresStart = easytierBlock.indexOf('features = [');
    const featuresEnd = easytierBlock.indexOf(']', featuresStart);
    const features = easytierBlock.slice(featuresStart, featuresEnd);

    expect(features).toContain('"socks5"');
    // smoltcp 是 socks5 的依赖，也必须在
    expect(features).toContain('"smoltcp"');
  });

  it('Cargo.toml 启用 smoltcp feature（noTun 模式的前提）', () => {
    // noTun 时 EasyTier 走用户态协议栈；缺 smoltcp 会"启动了但连不上任何人"
    const cargoToml = fs.readFileSync(
      path.join(__dirname, '../../native/easytier-node/Cargo.toml'),
      'utf8',
    );
    expect(cargoToml).toContain('"smoltcp"');
  });
});
