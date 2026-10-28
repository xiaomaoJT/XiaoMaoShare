'use strict';
/**
 * 启动器：只负责把 Electron 拉起来。
 *
 * 为什么不直接写 `"desktop": "electron ."`：
 * 有些终端环境（IDE、 Electron 系的宿主程序）会带上 ELECTRON_RUN_AS_NODE=1，
 * 那样 electron 可执行文件会退化成一个纯 Node —— 于是 require('electron') 拿到的是
 * 一个路径字符串而不是 API，主进程在第一步就崩了，报「Cannot read properties of undefined」。
 * 这里先把这个变量摘掉再拉，用户从哪儿启动都不会踩这个坑。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const electronBin = require('electron'); // 在纯 Node 下，它返回的就是可执行文件路径
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [path.join(__dirname, '..')], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
child.on('error', (err) => {
  console.error('启动 Electron 失败：', err.message);
  console.error('先跑一次 `npm install` 把依赖装上。');
  process.exit(1);
});
