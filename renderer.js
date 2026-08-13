'use strict';

(function () {
  const PKG = {
    'vscode-jsonrpc': {
      base: 'editor://app/vendor/vscode-jsonrpc/',
      entry: 'lib/browser/main.js',
    },
    'vscode-languageserver-protocol': {
      base: 'editor://app/vendor/vscode-languageserver-protocol/',
      entry: 'lib/common/api.js',
    },
    'vscode-languageserver-types': {
      base: 'editor://app/vendor/vscode-languageserver-types/',
      entry: 'lib/umd/main.js',
    },
  };
  const cache = Object.create(null);

  function normalizePath(p) {
    const parts = p.split('/');
    const out = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return out.join('/');
  }
  function dirname(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  }
  function joinPath(dir, spec) {
    if (spec.startsWith('/')) return normalizePath(spec);
    return normalizePath((dir ? dir + '/' : '') + spec);
  }
  function syncFetch(url) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false); // 同步：CommonJS 的 require 是同步的
    xhr.send(null);
    if (xhr.status >= 200 && xhr.status < 300) return xhr.responseText;
    throw new Error('加载模块失败 (' + xhr.status + '): ' + url);
  }

  function load(pkgName, relPath) {
    // 模拟 Node 的 require 扩展名解析
    if (!/\.(js|json|mjs|cjs)$/i.test(relPath)) relPath += '.js';
    const key = pkgName + '/' + relPath;
    if (cache[key]) return cache[key].exports;

    const mod = { exports: {} };
    cache[key] = mod; // 先注册，以支持循环依赖

    const url = PKG[pkgName].base + relPath;
    const code = syncFetch(url);
    const dir = dirname(relPath);
    const factory = new Function(
      'exports',
      'require',
      'module',
      '__filename',
      '__dirname',
      code
    );
    factory(mod.exports, makeRequire(pkgName, dir), mod, url, dir);
    return mod.exports;
  }

  function makeRequire(pkgName, dir) {
    return function require(spec) {
      if (spec.startsWith('.')) {
        return load(pkgName, joinPath(dir, spec));
      }
      if (PKG[spec]) {
        return load(spec, PKG[spec].entry);
      }
      throw new Error(
        '无法解析模块 "' + spec + '"（来源: ' + pkgName + '/' + dir + '）'
      );
    };
  }

  window.__cjsRequire = function (pkgName) {
    return load(pkgName, PKG[pkgName].entry);
  };
})();

// 调试状态：供自动化冒烟测试读取
window.__cppeditor = {
  stage: 'boot',
  lspState: null,
  lspText: '',
  serverCapabilities: null,
  diagnostics: { errors: 0, warnings: 0, total: 0 },
  lastError: null,
};

const jsonrpc = window.__cjsRequire('vscode-jsonrpc');
const proto = window.__cjsRequire('vscode-languageserver-protocol');
window.__cppeditor.stage = 'cjs-loaded';

// ---------------------------------------------------------------------------
// 1. 工具函数
// ---------------------------------------------------------------------------
const IS_WIN = navigator.platform ? /Win/i.test(navigator.platform) : true;
// 应用根目录由主进程通过 query 注入，用于推导文档/工作区 URI
const APP_ROOT = (function () {
  try {
    const q = new URLSearchParams(window.location.search).get('root');
    if (q) return q;
  } catch (e) { /* ignore */ }
  return IS_WIN ? 'C:/CppEditor' : '/tmp/cppeditor';
})();
// 项目目录（保存目录）。未保存时为 null，使用应用根目录作为临时工作区。
let projectDir = null;
// 当前编辑文档对应的磁盘路径（首次保存后才有）
let FILE_PATH = (APP_ROOT.replace(/\\/g, '/') + '/main.cpp').replace(/\/+/g, '/');
let DOC_URI = 'file:///' + FILE_PATH;
let ROOT_URI = 'file:///' + APP_ROOT.replace(/\\/g, '/');

// 切换到某个项目目录，并让文档/工作区 URI 跟随它
function applyProjectDir(dir, file) {
  if (!dir) return;
  projectDir = dir;
  FILE_PATH = (dir.replace(/\\/g, '/') + '/main.cpp').replace(/\/+/g, '/');
  DOC_URI = 'file:///' + FILE_PATH;
  ROOT_URI = 'file:///' + dir.replace(/\\/g, '/');
  if (file) savedPath = file;
}

function pathDirOf(p) {
  if (!p) return null;
  return p.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
}

