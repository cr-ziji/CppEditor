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

// 将 LSP 返回的 file:// URI（clangd 在 Windows 上可能带 %3A / 小写盘符）
// 还原为磁盘路径（Windows 下使用反斜杠，便于 readFile / findTabByPath）。
function pathFromLspUri(uri) {
  if (!uri || typeof uri !== 'string') return null;
  let s = uri;
  try {
    s = decodeURIComponent(s);
  } catch { /* ignore */ }
  if (s.indexOf('file://') === 0) s = s.slice('file://'.length);
  s = s.replace(/^\/+/, '');
  if (IS_WIN) s = s.replace(/\//g, '\\');
  return s || null;
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

// 底部编译输出面板：展示 g++ 编译的警告 / 错误（kind: 'warning' | 'error'）
function showBuildOutput(kind, text) {
  const panel = document.getElementById('build-output');
  if (!panel) return;
  panel.classList.remove('error', 'warning');
  panel.classList.add(kind === 'error' ? 'error' : 'warning');
  const title = panel.querySelector('.build-title');
  if (title) title.textContent = kind === 'error' ? '编译错误' : '编译警告';
  const body = panel.querySelector('.build-body');
  if (body) body.textContent = text;
  panel.style.display = 'flex';
}

function hideBuildOutput() {
  const panel = document.getElementById('build-output');
  if (panel) panel.style.display = 'none';
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
        // 支持 clangd 的语义 token（全量/增量/范围请求，relative 编码）
        semanticTokens: {
          requests: { full: { delta: true }, range: true },
          formats: ['relative'],
        },
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

  // 若 clangd 支持语义 token，则注册 Monaco 语义高亮提供者
  if (serverCapabilities.semanticTokensProvider) {
    registerSemanticHighlighting();
  }
  // 强制 Monaco 重新拉取语义 token：注册提供者或 clangd 重连后，已打开文件的
  // 旧 token 需要刷新（无副作用，无 clangd 语义能力时也安全）
  refreshSemanticTokens();

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

// 依据当前活动模型上已发布的 clangd 诊断，重新刷新底部错误/警告计数。
// 关闭/切换文件后 clangd 不一定会重新推送诊断，直接统计现存 markers，
// 避免旧文件的计数残留。
function refreshDiagFromActiveModel() {
  const model = editor && editor.getModel();
  if (!model) {
    setDiagCounts(0, 0);
    window.__cppeditor.diagnostics = { errors: 0, warnings: 0, total: 0 };
    return;
  }
  let errors = 0;
  let warnings = 0;
  let total = 0;
  try {
    const markers = monaco.editor.getModelMarkers({ resource: model.uri, owner: 'clangd' });
    total = markers.length;
    for (const m of markers) {
      if (m.severity === monaco.MarkerSeverity.Error) errors += 1;
      else if (m.severity === monaco.MarkerSeverity.Warning) warnings += 1;
    }
  } catch {
    /* ignore */
  }
  setDiagCounts(errors, warnings);
  window.__cppeditor.diagnostics = { errors, warnings, total };
}

function handleDiagnostics(params) {
  const doc = currentTextDoc();
  if (!params || !doc || !doc.uri || normalizeUri(params.uri) !== normalizeUri(doc.uri) || !isCppLang(doc.languageId)) return;
  const model = editor && editor.getModel();
  if (!model) return;

  // 工具链内部文件（libstdc++ 等）在独立打开时因非自包含会产生伪报错，
  // 不展示这些诊断。.tcc/.tpp/.ipp 的语言归属已在 resources/mingw/.clangd
  // 中用 -x c++-header 配置，避免 clangd 的 "expected exactly one compiler job"。
  const docPath = pathFromLspUri(doc.uri);
  if (docPath && isGccFile(docPath)) {
    monaco.editor.setModelMarkers(model, 'clangd', []);
    setDiagCounts(0, 0);
    window.__cppeditor.diagnostics = { errors: 0, warnings: 0, total: 0 };
    return;
  }

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

// 跳转到指定位置的符号定义（Ctrl+左键）。
// 同一文件内直接定位；其他文件（无论是否已打开）通过标签页打开并定位。
async function jumpToDefinition(position) {
  const doc = currentTextDoc();
  if (!isReady() || !doc || !doc.uri || !isCppLang(doc.languageId)) return;
  syncNow();
  let result;
  try {
    result = await lsp.connection.sendRequest(proto.DefinitionRequest.type, {
      textDocument: { uri: doc.uri },
      position: toLspPosition(position),
    });
  } catch (err) {
    console.warn('[LSP] 定义跳转请求失败:', err);
    return;
  }
  const items = Array.isArray(result) ? result : result ? [result] : [];
  const loc = items[0];
  if (!loc) return;
  // 兼容 Location（uri/range）与 LocationLink（targetUri/targetRange）
  const targetUri = loc.targetUri || loc.uri;
  const range = loc.targetRange || loc.range || loc.targetSelectionRange;
  if (!targetUri) return;
  const targetPath = pathFromLspUri(targetUri);
  if (!targetPath) return;

  const reveal = () => {
    if (!range) return;
    if (!editor || !editor.getModel()) return;
    const r = toMonacoRange(range);
    editor.setPosition({ lineNumber: r.startLineNumber, column: r.startColumn });
    editor.revealRangeInCenter(r, monaco.editor.ScrollType.Smooth);
  };

  const t = activeTab();
  if (t && t.path && pathEquals(targetPath, t.path)) {
    // 定义就在当前文件：直接定位
    reveal();
    return;
  }
  const existing = findTabByPath(targetPath);
  if (existing && existing.kind === 'text' && existing.model) {
    activateTab(existing);
    reveal();
    return;
  }
  await openFileTab(targetPath);
  reveal();
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
  if (typeMap[ext]) return typeMap[ext];
  // 无扩展名的文件：GCC 工具链内的 C++ 标准库头文件（如 iostream、vector）
  // 无扩展名，视为 h（头文件）图标；其余保持 unknown
  if (!ext && isGccFile(node.path)) return 'h';
  return 'unknown';
}

// 设置文件/文件夹图标：同时记录深/浅色版本路径，主题切换时由 applyThemeToIcons 统一换图
function setFileIcon(img, iconType) {
  const name = iconType || 'unknown';
  img.dataset.darkSrc = 'editor://app/resources/icons/' + name + '.svg';
  img.dataset.lightSrc = 'editor://app/resources/icons/light/' + name + '.svg';
  img.src = appTheme === 'light' ? img.dataset.lightSrc : img.dataset.darkSrc;
}

// 标签页图标：先按扩展名，无扩展名/未知类型时回退到 model 的语言
function tabIconType(t) {
  const byName = getFileType({ name: t.name, type: 'file', path: t.path });
  if (byName !== 'unknown') return byName;
  const lang = t.model ? t.model.getLanguageId() : null;
  if (lang === 'cpp' || lang === 'objective-c') return 'cpp';
  if (lang === 'c') return 'c';
  if (lang === 'plaintext' || lang === 'markdown') return 'txt';
  return 'unknown';
}

function expandFolder(node){
  const ch = childrenContainerOf(node);
  if (!ch) return;
  if (node.classList.contains('expanded')){
    node.classList.remove('expanded');
    ch.style.display = 'none';
  }
  else{
    node.classList.add('expanded');
    ch.style.display = 'block';
  }
}

function rendererFileTree(paths, faNode) {
  paths.forEach(path => {
    const node = document.createElement('div');
    if (path.type === 'directory'){
      const nodeExpand = document.createElement('div');
      nodeExpand.classList.add('expand');
      nodeExpand.addEventListener('click', (e) => { e.stopPropagation(); expandFolder(node); });
      node.appendChild(nodeExpand);
      node.classList.add('folder');
      node.addEventListener('click', (e) => {
        // 阻止冒泡到父级文件夹（否则会误触发父级选中）
        e.stopPropagation();
        if (treeMenuVisible()) { hideTreeMenu(); return; }
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleTreeSelection(path); return; }
        // 仅点三角展开/折叠，点文件夹本身只选中
        setTreeSelection([path.path]);
      });
    }
    else {
      node.classList.add('file');
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        if (treeMenuVisible()) { hideTreeMenu(); return; }
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleTreeSelection(path); return; }
        setTreeSelection([path.path]);
        openFileTab(path.path);
      });
    }
    node.dataset.path = path.path;
    node.dataset.type = path.type;
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTreeMenu(e, path);
    });
    const nodeImg = document.createElement('img');
    setFileIcon(nodeImg, getFileType(path));
    const nodeText = document.createElement('span');
    nodeText.innerText = path.name;
    node.appendChild(nodeImg);
    node.appendChild(nodeText);
    faNode.appendChild(node);
    if (path.type === 'directory') {
      const nodeChildren = document.createElement('div');
      nodeChildren.classList.add('children');
      nodeChildren.style.display = 'none';
      rendererFileTree(path.children, nodeChildren);
      node.insertAdjacentElement('afterend', nodeChildren);
    }
    path.node = node;
  })
}

