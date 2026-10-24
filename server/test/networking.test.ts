import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';
import { NetworkingRuntime } from '../src/networking/runtime';
import { defaultNetworkingConfig } from '../src/domain/networking';

/**
 * 设备互联的降级路径。
 *
 * 这一组的核心断言只有一条：**原生模块不在时，一切都不能炸**。
 * 本仓库的默认安装不含 `native/easytier-node/`（需要 Rust 工具链编译），
 * 所以"加载失败"不是异常场景，而是最常见的情况。
 *
 * 如果这里的行为退化成抛异常，`GET /api/networking/status` 会 500，
 * 前端页面直接报错——用户会以为整个服务坏了，而实际上只是没编译可选模块。
 */

function makeRuntime(): NetworkingRuntime {
  // error 级别：测试里不需要打日志
  return new NetworkingRuntime(createLogger('error'));
}

describe('设备互联：原生模块不可用时的降级', () => {
  it('availability 返回不可用并说明原因，不抛异常', () => {
    const runtime = makeRuntime();
    const availability = runtime.availability();

    // 测试环境没有编译原生模块，所以必然是 false
    expect(availability.available).toBe(false);
    expect(availability.reason).toBeTruthy();
    // 原因必须可操作：告诉用户"需要编译"以及"同步不受影响"
    expect(availability.reason).toContain('native/easytier-node');
    expect(availability.reason).toContain('同步');
  });

  it('status 在不可用时返回安全默认值而非抛错', async () => {
    const runtime = makeRuntime();
    const status = await runtime.status(defaultNetworkingConfig());

    expect(status.available).toBe(false);
    expect(status.running).toBe(false);
    expect(status.virtualIpv4).toBeNull();
    expect(status.peerCount).toBe(0);
    // enabled 仍然如实反映配置，而不是因为不可用就谎报 false
    expect(status.enabled).toBe(false);
  });

  it('peers 在不可用时返回空数组', async () => {
    const runtime = makeRuntime();
    await expect(runtime.peers()).resolves.toEqual([]);
  });

  it('stop 在不可用时是空操作，不抛错', async () => {
    const runtime = makeRuntime();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it('start 在不可用时抛出可读错误（这是唯一应该报错的入口）', async () => {
    const runtime = makeRuntime();
    // 启动是用户显式动作，必须让他知道为什么没成
    await expect(runtime.start(defaultNetworkingConfig())).rejects.toThrow(
      /native\/easytier-node|原生模块/,
    );
  });

  it('多次调用 availability 不会反复尝试加载（结果被缓存）', () => {
    const runtime = makeRuntime();
    // 加载失败也要缓存：反复 require 一个不存在的模块会拖慢每个请求
    const first = runtime.availability();
    const second = runtime.availability();
    expect(first).toEqual(second);
  });
});

describe('设备互联：参数校验', () => {
  // 这些校验在原生模块可用时才有意义，但逻辑本身可以先单独验：
  // 空网络名/空密钥会让节点加入失败，且 EasyTier 侧的报错不直观。

  it('默认配置指向官方公共中继且默认关闭', () => {
    const config = defaultNetworkingConfig();
    // 默认关闭：组网会创建 TUN 设备、需要权限，不该因为升级就自动开始
    expect(config.enabled).toBe(false);
    // 开箱可用：预填官方中继
    expect(config.peers).toContain('tcp://public.easytier.cn:11010');
    // 密钥默认为空，必须由用户显式设置
    expect(config.networkSecret).toBe('');
  });
});