function pathEquals(a, b) {
  const norm = (s) =>
    (s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

// 归一化 LSP URI 以便比较：clangd 在 Windows 上会把盘符小写化并还原百分号编码，
// 而 Monaco 的 Uri.file().toString() 会产生 file:///d%3A/... 形式，需统一后再比对。
function normalizeUri(u) {
  if (!u) return u;
  try {
    u = decodeURIComponent(u);
  } catch { /* ignore */ }
  return IS_WIN ? u.toLowerCase() : u;
}

const MAX_RECONNECT = 3;
const INIT_TIMEOUT_MS = 15000;

function log(...args) {
  console.log('[renderer]', ...args);
}

function msgToStr(m) {
  if (typeof m === 'string') return m;
  try {
    return JSON.stringify(m);
  } catch {
    return String(m);
  }
}

const logger = {
  error: (m) => console.error('[LSP]', msgToStr(m)),
  warn: () => {},
  info: () => {},
  log: () => {},
};

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function toLspPosition(position) {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function toMonacoRange(range) {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1
  );
}

function normalizeDocumentation(doc) {
  if (!doc) return undefined;
  const value = typeof doc === 'string' ? doc : doc.value;
  return value ? { value, isTrusted: false } : undefined;
}

function normalizeHoverContents(contents) {
  if (typeof contents === 'string') {
    return [{ value: contents, isTrusted: false }];
  }
  if (Array.isArray(contents)) {
    return contents.map((c) => {
      if (typeof c === 'string') return { value: c, isTrusted: false };
      return {
        value: c.value || '',
        language: c.language,
        isTrusted: false,
      };
    });
  }
  return [{ value: contents.value || '', isTrusted: false }];
}

function mapCompletionKind(kind) {
  // LSP 与 Monaco 的 CompletionItemKind 枚举值一致（1..25）
  return kind >= 1 && kind <= 25
    ? kind
    : monaco.languages.CompletionItemKind.Text;
}

function toMonacoSeverity(severity) {
  switch (severity) {
    case proto.DiagnosticSeverity.Error:
      return monaco.MarkerSeverity.Error;
    case proto.DiagnosticSeverity.Warning:
      return monaco.MarkerSeverity.Warning;
    case proto.DiagnosticSeverity.Information:
      return monaco.MarkerSeverity.Info;
    case proto.DiagnosticSeverity.Hint:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Error;
  }
}

// ---------------------------------------------------------------------------
// 2. 基于 IPC 的 MessageReader / MessageWriter
//    将 vscode-jsonrpc 的连接接入 preload 暴露的 editorAPI（主进程 -> clangd）。
// ---------------------------------------------------------------------------
class IPCReader extends jsonrpc.AbstractMessageReader {
  constructor() {
    super();
    this._callback = null;
    this._unsubscribe = null;
  }

  listen(callback) {
    this._callback = callback;
    this._unsubscribe = window.editorAPI.onMessage((message) => {
      if (this._callback) {
        try {
          this._callback(message);
        } catch (err) {
          this.fireError(err);
        }
      }
    });
    return {
      dispose: () => {
        if (this._unsubscribe) {
          this._unsubscribe();
          this._unsubscribe = null;
        }
      },
    };
  }

  dispose() {
    super.dispose();
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }
}

class IPCWriter extends jsonrpc.AbstractMessageWriter {
  write(message) {
    window.editorAPI.send(message);
    return Promise.resolve();
  }

  end() {
    try {
      window.editorAPI.stop();
    } catch {
      /* ignore */
    }
  }

  dispose() {
    super.dispose();
  }
}

// ---------------------------------------------------------------------------
// 3. 状态栏
// ---------------------------------------------------------------------------
function setLspState(state, text) {
  const dot = document.getElementById('lsp-dot');
  const label = document.getElementById('lsp-status-text');
  if (!dot || !label) return;
  const cls =
    state === 'connected'
      ? 'connected'
      : state === 'connecting'
        ? 'connecting'
        : state === 'warning'
          ? 'warning'
          : 'error';
  dot.className = 'status-dot ' + cls;
  label.textContent = text;
  label.title = text;
  window.__cppeditor.lspState = state;
  window.__cppeditor.lspText = text;
  if (state === 'error') window.__cppeditor.lastError = text;
}

function setDiagCounts(errors, warnings) {
  const e = document.getElementById('diag-errors');
  const w = document.getElementById('diag-warnings');
  if (e) e.textContent = errors + ' 个错误';
  if (w) w.textContent = warnings + ' 个警告';
}

function updateCursor(position) {
  const el = document.getElementById('cursor-pos');
  if (el) {
    el.textContent = 'Ln ' + position.lineNumber + ', Col ' + position.column;
  }
}

function updateFileLabel() {
  const el = document.getElementById('file-path');
  const t = activeTab();
  const label = t ? (t.path || t.name) : '';
  if (el) el.textContent = String(label).replace(/\\/g, '/');
  window.__cppeditor.savedPath = t ? t.path : null;
}

function showSaveStatus(text, isError) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? '#f48771' : '#89d185';
  clearTimeout(showSaveStatus._timer);
  showSaveStatus._timer = setTimeout(() => {
    el.textContent = '';
  }, 4000);
}

// 保存当前激活标签页：
//  - 已有路径（从项目树打开）：写回该文件
//  - 未命名标签页：先选择保存目录，写入 main.cpp，再绑定路径
async function saveFile() {
  if (!editor || shutdown) return;
  const tab = activeTab();
  if (!tab) return;
  if (tab.kind !== 'text' || !tab.model) {
    showSaveStatus('该标签页无法以文本方式保存', true);
    return;
  }
  try {
    if (!tab.path) {
      const result = await window.editorAPI.save(tab.model.getValue());
      if (!result || result.cancelled) return;
      if (!result.ok) {
        showSaveStatus(result.message || '保存失败', true);
        return;
      }
      tab.path = result.path;
      tab.name = basename(tab.path);
      tab.savedContent = content;
      tab.dirty = false;
      applyProjectDir(result.projectDir || pathDirOf(result.path), result.path);
      // 让 model 的 URI 跟随真实路径，clangd 才能对同一 URI 工作
      const old = tab.model;
      tab.model = monaco.editor.createModel(
        old.getValue(),
        old.getLanguageId(),
        monaco.Uri.file(tab.path)
      );
      old.dispose();
      activateTab(tab);
      showSaveStatus('已保存: ' + tab.path);
      window.__cppeditor._saveSeq = (window.__cppeditor._saveSeq || 0) + 1;
      loadProjectFile();
      return;
    }

    const result = await window.editorAPI.saveFile(tab.path, tab.model.getValue());
    if (result && result.ok) {
      tab.savedContent = tab.model.getValue();
      tab.dirty = false;
      renderTabs();
      updateFileLabel();
      showSaveStatus('已保存: ' + result.path);
      window.__cppeditor._saveSeq = (window.__cppeditor._saveSeq || 0) + 1;
    } else {
      showSaveStatus((result && result.message) || '保存失败', true);
    }
  } catch (err) {
    showSaveStatus('保存失败: ' + err.message, true);
  }
}

// ---------------------------------------------------------------------------
// 4. LSP 客户端
// ---------------------------------------------------------------------------
let lsp = null; // { connection, reader, writer, initialized }
let serverCapabilities = null;
let fallbackFlags = [];
let docVersion = 0;
let dirty = false;
let changeTimer = null;
let reconnectAttempts = 0;
let shutdown = false;
let savedPath = null;

function isReady() {
  return lsp !== null && lsp.initialized && editor !== null;
}

function teardownLsp() {
  if (changeTimer) {
    clearTimeout(changeTimer);
    changeTimer = null;
  }
  if (lsp) {
    try {
      lsp.connection.dispose();
    } catch {
      /* ignore */
    }
    try {
      lsp.reader.dispose();
    } catch {
      /* ignore */
    }
    try {
      lsp.writer.dispose();
    } catch {
      /* ignore */
    }
    lsp = null;
  }
  serverCapabilities = null;
  // 确保旧的 clangd 进程被真正停止，否则 start() 会因 isClangdRunning() 短路复用旧进程
  try {
    window.editorAPI.stop();
  } catch {
    /* ignore */
  }
}

function registerHandlers(connection) {
  // 实时错误/警告（红色波浪线）
  connection.onNotification(
    proto.PublishDiagnosticsNotification.type,
    handleDiagnostics
  );

  // clangd 可能发起的请求/通知，注册空处理以消除噪音
  connection.onRequest('window/workDoneProgress/create', () => ({}));
  connection.onNotification('window/showMessage', (message) => {
    if (message && message.message) {
      setLspState('warning', 'clangd: ' + message.message);
    }
  });
  connection.onNotification('window/logMessage', (message) => {
    if (message && message.message) log('[clangd] ' + message.message);
  });
  connection.onNotification('$/progress', () => {});
}

async function bootstrap() {
  if (shutdown) return;

  setLspState('connecting', '正在启动 clangd...');

  // 先停掉旧连接与旧 clangd，再启动新的，避免两个 clangd 进程并存
  teardownLsp();

  let config;
  try {
    config = await window.editorAPI.start();
  } catch (err) {
    setLspState('error', '无法启动语言服务器: ' + err.message);
    return;
  }

  if (!config || !config.ok) {
    setLspState('error', (config && config.message) || 'clangd 启动失败');
    return;
  }

  fallbackFlags = config.fallbackFlags || [];

  const reader = new IPCReader();
  const writer = new IPCWriter();
  const connection = jsonrpc.createMessageConnection(reader, writer, logger);
  registerHandlers(connection);
  connection.listen();
  lsp = { connection, reader, writer, initialized: false };

  setLspState('connecting', 'clangd 已启动，正在初始化 LSP 会话...');

  const params = {
    processId: null,
    clientInfo: { name: 'CppEditor', version: '0.1.0' },
    rootUri: ROOT_URI,
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false },
        completion: {
          completionItem: {
            snippetSupport: true,
            documentationFormat: ['markdown', 'plaintext'],
            deprecatedSupport: true,
            commitCharactersSupport: true,
          },
        },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        publishDiagnostics: { relatedInformation: false },
      },
      workspace: {
        workspaceFolders: false,
        // 声明客户端会发送 workspace/didChangeWatchedFiles 文件监听通知
        didChangeWatchedFiles: { dynamicRegistration: false },
      },
      // 让 clangd 以 UTF-16 计算字符偏移，与 Monaco 的坐标一致
      general: { positionEncodings: ['utf-16'] },
    },
    initializationOptions: { fallbackFlags },
    trace: 'off',
  };

  let initResult;
  try {
    initResult = await withTimeout(
      connection.sendRequest(proto.InitializeRequest.type, params),
      INIT_TIMEOUT_MS,
      'LSP 初始化超时（' + INIT_TIMEOUT_MS / 1000 + ' 秒）'
    );
  } catch (err) {
    teardownLsp();
    setLspState('error', 'LSP 初始化失败: ' + err.message);
    return;
  }

  serverCapabilities = initResult.capabilities || {};
  lsp.initialized = true;
  reconnectAttempts = 0;
  docVersion = 0;
  dirty = false;

  connection.sendNotification(proto.InitializedNotification.type, {});
  sendDidOpen();
  window.__cppeditor.stage = 'lsp-connected';
  window.__cppeditor._bootSeq = (window.__cppeditor._bootSeq || 0) + 1;
  window.__cppeditor.serverCapabilities = Object.keys(serverCapabilities);
  setLspState('connected', 'clangd 已连接（C++ 智能提示就绪）');
}

