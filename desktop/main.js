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

const { app, BrowserWindow, ipcMain, Menu, Tray, shell, clipboard, dialog, nativeImage, screen, session, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
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
let ballMenuWin = null;   // 右键菜单是**独立窗口**（球窗永远只有球那么大）
let ballMenuSeq = 0;      // 菜单展开序号：延时收回时用来判断「这期间有没有人重新展开过」
let ballOnline = false;   // 最近一次拉列表的连接状态，菜单胶囊拿来点绿灯
let ballActivating = false; // 「打开界面」激活流程进行中（这期间失焦不收菜单）

/* ------------------------------------------------- 连别人时的历史快照缓存
   主进程本来就每隔几秒去对方主机拉一次 /api/list（见 startNoticeWatch），
   顺手把最近一次成功的结果按 origin 存下来。对方服务一停、连接窗口被刷新/
   重开时，did-fail-load 兜不住（页面在死掉的主机那边），我们就用这份快照
   渲染一个「对方主机不在线 + 最后的文件列表」，而不是一句冷冰冰的连不上。 */
const linkSnaps = new Map(); // origin -> { data, at, sig }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function loadLinkSnaps() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'link-snapshots.json'), 'utf8'));
    if (o && typeof o === 'object') for (const k in o) linkSnaps.set(k, o[k]);
  } catch {}
}

function saveLinkSnaps() {
  try {
    const o = {};
    for (const [k, v] of linkSnaps) o[k] = v;
    fs.writeFileSync(path.join(app.getPath('userData'), 'link-snapshots.json'), JSON.stringify(o));
  } catch {}
}

function cacheSnapshot(origin, data) {
  if (!origin || !data) return;
  const sig = JSON.stringify(data.items || '');
  const prev = linkSnaps.get(origin);
  if (prev && prev.sig === sig) { prev.at = Date.now(); return; } // 没变化只更新时间，不落盘
  linkSnaps.set(origin, { data, at: Date.now(), sig });
  saveLinkSnaps();
}

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

/** mac 上点窗口，顶部菜单栏要切成自己的 —— 窗口在后台被 show 出来、或无框窗的场景，
 *  系统不一定顺带激活 app，菜单栏就还挂在别的应用名下。focus 时补一脚。 */
/**
 * 保证本进程一直是「常规应用」（有菜单栏、有 Dock 图标）。
 *
 * 这是个真坑，实测出来的（macOS 27 + Electron 45）：
 * `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` 会把整个 App 的
 * activationPolicy 偷偷改成 **accessory** —— 一旦变成 accessory，应用**根本没有菜单栏**，
 * 点任何窗口（自己 show 出来也好、用户手动点也好）菜单栏都不会跟随，因为「跟随」的对象
 * 压根不存在。而且这状态会一直挂着，直到某处调 `app.dock.show()` 把它拉回 regular
 * （关悬浮球正好会走 ensureDockIcon → dock.show，于是出现「关掉球才恢复」的怪象）。
 *
 * 对照实验（同机实测）：只开球窗=regular；+floating=regular；+全空间(无选项)=regular；
 * +visibleOnFullScreen=**accessory**；再 setActivationPolicy('regular') 立刻回到 regular，
 * 且球的 isVisibleOnAllWorkspaces 仍为 true（全屏可见没丢）。所以每次动完球的层级都补一刀。
 */
function ensureRegularApp() {
  if (!IS_MAC || quitting) return;
  try { app.setActivationPolicy('regular'); } catch { /* 老版本没有这个 API */ }
  try { if (app.dock && !app.dock.isVisible()) app.dock.show(); } catch { /* 没 Dock 的环境 */ }
}

/** mac：窗口是程序里 show 出来的（悬浮球按钮 / 托盘 / 菜单），系统经常不顺带激活 app ——
 *  菜单栏不切、窗口沉在别的应用下面。所有「把窗口叫起来」的地方都补一脚。 */
function activateApp() {
  if (!IS_MAC || quitting) return;
  ensureRegularApp();   // accessory 状态下激活是白搭：先确保自己是常规应用
  try { app.focus({ steal: true }); } catch { /* 老版本不收参数 */ }
}

/**
 * 窗口真可见之前一直补激活。
 *
 * 为什么需要：`show()` 只对「已经能画出画面」的窗口才立刻生效 —— 新开的窗口要等
 * 导航完成、`ready-to-show` 才真的上屏。那句 `app.focus({steal:true})` 如果在这一刻
 * 之前就调完，系统激活的是「还没上屏的窗口」，等窗口姗姗来迟地出现时没人再激活它，
 * 菜单栏就还挂在别的应用名下（关掉悬浮球就好，因为那时又走了另一条焦点路径）。
 * 所以这里在窗口可见之前以 120ms 为一拍持续确认，最多 ms 毫秒。
 */
function ensureFront(win, ms = 1400) {
  if (!IS_MAC) return;
  const t0 = Date.now();
  const tick = () => {
    if (quitting) return;
    if (!win || win.isDestroyed()) return;
    ensureRegularApp();   // 期间若有代码把 policy 打成 accessory（球的层级调用），这里补回来
    if (win.isVisible()) {
      try { app.focus({ steal: true }); } catch { /* 无所谓 */ }
      try { if (ballWin && !ballWin.isDestroyed() && ballWin.isFocused()) ballWin.blur(); } catch { /* 同上 */ }
    }
    if (Date.now() - t0 < ms) setTimeout(tick, 120);
  };
  setTimeout(tick, 40);
}

function stealAppFocusOn(win) {
  if (!IS_MAC) return;
  // focus 事件里同步调会被吞，推迟到下一轮
  win.on('focus', () => { if (!quitting) setImmediate(activateApp); });
  // 「先创建、稍后才上屏」的窗口可能压根不发 focus —— show 也补一脚。
  // 否则菜单栏会一直挂在别的应用名下，直到用户再点一次窗口。
  win.on('show', () => { if (!quitting) setImmediate(activateApp); });
}

/**
 * 给页面补上浏览器自带的那个右键菜单（Electron 没有默认右键菜单，右键是空的）。
 * 图片上：复制图片 / 复制图片地址；文字上：复制 / 粘贴 / 剪切 / 全选。
 * 走主进程 copyImageAt，不依赖页面的 navigator.clipboard（http://IP 非安全上下文
 * 下那个 API 根本不存在），也不依赖对方主机是否升级 HTTPS —— 主窗口、连接窗口通吃。
 */
