'use strict';
/**
 * XiaoMao 互传 · 桌面壳
 *
 * 这个文件只做三件事：
 *   1. 把 server.js 当模块拉起来，本机从此是一个「主机」；
 *   2. 主窗口指向 localhost（带主设备令牌），所以它天然是主控身份；
 *   3. 另外可以开出「连到别人」的窗口 —— 那边就是普通设备，走对方的接入授权。
 *
 * 于是同一个进程里两个角色并存：自己在对外提供服务，同时也能用别人的服务。
 * 两边是不同的窗口、不同的 origin、互不干扰；本机服务在后台一直跑，
 * 关掉界面不影响手机连进来。
 */

const { app, BrowserWindow, ipcMain, Menu, shell, clipboard, dialog } = require('electron');
const path = require('node:path');
const { once } = require('node:events');

/**
 * 数据目录必须在 require server.js 之前定好 —— 它在模块顶层就把 DATA_DIR 算出来了。
 * 打包后代码在只读的 asar 里，数据只能写用户目录。
 */
process.env.XM_DATA_DIR = process.env.XM_DATA_DIR || path.join(app.getPath('userData'), 'data');

const server = require('../server.js');

const IS_MAC = process.platform === 'darwin';
const DEFAULT_PORT = 6767;

let hostWin = null;   // 我自己的主机（主控）
let hostInfo = null;  // 启动后缓存的地址信息（端口、局域网地址）
const links = new Map(); // id -> { id, url, host, win }
let linkSeq = 0;
let quitting = false;

/* ------------------------------------------------------------ 地址处理 */

/**
 * 把用户随手输的东西整理成可用地址：
 *   「192.168.1.20」          → http://192.168.1.20:6767
 *   「192.168.1.20:8080」     → http://192.168.1.20:8080
 *   「https://a.b/c」         → 原样
 * 只放行 http / https —— 绝不能让它变成 file:// 或别的协议。
 */
function normalizeLink(input) {
  let s = String(input || '').trim();
  if (!s) return { error: '先填对方的地址，例如 192.168.1.20:6767' };
  if (s.length > 300) return { error: '地址太长了' };

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;

  let u;
  try { u = new URL(s); } catch { return { error: '这个地址看不懂，试试 192.168.1.20:6767' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: '只支持 http / https 地址' };
  if (!u.hostname) return { error: '地址里没有主机名' };
  // 对方多半用的就是默认端口，没写就补上，省得每次都要记
  if (!u.port && u.protocol === 'http:') u.port = String(DEFAULT_PORT);

  const url = u.origin + (u.pathname === '/' ? '' : u.pathname);
  return { url, host: u.host };
}

/** 是不是连到自己（同一个端口 + 本机名），那样只会绕回来 */
function isSelf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const mine = Number(hostInfo && hostInfo.port) || 0;
    if (Number(u.port || 80) !== mine) return false;
    return ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname) ||
      (hostInfo.lan || []).some((n) => n.address === u.hostname);
  } catch { return false; }
}

/* ------------------------------------------------------------ 窗口 */

