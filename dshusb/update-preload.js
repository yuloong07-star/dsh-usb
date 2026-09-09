'use strict';

// DSH USB — 更新窗口（updating.html）的极简 preload。
// 仅暴露"取消更新"：把按钮点击转发给主进程，由主进程终止正在进行的
// npm 下载/安装进程并关闭窗口。沙箱下只允许使用 contextBridge 与 ipcRenderer。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshUpdate', {
  cancel: () => ipcRenderer.send('update:cancel'),
});