function sendDidOpen() {
  syncActiveDoc();
}

function syncActiveDoc() {
  if (!isReady()) return;
  const doc = currentTextDoc();
  if (!doc || !doc.uri) {
    if (lsp.lastDocUri) {
      try {
        lsp.connection.sendNotification(proto.DidCloseTextDocumentNotification.type, {
          textDocument: { uri: lsp.lastDocUri },
        });
      } catch { /* ignore */ }
      lsp.lastDocUri = null;
    }
    return;
  }
  if (lsp.lastDocUri && lsp.lastDocUri !== doc.uri) {
    try {
      lsp.connection.sendNotification(proto.DidCloseTextDocumentNotification.type, {
        textDocument: { uri: lsp.lastDocUri },
      });
    } catch { /* ignore */ }
    lsp.lastDocUri = null;
  }
  // 仅 C/C++ 文档注册给 clangd，其他语言不参与 LSP
  if (!isCppLang(doc.languageId)) {
    lsp.lastDocUri = null;
    return;
  }
  lsp.lastDocUri = doc.uri;
  docVersion = 1;
  dirty = false;
  lsp.connection.sendNotification(proto.DidOpenTextDocumentNotification.type, {
    textDocument: {
      uri: doc.uri,
      languageId: doc.languageId,
      version: docVersion,
      text: doc.text,
    },
  });
}

function syncNow() {
  if (!isReady() || !dirty) return;
  const doc = currentTextDoc();
  if (!doc || !doc.uri || !isCppLang(doc.languageId)) {
    dirty = false;
    return;
  }
  if (changeTimer) {
    clearTimeout(changeTimer);
    changeTimer = null;
  }
  docVersion += 1;
  dirty = false;
  lsp.connection.sendNotification(proto.DidChangeTextDocumentNotification.type, {
    textDocument: { uri: doc.uri, version: docVersion },
    contentChanges: [{ text: doc.text }],
  });
}

function scheduleChange() {
  dirty = true;
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(syncNow, 150);
}

function handleDiagnostics(params) {
  const doc = currentTextDoc();
  if (!params || !doc || !doc.uri || normalizeUri(params.uri) !== normalizeUri(doc.uri) || !isCppLang(doc.languageId)) return;
  const model = editor && editor.getModel();
  if (!model) return;

  const markers = (params.diagnostics || []).map((d) => ({
    severity: toMonacoSeverity(d.severity),
    message: d.message || '',
    startLineNumber: (d.range.start.line || 0) + 1,
    startColumn: (d.range.start.character || 0) + 1,
    endLineNumber: (d.range.end.line || 0) + 1,
    endColumn: (d.range.end.character || 0) + 1,
    code: d.code,
    source: d.source || 'clangd',
  }));

  monaco.editor.setModelMarkers(model, 'clangd', markers);

  let errors = 0;
  let warnings = 0;
  for (const m of markers) {
    if (m.severity === monaco.MarkerSeverity.Error) errors += 1;
    else if (m.severity === monaco.MarkerSeverity.Warning) warnings += 1;
  }
  setDiagCounts(errors, warnings);
  window.__cppeditor.diagnostics = {
    errors,
    warnings,
    total: markers.length,
  };
}

function handleServerStatus(status) {
  if (!status) return;
  switch (status.state) {
    case 'starting':
      setLspState('connecting', status.message || '正在启动 clangd...');
      break;
    case 'running':
      break; // 等 initialize 完成后统一显示 connected
    case 'exited':
      teardownLsp();
      setLspState(
        'error',
        'clangd 已退出 (code=' + status.code + ')，正在重连...'
      );
      scheduleReconnect();
      break;
    case 'error':
      teardownLsp();
      setLspState('error', status.message || 'clangd 发生错误');
      scheduleReconnect();
      break;
    default:
      break;
  }
}

function scheduleReconnect() {
  if (shutdown) return;
  if (reconnectAttempts >= MAX_RECONNECT) {
    setLspState('error', 'clangd 多次重连失败，请按 Ctrl+Shift+R 手动重连');
    return;
  }
  reconnectAttempts += 1;
  setTimeout(() => {
    if (!shutdown) bootstrap();
  }, 1500);
}

// ---------------------------------------------------------------------------
// 5. 补全 / 悬停 / 诊断 提供器
// ---------------------------------------------------------------------------
function mapCompletionItem(item, model, position) {
  if (!item || !item.label) return null;

  const completion = {
    label: item.label,
    kind: mapCompletionKind(item.kind),
    detail: item.detail || undefined,
    documentation: normalizeDocumentation(item.documentation),
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect || undefined,
    tags: item.tags,
  };

  if (item.textEdit && item.textEdit.range) {
    completion.range = toMonacoRange(item.textEdit.range);
    completion.insertText = item.textEdit.newText;
  } else {
    const word = model.getWordUntilPosition(position);
    completion.range = new monaco.Range(
      position.lineNumber,
      word.startColumn,
      position.lineNumber,
      Math.max(word.endColumn, position.column)
    );
    completion.insertText = item.insertText || item.label;
  }

  if (item.insertTextFormat === 2) {
    completion.insertTextRules =
      monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }
  if (item.additionalTextEdits && item.additionalTextEdits.length) {
    completion.additionalTextEdits = item.additionalTextEdits.map((edit) => ({
      range: toMonacoRange(edit.range),
      text: edit.newText,
    }));
  }
  return completion;
}

