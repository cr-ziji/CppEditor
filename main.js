'use strict';

const { app, BrowserWindow, dialog, ipcMain, protocol } = require('electron');
const windowStateKeeper = require('electron-window-state');
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
let settingWindow = null;
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
 * 计算 mingw 头文件搜索路径与目标平台参数。
 *
 * 注意：这里不写死 -std。因为 -std=c++17 对 C 语言是非法参数
 * （Invalid argument '-std=c++17' not allowed with 'C'），而 fallbackFlags
 * 是全局的、无法按文件语言区分；-std 只能放进 compile_commands.json 的
 * 逐文件参数中（.c → -std=c11，.cpp → -std=c++17）。
 */
function buildBaseFlags() {
  const mingw = getMingwRoot();
  const flags = ['--target=x86_64-w64-mingw32'];

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

const SOURCE_EXTS = ['.c', '.cpp'];

// 图片扩展名：以二进制（base64）形式返回给渲染进程做图片预览
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg',
]);

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

// 在项目目录生成 compile_commands.json，让 clangd 以相同编译参数索引整个目录。
// 编译器与 -std 按文件语言区分：.c 用 clang + c11，.cpp 用 clang++ + c++17。
function writeCompileCommands(projectDir) {
  try {
    const base = buildBaseFlags();
    let files = findSourceFiles(projectDir);
    if (!files.length) files = [path.join(projectDir, 'main.cpp')];
    const entries = files.map((file) => {
      const isC = path.extname(file).toLowerCase() === '.c';
      const compiler = isC ? 'clang' : 'clang++';
      const std = isC ? '-std=c11' : '-std=c++17';
      return {
        directory: projectDir,
        file,
        arguments: [compiler, ...base, std, file],
      };
    });
    fs.writeFileSync(
      path.join(projectDir, 'compile_commands.json'),
      JSON.stringify(entries, null, 2),
      'utf8'
    );
  } catch {
    /* 生成失败不影响保存 */
  }
}

// --- 项目目录监听 -------------------------------------------------------------
// Windows 上 Node 18 的 fs.watch 不支持 recursive，故采用轻量轮询：
// 定期对比源文件集合，增删发生时重建 compile_commands.json 并通知渲染进程，
// 渲染进程再向 clangd 发送 workspace/didChangeWatchedFiles 使其实时索引。
let projectWatcher = null;

// 监听快照取目录内所有文件（含 .h/.hpp 等头文件）及各自的 mtime/size，
// 以便区分新增 / 删除 / 内容修改。目录本身也纳入快照（isDirectory: true），
// 这样空文件夹的创建 / 删除也能被感知并同步到文件树。
function snapshotProjectFiles(dir) {
  const out = new Map();
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
        const fp = path.join(d, name).replace(/\\/g, '/');
        // 目录的 mtime 会随内部增删而变化，这里固定为 0，
        // 目录只参与「出现 / 消失」判断，不参与「内容修改」判断
        out.set(fp, { mtimeMs: 0, size: 0, isDirectory: true });
        walk(path.join(d, name), depth + 1);
      } else if (ent.isFile()) {
        if (path.extname(ent.name).toLowerCase() === '.exe') continue; // 编译产物不跟踪
        const fp = path.join(d, name).replace(/\\/g, '/');
        try {
          const st = fs.statSync(path.join(d, name));
          out.set(fp, { mtimeMs: st.mtimeMs, size: st.size, isDirectory: false });
        } catch {
          out.set(fp, { mtimeMs: 0, size: 0, isDirectory: false });
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [p, info] of a) {
    const other = b.get(p);
    if (!other || other.mtimeMs !== info.mtimeMs || other.size !== info.size) return false;
  }
  return true;
}

