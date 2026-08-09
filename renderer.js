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

  paths.forEach(filePath => {
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

      // 查找是否已存在同名子节点
      let child = currentNode.children.find(
          node => node.name === segment
      );

      if (!child) {
        // 判断是否为文件（简单启发式：最后一段且有扩展名）
        const isFile = isLast && segment.includes('.');

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

  // 对子节点排序：目录在前，文件在后，按名称排序
  function sortChildren(node) {
    if (node.children && Array.isArray(node.children)) {
      node.children.sort((a, b) => {
        // 目录优先
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        // 按名称排序
        return a.name.localeCompare(b.name);
      });

      // 递归排序子节点
      node.children.forEach(child => {
        if (child.type === 'directory') {
          sortChildren(child);
        }
      });
    }
    return node;
  }

  // 对根节点的子节点排序
  root.children.forEach(child => {
    if (child.type === 'directory') {
      sortChildren(child);
    }
  });

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
    else node.classList.add('file');
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

async function loadProjectFile(){
  const projectInf = await window.editorAPI.loadProject();
  if (projectInf && projectInf.projectDir) projectDir = projectInf.projectDir;
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
  document.getElementById('fileframe').appendChild(projectDom);
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
  return a.name.localeCompare(b.name);
}

// 将新 DOM 节点按「目录优先 + 名称排序」插入容器
function insertChildDomSorted(container, el, name, isDir) {
  for (const sibling of container.children) {
    if (!sibling.classList || (!sibling.classList.contains('folder') && !sibling.classList.contains('file'))) continue;
    const sibIsDir = sibling.classList.contains('folder');
    const sibSpan = sibling.querySelector('span');
    const sibName = sibSpan ? sibSpan.textContent : '';
    let before = false;
    if (isDir && !sibIsDir) before = true;
    else if (!isDir && sibIsDir) before = false;
    else before = name.localeCompare(sibName) < 0;
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
function insertFilePath(basePath, nodes, fullPath, rootContainer) {
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
      const isFile = isLast && segment.includes('.');
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
          // 子节点删空后父目录也一并移除
          if (n.children.length === 0 && n.node && n.node.parentNode) {
            const at = list.indexOf(n);
            if (at !== -1) list.splice(at, 1);
            n.node.parentNode.removeChild(n.node);
          }
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
    if (shouldIgnoreTreePath(f)) continue;
    insertFilePath(projectDir, projectFileTree, f, rootContainer);
  }
  for (const f of info.removed || []) {
    if (shouldIgnoreTreePath(f)) continue;
    removeFilePath(projectFileTree, f, rootContainer);
  }
}

// ---------------------------------------------------------------------------
// 6. 编辑器初始化
// ---------------------------------------------------------------------------
const DEFAULT_CODE = ``;

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

  loadProjectFile();

  // 项目目录文件增删：通知 clangd 重新索引（compile_commands.json 已在主进程重建）
  window.editorAPI.onProjectChanged((info) => {
    updateFileTree(info);
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
