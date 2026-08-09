'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 通过 contextBridge 暴露一组最小、安全的 IPC 接口给渲染进程。
// 渲染进程只能通过这些方法启动 clangd、发送 LSP 消息以及订阅事件，
// 无法直接访问 Node.js / Electron 底层能力。
contextBridge.exposeInMainWorld('editorAPI', {
  // 请求主进程启动 clangd，返回启动结果与 clangd 配置。
  start: () => ipcRenderer.invoke('lsp:start'),

  // 将一条 JSON-RPC 消息（对象）交给主进程转发给 clangd。
  send: (message) => ipcRenderer.send('lsp:send', message),

  // 请求主进程关闭 clangd。
  stop: () => ipcRenderer.send('lsp:stop'),

  // 订阅 clangd 返回的 LSP 消息。返回取消订阅函数。
  onMessage: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('lsp:message', listener);
    return () => ipcRenderer.removeListener('lsp:message', listener);
  },

  // 订阅 clangd 进程状态变化（starting / running / exited / error）。
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('lsp:status', listener);
    return () => ipcRenderer.removeListener('lsp:status', listener);
  },

  // 订阅主进程日志（clangd stderr 等）。
  onLog: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('lsp:log', listener);
    return () => ipcRenderer.removeListener('lsp:log', listener);
  },

  loadProject: () => ipcRenderer.invoke('project:load'),

  // 将编辑器全文保存到「保存目录/main.cpp」；返回 { ok, path } 或 { ok:false, cancelled:true }。
  save: (content) => ipcRenderer.invoke('save:save', content),

  // 读取上次保存的文件内容（用于启动时恢复）；返回 { ok, path, content } 或 { ok:false }。
  getSaved: () => ipcRenderer.invoke('save:get-saved'),

  // 重新选择保存目录；返回 { ok, path } 或 { ok:false, cancelled:true }。
  chooseDirectory: () => ipcRenderer.invoke('save:choose-dir'),

  // 订阅项目目录文件增删事件（{ projectDir, added, removed }）。返回取消订阅函数。
  onProjectChanged: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('lsp:project-changed', listener);
    return () => ipcRenderer.removeListener('lsp:project-changed', listener);
  },
});
