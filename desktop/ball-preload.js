'use strict';
/**
 * 悬浮球的预加载脚本。
 *
 * 球只是一个「装入口」：读列表、投文件、打开主界面，全部经主进程转发。
 * 不在渲染层直接 fetch 本地服务，是因为球要同时服务两种身份 ——
 * 自己是主机（localhost + 主控令牌）和连着别人的主机（对方 IP + 授权 cid），
 * 而 origin 与凭据都只有主进程知道。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('xmBall', {
  /** 最近内容 + 未读数 + 当前目标（主机 / 连到谁） */
  list: () => ipcRenderer.invoke('ball:list'),

  /** 面板打开过：把未读清掉（记在主进程，重启也认） */
  seen: () => ipcRenderer.invoke('ball:seen'),

  /**
   * 拖进来的文件 → 真实路径。
   * Electron 32 之后 File.path 已被移除，只有 webUtils 拿得到；
   * 拿不到就说明不是本地文件（比如从网页里拖的），直接丢掉。
   */
  pathsOf: (files) => {
    const out = [];
    for (const f of files || []) {
      try {
        const p = webUtils.getPathForFile(f);
        if (p) out.push(p);
      } catch { /* 非本地文件 */ }
    }
    return out;
  },

  /** 发一组本地文件；返回 { ok, sent, failed } */
  send: (paths) => ipcRenderer.invoke('ball:send', paths),
  /** 打开主界面 */
  openHost: () => ipcRenderer.invoke('ball:open-host'),
  /** 在文件管理器里定位某条内容的文件 */
  reveal: (fid) => ipcRenderer.invoke('ball:reveal', fid),
  copy: (text) => ipcRenderer.invoke('ball:copy', text),

  /** 展开 / 收起面板：主进程要跟着改窗口尺寸和位置 */
  expand: (on) => ipcRenderer.invoke('ball:expand', on),
  /** 拖动：传的是这一帧的位移，主进程直接挪窗口 */
  move: (dx, dy) => ipcRenderer.send('ball:move', dx, dy),
  dragEnd: () => ipcRenderer.send('ball:drag-end'),
  /** 收进托盘（球自己的关闭方式） */
  hide: () => ipcRenderer.invoke('ball:hide'),

  onState: (fn) => {
    if (typeof fn !== 'function') return;
    ipcRenderer.on('ball:state', (_e, s) => { try { fn(s); } catch { /* 页面自己的错 */ } });
  },
});