function watchProject() {
  stopProjectWatcher();
  const dir = projectPath;
  if (!dir || !fs.existsSync(dir)) {
    emitLog('[watcher] skip, dir=' + dir);
    return;
  }
  const snapshot = snapshotProjectFiles(dir);
  writeCompileCommands(dir);
  projectWatcher = {
    snapshot,
    timer: setInterval(() => {
      const next = snapshotProjectFiles(dir);
      if (setsEqual(next, projectWatcher.snapshot)) return;
      const added = [];
      const removed = [];
      const modified = [];
      for (const [p, info] of next) {
        const prev = projectWatcher.snapshot.get(p);
        if (!prev) added.push({ path: p, isDirectory: !!info.isDirectory });
        else if (prev.mtimeMs !== info.mtimeMs || prev.size !== info.size) modified.push({ path: p, isDirectory: !!info.isDirectory });
      }
      for (const p of projectWatcher.snapshot.keys()) {
        if (!next.has(p)) {
          const prevInfo = projectWatcher.snapshot.get(p);
          removed.push({ path: p, isDirectory: !!(prevInfo && prevInfo.isDirectory) });
        }
      }
      projectWatcher.snapshot = next;
      // 仅当编译单元集合变化时才需要重建编译数据库（.h 变化不影响）
      const sourceExts = new Set(SOURCE_EXTS);
      const hasSourceChange = [...added, ...removed, ...modified].some((f) =>
        sourceExts.has(path.extname(typeof f === 'object' ? f.path : f).toLowerCase())
      );
      if (hasSourceChange) writeCompileCommands(dir);
      emitToRenderer('lsp:project-changed', {
        projectDir: dir,
        added,
        removed,
        modified,
      });
    }, 1000),
  };
}

