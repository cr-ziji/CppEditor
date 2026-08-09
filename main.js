'use strict';

const { app, BrowserWindow, dialog, ipcMain, protocol } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 自定义 editor:// 协议：用于在渲染进程中安全地加载 monaco 编辑器与
// vscode-jsonrpc / vscode-languageserver-protocol 等前端脚本。
// 必须在 app ready 之前注册。
// ---------------------------------------------------------------------------
const EDITOR_SCHEME = 'editor';

protocol.registerSchemesAsPrivileged([
  {
    scheme: EDITOR_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// app 根目录（开发模式下是项目根目录，打包后是 asar 内的应用根目录）
const APP_ROOT = app.getAppPath();
const NODE_MODULES = path.join(APP_ROOT, 'node_modules');

// ---------------------------------------------------------------------------
// 路径映射表：editor://app/<path> 的前缀 -> 磁盘真实目录
// ---------------------------------------------------------------------------
const ROUTES = [
  {
    prefix: '/vs/',
    root: path.join(NODE_MODULES, 'monaco-editor', 'min', 'vs'),
    strip: '/vs/',
  },
  {
    prefix: '/vendor/vscode-jsonrpc/',
    root: path.join(NODE_MODULES, 'vscode-jsonrpc'),
    strip: '/vendor/vscode-jsonrpc/',
  },
  {
    prefix: '/vendor/vscode-languageserver-protocol/',
    root: path.join(NODE_MODULES, 'vscode-languageserver-protocol'),
    strip: '/vendor/vscode-languageserver-protocol/',
  },
  {
    prefix: '/vendor/vscode-languageserver-types/',
    root: path.join(NODE_MODULES, 'vscode-languageserver-types'),
    strip: '/vendor/vscode-languageserver-types/',
  },
  // 兜底：其余路径都从应用根目录读取（index.html / renderer.js / preload.js 等）
  {
    prefix: '/',
    root: APP_ROOT,
    strip: '/',
  },
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
};

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function isWithin(root, filePath) {
  const r = path.resolve(root);
  const p = path.resolve(filePath);
  return p === r || p.startsWith(r + path.sep);
}

function registerEditorProtocol() {
  protocol.handle(EDITOR_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname);

      let filePath = null;
      let root = null;
      for (const route of ROUTES) {
        if (pathname.startsWith(route.prefix)) {
          root = route.root;
          filePath = path.resolve(root, pathname.slice(route.strip.length));
          break;
        }
      }

      if (!filePath || !isWithin(root, filePath)) {
        return new Response('Not Found', { status: 404 });
      }

      const buf = await fs.promises.readFile(filePath);
      return new Response(buf, {
        headers: { 'Content-Type': contentType(filePath) },
      });
    } catch (err) {
      return new Response(String(err && err.message), { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// clangd 子进程管理
// ---------------------------------------------------------------------------
let mainWindow = null;
let clangd = null;                 // ChildProcess 实例
let stdoutBuffer = Buffer.alloc(0);
let pendingContentLength = null;
let headerEndLength = 4;
let queuedWrites = [];
let writeInFlight = false;

function getClangdPath() {
  const exeName = process.platform === 'win32' ? 'clangd.exe' : 'clangd';
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'clangd')
    : path.join(APP_ROOT, 'resources', 'clangd');
  return path.join(base, 'bin', exeName);
}

function getMingwRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mingw')
    : path.join(APP_ROOT, 'resources', 'mingw');
}

/**
 * 计算 mingw 头文件搜索路径，作为 clangd 的 fallbackFlags 通过 LSP initialize
 * 的 initializationOptions 下发（clangd 22 已移除 --extra-arg 命令行参数）。
 */
function buildFallbackFlags() {
  const mingw = getMingwRoot();
  const flags = ['--target=x86_64-w64-mingw32', '-std=c++17'];

  const pushIsystem = (dir) => {
    if (!dir) return;
    const normalized = dir.replace(/\\/g, '/');
    if (fs.existsSync(normalized)) {
      flags.push('-isystem', normalized);
    }
  };

  const gccRoot = path.join(mingw, 'lib', 'gcc', 'x86_64-w64-mingw32');
  let versionDir = null;
  try {
    if (fs.existsSync(gccRoot)) {
      const entries = fs.readdirSync(gccRoot).filter((e) => /^\d/.test(e));
      if (entries.length > 0) versionDir = entries[0];
    }
  } catch {
    versionDir = null;
  }

  if (versionDir) {
    const gccInclude = path.join(gccRoot, versionDir, 'include');
    pushIsystem(path.join(gccInclude, 'c++'));
    pushIsystem(path.join(gccInclude, 'c++', 'x86_64-w64-mingw32'));
    pushIsystem(path.join(gccInclude, 'c++', 'backward'));
    pushIsystem(path.join(gccInclude, 'include-fixed'));
  }
  pushIsystem(path.join(mingw, 'x86_64-w64-mingw32', 'include'));
  pushIsystem(path.join(mingw, 'include'));

  return flags;
}

function buildClangdArgs() {
  return [
    '--background-index',
    '--clang-tidy',
    '--header-insertion=never',
    '--completion-style=detailed',
    '--pch-storage=memory',
    '--log=error',
    '--offset-encoding=utf-16',
    '-j=4',
  ];
}

const SOURCE_EXTS = ['.c', '.cpp', '.cc', '.cxx', '.c++'];

// 递归收集项目目录下的所有 C/C++ 源文件，供 compile_commands.json 使用
function findSourceFiles(dir, maxDepth = 8) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (ent.isDirectory()) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'build' || name === 'out') continue;
        walk(path.join(d, name), depth + 1);
      } else if (ent.isFile() && SOURCE_EXTS.includes(path.extname(name).toLowerCase())) {
        out.push(path.join(d, name));
      }
    }
  };
  walk(dir, 0);
  return out;
}

