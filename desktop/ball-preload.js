'use strict';
/**
 * 悬浮球的预加载脚本。
 *
 * 球只是一个「装入口」：读列表、投文件、发文字、定位到主界面，全部经主进程转发。
 * 不在渲染层直接 fetch 本地服务，是因为球要同时服务两种身份 ——
 * 自己是主机（localhost + 主控令牌）和连着别人的主机（对方 IP + 授权 cid），
 * 而 origin 与凭据都只有主进程知道。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('xmBall', {
  /** 最近内容（含类型、组成、能不能打开位置）+ 未读数 + 当前目标（主机 / 连到谁） */
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

  /** 发东西：{ paths?: string[], text?: string }；返回 { ok, sent, failed, text } */
  send: (payload) => ipcRenderer.invoke('ball:send', payload),
  /** 打开主界面 */
  openHost: () => ipcRenderer.invoke('ball:open-host'),
  /** 打开主界面并滚到某条内容（滚过去 + 闪一下） */
  locate: (id) => ipcRenderer.invoke('ball:locate', id),
  /** 在文件管理器里显示这份文件（只在本机有实物时可用） */
  reveal: (payload) => ipcRenderer.invoke('ball:reveal', payload),
  copy: (text) => ipcRenderer.invoke('ball:copy', text),

  /** 初次加载要一份几何：球多大、面板在哪 */
  layout: () => ipcRenderer.invoke('ball:layout'),
  /** 展开 / 收起面板：主进程要跟着改窗口尺寸和位置 */
  expand: (on) => ipcRenderer.invoke('ball:expand', on),
  /** 拖动：传的是这一帧的位移，主进程直接挪窗口（展开时挪的是整个窗口） */
  move: (dx, dy) => ipcRenderer.send('ball:move', dx, dy),
  dragEnd: () => ipcRenderer.send('ball:drag-end'),
  /** 球上滚轮：一步一档放大 / 缩小 */
  sizeStep: (dir) => ipcRenderer.invoke('ball:size-step', dir),
  /** 收进托盘（球自己的关闭方式） */
  hide: () => ipcRenderer.invoke('ball:hide'),

  /** 换尺寸 / 展开收起后主进程会推一份新几何过来 */
  onGeometry: (fn) => {
    if (typeof fn !== 'function') return;
    ipcRenderer.on('ball:geometry', (_e, g) => { try { fn(g); } catch { /* 页面自己的错 */ } });
  },
});