// ---------------------------------------------------------------------------
// 5a2. 文件树多选 / 右键菜单 / 剪贴板操作
//     Ctrl+单击多选文件与文件夹；右键弹出菜单；Ctrl+C/V/X 与右键菜单等效。
//     剪贴板文件走主进程 CF_HDROP（FileNameW），与 Windows 资源管理器互通。
// ---------------------------------------------------------------------------
const selectedTreePaths = new Set();
let fileTreeFocused = false;
let treeInputOnOk = null;

function normalizeTreeKey(p) {
  return (p || '').replace(/\\/g, '/');
}

function setTreeSelection(paths) {
  selectedTreePaths.clear();
  for (const p of paths) selectedTreePaths.add(normalizeTreeKey(p));
  applyTreeSelection();
}

function clearTreeSelection() {
  setTreeSelection([]);
}

function toggleTreeSelection(treeNode) {
  const key = normalizeTreeKey(treeNode && treeNode.path);
  if (!key) return;
  if (selectedTreePaths.has(key)) selectedTreePaths.delete(key);
  else selectedTreePaths.add(key);
  applyTreeSelection();
}

function applyTreeSelection() {
  if (!projectDom) return;
  // children 是 projectDom 的兄弟节点，需从父容器整树查找（querySelectorAll 含 projectDom 自身）
  const container = projectDom.parentElement;
  if (!container) return;
  const all = container.querySelectorAll('.file, .folder');
  for (const el of all) {
    const p = el.dataset && el.dataset.path;
    el.classList.toggle('selected', !!p && selectedTreePaths.has(normalizeTreeKey(p)));
  }
}

// 右键菜单当前是否可见（点击树节点时若可见则只关闭菜单，不触发选中）
function treeMenuVisible() {
  const m = document.getElementById('tree-menu');
  return !!(m && m.style.display !== 'none');
}

// 返回某文件夹节点的 children 容器（children 是 folder 的兄弟节点）
function childrenContainerOf(el) {
  if (!el) return null;
  const sib = el.nextElementSibling;
  return sib && sib.classList && sib.classList.contains('children') ? sib : null;
}

function treeNodeIsDirectory(p) {
  if (!p) return false;
  const key = normalizeTreeKey(p);
  if (key === normalizeTreeKey(projectDir || '')) return true;
  const n = findTreeNode(projectFileTree, key);
  return !!n && n.type === 'directory';
}

// 粘贴目标目录：优先选中的文件夹；其次选中文件的父目录；最后项目根
function pasteTargetDir() {
  const dirs = [...selectedTreePaths].filter((p) => treeNodeIsDirectory(p));
  if (dirs.length) return dirs[0];
  for (const p of selectedTreePaths) {
    const i = p.lastIndexOf('/');
    if (i > 0) return p.slice(0, i);
  }
  return projectDir ? projectDir.replace(/\\/g, '/') : null;
}

function treeRootContainer() {
  return projectDom ? childrenContainerOf(projectDom) : null;
}

// 操作后立即同步树（watcher 轮询 1s 后会再次校正，幂等安全）
function treeAddPath(p, isDir) {
  if (!projectFileTree || !projectDom) return;
  const c = treeRootContainer();
  if (c) insertFilePath(projectDir, projectFileTree, p, c, !!isDir);
}

function treeRemovePath(p) {
  if (!projectFileTree || !projectDom) return;
  const c = treeRootContainer();
  if (c) removeFilePath(projectFileTree, p, c);
}