// 在项目目录生成 compile_commands.json，让 clangd 以相同编译参数索引整个目录
function writeCompileCommands(projectDir) {
  try {
    const flags = ['clang++', ...buildFallbackFlags()];
    let files = findSourceFiles(projectDir);
    if (!files.length) files = [path.join(projectDir, 'main.cpp')];
    const entries = files.map((file) => ({
      directory: projectDir,
      file,
      arguments: [...flags, file],
    }));
    fs.writeFileSync(
      path.join(projectDir, 'compile_commands.json'),
      JSON.stringify(entries, null, 2),
      'utf8'
    );
  } catch {
    /* 生成失败不影响保存 */
  }
}

function projectDirOf() {
  return currentSavePath ? path.dirname(currentSavePath) : null;
}

// --- 项目目录监听 -------------------------------------------------------------
// Windows 上 Node 18 的 fs.watch 不支持 recursive，故采用轻量轮询：
// 定期对比源文件集合，增删发生时重建 compile_commands.json 并通知渲染进程，
// 渲染进程再向 clangd 发送 workspace/didChangeWatchedFiles 使其实时索引。
let projectWatcher = null;

// 监听快照取目录内所有文件（含 .h/.hpp 等头文件），而不仅是编译单元
function snapshotProjectFiles(dir) {
  const out = new Set();
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (ent.isDirectory()) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'build' || name === 'out') continue;
        walk(path.join(d, name), depth + 1);
      } else if (ent.isFile()) {
        out.add(path.join(d, name).replace(/\\/g, '/'));
      }
    }
  };
  walk(dir, 0);
  return out;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function watchProject() {
  stopProjectWatcher();
  const dir = projectDirOf();
  if (!dir || !fs.existsSync(dir)) {
    emitLog('[watcher] skip, dir=' + dir);
    return;
  }
  let snapshot = snapshotProjectFiles(dir);
  writeCompileCommands(dir);
  projectWatcher = {
    timer: setInterval(() => {
      const next = snapshotProjectFiles(dir);
      if (setsEqual(next, snapshot)) return;
      const added = [...next].filter((f) => !snapshot.has(f));
      const removed = [...snapshot].filter((f) => !next.has(f));
      snapshot = next;
      // 仅当编译单元集合变化时才需要重建编译数据库（.h 变化不影响）
      const sourceExts = new Set(SOURCE_EXTS);
      const hasSourceChange = [...added, ...removed].some((f) =>
        sourceExts.has(path.extname(f).toLowerCase())
      );
      if (hasSourceChange) writeCompileCommands(dir);
      emitToRenderer('lsp:project-changed', {
        projectDir: dir,
        added,
        removed,
      });
    }, 1000),
  };
}

function stopProjectWatcher() {
  if (projectWatcher) {
    clearInterval(projectWatcher.timer);
    projectWatcher = null;
  }
}

function emitToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function emitStatus(status) {
  emitToRenderer('lsp:status', status);
}

