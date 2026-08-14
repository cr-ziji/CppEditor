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

  // 打开文件夹对话框，将所选目录设为项目并返回文件树数据；取消时返回 { cancelled:true }。
  openProjectFolder: () => ipcRenderer.invoke('project:open-folder'),

  // 读取项目目录内任意文件；返回 { ok, path, content, binary, mime, size, ext }。
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),

  // 将文本写回项目目录内的指定文件；返回 { ok, path }。
  saveFile: (filePath, content) => ipcRenderer.invoke('file:save', filePath, content),

  // 将编辑器全文保存到「保存目录/main.cpp」；返回 { ok, path } 或 { ok:false, cancelled:true }。
  save: (content) => ipcRenderer.invoke('save:save', content),

  // 读取上次保存的文件内容（用于启动时恢复）；返回 { ok, path, content } 或 { ok:false }。
  getSaved: () => ipcRenderer.invoke('save:get-saved'),

  // 重新选择保存目录；返回 { ok, path } 或 { ok:false, cancelled:true }。
  chooseDirectory: () => ipcRenderer.invoke('save:choose-dir'),

  // 编译并运行 .c/.cpp 文件；返回 { ok, exePath, message } 或 { ok:false, message }。
  runFile: (filePath) => ipcRenderer.invoke('run:compile-and-run', filePath),

  // 订阅项目目录文件增删事件（{ projectDir, added, removed }）。返回取消订阅函数。
  onProjectChanged: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('lsp:project-changed', listener);
    return () => ipcRenderer.removeListener('lsp:project-changed', listener);
  },

  // 订阅扩展名关联打开的文件（主进程经 second-instance 或启动参数转发）。
  // 回调参数为文件绝对路径；是否属于项目、是否已设置项目都无影响。
  onOpenExternalFile: (callback) => {
    const listener = (_event, filePath) => callback(filePath);
    ipcRenderer.on('file:open-external', listener);
    return () => ipcRenderer.removeListener('file:open-external', listener);
  },

  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  onMaximizedWindow: (callback) => ipcRenderer.on('window:maximized', callback),
  unmaximizeWindow: () => ipcRenderer.send('window:unmaximize'),
  onUnmaximizedWindow: (callback) => ipcRenderer.on('window:unmaximized', callback),
  closeWindow: () => ipcRenderer.send('window:close'),

  openSettingWindow: () => ipcRenderer.send('window:open-setting-window'),
  closeSettingWindow: () => ipcRenderer.send('window:close-setting-window'),

  // 设置：读取全部设置，以及保存 compile/editor/templates/shortcuts 分组。
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  // 订阅设置变更（设置窗口保存后，主窗口据此即时应用外观等）。返回取消订阅函数。
  onSettingsChanged: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
});