async function provideCompletion(model, position, context) {
  const doc = currentTextDoc();
  if (!isReady() || !doc || !doc.uri || !isCppLang(doc.languageId)) {
    return { suggestions: [] };
  }
  syncNow();
  try {
    const triggerKind =
      context.triggerKind === 0 ? 1 : context.triggerKind === 1 ? 2 : 3;
    const params = {
      textDocument: { uri: doc.uri },
      position: toLspPosition(position),
      context: {
        triggerKind,
        triggerCharacter: context.triggerCharacter || null,
      },
    };
    const result = await lsp.connection.sendRequest(
      proto.CompletionRequest.type,
      params
    );
    const items = Array.isArray(result)
      ? result
      : (result && result.items) || [];
    const suggestions = items
      .map((item) => mapCompletionItem(item, model, position))
      .filter(Boolean);
    return {
      suggestions,
      incomplete: !!(result && result.isIncomplete),
    };
  } catch (err) {
    console.warn('[LSP] 补全请求失败:', err);
    return { suggestions: [] };
  }
}

async function provideHover(model, position) {
  const doc = currentTextDoc();
  if (!isReady() || !doc || !doc.uri || !isCppLang(doc.languageId)) return null;
  syncNow();
  try {
    const params = {
      textDocument: { uri: doc.uri },
      position: toLspPosition(position),
    };
    const result = await lsp.connection.sendRequest(
      proto.HoverRequest.type,
      params
    );
    if (!result || !result.contents) return null;
    return {
      contents: normalizeHoverContents(result.contents),
      range: result.range ? toMonacoRange(result.range) : undefined,
    };
  } catch (err) {
    console.warn('[LSP] 悬停请求失败:', err);
    return null;
  }
}

function buildFileTree(paths, basePath = '') {
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return [];
  }

  const root = {
    name: 'root',
    type: 'directory',
    children: [],
    path: basePath || 'root'
  };

  paths.forEach(entry => {
    const filePath = typeof entry === 'string' ? entry : entry.path;
    const isDirEntry = typeof entry === 'object' && entry.isDirectory === true;
    // 生成相对路径
    let relativePath = filePath;
    if (basePath && filePath.startsWith(basePath)) {
      relativePath = filePath.substring(basePath.length);
      // 移除开头的路径分隔符
      if (relativePath.startsWith('\\') || relativePath.startsWith('/')) {
        relativePath = relativePath.substring(1);
      }
    }

    // 统一使用 / 作为分隔符
    const normalized = relativePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(segment => segment !== '');

    if (segments.length === 0) return;

    let currentNode = root;
    let currentPath = basePath;

    segments.forEach((segment, index) => {
      const isLast = index === segments.length - 1;

      // 构建当前节点的完整路径
      if (currentPath) {
        currentPath = currentPath + '\\' + segment;
      } else {
        currentPath = segment;
      }

      // 若当前节点此前被误判为文件（后面还有路径要进入它），提升为目录
      if (currentNode.type === 'file') {
        currentNode.type = 'directory';
        currentNode.isFile = false;
        currentNode.extension = '';
        currentNode.children = [];
      }

      // 查找是否已存在同名子节点
      let child = currentNode.children.find(
          node => node.name === segment
      );

      if (!child) {
        // 是否为文件由主进程的 isDirectory 决定；目录名含点（如 .cache）也按目录处理
        const isFile = isLast && !isDirEntry;

        child = {
          name: segment,
          type: isFile ? 'file' : 'directory',
          children: isFile ? undefined : [],
          path: currentPath,
          // 额外信息
          isFile: isFile,
          extension: isFile ? getFileExtension(segment) : '',
          size: 0, // 可以后续通过 fs.stat 获取
        };

        currentNode.children.push(child);
      }

      currentNode = child;
    });
  });

  // 对子节点排序：目录在前，文件在后，按名称字典序
  function sortChildren(node) {
    if (node.children && Array.isArray(node.children)) {
      node.children.sort(compareTreeNodes);

      // 递归排序子节点
      node.children.forEach(child => {
        if (child.type === 'directory') {
          sortChildren(child);
        }
      });
    }
    return node;
  }

  // 对根节点的子节点也排序（目录在前、文件在后，各自按名称字典序）
  sortChildren(root);

  // 返回根节点的子节点（即顶层目录/文件）
  return root.children;
}

function getFileExtension(filename) {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1) return '';
  return filename.substring(lastDotIndex + 1);
}

function getFileType(node) {
  if (node.type === 'directory') return 'folder'
  const ext = getFileExtension(node.name);
  const typeMap = {
    'c': 'c',
    'cpp': 'cpp',
    'h': 'h',
    'txt': 'txt',
    'in': 'txt',
    'out': 'txt',
    'ans': 'txt'
  }
  return typeMap[ext] || 'unknown';
}

function getFileIcon(ext) {
  const iconMap = {
    'c': 'editor://app/resources/icons/c.svg',
    'cpp': 'editor://app/resources/icons/cpp.svg',
    'h': 'editor://app/resources/icons/h.svg',
    'txt': 'editor://app/resources/icons/txt.svg',
    'folder': 'editor://app/resources/icons/folder.svg',
    'unknown': 'editor://app/resources/icons/unknown.svg'
  };
  return iconMap[ext] || 'editor://app/resources/icons/unkonwn.svg';
}

function expandFolder(node){
  if (node.classList.contains('expanded')){
    node.classList.remove('expanded');
    node.querySelectorAll(':scope > div.children')[0].style.display = 'none';
  }
  else{
    node.classList.add('expanded');
    node.querySelectorAll(':scope > div.children')[0].style.display = 'block';
  }
}

function rendererFileTree(paths, faNode) {
  paths.forEach(path => {
    const node = document.createElement('div');
    if (path.type === 'directory'){
      const nodeExpand = document.createElement('div');
      nodeExpand.innerText = '>';
      nodeExpand.classList.add('expand');
      nodeExpand.addEventListener('click', () => expandFolder(node))
      node.appendChild(nodeExpand);
      node.classList.add('folder');
    }
    else {
      node.classList.add('file');
      node.addEventListener('click', () => openFileTab(path.path));
    }
    const nodeImg = document.createElement('img');
    nodeImg.src = getFileIcon(getFileType(path));
    const nodeText = document.createElement('span');
    nodeText.innerText = path.name;
    node.appendChild(nodeImg);
    node.appendChild(nodeText);
    if (path.type === 'directory') {
      const nodeChildren = document.createElement('div');
      nodeChildren.classList.add('children');
      nodeChildren.style.display = 'none';
      rendererFileTree(path.children, nodeChildren);
      node.appendChild(nodeChildren);
    }
    faNode.appendChild(node);
    path.node = node;
  })
}

let projectFileTree = [];
let projectDom = null;

// 弹出文件夹选择框并作为项目打开；选中后刷新左侧文件树。
// 「打开文件夹」大按钮与「切换文件夹」小按钮共用此逻辑。
async function pickProjectFolder() {
  const result = await window.editorAPI.openProjectFolder();
  if (!result || result.cancelled) return;
  projectDir = result.projectDir || projectDir;
  await loadProjectFile();
}