function createHostWindow() {
  hostWin = new BrowserWindow({
    width: 1120,
    height: 840,
    minWidth: 640,
    minHeight: 520,
    title: 'XiaoMao 互传',
    backgroundColor: '#f4f6f9',
    show: false,
    // macOS 去掉系统标题栏，把红绿灯压进页面顶栏，App 感更强
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 16, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  hostWin.once('ready-to-show', () => hostWin.show());
  hostWin.loadURL(hostInfo.hostUrl);

  // 页面里想开新窗口（外链）一律交给系统浏览器，别在应用里长出一堆窗口
  hostWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关窗只是收起界面：主机还在跑，手机照样能传
  hostWin.on('closed', () => { hostWin = null; });

  return hostWin;
}

/** 主窗口可能被关掉了，任何「要跟用户说话」的动作都先把它叫回来 */
async function ensureHostWindow() {
  if (hostWin && !hostWin.isDestroyed()) {
    if (hostWin.isMinimized()) hostWin.restore();
    hostWin.show();
    hostWin.focus();
    return hostWin;
  }
  createHostWindow();
  if (hostWin.webContents.isLoading()) await once(hostWin.webContents, 'did-finish-load');
  return hostWin;
}

/**
 * 开一个「连到别人」的窗口。
 * 这个窗口不挂 preload：对面是别人的服务，不需要（也不该）拿到桌面 API。
 */
function openLink(rawUrl) {
  const n = normalizeLink(rawUrl);
  if (n.error) return n;
  if (isSelf(n.url)) return { error: '这是你自己这台机器的地址，不用连' };

  for (const [, l] of links) {
    if (l.url === n.url) {
      if (l.win.isMinimized()) l.win.restore();
      l.win.show();
      l.win.focus();
      return { ok: true, id: l.id, existed: true };
    }
  }

  const id = 'L' + (++linkSeq);
  const win = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 560,
    minHeight: 480,
    title: `连到 ${n.host}`,
    backgroundColor: '#f4f6f9',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,          // 对方页面是完全外部的内容，能收紧就收紧
      spellcheck: false,
    },
  });

  // 页面自己的 <title> 会覆盖窗口标题，这里按住，让人一眼看出「这是别人的主机」
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(`连到 ${n.host} — XiaoMao 互传`);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = 用户自己取消，不算失败
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(offlinePage(n.host)));
  });

  const rec = { id, url: n.url, host: n.host, win };
  links.set(id, rec);
  win.on('closed', () => {
    links.delete(id);
    broadcastLinks();
  });

  win.loadURL(n.url);
  broadcastLinks();

  // 地址可能记不住（对方换了 IP），存一份最近的，下次直接点
  rememberLink(n.url);
  return { ok: true, id };
}

/** 连不上时给一页人话，而不是 Electron 那句 ERR_CONNECTION_REFUSED */
function offlinePage(host) {
  return `<!doctype html><meta charset="utf-8"><title>连不上</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#f4f6f9;
       font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#3d4450}
  .box{max-width:400px;padding:28px;text-align:center}
  h1{font-size:17px;margin:0 0 10px}
  p{margin:0 0 8px;color:#6b7280}
  code{background:#eef1f6;padding:2px 6px;border-radius:5px;font-size:13px}
</style>
<div class="box">
  <h1>连不上 ${host.replace(/[<>&]/g, '')}</h1>
  <p>对方可能没开服务、或者已经不在同一个网络里。</p>
  <p>请确认 <code>${host.replace(/[<>&]/g, '')}</code> 能打开，再重试。</p>
</div>`;
}

/* ------------------------------------------------------- 最近连接记录 */

const RECENT_FILE = () => path.join(app.getPath('userData'), 'recent-links.json');

function readRecent() {
  try {
    const a = JSON.parse(require('node:fs').readFileSync(RECENT_FILE(), 'utf8'));
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 8) : [];
  } catch { return []; }
}

function rememberLink(url) {
  const list = [url, ...readRecent().filter((x) => x !== url)].slice(0, 8);
  try { require('node:fs').writeFileSync(RECENT_FILE(), JSON.stringify(list, null, 2)); } catch { /* 写不了就算了 */ }
}

/* ------------------------------------------------------------ 状态广播 */

function linkSnapshot() {
  return [...links.values()].map((l) => ({ id: l.id, url: l.url, host: l.host }));
}

function broadcastLinks() {
  const snap = linkSnapshot();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('desktop:links', snap);
  }
  buildMenu();
}

function desktopState() {
  const info = server.serverInfo();
  return {
    running: info.running,
    port: info.port,
    hostUrl: info.hostUrl,
    localUrl: info.localUrl,
    lan: info.lan,
    dataDir: info.dataDir,
    count: info.count,
    links: linkSnapshot(),
    recent: readRecent(),
  };
}

/* ------------------------------------------------------------ IPC */

ipcMain.handle('host:info', () => desktopState());

ipcMain.handle('link:connect', (_e, url) => openLink(url));

ipcMain.handle('link:close', (_e, id) => {
  const l = links.get(id);
  if (l) { l.win.close(); return { ok: true }; }
  return { error: '这个窗口已经关了' };
});

ipcMain.handle('link:focus', (_e, id) => {
  const l = links.get(id);
  if (!l) return { error: '这个窗口已经关了' };
  if (l.win.isMinimized()) l.win.restore();
  l.win.show(); l.win.focus();
  return { ok: true };
});