// 可执行剪切/删除/复制/重命名的操作列表（排除项目根自身）
function treeOpList() {
  const rootKey = normalizeTreeKey(projectDir || '');
  return [...selectedTreePaths].filter((p) => normalizeTreeKey(p) !== rootKey);
}

async function copySelected() {
  const list = [...selectedTreePaths];
  if (!list.length) return;
  const r = await window.editorAPI.treeCopy(list);
  if (r && r.ok) showSaveStatus('已复制 ' + r.count + ' 项');
  else showSaveStatus('复制失败: ' + ((r && r.message) || ''), true);
}

async function cutSelected() {
  const list = treeOpList();
  if (!list.length) return;
  const r = await window.editorAPI.treeCut(list);
  if (r && r.ok) showSaveStatus('已剪切 ' + r.count + ' 项');
  else showSaveStatus('剪切失败: ' + ((r && r.message) || ''), true);
}

async function pasteToDir(dir) {
  if (!dir) return;
  const r = await window.editorAPI.treePaste(dir);
  if (!r || !r.ok) {
    showSaveStatus('粘贴失败: ' + ((r && r.message) || ''), true);
    return;
  }
  let n = 0;
  for (const res of r.results || []) {
    if (!res.ok) continue;
    n++;
    if (res.dest) treeAddPath(res.dest, !!res.isDirectory);
    // 剪切（移动）才移除源并关闭其标签；复制保留源
    if (res.moved && res.src) {
      treeRemovePath(res.src);
      if (res.src !== res.dest) {
        const tab = findTabByPath(res.src);
        if (tab) closeTab(tab.id);
      }
    }
  }
  showSaveStatus('已粘贴 ' + n + ' 项');
}

async function deleteSelectedTreePaths() {
  const list = treeOpList();
  if (!list.length) return;
  const ok = window.confirm('确定删除选中的 ' + list.length + ' 项吗？此操作将移入回收站。');
  if (!ok) return;
  const r = await window.editorAPI.treeDelete(list);
  if (!r) return;
  let okCount = 0;
  for (const res of r.results || []) {
    if (!res.ok) continue;
    okCount++;
    treeRemovePath(res.path);
    const tab = findTabByPath(res.path);
    if (tab) closeTab(tab.id);
  }
  if (r.ok) showSaveStatus('已删除 ' + okCount + ' 项');
  else showSaveStatus('部分项目删除失败', true);
  clearTreeSelection();
}

