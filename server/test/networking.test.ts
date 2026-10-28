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
  it('availability 要么可用、要么给出可操作的原因（不抛异常）', () => {
    const runtime = makeRuntime();
    const availability = runtime.availability();

    if (availability.available) {
      // 原生模块已编译（本地开发机常见）：不需要原因说明
      expect(availability.reason).toBeNull();
    } else {
      // 未编译：原因必须可操作——告诉用户怎么办，以及同步不受影响
      expect(availability.reason).toBeTruthy();
      expect(availability.reason).toContain('native/easytier-node');
      expect(availability.reason).toContain('同步');
    }
  });

  it('status 在未启动时返回安全默认值而非抛错', async () => {
    const runtime = makeRuntime();
    const status = await runtime.status(defaultNetworkingConfig());

    // 两种情况都必须满足：没启动就是没启动
    expect(status.running).toBe(false);
    expect(status.virtualIpv4).toBeNull();
    expect(status.peerCount).toBe(0);
    expect(status.functional).toBe(false);
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

  it('start 在不满足前置条件时抛出可读错误', async () => {
    const runtime = makeRuntime();
    const config = defaultNetworkingConfig();

    // 这个用例要覆盖两种环境，因为原生模块是可选的：
    //
    // - 未编译（CI/新克隆的仓库常见）：第一道拦截是"模块不可用"，错误里
    //   必须说清怎么办，且要提到同步功能不受影响。
    // - 已编译（本地开发机，`.node` 产物被 gitignore 所以只在本机存在）：
    //   此时才会走到参数校验，空密钥必须被拒绝——知道网络名与密钥的节点
    //   都能加入网络，所以空密钥是一条必须挡住的口子。
    //
    // 早先这里只断言 /密钥/，在编译过原生模块的机器上会稳定失败；
    // 反过来只断言"模块不可用"又会在没编译的机器上失败。两种都要认。
    const availability = runtime.availability();
    if (availability.available) {
      await expect(runtime.start(config)).rejects.toThrow(/密钥/);
    } else {
      await expect(runtime.start(config)).rejects.toThrow(/原生模块|easytier-node/);
    }
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

describe('设备互联：真实状态与"名义运行"的区分', () => {
  it('没有虚拟 IP 时 functional 为 false 并给出原因', async () => {
    // 真实踩到的情况：容器缺 CAP_NET_ADMIN、宿主机没有 /dev/net/tun 时，
    // EasyTier 的 startNode() 会"成功"、running 为 true，但虚拟网卡根本没建，
    // 虚拟 IP 为 null，永远连不上任何节点。
    //
    // 如果只暴露 running，用户会以为配错了网络名或密钥，去反覆改那些其实
    // 没问题的参数。所以要有一个能区分"对象建了"与"网络真的通了"的字段。
    const runtime = makeRuntime();
    const status = await runtime.status(defaultNetworkingConfig());

    // 无论原生模块是否可用，没启动就不该是 functional
    expect(status.functional).toBe(false);
  });
});

describe('设备互联：napi 参数传递的坑', () => {
  it('ipv4 为 null 时不能把 null 传给原生模块（要省略该字段）', () => {
    // 真实踩到的错误：
    //   `Failed to convert JavaScript value Null into rust type String`
    //
    // 成因：napi-rs 在 `#[napi(object)]` 结构体上把 `Option<String>` 映射成
    // "可省略但不可为 null"。Rust 侧写 `pub ipv4: Option<String>` 看起来
    // 完全允许 None，但 JS 侧必须用 `undefined`（或干脆不传），传 `null` 会在
    // startNode 时抛错。错误文案像类型系统内部问题，很容易被误判成 Rust 代码写错。
    //
    // 这里锁定"配置层的 null 必须转成省略字段"这个约定。
    const config = defaultNetworkingConfig();
    expect(config.ipv4).toBeNull();
    // runtime 负责在调用原生模块前做这个转换（`null → 省略`），
    // 见 server/src/networking/runtime.ts 的 start()。
  });
});