ipcMain.handle('host:copy', (_e, text) => {
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

/** 前端点「连接」时想先挑一下最近连过的，这个开关由主进程控制窗口 */
ipcMain.handle('link:forget', (_e, url) => {
  const list = readRecent().filter((x) => x !== url);
  try { require('node:fs').writeFileSync(RECENT_FILE(), JSON.stringify(list, null, 2)); } catch { /* ignore */ }
  return { ok: true, recent: list };
});

/* ------------------------------------------------------------ 菜单 */

function buildMenu() {
  const recent = readRecent();
  const opened = linkSnapshot();

  const linkItems = opened.length
    ? opened.map((l) => ({
        label: `连到 ${l.host}`,
        type: 'checkbox',
        checked: true,
        click: () => {
          const rec = links.get(l.id);
          if (!rec) return;
          if (rec.win.isMinimized()) rec.win.restore();
          rec.win.show(); rec.win.focus();
        },
      }))
    : [{ label: '（还没有连其他主机）', enabled: false }];

  const recentItems = recent.length
    ? recent.map((url) => ({
        label: url.replace(/^https?:\/\//, ''),
        click: () => openLink(url),
      }))
    : [{ label: '（连过一次之后会出现在这里）', enabled: false }];

  const tmpl = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: '我的主机',
      submenu: [
        { label: '显示主窗口', accelerator: 'CmdOrCtrl+1', click: () => ensureHostWindow() },
        { type: 'separator' },
        {
          label: '复制局域网地址',
          enabled: !!(hostInfo && hostInfo.lan.length),
          click: () => {
            const url = hostInfo && hostInfo.lan[0] && hostInfo.lan[0].url;
            if (!url) return;
            clipboard.writeText(url);
            dialog.showMessageBox({ message: '已复制', detail: url, buttons: ['好'], noLink: true });
          },
        },
        {
          label: '复制本机主控地址',
          click: () => { clipboard.writeText(server.serverInfo().hostUrl); },
        },
        { type: 'separator' },
        {
          label: '更改端口…',
          click: async () => {
            const cur = server.serverInfo().port || readPortPref() || DEFAULT_PORT;
            const p = await askPort(cur);
            if (!p || p === server.serverInfo().port) return;
            try {
              const info = await restartWithPort(p);
              dialog.showMessageBox({
                message: '已换到端口 ' + p,
                detail: '新的局域网地址：\n' +
                  (info.lan.length ? info.lan.map((n) => n.url).join('\n') : info.localUrl) +
                  '\n\n之前连过的设备要用新地址重新访问。',
                buttons: ['好'],
                noLink: true,
              });
            } catch (e) {
              dialog.showErrorBox('换端口失败', e.message + '\n\n已尝试恢复原端口。');
            }
          },
        },
        { type: 'separator' },
        {
          label: '打开数据目录',
          click: () => shell.openPath(server.DATA_DIR),
        },
        { type: 'separator' },
        { role: IS_MAC ? 'close' : 'quit', label: IS_MAC ? '关闭窗口（服务继续）' : '退出' },
      ],
    },
    {
      label: '连接其他主机',
      submenu: [
        {
          label: '连接其他主机…',
          accelerator: 'CmdOrCtrl+L',
          click: async () => {
            const w = await ensureHostWindow();
            w.webContents.send('desktop:open-connect');
          },
        },
        { type: 'separator' },
        ...linkItems,
        { type: 'separator' },
        { label: '最近连过', enabled: false },
        ...recentItems,
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '查看',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(tmpl));
}

/* ------------------------------------------------------- 端口偏好 */

/**
 * 用户上次选的端口记在 userData/settings.json。
 * 存的是「实际跑起来的端口」：6767 被占自动挪到 6768 的话，下次直接用 6768，
 * 地址才稳定——手机上存的书签不会隔天失效。
 */
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function readPortPref() {
  try {
    const s = JSON.parse(require('node:fs').readFileSync(SETTINGS_FILE(), 'utf8'));
    const p = Number(s && s.port);
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : 0;
  } catch { return 0; }
}

function writePortPref(port) {
  try {
    let s = {};
    try { s = JSON.parse(require('node:fs').readFileSync(SETTINGS_FILE(), 'utf8')) || {}; } catch { /* 覆盖就好 */ }
    s.port = port;
    require('node:fs').writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
  } catch { /* 写不了就算了，下次从头试 */ }
}

/**
 * 弹一个小窗让用户输入端口号，返回 Promise<number | null>（取消 = null）。
 * 启动彻底失败、或用户主动想换端口时用。
 */
function askPort(current) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); w.close(); } };

    const w = new BrowserWindow({
      width: 380,
      height: 190,
      parent: hostWin && !hostWin.isDestroyed() ? hostWin : undefined,
      modal: !!(hostWin && !hostWin.isDestroyed()),
      title: '选择端口',
      resizable: false,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;padding:18px 20px;font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#3d4450;background:#f4f6f9}
  label{font-weight:600}
  input{width:100%;box-sizing:border-box;margin-top:8px;height:36px;padding:0 10px;
        border:1px solid #d4d9e2;border-radius:8px;font-size:14px;outline:none;background:#fff}
  input:focus{border-color:#4c6ef5}
  .err{color:#c0392b;font-size:12px;min-height:18px;margin-top:4px}
  .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
  button{height:30px;padding:0 14px;border-radius:7px;border:1px solid #d4d9e2;
         background:#fff;color:#3d4450;font-size:12.5px;cursor:pointer}
  button.ok{background:#4c6ef5;border-color:#4c6ef5;color:#fff}
</style>
<label>服务端口号</label>
<input id="p" type="text" inputmode="numeric" value="${Number(current) || 6767}">
<div class="err" id="e"></div>
<div class="btns">
  <button id="c">取消</button>
  <button id="o" class="ok">确定</button>
</div>
<script>
  const i = document.getElementById('p'), e = document.getElementById('e');
  function submit(){
    const n = Number(i.value);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) { e.textContent = '端口要是 1–65535 的整数'; return; }
    // 把合法端口写进标题，主进程从 page-title-updated 里收
    document.title = 'PORT:' + n;
  }
  document.getElementById('o').onclick = submit;
  document.getElementById('c').onclick = () => window.close();
  i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
  i.focus(); i.select();
<\/script>`));

    // 校验和取值都在页面里做：输入合法后关闭窗口，主进程从 title 里拿结果最稳；
    // 这里改用「页面把合法端口写进 window.title」的方式传回
    w.webContents.on('page-title-updated', (e2, title) => {
      const m = /^PORT:(\d+)$/.exec(title || '');
      if (m) { e2.preventDefault(); w.setTitle(title); finish(Number(m[1])); }
    });
    w.on('closed', () => finish(null));
    w.once('ready-to-show', () => w.show());
  });
}

/** 换端口：停服 → 用新端口起 → 存偏好 → 主窗口跟着换地址 */
async function restartWithPort(p) {
  const old = server.serverInfo().port;
  await server.stopServer();
  try {
    hostInfo = await server.startServer({ port: p });
  } catch (err) {
    // 新端口没起来就把旧的拉回来，别让服务悬空
    if (old) { try { hostInfo = await server.startServer({ port: old }); } catch { /* 尽力而为 */ } }
    throw err;
  }
  writePortPref(hostInfo.port);
  buildMenu();
  if (hostWin && !hostWin.isDestroyed()) hostWin.loadURL(hostInfo.hostUrl);
  broadcastLinks();
  return hostInfo;
}

/* ------------------------------------------------------------ 生命周期 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { ensureHostWindow(); });

  app.whenReady().then(async () => {
    // 上次用过的端口优先（哪怕是被占用后自动挪过位的），地址才稳定
    const pref = readPortPref() || DEFAULT_PORT;
    let err = null;
    try {
      hostInfo = await server.startServer({ port: pref });
    } catch (e) {
      err = e;
    }

    // 起不来（端口段被占满、权限不够等）：给一次「换个端口重试」的机会，而不是直接死
    while (!hostInfo) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        title: '服务起不来',
        message: '端口被占用或不可用',
        detail: (err && err.message) + '\n\n可以换个端口再试，默认 6767。',
        buttons: ['换个端口', '退出'],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice !== 0) { app.exit(1); return; }
      const p = await askPort(pref);
      if (!p) { app.exit(1); return; }
      try {
        hostInfo = await server.startServer({ port: p });
      } catch (e) { err = e; }
    }

    writePortPref(hostInfo.port); // 记住实际跑起来的端口（可能因占用偏移过）
    buildMenu();
    createHostWindow();

    app.on('activate', () => { ensureHostWindow(); });
  });

  // macOS：关掉窗口不退程序，主机继续在后台跑（手机上还能传）
  // Windows / Linux：关掉就退，免得用户以为没退出
  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });

  // 退出前把端口放掉，别留下一个半死不活的监听
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    server.stopServer().finally(() => app.quit());
  });
}
