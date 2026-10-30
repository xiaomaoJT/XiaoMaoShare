'use strict';
/**
 * 桌面壳的桥：页面只能通过这几个方法跟主进程说话，拿不到 Node。
 * 页面靠「window.xmDesktop 在不在」判断自己是在桌面里还是浏览器里，
 * 所以浏览器打开时这些入口自动消失，Web 端行为一点不变。
 */

const { contextBridge, ipcRenderer } = require('electron');

const listeners = { links: [], openConnect: [], startError: [], startAskLink: [], notice: [] };

ipcRenderer.on('desktop:links', (_e, snap) => {
  listeners.links.forEach((fn) => { try { fn(snap); } catch { /* 页面自己的错 */ } });
});

ipcRenderer.on('desktop:open-connect', () => {
  listeners.openConnect.forEach((fn) => { try { fn(); } catch { /* 同上 */ } });
});

// 启动阶段：服务起不来、地址不合法 —— 让选择页退回可操作状态并说明原因
ipcRenderer.on('desktop:start-error', (_e, msg) => {
  listeners.startError.forEach((fn) => { try { fn(msg); } catch { /* 同上 */ } });
});

// 菜单里点了「连接其他主机…」，而主窗口正停在启动页：把焦点引到连接那张卡
ipcRenderer.on('desktop:start-ask-link', () => {
  listeners.startAskLink.forEach((fn) => { try { fn(); } catch { /* 同上 */ } });
});

// 主进程的一句话提示（例如「上次那台连不上，已回到我的主机」）
ipcRenderer.on('desktop:notice', (_e, text) => {
  listeners.notice.forEach((fn) => { try { fn(text); } catch { /* 同上 */ } });
});

contextBridge.exposeInMainWorld('xmDesktop', {
  role: 'host',                                  // 这个窗口是「我自己主机」的主控界面
  platform: process.platform,
  insetTitlebar: process.platform === 'darwin',   // 顶栏要给红绿灯让位

  /** 本机服务状态：端口、局域网地址、已连接的其他主机、最近连过 */
  info: () => ipcRenderer.invoke('host:info'),

  /* ---- 启动选择页（desktop/start.html）---- */

  /** 读启动方式与最近地址，决定选择页显示选择还是继续转圈 */
  startState: () => ipcRenderer.invoke('start:state'),

  /** 提交选择：{ action:'host' | 'link', url?, keepHost?, remember? } */
  startChoose: (payload) => ipcRenderer.invoke('start:choose', payload),

  /** 选择页底部的「数据目录 / 更改」 */
  startDataDir: () => ipcRenderer.invoke('start:dataDir'),

  /** 反悔「记住这次选择」：把启动记忆改回「每次问」 */
  startForget: () => ipcRenderer.invoke('start:forget'),

  /** 连到别人的主机；返回 { ok, id } 或 { error } */
  connect: (url) => ipcRenderer.invoke('link:connect', url),
  closeLink: (id) => ipcRenderer.invoke('link:close', id),
  focusLink: (id) => ipcRenderer.invoke('link:focus', id),
  forgetLink: (url) => ipcRenderer.invoke('link:forget', url),

  /** 复制到系统剪贴板（页面在 http 下也能用 navigator.clipboard，但桌面里更稳） */
  copy: (text) => ipcRenderer.invoke('host:copy', text),

  /** 复制图片到系统剪贴板：传 PNG 的 dataURL，聊天软件里直接粘贴（浏览器 http 下没有剪贴板 API，桌面独占） */
  copyImage: (dataUrl) => ipcRenderer.invoke('host:copyImage', dataUrl),

  onLinks: (fn) => { if (typeof fn === 'function') listeners.links.push(fn); },
  onOpenConnect: (fn) => { if (typeof fn === 'function') listeners.openConnect.push(fn); },
  onStartError: (fn) => { if (typeof fn === 'function') listeners.startError.push(fn); },
  onStartAskLink: (fn) => { if (typeof fn === 'function') listeners.startAskLink.push(fn); },
  onNotice: (fn) => { if (typeof fn === 'function') listeners.notice.push(fn); },
});