function emitLog(line) {
  emitToRenderer('lsp:log', String(line).trim());
}

function isClangdRunning() {
  return clangd !== null && clangd.exitCode === null && clangd.pid !== undefined;
}

// --- 解析 clangd stdout 的 Content-Length 帧 ---------------------------------
function onClangdStdout(data) {
  stdoutBuffer = Buffer.concat([stdoutBuffer, data]);

  for (;;) {
    if (pendingContentLength === null) {
      let headerEnd = stdoutBuffer.indexOf('\r\n\r\n');
      headerEndLength = 4;
      if (headerEnd === -1) {
        const altEnd = stdoutBuffer.indexOf('\n\n');
        if (altEnd !== -1) {
          headerEnd = altEnd;
          headerEndLength = 2;
        }
      }
      if (headerEnd === -1) {
        // 头信息不完整（或异常数据），等待更多数据
        return;
      }
      const header = stdoutBuffer.subarray(0, headerEnd).toString('utf8');
      const match = /content-length:\s*(\d+)/i.exec(header);
      stdoutBuffer = stdoutBuffer.subarray(headerEnd + headerEndLength);
      if (!match) {
        emitLog('[clangd] 无法解析消息头，已丢弃一段输出');
        continue;
      }
      pendingContentLength = parseInt(match[1], 10);
      if (pendingContentLength < 0 || pendingContentLength > 512 * 1024 * 1024) {
        emitLog('[clangd] 非法 Content-Length: ' + pendingContentLength);
        pendingContentLength = null;
        continue;
      }
    }

    if (stdoutBuffer.length < pendingContentLength) {
      return; // 消息体尚未完整
    }

    const body = stdoutBuffer.subarray(0, pendingContentLength).toString('utf8');
    stdoutBuffer = stdoutBuffer.subarray(pendingContentLength);
    pendingContentLength = null;

    try {
      const message = JSON.parse(body);
      emitToRenderer('lsp:message', message);
    } catch (err) {
      emitLog('[clangd] JSON 解析失败: ' + err.message);
    }
  }
}

// --- 向 clangd 写入一条 LSP 消息 ---------------------------------------------
function writeToClangd(message) {
  if (!isClangdRunning()) return;
  const body = JSON.stringify(message);
  const framed =
    'Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body;
  queuedWrites.push(framed);
  drainStdin();
}

function drainStdin() {
  if (writeInFlight || queuedWrites.length === 0) return;
  if (!isClangdRunning() || clangd.stdin.destroyed) {
    queuedWrites.length = 0;
    return;
  }
  writeInFlight = true;
  const chunk = queuedWrites.shift();
  clangd.stdin.write(chunk, 'utf8', () => {
    writeInFlight = false;
    drainStdin();
  });
}

// --- 启动 clangd -------------------------------------------------------------
function startClangd() {
  if (isClangdRunning()) {
    return { ok: true, message: 'clangd 已在运行', clangdPath: getClangdPath() };
  }

  const clangdPath = getClangdPath();
  if (!fs.existsSync(clangdPath)) {
    emitStatus({
      state: 'error',
      message: '找不到 clangd，请确认 resources/clangd 目录存在: ' + clangdPath,
    });
    return {
      ok: false,
      message: '找不到 clangd 可执行文件: ' + clangdPath,
    };
  }

  stdoutBuffer = Buffer.alloc(0);
  pendingContentLength = null;
  queuedWrites = [];
  writeInFlight = false;

  emitStatus({ state: 'starting', message: '正在启动 clangd...' });

  let child;
  try {
    // 以项目目录作为 clangd 的工作目录，使其能发现 compile_commands.json 并索引整个项目
    const projectDir = projectDirOf();
    const cwd = projectDir && fs.existsSync(projectDir) ? projectDir : path.dirname(clangdPath);
    child = spawn(clangdPath, buildClangdArgs(), {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    emitStatus({ state: 'error', message: 'clangd 启动失败: ' + err.message });
    return { ok: false, message: 'clangd 启动失败: ' + err.message };
  }

  clangd = child;

  child.on('spawn', () => {
    emitStatus({ state: 'running', message: 'clangd 已启动' });
  });

  child.stdout.on('data', onClangdStdout);
  child.stdout.on('error', (err) => emitLog('[clangd stdout] ' + err.message));

  child.stderr.on('data', (data) => {
    emitLog('[clangd stderr] ' + data.toString('utf8'));
  });

  child.on('error', (err) => {
    emitStatus({
      state: 'error',
      message: 'clangd 启动失败: ' + err.message,
    });
    emitLog('[clangd] 启动错误: ' + err.message);
    clangd = null;
  });

  child.on('exit', (code, signal) => {
    emitStatus({
      state: 'exited',
      code,
      signal,
      message: 'clangd 已退出 (code=' + code + ', signal=' + signal + ')',
    });
    emitLog('[clangd] 进程退出 code=' + code + ' signal=' + signal);
    clangd = null;
    queuedWrites = [];
  });

  return { ok: true, message: 'clangd 启动中', clangdPath };
}

function stopClangd() {
  if (!clangd) return;
  const child = clangd;
  clangd = null;
  queuedWrites = [];
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }, 200);
}

