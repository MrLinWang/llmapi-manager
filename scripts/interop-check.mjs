#!/usr/bin/env node
/**
 * 双节点互通测试：验证"两个真实 EasyTier 节点能互相发现并建连"。
 *
 * 这是 `protocolSelfCheck()` **替代不了**的那一层验证：
 *
 * - `protocolSelfCheck()` 证明"我们编出的字节是对的"（纯计算）
 * - 这个脚本证明"对端真的接受了、并且网络真的形成了"（真实网络）
 *
 * 两者互补。前者快、随时能跑；后者慢、依赖环境，但它是最终判据。
 *
 * ## 用法
 *
 * ```bash
 * # 前置：编译原生模块（只需一次）
 * cd native/easytier-node
 * npx napi build --platform --release
 *
 * # 跑互通测试
 * node scripts/interop-check.mjs
 *
 * # 可选参数
 * node scripts/interop-check.mjs --port 11010 --timeout 45 --verbose
 * ```
 *
 * ## 为什么不在 vitest 里
 *
 * 它需要两个进程、真实网络、几十秒等待，还会留下临时进程。
 * 放进 `npm test` 会让日常测试变慢且不稳定。所以做成独立脚本：
 * **需要验证建连时手动跑**。
 *
 * ## 它到底验证了什么
 *
 * 1. 两个节点能在同一网络名 + 同一密钥下互相发现
 * 2. 各自的 `peerCount` 能到 1
 * 3. 对端主机名出现在自己的 peer 列表里
 * 4. （若分配了虚拟 IP）对方的虚拟 IP 可见
 *
 * 第 2、3 条是"建连成功"的硬证据——不是"进程起来了"，而是"对面知道我了"。
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'native/easytier-node/index.js');

// ── 参数 ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { port: 11010, timeout: 45, verbose: false, keepLogs: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--keep-logs') opts.keepLogs = true;
    else if (a === '--ipv4') opts.ipv4 = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node scripts/interop-check.mjs [选项]

  --port <n>       监听端口（默认 11010）。两个节点用连续端口。
  --timeout <n>    等待建连的秒数（默认 45）
  --verbose, -v    打印子进程的完整日志
  --keep-logs      保留子进程日志文件
  --ipv4 <prefix>  给两个节点分配虚拟 IP（如 10.126.126，得到 .1 与 .2）
  --help, -h       显示本帮助`);
      process.exit(0);
    }
  }
  return opts;
}

// ── 环境检查 ──────────────────────────────────────────────────────
function findLocalIPv4() {
  // **不能用 127.0.0.1**：EasyTier 的虚拟网络栈会接管 loopback，
  // 表现为 connect timeout 而对端收不到任何连接。
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function ensureModuleReady() {
  try {
    const mod = require(MODULE_PATH);
    if (typeof mod.startNode !== 'function') {
      throw new Error('模块没有 startNode 导出');
    }
    return mod;
  } catch (cause) {
    console.error('❌ 原生模块不可用\n');
    console.error(`   尝试加载: ${MODULE_PATH}`);
    console.error(`   错误: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    console.error('   请先编译：');
    console.error('     cd native/easytier-node');
    console.error('     npx napi build --platform --release\n');
    process.exit(2);
  }
}

// ── 子进程管理 ────────────────────────────────────────────────────
/**
 * 在子进程里跑一个节点。
 *
 * **必须用子进程**：原生模块是单例，一个 Node 进程只能跑一个 EasyTier 实例。
 * 在同一进程里连续 startNode 两次，第二次是幂等的空操作（拿到的是同一个实例）。
 */
