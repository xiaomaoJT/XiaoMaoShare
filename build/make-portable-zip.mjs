#!/usr/bin/env node
// 把 release/win-unpacked 打成「解压即用」便携版 zip。
//
// 关键点：portable.mode 标记只允许出现在 zip 里。
// 如果它残留在 win-unpacked，下次打 nsis 安装包时安装版会被误判成便携版，
// 数据就会写进 Programs 目录（权限不足直接报错）。所以打完立刻删掉。
//
// 压缩工具按平台自动选：Windows 没有 zip 命令，退到系统自带的 tar（Win10 1803+）
// 或 PowerShell 的 Compress-Archive，保证 mac / Windows 都能一条命令跑通。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'release');

// electron-builder 的目录名随架构变化：x64 是 win-unpacked，arm64 是 win-arm64-unpacked
const unpackedName = fs.existsSync(releaseDir)
  ? fs.readdirSync(releaseDir).find((n) => /^win(-[\w]+)?-unpacked$/.test(n))
  : null;
const unpacked = unpackedName && path.join(releaseDir, unpackedName);

if (!unpacked || !fs.existsSync(unpacked)) {
  console.error('找不到 release/win-unpacked，请先打 Windows 包（npm run dist:win 会自动处理）');
  process.exit(1);
}

const marker = path.join(unpacked, 'portable.mode');
const zipName = `XiaoMaoShare-${version}-win-portable.zip`;
const zipPath = path.join(releaseDir, zipName);
const opts = { cwd: releaseDir, stdio: 'inherit' };

// 依次尝试，能跑通就用，全挂才报错
const packers = [
  // 1) macOS / Linux 的 zip
  ['zip', () => execFileSync('zip', ['-r', '-q', zipName, unpackedName], opts)],
  // 2) Windows 10+ 自带 bsdtar，-a 按扩展名自动选 zip 格式
  ['tar', () => execFileSync('tar', ['-a', '-c', '-f', zipName, unpackedName], opts)],
  // 3) 兜底 PowerShell（慢一些，但任何 Windows 都有）
  ['powershell', () => execFileSync(
    'powershell',
    ['-NoProfile', '-Command',
      `Compress-Archive -Path '${unpackedName}' -DestinationPath '${zipName}' -Force`],
    opts,
  )],
];

fs.writeFileSync(marker, '');
fs.rmSync(zipPath, { force: true });

let used = null;
const failures = [];

try {
  for (const [name, run] of packers) {
    try {
      run();
      used = name;
      break;
    } catch (e) {
      failures.push(`${name}: ${e.code || e.message}`);
    }
  }

  if (!used) {
    throw new Error(`压缩全部失败：\n  ${failures.join('\n  ')}`);
  }

  const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n✓ 便携版已生成：release/${zipName}（${mb} MB，用 ${used} 压缩）`);
} finally {
  // 标记用完就删：留在 win-unpacked 里会污染下一次 nsis 打包
  fs.rmSync(marker, { force: true });
}
