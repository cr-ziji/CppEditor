'use strict';

// ---------------------------------------------------------------------------
// 平台适配层：把渲染进程所需的 window.editorAPI 统一到同一接口。
// - Electron：preload.js 已通过 contextBridge 暴露 editorAPI，此处直接跳过。
// - Android：通过原生注入的 window.AndroidBridge 实现相同的接口形状。
// ---------------------------------------------------------------------------

(function () {
  // 标记平台，供 renderer.js 推导默认工作目录等使用
  var isAndroid = !!window.AndroidBridge;
  window.__cppeditor_platform = isAndroid ? 'android' : 'unknown';

  // 在 <html> 根上加平台 class，供 CSS 针对移动端做差异处理（如隐藏窗口控制按钮）
  if (isAndroid) {
    document.documentElement.classList.add('platform-android');
  }

  if (window.editorAPI) return; // Electron preload 已提供

  var bridge = window.AndroidBridge;
  if (!bridge) {
    window.editorAPI = {
      start: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      send: function () {},
      stop: function () {},
      onMessage: function (cb) { return function () {}; },
      onStatus: function (cb) { return function () {}; },
      onLog: function (cb) { return function () {}; },
      loadProject: function () { return Promise.resolve({ projectDir: null, files: [] }); },
      openProjectFolder: function () { return Promise.resolve({ cancelled: true }); },
      readFile: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      saveFile: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      saveAs: function () { return Promise.resolve({ ok: false, cancelled: true }); },
      getSaved: function () { return Promise.resolve({ ok: false }); },
      chooseDirectory: function () { return Promise.resolve({ ok: false, cancelled: true }); },
      runFile: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      startRun: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      sendInput: function () { return Promise.resolve({ ok: false }); },
      stopRun: function () { return Promise.resolve({ ok: true }); },
      readClipboardText: function () { return Promise.resolve(''); },
      writeClipboardText: function () { return Promise.resolve({ ok: true }); },
      treeCopy: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      treeCut: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      treePaste: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      treeRename: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      treeDelete: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      treeReveal: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      treeOpenFile: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      treeCopyPath: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      treeCreateFile: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      treeCreateDir: function () { return Promise.resolve({ ok: false, message: '无平台桥接' }); },
      onProjectChanged: function (cb) { return function () {}; },
      onLspCompileDbUpdated: function (cb) { return function () {}; },
      onLspRestart: function (cb) { return function () {}; },
      onOpenExternalFile: function (cb) { return function () {}; },
      toolchainStatus: function () { return Promise.resolve({ ready: true }); },
      onToolchainProgress: function (cb) { return function () {}; },
      onToolchainReady: function (cb) { return function () {}; },
      minimizeWindow: function () {},
      maximizeWindow: function () {},
      onMaximizedWindow: function (cb) { return function () {}; },
      unmaximizeWindow: function () {},
      onUnmaximizedWindow: function (cb) { return function () {}; },
      closeWindow: function () {},
      openSettingWindow: function () {},
      closeSettingWindow: function () {},
      updateThemeColors: function () {},
      loadSettings: function () { return Promise.resolve({}); },
      saveSettings: function () { return Promise.resolve({}); },
      onSettingsChanged: function (cb) { return function () {}; },
    };
    return;
  }

  // --- 通用 invoke / send / event 基础设施 --------------------------------
  var cbSeq = 0;
  var pending = Object.create(null); // callbackId -> { resolve, reject }
  var listeners = Object.create(null); // channel -> Set<fn>

  function invoke(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var id = ++cbSeq;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        bridge.call(method, JSON.stringify(args), id);
      } catch (err) {
        delete pending[id];
        reject(err);
      }
    });
  }

  function send(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      bridge.call(method, JSON.stringify(args), -1);
    } catch (err) { /* ignore */ }
  }

  function on(channel, cb) {
    var set = listeners[channel] || (listeners[channel] = new Set());
    set.add(cb);
    return function () { set.delete(cb); };
  }

  window.__bridgeResult = function (id, json) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    try { p.resolve(JSON.parse(json)); } catch (err) { p.reject(err); }
  };

  window.__bridgeEvent = function (channel, json) {
    var set = listeners[channel];
    if (!set) return;
    var payload;
    try { payload = JSON.parse(json); } catch (err) { return; }
    set.forEach(function (fn) {
      try { fn(payload); } catch (err) { console.error('[platform] listener error:', err); }
    });
  };

  // --- editorAPI 接口 ------------------------------------------------------
  window.editorAPI = {
    start: function () { return invoke('start'); },
    send: function (message) { send('send', message); },
    stop: function () { send('stop'); },
    onMessage: function (cb) { return on('lsp:message', cb); },
    onStatus: function (cb) { return on('lsp:status', cb); },
    onLog: function (cb) { return on('lsp:log', cb); },

    loadProject: function () { return invoke('loadProject'); },
    openProjectFolder: function () { return invoke('openProjectFolder'); },
    readFile: function (p) { return invoke('readFile', p); },
    saveFile: function (p, c) { return invoke('saveFile', p, c); },
    saveAs: function (c, n) { return invoke('saveAs', c, n); },
    getSaved: function () { return invoke('getSaved'); },
    chooseDirectory: function () { return invoke('chooseDirectory'); },
    runFile: function (p) { return invoke('runFile', p); },
    startRun: function (p) { return invoke('startRun', p); },
    sendInput: function (t) { return invoke('sendInput', t); },
    stopRun: function () { return invoke('stopRun'); },

    onRunStdout: function (cb) { return on('run:stdout', cb); },
    onRunStderr: function (cb) { return on('run:stderr', cb); },
    onRunExit: function (cb) { return on('run:exit', cb); },
    onRunStarted: function (cb) { return on('run:started', cb); },

    readClipboardText: function () { return invoke('readClipboardText'); },
    writeClipboardText: function (t) { return invoke('writeClipboardText', t); },

    treeCopy: function (paths) { return invoke('treeCopy', paths); },
    treeCut: function (paths) { return invoke('treeCut', paths); },
    treePaste: function (destDir) { return invoke('treePaste', destDir); },
    treeRename: function (oldPath, newName) { return invoke('treeRename', oldPath, newName); },
    treeDelete: function (paths) { return invoke('treeDelete', paths); },
    treeReveal: function (p) { return invoke('treeReveal', p); },
    treeOpenFile: function (p) { return invoke('treeOpenFile', p); },
    treeCopyPath: function (p) { return invoke('treeCopyPath', p); },
    treeCreateFile: function (dir, name, content) { return invoke('treeCreateFile', dir, name, content); },
    treeCreateDir: function (dir, name) { return invoke('treeCreateDir', dir, name); },

    onProjectChanged: function (cb) { return on('lsp:project-changed', cb); },
    onLspCompileDbUpdated: function (cb) { return on('lsp:compile-db-updated', cb); },
    onLspRestart: function (cb) { return on('lsp:restart', cb); },
    onOpenExternalFile: function (cb) { return on('file:open-external', cb); },
    toolchainStatus: function () { return invoke('toolchainStatus'); },
    onToolchainProgress: function (cb) { return on('toolchain:progress', cb); },
    onToolchainReady: function (cb) { return on('toolchain:ready', cb); },

    minimizeWindow: function () { send('minimizeWindow'); },
    maximizeWindow: function () { send('maximizeWindow'); },
    onMaximizedWindow: function (cb) { return on('window:maximized', cb); },
    unmaximizeWindow: function () { send('unmaximizeWindow'); },
    onUnmaximizedWindow: function (cb) { return on('window:unmaximized', cb); },
    closeWindow: function () { send('closeWindow'); },
    openSettingWindow: function () { send('openSettingWindow'); },
    closeSettingWindow: function () { send('closeSettingWindow'); },
    updateThemeColors: function (theme) { send('updateThemeColors', theme); },

    loadSettings: function () { return invoke('loadSettings'); },
    saveSettings: function (patch) { return invoke('saveSettings', patch); },
    onSettingsChanged: function (cb) { return on('settings:changed', cb); },
  };

  // 通知原生：JS 侧已就绪，可以开始投递缓存的事件了
  bridge.ready();
})();