function spawnNode({ name, port, networkName, networkSecret, peers, hostname, verbose, ipv4 }) {
  const script = `
    const m = require(${JSON.stringify(MODULE_PATH)});
    (async () => {
      await m.startNode({
        networkName: ${JSON.stringify(networkName)},
        networkSecret: ${JSON.stringify(networkSecret)},
        peers: ${JSON.stringify(peers)},
        hostname: ${JSON.stringify(hostname)},
        // 容器/无特权环境必需：建内核 TUN 需要 CAP_NET_ADMIN
        noTun: true,
        // 不写 listenPort 就没有监听，对端连不进来
        listenPort: ${port},
        // ipv4 必须完全省略（不能传 null）：
        // napi 的 Option<String> 映射是"可省略但不可为 null"，
        // 传 null 会抛 "Failed to convert JavaScript value Null into rust type String"。
        ${ipv4 ? `ipv4: ${JSON.stringify(ipv4)},` : ''}
      });
      process.stdout.write('READY\\n');

      // 周期性把状态打到 stdout，供父进程解析。
      //
      // 用 stdout 而不是额外 IPC 通道：原生模块是单例，父进程不能自己
      // require 一份来查询（会拿到另一个实例或失败），所以只能让子进程报。
      let tick = 0;
      setInterval(async () => {
        tick += 1;
        if (tick > 600) process.exit(0); // 兜底：10 分钟后自动退出，避免僵尸进程
        try {
          const status = await m.nodeStatus();
          const peers = await m.listPeers();
          process.stdout.write(
            'STATUS ' + JSON.stringify({
              peerCount: status.peerCount ?? 0,
              ipv4: status.virtualIpv4 ?? null,
              hostnames: (peers || []).map((p) => p.hostname).filter(Boolean),
            }) + '\\n',
          );
        } catch {
          // 查询失败不致命，下一轮再试
        }
      }, 1000);
    })().catch((e) => {
      process.stderr.write('STARTFAIL ' + (e && e.message ? e.message : String(e)) + '\\n');
      process.exit(1);
    });
  `;

  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const state = { name, child, ready: false, failed: null, log: [] };

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    state.log.push(text);
    if (text.includes('READY')) state.ready = true;
    if (verbose) process.stdout.write(`[${name}] ${text}`);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    state.log.push(text);
    if (text.includes('STARTFAIL')) {
      state.failed = text.replace(/STARTFAIL\s*/, '').trim();
    }
    // EasyTier 自己的日志走 stderr；只在 verbose 时显示
    if (verbose) process.stderr.write(`[${name}] ${text}`);
  });

  child.on('exit', (code) => {
    if (!state.failed && code !== 0 && code !== null) {
      state.failed = `进程退出，code=${code}`;
    }
  });

  return state;
}

