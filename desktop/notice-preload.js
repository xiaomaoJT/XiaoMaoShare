'use strict';
/**
 * 连接窗口（连到别人主机）专用的桥 —— 只做一件事：把「收到消息」上报给主进程。
 *
 * 这个窗口加载的是别人的页面，按设计不该拿到桌面 API（所以它不挂 preload.js）。
 * 但收消息要弹系统通知，总得有一条能出去的路。这里只暴露一个单向上报方法，
 * 页面从主进程那边什么也读不到，也调不动任何窗口/文件能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xmNotice', {
  /** 页面判断完「该不该提醒」，把标题/正文交过来；主进程弹真正的系统通知 */
  notifyIncoming: (payload) => ipcRenderer.invoke('notice:incoming', payload),
});