function askRename(p) {
  const name = basename(p);
  showTreeInput('重命名', name, async (newName) => {
    newName = (newName || '').trim();
    if (!newName || newName === name) return;
    if (/[\\/:*?"<>|]/.test(newName)) { showSaveStatus('文件名包含非法字符', true); return; }
    const r = await window.editorAPI.treeRename(p, newName);
    if (!r || !r.ok) {
      showSaveStatus('重命名失败: ' + ((r && r.message) || ''), true);
      return;
    }
    treeRemovePath(r.oldPath);
    treeAddPath(r.newPath, !!r.isDirectory);
    const tab = findTabByPath(r.oldPath);
    if (tab) closeTab(tab.id);
    showSaveStatus('已重命名');
  });
}

// 模板：templates.cpp / templates.c / templates.header（设置窗口可改）
function treeTemplateForExt(ext) {
  const t = (appSettings.templates) || {};
  if (ext === 'c') return t.c || '';
  if (ext === 'cpp') return t.cpp || '';
  if (ext === 'h' || ext === 'hpp' || ext === 'hh') return t.header || '';
  return '';
}

// 应用模板：$FILE_NAME$ → 不含扩展名的文件名；$cursor$ 记录位置后移除
function applyTreeTemplate(ext, fullName) {
  const dot = fullName.lastIndexOf('.');
  const base = dot > 0 ? fullName.slice(0, dot) : fullName;
  let tpl = treeTemplateForExt(ext);
  if (!tpl) return { content: '', cursorOffset: -1 };
  tpl = tpl.replace(/\$FILE_NAME\$/g, base);
  let cursorOffset = -1;
  if (tpl.indexOf('$cursor$') !== -1) {
    const CURSOR_PH = '\u0001CURSOR\u0001';
    tpl = tpl.replace('$cursor$', CURSOR_PH);
    cursorOffset = tpl.indexOf(CURSOR_PH);
    tpl = tpl.replace(CURSOR_PH, '');
  }
  return { content: tpl, cursorOffset };
}

async function createTreeFile(dir, name) {
  const dot = name.lastIndexOf('.');
  const ext = (dot > 0 ? name.slice(dot + 1) : '').toLowerCase();
  const { content, cursorOffset } = applyTreeTemplate(ext, name);
  const r = await window.editorAPI.treeCreateFile(dir, name, content);
  if (!r || !r.ok) {
    showSaveStatus('新建失败: ' + ((r && r.message) || ''), true);
    return;
  }
  treeAddPath(r.path, false);
  await openFileTab(r.path);
  if (cursorOffset >= 0 && editor) {
    const t = activeTab();
    if (t && t.model) {
      try {
        const pos = t.model.getPositionAt(cursorOffset);
        editor.setPosition(pos);
        editor.revealPositionInCenter(pos);
        editor.focus();
      } catch {
        /* ignore */
      }
    }
  }
}

function askCreateFile(dir, defaultName) {
  showTreeInput('新建文件', defaultName || '', (name) => {
    name = (name || '').trim();
    if (!name) return;
    if (/[\\/:*?"<>|]/.test(name)) { showSaveStatus('文件名包含非法字符', true); return; }
    createTreeFile(dir, name);
  });
}

async function createTreeDir(dir, name) {
  const r = await window.editorAPI.treeCreateDir(dir, name);
  if (!r || !r.ok) {
    showSaveStatus('新建失败: ' + ((r && r.message) || ''), true);
    return;
  }
  treeAddPath(r.path, true);
  showSaveStatus('已新建文件夹');
}

function askCreateDir(dir) {
  showTreeInput('新建文件夹', '新文件夹', (name) => {
    name = (name || '').trim();
    if (!name) return;
    if (/[\\/:*?"<>|]/.test(name)) { showSaveStatus('文件夹名包含非法字符', true); return; }
    createTreeDir(dir, name);
  });
}

function openTreeMenu(e, treeNode) {
  if (!selectedTreePaths.has(normalizeTreeKey(treeNode && treeNode.path))) {
    setTreeSelection([treeNode.path]);
  }
  const menu = document.getElementById('tree-menu');
  if (!menu) return;
  menu.innerHTML = '';
  const selAll = [...selectedTreePaths];
  // 项目根自身不可剪切/删除/重命名；复制与「打开于-资源管理器」可用于项目根
  const opList = treeOpList();
  const anyFolder = selAll.some((p) => treeNodeIsDirectory(p));
  const single = opList.length === 1;
  const target = pasteTargetDir();

  const item = (label, fn, disabled) => {
    const d = document.createElement('div');
    d.className = 'tree-menu-item' + (disabled ? ' disabled' : '');
    d.textContent = label;
    if (!disabled) d.addEventListener('click', (ev) => { ev.stopPropagation(); hideTreeMenu(); fn(); });
    return d;
  };
  const sep = () => {
    const d = document.createElement('div');
    d.className = 'tree-menu-sep';
    return d;
  };

  // 新建子菜单（第一位）：带文件图标；仅当存在目标目录时显示
  if (target) {
    const subWrap = document.createElement('div');
    subWrap.className = 'tree-menu-item has-submenu';
    subWrap.textContent = '新建';
    const sub = document.createElement('div');
    sub.className = 'tree-menu-sub';
    const mkNew = (label, name, iconType, isDir) => {
      const d = document.createElement('div');
      d.className = 'tree-menu-item';
      const img = document.createElement('img');
      setFileIcon(img, iconType || 'unknown');
      const sp = document.createElement('span');
      sp.textContent = label;
      d.appendChild(img);
      d.appendChild(sp);
      d.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideTreeMenu();
        if (isDir) askCreateDir(target);
        else askCreateFile(target, name);
      });
      sub.appendChild(d);
    };
    mkNew('文件夹', '', 'folder', true);
    mkNew('.c 文件', 'new.c', 'c');
    mkNew('.cpp 文件', 'new.cpp', 'cpp');
    mkNew('.h 文件', 'new.h', 'h');
    mkNew('.in 文件', 'new.in', 'txt');
    mkNew('.out 文件', 'new.out', 'txt');
    mkNew('.ans 文件', 'new.ans', 'txt');
    mkNew('文件', 'new', 'unknown');
    subWrap.appendChild(sub);
    menu.appendChild(subWrap);
    menu.appendChild(sep());
  }

  menu.appendChild(item('粘贴', () => pasteToDir(target), !target));
  menu.appendChild(item('复制', copySelected, selAll.length === 0));
  menu.appendChild(item('剪切', cutSelected, opList.length === 0));
  menu.appendChild(sep());
  menu.appendChild(item('重命名', () => { if (single) askRename(opList[0]); }, !single));
  menu.appendChild(item('删除', deleteSelectedTreePaths, opList.length === 0));

  // 打开于（子菜单，可扩展其他打开方式）
  if (selAll.length) {
    const openWrap = document.createElement('div');
    openWrap.className = 'tree-menu-item has-submenu';
    openWrap.textContent = '打开于';
    const openSub = document.createElement('div');
    openSub.className = 'tree-menu-sub';
    const mkOpen = (label, iconType, fn) => {
      const d = document.createElement('div');
      d.className = 'tree-menu-item';
      const img = document.createElement('img');
      setFileIcon(img, iconType);
      const sp = document.createElement('span');
      sp.textContent = label;
      d.appendChild(img);
      d.appendChild(sp);
      d.addEventListener('click', (ev) => { ev.stopPropagation(); hideTreeMenu(); fn(); });
      openSub.appendChild(d);
    };
    mkOpen('资源管理器', 'explorer', () => {
      const p = single ? (opList[0] || selAll[0]) : (anyFolder ? selAll.find((x) => treeNodeIsDirectory(x)) : selAll[0]);
      if (p) window.editorAPI.treeReveal(p);
    });
    openWrap.appendChild(openSub);
    menu.appendChild(openWrap);
  }

  menu.style.display = 'block';
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let lx = e.clientX;
  let ly = e.clientY;
  if (lx + mw > window.innerWidth - 8) lx = Math.max(8, window.innerWidth - mw - 8);
  if (ly + mh > window.innerHeight - 8) ly = Math.max(8, window.innerHeight - mh - 8);
  menu.style.left = lx + 'px';
  menu.style.top = ly + 'px';
}

function hideTreeMenu() {
  const menu = document.getElementById('tree-menu');
  if (menu) menu.style.display = 'none';
}

// 新建 / 重命名共用的输入弹层
function showTreeInput(title, initial, onOk) {
  const layer = document.getElementById('tree-input');
  if (!layer) return;
  document.getElementById('tree-input-title').textContent = title;
  const field = document.getElementById('tree-input-field');
  field.value = initial || '';
  treeInputOnOk = onOk;
  layer.style.display = 'flex';
  field.focus();
  field.select();
}

function hideTreeInput() {
  const layer = document.getElementById('tree-input');
  if (layer) layer.style.display = 'none';
  treeInputOnOk = null;
}

function commitTreeInput() {
  const fn = treeInputOnOk;
  treeInputOnOk = null;
  const value = document.getElementById('tree-input-field').value;
  hideTreeInput();
  if (fn) fn(value);
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
  setFileIcon(img, 'folder');
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
  setFileIcon(img, 'folder');
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
  clearTreeSelection();
  hideTreeMenu();
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
  projectExpand.classList.add('expand');
  projectExpand.addEventListener('click', (e) => { e.stopPropagation(); expandFolder(projectDom); })
  projectDom.appendChild(projectExpand);
  projectDom.classList.add('folder');
  projectDom.classList.add('expanded');
  projectDom.dataset.path = projectDir;
  projectDom.dataset.type = 'directory';
  projectDom.addEventListener('click', (e) => {
    e.stopPropagation();
    if (treeMenuVisible()) { hideTreeMenu(); return; }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleTreeSelection({ path: projectDir, type: 'directory' });
      return;
    }
    // 仅点三角展开/折叠，点项目根本身只选中
    setTreeSelection([projectDir]);
  });
  projectDom.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openTreeMenu(e, { path: projectDir, type: 'directory' });
  });
  const projectImg = document.createElement('img');
  setFileIcon(projectImg, 'folder');
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
  if (treeEl) {
    treeEl.appendChild(projectDom);
    projectDom.insertAdjacentElement('afterend', projectChildren);
  }
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
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (treeMenuVisible()) { hideTreeMenu(); return; }
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleTreeSelection(child); return; }
          setTreeSelection([child.path]);
          openFileTab(child.path);
        });
      } else {
        el.classList.add('folder');
        const expand = document.createElement('div');
        expand.classList.add('expand');
        expand.addEventListener('click', (e) => { e.stopPropagation(); expandFolder(el); });
        el.appendChild(expand);
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (treeMenuVisible()) { hideTreeMenu(); return; }
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleTreeSelection(child); return; }
          // 仅点三角展开/折叠，点文件夹本身只选中
          setTreeSelection([child.path]);
        });
      }
      el.dataset.path = child.path;
      el.dataset.type = isFile ? 'file' : 'directory';
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTreeMenu(e, child);
      });
      const img = document.createElement('img');
      setFileIcon(img, isFile ? getFileType(child) : 'folder');
      const text = document.createElement('span');
      text.innerText = child.name;
      el.appendChild(img);
      el.appendChild(text);
      child.node = el;
      insertChildDomSorted(levelContainer, el, child.name, !isFile);
      if (!isFile) {
        // children 是 folder 的兄弟节点，紧跟其后
        const childrenEl = document.createElement('div');
        childrenEl.classList.add('children');
        childrenEl.style.display = 'none';
        el.insertAdjacentElement('afterend', childrenEl);
      }
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
        el.dataset.type = 'directory';
        const expand = document.createElement('div');
        expand.classList.add('expand');
        expand.addEventListener('click', (e) => { e.stopPropagation(); expandFolder(el); });
        el.insertBefore(expand, el.firstChild);
        const childrenEl = document.createElement('div');
        childrenEl.classList.add('children');
        childrenEl.style.display = 'none';
        el.insertAdjacentElement('afterend', childrenEl);
      }
    }

    if (child.type === 'directory') {
      levelNodes = child.children;
      levelContainer = child.node ? childrenContainerOf(child.node) : null;
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
        // children 是 n.node 的兄弟节点，需一并移除
        const cc = childrenContainerOf(n.node);
        if (n.node && n.node.parentNode) n.node.parentNode.removeChild(n.node);
        if (cc && cc.parentNode) cc.parentNode.removeChild(cc);
        return true;
      }
      if (n.type === 'directory') {
        const childContainer = n.node ? childrenContainerOf(n.node) : null;
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
  const rootContainer = treeRootContainer();
  if (!rootContainer) return;
  for (const f of info.added || []) {
    const p = typeof f === 'object' ? f.path : f;
    if (shouldIgnoreTreePath(p)) continue;
    insertFilePath(projectDir, projectFileTree, p, rootContainer, typeof f === 'object' ? !!f.isDirectory : false);
  }
  for (const f of info.removed || []) {
    const p = typeof f === 'object' ? f.path : f;
    if (shouldIgnoreTreePath(p)) continue;
    selectedTreePaths.delete(normalizeTreeKey(p));
    removeFilePath(projectFileTree, p, rootContainer);
  }
  applyTreeSelection();
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

// GCC 工具链（mingw 资源目录下 lib\gcc\...）内的文件。
// C++ 标准库头文件（iostream、vector 等）无扩展名，仅对这类文件做内容嗅探/图标推断。
function isGccFile(p) {
  return /[\\/]lib[\\/]gcc[\\/]/i.test(p || '');
}

function detectCppContent(p, content) {
  if (!content) return /[\\/]include[\\/]c\+\+[\\/]/i.test(p || '');
  const head = String(content).slice(0, 2000);
  // emacs 模式行，如 "// Standard iostream objects -*- C++ -*-"
  if (/-\*- *(c\+\+|c) *-\*-/i.test(head)) return true;
  if (/#\s*include\s+[<"][^\s>"]+[>"]/.test(head)) return true;
  if (/#\s*(pragma\s+once|ifndef|ifdef|define|undef)\b/.test(head)) return true;
  if (/\b(namespace|template|using\s+namespace|std::)\b/.test(head)) return true;
  return false;
}

function languageForPath(p, content) {
  const ext = '.' + getFileExtension(p).toLowerCase();
  const lang = LANG_BY_EXT[ext];
  if (lang) return lang;
  // 无扩展名/未知扩展名：仅对 GCC 工具链内的文件按内容嗅探为 C++
  if (isGccFile(p) && detectCppContent(p, content)) return 'cpp';
  return 'plaintext';
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
      languageForPath(path, file.content),
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
  if (econt) {
    // 非文本标签页会把 #editor 设成 display:none，这里必须还原，
    // 否则该区域塌陷、底部状态栏会顶上去
    econt.style.display = '';
    econt.style.visibility = 'hidden';
  }
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
  refreshDiagFromActiveModel();
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
        languageForPath(tab.path, file.content),
        monaco.Uri.file(tab.path)
      );
    } else if (tab.model.getValue() !== file.content) {
      // 文件在磁盘上更新：若此前按纯文本创建（无扩展名），可重新嗅探升级语言
      const lang = languageForPath(tab.path, file.content);
      if (lang !== 'plaintext' && tab.model.getLanguageId() === 'plaintext') {
        monaco.editor.setModelLanguage(tab.model, lang);
      }
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
    setFileIcon(img, tabIconType(t));
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
    refreshDiagFromActiveModel();
  } else {
    renderTabs();
  }
}

// ---------------------------------------------------------------------------
// 6. 语义高亮（clangd semantic tokens）
//    语法高亮只按关键字/字符串等词法分类；语义高亮由 clangd 按真实编译语义
//    区分类型、函数、变量、成员、宏等，并支持标准库斜体、已弃用删除线等修饰。
// ---------------------------------------------------------------------------
// Monaco 默认语义 token 类型表（名称顺序即索引；主题规则按这些名字匹配上色）
const SEMANTIC_TOKEN_TYPES = [
  'comment', 'keyword', 'string', 'number', 'regexp', 'operator',
  'namespace', 'type', 'struct', 'class', 'interface', 'enum',
  'typeParameter', 'function', 'member', 'macro', 'variable',
  'parameter', 'property', 'enumMember', 'event', 'decorator',
];
const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'readonly', 'static', 'deprecated', 'abstract',
  'async', 'modification', 'documentation', 'defaultLibrary',
];
const SEMANTIC_TYPE_INDEX = {};
SEMANTIC_TOKEN_TYPES.forEach((t, i) => (SEMANTIC_TYPE_INDEX[t] = i));
const SEMANTIC_MOD_INDEX = {};
SEMANTIC_TOKEN_MODIFIERS.forEach((m, i) => (SEMANTIC_MOD_INDEX[m] = i));
// clangd 的 LSP token 类型名 → Monaco 默认类型名（method→member、modifier→keyword 等归一化）
const LSP_SEMANTIC_TYPE = {
  namespace: 'namespace', type: 'type', class: 'class', enum: 'enum',
  interface: 'interface', struct: 'struct', typeParameter: 'typeParameter',
  parameter: 'parameter', variable: 'variable', property: 'property',
  enumMember: 'enumMember', event: 'event', function: 'function',
  method: 'member', macro: 'macro', keyword: 'keyword', modifier: 'keyword',
  comment: 'comment', string: 'string', number: 'number', regexp: 'regexp',
  operator: 'operator', decorator: 'decorator',
};