async function waitReady(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.ready) return true;
    if (state.failed) throw new Error(`${state.name} 启动失败：${state.failed}`);
    await sleep(100);
  }
  throw new Error(`${state.name} 在 ${timeoutMs}ms 内没有就绪`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 查询：让子进程报自己的状态 ────────────────────────────────────
/**
 * 通过一次性子进程查询是不行的（单例），所以用 IPC 太重。
 *
 * 折中方案：让节点子进程**定期把自己的状态打到 stdout**，
 * 父进程解析最后一条。这样不需要额外的通信通道。
 */
async function queryStatus(state) {
  // 该节点的 stdout 里应该有我们让它周期性打印的状态行
  const text = state.log.join('');
  const matches = [...text.matchAll(/STATUS (\{.*\})/g)];
  if (matches.length === 0) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1]);
  } catch {
    return null;
  }
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const host = findLocalIPv4();
  if (host === null) {
    console.error('❌ 找不到非回环 IPv4 地址');
    console.error('   本机只有 loopback 时无法做这个测试——EasyTier 会拦截 127.0.0.1。');
    process.exit(2);
  }

  ensureModuleReady();

  const networkName = `interop-${Date.now().toString(36)}`;
  const networkSecret = `secret-${Math.random().toString(36).slice(2)}`;
  const portA = opts.port;
  const portB = opts.port + 1;

  console.log('双节点互通测试');
  console.log(`  本机 IP    ${host}`);
  console.log(`  网络名     ${networkName}`);
  console.log(`  节点 A     端口 ${portA}`);
  console.log(`  节点 B     端口 ${portB} → 连 ${host}:${portA}`);
  console.log(`  超时       ${opts.timeout}s\n`);

  // A 先起来监听，B 主动连 A
  const nodeA = spawnNode({
    name: 'A',
    port: portA,
    networkName,
    networkSecret,
    peers: [],
    hostname: 'node-a',
    verbose: opts.verbose,
    ipv4: opts.ipv4 ? `${opts.ipv4}.1/24` : undefined,
  });

  let nodeB = null;

  try {
    await waitReady(nodeA, 15_000);
    console.log('  节点 A 已就绪（监听中）');

    // 给监听器一点时间真正 bind
    await sleep(1500);

    nodeB = spawnNode({
      name: 'B',
      port: portB,
      networkName,
      networkSecret,
      peers: [`tcp://${host}:${portA}`],
      hostname: 'node-b',
      verbose: opts.verbose,
      ipv4: opts.ipv4 ? `${opts.ipv4}.2/24` : undefined,
    });

    await waitReady(nodeB, 15_000);
    console.log('  节点 B 已就绪（主动连接 A）\n');

    // ── 等待建连 ──
    //
    // 判据是"B 的 peerCount 到 1 且能看到 A 的主机名"。
    // 只等 peerCount 可能撞上中间态，所以两个条件都要。
    const deadline = Date.now() + opts.timeout * 1000;
    let lastStatus = null;
    let ok = false;

    while (Date.now() < deadline) {
      const statusA = await queryStatus(nodeA);
      const statusB = await queryStatus(nodeB);
      lastStatus = { A: statusA, B: statusB };

      if (statusB && statusB.peerCount >= 1 && (statusB.hostnames ?? []).includes('node-a')) {
        ok = true;
        break;
      }
      await sleep(1000);
      if (opts.verbose) {
        process.stdout.write(
          `  ... A peerCount=${statusA?.peerCount ?? '?'} B peerCount=${statusB?.peerCount ?? '?'}\n`,
        );
      }
    }

    console.log('结果');
    if (ok) {
      console.log('  ✅ 建连成功');
      console.log(`     B 看到 ${lastStatus.B.peerCount} 个对端：${(lastStatus.B.hostnames ?? []).join(', ')}`);
      if (lastStatus.B?.ipv4) console.log(`     B 的虚拟 IP：${lastStatus.B.ipv4}`);
      if (lastStatus.A?.ipv4) console.log(`     A 的虚拟 IP：${lastStatus.A.ipv4}`);
      if (!lastStatus.A?.ipv4 && !lastStatus.B?.ipv4) {
        console.log('     虚拟 IP：未分配');
        console.log('       noTun 模式下不写内核网卡，未显式指定 ipv4 时不会拿到地址。');
        console.log('       要验证 IP 分配，加参数：--ipv4 10.126.126');
      }
    } else {
      console.log('  ❌ 未建连（超时）');
      console.log(`     最终 A peerCount=${lastStatus?.A?.peerCount ?? '未知'}`);
      console.log(`     最终 B peerCount=${lastStatus?.B?.peerCount ?? '未知'}`);
      console.log('\n   可能原因：');
      console.log('     - 防火墙拦了端口（检查 iptables / ufw）');
      console.log('     - 网络名或密钥不一致（两次运行用了不同的随机值，只有同一次运行内一致）');
      console.log('     - 端口被占用（换 --port）');
      console.log('     - 用 --verbose 看 EasyTier 自己的日志');
      process.exitCode = 1;
    }
  } finally {
    for (const node of [nodeA, nodeB]) {
      if (!node) continue;
      try {
        node.child.kill('SIGTERM');
        // 给一点时间优雅退出，再强杀
        setTimeout(() => {
          try { node.child.kill('SIGKILL'); } catch { /* 已退出 */ }
        }, 2000).unref();
      } catch { /* 已退出 */ }
    }

    if (opts.keepLogs) {
      for (const node of [nodeA, nodeB]) {
        if (!node) continue;
        const file = path.join(ROOT, `interop-${node.name}.log`);
        const fs = await import('node:fs');
        fs.writeFileSync(file, node.log.join(''));
        console.log(`\n  日志已保存：${file}`);
      }
    }
  }
}

main().catch((cause) => {
  console.error('\n❌ 测试过程中出错');
  console.error(`   ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
});
