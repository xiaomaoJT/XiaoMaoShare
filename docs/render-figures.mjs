#!/usr/bin/env node
/**
 * 把 docs/client-figures.html 里的三张图渲染成 2x PNG。
 *
 *   node docs/render-figures.mjs
 *
 * 坑位备忘（本机验证过）：
 *  - headless Chrome 必须 --no-sandbox，否则 GPU/network 子进程沙箱初始化失败会静默退出、零产物
 *  - 输出文件先删，/tmp 残留旧图会顶替新产物造成「假绿」
 *  - 走 CDP：Emulation.setDeviceMetricsOverride(dsf=2) + Page.captureScreenshot(captureBeyondViewport)
 *  - Node 22 自带 WebSocket，不需要额外依赖（服务端保持零依赖）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(HERE, 'client-figures.html');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 960;
const OUT = [
  { hash: 'arch',   file: 'fig-architecture.png' },
  { hash: 'cap',    file: 'fig-capabilities.png' },
  { hash: 'matrix', file: 'fig-clients.png' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = 'file://' + HTML;

if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME);
if (!fs.existsSync(HTML)) throw new Error('找不到源稿：' + HTML);

for (const o of OUT) fs.rmSync(path.join(HERE, o.file), { force: true });

const port = 9300 + (process.pid % 400);
const profile = `/tmp/xmfig-chrome-${process.pid}`;
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--no-proxy-server', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  'about:blank',
], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
});
let chromeErr = '';
chrome.stderr.on('data', (b) => { chromeErr += String(b).slice(0, 2000); });

async function waitDevTools() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    if (chrome.exitCode !== null) throw new Error('Chrome 提前退出：\n' + chromeErr);
    await sleep(120);
  }
  throw new Error('Chrome DevTools 未就绪：\n' + chromeErr);
}

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = async (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
    const msg = JSON.parse(raw);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, send };
}

(async () => {
  await waitDevTools();
  const { ws, send } = await connect();

  await send('Page.enable');
  await send('Runtime.enable');

  for (const o of OUT) {
    await send('Page.navigate', { url: `${fileUrl}#${o.hash}` });
    // 同文档换 hash 可能不重跑 head 里的脚本，显式指定当前要显示哪一张
    await send('Runtime.evaluate', {
      expression: `document.documentElement.dataset.only = ${JSON.stringify(o.hash)}`,
    });
    // 等字体与布局完成
    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', {
        expression: 'document.readyState === "complete" && document.fonts.status === "loaded"',
        returnByValue: true,
      });
      if (r.result.value === true) break;
      await sleep(80);
    }
    await sleep(160);

    // 量「当前这张 fig」的实际高度，不能用 scrollHeight：
    // viewport 还留着上一张的高度时，body 会被撑到至少那么高，短图底部就多出一截空白
    const h = await send('Runtime.evaluate', {
      expression: `(() => {
        const f = [...document.querySelectorAll('.fig')].find(e => getComputedStyle(e).display !== 'none');
        return Math.ceil(f.getBoundingClientRect().height);
      })()`,
      returnByValue: true,
    });
    const height = Math.max(200, Number(h.result.value) || 800);

    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height, deviceScaleFactor: 2, mobile: false,
    });
    await sleep(180);

    const shot = await send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
    });
    const dest = path.join(HERE, o.file);
    fs.writeFileSync(dest, Buffer.from(shot.data, 'base64'));
    const bytes = fs.statSync(dest).size;
    console.log(`${o.file.padEnd(26)} ${WIDTH * 2}×${height * 2}px  ${(bytes / 1024).toFixed(0)} KB`);
  }

  ws.close();
  chrome.kill('SIGTERM');
  // Chrome 退出有延迟，目录可能还在被写；清不掉就算了，不影响产物
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
  console.log('完成：三张图已写入 docs/');
})().catch((err) => {
  console.error('渲染失败：', err.message);
  try { chrome.kill('SIGTERM'); } catch {}
  process.exit(1);
});