// ---------------------------------------------------------------------------
// 外观设置：主题、字号、括号行为。由设置窗口保存，主窗口读取并即时应用。
// ---------------------------------------------------------------------------
let appSettings = {};
let appTheme = 'dark';

function clampFontSize(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 8 && n <= 40) return Math.round(n);
  return 14;
}

// 文件树字号：直接对 #filetree 容器设置，所有节点文字/图标（em 单位）随继承缩放。
// 首帧渲染前（脚本加载时）就应用，避免窗口显示后再跳变。
function applyTreeFontSize(v) {
  const treeEl = document.getElementById('filetree');
  if (treeEl) treeEl.style.fontSize = clampFontSize(v) + 'px';
}

// 应用配色主题：Monaco 主题（全局 API，不依赖 editor 实例）+ 应用界面深浅色。
// monaco 尚未加载时只切换界面主题，编辑器创建后再应用 Monaco 主题。
function applyAppTheme(theme) {
  appTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.classList.toggle('theme-light', appTheme === 'light');
  document.body.classList.toggle('theme-light', appTheme === 'light');
  applyThemeToIcons();
  if (typeof monaco !== 'undefined' && monaco.editor) {
    monaco.editor.setTheme(appTheme === 'light' ? 'cppeditor-light' : 'cppeditor-dark');
  }
}

