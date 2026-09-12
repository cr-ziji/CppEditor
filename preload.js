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

  // 弹出「另存为」对话框保存新文件（自选目录与文件名，默认目录为项目根、
  // 默认文件名为「未命名」）；返回 { ok, path, projectDir } 或 { ok:false, cancelled:true }。
  saveAs: (content, suggestedName) => ipcRenderer.invoke('save:save-as', content, suggestedName),

  // 读取上次保存的文件内容（用于启动时恢复）；返回 { ok, path, content } 或 { ok:false }。
  getSaved: () => ipcRenderer.invoke('save:get-saved'),

  // 重新选择保存目录；返回 { ok, path } 或 { ok:false, cancelled:true }。
  chooseDirectory: () => ipcRenderer.invoke('save:choose-dir'),

  // 编译并运行 .c/.cpp 文件；返回 { ok, exePath, message } 或 { ok:false, message }。
  runFile: (filePath) => ipcRenderer.invoke('run:compile-and-run', filePath),

  // 编辑器右键菜单复制 / 粘贴 / 剪切用的文本剪贴板（绕过 Monaco 剪贴板权限限制）。
  // sandbox 预加载脚本无 clipboard 模块，改由主进程 IPC 读写。
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),

  // 文件树操作。剪贴板使用 CF_HDROP（FileNameW），与 Windows 资源管理器互通。
  // 复制/剪切：将文件列表写入剪贴板；返回 { ok, count } 或 { ok:false, message }。
  treeCopy: (paths) => ipcRenderer.invoke('filetree:copy', paths),
  treeCut: (paths) => ipcRenderer.invoke('filetree:cut', paths),
  // 粘贴到 destDir；返回 { ok, results:[{ src, dest, isDirectory, ok, message }] }。
  treePaste: (destDir) => ipcRenderer.invoke('filetree:paste', destDir),
  // 重命名；返回 { ok, oldPath, newPath, isDirectory } 或 { ok:false, message }。
  treeRename: (oldPath, newName) => ipcRenderer.invoke('filetree:rename', oldPath, newName),
  // 删除（移入回收站）；返回 { ok, results }。
  treeDelete: (paths) => ipcRenderer.invoke('filetree:delete', paths),
  // 在资源管理器中定位；返回 { ok }。
  treeReveal: (filePath) => ipcRenderer.invoke('filetree:reveal', filePath),
  // 用系统默认关联应用打开文件；返回 { ok }。
  treeOpenFile: (filePath) => ipcRenderer.invoke('filetree:open-file', filePath),
  // 在 dir 下新建文件（内容由渲染端按模板替换）；返回 { ok, path } 或 { ok:false, message }。
  treeCreateFile: (dir, name, content) => ipcRenderer.invoke('filetree:create-file', dir, name, content),
  // 在 dir 下新建文件夹；返回 { ok, path } 或 { ok:false, message }。
  treeCreateDir: (dir, name) => ipcRenderer.invoke('filetree:create-dir', dir, name),

  // 复制文件路径到剪贴板（通过主进程 IPC）。
  treeCopyPath: (filePath) => ipcRenderer.invoke('clipboard:copy-path', filePath),

  // ── 交互式运行（Android 专用；Electron 端为桩）──
  startRun: () => Promise.resolve({ ok: false, message: '桌面端不支持交互式运行' }),
  sendInput: () => Promise.resolve({ ok: false }),
  stopRun: () => Promise.resolve({ ok: true }),
  onRunStdout: () => () => {},
  onRunStderr: () => () => {},
  onRunExit: () => () => {},
  onRunStarted: () => () => {},

  // ── 工具链状态（Android 专用；Electron 端始终 ready）──
  toolchainStatus: () => Promise.resolve({ ready: true }),
  onToolchainProgress: () => () => {},
  onToolchainReady: () => () => {},

  // 订阅项目目录文件增删事件（{ projectDir, added, removed }）。返回取消订阅函数。
  onProjectChanged: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('lsp:project-changed', listener);
    return () => ipcRenderer.removeListener('lsp:project-changed', listener);
  },

  // 订阅「compile_commands.json 已重建，请通知 clangd 重新加载」事件（设置窗口修改编译设置后触发）。
  // 回调参数为 compile_commands.json 绝对路径。
  onLspCompileDbUpdated: (callback) => {
    const listener = (_event, compileDbPath) => callback(compileDbPath);
    ipcRenderer.on('lsp:compile-db-updated', listener);
    return () => ipcRenderer.removeListener('lsp:compile-db-updated', listener);
  },

  // 订阅「编译参数已变化，请重启 clangd」事件（无项目、仅有 fallback 参数时触发）。
  onLspRestart: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('lsp:restart', listener);
    return () => ipcRenderer.removeListener('lsp:restart', listener);
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

  // 桌面端无系统栏预留区，主题切换已由 renderer.js 的 CSS 完成，无需原生联动。
  updateThemeColors: () => {},

  // 订阅设置变更（设置窗口保存后，主窗口据此即时应用外观等）。返回取消订阅函数。
  onSettingsChanged: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
});
