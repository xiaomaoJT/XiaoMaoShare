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

const { app, BrowserWindow, ipcMain, Menu, Tray, shell, clipboard, dialog, nativeImage, screen, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { once } = require('node:events');

/**
 * 数据目录必须在 require server.js 之前定好 —— 它在模块顶层就把 DATA_DIR 算出来了。
 * 默认落到 userData/data（打包后代码在只读的 asar 里，数据只能写用户目录）；
 * 但用户可以在设置里改到任意目录（比如沿用 启动.bat 那份 data），这里优先读那个偏好。
 */
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function readDataDirPref() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    return s && typeof s.dataDir === 'string' && s.dataDir ? s.dataDir : '';
  } catch { return ''; }
}

function writeDataDirPref(dir) {
  try {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) || {}; } catch { /* 覆盖就好 */ }
    s.dataDir = dir;
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
  } catch { /* 写不了就算了 */ }
}

/** 一个目录看着像不像我们的数据目录（里面有没有熟悉的标记文件） */
function looksLikeOurData(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    const names = fs.readdirSync(dir);
    return ['index.json', 'accounts.json', 'host.json', 'profiles.json', 'settings.json', 'devices.json']
      .some((n) => names.includes(n)) || names.includes('files');
  } catch { return false; }
}

// 免安装版（portable）数据放在 exe 旁边的 data/ 下，U 盘拷走即整套带走。
// 两种「免安装」分发形态都识别：
//   1) electron-builder 的 SFX 自解压包会注入 PORTABLE_EXECUTABLE_DIR（指向临时解压目录）
//   2) 我们另发的「解压即用」zip 包：在 exe 同级放一个 portable.mode 标记文件来识别
//      （标记不进 nsis 安装包，避免安装版被误判成便携版而把数据写进 Programs 目录）
const EXE_DIR = app.isPackaged ? path.dirname(app.getPath('exe')) : '';
const PORTABLE_ROOT = process.env.PORTABLE_EXECUTABLE_DIR
  || (EXE_DIR && fs.existsSync(path.join(EXE_DIR, 'portable.mode')) ? EXE_DIR : '');

// 免安装版把数据放在 exe 旁边的 data/；其余仍落 userData
process.env.XM_DATA_DIR = readDataDirPref() ||
  (PORTABLE_ROOT ? path.join(PORTABLE_ROOT, 'data') : path.join(app.getPath('userData'), 'data'));

const server = require('../server.js');
// 类型判定跟网页端共用一份（同一套后缀表），别在这里再抄一遍
const fileType = require('../public/filetype.js');

const IS_MAC = process.platform === 'darwin';
const DEFAULT_PORT = 6767;

let hostWin = null;   // 我自己的主机（主控）
let guideWin = null;  // 数据目录引导窗
let hostInfo = null;  // 启动后缓存的地址信息（端口、局域网地址）
const links = new Map(); // id -> { id, url, host, win }
let linkSeq = 0;
let quitting = false;

let tray = null;          // 系统托盘 / 菜单栏图标；建不起来时为 null（Linux 缺 appindicator 之类）
let closeAsking = false;  // 关闭确认框只允许存在一个，连点红叉不会叠出一串
let trayHintShown = false; // 「已收进托盘」的气泡只在第一次提示，之后不再打扰

let ballWin = null;       // 悬浮球窗口
let ballOpen = false;     // 面板是否展开（展开时窗口变大）
let ballAnchor = null;    // 球的屏幕位置（收起时就是窗口位置，展开时是窗口内的球位换算出来的）
let ballGeo = null;       // 上一次算出来的展开布局，拖动时用它把窗口位移换算回球位
let ballCid = '';         // 主窗口上报的设备身份，球的请求靠它拿权限
let ballBase = '';        // 主窗口上报的 origin（连别人时是对方的地址）
let ballLastFocus = null; // 最近用的是哪个窗口：{ kind:'host' } / { kind:'link', id }
let ballPinCache;         // 手动选定的目标（undefined = 还没从设置里读过）
let ballDiscPx = 64;      // 当前球体直径（跟着设置走）
let ballBoxPx = 84;       // 当前球窗口边长 = 球体 + 一圈给阴影留的空白

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

/**
 * 启动页：双击后立刻显示，不依赖本地服务器是否已起好。
 * 它身兼三职：加载动画、启动方式选择、以及「服务没起时」的选择入口。
 */
const START_PAGE = path.join(__dirname, 'start.html');

/**
 * 应用图标。每个窗口都要显式挂上 —— 不挂的话，窗口标题栏和任务栏会退回
 * electron.exe 自带的默认图标：打包后 exe 有自己的图标能盖住，`npm run desktop`
 * 开发模式盖不住，一眼就是 Electron。mac 上窗口没有图标位，改用 Dock 图标。
 */
const APP_ICON = path.join(__dirname, '..', 'public', 'icon.png');

/** 读整个 settings.json（各偏好共用一个文件） */
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) || {}; } catch { return {}; }
}

/** 合并写几个键，其余键保持不动 */
function updateSettings(patch) {
  try {
    const s = { ...readSettings(), ...patch };
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
  } catch { /* 写不了就算了 */ }
}

/**
 * 校验保存下来的窗口几何：数值要齐全，且至少 1/4 面积落在某块屏幕的工作区内。
 * 防两种坏数据：手改坏 settings.json；拔掉外接显示器后窗口还原到屏幕外。
 */
function validWindowBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  if (b.width < 400 || b.height < 300) return null;
  try {
    const work = screen.getDisplayMatching(b).workArea;
    const ix = Math.max(0, Math.min(b.x + b.width, work.x + work.width) - Math.max(b.x, work.x));
    const iy = Math.max(0, Math.min(b.y + b.height, work.y + work.height) - Math.max(b.y, work.y));
    return ix * iy >= (b.width * b.height) / 4 ? b : null;
  } catch { return null; }
}

function createHostWindow() {
  // 恢复上次的大小与位置；最大化状态单独记，还原态的几何始终保留一份
  const saved = validWindowBounds(readSettings().windowBounds);
  const bounds = saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
                       : { width: 1120, height: 840 };

  hostWin = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 520,
    title: 'XiaoMao 互传',
    icon: APP_ICON,
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

  if (saved && saved.isMaximized) hostWin.maximize();

  // 先显示启动页（不依赖本地服务器，双击后立即有反馈），服务就绪后再换真实页
  if (hostInfo) hostWin.loadURL(hostInfo.hostUrl); // 窗口重建时服务已在跑，直接进真实页，不必闪一下启动页
  else hostWin.loadFile(START_PAGE);
  hostWin.show();

  // 记住窗口大小与位置：拖动/缩放中只更新内存里的还原态，防抖 400ms 落盘；
  // 最大化、全屏、最小化时的瞬时几何不记录，还原态始终是上一次「正常」的样子
  let lastNormal = saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : null;
  let boundsTimer = null;
  const captureNormal = () => {
    if (!hostWin || hostWin.isDestroyed()) return;
    if (hostWin.isMinimized() || hostWin.isMaximized() || hostWin.isFullScreen()) return;
    lastNormal = hostWin.getBounds();
  };
  const saveBounds = (final) => {
    captureNormal();
    clearTimeout(boundsTimer);
    if (!final) { boundsTimer = setTimeout(saveBounds, 400); return; }
    if (lastNormal && hostWin && !hostWin.isDestroyed()) {
      updateSettings({ windowBounds: { ...lastNormal, isMaximized: hostWin.isMaximized() } });
    }
  };
  hostWin.on('resize', () => saveBounds(false));
  hostWin.on('move', () => saveBounds(false));
  hostWin.on('close', (e) => {
    saveBounds(true);
    handleHostClose(e);
  });

  // 页面里想开新窗口（外链）一律交给系统浏览器，别在应用里长出一堆窗口
  hostWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关窗只是收起界面：主机还在跑，手机照样能传
  hostWin.on('closed', () => { hostWin = null; });

  // 悬浮球「跟随最近用的窗口」靠这个：点过哪个窗口，球就发给谁
  hostWin.on('focus', () => noteBallFocus('host'));

  return hostWin;
}

/**
 * 主窗口可能被关掉了，也可能在「连接模式」下被藏起来了 ——
 * 任何「要跟用户说话」的动作都先把它叫回来。
 * 如果它还停在启动页而服务已经在跑，顺手补一次跳转，别让用户看到一张过期的选择页。
 */
async function ensureHostWindow() {
  if (hostWin && !hostWin.isDestroyed()) {
    if (hostWin.isMinimized()) hostWin.restore();
    hostWin.show();
    hostWin.focus();
    const u = String(hostWin.webContents.getURL());
    if (u.startsWith('file:')) {
      const inf = server.serverInfo();
      if (inf.running) {
        // 服务在跑：直接进真实界面，别让用户看到一张过期的启动页
        hostInfo = inf;
        hostWin.loadURL(inf.hostUrl);
      } else if (!u.includes('force=1')) {
        // 服务没跑：记过启动方式就按记忆重新走一遍（连上次那台 / 起本机服务），
        // 只有「每次问我」才亮选择页 —— 记了「直接连」还天天被问，等于没记
        if (!runStartPref()) hostWin.loadFile(START_PAGE, { query: { force: '1' } });
      }
    }
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
    icon: APP_ICON,
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

  // 这是最后一个可见窗口时，点关闭 = 整个应用「消失」进托盘 —— 得和主窗口一个待遇：
  // 「每次问我」就问一句，别闷声把界面全收走（用户会以为程序退了，连问都不问）
  let linkForceClose = false;
  win.on('close', (e) => {
    if (quitting || linkForceClose) return;
    const otherVisible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w !== win && w.isVisible());
    if (otherVisible || !tray) return;   // 还有别的窗口看着，或没托盘可收：照常关
    const policy = readClosePref();
    if (policy === 'quit') { e.preventDefault(); setImmediate(() => app.quit()); return; }
    e.preventDefault();
    const parkAndClose = () => { linkForceClose = true; win.close(); notifyTrayParked(); };
    if (policy === 'tray') { parkAndClose(); return; }
    askCloseChoice(parkAndClose);
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = 用户自己取消，不算失败
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(offlinePage(n.host)));
  });

  const rec = { id, url: n.url, host: n.host, win, cid: '' };
  links.set(id, rec);
  // 刚开出来的连接窗口多半就是用户接下来在用的窗口 —— 球默认跟着它
  noteBallFocus('link', id);
  win.on('focus', () => noteBallFocus('link', id));
  win.on('closed', () => {
    links.delete(id);
    broadcastLinks();
    // 球正指着这台就把记忆清掉，下次按「最近用的窗口」重新算
    if (ballLastFocus && ballLastFocus.kind === 'link' && ballLastFocus.id === id) noteBallFocus('host');
    const pin = ballPinRead();
    if (pin && pin.kind === 'link' && String(pin.url || '').replace(/\/+$/, '') === n.url.replace(/\/+$/, '')) {
      ballPinWrite(null);
    }
    // 「只连别人」时主窗口是藏着的，关掉这个窗口不会触发 window-all-closed，
    // 得自己判断一次，否则会留下一个看不见却在后台常驻的进程
    quitIfNoVisibleWindow();
  });

  win.loadURL(n.url);

  // 连接窗口不挂 preload（对方页面不该拿到桌面 API），但悬浮球要替这台主机
  // 发东西，就必须用对方授权过的设备 cid —— 页面把它存在 localStorage('xm.cid')，
  // 这里读出来记在 rec 上（只进主进程内存，不回传给对方页面）。
  // 缺了这一步，球只能用自己兜底的陌生 cid，对方会判成「设备未授权」。
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript("localStorage.getItem('xm.cid')||''", true)
      .then((cid) => {
        cid = String(cid || '');
        if (/^[A-Za-z0-9_-]{3,64}$/.test(cid) && cid !== rec.cid) {
          rec.cid = cid;
          refreshBallTarget();
        }
      })
      .catch(() => { /* 页面还没准备好就算了，球那边退回兜底身份 */ });
  });
  broadcastLinks();

  // 地址可能记不住（对方换了 IP），存一份最近的，下次直接点
  rememberLink(n.url);
  return { ok: true, id };
}