// 应用自身写入文件后，同步更新 watcher 快照，避免下一轮轮询误报「内容修改」。
// 只跟踪项目目录内的文件：项目外的文件（扩展名关联打开的）不会进入快照，
// 否则会被误判为「删除」并关闭对应标签页。
function updateSnapshotEntry(filePath) {
  if (!projectWatcher || !projectWatcher.snapshot) return;
  const resolved = path.resolve(filePath);
  if (!projectPath || !isWithin(projectPath, resolved)) return;
  const p = resolved.replace(/\\/g, '/');
  try {
    const st = fs.statSync(resolved);
    projectWatcher.snapshot.set(p, { mtimeMs: st.mtimeMs, size: st.size, isDirectory: false });
  } catch {
    /* ignore */
  }
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
    const cwd = projectPath && fs.existsSync(projectPath) ? projectPath : path.dirname(clangdPath);
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
function setupLspIpc() {
  ipcMain.handle('lsp:start', () => {
    const result = startClangd();
    return {
      ok: result.ok,
      message: result.message,
      clangdPath: result.clangdPath,
      fallbackFlags: buildBaseFlags(),
      offsetEncoding: 'utf-16',
      projectDir: projectPath,
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
let projectPath = null;
// 应用设置：projectPath 由主进程维护，compile/editor/templates/shortcuts
// 分组由设置窗口写入，与 projectPath 一并持久化到同一个 settings.json。
let appSettings = { projectPath: null };

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const s = JSON.parse(raw);
    if (s && typeof s === 'object') appSettings = s;
  } catch {
    /* 无配置或解析失败时保持默认 */
  }
  if (typeof appSettings.projectPath === 'string') projectPath = appSettings.projectPath;
}

function persistSettings() {
  appSettings.projectPath = projectPath;
  try {
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify(appSettings, null, 2),
      'utf8'
    );
  } catch {
    /* 忽略写入失败 */
  }
}

// 设置窗口读写：只读写 compile/editor/templates/shortcuts 四个分组，
// projectPath 仍由主进程单独维护，渲染进程发来的补丁不会覆盖它。
function setupSettingsIpc() {
  ipcMain.handle('settings:load', () => appSettings);

  ipcMain.handle('settings:save', (_event, patch) => {
    if (patch && typeof patch === 'object') {
      for (const key of ['compile', 'editor', 'templates', 'shortcuts']) {
        if (patch[key] && typeof patch[key] === 'object') appSettings[key] = patch[key];
      }
      persistSettings();
      // 通知主窗口即时应用最新设置（主题、字号、括号行为等）
      emitToRenderer('settings:changed', appSettings);
    }
    return appSettings;
  });
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

// 选择要打开的文件夹（左侧「打开文件夹」按钮）
async function chooseProjectDirectory() {
  const win = BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win, {
    title: '打开文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

function setupSaveIpc() {
  // 启动时恢复上次的保存路径与文件内容
  loadSettings();
  watchProject();

  ipcMain.handle('save:get-saved', () => {
    if (!projectPath) return { ok: false };
    try {
      if (!fs.existsSync(path.join(projectPath, 'main.cpp'))) {
        return { ok: false, missing: true, path: path.join(projectPath, 'main.cpp'), projectPath };
      }
      writeCompileCommands(projectPath);
      const content = fs.readFileSync(path.join(projectPath, 'main.cpp'), 'utf8');
      return { ok: true, path: path.join(projectPath, 'main.cpp'), projectPath, content };
    } catch (err) {
      return { ok: false, message: '读取失败: ' + err.message };
    }
  });

  // 渲染进程 Ctrl+S：把编辑器全文写入当前保存路径
  ipcMain.handle('save:save', async (_event, content) => {
    if (typeof content !== 'string') {
      return { ok: false, message: '要保存的内容无效' };
    }
    if (!projectPath) {
      const chosen = await chooseSaveDirectory();
      if (!chosen) return { ok: false, cancelled: true };
      projectPath = chosen;
    }
    try {
      fs.writeFileSync(path.join(projectPath, 'main.cpp'), content, 'utf8');
      updateSnapshotEntry(path.join(projectPath, 'main.cpp'));
      writeCompileCommands(projectPath);
      persistSettings();
      watchProject();
      return {
        ok: true,
        path: path.join(projectPath, 'main.cpp'),
        projectDir: projectPath,
      };
    } catch (err) {
      return { ok: false, message: '保存失败: ' + err.message };
    }
  });

  // 手动重新选择保存目录（状态栏「更改目录」）
  ipcMain.handle('save:choose-dir', async () => {
    const chosen = await chooseSaveDirectory();
    if (!chosen) return { ok: false, cancelled: true };
    projectPath = chosen;
    writeCompileCommands(chosen);
    persistSettings();
    watchProject();
    return { ok: true, path: path.join(projectPath, 'main.cpp'), projectDir: projectPath };
  });
}

async function readProjectDir(currentPath) {
  // 读取目录，withFileTypes 能让我们直接知道是文件还是文件夹
  const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      // 目录自身也加入结果，保证空文件夹也能在文件树中显示
      results.push({ path: fullPath, isDirectory: true });
      // 递归调用，并展开子目录的结果
      const nestedFiles = await readProjectDir(fullPath);
      results.push(...nestedFiles);
    } else {
      // 编译产物（.exe）不显示在文件树中
      if (path.extname(entry.name).toLowerCase() === '.exe') continue;
      // 是文件，直接记录其路径
      results.push({ path: fullPath, isDirectory: false });
    }
  }
  return results;
}

function setupProjectIpc() {
  ipcMain.handle('project:load', async () => {
    if (!projectPath) return { projectDir: null, files: [] };
    try {
      return { projectDir: projectPath, files: await readProjectDir(projectPath) };
    } catch (err) {
      return { projectDir: projectPath, files: [] };
    }
  })

  // 左侧「打开文件夹」按钮：选择目录作为项目，返回文件树数据
  ipcMain.handle('project:open-folder', async () => {
    const chosen = await chooseProjectDirectory();
    if (!chosen) return { cancelled: true };
    projectPath = chosen;
    writeCompileCommands(chosen);
    persistSettings();
    watchProject();
    try {
      return { projectDir: chosen, files: await readProjectDir(chosen) };
    } catch (err) {
      return { projectDir: chosen, files: [] };
    }
  })
}

// ---------------------------------------------------------------------------
// 文件读写：渲染进程打开项目树中的任意文件 / 保存当前标签页
// ---------------------------------------------------------------------------
function setupFileIpc() {
  // 读取任意文件。文本返回 UTF-8 字符串，图片/二进制返回 base64。
  // 不限于项目目录内：扩展名关联打开的外部文件也需要能读取。
  ipcMain.handle('file:read', async (_event, filePath) => {
    try {
      const resolved = path.resolve(filePath);
      const buf = await fs.promises.readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const image = IMAGE_EXTS.has(ext);
      let binary = image;
      if (!binary) {
        // 经典启发式：存在 NUL 字节视为二进制
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] === 0) { binary = true; break; }
        }
      }
      return {
        ok: true,
        path: resolved,
        ext,
        mime: contentType(resolved),
        binary,
        size: buf.length,
        content: binary ? buf.toString('base64') : buf.toString('utf8'),
      };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  // 将文本内容写回指定文件（配合当前激活标签页）。
  // 不限于项目目录内：外部打开的文件也可保存回原路径。
  ipcMain.handle('file:save', async (_event, filePath, content) => {
    if (typeof content !== 'string') {
      return { ok: false, message: '要保存的内容无效' };
    }
    try {
      const resolved = path.resolve(filePath);
      fs.writeFileSync(resolved, content, 'utf8');
      updateSnapshotEntry(resolved);
      return { ok: true, path: resolved };
    } catch (err) {
      return { ok: false, message: '保存失败: ' + err.message };
    }
  });
}

// ---------------------------------------------------------------------------
// 运行当前文件：用 MinGW 的 g++/gcc 编译 .cpp/.c，成功后启动编译出的 exe
// ---------------------------------------------------------------------------
function getGxxPath() {
  const bundled = path.join(getMingwRoot(), 'bin', 'g++.exe');
  return fs.existsSync(bundled) ? bundled : 'g++';
}

function getGccPath() {
  const bundled = path.join(getMingwRoot(), 'bin', 'gcc.exe');
  return fs.existsSync(bundled) ? bundled : 'gcc';
}

// 让子进程能找到 MinGW 的 DLL（libstdc++-6.dll 等）
function mingwEnv() {
  const binDir = path.join(getMingwRoot(), 'bin');
  return {
    ...process.env,
    PATH: binDir + path.delimiter + (process.env.PATH || ''),
  };
}

function runProcess(cmd, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function setupRunIpc() {
  ipcMain.handle('run:compile-and-run', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) {
      return { ok: false, message: '无效的文件路径' };
    }
    if (!fs.existsSync(filePath)) {
      return { ok: false, message: '文件不存在: ' + filePath };
    }
    const ext = path.extname(filePath).toLowerCase();
    const isC = ext === '.c';
    if (!isC && ext !== '.cpp') {
      return { ok: false, message: '仅支持运行 .c / .cpp 文件' };
    }

    const compiler = isC ? getGccPath() : getGxxPath();
    const exePath = filePath.slice(0, filePath.length - ext.length) + '.exe';
    const dir = path.dirname(filePath);
    const stdFlag = isC ? '-std=c11' : '-std=c++17';
    // -static 静态链接 libstdc++/libgcc/libwinpthread，生成的 exe 不依赖
    // mingw 运行时 DLL（libstdc++-6.dll 等），可独立运行
    const args = [filePath, '-o', exePath, stdFlag, '-static'];

    let result;
    try {
      result = await runProcess(compiler, args, dir, mingwEnv());
    } catch (err) {
      return { ok: false, message: '无法启动编译器: ' + err.message };
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      return {
        ok: false,
        message: '编译失败' + (detail ? ':\n' + detail : ''),
      };
    }

    // 打开编译出的 exe：经 cmd start 在新窗口中启动目标程序。
    // 直接 spawn 控制台程序通常不会弹出可见窗口；cmd /c start 会为目标
    // 分配一个新的控制台窗口。外层再套 cmd /k，程序退出后窗口保留，
    // 便于查看输出（避免 hello world 一闪而过）。windowsHide 只隐藏
    // 最外层 cmd 本身，start 创建的目标窗口不受影响。
    try {
      const cmdPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      const child = spawn(cmdPath, ['/c', 'start', '', 'cmd', '/k', exePath], {
        cwd: dir,
        env: mingwEnv(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch (err) {
      return { ok: false, message: '启动程序失败: ' + err.message };
    }
    return { ok: true, exePath, message: '已启动: ' + exePath };
  });
}

// ---------------------------------------------------------------------------
// 窗口与应用生命周期
// ---------------------------------------------------------------------------
function createWindow() {
  let mainWindowState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 860
  });

  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    title: 'CppEditor',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindowState.manage(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const urlTheme = appSettings.editor && appSettings.editor.theme === 'light' ? 'light' : 'dark';
  mainWindow.loadURL(
    EDITOR_SCHEME + '://app/index.html?root=' + encodeURIComponent(APP_ROOT) + '&theme=' + urlTheme
  );

  // 页面加载完成后，若有待打开的关联文件（启动时带文件参数，或加载期间收到
  // 第二个实例转发过来的文件），通知渲染进程以标签页形式打开。
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingExternalFile) {
      const f = pendingExternalFile;
      pendingExternalFile = null;
      mainWindow.webContents.send('file:open-external', f);
    }
    // electron-window-state 恢复的最大化发生在页面加载前，maximize 事件早于
    // 渲染进程监听而被丢弃，这里按窗口当前实际状态校准自定义标题栏按钮
    emitToRenderer(mainWindow.isMaximized() ? 'window:maximized' : 'window:unmaximized');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('maximize', () => {
    emitToRenderer('window:maximized');
  })
  mainWindow.on('unmaximize', () => {
    emitToRenderer('window:unmaximized');
  })

  mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function createSettingWindow() {
  settingWindow = new BrowserWindow({
    width: 640,
    height: 620,
    minWidth: 520,
    minHeight: 560,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    title: '设置',
    frame: false,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const urlTheme = appSettings.editor && appSettings.editor.theme === 'light' ? 'light' : 'dark';
  settingWindow.loadURL(
      EDITOR_SCHEME + '://app/setting.html?root=' + encodeURIComponent(APP_ROOT) + '&theme=' + urlTheme
  );

  settingWindow.on('closed', () => {
    settingWindow = null;
  });

  settingWindow.on('maximize', () => {
    emitToRenderer('window:maximized');
  })
  settingWindow.on('unmaximize', () => {
    emitToRenderer('window:unmaximized');
  })

  settingWindow.webContents.openDevTools({ mode: 'detach' });
}

function setupWindowIpc() {
  ipcMain.on('window:minimize', () => {
    if (mainWindow){
      mainWindow.minimize();
    }
  })
  ipcMain.on('window:maximize', () => {
    if (mainWindow){
      mainWindow.maximize();
    }
  })
  ipcMain.on('window:unmaximize', () => {
    if (mainWindow){
      mainWindow.unmaximize();
    }
  })
  ipcMain.on('window:close', () => {
    if (mainWindow){
      mainWindow.close();
    }
  })
  ipcMain.on('window:open-setting-window', () => {
    createSettingWindow();
  })
  ipcMain.on('window:close-setting-window', () => {
    if (settingWindow){
      settingWindow.close();
    }
  })
}

app.whenReady().then(() => {
  registerEditorProtocol();
  setupWindowIpc();
  setupLspIpc();
  setupSaveIpc();
  setupProjectIpc();
  setupSettingsIpc();
  setupFileIpc();
  setupRunIpc();
  // 启动时通过扩展名关联打开的文件：记入待打开队列，页面加载后交给渲染进程
  const external = findExternalFile(process.argv);
  if (external) pendingExternalFile = external;
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

// --- 单实例 + 扩展名关联打开 ------------------------------------------------
// 从命令行参数中找出通过扩展名关联（或命令行）传入的源文件。
// 过滤掉应用自身、以 - 开头的开关以及不存在的路径。
const FILE_ASSOC_EXTS = new Set(['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx', '.ino']);

function findExternalFile(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    if (typeof a !== 'string' || !a || a.startsWith('-')) continue;
    const ext = path.extname(a).toLowerCase();
    if (!ext || !FILE_ASSOC_EXTS.has(ext)) continue;
    try {
      const resolved = path.resolve(a);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch {
      /* 忽略无法访问的路径 */
    }
  }
  return null;
}

// 待打开的外部文件：页面加载前存入，did-finish-load 后推送给渲染进程
let pendingExternalFile = null;

function deliverExternalFile(filePath) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingExternalFile = filePath;
    return;
  }
  mainWindow.webContents.send('file:open-external', filePath);
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  // 第二个实例启动：聚焦已有窗口，并把关联的文件以标签页形式打开。
  // 文件是否属于当前项目、是否已设置项目，都不影响这次打开。
  app.on('second-instance', (_event, argv) => {
    const file = findExternalFile(argv);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (file) deliverExternalFile(file);
  });
}
