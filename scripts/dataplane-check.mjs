#!/usr/bin/env node
/**
 * 数据面互通测试：验证数据**真的流过了虚拟网络**。
 *
 * # ⚠️ 状态：脚本逻辑完整，但当前环境下**无法通过**
 *
 * 结论来自一次对照实验（见下方"已排除"），不是推测：
 *
 * EasyTier 的 port-forward gateway 在**实例创建后不绑定监听端口**。
 * `set_port_forwards()` 写入成功且能回读（确认 1 条规则、地址正确），
 * 但 6 秒后目标端口仍 `Connection refused`，且日志里没有任何
 * gateway 相关输出——既没成功也没报错。
 *
 * ## 已排除（都做了实测）
 *
 * | 怀疑点 | 结果 |
 * | --- | --- |
 * | 我们的 `set_port_forwards` 调用方式 | 去掉原生模块、用纯 Rust 直接调，同样不绑定 |
 * | 配置没写进去 | 回读确认规则存在且地址正确 |
 * | `no_tun = true` 导致 | `no_tun` 为 true / false 都不绑定 |
 * | `smoltcp` feature 缺失 | `cargo tree` 确认 `proxy-smoltcp-stack` 已启用 |
 * | `gateway_enabled` / `startup_plan.gateway` 为 false | 源码里默认都是 true |
 * | 绑定慢（时序） | 等 17 秒仍不绑定 |
 *
 * ## 所以这个脚本现在的意义
 *
 * 它仍然是有用的：**在有可用 gateway 的环境里能直接跑通**。
 * 一旦上游修复或找到正确的启用方式，不需要改脚本。
 *
 * 在此之前，它跑起来会停在"转发端口未就绪"并给出排错提示——
 * 这是**如实反映**，不是脚本 bug。
 *
 * 若你要绕开这个限制验证数据面，需要真实 TUN 设备
 * （`noTun: false` + `CAP_NET_ADMIN` 或 root），然后直接 ping / TCP 连虚拟 IP。
 */
/**
 * （原说明保留如下）
 *
 * `interop-check.mjs` 只证明"两个节点互相看得见"（控制面）。
 * 这个脚本验证的是下一个层次：**字节能不能从一端走到另一端**。
 *
 * ## 为什么不用 ping
 *
 * 容器/无特权环境里没有 `CAP_NET_ADMIN`、也没有 `/dev/net/tun`，
 * `noTun: true` 模式下 EasyTier 不建内核网卡。此时：
 *
 * - `ping 10.126.126.1` → 网络不可达（根本没有那个网卡）
 * - `net.connect('10.126.126.1', 8080)` → 同样失败
 *
 * 所以不能用它们来判断"数据面通不通"——失败也只说明"没有网卡"，
 * 与虚拟网络本身无关。
 *
 * ## 改用端口转发
 *
 * EasyTier 的 gateway 支持把**本机端口**映射到**虚拟网络内的地址**，
 * 全在用户态完成，不需要 TUN：
 *
 * ```
 * 节点 A 监听虚拟网络里的 10.126.126.1:18080
 * 节点 B 配一条转发：127.0.0.1:18081 → 10.126.126.1:18080
 * 在 B 上访问 127.0.0.1:18081，流量经虚拟网络到达 A 的服务
 * ```
 *
 * 于是"数据面是否通畅"变成一个普通的 TCP 请求：取到响应就算通，
 * 拿不到就是不通。这比 ping 更接近真实用途（用户要传的就是 TCP 流量）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/dataplane-check.mjs
 * node scripts/dataplane-check.mjs --verbose        # 看 EasyTier 日志
 * node scripts/dataplane-check.mjs --size 1048576   # 传 1 MiB 验证吞吐
 * ```
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'native/easytier-node/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = {
    port: 11070,
    timeout: 45,
    verbose: false,
    size: 64 * 1024,
    vnet: '10.126.126',
    servicePort: 18080,
    forwardPort: 18081,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--size') opts.size = Number(argv[++i]);
    else if (a === '--vnet') opts.vnet = argv[++i];
    else if (a === '--service-port') opts.servicePort = Number(argv[++i]);
    else if (a === '--forward-port') opts.forwardPort = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node scripts/dataplane-check.mjs [选项]

  --port <n>           节点 A 的监听端口（默认 11070）
  --timeout <n>        等待建连 + 传输的秒数（默认 45）
  --size <bytes>       传输的数据量（默认 65536）
  --vnet <prefix>      虚拟网段前缀（默认 10.126.126，得到 .1 与 .2）
  --service-port <n>   节点 A 上被访问的服务端口（默认 18080）
  --forward-port <n>   节点 B 上的转发端口（默认 18081）
  --verbose, -v        打印子进程日志
  --help, -h           显示本帮助`);
      process.exit(0);
    }
  }
  return opts;
}

function findLocalIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function ensureModule() {
  try {
    const mod = require(MODULE_PATH);
    if (typeof mod.startNode !== 'function') throw new Error('没有 startNode 导出');
    return mod;
  } catch (cause) {
    console.error('❌ 原生模块不可用\n');
    console.error(`   ${cause instanceof Error ? cause.message : String(cause)}\n`);
    console.error('   先编译：cd native/easytier-node && npx napi build --platform --release');
    process.exit(2);
  }
}

/**
 * 起一个节点子进程。
 *
 * 依然必须是子进程：原生模块单例，一个 Node 进程只能跑一个实例。
 */