function attachContextMenu(win) {
  const wc = win.webContents;
  wc.on('context-menu', (_e, params) => {
    const items = [];
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        {
          label: '复制图片',
          click: () => { try { wc.copyImageAt(params.x, params.y); } catch {} },
        },
        {
          label: '复制图片地址',
          click: () => { clipboard.writeText(params.srcURL); },
        },
      );
    }
    if (params.isEditable) {
      if (items.length) items.push({ type: 'separator' });
      if (params.editFlags.canCut) items.push({ role: 'cut', label: '剪切' });
      if (params.editFlags.canCopy) items.push({ role: 'copy', label: '复制' });
      if (params.editFlags.canPaste) items.push({ role: 'paste', label: '粘贴' });
      items.push({ role: 'selectAll', label: '全选' });
    } else if (params.editFlags && params.editFlags.canCopy && params.selectionText) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ role: 'copy', label: '复制文字' });
    }
    if (!items.length) return;   // 空白处右键不弹菜单，跟浏览器上只对图片/文字弹一致
    Menu.buildFromTemplate(items).popup({ window: win });
  });
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
  stealAppFocusOn(hostWin);   // mac：点到窗口，菜单栏就得是自己的

  // 先显示启动页（不依赖本地服务器，双击后立即有反馈），服务就绪后再换真实页
  if (hostInfo) hostWin.loadURL(hostInfo.hostUrl); // 窗口重建时服务已在跑，直接进真实页，不必闪一下启动页
  else hostWin.loadFile(START_PAGE);
  hostWin.show();
  startNoticeWatch(hostWin);   // 收消息提醒由主进程统一负责（页面只负责展示）
  attachContextMenu(hostWin);  // 浏览器同款右键：图片可复制，输入框有剪切/粘贴

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
  // 启动记忆是「连上次那台」且那个窗口还开着（含收进托盘的）→ 直接回到它。
  // 不做这步的话：主窗口先 show 出来、又按记忆 hide 转投对方窗口 —— 用户看到的就是
  // 「蹦出两个窗口、第一个闪一下自己关了」的毛躁体验
  const pref0 = readStartPref();
  if (pref0.mode === 'link' && pref0.lastLinkUrl) {
    for (const [, l] of links) {
      if (l.url === pref0.lastLinkUrl && !l.win.isDestroyed()) {
        if (l.win.isMinimized()) l.win.restore();
        l.win.show();
        l.win.focus();
        activateApp();
        return l.win;
      }
    }
  }
  if (hostWin && !hostWin.isDestroyed()) {
    const u = String(hostWin.webContents.getURL());
    if (u.startsWith('file:')) {
      const inf = server.serverInfo();
      let nav = null;
      if (inf.running) {
        // 服务在跑：直接进真实界面，别让用户看到一张过期的启动页
        hostInfo = inf;
        nav = hostWin.loadURL(inf.hostUrl);
      } else if (!u.includes('force=1')) {
        // 服务没跑：记过启动方式就按记忆重新走一遍（连上次那台 / 起本机服务），
        // 只有「每次问我」才亮选择页 —— 记了「直接连」还天天被问，等于没记
        if (runStartPref()) {
          // 按记忆走了：目的地多半不是这张启动页 —— 先藏好再换装，
          // 不然就是「闪一下选择页、再跳进主界面」的毛躁体验。
          // 走失败了 applyStartChoice / startPageError 会自己把窗口亮出来
          if (hostWin.isVisible()) hostWin.hide();
        } else {
          hostWin.loadFile(START_PAGE, { query: { force: '1' } });
        }
      }
      if (nav) {
        if (hostWin.isVisible()) hostWin.hide();
        nav.catch(() => {}).then(() => {
          if (!hostWin || hostWin.isDestroyed()) return;
          hostWin.show();
          hostWin.focus();
          activateApp();
        });
        return hostWin;
      }
    }
    if (hostWin.isMinimized()) hostWin.restore();
    hostWin.show();
    hostWin.focus();
    activateApp();
    return hostWin;
  }
  createHostWindow();
  if (hostWin.webContents.isLoading()) await once(hostWin.webContents, 'did-finish-load');
  return hostWin;
}

/**
 * 「打开我的主机界面」（菜单 ⌘1 / 悬浮球按钮）：语义就是本机主机 ——
 * 服务没起就当场起，然后主窗口指到本机界面。
 * 不能复用 ensureHostWindow：那个按启动记忆走，记忆是「连别人」时
 * 会把人又带回对方窗口，还让主窗口闪一下 —— 和菜单文案直接打架。
 */
async function openMyHost() {
  const info = await ensureHostServer();
  if (!info) {
    startPageError('本机服务没起来。可以再试一次，或者先连别人的主机。');
    return;
  }
  if (!hostWin || hostWin.isDestroyed()) createHostWindow();
  if (hostWin.isMinimized()) hostWin.restore();
  hostWin.show();
  hostWin.focus();
  activateApp();
  hostWin.loadURL(info.hostUrl);
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
      // 只挂「上报通知」这一条通道：页面能喊主进程弹通知，但拿不到任何别的能力。
      // 不挂这个的话，收到消息就只能退回页面里的 HTML5 通知 —— 而那条路在 macOS
      // 上是被权限短路掉的（构造不报错，系统侧静默丢弃）
      preload: path.join(__dirname, 'notice-preload.js'),
      spellcheck: false,
    },
  });

  // 页面自己的 <title> 会覆盖窗口标题，这里按住，让人一眼看出「这是别人的主机」
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(`连到 ${n.host} — XiaoMao 互传`);
  });
  stealAppFocusOn(win);   // mac：连接窗口被点到 / 叫回来时，菜单栏同步切过来

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  attachContextMenu(win);   // 连接窗口也要浏览器同款右键（图片复制等）

  // 这是最后一个可见窗口时，点关闭 = 整个应用「消失」进托盘 —— 得和主窗口一个待遇：
  // 「每次问我」就问一句，别闷声把界面全收走（用户会以为程序退了，连问都不问）
  let linkForceClose = false;
  win.on('close', (e) => {
    if (quitting || linkForceClose || win.__xmNoAsk) return;
    // 悬浮球是浮件，不该算「还有别的窗口看着」—— 否则一开球，关闭就永远问不出口
    if (!tray) return;   // 没托盘可收：照常关
    const policy = readClosePref();
    // 「收入托盘」是藏起来不是关掉：窗口一销毁，连接、这条记录、悬浮球的数据源全没 ——
    // 球面板会瞬间变成空的，跟断了线一样。hide 保留现场，托盘/菜单随时叫回来。
    // 关闭策略对每一次点击都生效（别的窗口开着也一样，分离 ≠ 免问）——
    // 之前有别的窗口就静默藏起来不问，用户设了「每次询问」却时问时不问
    const parkAndClose = () => { linkForceClose = true; win.hide(); refreshTray(); notifyTrayParked(); };
    if (policy === 'quit') { e.preventDefault(); setImmediate(() => app.quit()); return; }
    e.preventDefault();
    if (policy === 'tray') { parkAndClose(); return; }
    askCloseChoice(parkAndClose);
  });
  // 藏进托盘后下次亮出来，就得重新按关闭策略走 —— 不复位的话第二回点关闭
  // 会一声不吭把窗口真关掉（用户看到的就是「时问时不问」）
  win.on('show', () => { linkForceClose = false; win.__xmNoAsk = false; });

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = 用户自己取消，不算失败
    let snap = null;
    try { const origin = new URL(n.url).origin; snap = linkSnaps.get(origin) || null; } catch {}
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(offlinePage(n.host, snap)));
  });

  const rec = { id, url: n.url, host: n.host, win, cid: '' };
  links.set(id, rec);
  // 球以后要替这台发东西：先把地址记住（cid 等页面加载出来再补）
  rememberBallLink(n.url, '');
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
  startNoticeWatch(win);   // 收消息的口头提醒由主进程负责，不看对方页面版本

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
          rememberBallLink(n.url, cid);
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

/** 连不上时给一页人话，而不是 Electron 那句 ERR_CONNECTION_REFUSED。
   若主进程手里还有对方最后的列表快照，一并陈列出来，并明确告诉用户「主机不在线」 */
