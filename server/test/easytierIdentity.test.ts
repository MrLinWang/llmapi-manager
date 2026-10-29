import { describe, expect, it } from 'vitest';
import { NetworkingRuntime, type NetworkingIdentityStore } from '../src/networking/runtime';
import { publicKeyFromPrivate } from '../src/networking/easytier/noiseXX';
import type { Logger } from '../src/logger';

/**
 * 组网身份的跨重启稳定性。
 *
 * 这是"自研引擎当主引擎"的必要条件：对端按 `noise_static_pubkey` 钉扎本机，
 * 重启换密钥会被当成另一个节点（或直接拒绝）。此前身份只存在进程内存里，
 * 每次 `new NetworkingRuntime(...)` 都是新身份。
 *
 * 测试用内存版 store 模拟"重启"：新建一个 runtime 但共享同一份存储，
 * 身份必须完全一致。
 */

function silentLogger(): Logger {
  const noop = (): void => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

/** 内存版身份存储，模拟落盘。 */
function memoryStore(): NetworkingIdentityStore & { saved: unknown } {
  let current: { peerId: number; staticPrivateKeyBase64: string } | null = null;
  return {
    get saved() {
      return current;
    },
    load: () => current,
    save: (identity) => {
      current = identity;
    },
  };
}

/** 通过一次启动把身份逼出来（身份在 start 时才生成）。 */
async function materializeIdentity(runtime: NetworkingRuntime): Promise<{
  peerId: number;
  publicKey: string;
}> {
  // 直接读内部身份：这里刻意用白盒，因为身份没有对外暴露的读取接口，
  // 而测试的目的正是验证"同一实例/新实例拿到同一身份"。
  const internal = runtime as unknown as {
    stableIdentity(): { peerId: number; staticPrivateKey: Buffer };
  };
  const identity = internal.stableIdentity();
  return {
    peerId: identity.peerId,
    publicKey: publicKeyFromPrivate(identity.staticPrivateKey).toString('base64'),
  };
}

describe('组网身份的持久化', () => {
  it('重启后身份完全一致（peerId 与公钥都不变）', async () => {
    const store = memoryStore();

    const first = new NetworkingRuntime(silentLogger(), store);
    const before = await materializeIdentity(first);

    // 模拟服务重启：新实例，共用同一份存储
    const second = new NetworkingRuntime(silentLogger(), store);
    const after = await materializeIdentity(second);

    expect(after.peerId).toBe(before.peerId);
    // 公钥是钉扎的依据，比私钥更适合断言（不泄漏私钥）
    expect(after.publicKey).toBe(before.publicKey);
  });

  it('没有存储时会生成并保存，而不是每次随机', async () => {
    const store = memoryStore();
    expect(store.saved).toBeNull();

    const runtime = new NetworkingRuntime(silentLogger(), store);
    const identity = await materializeIdentity(runtime);

    const saved = store.saved as { peerId: number; staticPrivateKeyBase64: string };
    expect(saved).not.toBeNull();
    expect(saved.peerId).toBe(identity.peerId);
    // 私钥是 32 字节的 base64
    expect(Buffer.from(saved.staticPrivateKeyBase64, 'base64').length).toBe(32);
  });

  it('同一实例多次取身份返回同一个', () => {
    const runtime = new NetworkingRuntime(silentLogger(), memoryStore());
    const internal = runtime as unknown as {
      stableIdentity(): { peerId: number; staticPrivateKey: Buffer };
    };
    const a = internal.stableIdentity();
    const b = internal.stableIdentity();
    expect(b.peerId).toBe(a.peerId);
    expect(b.staticPrivateKey.equals(a.staticPrivateKey)).toBe(true);
  });

  it('存储里的私钥长度不对时重新生成，不让服务崩掉', async () => {
    // 数据被破坏（比如有人手改了文件）时，正确做法是重生成 + 告警，
    // 而不是抛错让整个服务起不来。代价是对端钉扎失效，用户需要知道。
    const store: NetworkingIdentityStore = {
      load: () => ({ peerId: 12345, staticPrivateKeyBase64: Buffer.alloc(16).toString('base64') }),
      save: () => {},
    };
    const runtime = new NetworkingRuntime(silentLogger(), store);
    const identity = await materializeIdentity(runtime);
    // 没有沿用那个 16 字节的错误私钥
    expect(identity.peerId).not.toBe(12345);
  });

  it('peer_id 不会是 0 或 0xffffffff（这两个值在协议里有特殊含义）', () => {
    for (let i = 0; i < 20; i += 1) {
      const runtime = new NetworkingRuntime(silentLogger(), memoryStore());
      const internal = runtime as unknown as {
        stableIdentity(): { peerId: number };
      };
      const { peerId } = internal.stableIdentity();
      expect(peerId).not.toBe(0);
      expect(peerId).not.toBe(0xffffffff);
      expect(peerId).toBeGreaterThan(0);
    }
  });
});
