'use strict';
/**
 * 悬浮球右键菜单窗的预加载脚本。
 *
 * 菜单是**独立窗口**（不是把球窗撑大）—— 这样三个入口的对齐由 CSS 定，
 * 窗口尺寸就等于内容尺寸，球贴到屏幕边缘时菜单整体平移，永远不会被裁掉。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xmBallMenu', {
  /** 胶囊要显示的内容：{ text, online } */
  state: () => ipcRenderer.invoke('ball:menu-state'),
  /** 换发送目标（原生单选项菜单） */
  pickTarget: () => ipcRenderer.invoke('ball:pick-target'),
  /** 打开当前连接的主界面 */
  openHost: () => ipcRenderer.invoke('ball:open-host'),
  /** 关闭悬浮球 */
  hideBall: () => ipcRenderer.invoke('ball:hide'),
  /** 收起菜单 */
  close: () => ipcRenderer.invoke('ball:menu', false),

  /** 主进程每次弹出菜单都会通知一次，页面借此刷新状态 */
  onShow: (fn) => {
    if (typeof fn !== 'function') return;
    ipcRenderer.on('ball:menu-show', () => { try { fn(); } catch { /* 页面自己的错 */ } });
  },
});