// 未打开任何文件夹时，在左侧显示一个蓝色的「打开文件夹」按钮（类似 VSCode）。
function renderOpenFolderButton(container) {
  const btn = document.createElement('button');
  btn.id = 'open-folder-btn';
  btn.type = 'button';
  const img = document.createElement('img');
  img.src = getFileIcon('folder');
  const span = document.createElement('span');
  span.textContent = '打开文件夹';
  btn.appendChild(img);
  btn.appendChild(span);
  btn.addEventListener('click', pickProjectFolder);
  container.appendChild(btn);
}

// 已打开项目时，在文件树顶部显示一个小图标按钮，点击可切换文件夹
function renderSwitchFolderButton(toolbar) {
  const btn = document.createElement('button');
  btn.id = 'switch-folder-btn';
  btn.type = 'button';
  btn.title = '切换文件夹';
  const img = document.createElement('img');
  img.src = getFileIcon('folder');
  btn.appendChild(img);
  btn.addEventListener('click', pickProjectFolder);
  toolbar.appendChild(btn);
}

// 确保项目目录信息已加载（init 与 startEditor 共享同一个加载过程）
let projectLoadPromise = null;
function ensureProjectLoaded() {
  if (!projectLoadPromise) projectLoadPromise = loadProjectFile();
  return projectLoadPromise;
}

async function loadProjectFile(){
  const projectInf = await window.editorAPI.loadProject();
  if (projectInf && projectInf.projectDir) projectDir = projectInf.projectDir;
  const treeEl = document.getElementById('filetree');
  const toolbar = document.getElementById('filetoolbar');
  if (treeEl) treeEl.innerHTML = '';
  if (toolbar) toolbar.innerHTML = '';
  if (!projectInf || !projectInf.projectDir) {
    // 尚未设置项目路径：什么都不打开，仅显示「打开文件夹」按钮
    projectFileTree = [];
    projectDom = null;
    if (treeEl) renderOpenFolderButton(treeEl);
    return;
  }
  const projectTree = buildFileTree(projectInf.files, projectInf.projectDir);
  projectFileTree = projectTree.filter(path => path.name !== '.cache' && path.name !== 'compile_commands.json');
  projectDom = document.createElement('div');
  const projectExpand = document.createElement('div');
  projectExpand.innerText = '>';
  projectExpand.classList.add('expand');
  projectExpand.addEventListener('click', () => expandFolder(projectDom))
  projectDom.appendChild(projectExpand);
  projectDom.classList.add('folder');
  projectDom.classList.add('expanded');
  const projectImg = document.createElement('img');
  projectImg.src = getFileIcon('folder');
  const projectText = document.createElement('span');
  function dirname(p) {
    p = p.replace(/\\/g, '/');
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(i+1);
  }
  projectText.innerText = dirname(projectInf.projectDir);
  projectDom.appendChild(projectImg);
  projectDom.appendChild(projectText);
  const projectChildren = document.createElement('div');
  projectChildren.classList.add('children');
  rendererFileTree(projectFileTree, projectChildren);
  projectDom.appendChild(projectChildren);
  if (treeEl) treeEl.appendChild(projectDom);
  // 已打开项目：顶部显示「切换文件夹」按钮
  if (toolbar) renderSwitchFolderButton(toolbar);
  // 树已就绪，应用暂存的文件变化
  if (treePendingInfo) {
    const pending = treePendingInfo;
    treePendingInfo = null;
    updateFileTree(pending);
  }
}

// ---------------------------------------------------------------------------
// 5b. 文件树增量更新：根据项目目录变化（added/removed）增删树节点与 DOM
// ---------------------------------------------------------------------------
let treePendingInfo = null;

function normalizeTreePath(p) {
  return (p || '').replace(/\\/g, '/');
}

function shouldIgnoreTreePath(p) {
  const norm = normalizeTreePath(p).toLowerCase();
  const parts = norm.split('/');
  if (parts.includes('.cache')) return true;
  if (norm.endsWith('/compile_commands.json')) return true;
  return false;
}

function compareTreeNodes(a, b) {
  if (a.type === 'directory' && b.type !== 'directory') return -1;
  if (a.type !== 'directory' && b.type === 'directory') return 1;
  return compareNames(a.name, b.name);
}

// 名称字典序比较（不区分大小写，大小写相同时按原始字符序稳定排序）
function compareNames(x, y) {
  const lx = String(x).toLowerCase();
  const ly = String(y).toLowerCase();
  if (lx < ly) return -1;
  if (lx > ly) return 1;
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

// 将新 DOM 节点按「目录优先 + 名称字典序」插入容器
function insertChildDomSorted(container, el, name, isDir) {
  for (const sibling of container.children) {
    if (!sibling.classList || (!sibling.classList.contains('folder') && !sibling.classList.contains('file'))) continue;
    const sibIsDir = sibling.classList.contains('folder');
    const sibSpan = sibling.querySelector('span');
    const sibName = sibSpan ? sibSpan.textContent : '';
    let before = false;
    if (isDir && !sibIsDir) before = true;
    else if (!isDir && sibIsDir) before = false;
    else before = compareNames(name, sibName) < 0;
    if (before) {
      container.insertBefore(el, sibling);
      return;
    }
  }
  container.appendChild(el);
}

// 在树中按绝对路径定位节点（不存在返回 null）
function findTreeNode(nodes, fullPath) {
  const target = normalizeTreePath(fullPath);
  const queue = [...nodes];
  while (queue.length) {
    const n = queue.shift();
    if (normalizeTreePath(n.path) === target) return n;
    if (n.children) queue.push(...n.children);
  }
  return null;
}

// 将新增文件/目录的绝对路径插入数据树与 DOM（自动补齐中间目录）
function insertFilePath(basePath, nodes, fullPath, rootContainer, isDirectory) {
  let rel = fullPath;
  if (basePath && normalizeTreePath(fullPath).startsWith(normalizeTreePath(basePath))) {
    rel = fullPath.substring(basePath.length);
    if (rel.startsWith('\\') || rel.startsWith('/')) rel = rel.substring(1);
  }
  const segments = normalizeTreePath(rel).split('/').filter(Boolean);
  if (!segments.length) return;

  let levelNodes = nodes;
  let levelContainer = rootContainer;
  let currentPath = basePath || '';

  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    currentPath = currentPath ? currentPath + '\\' + segment : segment;

    let child = levelNodes.find((n) => n.name === segment);
    if (!child) {
      // isDirectory 只针对整条路径的末段（文件/目录由 watcher 判定）
      const isFile = isLast && !isDirectory;
      child = {
        name: segment,
        type: isFile ? 'file' : 'directory',
        children: isFile ? undefined : [],
        path: currentPath,
        isFile,
        extension: isFile ? getFileExtension(segment) : '',
        size: 0,
        node: null,
      };
      // 按排序规则插入数据数组
      const idx = levelNodes.findIndex((n) => compareTreeNodes(child, n) < 0);
      if (idx === -1) levelNodes.push(child);
      else levelNodes.splice(idx, 0, child);

      // 创建 DOM 节点
      const el = document.createElement('div');
      if (isFile) {
        el.classList.add('file');
        el.addEventListener('click', () => openFileTab(child.path));
      } else {
        el.classList.add('folder');
        const expand = document.createElement('div');
        expand.innerText = '>';
        expand.classList.add('expand');
        expand.addEventListener('click', () => expandFolder(el));
        el.appendChild(expand);
      }
      const img = document.createElement('img');
      img.src = getFileIcon(isFile ? getFileType(child) : 'folder');
      const text = document.createElement('span');
      text.innerText = child.name;
      el.appendChild(img);
      el.appendChild(text);
      if (!isFile) {
        const childrenEl = document.createElement('div');
        childrenEl.classList.add('children');
        childrenEl.style.display = 'none';
        el.appendChild(childrenEl);
      }
      child.node = el;
      insertChildDomSorted(levelContainer, el, child.name, !isFile);
    }

    // 若该节点此前被误判为文件（新路径要进入它），提升为目录
    if (child.type === 'file' && !isLast) {
      child.type = 'directory';
      child.isFile = false;
      child.extension = '';
      child.children = [];
      if (child.node) {
        const el = child.node;
        el.classList.remove('file');
        el.classList.add('folder');
        const expand = document.createElement('div');
        expand.innerText = '>';
        expand.classList.add('expand');
        expand.addEventListener('click', () => expandFolder(el));
        el.insertBefore(expand, el.firstChild);
        const childrenEl = document.createElement('div');
        childrenEl.classList.add('children');
        childrenEl.style.display = 'none';
        el.appendChild(childrenEl);
      }
    }

    if (child.type === 'directory') {
      levelNodes = child.children;
      levelContainer = child.node ? child.node.querySelector(':scope > div.children') : null;
    } else {
      levelNodes = [];
      levelContainer = null;
    }
  });
}