/**
 * 菜单 / 快捷键想「填个地址连别人」时统一走这里。
 * 主窗口可能停在启动页：那就让选择页把焦点引到右边那张卡，
 * 而不是往一个不认识 desktop:open-connect 的页面里发消息。
 */
async function openConnectPanel() {
  const w = await ensureHostWindow();
  const atStartPage = String(w.webContents.getURL()).startsWith('file:');
  if (w.webContents.isLoading()) await once(w.webContents, 'did-finish-load');
  w.webContents.send(atStartPage ? 'desktop:start-ask-link' : 'desktop:open-connect');
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
  refreshBallTarget();   // 连上 / 断开都会影响球发给谁，标题要跟着改
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

/* ---- 启动选择页（desktop/start.html）---- */

ipcMain.handle('start:state', (e) => {
  const p = readStartPref();
  // 菜单里主动点「启动方式…」时会在 URL 上带 force=1：不管记没记住都问一次
  let force = false;
  try { force = new URL(e.sender.getURL()).searchParams.get('force') === '1'; } catch { /* file:// 解析失败就当没带 */ }
  return {
    force,
    mode: p.mode,
    lastLinkUrl: p.lastLinkUrl,
    keepHost: p.keepHost,
    recent: readRecent(),
    dataDir: server.DATA_DIR,
    // 选择页把端口固定显示成「:6767」，跟着这里的常量走，改端口不用改两处
    defaultPort: DEFAULT_PORT,
  };
});

ipcMain.handle('start:choose', (_e, payload) => {
  const p = payload || {};
  // 先把回复给出去再干活：接下来会 loadURL 把发问的这个页面换掉，
  // 不在页面销毁前来回跑一趟，免得渲染端拿到一个「帧已销毁」的异常
  applyStartChoice({
    action: p.action === 'link' ? 'link' : 'host',
    url: typeof p.url === 'string' ? p.url : '',
    keepHost: p.keepHost === true,
    remember: !!p.remember,
  }).catch((e) => startPageError('启动失败：' + ((e && e.message) || '未知错误')));
  return { ok: true };
});

ipcMain.handle('start:dataDir', () => { openDataDirGuide(); return { ok: true }; });

// 「记住这次选择」的反悔：选择页底部那行「改回每次询问」
ipcMain.handle('start:forget', () => setStartMode('ask'));

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

// 页面传 PNG 的 dataURL 过来，主进程写进系统剪贴板 —— 微信 / QQ 输入框直接粘贴
ipcMain.handle('host:copyImage', (_e, dataUrl) => {
  try {
    const img = nativeImage.createFromDataURL(String(dataUrl || ''));
    if (img.isEmpty()) return { error: '图片数据为空' };
    clipboard.writeImage(img);
    return { ok: true };
  } catch (e) {
    return { error: (e && e.message) || '复制失败' };
  }
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
  const startPref = readStartPref();
  const closePref = readClosePref();

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
        { label: '打开我的主机界面', accelerator: 'CmdOrCtrl+1', click: () => ensureHostWindow() },
        {
          // 「记住这次选择」的反悔入口：记忆是什么、怎么改，都在这里
          label: '启动时…',
          submenu: [
            {
              label: '每次让我选',
              type: 'radio',
              checked: startPref.mode === 'ask',
              click: () => setStartMode('ask'),
            },
            {
              label: '直接进入我的主机',
              type: 'radio',
              checked: startPref.mode === 'host',
              click: () => setStartMode('host'),
            },
            {
              label: startPref.lastLinkUrl
                ? '直接连上次的主机（' + startPref.lastLinkUrl.replace(/^https?:\/\//, '') + '）'
                : '直接连上次的主机',
              type: 'radio',
              checked: startPref.mode === 'link',
              // 还没连过任何主机时，先让人去选一台，而不是记一个空地址
              click: () => (startPref.lastLinkUrl ? setStartMode('link') : openStartChooser()),
            },
            { type: 'separator' },
            { label: '现在重新选一次…', accelerator: 'CmdOrCtrl+Shift+S', click: () => openStartChooser() },
          ],
        },
        {
          // 「收进托盘」也是记忆，同样要能改回来
          label: '点关闭按钮时…',
          submenu: [
            { label: '每次问我', type: 'radio', checked: closePref === 'ask', click: () => setCloseAction('ask') },
            { label: '收入托盘（服务继续）', type: 'radio', checked: closePref === 'tray', click: () => setCloseAction('tray') },
            { label: '完全退出', type: 'radio', checked: closePref === 'quit', click: () => setCloseAction('quit') },
          ],
        },
        {
          // 悬浮球：拖个文件上去就能发出去，不用切窗口
          label: '悬浮球',
          submenu: [
            {
              label: '显示悬浮球',
              type: 'checkbox',
              checked: readBallPref().enabled,
              click: (item) => setBallEnabled(item.checked),
            },
            { type: 'separator' },
            { label: '大小', enabled: false },
            { label: '小', type: 'radio', checked: readBallPref().size === 'sm', click: () => setBallSize('sm') },
            { label: '标准', type: 'radio', checked: readBallPref().size === 'md', click: () => setBallSize('md') },
            { label: '大', type: 'radio', checked: readBallPref().size === 'lg', click: () => setBallSize('lg') },
            { type: 'separator' },
            {
              label: '收回屏幕右上角',
              enabled: readBallPref().enabled,
              click: () => {
                if (!ballWin || ballWin.isDestroyed()) return;
                ballAnchor = clampBallPos(null);
                ballWin.setBounds({ x: ballAnchor.x, y: ballAnchor.y, width: ballBoxPx, height: ballBoxPx });
                ballOpen = false;
                ballGeo = null;
                applyBallGeometry();
                updateSettings({ ballPos: { x: ballAnchor.x, y: ballAnchor.y } });
              },
            },
          ],
        },
        { type: 'separator' },
        // 服务跑没跑起来，只有这里看得见 —— 连别人的主机时主窗口是隐藏的，
        // 「手机现在还传不传得给我」全看这一行
        server.serverInfo().running
          ? { label: `本机可被连接 · 端口 ${server.serverInfo().port}`, enabled: false }
          : {
            label: '本机未开接收服务（点击开启）',
            click: () => { ensureHostServer().then(() => buildMenu()); },
          },
        { type: 'separator' },
        {
          label: '复制局域网地址',
          enabled: !!server.serverInfo().running && !!(hostInfo && hostInfo.lan.length),
          click: () => {
            const url = hostInfo && hostInfo.lan[0] && hostInfo.lan[0].url;
            if (!url) return;
            clipboard.writeText(url);
            dialog.showMessageBox({ message: '已复制', detail: url, buttons: ['好'], noLink: true });
          },
        },
        {
          label: '复制本机主控地址',
          enabled: !!server.serverInfo().running,
          click: () => { clipboard.writeText(server.serverInfo().hostUrl); },
        },
        { type: 'separator' },
        {
          label: '更改端口…',
          enabled: !!server.serverInfo().running,
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
        {
          label: '更改数据目录…',
          click: () => openDataDirGuide(),
        },
        { type: 'separator' },
        {
          label: '打开数据目录',
          click: () => shell.openPath(server.DATA_DIR),
        },
        {
          label: '检查更新…',
          click: () => checkForUpdatesManually(),
        },
        {
          label: '自动下载更新',
          type: 'checkbox',
          checked: readAutoDownloadPref(),
          visible: app.isPackaged && !PORTABLE_ROOT, // 开发模式 / 免安装版没有更新器，不显示
          click: (item) => {
            writeAutoDownloadPref(item.checked);
            try {
              const { autoUpdater } = require('electron-updater');
              autoUpdater.autoDownload = item.checked; // 立即生效，不用重启
            } catch { /* 没装更新器就算了 */ }
          },
        },
        { type: 'separator' },
        { role: IS_MAC ? 'close' : 'quit', label: IS_MAC ? '关闭窗口' : '退出' },
      ],
    },
    {
      label: '连接其他主机',
      submenu: [
        {
          label: '连接其他主机…',
          accelerator: 'CmdOrCtrl+L',
          click: () => openConnectPanel(),
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
  refreshTray(); // 托盘菜单和这里共用一份状态，别让两边说的不是一回事
}

/* ------------------------------------------------------- 端口偏好 */

/**
 * 用户上次选的端口记在 userData/settings.json。
 * 存的是「实际跑起来的端口」：6767 被占自动挪到 6768 的话，下次直接用 6768，
 * 地址才稳定——手机上存的书签不会隔天失效。
 */

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
    // 收尾必须判存活：点「取消」/关窗时 'closed' 已触发、窗口已销毁，
    // 这时再 w.close() 会抛 "Object has been destroyed"
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      if (!w.isDestroyed()) w.close();
    };

    const w = new BrowserWindow({
      width: 380,
      height: 190,
      parent: hostWin && !hostWin.isDestroyed() ? hostWin : undefined,
      modal: !!(hostWin && !hostWin.isDestroyed()),
      title: '选择端口',
      icon: APP_ICON,
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

/* ------------------------------------------------- 数据目录选择引导 */

/**
 * 系统文件夹选择器在各平台上行为不一致（Windows 上选中后常常只是「进入」文件夹，
 * 很多人选不出来），所以不直接裸弹选择器，而是先给一个引导窗：
 *   说明这步是干嘛的 → 粘贴路径或点「浏览…」→ 实时校验 → 确认重启生效。
 * 整个过程不阻塞主界面，随时可关。
 */

function readGuideDismissed() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    return !!(s && s.dataDirGuideDismissed);
  } catch { return false; }
}

function writeGuideDismissed() {
  updateSettings({ dataDirGuideDismissed: true });
}

/** 「自动下载更新」偏好：默认开；关掉后只提示有新版，下载与否由用户决定 */
function readAutoDownloadPref() {
  const s = readSettings();
  return !(s && s.autoDownload === false);
}

function writeAutoDownloadPref(on) {
  updateSettings({ autoDownload: !!on });
}

function dataDirStatus(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return { exists: false, valid: false };
  } catch { return { exists: false, valid: false }; }
  return { exists: true, valid: looksLikeOurData(dir) };
}

function pushToGuide(js) {
  if (!guideWin || guideWin.isDestroyed()) return;
  guideWin.webContents.executeJavaScript(js).catch(() => {});
}

function pushStatToGuide(dir) {
  pushToGuide(`window.__setStat && window.__setStat(${JSON.stringify(dataDirStatus(dir))})`);
}

/** 校验并应用新目录：不存在报错；不是有效数据目录时二次确认（允许硬选空目录） */
function validateAndApplyDataDir(dir) {
  const st = dataDirStatus(dir);
  if (!st.exists) {
    dialog.showErrorBox('目录不存在', dir + '\n\n请确认盘符和路径拼写。');
    return;
  }
  const apply = () => {
    writeDataDirPref(dir);
    if (guideWin && !guideWin.isDestroyed()) guideWin.close();
    dialog.showMessageBox({
      type: 'info',
      title: '数据目录已更新',
      message: '数据目录已设为：\n' + dir,
      detail: '需要重启应用才能生效。重启后所有文件、账号与头像都会从新目录读取。',
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) { app.relaunch(); app.exit(0); }
    });
  };
  if (!st.valid) {
    dialog.showMessageBox({
      type: 'warning',
      title: '没有找到已知的数据文件',
      message: '这个目录里没有发现小帽互传的数据文件（accounts.json / index.json / files 等）。',
      detail: '选一个空目录的话，应用会从零开始记录。如果你确定路径没选错（比如就想另起一份），可以继续使用。',
      buttons: ['仍要使用', '返回重选'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => { if (response === 0) apply(); });
    return;
  }
  apply();
}

function openDataDirGuide() {
  if (guideWin && !guideWin.isDestroyed()) { guideWin.show(); guideWin.focus(); return; }
  guideWin = new BrowserWindow({
    width: 520,
    height: 400,
    parent: hostWin && !hostWin.isDestroyed() ? hostWin : undefined,
    modal: false, // 不挡主界面，随手可关
    title: '数据目录',
    icon: APP_ICON,
    resizable: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  guideWin.setMenuBarVisibility(false);

  const curEsc = String(server.DATA_DIR).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  guideWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;padding:20px 22px;font:13px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#3d4450;background:#f4f6f9}
  h2{font-size:15px;margin:0 0 6px}
  .tip{margin:0 0 14px;color:#6b7280;font-size:12.5px}
  .tip b{color:#3d4450}
  .row{display:flex;gap:8px}
  input{flex:1;box-sizing:border-box;height:36px;padding:0 10px;border:1px solid #d4d9e2;
        border-radius:8px;font-size:13px;outline:none;background:#fff;color:#3d4450}
  input:focus{border-color:#4c6ef5}
  button.br{height:36px;padding:0 14px;border-radius:8px;border:1px solid #d4d9e2;
            background:#fff;color:#3d4450;font-size:12.5px;cursor:pointer;white-space:nowrap}
  button.br:hover{background:#eef1f6}
  .st{min-height:20px;margin-top:8px;font-size:12px;font-weight:600}
  .st.ok{color:#1a7f4b}.st.warn{color:#b45309}.st.err{color:#c0392b}
  .cur{margin-top:10px;font-size:12px;color:#6b7280}
  .cur code{background:#eef1f6;padding:1px 6px;border-radius:5px;font-size:11.5px;word-break:break-all}
  .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
  .btns button{height:30px;padding:0 14px;border-radius:7px;border:1px solid #d4d9e2;
               background:#fff;color:#3d4450;font-size:12.5px;cursor:pointer}
  .btns button.ok{background:#4c6ef5;border-color:#4c6ef5;color:#fff}
</style>
<h2>选择数据目录</h2>
<p class="tip">这里存放消息、账号与文件。如果你之前用<b>命令行方式（启动.bat）</b>跑过服务，
把目录指到项目里那个 <b>data</b> 文件夹，所有数据原样沿用，<b>无需复制迁移</b>。</p>
<div class="row">
  <input id="p" placeholder="粘贴 data 文件夹的完整路径，如 D:\\XiaoMaoShare\\data" spellcheck="false">
  <button class="br" id="b">浏览…</button>
</div>
<div class="st" id="st"></div>
<div class="cur">当前：<code>${curEsc}</code></div>
<div class="btns">
  <button id="c">取消</button>
  <button class="ok" id="o">使用此目录</button>
</div>
<script>
  var p = document.getElementById('p'), st = document.getElementById('st');
  var timer = null;
  function val(){ return p.value.trim(); }
  /* 主进程靠 page-title-updated 收消息，而标题没变就不触发这个事件 ——
     每条消息缀一个自增序号，保证连续点两次按钮主进程也都能收到 */
  var seq = 0;
  function send(t){ document.title = t + '\\u200b' + (++seq); }
  window.__setPath = function (d) { p.value = d; };
  window.__setTip = function (t) { st.className = 'st warn'; st.textContent = t; };
  window.__setStat = function (s) {
    st.className = 'st ' + (!s.exists ? 'err' : s.valid ? 'ok' : 'warn');
    st.textContent = !s.exists ? '❌ 目录不存在，请检查盘符和路径'
      : s.valid ? '✅ 已识别为有效的数据目录'
      : '⚠️ 没发现已知数据文件（仍可使用，应用会从零开始记录）';
  };
  p.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (val()) send('DDVAL:' + encodeURIComponent(val()));
      else { st.textContent = ''; st.className = 'st'; }
    }, 300);
  });
  document.getElementById('b').onclick = function () { send('DDBROWSE:' + encodeURIComponent(val())); };
  document.getElementById('o').onclick = function () {
    if (val()) { send('DDOK:' + encodeURIComponent(val())); return; }
    /* 输入框空着不该无声无息：让主进程决定 —— 浏览选过就用浏览那个，真没有就提示 */
    send('DDEMPTY:');
  };
  document.getElementById('c').onclick = function () { window.close(); };
  p.focus();
<\/script>`));

  let lastBrowsed = ''; // 「浏览…」选过的目录：输入框空着点「使用此目录」时兜底用它

  guideWin.webContents.on('page-title-updated', async (e, title) => {
    // 页面每条消息都缀了自增序号（逼着标题变化、事件必触发），先剥掉再认指令
    title = String(title || '').split('\u200b')[0];
    let m = /^DDBROWSE(?::(.*))?$/.exec(title || '');
    if (m) {
      e.preventDefault();
      let start = '';
      try { start = m[1] ? decodeURIComponent(m[1]) : ''; } catch { /* ignore */ }
      const res = await dialog.showOpenDialog(guideWin, {
        title: '选择数据目录',
        defaultPath: start || server.DATA_DIR,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (!res.canceled && res.filePaths && res.filePaths[0]) {
        lastBrowsed = res.filePaths[0];
        pushToGuide(`window.__setPath && window.__setPath(${JSON.stringify(res.filePaths[0])})`);
        pushStatToGuide(res.filePaths[0]);
      }
      return;
    }
    m = /^DDVAL:(.+)$/.exec(title || '');
    if (m) {
      e.preventDefault();
      try { pushStatToGuide(decodeURIComponent(m[1])); } catch { /* ignore */ }
      return;
    }
    m = /^DDOK:(.+)$/.exec(title || '');
    if (m) {
      e.preventDefault();
      try { validateAndApplyDataDir(decodeURIComponent(m[1])); } catch { /* ignore */ }
      return;
    }
    // 输入框空着就点了「使用此目录」：浏览选过的话直接用那个（用户预期就是关窗生效），
    // 真的什么都没有就回到窗口里说清楚差什么
    if (/^DDEMPTY:$/.test(title || '')) {
      e.preventDefault();
      if (lastBrowsed) validateAndApplyDataDir(lastBrowsed);
      else pushToGuide(`window.__setTip && window.__setTip('先点「浏览…」选一个目录，或把路径粘进输入框')`);
    }
  });

  guideWin.on('closed', () => {
    guideWin = null;
    writeGuideDismissed(); // 关过一次就不再自动弹，菜单里随时可以再开
  });
  guideWin.once('ready-to-show', () => guideWin.show());
}

/* ------------------------------------------------------------ 自动更新 */

/**
 * 基于 electron-updater + GitHub Releases：
 *   打包配置里声明了 publish（provider: github），electron-builder 会顺带生成
 *   latest.yml / latest-mac.yml 元数据；只要把它们随安装包一起传上 Release，
 *   应用就能自己发现新版本、后台下载、重启安装。
 *
 * 差异：Windows（NSIS）走 blockmap 差量更新，只下改动块；
 *       macOS（Squirrel.Mac）只支持全量 zip。
 * 注意：mac 应用未签名，自动更新可能被系统拦下 —— 失败时降级为打开下载页。
 */

const RELEASES_URL = 'https://github.com/xiaomaoJT/XiaoMaoShare/releases/latest';
let manualCheck = false; // 手动检查时才把失败细节弹给用户，静默检查失败不打扰

/* ---- 更新状态小窗：检查/下载进度即时可见 ----
   原生 dialog 做不了进度显示，还会阻塞；这个小窗非模态、随手可关，
   点「检查更新」立刻出现（转圈），发现新版切成实时进度条，已是最新则打勾自动关闭。 */
let updWin = null;
let updState = null;       // 最近一次要渲染的状态，页面加载完补渲染
let updVersion = '';       // update-available 与 download-progress 事件间传递版本号
let updLastPaint = 0;      // 进度事件限频，~4 次/秒足够
let updChecking = false;   // 防抖：检查进行中再点菜单不重复发起

const UPD_HTML = `<!doctype html><meta charset="utf-8"><title>检查更新</title>
<style>
  body{margin:0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
       color:#3d4450;background:#f4f6f9;display:flex;align-items:center;height:100vh;user-select:none}
  .row{display:flex;align-items:center;gap:12px;width:300px;margin:0 auto}
  .spin{width:20px;height:20px;border:3px solid #d4d9e2;border-top-color:#4c6ef5;border-radius:50%;
        animation:s .8s linear infinite;flex:none;box-sizing:border-box}
  @keyframes s{to{transform:rotate(360deg)}}
  .ok{width:20px;height:20px;flex:none;color:#1a7f37;font-size:16px;font-weight:700;text-align:center;line-height:20px}
  b{display:block;font-size:13.5px}
  span{color:#6b7280;font-size:12px}
  .bar{height:6px;border-radius:3px;background:#d8dee4;margin-top:6px;overflow:hidden}
  .bar i{display:block;height:100%;width:0;background:#4c6ef5;border-radius:3px;transition:width .25s}
</style>
<div class="row">
  <div class="spin" id="ico"></div>
  <div style="flex:1"><b id="t">正在检查更新…</b><span id="d">连接更新服务器，请稍候</span>
  <div class="bar" id="bar" hidden><i id="fill"></i></div></div>
</div>
<script>
function __upd(s){
  var t=document.getElementById('t'),d=document.getElementById('d'),
      ico=document.getElementById('ico'),bar=document.getElementById('bar'),fill=document.getElementById('fill');
  function mb(n){return Number.isFinite(n)?(n/1048576).toFixed(1):null;}
  if(s.state==='checking'){
    ico.className='spin';ico.textContent='';bar.hidden=true;
    t.textContent='正在检查更新…';d.textContent='连接更新服务器，请稍候';
  }else if(s.state==='downloading'){
    ico.className='spin';ico.textContent='';bar.hidden=false;
    var p=Math.max(0,Math.min(100,Number.isFinite(s.extra.percent)?s.extra.percent:0));
    t.textContent='正在下载新版本 v'+(s.extra.version||'')+' · '+p.toFixed(0)+'%';
    fill.style.width=p+'%';
    var bits=[];
    var spd=mb(s.extra.speed), got=mb(s.extra.transferred), tot=mb(s.extra.total);
    if(spd) bits.push(spd+' MB/s');
    if(got&&tot) bits.push(got+' / '+tot+' MB');
    d.textContent=bits.join(' · ')||'正在后台下载，完成后会询问是否安装';
  }else if(s.state==='latest'){
    ico.className='ok';ico.textContent='✓';bar.hidden=true;
    t.textContent='已是最新版本';d.textContent='当前 v'+(s.extra.version||'')+'，暂无更新';
  }
}
</script>`;

function updRender() {
  if (!updWin || updWin.isDestroyed() || !updState) return;
  updWin.webContents.executeJavaScript('window.__upd(' + JSON.stringify(updState) + ')').catch(() => {});
}

function updShow(state, extra) {
  updState = { state, extra: extra || {} };
  if (!updWin || updWin.isDestroyed()) {
    updWin = new BrowserWindow({
      width: 380,
      height: 128,
      title: '检查更新',
      icon: APP_ICON,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#f4f6f9',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    updWin.setMenuBarVisibility(false);
    updWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(UPD_HTML));
    updWin.webContents.on('did-finish-load', updRender);
    updWin.once('ready-to-show', () => { if (updWin && !updWin.isDestroyed()) updWin.show(); });
    updWin.on('closed', () => { updWin = null; });
  } else {
    if (!updWin.isVisible()) updWin.show();
    updRender();
  }
}

function updClose() {
  if (updWin && !updWin.isDestroyed()) updWin.close();
  updWin = null;
}

function setupAutoUpdater() {
  if (!app.isPackaged || PORTABLE_ROOT) return; // 开发模式 / 免安装版不接自动更新
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }

  autoUpdater.autoDownload = readAutoDownloadPref();
  autoUpdater.allowPrerelease = false;

  // 发现新版：开了自动下载 → 状态小窗直接切进度条；
  // 关了 → 问一句要不要现在下载（下载与否完全由用户决定）
  autoUpdater.on('update-available', (info) => {
    manualCheck = false;
    updChecking = false;
    updVersion = info.version;
    if (readAutoDownloadPref()) {
      updShow('downloading', { version: info.version, percent: 0 });
      return;
    }
    dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `新版本 ${info.version} 可用（当前 v${app.getVersion()}）`,
      detail: '已关闭自动下载：可以立即下载，或到发布页手动获取安装包。',
      buttons: ['立即下载', '打开发布页', '暂不更新'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) {
        updShow('downloading', { version: info.version, percent: 0 });
        autoUpdater.downloadUpdate().catch(() => { updClose(); });
      } else if (response === 1) {
        shell.openExternal(RELEASES_URL);
      }
    });
  });

  autoUpdater.on('download-progress', (p) => {
    const now = Date.now();
    if (now - updLastPaint < 250) return;
    updLastPaint = now;
    updShow('downloading', {
      version: updVersion,
      percent: p.percent,
      speed: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    updClose();
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: '更新已就绪',
      message: `新版本 ${info.version} 已下载完成`,
      detail: '重启应用后将自动安装并进入新版本，主机服务会短暂中断几秒。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
    // 走一遍优雅退出（放掉端口）再交给安装器；isForceRunAfter 让它装完自动拉起新版
    quitting = true;
    server.stopServer().finally(() => autoUpdater.quitAndInstall(false, true));
  });

  autoUpdater.on('error', (e) => {
    updChecking = false;
    if (!manualCheck) { updClose(); return; } // 静默检查失败：忽略，下次启动再试
    manualCheck = false;
    updClose();
    dialog.showMessageBox({
      type: 'warning',
      title: '检查更新失败',
      message: '自动更新暂时不可用',
      detail: (e && e.message ? e.message : String(e)) +
        '\n\n可以直接到发布页手动下载最新安装包。',
      buttons: ['打开下载页', '关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => { if (response === 0) shell.openExternal(RELEASES_URL); });
  });

  // 启动后静默检查一次；网络不通、被拦截等一律静默，不烦用户
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 5000);
}

/** 菜单「检查更新…」：点了立刻出状态小窗（转圈），结果出来就地切换，不让用户干等 */
function checkForUpdatesManually() {
  if (PORTABLE_ROOT) {
    dialog.showMessageBox({
      type: 'info',
      title: '免安装版',
      message: '免安装版不自动更新',
      detail: '有新版本时，到发布页下载新的免安装版替换即可（数据目录不受影响）。',
      buttons: ['打开发布页', '关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => { if (response === 0) shell.openExternal(RELEASES_URL); });
    return;
  }
  if (!app.isPackaged) {
    dialog.showMessageBox({
      message: '开发模式下不检查更新',
      detail: '打包后的应用才支持自动更新。',
      buttons: ['好'],
      noLink: true,
    });
    return;
  }
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { shell.openExternal(RELEASES_URL); return; }
  if (updChecking) { updShow('checking'); return; } // 已经在查：把状态窗调出来就行
  updChecking = true;
  manualCheck = true;
  updShow('checking'); // 先出窗再发请求，网络再慢用户也知道在动
  autoUpdater.checkForUpdates()
    .then((r) => {
      updChecking = false;
      manualCheck = false;
      const latest = r && r.updateInfo && r.updateInfo.version;
      if (latest && latest !== app.getVersion()) return; // 状态窗已切到下载进度
      updShow('latest', { version: app.getVersion() });
      setTimeout(() => { if (updWin && !manualCheck) updClose(); }, 1800);
    })
    .catch(() => { /* error 事件里统一兜底 */ });
}

/* ------------------------------------------------- 启动方式：当主机还是连别人 */

/**
 * 记住的启动方式（settings.json）：
 *   ask  —— 每次打开都问；没设置过就是它，所以首次必然会给选择
 *   host —— 直接进自己的主机界面
 *   link —— 直接连上次那台；连不上会自动回落到主机界面，不会把人困在空白页
 *
 * keepHost 只对 link 有意义：连别人的同时，本机服务要不要也开着（别人也能传给你）。
 * 默认 **不** 开 —— 连别人就老实当客户端，不占端口、不弹防火墙；
 * 想让手机同时能传给自己，得在选择页明确勾上。
 */
function readStartPref() {
  const s = readSettings();
  return {
    mode: ['ask', 'host', 'link'].includes(s.startMode) ? s.startMode : 'ask',
    lastLinkUrl: typeof s.lastLinkUrl === 'string' ? s.lastLinkUrl : '',
    keepHost: s.keepHost === true, // 默认关：纯客户端，不监听任何端口
  };
}

/**
 * 改「启动记忆」。菜单里的三个单选、选择页的「改回每次询问」都走这里，
 * 免得两处各写一遍 updateSettings，改着改着就不一致了。
 */
function setStartMode(mode) {
  const m = ['ask', 'host', 'link'].includes(mode) ? mode : 'ask';
  updateSettings({ startMode: m });
  buildMenu(); // 单选勾选状态要立刻跟上
  refreshTray();
  return { ok: true, mode: m };
}

/**
 * 点窗口关闭按钮时怎么办（settings.json.closeAction）：
 *   ask  —— 每次都问；没设置过就是它，所以第一次关闭必然弹窗
 *   tray —— 直接收进托盘，本机服务继续跑（手机照样能传）
 *   quit —— 直接退出
 *
 * 和启动方式一样，这个记忆必须有反悔入口：菜单「我的主机 → 关闭时…」、
 * 关闭弹窗里的「记住」勾选、以及托盘菜单，三处改的是同一个键。
 */
function readClosePref() {
  const m = readSettings().closeAction;
  return ['ask', 'tray', 'quit'].includes(m) ? m : 'ask';
}

function setCloseAction(v) {
  const m = ['ask', 'tray', 'quit'].includes(v) ? v : 'ask';
  updateSettings({ closeAction: m });
  buildMenu();
  refreshTray();
  return { ok: true, mode: m };
}

/**
 * 起本机服务（幂等）。端口被占就按老规矩换一个；用户放弃则返回 null，
 * 由调用方决定收场 —— 「当主机」失败该留在选择页，「连别人」失败不该拖累连接。
 */
async function ensureHostServer() {
  const inf = server.serverInfo();
  if (inf.running) { hostInfo = inf; return hostInfo; }

  const pref = readPortPref() || DEFAULT_PORT;
  let err = null;
  try { hostInfo = await server.startServer({ port: pref }); } catch (e) { err = e; }

  while (!hostInfo) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: '服务起不来',
      message: '端口被占用或不可用',
      detail: ((err && err.message) || '未知错误') + '\n\n可以换个端口再试，默认 ' + DEFAULT_PORT + '。',
      buttons: ['换个端口', '先不启动'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice !== 0) return null;
    const p = await askPort(pref);
    if (!p) return null;
    try { hostInfo = await server.startServer({ port: p }); } catch (e) { err = e; }
  }

  writePortPref(hostInfo.port); // 记住实际端口，地址才稳定
  buildMenu();                  // 菜单里的「复制局域网地址」等项要跟着解禁
  return hostInfo;
}

/**
 * 连之前先探一下（一个很小的 GET，1.2 秒超时）。
 * 目的只有一个：上次那台关机了，别把用户丢进「连不上」的页面里出不来。
 */
function probeHost(url, ms = 1200) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(false); }
    const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = lib.request({
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: (u.pathname || '/') + (u.search || ''),
        method: 'GET',
        timeout: ms,
        rejectUnauthorized: false, // 对方用自签证书时也别误判成「连不上」
      }, (res) => { res.destroy(); done(true); });
      req.on('timeout', () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
      req.end();
    } catch { done(false); }
  });
}

/** 给主窗口页面发一条轻提示（页面还没加载完就等加载完再发） */
function noticeToHost(text) {
  if (!hostWin || hostWin.isDestroyed()) return;
  const send = () => { if (hostWin && !hostWin.isDestroyed()) hostWin.webContents.send('desktop:notice', String(text)); };
  if (hostWin.webContents.isLoading()) hostWin.webContents.once('did-finish-load', send);
  else send();
}

/** 启动阶段的错误回显到选择页（页面没在的话退化成系统弹窗） */
function startPageError(text) {
  if (hostWin && !hostWin.isDestroyed() && String(hostWin.webContents.getURL()).startsWith('file:')) {
    hostWin.show();
    // 刚 loadFile 完页面可能还在加载，监听器还没挂上 —— 等加载完再发，消息不丢
    const send = () => {
      if (hostWin && !hostWin.isDestroyed()) {
        hostWin.webContents.send('desktop:start-error', String(text || ''));
      }
    };
    if (hostWin.webContents.isLoading()) hostWin.webContents.once('did-finish-load', send);
    else send();
  } else {
    dialog.showMessageBox({ type: 'warning', message: String(text || '启动失败'), buttons: ['好'], noLink: true });
  }
}

/** 首次运行的数据目录引导：等服务/界面稳定后再弹，别盖住启动选择页 */
function maybeFirstRunGuide() {
  if (readDataDirPref() || readGuideDismissed()) return;
  openDataDirGuide();
}

/**
 * 执行一次启动选择。这是「打开应用之后到底走去哪」的唯一入口，
 * 启动记忆、菜单切换、选择页回传都走它，行为才不会分叉。
 *
 * @param {{action:'host'|'link', url?:string, keepHost?:boolean, remember?:boolean}} c
 */
async function applyStartChoice(c) {
  const remember = !!c.remember;
  let target = c.action === 'link' ? 'link' : 'host';
  let linkUrl = '';
  let linkHost = '';
  let pending = '';

  if (target === 'link') {
    const n = normalizeLink(c.url || '');
    // 地址不合法、或指向自己，就没得连 —— 干脆当主机
    if (n.error || isSelf(n.url)) {
      target = 'host';
      if (n.error && !/先填对方的地址/.test(n.error)) pending = n.error + '，已回到我的主机';
    } else {
      linkUrl = n.url;
      linkHost = n.host;
    }
  }

  if (remember) {
    updateSettings({ startMode: target === 'link' ? 'link' : 'host', keepHost: c.keepHost === true });
  }

  if (target === 'link') {
    updateSettings({ lastLinkUrl: linkUrl });

    if (!(await probeHost(linkUrl))) {
      // 连不上：退回选择页让人自己挑，别擅自把本机服务拉起来 ——
      // 用户想的是「连他」，结果变成了「当主机」，这属于替人做主
      if (!remember) updateSettings({ startMode: 'ask' });
      if (!hostWin || hostWin.isDestroyed()) createHostWindow();
      hostWin.show();
      hostWin.focus();
      // 错误随页面带过去：刚导航完就 webContents.send 有「监听器还没挂上」的时序坑，
      // 走 query 最稳 —— 页面初始化时自己读
      await hostWin.loadFile(START_PAGE, {
        query: { force: '1', startErr: encodeURIComponent(linkHost + ' 连不上，请重新选择') },
      });
      return;
    }
  }

  if (target === 'host') {
    const info = await ensureHostServer();
    if (!info) {
      startPageError('本机服务没起来。可以再试一次，或者先连别人的主机。');
      return;
    }
    if (!hostWin || hostWin.isDestroyed()) createHostWindow();
    hostWin.loadURL(info.hostUrl);
    if (pending) noticeToHost(pending);
    maybeFirstRunGuide();
    return;
  }

  // ---- 连别人 ----
  // 本机服务起不来不拖累连接：连别人照样能用，只是这台电脑暂时不对外提供服务
  if (c.keepHost === true && !(await ensureHostServer())) {
    pending = '本机服务没起来，这次只能当普通设备用';
  }

  if (!hostWin || hostWin.isDestroyed()) createHostWindow();
  hostWin.hide();

  const r = openLink(linkUrl);
  if (r.error) {
    hostWin.show();
    startPageError(r.error);
    return;
  }
  // 主窗口藏着，页面提示看不见 —— 这种少见情况用系统弹窗说清楚
  if (pending) dialog.showMessageBox({ type: 'info', message: pending, buttons: ['好'], noLink: true });
}

/**
 * 按「启动记忆」走一次。mode 是 ask 就不动（交给选择页），
 * 记了 host / link 就等价于用户当时勾了「记住」又选了一次。
 * 冷启动和「主窗口回到启动页」都走这里 —— 只在冷启动走一遍的话，
 * 窗口后来停在启动页时没人接管，就会永远卡在「正在连接…」的动画上。
 */
function runStartPref() {
  const pref = readStartPref();
  if (pref.mode === 'ask') return false;
  applyStartChoice({
    action: pref.mode === 'link' ? 'link' : 'host',
    url: pref.lastLinkUrl,
    keepHost: pref.keepHost,
    remember: false,
  }).catch((e) => startPageError('启动失败：' + ((e && e.message) || '未知错误')));
  return true;
}

/** 把窗口切回「选择页」：菜单里的「启动方式…」用它，用户随时能改主意 */
async function openStartChooser() {
  if (!hostWin || hostWin.isDestroyed()) createHostWindow();
  hostWin.show();
  hostWin.focus();
  await hostWin.loadFile(START_PAGE, { query: { force: '1' } });
  hostWin.show();
  hostWin.focus();
}

/**
 * 没有可见窗口了要不要退出（Windows / Linux）。
 * 连接模式下主窗口是 hide() 着的，它不算可见窗口 —— 所以不能让
 * window-all-closed 来判断，否则关掉对方的窗口后进程会赖在后台。
 *
 * 托盘在的时候不退出：托盘图标就是那个「看得见的落脚点」，
 * 用户随时能点回来。只有记过「关闭即完全退出」才放行。
 */
function quitIfNoVisibleWindow() {
  if (IS_MAC) return; // mac 惯例外：关窗不退，Dock 点回来
  const anyVisible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible());
  if (anyVisible) return;
  if (tray && readClosePref() !== 'quit') return;
  app.quit();
}

/* ------------------------------------------------------------ 托盘 */

/**
 * 托盘图标：Windows 用 ico（系统按 DPI 自己挑 16/24/32/48），
 * mac / Linux 用 png。都在 desktop/ 里 —— 构建的 files 只收 server.js、
 * public/、desktop/，放别处（比如 build/）打包后就读不到了。
 * 图是从应用图标重采样的圆角透明版：16~32px 的托盘格子里，
 * 白底方图会变成一块死白，圆角挖空才像个图标。
 */
const TRAY_ICON = path.join(__dirname, process.platform === 'win32' ? 'tray.ico' : 'tray.png');

function buildTray() {
  if (tray) {
    try { tray.destroy(); } catch { /* 已经不在了 */ }
    tray = null;
  }

  let img = nativeImage.createFromPath(TRAY_ICON);
  if (img.isEmpty()) return; // 图标缺失就干脆不建，别在任务栏留一个空白格子
  if (IS_MAC) img = img.resize({ width: 18, height: 18 });

  try {
    tray = new Tray(img);
  } catch {
    tray = null; // Linux 缺 libappindicator 等：当作「不支持托盘」，退回原来的关闭即退出
    return;
  }

  tray.setToolTip('XiaoMao 互传');
  // Windows / Linux：左键单击直接叫回界面，右键才是菜单。
  // macOS 的菜单栏图标点了就弹菜单，所以那边靠菜单第一项回来。
  tray.on('click', () => showFromTray());
  tray.on('double-click', () => showFromTray());
  refreshTray();
}

/** 托盘菜单跟着服务状态走：端口、能不能复制地址、关闭策略的单选，都要是当下的事实 */
function refreshTray() {
  if (!tray) return;
  const inf = server.serverInfo();
  tray.setToolTip(inf.running ? `XiaoMao 互传 · 端口 ${inf.port}` : 'XiaoMao 互传 · 本机未开接收服务');
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(inf)));
}

function trayTemplate(inf) {
  const closePref = readClosePref();
  const lanUrl = (hostInfo && hostInfo.lan[0] && hostInfo.lan[0].url) || '';
  return [
    { label: '打开 XiaoMao 互传', click: () => showFromTray() },
    { type: 'separator' },
    inf.running
      ? { label: `本机可被连接 · 端口 ${inf.port}`, enabled: false }
      : {
        label: '本机未开接收服务（点击开启）',
        click: () => ensureHostServer().then(() => { buildMenu(); refreshTray(); }),
      },
    {
      label: '复制局域网地址',
      enabled: !!(inf.running && lanUrl),
      click: () => { if (lanUrl) clipboard.writeText(lanUrl); },
    },
    { type: 'separator' },
    { label: '连接其他主机…', click: () => openConnectPanel() },
    { type: 'separator' },
    {
      label: '点关闭按钮时…',
      submenu: [
        { label: '每次问我', type: 'radio', checked: closePref === 'ask', click: () => setCloseAction('ask') },
        { label: '收入托盘（服务继续）', type: 'radio', checked: closePref === 'tray', click: () => setCloseAction('tray') },
        { label: '完全退出', type: 'radio', checked: closePref === 'quit', click: () => setCloseAction('quit') },
      ],
    },
    {
      label: '悬浮球',
      submenu: [
        {
          label: '显示悬浮球',
          type: 'checkbox',
          checked: readBallPref().enabled,
          click: (item) => setBallEnabled(item.checked),
        },
        { label: '小', type: 'radio', checked: readBallPref().size === 'sm', click: () => setBallSize('sm') },
        { label: '标准', type: 'radio', checked: readBallPref().size === 'md', click: () => setBallSize('md') },
        { label: '大', type: 'radio', checked: readBallPref().size === 'lg', click: () => setBallSize('lg') },
      ],
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
}

function showFromTray() {
  if (hostWin && !hostWin.isDestroyed() && hostWin.isVisible()) {
    if (hostWin.isMinimized()) hostWin.restore();
    hostWin.focus();
    return;
  }
  ensureHostWindow();
}

/**
 * 主窗口的关闭按钮走这里。三种结局由 closeAction 决定，
 * 但无论哪种，都是「窗口关不关」的问题 —— 服务是否停，只看是不是真退出。
 */
function handleHostClose(e) {
  if (quitting) return; // 已经在退出流程里，放行
  if (!tray) return;    // 没有托盘可收，保持老行为：真关，窗口全关后退出

  const policy = readClosePref();
  if (policy === 'quit') {
    // 记过「完全退出」就真的退。mac 上不能只是放行关窗 —— 那边关窗默认不退，
    // 用户会以为点了个寂寞，得显式走一遍退出流程。
    e.preventDefault();
    // 推迟一拍再退：直接在 close 事件里调 app.quit()，quit 流程又会来关这个窗口，
    // 有平台会因为「正在关闭中」把这个请求吃掉
    setImmediate(() => app.quit());
    return;
  }

  e.preventDefault();            // 兜住这次关闭，改由我们决定去哪
  if (policy === 'tray') { hideToTray(); return; }
  askCloseChoice();
}

function hideToTray() {
  if (!hostWin || hostWin.isDestroyed()) return;
  hostWin.hide();
  refreshTray();
  notifyTrayParked();
}

/** 第一次「界面没了但进程还在」时说一声 —— 否则用户会以为程序没退干净 */
function notifyTrayParked() {
  if (trayHintShown) return;
  trayHintShown = true;
  try {
    if (process.platform === 'win32' && tray) {
      tray.displayBalloon({
        title: 'XiaoMao 互传还在运行',
        content: '点托盘图标随时打开；右键菜单里可以完全退出。',
      });
    } else if (!IS_MAC) {
      new Notification({
        title: 'XiaoMao 互传还在运行',
        body: '点托盘图标随时打开；右键菜单里可以完全退出。',
      }).show();
    }
  } catch { /* 系统通知不可用就算了，别为一句提示把关闭流程弄崩 */ }
}

/**
 * 关闭确认。之所以默认是「收入托盘」而不是「退出」：
 * 这个程序在后台是有用的（手机还在传），误关的代价比误留高得多。
 *
 * @param {() => void} [onTray] 选「收入托盘」后的去处；默认把主窗口藏进托盘。
 *   连接窗口复用这个询问时传自己的收场（关掉自己、进程留在托盘）。
 */
async function askCloseChoice(onTray) {
  if (closeAsking) return;
  closeAsking = true;

  const inf = server.serverInfo();
  const port = inf.running ? inf.port : (readPortPref() || DEFAULT_PORT);
  // 对话框要挂在看得见的窗口上：主窗口收着的时候（连别人模式）挂无主对话框，
  // 不然询问挂在一个看不见的窗口上，看起来就是「点了关闭没反应」
  const parent = hostWin && !hostWin.isDestroyed() && hostWin.isVisible() ? hostWin : undefined;
  let r;
  try {
    r = await dialog.showMessageBox(parent, {
      type: 'question',
      title: '关闭窗口',
      message: '关掉窗口后，XiaoMao 互传还要继续接收吗？',
      detail: inf.running
        ? `收入托盘：界面收起，本机继续在端口 ${port} 上守着，手机和别的电脑照样能传给你。\n完全退出：服务和端口一起停掉，别人就传不进来了。`
        : '收入托盘：界面收起，进程留在托盘里，随时点回来。\n完全退出：结束进程，托盘图标一起消失。',
      buttons: ['收入托盘', '完全退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: '记住我的选择，以后不再问',
      checkboxChecked: false,
      noLink: true,
    });
  } finally {
    closeAsking = false;
  }

  if (r.response === 0) {
    // 只记「确定」的那两项；勾了记住又点取消，不该产生任何记忆
    if (r.checkboxChecked) setCloseAction('tray');
    if (typeof onTray === 'function') onTray();
    else hideToTray();
  } else if (r.response === 1) {
    if (r.checkboxChecked) setCloseAction('quit');
    app.quit();
  }
  // 2 = 取消：什么都不做，窗口原样留着
}

/* ------------------------------------------------------------ 悬浮球 */

/**
 * 悬浮球：一个始终置顶的小圆球，拖着文件扔上去就直接发出去，
 * 点一下展开面板看最近几条、也能顺手发句话。
 *
 * 它存在的理由不是「多一个入口」，而是「不打断手上的事」——
 * 传文件本来要：找窗口 → 切过去 → 选文件 → 发，一套下来十几秒。
 *
 * 数据全部经主进程转发，不在球的渲染层直接打请求：
 * 球要同时服务两种身份（自己是主机：localhost + 主控令牌；连着别人：对方地址 + 授权 cid），
 * origin 和凭据都只有主进程知道。
 */
const BALL_PAGE = path.join(__dirname, 'ball.html');
// 三档大小：菜单 / 托盘 / 在球上滚滚轮都能换，记在设置里
const BALL_DISC = { sm: 52, md: 64, lg: 80 };
const BALL_PAD = 20;                                     // 窗口比球体大一圈，给自绘阴影留位（透明窗口会裁掉超出部分）
const BALL_GAP = 6;                                      // 球与面板之间（球本身还自带 10px 留白）
const BALL_PANEL = { width: 360, height: 460 };

let ballOn = false;       // 悬浮球是「每场会话」的开关：默认关，重启后想用要重新打开（不落盘，免得一次开启永久常驻）

function readBallPref() {
  const s = readSettings();
  const p = s.ballPos;
  return {
    enabled: ballOn,                                     // 默认关闭；菜单 / 托盘里开了才出现，且只管本次运行
    size: BALL_DISC[s.ballSize] ? s.ballSize : 'md',
    pos: p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null,
  };
}

/** 把像素尺寸从设置里同步到内存：布局和拖动都靠这两个数，别每次读盘 */
function syncBallMetrics() {
  ballDiscPx = BALL_DISC[readBallPref().size];
  ballBoxPx = ballDiscPx + BALL_PAD;
}

function setBallEnabled(on) {
  ballOn = !!on;   // 会话内开关，不写设置 —— 下次启动仍然是关着的
  if (on) createBallWindow();
  else destroyBallWindow();
  buildMenu();
  refreshTray();
  return { ok: true, enabled: !!on };
}

/** 换大小：窗口跟着变，球心位置尽量不动 —— 换完球不该跳到屏幕另一头 */
function setBallSize(key) {
  if (!BALL_DISC[key]) return { ok: false, error: '没有这个尺寸' };
  const before = ballAnchor || clampBallPos(readBallPref().pos);
  const center = { x: before.x + ballBoxPx / 2, y: before.y + ballBoxPx / 2 };

  updateSettings({ ballSize: key });
  syncBallMetrics();

  if (ballWin && !ballWin.isDestroyed()) {
    if (ballOpen) {
      // 展开时球心随窗口内球位偏移，重算一遍布局即可
      ballAnchor = clampBallPos({
        x: Math.round(center.x - ballBoxPx / 2),
        y: Math.round(center.y - ballBoxPx / 2),
      });
      ballGeo = ballLayout();
      ballWin.setBounds(ballGeo.bounds);
      applyBallGeometry();
    } else {
      ballAnchor = clampBallPos({
        x: Math.round(center.x - ballBoxPx / 2),
        y: Math.round(center.y - ballBoxPx / 2),
      });
      ballWin.setBounds({ x: ballAnchor.x, y: ballAnchor.y, width: ballBoxPx, height: ballBoxPx });
      applyBallGeometry();
    }
  }
  buildMenu();
  refreshTray();
  return { ok: true, size: key };
}

/** 把当前几何推给页面（换尺寸 / 展开收起都走这里，页面只负责摆） */
function applyBallGeometry() {
  if (!ballWin || ballWin.isDestroyed()) return;
  const payload = (ballOpen && ballGeo)
    ? ballGeo.panelAndBall()
    : { size: ballDiscPx, box: ballBoxPx, ball: { left: 0, top: 0 }, panel: null };
  try { ballWin.webContents.send('ball:geometry', payload); } catch { /* 页面还没就绪 */ }
}

/** 位置兜底：默认贴右上角；记下来的位置要落回某块屏幕里（拔了外接屏也不会跑到看不见的地方） */
function clampBallPos(pos) {
  const area = screen.getDisplayNearestPoint(pos || { x: 200, y: 200 }).workArea;
  const raw = pos || { x: area.x + area.width - ballBoxPx - 24, y: area.y + 120 };
  return {
    x: Math.round(Math.min(Math.max(raw.x, area.x), area.x + area.width - ballBoxPx)),
    y: Math.round(Math.min(Math.max(raw.y, area.y), area.y + area.height - ballBoxPx)),
  };
}

function createBallWindow() {
  if (ballWin && !ballWin.isDestroyed()) { ballWin.showInactive(); return ballWin; }

  syncBallMetrics();
  const pos = clampBallPos(readBallPref().pos);
  ballAnchor = pos;
  ballOpen = false;
  ballGeo = null;

  ballWin = new BrowserWindow({
    x: pos.x, y: pos.y, width: ballBoxPx, height: ballBoxPx,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true,          // 任务栏里不留第二个条目，它是个浮件
    alwaysOnTop: true,
    hasShadow: false,           // 系统阴影会按矩形画，透明窗口上会露一圈方框
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'ball-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,   // preload 要用 webUtils 从拖进来的 File 上取真实路径，沙箱下拿不到
    },
  });

  // mac 上必须先 setVisibleOnAllWorkspaces 再 setAlwaysOnTop —— 顺序反过来
  // 会把窗口层级重置掉，球就沉到普通窗口下面去了（拖文件永远拖不到它身上）。
  // screen-saver 这一级才压得住全屏应用；普通 alwaysOnTop 一进全屏就被盖住。
  if (IS_MAC) {
    try { ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 老系统 */ }
  }
  ballWin.setAlwaysOnTop(true, 'screen-saver');
  ballWin.moveTop();

  ballWin.loadFile(BALL_PAGE);
  ballWin.once('ready-to-show', () => { if (ballWin && !ballWin.isDestroyed()) ballWin.showInactive(); });
  ballWin.webContents.on('did-finish-load', () => applyBallGeometry());
  ballWin.on('closed', () => { ballWin = null; ballOpen = false; ballGeo = null; });
  ballWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return ballWin;
}

function destroyBallWindow() {
  if (!ballWin || ballWin.isDestroyed()) { ballWin = null; return; }
  // 关窗前把位置记下来，下次还在原地起来
  try {
    const [x, y] = ballWin.getPosition();
    updateSettings({ ballPos: { x, y } });
  } catch { /* 拿不到就算了 */ }
  ballWin.destroy();
  ballWin = null;
  ballOpen = false;
  ballGeo = null;
}

/**
 * 展开时窗口要同时装下「球」和「面板」。
 * 球与面板并排（不是斜对角 —— 那样会空出一个 L 形的洞），
 * 水平方向默认往右弹、贴右边自动翻到左侧；垂直方向按球的位置决定贴顶还是贴底。
 */
function ballLayout() {
  const box = ballBoxPx;
  const anchor = ballAnchor || clampBallPos(readBallPref().pos);
  const area = screen.getDisplayNearestPoint(anchor).workArea;

  const right = anchor.x + box + BALL_GAP + BALL_PANEL.width <= area.x + area.width;
  const down = anchor.y + BALL_PANEL.height <= area.y + area.height;

  const w = box + BALL_GAP + BALL_PANEL.width;
  const h = Math.max(box, BALL_PANEL.height);
  const x = Math.min(Math.max(right ? anchor.x : anchor.x + box - w, area.x), area.x + area.width - w);
  const y = Math.min(Math.max(down ? anchor.y : anchor.y + box - h, area.y), area.y + area.height - h);

  const ball = { left: right ? 0 : w - box, top: down ? 0 : h - box, box };
  const panel = {
    left: right ? box + BALL_GAP : 0,
    top: 0,
    width: BALL_PANEL.width,
    height: BALL_PANEL.height,
  };
  const out = {
    bounds: { x: Math.round(x), y: Math.round(y), width: w, height: h },
    ball,
    panel,
    size: ballDiscPx,
    box,
    panelAndBall: () => ({ ball, panel, size: ballDiscPx, box }),
  };
  return out;
}
/**
 * 球现在该跟谁打交道。
 *
 * 「本机服务在跑」和「连着别人的主机」可以同时成立，所以必须有个明确规则，
 * 否则球会悄悄改投：按一下 Cmd+1 看一眼本机界面，球就以为你要发给本机了。
 * 规则按优先级来：
 *   1. 手动选过（面板顶部点一下就切）→ 听手动那个，记在设置里，重启还在
 *   2. 否则跟随「最近用过的那个窗口」—— 你在用哪个窗口，球就跟着谁
 *   3. 目标没了（那台断开了 / 本机服务停了）→ 看另一个还有没有，都没有就当没目标
 */
function ballTarget() {
  const inf = server.serverInfo();
  const host = inf.running
    ? { base: 'http://127.0.0.1:' + inf.port, kind: 'host', label: '本机主机', port: inf.port, id: '' }
    : null;

  const byId = (id) => {
    const l = id && links.get(id);
    if (!l) return null;
    return { base: l.url.replace(/\/+$/, ''), kind: 'link', label: '连到 ' + l.host, port: '', id: l.id };
  };
  const byUrl = (url) => {
    const u = String(url || '').replace(/\/+$/, '');
    for (const [, l] of links) if (l.url.replace(/\/+$/, '') === u) return byId(l.id);
    return null;
  };

  const pin = ballPinRead();
  if (pin) {
    const t = pin.kind === 'host' ? host : byUrl(pin.url);
    if (t) return t;
    // 手动指定的那台不在了：清掉这个记忆，免得一直卡在无效目标上
    ballPinWrite(null);
  }

  if (ballLastFocus && ballLastFocus.kind === 'link') {
    const t = byId(ballLastFocus.id);
    if (t) return t;
  }
  // 最近用的是主窗口（或从没用过）→ 只能是本机；本机没开服务就只能空着
  return host;
}

/** 手动选定的目标：{ kind:'host' } 或 { kind:'link', url } */
function ballPinRead() {
  if (ballPinCache !== undefined) return ballPinCache;
  const p = readSettings().ballPin;
  if (p && p.kind === 'host') ballPinCache = { kind: 'host' };
  else if (p && p.kind === 'link' && /^https?:\/\//i.test(String(p.url || ''))) {
    ballPinCache = { kind: 'link', url: String(p.url) };
  } else ballPinCache = null;
  return ballPinCache;
}

function ballPinWrite(p) {
  ballPinCache = p;
  updateSettings({ ballPin: p || null });
}

/** 记住「最近用的是哪个窗口」，球跟着它 */
function noteBallFocus(kind, id) {
  ballLastFocus = { kind, id: id || '' };
}

/**
 * 球的设备身份。
 * 主窗口开着时会把它自己的 cid 报过来，直接用那个（连别人时才有授权）；
 * 主窗口还没报（球先起来 / 主窗口在启动页）就用一个本机持久 cid ——
 * 关键是「同一个身份贯穿上传与合并发送」，服务端按 cid 认暂存文件的归属，
 * 两次请求各随机一个 cid，就会被判成「附件已失效」。
 */
function ballIdentity() {
  if (ballCid) return ballCid;
  const saved = String(readSettings().ballCid || '');
  if (/^[A-Za-z0-9_-]{3,64}$/.test(saved)) return saved;
  const made = 'd' + require('node:crypto').randomBytes(8).toString('hex');
  updateSettings({ ballCid: made });
  return made;
}

/** 主机模式带主控令牌（不然读不到私聊、也发不出东西）；连接模式只能靠 cid */
function ballUrl(t, p) {
  if (t.kind !== 'host') return t.base + p;
  return t.base + p + (p.includes('?') ? '&' : '?') + 'host=' + encodeURIComponent(server.hostToken);
}

/**
 * 这次请求该用哪个设备身份。
 * 连别人时必须用「对方主机授权过的那台设备」的 cid（从连接窗口的 localStorage 取的）；
 * 球自己的兜底 cid 在对方眼里是个没授权过的陌生设备，会被判「设备未授权」拒之门外。
 * 拿不到（窗口还没加载完 / 对方页面没存）才退回球的持久身份。
 */
function ballCidFor(t) {
  if (t && t.kind === 'link') {
    for (const [, l] of links) {
      if (l.url.replace(/\/+$/, '') === t.base && l.cid) return l.cid;
    }
  }
  return ballIdentity();
}

/** 这条内容在本机磁盘上有没有实物：有就能「打开文件位置」 */
function ballLocalCopy(t, it) {
  if (!it) return '';
  if (t && t.kind === 'host' && it.file) {
    const p = path.join(server.FILES_DIR, String(it.file));
    if (fs.existsSync(p)) return p;
  }
  // 连别人时：文件是对方机器上的，只有自己下过才有本地副本
  const nm = path.basename(String(it.name || ''));
  if (!nm) return '';
  const p = path.join(app.getPath('downloads'), nm);
  return fs.existsSync(p) ? p : '';
}

/** 列表里一行要展示的东西：类型、标题、组成、以及能不能定位 / 打开位置 */
function ballItemView(t, it) {
  const parts = Array.isArray(it.parts) && it.parts.length
    ? it.parts
    : (it.text ? [{ kind: 'text', text: it.text }] : []);
  const texts = parts.filter((p) => p.kind === 'text');
  const files = parts.filter((p) => p.kind !== 'text');
  const imgs = files.filter((p) => p.kind === 'image');
  const docs = files.filter((p) => p.kind !== 'image');
  const pick = docs[0] || imgs[0] || null;           // 「打开位置」认这一个文件
  const text = String((texts[0] && texts[0].text) || '');
  const snippet = text.replace(/\s+/g, ' ').trim();

  let title;
  let kind;
  if (pick && docs.length) {
    title = pick.name || '文件';
    if (docs.length > 1) title += ' 等 ' + docs.length + ' 个';
    kind = 'file';
  } else if (pick) {
    title = pick.name || '图片';
    if (imgs.length > 1) title += ' 等 ' + imgs.length + ' 张';
    kind = 'image';
  } else {
    title = snippet.slice(0, 120) || '（空内容）';
    kind = 'text';
  }
  if (pick && snippet && (texts.length || parts.length > 1)) kind = 'mixed';

  // 类型头像：文字用「文」，文件用后缀（PDF / PNG / MP4…）
  const tk = pick
    ? fileType.of(pick.name, pick.mime || pick.type)
    : { key: 'text', label: '文' };

  const comp = [];
  if (texts.length) comp.push('文字');
  if (imgs.length) comp.push(imgs.length + ' 张图片');
  if (docs.length) comp.push(docs.length + ' 个文件');

  return {
    id: it.id,
    kind,
    title,
    comp: parts.length > 1 ? comp.join(' + ') : '',
    from: it.from || '',
    time: it.time || 0,
    tk,
    snippet: snippet.slice(0, 400),
    fid: (pick && pick.fid) || '',
    name: (pick && pick.name) || '',
    file: (pick && pick.file) || '',
    canReveal: !!ballLocalCopy(t, pick),
  };
}

/** 定位要用哪个窗口：连别人的内容就在那个连接窗口里找，自己的内容在主窗口里找 */
function ballWindowFor(t) {
  if (t && t.kind === 'link') {
    const l = (t.id && links.get(t.id)) || [...links.values()].find((x) => x.url.replace(/\/+$/, '') === t.base);
    if (l) return l.win;
    const last = [...links.values()].pop();
    if (last) return last.win;
  }
  return hostWin && !hostWin.isDestroyed() ? hostWin : null;
}

/** 目标变了就告诉球一声，别等下一次轮询才更新标题 */
function refreshBallTarget() {
  if (!ballWin || ballWin.isDestroyed()) return;
  try { ballWin.webContents.send('ball:target-changed'); } catch { /* 页面还没就绪 */ }
}

/** 手动选目标：写进设置，并让面板立刻改口 */
function setBallPin(pin) {
  ballPinWrite(pin);
  refreshBallTarget();
}

/** 把某条内容滚到中间并闪一下（页面里暴露了 window.__xmLocate） */
async function locateInWindow(win, id) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  try {
    if (win.webContents.isLoading()) await once(win.webContents, 'did-finish-load');
    const ok = await win.webContents.executeJavaScript(
      'window.__xmLocate ? window.__xmLocate(' + JSON.stringify(String(id)) + ') : false',
      true,
    );
    return ok === true;
  } catch { return false; }
}

function registerBallIpc() {
  ipcMain.handle('ball:list', async () => {
    const t = ballTarget();
    if (!t) return { ok: false, online: false, error: '本机服务没开' };
    try {
      const r = await fetch(ballUrl(t, '/api/list'), { headers: { 'x-xm-cid': ballCidFor(t) } });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        return { ok: false, online: false, target: t, error: j.error || ('对方返回 ' + r.status) };
      }
      const d = await r.json();
      // 服务端给的是全量可见列表，这里只裁面板装得下的量；
      // 之前裁 10 条被用户吐槽「历史记录不全」——面板本身能滚，放宽到 40
      const items = (d.items || []).slice(0, 40).map((it) => ballItemView(t, it));
      const lastSeen = Number(readSettings().ballSeen || 0);
      return {
        ok: true, online: true, target: t, port: t.port,
        items,
        unread: items.filter((it) => (it.time || 0) > lastSeen).length,
      };
    } catch {
      return { ok: false, online: false, target: t, error: '连不上' };
    }
  });

  /** 面板打开过就算看过了 */
  ipcMain.handle('ball:seen', () => {
    updateSettings({ ballSeen: Date.now() });
    return { ok: true };
  });

  /** 页面初次加载要一份几何（窗口由主进程摆，页面只把球和面板放到对应位置） */
  ipcMain.handle('ball:layout', () => ({
    size: ballDiscPx, box: ballBoxPx, ball: { left: 0, top: 0 }, panel: null,
  }));

  ipcMain.handle('ball:expand', (_e, on) => {
    if (!ballWin || ballWin.isDestroyed()) return { size: ballDiscPx, box: ballBoxPx, ball: { left: 0, top: 0 } };
    ballOpen = !!on;
    if (!on) {
      const a = clampBallPos(ballAnchor || readBallPref().pos);
      ballAnchor = a;
      ballGeo = null;
      ballWin.setBounds({ x: a.x, y: a.y, width: ballBoxPx, height: ballBoxPx });
      return { size: ballDiscPx, box: ballBoxPx, ball: { left: 0, top: 0 }, panel: null };
    }
    ballGeo = ballLayout();
    ballWin.setBounds(ballGeo.bounds);
    return ballGeo.panelAndBall();
  });

  /**
   * 拖动：传这一帧的位移，主进程直接挪窗口。
   * 展开后也要能挪 —— 这时候球和面板在同一个窗口里，窗口整体移动，
   * 球位再按窗口内偏移换算回屏幕坐标，收起来时才不会跳。
   */
  ipcMain.on('ball:move', (_e, dx, dy) => {
    if (!ballWin || ballWin.isDestroyed()) return;
    const b = ballWin.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    let nx = Math.round(b.x + (Number(dx) || 0));
    let ny = Math.round(b.y + (Number(dy) || 0));
    nx = Math.min(Math.max(nx, area.x), area.x + area.width - b.width);
    ny = Math.min(Math.max(ny, area.y), area.y + area.height - b.height);
    if (nx === b.x && ny === b.y) return;
    ballWin.setPosition(nx, ny);
    const off = (ballOpen && ballGeo) ? ballGeo.ball : { left: 0, top: 0 };
    ballAnchor = { x: nx + off.left, y: ny + off.top };
  });

  ipcMain.on('ball:drag-end', () => {
    if (!ballWin || ballWin.isDestroyed()) return;
    if (!ballAnchor) {
      const [x, y] = ballWin.getPosition();
      ballAnchor = { x, y };
    }
    updateSettings({ ballPos: { x: ballAnchor.x, y: ballAnchor.y } });
  });

  /**
   * 面板顶部点一下：手动指定球发给谁。
   * 本机服务和连别人的窗口可以同时存在，靠「最近用过的窗口」自动跟随就够用了，
   * 但要给人一个能明确按下去的地方 —— 否则永远搞不清这个文件到底发去了哪。
   */
  ipcMain.handle('ball:pick-target', () => {
    if (!ballWin || ballWin.isDestroyed()) return { ok: false };
    const inf = server.serverInfo();
    const cur = ballTarget();
    const items = [
      {
        label: '本机主机' + (inf.running ? '' : '（接收服务没开）'),
        type: 'radio',
        checked: !!cur && cur.kind === 'host',
        enabled: inf.running,
        click: () => setBallPin({ kind: 'host' }),
      },
      { type: 'separator' },
    ];
    if (!links.size) {
      items.push({ label: '（还没有连其他主机）', enabled: false });
    } else {
      for (const [, l] of links) {
        items.push({
          label: '连到 ' + l.host,
          type: 'radio',
          checked: !!cur && cur.kind === 'link' && cur.id === l.id,
          click: () => setBallPin({ kind: 'link', url: l.url }),
        });
      }
    }
    items.push({ type: 'separator' });
    items.push({
      label: '改回自动跟随（最近用的窗口）',
      enabled: !!ballPinRead(),
      click: () => setBallPin(null),
    });
    Menu.buildFromTemplate(items).popup({ window: ballWin });
    return { ok: true };
  });

  /** 滚轮换大小：球上滚一下比翻菜单快 */
  ipcMain.handle('ball:size-step', (_e, dir) => {
    const order = ['sm', 'md', 'lg'];
    const cur = readBallPref().size;
    const at = Math.max(0, order.indexOf(cur));
    const next = order[Math.min(order.length - 1, Math.max(0, at + (Number(dir) > 0 ? 1 : -1)))];
    if (next === cur) return { ok: true, size: cur };
    setBallSize(next);
    return { ok: true, size: next };
  });

  ipcMain.handle('ball:open-host', () => { ensureHostWindow(); return { ok: true }; });
  ipcMain.handle('ball:copy', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });

  ipcMain.handle('ball:hide', () => setBallEnabled(false));

  // 主窗口一拿到身份就报过来，球的所有请求都借这个身份
  ipcMain.on('ball:identity', (_e, base, cid) => { reportBallIdentity(base, cid); });

  /** 定位：把人带到主界面那一行，滚到中间再闪一下 */
  ipcMain.handle('ball:locate', async (_e, id) => {
    const t = ballTarget();
    if (!t) return { ok: false, error: '本机服务没开' };
    let win = ballWindowFor(t);
    // 主窗口可能被收进托盘了、还停在启动页（file://）—— 先把它叫成真正的界面
    if (!win || win.isDestroyed() || String(win.webContents.getURL()).startsWith('file:')) {
      win = await ensureHostWindow();
    }
    if (!win || win.isDestroyed()) return { ok: false, error: '没有可以定位的窗口' };
    const ok = await locateInWindow(win, id);
    return ok ? { ok: true } : { ok: false, error: '这条已不在当前列表里' };
  });

  /** 打开文件位置：只有本机真有这份文件时才有意义 */
  ipcMain.handle('ball:reveal', (_e, payload) => {
    const t = ballTarget();
    if (!t) return { ok: false, error: '本机服务没开' };
    const p = ballLocalCopy(t, payload || {});
    if (!p) return { ok: false, error: t.kind === 'host' ? '文件已经不在了' : '还没下载到本机' };
    shell.showItemInFolder(p);
    return { ok: true };
  });

  /**
   * 发东西：一段文字 / 一组文件 / 两者一起。
   * 文字和文件可以同属一条消息 —— 先说一句「这是原图」，附件跟在后面。
   */
  ipcMain.handle('ball:send', async (_e, payload) => {
    const t = ballTarget();
    if (!t) return { ok: false, error: '本机服务没开' };

    const p = payload && typeof payload === 'object' ? payload : { paths: payload };
    const list = (Array.isArray(p.paths) ? p.paths : []).filter(Boolean).slice(0, 20);
    const body = String(p.text || '').replace(/\u0000/g, '').trim();
    if (!list.length && !body) return { ok: false, error: '没有可发送的内容' };

    const cid = ballCidFor(t);
    const parts = [];
    const failed = [];   // { name, reason } —— 界面要把失败原因念给人听，别只说「失败」

    for (const one of list) {
      const name = path.basename(String(one));
      try {
        const st = fs.statSync(one);
        if (!st.isFile()) { failed.push({ name, reason: '不是文件' }); continue; }
        const q = '/api/upload?name=' + encodeURIComponent(path.basename(one)) +
          '&cid=' + encodeURIComponent(cid);
        const stream = Readable.toWeb(fs.createReadStream(one));
        const r = await fetch(ballUrl(t, q), {
          method: 'POST',
          body: stream,
          duplex: 'half',
          headers: { 'x-xm-cid': cid, 'content-type': 'application/octet-stream' },
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          failed.push({ name, reason: j.error || ('对方返回 ' + r.status) });
          continue;
        }
        const d = await r.json();
        if (d.part) parts.push(d.part); else failed.push({ name, reason: '服务端没给回执' });
      } catch (err) {
        failed.push({ name, reason: err && err.code === 'ENOENT' ? '文件不存在' : '读不了这个文件' });
      }
    }

    if (list.length && !parts.length) {
      return { ok: false, error: failed.map((f) => f.name + '：' + f.reason).join('；') || '没有可发送的文件' };
    }

    // 文字排在最前面：一条消息里先说事，再挂附件
    const all = body ? [{ type: 'text', text: body }, ...parts] : parts;
    try {
      const r = await fetch(ballUrl(t, '/api/send'), {
        method: 'POST',
        headers: { 'x-xm-cid': cid, 'content-type': 'application/json' },
        body: JSON.stringify({ cid, parts: all }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        return { ok: false, error: j.error || '发送失败' };
      }
    } catch {
      return { ok: false, error: '发送失败' };
    }
    refreshTray();
    return {
      ok: true, sent: parts.length, failed: failed.length, text: !!body, target: t.label,
      failedNames: failed.map((f) => f.name + '（' + f.reason + '）'),
    };
  });
}

/** 主窗口把自己的身份和所在 origin 报过来 —— 球用它读列表、发文件 */
function reportBallIdentity(base, cid) {
  if (typeof base === 'string' && /^https?:\/\//i.test(base)) ballBase = base;
  if (typeof cid === 'string' && cid) ballCid = cid.slice(0, 64);
  return { ok: true };
}

/* ------------------------------------------------------------ 生命周期 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { ensureHostWindow(); });

  app.whenReady().then(async () => {
    // macOS 开发模式下 Dock 上是 Electron 自带图标（装成 app 才有自己的），
    // 运行时换成我们的，免得调试时 Dock 里一直坐着一个 Electron
    if (IS_MAC && app.dock) {
      try { app.dock.setIcon(APP_ICON); } catch { /* 无 Dock 的环境就算了 */ }
    }

    buildMenu();          // 菜单先挂上，别让窗口出来时顶栏是空的
    buildTray();          // 托盘尽早建：关闭按钮的三种结局都依赖它在不在
    syncBallMetrics();    // 球的尺寸先算好，后面布局都靠它
    registerBallIpc();    // 悬浮球的请求通道先打通，窗口起来就能用
    createHostWindow();   // 窗口与启动页立刻出现 —— 双击就有反馈，不用干等任何东西
    // 悬浮球默认不出场：它是用户临时叫出来的浮件，每次启动都从关着开始

    setupAutoUpdater();

    // 记住过就直接按记忆走；没记住（首次一定是）就把选择权交给启动页
    runStartPref();

    app.on('activate', () => { ensureHostWindow(); });
  });

  // macOS：关掉窗口不退程序，主机继续在后台跑（手机上还能传）
  // Windows / Linux：关掉就退，免得用户以为没退出
  // （「收进托盘」那条路在主窗口的 close 事件里就拦下了，走不到这里）
  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });

  // 退出前把端口放掉，别留下一个半死不活的监听
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    // 托盘先撤掉：mac 上偶尔会出现「进程退了、菜单栏图标还挂着」的残影
    if (tray) {
      try { tray.destroy(); } catch { /* 已经没了 */ }
      tray = null;
    }
    server.stopServer().finally(() => app.quit());
  });
}
