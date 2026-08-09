'use strict';

/* ============================================================================
 * CppEditor 渲染进程
 * ----------------------------------------------------------------------------
 * 职责：
 *   1. 通过 AMD 加载 Monaco Editor，创建 C++ 编辑器（语法高亮、自动缩进、
 *      括号补全）。
 *   2. 通过一个极简的 CommonJS 加载器，在浏览器环境加载
 *      vscode-jsonrpc / vscode-languageserver-protocol，并在本进程内创建
 *      LSP 消息连接（与主进程里的 clangd 通过 preload 暴露的 IPC 通信）。
 *   3. 实现 initialize / didOpen / didChange / completion / hover /
 *      publishDiagnostics 等 LSP 交互，驱动补全、错误波浪线与悬停提示。
 * ==========================================================================*/

// ---------------------------------------------------------------------------
// 0. 极简 CommonJS 加载器
//    vscode-jsonrpc 与 vscode-languageserver-protocol 发布的是 CommonJS 代码。
//    渲染进程没有 Node 的 require，这里用一个同步 XHR + Function 构造的迷你
//    加载器来运行它们。所有模块都从 editor://app/vendor/... 加载（同源）。
// ---------------------------------------------------------------------------
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
  if (el) el.textContent = savedPath ? savedPath.replace(/\\/g, '/') : FILE_PATH;
  window.__cppeditor.savedPath = savedPath;
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

// 保存文件：首次按 Ctrl+S 会弹出目录选择框，之后直接覆盖 main.cpp
async function saveFile() {
  if (!editor || shutdown) return;
  try {
    const result = await window.editorAPI.save(editor.getValue());
    if (!result) return;
    if (result.cancelled) return;
    if (result.ok) {
      const wasUnset = !projectDir;
      const dirChanged = !pathEquals(result.projectDir, projectDir);
      applyProjectDir(result.projectDir || pathDirOf(result.path), result.path);
      updateFileLabel();
      showSaveStatus('已保存: ' + result.path);
      window.__cppeditor.saveInfo = { path: result.path, projectDir: result.projectDir };
      window.__cppeditor._saveSeq = (window.__cppeditor._saveSeq || 0) + 1;

      // 首次保存或更换目录：重建 model（URI 跟随项目目录）并重启 LSP，
      // 让 clangd 以新项目根索引整个目录
      if (wasUnset || dirChanged) {
        log('saveFile: rebuild+restart (wasUnset=' + wasUnset + ' dirChanged=' + dirChanged + ' projectDir=' + projectDir + ')');
        rebuildEditorModel();
        reconnectAttempts = 0;
        bootstrap();
      } else {
        log('saveFile: no dir change, skip restart');
      }
    } else {
      showSaveStatus(result.message || '保存失败', true);
    }
  } catch (err) {
    showSaveStatus('保存失败: ' + err.message, true);
  }
}

// 项目目录变化时重建编辑器 model，让文档 URI 跟随新路径（内容不变）
function rebuildEditorModel() {
  const oldModel = editor.getModel();
  const content = oldModel ? oldModel.getValue() : DEFAULT_CODE;
  const model = monaco.editor.createModel(
    content,
    'cpp',
    monaco.Uri.parse(DOC_URI)
  );
  if (editor.getModel() !== model) editor.setModel(model);
  if (oldModel) oldModel.dispose();
  updateFileLabel();
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
  if (!isReady()) return;
  docVersion = 1;
  dirty = false;
  lsp.connection.sendNotification(proto.DidOpenTextDocumentNotification.type, {
    textDocument: {
      uri: DOC_URI,
      languageId: 'cpp',
      version: docVersion,
      text: editor.getValue(),
    },
  });
}

function syncNow() {
  if (!isReady() || !dirty) return;
  if (changeTimer) {
    clearTimeout(changeTimer);
    changeTimer = null;
  }
  docVersion += 1;
  dirty = false;
  lsp.connection.sendNotification(proto.DidChangeTextDocumentNotification.type, {
    textDocument: { uri: DOC_URI, version: docVersion },
    contentChanges: [{ text: editor.getValue() }],
  });
}

function scheduleChange() {
  dirty = true;
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(syncNow, 150);
}

function handleDiagnostics(params) {
  if (!params || params.uri !== DOC_URI) return;
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
  if (!isReady()) return { suggestions: [] };
  syncNow();
  try {
    const triggerKind =
      context.triggerKind === 0 ? 1 : context.triggerKind === 1 ? 2 : 3;
    const params = {
      textDocument: { uri: DOC_URI },
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
  if (!isReady()) return null;
  syncNow();
  try {
    const params = {
      textDocument: { uri: DOC_URI },
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

// ---------------------------------------------------------------------------
// 6. 编辑器初始化
// ---------------------------------------------------------------------------
const DEFAULT_CODE = `#include <iostream>
#include <vector>
#include <cmath>
#include <string>

// 提示：输入 std:: 会触发 clangd 的代码补全；
// 把鼠标悬停在函数名上可查看类型信息。

struct Point {
    double x;
    double y;
};

double distance(const Point& a, const Point& b) {
    double dx = a.x - b.x;
    double dy = a.y - b.y;
    return std::sqrt(dx * dx + dy * dy);
}

int main() {
    std::vector<std::string> messages = {"Hello", "CppEditor"};
    for (const auto& msg : messages) {
        std::cout << msg << std::endl;
    }

    Point a{0, 0};
    Point b{3, 4};
    std::cout << "distance = " << distance(a, b) << std::endl;

    return 0;
}
`;

let editor = null;

async function startEditor() {
  window.__cppeditor.stage = 'monaco-loaded';

  // 启动时尝试恢复上次保存的项目（目录 + 文件内容）
  let initialCode = DEFAULT_CODE;
  try {
    const saved = await window.editorAPI.getSaved();
    if (saved && saved.ok && typeof saved.content === 'string') {
      initialCode = saved.content;
      applyProjectDir(saved.projectDir || pathDirOf(saved.path), saved.path);
    } else if (saved && saved.projectDir) {
      applyProjectDir(saved.projectDir);
    }
  } catch (e) {
    /* 恢复失败时使用默认示例代码 */
  }

  const model = monaco.editor.createModel(
    initialCode,
    'cpp',
    monaco.Uri.parse(DOC_URI)
  );

  editor = monaco.editor.create(document.getElementById('editor'), {
    model,
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

  editor.onDidChangeModelContent(() => scheduleChange());
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

  updateFileLabel();
  setDiagCounts(0, 0);
  setLspState('connecting', '正在连接 clangd...');
  editor.focus();
  window.__cppeditor.stage = 'editor-ready';
  window.__cppeditor.lines = model.getLineCount();

  bootstrap();
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

  // 项目目录文件增删：通知 clangd 重新索引（compile_commands.json 已在主进程重建）
  window.editorAPI.onProjectChanged((info) => {
    if (!lsp || !lsp.initialized || !info) return;
    const changes = [];
    for (const f of info.added || []) {
      changes.push({ uri: 'file:///' + f.replace(/\\/g, '/'), type: 1 });
    }
    for (const f of info.removed || []) {
      changes.push({ uri: 'file:///' + f.replace(/\\/g, '/'), type: 3 });
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