// 将已删除文件/目录从数据树与 DOM 中移除
function removeFilePath(nodes, fullPath, rootContainer) {
  const target = normalizeTreePath(fullPath);
  const removeIn = (list, container) => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (normalizeTreePath(n.path) === target) {
        list.splice(i, 1);
        if (n.node && n.node.parentNode) n.node.parentNode.removeChild(n.node);
        return true;
      }
      if (n.type === 'directory') {
        const childContainer = n.node ? n.node.querySelector(':scope > div.children') : null;
        if (removeIn(n.children, childContainer)) {
          // 空文件夹也保留在树中（与创建时「空文件夹可见」一致），
          // 目录本身的增删由 watcher 以 added/removed 事件驱动
          return true;
        }
      }
    }
    return false;
  };
  removeIn(nodes, rootContainer);
}

// 根据主进程推送的文件变化增量更新文件树
function updateFileTree(info) {
  if (!info) return;
  if (!projectFileTree || !projectDom) {
    // 树尚未构建完成，暂存事件，构建完成后补应用
    treePendingInfo = {
      added: [...((treePendingInfo && treePendingInfo.added) || []), ...(info.added || [])],
      removed: [...((treePendingInfo && treePendingInfo.removed) || []), ...(info.removed || [])],
    };
    return;
  }
  const rootContainer = projectDom.querySelector(':scope > div.children');
  if (!rootContainer) return;
  for (const f of info.added || []) {
    const p = typeof f === 'object' ? f.path : f;
    if (shouldIgnoreTreePath(p)) continue;
    insertFilePath(projectDir, projectFileTree, p, rootContainer, typeof f === 'object' ? !!f.isDirectory : false);
  }
  for (const f of info.removed || []) {
    const p = typeof f === 'object' ? f.path : f;
    if (shouldIgnoreTreePath(p)) continue;
    removeFilePath(projectFileTree, p, rootContainer);
  }
}

// ---------------------------------------------------------------------------
// 6. 编辑器初始化与多标签页
//    每个标签页持有独立的 monaco model（自带语法高亮与撤销/重做栈），
//    文本用编辑器打开，图片用图片查看器，二进制/未知类型显示信息面板。
// ---------------------------------------------------------------------------
const DEFAULT_CODE = ``;

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg'];

const LANG_BY_EXT = {
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.ino': 'cpp',
  '.java': 'java', '.py': 'python', '.js': 'javascript', '.mjs': 'javascript',
  '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript',
  '.tsx': 'typescript', '.json': 'json', '.jsonc': 'json',
  '.md': 'markdown', '.txt': 'plaintext', '.log': 'plaintext',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss',
  '.less': 'less', '.xml': 'xml', '.svg': 'xml', '.yml': 'yaml',
  '.yaml': 'yaml', '.ini': 'ini', '.toml': 'ini', '.sh': 'shell',
  '.bat': 'batch', '.ps1': 'powershell', '.sql': 'sql', '.go': 'go',
  '.rs': 'rust', '.cs': 'csharp', '.php': 'php', '.rb': 'ruby',
  '.swift': 'swift', '.kt': 'kotlin', '.lua': 'lua', '.dart': 'dart',
};

let editor = null;
let tabs = [];
let activeTabId = null;
let tabSeq = 0;
let pendingOpenPath = null;
let pendingOpenOpts = null;