function spawnNode(opts) {
  const script = `
    const m = require(${JSON.stringify(MODULE_PATH)});
    (async () => {
      await m.startNode(${JSON.stringify(opts.nodeOptions)});
      process.stdout.write('READY\\n');
      let tick = 0;
      setInterval(async () => {
        tick += 1;
        if (tick > 900) process.exit(0);
        try {
          const s = await m.nodeStatus();
          const p = await m.listPeers();
          process.stdout.write('STATUS ' + JSON.stringify({
            peerCount: s.peerCount ?? 0,
            ipv4: s.virtualIpv4 ?? null,
            hostnames: (p || []).map((x) => x.hostname).filter(Boolean),
          }) + '\\n');
        } catch {}
      }, 1000);
    })().catch((e) => {
      process.stderr.write('STARTFAIL ' + (e && e.message ? e.message : String(e)) + '\\n');
      process.exit(1);
    });
  `;

  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { name: opts.name, child, ready: false, failed: null, log: [] };

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    state.log.push(text);
    if (text.includes('READY')) state.ready = true;
    if (opts.verbose) process.stdout.write(`[${opts.name}] ${text}`);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    state.log.push(text);
    if (text.includes('STARTFAIL')) state.failed = text.replace(/STARTFAIL\s*/, '').trim();
    if (opts.verbose) process.stderr.write(`[${opts.name}] ${text}`);
  });
  child.on('exit', (code) => {
    if (!state.failed && code !== 0 && code !== null) state.failed = `进程退出 code=${code}`;
  });

  return state;
}

async function waitReady(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.ready) return;
    if (state.failed) throw new Error(`${state.name} 启动失败：${state.failed}`);
    await sleep(100);
  }
  throw new Error(`${state.name} 未在 ${timeoutMs}ms 内就绪`);
}

function lastStatus(state) {
  const matches = [...state.log.join('').matchAll(/STATUS (\{.*\})/g)];
  if (matches.length === 0) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1]);
  } catch {
    return null;
  }
}

/**
 * 在节点 A 的**本机**端口上起一个回显服务。
 *
 * 注意它监听的是 `127.0.0.1`（本机回环），不是虚拟地址——
 * 虚拟地址在 `noTun` 模式下没有网卡绑定。A 的端口转发规则会把
 * 虚拟网络里对 `10.x.x.1:<servicePort>` 的访问桥接到这个本机端口。
 *
 * 协议：客户端发 `SIZE <n>\n`，服务端回 n 字节伪随机数据。
 * 这样能验证"大量数据双向流动且内容正确"，而不只是"能连上"。
 */