// ---------------------------------------------------------------------------
// IPC 接口
// ---------------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('lsp:start', () => {
    const result = startClangd();
    return {
      ok: result.ok,
      message: result.message,
      clangdPath: result.clangdPath,
      fallbackFlags: buildFallbackFlags(),
      offsetEncoding: 'utf-16',
      projectDir: projectDirOf(),
    };
  });

  ipcMain.on('lsp:send', (_event, message) => {
    if (message && typeof message === 'object') {
      writeToClangd(message);
    }
  });

  ipcMain.on('lsp:stop', () => stopClangd());
}

// ---------------------------------------------------------------------------
// 文件保存：Ctrl+S 将编辑器内容保存到用户选择的目录
// 保存路径会被持久化到 settings.json，下次启动直接恢复并读取文件内容。
// ---------------------------------------------------------------------------
let currentSavePath = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const s = JSON.parse(raw);
    if (s && typeof s.savePath === 'string') currentSavePath = s.savePath;
  } catch {
    /* 无配置或解析失败时保持默认 */
  }
}

function persistSettings() {
  try {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ savePath: currentSavePath }, null, 2),
      'utf8'
    );
  } catch {
    /* 忽略写入失败 */
  }
}

async function chooseSaveDirectory() {
  const win = BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win, {
    title: '选择 CppEditor 保存目录',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('documents'),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

function setupSaveIpc() {
  // 启动时恢复上次的保存路径与文件内容
  loadSettings();
  watchProject();

  ipcMain.handle('save:get-saved', () => {
    if (!currentSavePath) return { ok: false };
    const projectDir = path.dirname(currentSavePath);
    try {
      if (!fs.existsSync(currentSavePath)) {
        return { ok: false, missing: true, path: currentSavePath, projectDir };
      }
      writeCompileCommands(projectDir);
      const content = fs.readFileSync(currentSavePath, 'utf8');
      return { ok: true, path: currentSavePath, projectDir, content };
    } catch (err) {
      return { ok: false, message: '读取失败: ' + err.message };
    }
  });

  // 渲染进程 Ctrl+S：把编辑器全文写入当前保存路径
  ipcMain.handle('save:save', async (_event, content) => {
    if (typeof content !== 'string') {
      return { ok: false, message: '要保存的内容无效' };
    }
    if (!currentSavePath) {
      const chosen = await chooseSaveDirectory();
      if (!chosen) return { ok: false, cancelled: true };
      currentSavePath = path.join(chosen, 'main.cpp');
    }
    try {
      fs.writeFileSync(currentSavePath, content, 'utf8');
      writeCompileCommands(path.dirname(currentSavePath));
      persistSettings();
      watchProject();
      return {
        ok: true,
        path: currentSavePath,
        projectDir: path.dirname(currentSavePath),
      };
    } catch (err) {
      return { ok: false, message: '保存失败: ' + err.message };
    }
  });

  // 手动重新选择保存目录（状态栏「更改目录」）
  ipcMain.handle('save:choose-dir', async () => {
    const chosen = await chooseSaveDirectory();
    if (!chosen) return { ok: false, cancelled: true };
    currentSavePath = path.join(chosen, 'main.cpp');
    writeCompileCommands(chosen);
    persistSettings();
    watchProject();
    return { ok: true, path: currentSavePath, projectDir: chosen };
  });
}

// ---------------------------------------------------------------------------
// 窗口与应用生命周期
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    title: 'CppEditor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.loadURL(
    EDITOR_SCHEME + '://app/index.html?root=' + encodeURIComponent(APP_ROOT)
  );

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  registerEditorProtocol();
  setupIpc();
  setupSaveIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  stopProjectWatcher();
  stopClangd();
});