function basename(p) {
  p = (p || '').replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function pathJoin(dir, name) {
  return (dir || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/' + name;
}

function languageForPath(p) {
  const ext = '.' + getFileExtension(p).toLowerCase();
  return LANG_BY_EXT[ext] || 'plaintext';
}

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function findTabByPath(p) {
  const norm = (p || '').replace(/\\/g, '/').toLowerCase();
  return (
    tabs.find(
      (t) => t.path && t.path.replace(/\\/g, '/').toLowerCase() === norm
    ) || null
  );
}

function isCppLang(lang) {
  return lang === 'cpp' || lang === 'c' || lang === 'objective-c';
}

// 当前激活的文本文档信息（供 LSP 使用）；非文本/无 model 时返回 null
function currentTextDoc() {
  const t = activeTab();
  if (!t || t.kind !== 'text' || !t.model) return null;
  const uri = t.model.uri ? t.model.uri.toString() : null;
  return { uri, languageId: t.model.getLanguageId(), text: t.model.getValue() };
}

// 打开文件（项目树点击 / 启动恢复）。同一文件只保留一个标签页。
async function openFileTab(path, opts) {
  opts = opts || {};
  if (!editor) {
    pendingOpenPath = path;
    pendingOpenOpts = opts;
    return;
  }
  const existing = findTabByPath(path);
  if (existing) {
    activateTab(existing);
    return;
  }

  const tab = {
    id: ++tabSeq,
    path,
    name: basename(path),
    kind: 'text',
    dirty: false,
    restoring: !!opts.restore,
    model: null,
  };
  tabs.push(tab);

  let file = null;
  try {
    file =
      opts.content !== undefined
        ? { ok: true, content: opts.content }
        : await window.editorAPI.readFile(path);
  } catch (e) {
    file = { ok: false, message: e.message };
  }

  if (!file || !file.ok) {
    tab.kind = 'error';
    tab.errorMsg = (file && file.message) || '读取文件失败';
    renderTabs();
    activateTab(tab);
    return;
  }

  const ext = '.' + getFileExtension(path).toLowerCase();
  const isImage = IMAGE_EXTS.includes(ext) || (file.mime && file.mime.startsWith('image/'));

  if (isImage || file.binary) {
    tab.kind = 'image';
    tab.mime = file.mime || 'image/png';
    tab.size = file.size || 0;
    tab.b64 = file.content; // 主进程对图片/二进制返回 base64
    if (isImage && !file.binary && typeof file.content === 'string') {
      // svg 等以文本形式返回的图片：转成 base64
      try {
        tab.b64 = btoa(unescape(encodeURIComponent(file.content)));
      } catch {
        tab.b64 = btoa(file.content);
      }
    }
    if (file.binary && !isImage) tab.kind = 'binary';
  } else {
    tab.kind = 'text';
    tab.model = monaco.editor.createModel(
      file.content,
      languageForPath(path),
      monaco.Uri.file(path)
    );
    tab.savedContent = file.content;
  }

  renderTabs();
  activateTab(tab);
}

// 没有任何打开的标签页时，隐藏编辑器内容（visibility 保留布局占位，
// 状态栏不会上移；不能 display:none，否则底部状态栏会被顶上去）
function showEmptyState() {
  const econt = document.getElementById('editor');
  if (econt) econt.style.visibility = 'hidden';
  const host = document.getElementById('fileview');
  if (host) {
    host.style.display = 'none';
    host.innerHTML = '';
  }
}

function activateTab(tab) {
  const prev = activeTab();
  activeTabId = tab.id;
  const host = document.getElementById('fileview');
  const econt = document.getElementById('editor');

  if (tab.kind === 'text' && tab.model) {
    if (host) {
      host.style.display = 'none';
      host.innerHTML = '';
    }
    if (econt) {
      econt.style.display = '';
      econt.style.visibility = 'visible';
    }
    editor.setModel(tab.model);
    if (editor.layout) editor.layout();
    if (!tab.restoring) editor.focus();
  } else {
    if (econt) econt.style.display = 'none';
    editor.setModel(null);
    if (host) {
      host.style.display = 'flex';
      host.innerHTML = '';
      if (tab.kind === 'image') {
        const img = document.createElement('img');
        img.src = 'data:' + (tab.mime || 'image/png') + ';base64,' + tab.b64;
        host.appendChild(img);
      } else {
        const info = document.createElement('div');
        info.className = 'bininfo';
        const t1 = document.createElement('div');
        t1.className = 'bintitle';
        t1.textContent = tab.name;
        const t2 = document.createElement('div');
        t2.className = 'binmsg';
        t2.textContent =
          tab.kind === 'error'
            ? tab.errorMsg
            : '二进制文件（' + (tab.size || 0) + ' 字节），无法以文本方式编辑';
        info.appendChild(t1);
        info.appendChild(t2);
        host.appendChild(info);
      }
    }
  }

  renderTabs();
  updateFileLabel();
  syncActiveDoc(prev);
}

// 以磁盘当前内容重建标签页（外部修改时保持与磁盘同步）。
// 文件已不存在时直接关闭标签页（删除文件 = 关闭标签）。
async function reloadTabFromDisk(tab) {
  if (!tab || !tab.path) return;
  let file = null;
  try {
    file = await window.editorAPI.readFile(tab.path);
  } catch (e) {
    file = { ok: false, message: e.message };
  }
  if (!file || !file.ok) {
    closeTab(tab.id);
    return;
  }

  const ext = '.' + getFileExtension(tab.path).toLowerCase();
  const isImage = IMAGE_EXTS.includes(ext) || (file.mime && file.mime.startsWith('image/'));
  const kind = isImage ? 'image' : file.binary ? 'binary' : 'text';

  // 文件类型变化（如文本→二进制）会被主进程解析为「删除旧文件 + 新增新文件」，
  // 走 removed 分支直接关闭标签，这里无需处理类型切换。
  if (kind === 'text') {
    if (!tab.model) {
      tab.model = monaco.editor.createModel(
        file.content,
        languageForPath(tab.path),
        monaco.Uri.file(tab.path)
      );
    } else if (tab.model.getValue() !== file.content) {
      tab.model.setValue(file.content);
    }
    tab.savedContent = file.content;
    tab.dirty = false;
  } else {
    tab.mime = file.mime || 'image/png';
    tab.size = file.size || 0;
    tab.b64 = file.content;
  }

  renderTabs();
  if (activeTabId === tab.id) activateTab(tab);
}

// 外部文件变化时，同步已打开标签页：
//  - modified: 非脏文本标签重新读取；图片/二进制重新加载
//  - removed:  直接关闭对应标签页（文件已删除，无需保留）
//  - added:    树已自动插入节点；标签页由用户按需重新打开
async function refreshTabsForChanges(info) {
  if (!info) return;
  for (const f of info.modified || []) {
    const p = typeof f === 'object' ? f.path : f;
    const t = findTabByPath(p);
    if (!t) continue;
    if (t.kind === 'text' && t.dirty) continue; // 保留未保存的编辑
    await reloadTabFromDisk(t);
  }
  for (const f of info.removed || []) {
    const p = typeof f === 'object' ? f.path : f;
    const t = findTabByPath(p);
    if (t) closeTab(t.id);
  }
}

function renderTabs() {
  const bar = document.getElementById('tabbar');
  if (!bar) return;
  bar.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '');
    const img = document.createElement('img');
    img.src = getFileIcon(getFileType({ name: t.name, type: 'file' }));
    const span = document.createElement('span');
    span.textContent = t.name;
    span.title = t.path || t.name;
    if (t.dirty) span.textContent += ' ●';
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.title = '关闭';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeTab(t.id);
    });
    el.appendChild(img);
    el.appendChild(span);
    el.appendChild(btn);
    el.addEventListener('click', () => activateTabById(t.id));
    el.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        closeTab(t.id);
      }
    });
    bar.appendChild(el);
  }
  bar.scrollLeft = bar.scrollWidth;
}

function activateTabById(id) {
  const t = tabs.find((x) => x.id === id);
  if (t) activateTab(t);
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  const wasActive = tab.id === activeTabId;
  tabs.splice(idx, 1);
  if (tab.model) {
    try {
      tab.model.dispose();
    } catch {
      /* ignore */
    }
  }
  if (wasActive) {
    const next = tabs[Math.min(idx, tabs.length - 1)] || null;
    if (next) {
      activateTab(next);
    } else {
      activeTabId = null;
      editor.setModel(null);
      if (editor.layout) editor.layout();
      showEmptyState();
      if (lsp && lsp.initialized && lsp.lastDocUri) {
        try {
          lsp.connection.sendNotification(proto.DidCloseTextDocumentNotification.type, {
            textDocument: { uri: lsp.lastDocUri },
          });
        } catch {
          /* ignore */
        }
        lsp.lastDocUri = null;
      }
      renderTabs();
      updateFileLabel();
    }
  } else {
    renderTabs();
  }
}