// 依据当前主题切换图标的深色 / 浅色版本（由 data-dark-src / data-light-src 指定）
function applyThemeToIcons() {
  const light = appTheme === 'light';
  document.querySelectorAll('img[data-light-src]').forEach((img) => {
    img.src = light ? img.dataset.lightSrc : img.dataset.darkSrc;
  });
}

// 把保存的外观设置应用到编辑器；editor 未创建时只记录主题，创建后由调用方补全
function applyEditorSettings() {
  const e = appSettings.editor || {};
  applyAppTheme(e.theme);
  const treeEl = document.getElementById('filetree');
  if (treeEl) treeEl.style.fontSize = clampFontSize(e.fileTreeFontSize) + 'px';
  if (!editor) return;
  editor.updateOptions({
    fontSize: clampFontSize(e.fontSize),
    autoClosingBrackets: e.autoClosingBrackets === false ? 'never' : 'languageDefined',
    autoClosingQuotes: e.autoClosingQuotes === false ? 'never' : 'languageDefined',
    bracketPairColorization: { enabled: e.bracketPairColorization !== false },
    matchBrackets: e.matchBrackets === false ? 'never' : 'always',
    autoIndent: e.autoIndent === false ? 'none' : 'full',
  });
}

// VS Code Dark+ / Light+ 风格的语义配色主题（语义 token 的颜色完全由这里的规则决定）
function installSemanticTheme() {
  monaco.editor.defineTheme('cppeditor-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
      { token: 'keyword', foreground: '569CD6' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'regexp', foreground: 'D16969' },
      { token: 'operator', foreground: 'D4D4D4' },
      { token: 'namespace', foreground: '4EC9B0' },
      { token: 'type', foreground: '4EC9B0' },
      { token: 'struct', foreground: '4EC9B0' },
      { token: 'class', foreground: '4EC9B0' },
      { token: 'interface', foreground: '4EC9B0' },
      { token: 'enum', foreground: '4EC9B0' },
      { token: 'typeParameter', foreground: '4EC9B0' },
      { token: 'function', foreground: 'DCDCAA' },
      { token: 'member', foreground: 'DCDCAA' },
      { token: 'macro', foreground: 'C586C0' },
      { token: 'variable', foreground: '9CDCFE' },
      { token: 'parameter', foreground: '9CDCFE' },
      { token: 'property', foreground: 'CE9178' },
      { token: 'enumMember', foreground: 'B5CEA8' },
      { token: 'event', foreground: 'C586C0' },
      { token: 'decorator', foreground: 'D7BA7D' },
      // 已弃用 → 删除线
      { token: 'type.deprecated', fontStyle: 'strikethrough' },
      { token: 'function.deprecated', fontStyle: 'strikethrough' },
      { token: 'member.deprecated', fontStyle: 'strikethrough' },
      { token: 'variable.deprecated', fontStyle: 'strikethrough' },
    ],
    colors: {},
  });

  monaco.editor.defineTheme('cppeditor-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '008000', fontStyle: 'italic' },
      { token: 'keyword', foreground: '0000E0' },
      { token: 'string', foreground: 'B80000' },
      { token: 'number', foreground: 'B25E00' },
      { token: 'regexp', foreground: 'A3157E' },
      { token: 'operator', foreground: '5E35B1' },
      { token: 'namespace', foreground: '0B7285' },
      { token: 'type', foreground: '0B7285' },
      { token: 'struct', foreground: '0B7285' },
      { token: 'class', foreground: '0B7285' },
      { token: 'interface', foreground: '0B7285' },
      { token: 'enum', foreground: '0B7285' },
      { token: 'typeParameter', foreground: '0055AA' },
      { token: 'function', foreground: 'B45309' },
      { token: 'member', foreground: 'B45309' },
      { token: 'macro', foreground: 'C2185B' },
      { token: 'variable', foreground: '0052CC' },
      { token: 'parameter', foreground: '0052CC' },
      { token: 'property', foreground: 'B4004E' },
      { token: 'enumMember', foreground: '008A00' },
      { token: 'event', foreground: 'C2185B' },
      { token: 'decorator', foreground: '7B1FA2' },
      // 常见修饰符组合：确保语义 token 带修饰符时仍命中鲜明颜色，而不是回落 base
      { token: 'variable.readonly', foreground: '0052CC' },
      { token: 'variable.declaration', foreground: '0052CC' },
      { token: 'variable.defaultLibrary', foreground: '0052CC' },
      { token: 'parameter.readonly', foreground: '0052CC' },
      { token: 'parameter.declaration', foreground: '0052CC' },
      { token: 'property.readonly', foreground: 'B4004E' },
      // 已弃用 → 删除线
      { token: 'type.deprecated', fontStyle: 'strikethrough' },
      { token: 'function.deprecated', fontStyle: 'strikethrough' },
      { token: 'member.deprecated', fontStyle: 'strikethrough' },
      { token: 'variable.deprecated', fontStyle: 'strikethrough' },
    ],
    colors: {},
  });

  applyAppTheme(appSettings.editor && appSettings.editor.theme);
}