function offlinePage(host, snap) {
  const h = String(host || '').replace(/[<>&]/g, '');
  let listHtml = '';
  const items = snap && snap.data && Array.isArray(snap.data.items) ? snap.data.items : [];
  if (items.length) {
    const at = snap.at ? new Date(snap.at).toLocaleString() : '';
    listHtml = '<p class="sub">以下为最后的快照' + (at ? '（' + escapeHtml(at) + '）' : '') + '：</p>'
      + '<ul class="lst">'
      + items.slice(0, 60).map((it) => {
        const kind = it.kind === 'text' ? '文字' : '文件';
        const title = it.kind === 'text'
          ? String(it.text || '').slice(0, 80)
          : ((it.parts && it.parts[0] && it.parts[0].name) || '附件');
        const from = it.from ? ' · ' + String(it.from) : '';
        return '<li><span class="tag">' + kind + '</span>' + escapeHtml(title) + escapeHtml(from) + '</li>';
      }).join('')
      + '</ul>';
  }
  return `<!doctype html><meta charset="utf-8"><title>对方主机不在线</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#f4f6f9;
       font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#3d4450}
  .box{max-width:460px;padding:28px;text-align:center}
  h1{font-size:17px;margin:0 0 10px;color:#b42318}
  p{margin:0 0 8px;color:#6b7280}
  code{background:#eef1f6;padding:2px 6px;border-radius:5px;font-size:13px}
  .sub{margin-top:18px;font-size:13px}
  .lst{list-style:none;padding:0;margin:10px 0 0;text-align:left;max-height:320px;overflow:auto}
  .lst li{padding:7px 10px;border:1px solid #e5e8ef;border-radius:8px;margin-bottom:6px;font-size:13px;
          display:flex;gap:8px;align-items:center;background:#fff}
  .tag{flex:none;background:#eef1f6;color:#52607a;border-radius:5px;padding:1px 6px;font-size:12px}
</style>
<div class="box">
  <h1>对方主机不在线</h1>
  <p>连不上 <code>${h}</code>。对方可能关掉了服务，或已不在同一网络。</p>
  ${listHtml}
  <p class="sub">恢复连接后刷新即可看到最新内容。</p>
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

// 「收到消息」：页面判断完要不要提醒，把标题/正文交过来，这里弹真正的系统通知
ipcMain.handle('notice:incoming', (e, payload) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return notifyIncoming(payload, win);
});
// 自检入口（菜单 / 托盘里点一下）：通不通一眼就知道，不用等别人真发一条
ipcMain.handle('notice:test', () => {
  // Windows 没快捷方式就压根弹不出来，先把这层原因说清楚，别让人对着「没反应」猜
  if (process.platform === 'win32') {
    try {
      if (!fs.existsSync(winShortcutPath())) {
        return {
          error: '系统里没有「XiaoMao 互传」的开始菜单快捷方式，Windows 不会投递通知。\n'
            + '用安装包（NSIS 那个 .exe）装一次就好；便携版需要能写开始菜单。',
        };
      }
    } catch { /* 查不到就不拦，照常发 */ }
  }
  return notifyIncoming({
    title: 'XiaoMao 互传 · 通知自检',
    body: '看到这条就说明系统通知是通的；别人发来内容时会这样提醒你。',
  }, hostWin);
});

/**
 * 诊断用：系统通知中心里现在到底有没有我们投递出去的东西。
 * macOS 上未签名的构建永远返回空数组 —— 这是判断「到底有没有真投递」的硬证据。
 */
ipcMain.handle('notice:history', async () => {
  try {
    if (typeof Notification.getHistory !== 'function') return { error: '当前 Electron 没有这个接口' };
    const list = await Notification.getHistory();
    return {
      count: list.length,
      items: list.slice(0, 5).map((n) => ({ title: n.title, body: n.body })),
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

ipcMain.handle('link:close', (_e, id) => {
  const l = links.get(id);
  // 明确的「断开这台」：别再拿应用级的关闭询问拦一道，那问的是「还要不要接收」，
  // 和用户点的是两回事。断开的同时忘掉球记的那台，否则球还会往已断开的地址发
  if (l) { forgetBallLink(l.url); l.win.__xmNoAsk = true; l.win.close(); return { ok: true }; }
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
        { label: '打开我的主机界面', accelerator: 'CmdOrCtrl+1', click: () => openMyHost() },
        {
          // 退出当前状态、重新挑一次。主机模式下会把接收服务一起关掉 ——
          // 不关的话界面回选择页、后面却还开着端口，用户以为已经退出了
          label: '返回选择页…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => backToChooser(),
        },
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
            { label: '现在重新选一次…', click: () => backToChooser() },
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
          : { label: '本机未开接收服务', enabled: false },
        server.serverInfo().running
          ? {
            // 只关服务，别的都不动：连着的别人的窗口照常、悬浮球自动改发对方
            label: '关闭本机接收服务（其它连接保持）',
            click: () => stopHostService(),
          }
          : {
            label: '开启本机接收服务',
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
          // 通知到底通不通，点一下就知道了 —— 不用等别人真发条消息来试
          label: '测试系统通知',
          click: () => {
            notifyIncoming({
              title: 'XiaoMao 互传 · 通知自检',
              body: '看到这条就说明系统通知是通的；别人发来内容时会这样提醒你。',
            }, hostWin).then((r) => {
              if (!r || !r.error) return;
              dialog.showMessageBox({
                type: 'warning',
                message: '这条通知发不出去',
                detail: `原因：${r.error}\n\n到「系统设置 → 通知」里找一下 XiaoMao 互传，确认允许通知。`,
                buttons: ['好'],
              }).catch(() => {});
            });
          },
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
 * 单独关掉本机接收服务，别的不动。
 *
 * 现在的真实场景：一台主机给多台设备当接收方，同时自己也可能连着别人的主机。
 * 「关掉本机接收」和「退出程序」是两件事 —— 只想让手机暂时传不进来，不该连带
 * 把连着的别人的窗口一起关了。
 */
async function stopHostService() {
  if (!server.serverInfo().running) return { ok: true, already: true };
  await server.stopServer();
  hostInfo = null;
  buildMenu();
  refreshTray();

  // 主窗口要是正停在本机界面，页面上的操作已经全打空了 —— 挪回选择页说清楚
  if (hostWin && !hostWin.isDestroyed()) {
    const u = String(hostWin.webContents.getURL());
    if (/^https?:\/\/127\.0\.0\.1/i.test(u) || /^https?:\/\/localhost/i.test(u)) {
      hostWin.loadFile(START_PAGE, { query: { force: '1', startErr: encodeURIComponent('本机接收服务已关闭') } });
      hostWin.show();
      hostWin.focus();
    }
  }
  // 球的目标可能在刚才那个服务上 —— 让它自己重新算一遍
  refreshBallTarget();
  return { ok: true };
}

/** 返回选择页 = 退出当前状态：主机模式下先把接收服务关掉，免得界面还挂着「本机可被连接」 */
async function backToChooser() {
  if (server.serverInfo().running) await stopHostService();
  await openStartChooser();
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
      // 用户想的是「连他」，结果变成了「当主机」，这属于替人做主。
      // 记忆保留不动：对方可能只是暂时没开，下次还该自动试 ——
      // 清了记忆的话，一次断线就把「直接连」降级成「每次问我」，用户会觉得记性变差了
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
    // ensureHostWindow 会先把主窗藏起来换装（免得闪选择页），这里到位了再亮出来；
    // 从选择页正常点进来的场景窗口本来就看得见，show 是幂等的
    hostWin.show();
    hostWin.focus();
    activateApp();
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
  const anyVisible = BrowserWindow.getAllWindows().some(
    (w) => !w.isDestroyed() && w !== ballWin && w.isVisible(),
  );
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
/** mac：窗口全收进托盘后 Dock 图标偶尔会被系统弄丢（Electron 的老毛病）。
 *  只要进程活着（没真退出），Dock 里就该一直坐着 —— 丢了就扶回来。 */
function ensureDockIcon() {
  if (!IS_MAC || !app.dock || quitting) return;
  try {
    if (!app.dock.isVisible()) app.dock.show();
    app.dock.setIcon(APP_ICON);
  } catch { /* Dock 不可用的环境就算了 */ }
}

function refreshTray() {
  if (IS_MAC) setImmediate(ensureDockIcon);   // 每次窗口/托盘状态变化都检查一遍
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
      : { label: '本机未开接收服务', enabled: false },
    inf.running
      ? { label: '关闭本机接收服务（其它连接保持）', click: () => stopHostService() }
      : {
        label: '开启本机接收服务',
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
    {
      // 通不通不用等人真发一条消息来试：点一下就该看到一条系统通知。
      // 弹不出来得说清楚原因，不然用户只会以为「又没反应」
      label: '测试系统通知',
      click: () => {
        notifyIncoming({
          title: 'XiaoMao 互传 · 通知自检',
          body: '看到这条就说明系统通知是通的；别人发来内容时会这样提醒你。',
        }, hostWin).then((r) => {
          if (!r || !r.error) return;
          dialog.showMessageBox({
            type: 'warning',
            message: '这条通知发不出去',
            detail: `原因：${r.error}\n\n到「系统设置 → 通知」里找一下 XiaoMao 互传，确认允许通知。`,
            buttons: ['好'],
          }).catch(() => {});
        });
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
}

function showFromTray() {
  if (hostWin && !hostWin.isDestroyed() && hostWin.isVisible()) {
    if (hostWin.isMinimized()) hostWin.restore();
    hostWin.focus();
    activateApp();   // 托盘叫回来的窗口也要把菜单栏带回来（accessory 状态下 focus 是白搭）
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

  // 还有别的界面开着（比如连别人的窗口）：关主窗口只收主窗口自己，
  // 主机服务照跑，别把别人的窗口一起带走 —— 多窗口各关各的
  const otherVisible = BrowserWindow.getAllWindows().some(
    (w) => !w.isDestroyed() && w !== hostWin && w !== ballWin && w.isVisible(),
  );
  // 分离 ≠ 免问：关闭策略对**每一次**点击都生效，只是「收托盘」在有别的
  // 界面时只收自己这一个窗口。之前有别的窗口就静默跳过询问，用户设了
  // 「每次询问」却发现时问时不问，就是这个旁路在作怪
  const parkSelf = () => { hostWin.hide(); refreshTray(); notifyTrayParked(); };
  const park = otherVisible ? parkSelf : hideToTray;

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
  if (policy === 'tray') { park(); return; }
  askCloseChoice(park);
}

function hideToTray() {
  // 「收入托盘」= 整个界面收起来，不只是主窗口：多客户端场景下对方窗口还晾在
  // 桌面上，用户会以为没关干净。球是常驻浮件，不算界面，留着
  if (hostWin && !hostWin.isDestroyed()) hostWin.hide();
  for (const [, l] of links) {
    if (l.win && !l.win.isDestroyed() && l.win.isVisible()) l.win.hide();
  }
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

/* ============================================================ 收到消息的系统通知
   页面只负责判断「该不该提醒」（是不是别人发来的、窗口在不在前台），
   真正的「弹」交给主进程。

   为什么不用页面里的 HTML5 Notification：主进程给会话放行权限时是直接返回
   granted 的，Chromium 于是以为有权限，**绕过了 macOS 的授权流程** —— 系统那边
   从没登记过这个 app，构造不报错、通知被静默丢弃（`com.apple.ncprefs` 里查不到
   任何记录）。Electron 的 Notification 走的是系统通知框架，会正常走授权，
   点一下还能把窗口拉回来。
*/

/**
 * @param {{title?:string, body?:string}} [payload]
 * @param {import('electron').BrowserWindow} [source] 点通知时要叫起来的窗口
 * @returns {{ok:true} | {error:string}}
 */
function notifyIncoming(payload, source) {
  const title = String((payload && payload.title) || 'XiaoMao 互传').slice(0, 120);
  const body = String((payload && payload.body) || '').slice(0, 240);
  if (!Notification.isSupported()) return Promise.resolve({ error: '这台系统不支持桌面通知' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const n = new Notification({ title, body });
      n.on('click', () => {
        const target = (source && !source.isDestroyed()) ? source
          : (hostWin && !hostWin.isDestroyed()) ? hostWin
            : null;
        if (!target) return;
        try { if (target.isMinimized()) target.restore(); } catch { /* 无所谓 */ }
        try { target.show(); } catch { /* 同上 */ }
        activateApp();
        try { target.focus(); } catch { /* 同上 */ }
      });
      // macOS 的通知走 UNNotification，**要求应用已代码签名**才有投递资格；
      // 没签名时它会在这里报失败，而不是静默消失 —— 把原因带回去，别让人瞎猜
      n.on('failed', (_evt, err) => done({
        error: String(err || '系统拒绝了这条通知 —— macOS 要求应用已签名'),
      }));
      n.on('show', () => done({ ok: true }));
      n.show();
      // 没报失败就当发出去了（部分平台不发 show 事件）
      setTimeout(() => done({ ok: true }), 900);
    } catch (e) {
      done({ error: String((e && e.message) || e) });
    }
  });
}

/* ---------------------------------------------- 收消息的提醒，统一由主进程管

   为什么不交给页面自己弹：
   ① 连接窗口里的页面是**对方主机下发**的。那台主机如果还跑 2.4.0 之前
      的版本，页面里根本没有通知这回事；② 窗口藏进托盘后，页面里的定时器
      会被 Chromium 节流，可能几分钟才醒一次。所以「能不能提醒」不能押在
      对方页面的版本和浏览器调度上 —— 主进程自己盯着 /api/list 最稳。

   页面侧只在**没有桌面壳**（普通浏览器直接打开网址）时才用 HTML5
   Notification 兜底；有壳时不弹，免得一条消息响两遍。 */

const noticeWatches = new Map();   // win.id -> { timer, seen, primed, cid, base }

function stopNoticeWatch(winId) {
  const w = noticeWatches.get(winId);
  if (w && w.timer) clearInterval(w.timer);
  noticeWatches.delete(winId);
}

/** 这个窗口所在站点的设备 cid —— 页面存在 localStorage('xm.cid')，只读，不外传 */
async function readWinCid(win) {
  try {
    const cid = await win.webContents.executeJavaScript("localStorage.getItem('xm.cid')||''", true);
    return String(cid || '');
  } catch {
    return '';
  }
}

/**
 * 给一个窗口挂上「收消息提醒」。本机页面和别人主机的页面走同一套逻辑，
 * 页面版本不再影响通知能不能弹。
 */
function startNoticeWatch(win) {
  if (!win || win.isDestroyed()) return;
  const wid = win.id;
  if (noticeWatches.has(wid)) return;

  const st = { timer: null, seen: new Set(), primed: false, cid: '', base: '' };
  noticeWatches.set(wid, st);

  const tick = async () => {
    if (win.isDestroyed()) { stopNoticeWatch(wid); return; }

    // 只认 http(s)：启动页是 file://、断线页是 data:，那些没有可轮询的站点
    let base = '';
    try {
      const cur = new URL(win.webContents.getURL());
      if (cur.protocol === 'http:' || cur.protocol === 'https:') base = cur.origin;
    } catch { /* about:blank 之类，跳过这一拍 */ }
    if (!base) return;

    // 换了站点（连了另一台主机 / 主窗口切回本机）：cid 和消息基线全部作废
    if (st.base !== base) {
      st.base = base;
      st.cid = '';
      st.seen.clear();
      st.primed = false;
    }

    if (!st.cid) st.cid = await readWinCid(win);
    if (!st.cid) return;              // 页面还没把 cid 写进来，下一拍再看

    let data = null;
    try {
      const r = await fetch(base + '/api/list?cid=' + encodeURIComponent(st.cid), {
        headers: { 'x-xm-cid': st.cid },
      });
      if (!r.ok) return;
      data = await r.json();
      cacheSnapshot(base, data);      // 趁连得上的时候，把对方的列表快照存下来备用
    } catch { return; }               // 对方离线 / 刚重启，下一拍再试，不打扰人

    const items = Array.isArray(data && data.items) ? data.items : [];
    const fresh = [];
    for (const it of items) {
      if (!it || !it.id || st.seen.has(it.id)) continue;
      st.seen.add(it.id);
      // 第一次只建基线：一进来不该把历史消息全弹一遍
      if (st.primed && it.owner && it.owner !== st.cid) fresh.push(it);
    }
    st.primed = true;
    if (!fresh.length) return;

    const first = fresh[0];
    let body;
    if (fresh.length > 1) body = fresh.length + ' 条新消息';
    else if (first.kind === 'text') body = String(first.text || '').slice(0, 120) || '发来一条消息';
    else {
      const ps = first.parts || [];
      const nm = ps[0] && ps[0].name;
      body = ps.length > 1 ? '发来 ' + ps.length + ' 个文件' : ('发来文件' + (nm ? '：' + nm : ''));
    }
    notifyIncoming({ title: 'XiaoMao 互传 · ' + (first.from || '有人'), body }, win);
  };

  st.timer = setInterval(tick, 3500);
  tick();                             // 立刻跑一次，先把现在已有的登记成基线
  win.on('closed', () => stopNoticeWatch(wid));
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
const BALL_MENU_PAGE = path.join(__dirname, 'ball-menu.html');
// 三档大小：菜单 / 托盘 / 在球上滚滚轮都能换，记在设置里
const BALL_DISC = { sm: 52, md: 64, lg: 80 };
const BALL_PAD = 20;                                     // 窗口比球体大一圈，给自绘阴影留位（透明窗口会裁掉超出部分）
const BALL_GAP = 6;                                      // 球与面板之间（球本身还自带 10px 留白）
const BALL_PANEL = { width: 360, height: 460 };
// 右键菜单的尺寸常量见 ballMenuLayout 上方（BALL_MENU_*）

let ballOn = false;       // 悬浮球的运行时开关；落盘在 settings.ballEnabled ——
                          // 用户手动开过就记住，下次启动自动跟着开，手动关了才不再出现

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
  ballOn = !!on;   // 记忆也落盘：手动开过，重启后自动开；手动关了，下次就安分
  updateSettings({ ballEnabled: ballOn });
  if (on) createBallWindow();
  else destroyBallWindow();
  buildMenu();
  refreshTray();
  return { ok: true, enabled: !!on };
}

/** 换大小：窗口跟着变，球心位置尽量不动 —— 换完球不该跳到屏幕另一头 */
function setBallSize(key) {
  if (!BALL_DISC[key]) return { ok: false, error: '没有这个尺寸' };
  closeBallMenu();
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
    : { size: ballDiscPx, box: ballBoxPx, ball: { left: 0, top: 0 }, panel: null, menu: { on: false } };
  try { ballWin.webContents.send('ball:geometry', payload); } catch { /* 页面还没就绪 */ }
}

/**
 * 把面板收起来：窗口缩回球那么大、球回到 ballAnchor，页面也同步成收起布局。
 *
 * 任何「收面板」都必须走这里。只把 ballOpen 置 false 的话，窗口还停在展开时的
 * 大尺寸，页面却按 ball:{0,0} 摆球 —— 球在屏幕上的实际位置变成了展开窗的左上角，
 * 与 ballAnchor 分家，菜单再按 anchor 贴过去就整块错位（右键球时被弹飞的正是这条）。
 */
function collapseBall() {
  if (!ballWin || ballWin.isDestroyed()) return false;
  const a = clampBallPos(ballAnchor || readBallPref().pos);
  ballAnchor = a;
  ballOpen = false;
  ballGeo = null;
  ballWin.setBounds({ x: a.x, y: a.y, width: ballBoxPx, height: ballBoxPx });
  applyBallGeometry();
  return true;
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
  closeBallMenu();

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
  // 层级用 floating 而不是 screen-saver：实测 screen-saver（1000）这一级 mac 的
  // 拖拽会话不往窗口路由 —— 文件拖影子都画在球下面、dragenter 一个都不来；
  // floating（3）仍压得住普通窗口，全屏可见交给上面的 visibleOnFullScreen。
  if (IS_MAC) {
    try { ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 老系统 */ }
  }
  ballWin.setAlwaysOnTop(true, 'floating');
  ballWin.moveTop();
  ensureRegularApp();   // ← visibleOnFullScreen 会把 App 变成 accessory（无菜单栏），立刻拉回 regular
  try { fs.appendFileSync('/tmp/xm-ball-drag.log', new Date().toISOString() + ' ball-created level=floating\n'); } catch { /* 日志而已 */ }

  ballWin.loadFile(BALL_PAGE);
  ballWin.once('ready-to-show', () => { if (ballWin && !ballWin.isDestroyed()) ballWin.showInactive(); });
  ballWin.webContents.on('did-finish-load', () => applyBallGeometry());
  ballWin.on('closed', () => { ballWin = null; ballOpen = false; ballGeo = null; closeBallMenu(); });
  // 球被藏起来（收进托盘 / 关球）时菜单不能留在屏幕上
  ballWin.on('hide', () => closeBallMenu());
  ballWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return ballWin;
}

function destroyBallWindow() {
  if (!ballWin || ballWin.isDestroyed()) { ballWin = null; return; }
  // 关窗前把位置记下来，下次还在原地起来。
  // 优先用 ballAnchor：面板展开时窗口比球大一圈，窗口坐标不再是球的位置，记错了下次球会跳。
  try {
    let pos = ballAnchor;
    if (!pos) {
      const [x, y] = ballWin.getPosition();
      pos = { x, y };
    }
    updateSettings({ ballPos: { x: pos.x, y: pos.y } });
  } catch { /* 拿不到就算了 */ }
  ballWin.destroy();
  ballWin = null;
  ballOpen = false;
  ballGeo = null;
  closeBallMenu();
}

/** mac 上 setBounds / show 之后窗口层级偶尔会被系统重置（这仓库吃过亏），重要操作后补一遍 */
function hardenBallLevel() {
  if (!IS_MAC || !ballWin || ballWin.isDestroyed()) return;
  // 「全空间可见」只在真的丢了时才重设：这个调用会把 App 打成 accessory（见 ensureRegularApp 注释），
  // 而 hardenBallLevel 在拖动/改尺寸时会反复调 —— 每次都重设的话 Dock 图标会跟着反复跳。
  try { if (!ballWin.isVisibleOnAllWorkspaces()) ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 老系统 */ }
  try { ballWin.setAlwaysOnTop(true, 'floating'); } catch { /* 同上 */ }
  ballWin.moveTop();
  ensureRegularApp();   // 万一上面那句刚把 App 打成 accessory（无菜单栏），立刻拉回 regular
}

/**
 * 右键菜单 = **独立窗口**，不是把球窗临时撑大。
 *
 * 之前的做法是「球窗撑大一圈、三个入口在窗口坐标里各算各的横坐标」：只要球贴近屏幕
 * 左右边，窗口被钳在屏幕内 → 球在窗口里偏心 → 胶囊再被单独钳一次 → 胶囊和图标球
 * 落到两条不同的竖轴上，胶囊还会顶到窗口边缘被截断。两套坐标系互相打架，几何算得
 * 再细也架不住（这已经反复出问题三次）。
 *
 * 现在菜单自己是一个窗口：宽高由内容定死，页面用 flex 竖着排，三个入口共用一条
 * 中轴线 —— 对齐由布局保证，不靠坐标；窗口整体贴在球下方（放不下就翻上方）、
 * 左右钳进屏幕，所以条目之间永远不齐不了、也永远裁不到。
 */
const BALL_MENU_W = 208;   // 10 边距 + 188 内容（胶囊最宽 188）+ 10 边距
const BALL_MENU_H = 166;   // 10 + 30(胶囊) + 10 + 48 + 10 + 48 + 10
const BALL_MENU_GAP = 8;   // 菜单与球之间的缝

/** 菜单窗摆哪：以球心为轴贴着球；下方放不下就翻到球上方；左右钳进屏幕 */
function ballMenuBounds() {
  const anchor = ballAnchor || clampBallPos(readBallPref().pos);
  const center = { x: Math.round(anchor.x + ballBoxPx / 2), y: Math.round(anchor.y + ballBoxPx / 2) };
  const area = screen.getDisplayNearestPoint(center).workArea;
  const down = anchor.y + ballBoxPx + BALL_MENU_GAP;
  const up = anchor.y - BALL_MENU_GAP - BALL_MENU_H;
  const fitsDown = down + BALL_MENU_H <= area.y + area.height;
  const fitsUp = up >= area.y;
  const y = Math.round((fitsDown || !fitsUp) ? Math.min(down, area.y + area.height - BALL_MENU_H) : up);
  const x = Math.round(Math.min(Math.max(center.x - BALL_MENU_W / 2, area.x), area.x + area.width - BALL_MENU_W));
  return { x, y, width: BALL_MENU_W, height: BALL_MENU_H };
}

/** 菜单窗的层级补丁（跟球窗一样：先 setVisibleOnAllWorkspaces 再 setAlwaysOnTop） */
function hardenMenuLevel() {
  if (!IS_MAC || !ballMenuWin || ballMenuWin.isDestroyed()) return;
  try { if (!ballMenuWin.isVisibleOnAllWorkspaces()) ballMenuWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 老系统 */ }
  try { ballMenuWin.setAlwaysOnTop(true, 'floating'); } catch { /* 同上 */ }
  ballMenuWin.moveTop();
  ensureRegularApp();   // 同球窗：visibleOnFullScreen 会把 App 打成 accessory，菜单栏就没了
}

function ensureBallMenuWindow() {
  if (ballMenuWin && !ballMenuWin.isDestroyed()) return ballMenuWin;
  ballMenuWin = new BrowserWindow({
    width: BALL_MENU_W, height: BALL_MENU_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false, movable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true,
    hasShadow: false,          // 系统阴影按矩形画，透明窗上会露方框
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'ball-menu-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (IS_MAC) {
    try { ballMenuWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 老系统 */ }
  }
  ballMenuWin.setAlwaysOnTop(true, 'floating');
  ballMenuWin.loadFile(BALL_MENU_PAGE);
  ballMenuWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 点到别处（别的应用 / 别的窗口）= 收菜单。
  // 刚弹出那一两百毫秒里系统焦点交接会误报一次失焦，用 __shownAt 挡掉；
  // 「打开界面」的激活流程本来就该失焦，也跳过。
  ballMenuWin.on('blur', () => {
    if (Date.now() - (ballMenuWin.__shownAt || 0) < 320) return;
    if (ballActivating) return;
    setImmediate(() => { if (!ballActivating) closeBallMenu(); });
  });
  ballMenuWin.on('closed', () => { ballMenuWin = null; });
  return ballMenuWin;
}

function openBallMenu() {
  if (!ballWin || ballWin.isDestroyed()) return false;
  if (ballOpen) collapseBall();   // 面板让位给菜单：先把窗口收回球那么大，菜单才贴得准
  const win = ensureBallMenuWindow();
  ballMenuSeq++;
  win.__shownAt = Date.now();
  win.setBounds(ballMenuBounds());
  hardenMenuLevel();
  win.show();
  win.focus();
  // 点了我们的球，菜单栏就应该是我们的 —— 弹出菜单这一步顺手把 app 激活
  activateApp();
  ensureFront(win, 900);      // 页面可能还没就绪就先 show 了，真可见之前一直补
  try { win.webContents.send('ball:menu-show'); } catch { /* 还没加载完 */ }
  return true;
}

function closeBallMenu() {
  if (!ballMenuWin || ballMenuWin.isDestroyed()) return;
  if (ballMenuWin.isVisible()) ballMenuWin.hide();
}

/** 菜单开着吗（收菜单的判断都用它，不再维护一份镜像状态） */
function ballMenuIsOpen() {
  return !!(ballMenuWin && !ballMenuWin.isDestroyed() && ballMenuWin.isVisible());
}

/**
 * 弹原生单选菜单（换发送目标）。
 * 必须挂在「当前还是 key 的那扇我们的窗口」上 —— 挂在没有焦点的窗口上会一闪就没；
 * 关掉之后再收右键菜单，菜单不会跟原生菜单叠在一起。
 */
function popupNearBall(menu) {
  const host = ballMenuIsOpen() ? ballMenuWin : ballWin;
  if (!host || host.isDestroyed()) return;
  try {
    menu.popup({ window: host, callback: () => closeBallMenu() });
  } catch { /* 窗口刚被销毁 */ }
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
/** 记住「上次连的那台」（地址 + 对方授权的 cid）：窗口关掉之后，球还能继续用它 */
function rememberBallLink(url, cid) {
  const u = String(url || '').replace(/\/+$/, '');
  if (!u) return;
  const prev = readSettings().ballLast;
  const keep = prev && prev.url === u ? prev.cid : '';
  updateSettings({ ballLast: { url: u, cid: cid || keep || '' } });
}

function forgetBallLink(url) {
  const u = String(url || '').replace(/\/+$/, '');
  const prev = readSettings().ballLast;
  if (prev && (!u || prev.url === u)) updateSettings({ ballLast: null });
}

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
  // 最近用的是主窗口（或从没用过）→ 本机优先
  if (host) return host;

  // 本机没开服务、连接窗口也关了 —— 但球刚才还连着某台，别让它瞬间变空。
  // 用记下来的地址 + cid 继续说话（只影响球，不复活窗口）
  const bl = readSettings().ballLast;
  if (bl && bl.url) {
    let label = bl.url;
    try { label = '连到 ' + new URL(bl.url).host; } catch { /* 地址坏了就当纯文本 */ }
    return { base: bl.url, kind: 'link', label, port: '', id: '' };
  }
  return null;
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

/** 球发文件时的分片大小：与网页端（public/index.html 的 UPLOAD_CHUNK）保持一致 */
const BALL_UPLOAD_CHUNK = 8 * 1024 * 1024;

/**
 * 问一下主机支持哪些能力（目前只用 caps.chunked）。
 * 老主机没有这个字段，调用方据此回退整包 —— 不能盲分片：
 * 老服务端会忽略 uid，每片都当成一次独立上传从头写，最后只剩最后一片。
 */
async function ballCapsOf(t, cid) {
  try {
    const r = await fetch(ballUrl(t, '/api/list?cid=' + encodeURIComponent(cid)), {
      headers: { 'x-xm-cid': cid },
    });
    if (!r.ok) return {};
    const d = await r.json();
    return (d && d.caps) || {};
  } catch {
    return {};
  }
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
    // 窗口关了也别丢身份：上次连这台时对方授权的 cid 记在设置里
    const bl = readSettings().ballLast;
    if (bl && bl.url === t.base && bl.cid) return bl.cid;
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
        ballOnline = false;
        return { ok: false, online: false, target: t, error: j.error || ('对方返回 ' + r.status) };
      }
      const d = await r.json();
      // 服务端给的是全量可见列表，这里只裁面板装得下的量；
      // 之前裁 10 条被用户吐槽「历史记录不全」——面板本身能滚，放宽到 40
      const items = (d.items || []).slice(0, 40).map((it) => ballItemView(t, it));
      const lastSeen = Number(readSettings().ballSeen || 0);
      ballOnline = true;   // 菜单胶囊的绿灯跟着这里走
      return {
        ok: true, online: true, target: t, port: t.port,
        items,
        unread: items.filter((it) => (it.time || 0) > lastSeen).length,
      };
    } catch {
      ballOnline = false;
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
    closeBallMenu();
    if (!on) {
      collapseBall();   // 收面板 = 窗口也要缩回去，不能只改标志（否则球位与 anchor 分家）
      return { size: ballDiscPx, box: ballBoxPx, ball: { left: 0, top: 0 }, panel: null };
    }
    ballOpen = true;
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
    closeBallMenu();   // 球一挪，菜单就跟着失效了，别留在原地
    // 展开时挪的是「球在 ballGeo 里的位置」；平时球就贴着窗口原点
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
    popupNearBall(Menu.buildFromTemplate(items));
    return { ok: true };
  });

  /**
   * 右键菜单开关：on=true 弹出**独立的菜单窗**（球窗不再被撑大），on=false 收起。
   * 条目对齐由菜单页的 flex 布局保证，主进程只负责窗口位置。
   */
  ipcMain.handle('ball:menu', (_e, on) => {
    if (!ballWin || ballWin.isDestroyed()) return { ok: false, on: false };
    if (!on) { closeBallMenu(); return { ok: true, on: false }; }
    return { ok: openBallMenu(), on: true };
  });

  /** 菜单胶囊的内容：当前发给谁 + 连着没有。
   *  只放地址本身（不带「连到」前缀）—— 胶囊宽度有限，带前缀就会出省略号，
   *  而「连到」这层意思由胶囊旁边的电脑图标和菜单语境已经够了。 */
  ipcMain.handle('ball:menu-state', () => {
    const cur = ballTarget();
    if (!cur) return { text: '未连接', full: '还没定发送目标', online: false };
    if (cur.kind === 'host') {
      const inf = server.serverInfo();
      return {
        text: '本机服务' + (inf.port ? ' :' + inf.port : ''),
        full: '本机接收服务' + (inf.port ? ' · 端口 ' + inf.port : ''),
        online: !!inf.running,
      };
    }
    const short = String(cur.base || '').replace(/^https?:\/\//, '');
    return { text: short || cur.label || '已连接', full: cur.label || '', online: ballOnline };
  });

  /** 迷你球「连接信息」：原生菜单念清楚当前发给谁、服务状态，顺手能换目标 */
  ipcMain.handle('ball:info', () => {
    if (!ballWin || ballWin.isDestroyed()) return { ok: false };
    const inf = server.serverInfo();
    const cur = ballTarget();
    const n = links.size;
    const items = [
      { label: '发送到：' + (cur ? (cur.kind === 'host' ? '本机主机' : cur.label) : '（还没定发送目标）'), enabled: false },
      {
        label: cur && cur.kind === 'link'
          ? ('对方地址 ' + cur.base.replace(/^https?:\/\//, ''))
          : (inf.running
            ? ('本机接收服务已开启 · 端口 ' + inf.port + (n ? ' · ' + n + ' 台设备连着' : ''))
            : '本机接收服务未开启'),
        enabled: false,
      },
      { type: 'separator' },
      {
        label: '本机主机' + (inf.running ? '' : '（接收服务没开）'),
        type: 'radio',
        checked: !!cur && cur.kind === 'host',
        enabled: inf.running,
        click: () => setBallPin({ kind: 'host' }),
      },
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
    popupNearBall(Menu.buildFromTemplate(items));
    return { ok: true };
  });

  /** 拖拽诊断：mac 上拖文件进球失效的分层排查日志（进没进窗口 / drop 来没来 / 路径拿到没） */
  ipcMain.on('ball:drag-log', (_e, msg) => {
    try {
      fs.appendFileSync('/tmp/xm-ball-drag.log',
        new Date().toISOString() + ' ' + String(msg || '').slice(0, 500) + '\n');
    } catch { /* 写不进就算了 */ }
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

  /** 球上的「打开界面」：球现在指谁就开谁的窗口 —— 连着别人开连接窗口，
      指本机才开主机界面。永远蹦主机界面会跟球的标题打架。 */
  /** 点球本身会让球窗攥住焦点，收菜单的 setBounds 又会再抢一次 ——
   *  所以「把界面叫起来」要：先松开球窗 → show/focus → 激活 app，
   *  再延时兜底（等慢的窗口/导航落定后重新确认）。
   *  收菜单的 setBounds 必须等激活落定之后才做（closeBallMenu 放在 220ms 那一脚里）：
   *  菜单路径下缩窗发生在球窗还攥着焦点的时候，会把刚激活的状态搅回去，
   *  菜单栏就停在别的应用名下，得关了球才恢复 —— 页面只藏视觉，几何由这里收回。 */
  /**
   * 点球上的入口 → 把对应窗口叫起来。
   *
   * 要处理三件事，缺一样菜单栏就会停在别的应用名下：
   *  ① 菜单 / 球本身就是我们的窗口：它们还攥着 key，激活会被它们「吸住」→ 先收
   *  ② 目标窗口可能是刚创建、还没上屏的（openLink 重连）：show 只对能画画的窗口生效，
   *     所以激活不能只调一次，要等窗口真可见（ensureFront 持续确认）
   *  ③ 收菜单的时机必须在激活之后（页面点完按钮就先 close 了，这里不再抢）
   */
  const openAndActivate = async (focusFn, pickWin) => {
    const seqAt = ballMenuSeq;              // 记下这次点击时菜单的序号
    ballActivating = true;                  // 这一段主动失焦是正常的，失焦收菜单先让路
    closeBallMenu();
    try { if (ballWin && !ballWin.isDestroyed()) ballWin.blur(); } catch { /* 无所谓 */ }
    await focusFn();
    activateApp();
    if (IS_MAC) {
      const target = typeof pickWin === 'function' ? pickWin() : null;
      if (target) ensureFront(target, 1600);
    }
    const reconfirm = () => {
      if (quitting) return;
      activateApp();
      try { if (ballWin && !ballWin.isDestroyed() && ballWin.isFocused()) ballWin.blur(); } catch { /* 同上 */ }
    };
    setTimeout(() => {
      reconfirm();
      // 只收「这次点击时还开着」的那份菜单：用户手快又右击一次的话，序号已变，
      // 这一脚不能把刚展开的新菜单收掉（否则就是「右键菜单出不来」）
      if (ballMenuSeq === seqAt) closeBallMenu();
    }, 220);
    setTimeout(() => { ballActivating = false; reconfirm(); }, 900);   // 覆盖导航慢的窗口
  };

  ipcMain.handle('ball:open-host', () => {
    const t = ballTarget();
    if (t && t.kind === 'link') {
      const l = (t.id && links.get(t.id))
        || [...links.values()].find((x) => x.url.replace(/\/+$/, '') === t.base);
      if (l && l.win && !l.win.isDestroyed()) {
        openAndActivate(async () => {
          if (l.win.isMinimized()) l.win.restore();
          l.win.show();
          l.win.focus();
        }, () => (l.win && !l.win.isDestroyed() ? l.win : null));
        return { ok: true, opened: 'link' };
      }
      // 窗口真没了（重启过 / 被彻底关掉）：按球的记忆重新连那台 ——
      // 落到 openMyHost 会给人一张选择页或本机界面，跟球上显示的「连到 x.x.x」对不上
      const r = openLink(t.base);
      if (r && r.ok) {
        openAndActivate(async () => {}, () => {
          const w = (r.id && links.get(r.id) && links.get(r.id).win)
            || [...links.values()].map((x) => x.win).find((w2) => w2 && !w2.isDestroyed());
          return w && !w.isDestroyed() ? w : null;
        });
        return { ok: true, opened: 'link' };
      }
      // 地址连不上（对方下线/写坏了）才退回本机
    }
    openAndActivate(() => openMyHost(), () => (hostWin && !hostWin.isDestroyed() ? hostWin : null));
    return { ok: true, opened: 'host' };
  });
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
  /**
   * 把一个文件流进主机（球的发送用）。
   *
   * 大文件 + 主机支持分片 → 8MB 一片、同一个 uid 逐片发，断一片只补这一片；
   * 否则整包（老主机 / 小文件）。
   *
   * 两条路都**必须带 content-length**：少了它服务端只知道「已收 xx 字节」，
   * 接收端那条进度条就没有分母，退化成来回摆的不确定动画 ——
   * 球发大文件「进度条反复」就是这么来的（网页端有 Content-Length，所以只有球会犯）。
   */
  async function ballUploadOne(t, cid, file) {
    const name = path.basename(file);
    const total = fs.statSync(file).size;
    const base = '/api/upload?name=' + encodeURIComponent(name) + '&cid=' + encodeURIComponent(cid);
    const headers = (len) => ({
      'x-xm-cid': cid,
      'content-type': 'application/octet-stream',
      'content-length': String(len),
    });
    const post = (q, start, end) => fetch(ballUrl(t, q), {
      method: 'POST',
      body: Readable.toWeb(fs.createReadStream(file, start == null ? undefined : { start, end: end - 1 })),
      duplex: 'half',
      headers: headers(end - (start || 0)),
    });

    // 分片要主机认这个协议；老主机不认 uid，逐片发会把文件覆盖成最后一片——
    // 所以先问一次能力位，没有就整包（行为与 2.4.0 之前完全一致）
    const caps = total > BALL_UPLOAD_CHUNK ? await ballCapsOf(t, cid) : {};
    if (!caps.chunked) {
      let lastErr = null;
      for (let left = 1; left >= 0; left--) {   // 整包失败再试一次：从头来，只用于小文件/老主机
        try {
          const r = await post(base, null, total);
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || ('对方返回 ' + r.status));
          if (!d.part) throw new Error('服务端没给回执');
          return d.part;
        } catch (e) {
          lastErr = e;
          if (left > 0) await new Promise((r2) => setTimeout(r2, 400));
        }
      }
      throw lastErr || new Error('上传失败');
    }

    const uid = 'b' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    let part = null;
    for (let off = 0; off < total; off += BALL_UPLOAD_CHUNK) {
      const end = Math.min(off + BALL_UPLOAD_CHUNK, total);
      const isLast = end >= total;
      const q = base + '&uid=' + uid + '&offset=' + off + '&total=' + total + (isLast ? '&final=1' : '');
      let lastErr = null;
      for (let left = 3; left >= 0; left--) {
        try {
          const r = await post(q, off, end);
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || ('对方返回 ' + r.status));
          if (d.part) part = d.part;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          // 同一片重发：已落盘的字节不丢，接收端进度停在 offset，不会归零
          if (left > 0) await new Promise((r2) => setTimeout(r2, 350 * (4 - left)));
        }
      }
      if (lastErr) throw lastErr;
    }
    if (!part) throw new Error('服务端没给回执');
    return part;
  }

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
        parts.push(await ballUploadOne(t, cid, String(one)));
      } catch (err) {
        // 服务端的原因（设备未授权 / 文件过大 / 断点失效）要原样念给人听，别一律说「失败」
        const raw = String((err && err.message) || '');
        const reason = err && err.code === 'ENOENT' ? '文件不存在'
          : (/fetch failed|ECONN|socket hang up|aborted|timeout/i.test(raw) ? '网络中断' : (raw || '读不了这个文件'));
        failed.push({ name, reason });
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

/* Windows 的 toast 靠 AppUserModelID 认领「这条通知是哪个应用的」：
   不注册的话通知不会显示、也不会进操作中心 —— 而且不报错，只是静默消失。
   macOS 根本不看这个，所以同样的代码在 mac 上通、在 Windows 上全静默。
   这里必须与 package.json 的 build.appId 完全一致：安装包给快捷方式写的就是
   那个值，两边对不上 AUMID 照样匹配不到应用。 */
const WIN_APP_ID = 'cc.xiaomao.share';
if (process.platform === 'win32') app.setAppUserModelId(WIN_APP_ID);

/**
 * Windows 投 toast 还有一个硬前提：**开始菜单里必须有一条带 AppUserModelID
 * 的快捷方式**。安装版由 NSIS 装好；但直接跑 win-unpacked 里的 exe、或者用
 * 便携版，系统找不到这条身份，通知会被直接丢掉 —— 不报错、不弹、也不进
 * 通知中心，表现就是「连测试通知都没反应」。
 *
 * 所以这里自己补一条（已有且 AUMID 正确就跳过）。只在打包后写，免得开发机
 * 上往开始菜单塞一个指向 electron.exe 的快捷方式。
 */
function winShortcutPath() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'XiaoMao 互传.lnk');
}

function ensureWinShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const lnk = winShortcutPath();
    if (fs.existsSync(lnk)) {
      try {
        const cur = shell.readShortcutLink(lnk);
        if (cur && cur.appUserModelId === WIN_APP_ID) return;  // 安装版装好的，别动它
        // AUMID 对不上：'update' 未必改得动这个字段，删了重建更干脆
        fs.unlinkSync(lnk);
      } catch { /* 读不出来就按下面重建 */ }
    }
    fs.mkdirSync(path.dirname(lnk), { recursive: true });
    shell.writeShortcutLink(lnk, 'create', {
      target: process.execPath,
      appUserModelId: WIN_APP_ID,
      description: 'XiaoMao 互传',
      icon: process.execPath,
      iconIndex: 0,
    });
  } catch { /* 没权限就算了：安装版不靠这条兜底 */ }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { ensureHostWindow(); });

  app.whenReady().then(async () => {
    loadLinkSnaps();
    // macOS 开发模式下 Dock 上是 Electron 自带图标（装成 app 才有自己的），
    // 运行时换成我们的，免得调试时 Dock 里一直坐着一个 Electron
    if (IS_MAC && app.dock) {
      try { app.dock.setIcon(APP_ICON); } catch { /* 无 Dock 的环境就算了 */ }
    }
    // 起来第一件事就是确认自己是「常规应用」：悬浮球的窗口层级调用会把 App 打成
    // accessory（无菜单栏），一旦被打进去，后面 show 多少窗口菜单栏都不会跟随
    ensureRegularApp();
    ensureWinShortcut();   // Windows：没有带 AUMID 的开始菜单快捷方式，toast 就弹不出来

    // 「收到消息」的提醒统一由主进程发（startNoticeWatch）。桌面壳里的 HTML5
    // Notification 一律关掉：留着只会让一条消息响两遍 —— 尤其是对方主机下发的
    // 旧页面，它压根不知道有主进程这条通道，会自己去 new Notification。
    // 普通浏览器直接打开网址时不受这个限制，仍然走浏览器自己的授权。
    try {
      const ses = session.defaultSession;
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      ses.setPermissionCheckHandler(() => false);
    } catch { /* 老版本 Electron 没这两个 API 就算了，页面里也有兜底 */ }

    buildMenu();          // 菜单先挂上，别让窗口出来时顶栏是空的
    buildTray();          // 托盘尽早建：关闭按钮的三种结局都依赖它在不在
    syncBallMetrics();    // 球的尺寸先算好，后面布局都靠它
    registerBallIpc();    // 悬浮球的请求通道先打通，窗口起来就能用
    createHostWindow();   // 窗口与启动页立刻出现 —— 双击就有反馈，不用干等任何东西
    // 上次是开着球退出的：这次自动把球带上（手动关过才会是 false）
    if (readSettings().ballEnabled) setBallEnabled(true);

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
    // 硬兜底：任何环节挂住（连接没收尾、对话框占着）都强制走人，
    // 不然就是用户看到的「托盘没了、Dock 图标还坐着」的半死状态
    setTimeout(() => { try { app.exit(0); } catch { /* 退出中 */ } }, 3000).unref();
  });
}