async function startEditor() {
  window.__cppeditor.stage = 'monaco-loaded';

  editor = monaco.editor.create(document.getElementById('editor'), {
    theme: 'vs-dark',
    fontSize: 14,
    fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
    automaticLayout: true,
    tabSize: 4,
    insertSpaces: true,
    // 自动缩进
    autoIndent: 'full',
    // 括号补全
    autoClosingBrackets: 'languageDefined',
    autoClosingQuotes: 'languageDefined',
    formatOnType: true,
    bracketPairColorization: { enabled: true },
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    roundedSelection: true,
    renderWhitespace: 'none',
    quickSuggestions: { other: true, comments: false, strings: true },
    suggest: { showWords: false, showSnippets: true, preview: true },
    snippetSuggestions: 'inline',
    hover: { enabled: true },
    fixedOverflowWidgets: true,
  });

  editor.onDidChangeModelContent(() => {
    const t = activeTab();
    if (t && t.kind === 'text' && t.model) {
      const isDirty = t.model.getValue() !== (t.savedContent !== undefined ? t.savedContent : '');
      if (isDirty !== t.dirty) {
        t.dirty = isDirty;
        renderTabs();
      }
    }
    scheduleChange();
  });
  editor.onDidChangeCursorPosition((e) => updateCursor(e.position));
  updateCursor({ lineNumber: 1, column: 1 });

  // LSP 驱动的代码补全
  monaco.languages.registerCompletionItemProvider('cpp', {
    triggerCharacters: ['.', '>', ':', '<', '"', '/', '*', '#', ' '],
    provideCompletionItems(model, position, context) {
      return provideCompletion(model, position, context);
    },
  });

  // LSP 驱动的悬停提示
  monaco.languages.registerHoverProvider('cpp', {
    provideHover(model, position) {
      return provideHover(model, position);
    },
  });

  // 手动重连语言服务器
  editor.addAction({
    id: 'cppeditor.reconnect',
    label: '重启语言服务器 (LSP)',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyR],
    run: () => {
      reconnectAttempts = 0;
      bootstrap();
    },
  });

  setDiagCounts(0, 0);
  setLspState('connecting', '正在连接 clangd...');

  // 默认不显示任何标签页：隐藏编辑器区域（有待打开文件时会由 activateTab 重新显示）
  showEmptyState();

  // 等待项目目录信息就绪（决定左侧显示「打开文件夹」还是项目树）。
  // 每次启动默认不自动打开任何标签页：不恢复上次文件，也不新建未命名页。
  await ensureProjectLoaded();

  // 编辑器就绪前用户已点击文件树 / 关联文件已请求打开：补开该文件
  if (pendingOpenPath) {
    const p = pendingOpenPath;
    const o = pendingOpenOpts;
    pendingOpenPath = null;
    pendingOpenOpts = null;
    await openFileTab(p, o);
  }

  window.__cppeditor.stage = 'editor-ready';
  if (activeTab()) editor.focus();
  bootstrap();
}

function initHeader(){
  document.getElementById('minimize-btn').addEventListener('click', () => {
    window.editorAPI.minimizeWindow();
  })
  document.getElementById('maximize-btn').addEventListener('click', () => {
    window.editorAPI.maximizeWindow();
  })
  document.getElementById('unmaximize-btn').addEventListener('click', () => {
    window.editorAPI.unmaximizeWindow();
  })
  document.getElementById('close-btn').addEventListener('click', () => {
    window.editorAPI.closeWindow();
  })
  window.editorAPI.onMaximizedWindow(() => {
    document.getElementById('maximize-btn').style.display = 'none';
    document.getElementById('unmaximize-btn').style.display = 'flex';
  })
  window.editorAPI.onUnmaximizedWindow(() => {
    document.getElementById('maximize-btn').style.display = 'flex';
    document.getElementById('unmaximize-btn').style.display = 'none';
  })

  document.getElementById('run-btn').addEventListener('click', async () => {
    const t = activeTab();
    if (!t || t.kind !== 'text' || !t.model) {
      showSaveStatus('没有可运行的源文件', true);
      return;
    }
    // 未绑定磁盘路径的文档先保存（取消保存则中止）
    if (!t.path) {
      await saveFile();
      if (!t.path) return;
    }
    const ext = '.' + getFileExtension(t.path).toLowerCase();
    if (ext !== '.c' && ext !== '.cpp') {
      showSaveStatus('仅支持运行 .c / .cpp 文件', true);
      return;
    }
    // 有未保存修改时先落盘，保证编译的是最新内容
    if (t.dirty) await saveFile();

    showSaveStatus('正在编译 ' + t.name + ' ...');
    let result;
    try {
      result = await window.editorAPI.runFile(t.path);
    } catch (err) {
      showSaveStatus('运行失败: ' + err.message, true);
      return;
    }
    if (result && result.ok) {
      showSaveStatus('已启动: ' + basename(result.exePath || t.path));
    } else {
      const msg = (result && result.message) || '编译失败';
      console.error(msg);
      const firstLine = msg.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '编译失败';
      showSaveStatus(firstLine.slice(0, 120), true);
    }
  })

  document.getElementById('setting-btn').addEventListener('click', () => {
    window.editorAPI.openSettingWindow();
  })
}

// ---------------------------------------------------------------------------
// 7. 启动
// ---------------------------------------------------------------------------
function init() {
  if (!window.editorAPI) {
    setLspState('error', 'preload 脚本未加载，无法访问 IPC 接口');
    return;
  }

  window.editorAPI.onStatus(handleServerStatus);
  window.editorAPI.onLog((line) => {
    if (line) log(line);
  });

  initHeader();

  ensureProjectLoaded();

  // 扩展名关联打开的文件（启动参数 / 第二个实例转发）：无论是否属于项目、
  // 是否已设置项目，都直接以标签页打开。
  window.editorAPI.onOpenExternalFile((filePath) => {
    if (filePath) openFileTab(filePath);
  });

  // 项目目录文件增删：通知 clangd 重新索引（compile_commands.json 已在主进程重建）
  window.editorAPI.onProjectChanged((info) => {
    updateFileTree(info);
    refreshTabsForChanges(info);
    if (!lsp || !lsp.initialized || !info) return;
    const changes = [];
    for (const f of info.added || []) {
      const p = typeof f === 'object' ? f.path : f;
      changes.push({ uri: 'file:///' + p.replace(/\\/g, '/'), type: 1 });
    }
    for (const f of info.removed || []) {
      const p = typeof f === 'object' ? f.path : f;
      changes.push({ uri: 'file:///' + p.replace(/\\/g, '/'), type: 3 });
    }
    if (changes.length) {
      lsp.connection.sendNotification('workspace/didChangeWatchedFiles', {
        changes,
      });
    }
    // clangd 收到 watcher 事件后不会主动重新诊断已打开的文档，
    // 这里再对当前文档发一次 didChange，强制其重新解析并立即更新诊断
    scheduleChange();
  });

  // Ctrl+S / Cmd+S 保存文件
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 's') {
      e.preventDefault();
      saveFile();
    }
    // Ctrl+W 关闭当前标签页
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      const t = activeTab();
      if (t) closeTab(t.id);
    }
  });

  window.addEventListener('error', (e) => {
    console.error('[renderer] 未捕获错误:', e.message);
    setLspState('error', '渲染进程错误: ' + e.message);
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[renderer] 未处理的 Promise 拒绝:', e.reason);
  });

  window.addEventListener('beforeunload', () => {
    shutdown = true;
    try {
      window.editorAPI.stop();
    } catch {
      /* ignore */
    }
  });

  // 通过 monaco 的 AMD 加载器加载编辑器核心
  require.config({ paths: { vs: 'editor://app/vs' } });
  require(['vs/editor/editor.main'], () => startEditor());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