// 把 clangd 的 LSP 语义 token 数据（按 clangd 的 legend 索引编码）转换成
// 使用我们注册的 Monaco legend 索引的 Uint32Array。
function convertSemanticTokens(lspData) {
  if (!lspData || !lspData.length) return { data: new Uint32Array(0) };
  const legend = serverCapabilities && serverCapabilities.semanticTokensProvider
    ? serverCapabilities.semanticTokensProvider.legend
    : null;
  const lspTypes = (legend && legend.tokenTypes) || [];
  const lspMods = (legend && legend.tokenModifiers) || [];
  const out = new Uint32Array(lspData.length);
  for (let i = 0; i + 4 < lspData.length; i += 5) {
    out[i] = lspData[i];
    out[i + 1] = lspData[i + 1];
    out[i + 2] = lspData[i + 2];
    const lspType = lspTypes[lspData[i + 3]];
    const monoType = SEMANTIC_TYPE_INDEX[LSP_SEMANTIC_TYPE[lspType]];
    out[i + 3] = monoType !== undefined ? monoType : 0;
    let monoMods = 0;
    const lspBits = lspData[i + 4];
    for (let m = 0; lspBits && m < lspMods.length; m++) {
      if (lspBits & (1 << m)) {
        const monoM = SEMANTIC_MOD_INDEX[lspMods[m]];
        if (monoM !== undefined) monoMods |= 1 << monoM;
      }
    }
    out[i + 4] = monoMods;
  }
  return { data: out };
}

const EMPTY_SEMANTIC_TOKENS = { data: new Uint32Array(0) };

// LSP 连接就绪后强制 Monaco 重新请求当前文档的语义 token。
// 不能通过 setModel(null)/setModel(m) 刷新：Monaco 对「编辑器自建」的模型
// 在 detach 时直接 dispose，会导致 setModel(m) 抛出「Model is disposed!」。
// 改为通过 semanticHighlighting 开关切换触发 onDidChangeConfiguration，
// 让 Monaco 重新注册模型观察者并重新拉取语义 token。
function refreshSemanticTokens() {
  if (!editor) return;
  editor.updateOptions({ 'semanticHighlighting.enabled': false });
  editor.updateOptions({ 'semanticHighlighting.enabled': true });
}

let semanticHighlightingRegistered = false;

function registerSemanticHighlighting() {
  if (semanticHighlightingRegistered) return;
  semanticHighlightingRegistered = true;
  installSemanticTheme();

  monaco.languages.registerDocumentSemanticTokensProvider(
    ['cpp', 'c', 'objective-c'],
    {
      getLegend() {
        return { tokenTypes: SEMANTIC_TOKEN_TYPES, tokenModifiers: SEMANTIC_TOKEN_MODIFIERS };
      },
      async provideDocumentSemanticTokens(model, lastResultId, token) {
        const doc = currentTextDoc();
        if (!isReady() || !doc || !doc.uri || !isCppLang(doc.languageId)) {
          return EMPTY_SEMANTIC_TOKENS;
        }
        if (!serverCapabilities || !serverCapabilities.semanticTokensProvider) {
          return EMPTY_SEMANTIC_TOKENS;
        }
        // 切换标签页后模型可能尚未对 clangd 打开；确保 didOpen 已发送
        if (lsp.lastDocUri !== doc.uri) syncActiveDoc();
        // 把挂起的 didChange 立即同步，保证语义 token 基于最新内容
        syncNow();
        try {
          const result = await lsp.connection.sendRequest(
            proto.SemanticTokensRequest.type,
            { textDocument: { uri: doc.uri } },
            token
          );
          if (token.isCancellationRequested) return EMPTY_SEMANTIC_TOKENS;
          return convertSemanticTokens(result && result.data);
        } catch (err) {
          return EMPTY_SEMANTIC_TOKENS;
        }
      },
      releaseDocumentSemanticTokens() {},
    }
  );
}