function startEchoService(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (buf) => {
        const text = buf.toString();
        const match = /SIZE (\d+)/.exec(text);
        if (match) {
          const size = Number(match[1]);
          // 用确定性算法生成，客户端能独立算出期望值
          const payload = Buffer.alloc(size);
          for (let i = 0; i < size; i += 1) payload[i] = i % 251;
          socket.write(payload);
        }
      });
      socket.on('error', () => { /* 客户端断开是正常的 */ });
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** 通过转发端口请求数据，返回收到的字节数。 */
function fetchThroughForward(port, size, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    let received = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`超时：${timeoutMs}ms 内只收到 ${received}/${size} 字节`));
    }, timeoutMs);

    socket.on('connect', () => socket.write(`SIZE ${size}\n`));
    socket.on('data', (buf) => {
      chunks.push(buf);
      received += buf.length;
      if (received >= size) {
        clearTimeout(timer);
        socket.destroy();
        resolve(Buffer.concat(chunks));
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const host = findLocalIPv4();
  if (host === null) {
    console.error('❌ 找不到非回环 IPv4 地址（EasyTier 会拦截 127.0.0.1）');
    process.exit(2);
  }
  ensureModule();

  const networkName = `dataplane-${Date.now().toString(36)}`;
  const networkSecret = `secret-${crypto.randomBytes(8).toString('hex')}`;
  const portA = opts.port;
  const portB = opts.port + 1;
  const ipA = `${opts.vnet}.1`;
  const ipB = `${opts.vnet}.2`;

  console.log('数据面互通测试');
  console.log(`  本机 IP     ${host}`);
  console.log(`  网络名      ${networkName}`);
  console.log(`  节点 A      ${ipA} / 端口 ${portA}`);
  console.log(`  节点 B      ${ipB} / 端口 ${portB}（连 A）`);
  console.log(`  服务        A 上 127.0.0.1:${opts.servicePort}`);
  console.log(`  转发        B 上 127.0.0.1:${opts.forwardPort} → ${ipA}:${opts.servicePort}`);
  console.log(`  传输量      ${opts.size} 字节\n`);

  // A 上的服务先起来（在宿主进程里，不是 EasyTier 子进程里）
  let service;
  try {
    service = await startEchoService(opts.servicePort);
  } catch (cause) {
    console.error(`❌ 无法在 127.0.0.1:${opts.servicePort} 起服务：${cause.message}`);
    console.error('   端口可能被占用，换 --service-port。');
    process.exit(2);
  }

  const common = {
    networkName,
    networkSecret,
    noTun: true,
  };

  const nodeA = spawnNode({
    name: 'A',
    verbose: opts.verbose,
    nodeOptions: {
      ...common,
      peers: [],
      hostname: 'node-a',
      listenPort: portA,
      ipv4: `${ipA}/24`,
    },
  });

  let nodeB = null;

  try {
    await waitReady(nodeA, 15_000);
    console.log('  节点 A 就绪');
    await sleep(1500);

    nodeB = spawnNode({
      name: 'B',
      verbose: opts.verbose,
      nodeOptions: {
        ...common,
        peers: [`tcp://${host}:${portA}`],
        hostname: 'node-b',
        listenPort: portB,
        ipv4: `${ipB}/24`,
        // B 侧的转发：本机 127.0.0.1:forwardPort → 虚拟网络里的 A:servicePort
        portForwards: [`127.0.0.1:${opts.forwardPort}->${ipA}:${opts.servicePort}`],
      },
    });
    await waitReady(nodeB, 15_000);
    console.log('  节点 B 就绪（带转发规则）\n');

    // ── 等待控制面建连 ──
    const connectDeadline = Date.now() + opts.timeout * 1000;
    let connected = false;
    while (Date.now() < connectDeadline) {
      const sb = lastStatus(nodeB);
      if (sb && sb.peerCount >= 1 && (sb.hostnames ?? []).includes('node-a')) {
        connected = true;
        break;
      }
      await sleep(1000);
    }

    if (!connected) {
      console.log('结果');
      console.log('  ❌ 控制面未建连，无法测试数据面');
      console.log(`     B peerCount=${lastStatus(nodeB)?.peerCount ?? '未知'}`);
      console.log('     先用 scripts/interop-check.mjs --verbose 排查建连问题');
      process.exitCode = 1;
      return;
    }
    console.log('  控制面已建连（B 看到 node-a）');

    // 转发规则生效需要一点时间（gateway 要 bind 本机端口）
    let forwarded = false;
    const forwardDeadline = Date.now() + 10_000;
    while (Date.now() < forwardDeadline) {
      forwarded = await new Promise((resolve) => {
        const probe = net.connect(opts.forwardPort, '127.0.0.1');
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', () => resolve(false));
      });
      if (forwarded) break;
      await sleep(500);
    }

    if (!forwarded) {
      console.log('\n结果');
      console.log(`  ❌ 转发端口未就绪（127.0.0.1:${opts.forwardPort} 连不上）`);
      console.log('     可能原因：');
      console.log('       - portForwards 格式不对（应是 "<bind>-><dst>"）');
      console.log('       - 端口被占用');
      console.log('       - Gateway 未启用（检查 --verbose 日志）');
      process.exitCode = 1;
      return;
    }
    console.log(`  转发端口就绪（127.0.0.1:${opts.forwardPort}）`);

    // ── 真正传数据 ──
    console.log(`\n  开始传输 ${opts.size} 字节……`);
    const started = Date.now();
    let payload;
    try {
      payload = await fetchThroughForward(opts.forwardPort, opts.size, opts.timeout * 1000);
    } catch (cause) {
      console.log('\n结果');
      console.log('  ❌ 数据未能通过虚拟网络传输');
      console.log(`     ${cause.message}`);
      console.log('     转发端口能连上但取不到数据，通常意味着：');
      console.log('       - 虚拟网络路由未收敛（再多等一会）');
      console.log('       - 目标服务不在 A 的虚拟地址上');
      process.exitCode = 1;
      return;
    }
    const elapsed = Date.now() - started;

    // ── 校验内容 ──
    let contentOk = payload.length === opts.size;
    if (contentOk) {
      for (let i = 0; i < payload.length; i += 1) {
        if (payload[i] !== i % 251) { contentOk = false; break; }
      }
    }

    console.log('\n结果');
    console.log('  ✅ 数据成功通过虚拟网络传输');
    console.log(`     收到 ${payload.length} 字节，耗时 ${elapsed}ms`);
    if (elapsed > 0) {
      const kbps = Math.round((payload.length / 1024 / elapsed) * 1000);
      console.log(`     约 ${kbps} KiB/s`);
    }
    console.log(`     内容校验：${contentOk ? '✅ 一致' : '❌ 不一致（数据被损坏）'}`);
    if (!contentOk) process.exitCode = 1;
  } finally {
    service?.close();
    for (const node of [nodeA, nodeB]) {
      if (!node) continue;
      try {
        node.child.kill('SIGTERM');
        setTimeout(() => {
          try { node.child.kill('SIGKILL'); } catch { /* 已退出 */ }
        }, 2000).unref();
      } catch { /* 已退出 */ }
    }
  }
}

main().catch((cause) => {
  console.error('\n❌ 测试过程中出错');
  console.error(`   ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
});
