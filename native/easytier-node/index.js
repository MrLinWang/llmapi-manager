// 原生模块的加载器。
//
// napi-rs 在正式 `napi build` 时会生成这样一个文件；这里手写精简版，
// 好处是**加载失败能给出可操作的错误**，而不是让上层只看到
// "Cannot find module"。
//
// 判定顺序：先找本平台编译好的 .node，找不到就说明"没编译"——
// 这是最常见的情况（默认安装不带 Rust 工具链），不是异常。

'use strict';

const path = require('node:path');
const fs = require('node:fs');

/** 本平台二进制的文件名。新增平台时在这里加一行。 */
function binaryName() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'easytier-node.linux-x64-gnu.node';
  if (platform === 'linux' && arch === 'arm64') return 'easytier-node.linux-arm64-gnu.node';
  if (platform === 'darwin' && arch === 'arm64') return 'easytier-node.darwin-arm64.node';
  if (platform === 'darwin' && arch === 'x64') return 'easytier-node.darwin-x64.node';
  if (platform === 'win32' && arch === 'x64') return 'easytier-node.win32-x64-msvc.node';
  return null;
}

function load() {
  const name = binaryName();
  if (name === null) {
    throw new Error(
      `设备互联不支持当前平台 ${process.platform}/${process.arch}。` +
        '可用的目标见 package.json 的 napi.targets。',
    );
  }

  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `原生模块未编译：找不到 ${name}。` +
        '请在 native/easytier-node 下执行 `npx napi build --platform --release`（需要 Rust 工具链）。' +
        '未编译不影响配置同步功能，只是设备互联不可用。',
    );
  }
  return require(file);
}

module.exports = load();