async function startEditor() {
  window.__cppeditor.stage = 'monaco-loaded';

  // 读取保存的外观设置，创建编辑器时直接采用（避免先以默认外观显示再切换）
  try {
    const s = await window.editorAPI.loadSettings();
    if (s && s.editor) appSettings = s;
  } catch {
    /* 无设置时使用默认外观 */
  }
  installSemanticTheme();

  editor = monaco.editor.create(document.getElementById('editor'), {
    theme: appTheme === 'light' ? 'cppeditor-light' : 'cppeditor-dark',
    fontSize: clampFontSize(appSettings.editor && appSettings.editor.fontSize),
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
    // 启用语义高亮（默认由主题决定，Monaco 内置主题默认关闭）
    'semanticHighlighting.enabled': true,
  });

  // 编辑器已创建，应用全部外观设置（字号、括号行为等）
  applyEditorSettings();

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

  // Ctrl + 左键：跳转到符号定义
  editor.onMouseDown((e) => {
    if (!(e.event.ctrlKey || e.event.metaKey)) return;
    if (!e.event.leftButton) return;
    const t = e.target;
    if (!t || t.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !t.position) return;
    jumpToDefinition(t.position);
  });

  // LSP 驱动的代码补全
  monaco.languages.registerCompletionItemProvider(['cpp', 'c'], {
    triggerCharacters: ['.', '>', ':', '<', '"', '/', '*', '#', ' '],
    provideCompletionItems(model, position, context) {
      return provideCompletion(model, position, context);
    },
  });

  // LSP 驱动的悬停提示
  monaco.languages.registerHoverProvider(['cpp', 'c'], {
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
      // 有警告：展示在底部面板（不影响运行）；无警告则收起旧面板，
      // 避免上次编译的警告/错误残留
      if (result.output) showBuildOutput('warning', result.output);
      else hideBuildOutput();
      showSaveStatus('已启动: ' + basename(result.exePath || t.path));
    } else {
      const msg = (result && result.message) || '编译失败';
      if (result && result.output) showBuildOutput('error', result.output);
      console.error(msg);
      showSaveStatus('编译失败', true);
    }
  })

  document.getElementById('setting-btn').addEventListener('click', () => {
    window.editorAPI.openSettingWindow();
  })

  const buildCloseBtn = document.getElementById('build-close');
  if (buildCloseBtn) {
    buildCloseBtn.addEventListener('click', hideBuildOutput);
  }
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

  // 设置窗口保存后即时应用外观（主题、字号、括号行为）
  window.editorAPI.onSettingsChanged((s) => {
    if (s && s.editor) appSettings = s;
    applyEditorSettings();
  });

  // compile_commands.json 已重建：clangd 会自动监听该文件变化，这里立即发
  // didChangeWatchedFiles 让它马上重载，并强制当前文档按新参数重新解析
  window.editorAPI.onLspCompileDbUpdated((compileDbPath) => {
    if (shutdown || !lsp || !lsp.initialized) return;
    if (compileDbPath) {
      lsp.connection.sendNotification('workspace/didChangeWatchedFiles', {
        changes: [{ uri: 'file:///' + compileDbPath.replace(/\\/g, '/'), type: 2 }],
      });
    }
    scheduleChange();
    refreshSemanticTokens();
  });

  // 编译设置变化后主进程广播 lsp:restart：重启 clangd 以加载新编译参数
  window.editorAPI.onLspRestart(() => {
    if (shutdown) return;
    reconnectAttempts = 0;
    bootstrap();
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
    // Delete：文件树聚焦时删除选中项（移入回收站，需确认）
    if (fileTreeFocused && (e.key === 'Delete' || e.key === 'Del')) {
      e.preventDefault();
      e.stopPropagation();
      deleteSelectedTreePaths();
      return;
    }
    // Ctrl+C / Ctrl+X / Ctrl+V：文件树剪贴板操作（仅当焦点在文件树区域时接管，
    // 否则保留编辑器的复制/剪切/粘贴行为）
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const k = (e.key || '').toLowerCase();
      if (fileTreeFocused && (k === 'c' || k === 'x' || k === 'v')) {
        e.preventDefault();
        e.stopPropagation();
        if (k === 'c') copySelected();
        else if (k === 'x') cutSelected();
        else pasteToDir(pasteTargetDir());
        return;
      }
    }
    // Esc 关闭右键菜单 / 输入弹层
    if (e.key === 'Escape') {
      if (document.getElementById('tree-input').style.display !== 'none') hideTreeInput();
      else hideTreeMenu();
    }
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

  // 文件树焦点追踪：点击文件树区域后 Ctrl+C/V/X 接管为文件操作；
  // 点击其他区域（如编辑器）则恢复默认剪贴板行为。
  document.addEventListener('mousedown', (e) => {
    fileTreeFocused = !!(e.target && e.target.closest && e.target.closest('#fileframe'));
  }, true);

  // 点击菜单/输入层之外关闭右键菜单
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && (t.closest('#tree-menu') || t.closest('#tree-input'))) return;
    hideTreeMenu();
  });

  // 新建 / 重命名输入弹层
  const treeInputOkBtn = document.getElementById('tree-input-ok');
  const treeInputCancelBtn = document.getElementById('tree-input-cancel');
  const treeInputField = document.getElementById('tree-input-field');
  if (treeInputOkBtn) treeInputOkBtn.addEventListener('click', commitTreeInput);
  if (treeInputCancelBtn) treeInputCancelBtn.addEventListener('click', hideTreeInput);
  if (treeInputField) {
    treeInputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitTreeInput(); }
      else if (e.key === 'Escape') { e.preventDefault(); hideTreeInput(); }
    });
  }

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

// 尽早读取设置应用主题：body 与图标此时已可访问，monaco 未加载则由 guard 兜底。
// 主进程在 URL 中带 theme/fontSize/treeFontSize 参数，可同步应用：
// - theme：避免浅色主题下先闪深色再切换；
// - treeFontSize：文件树字号在首帧前就位，避免窗口显示后字体/图标再缩放。
(function prefetchAppSettings() {
  const q = new URLSearchParams(location.search);
  const themeFromUrl = q.get('theme');
  if (themeFromUrl === 'light' || themeFromUrl === 'dark') {
    appSettings = { editor: { theme: themeFromUrl } };
    applyAppTheme(themeFromUrl);
  }
  const fontFromUrl = Number(q.get('fontSize'));
  if (Number.isFinite(fontFromUrl)) {
    appSettings.editor = appSettings.editor || {};
    appSettings.editor.fontSize = clampFontSize(fontFromUrl);
  }
  const treeFontFromUrl = Number(q.get('treeFontSize'));
  if (Number.isFinite(treeFontFromUrl)) {
    applyTreeFontSize(treeFontFromUrl);
  }
  if (!window.editorAPI) return;
  window.editorAPI.loadSettings()
    .then((s) => {
      if (s && s.editor) appSettings = s;
      applyAppTheme(s && s.editor && s.editor.theme);
      applyTreeFontSize(s && s.editor && s.editor.fileTreeFontSize);
    })
    .catch(() => {});
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
