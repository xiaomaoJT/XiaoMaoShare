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
        // 服务没跑：把选择页强制显示出来 —— 否则会卡在启动动画上，看得见却点不动
        hostWin.loadFile(START_PAGE, { query: { force: '1' } });
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
    // 「只连别人」时主窗口是藏着的，关掉这个窗口不会触发 window-all-closed，
    // 得自己判断一次，否则会留下一个看不见却在后台常驻的进程
    quitIfNoVisibleWindow();
  });

  win.loadURL(n.url);
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
  function send(t){ document.title = t; }
  window.__setPath = function (d) { p.value = d; };
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
  document.getElementById('o').onclick = function () { if (val()) send('DDOK:' + encodeURIComponent(val())); };
  document.getElementById('c').onclick = function () { window.close(); };
  p.focus();
<\/script>`));

  guideWin.webContents.on('page-title-updated', async (e, title) => {
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
    hostWin.webContents.send('desktop:start-error', String(text || ''));
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
      target = 'host';
      pending = linkHost + ' 连不上，已回到我的主机';
      // 记忆里那台已经不在了：这次不是用户主动选的，就别让他每次开机都白等 1.2 秒
      if (!remember) updateSettings({ startMode: 'ask' });
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

  // 第一次收起时说一声 —— 否则 Windows 用户会以为程序没退干净
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
 */
async function askCloseChoice() {
  if (closeAsking) return;
  closeAsking = true;

  const inf = server.serverInfo();
  const port = inf.running ? inf.port : (readPortPref() || DEFAULT_PORT);
  let r;
  try {
    r = await dialog.showMessageBox(hostWin && !hostWin.isDestroyed() ? hostWin : undefined, {
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
    hideToTray();
  } else if (r.response === 1) {
    if (r.checkboxChecked) setCloseAction('quit');
    app.quit();
  }
  // 2 = 取消：什么都不做，窗口原样留着
}

/* ------------------------------------------------------------ 生命周期 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { ensureHostWindow(); });

  app.whenReady().then(async () => {
    buildMenu();          // 菜单先挂上，别让窗口出来时顶栏是空的
    buildTray();          // 托盘尽早建：关闭按钮的三种结局都依赖它在不在
    createHostWindow();   // 窗口与启动页立刻出现 —— 双击就有反馈，不用干等任何东西

    setupAutoUpdater();

    // 记住过就直接按记忆走；没记住（首次一定是）就把选择权交给启动页
    const pref = readStartPref();
    if (pref.mode !== 'ask') {
      applyStartChoice({
        action: pref.mode === 'link' ? 'link' : 'host',
        url: pref.lastLinkUrl,
        keepHost: pref.keepHost,
        remember: false,
      }).catch((e) => startPageError('启动失败：' + ((e && e.message) || '未知错误')));
    }

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
