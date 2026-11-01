'use strict';

const { app, BrowserWindow, dialog, ipcMain, protocol, shell, clipboard } = require('electron');
const windowStateKeeper = require('electron-window-state');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const IS_MAC = process.platform === 'darwin';
const EXE_SUFFIX = IS_WIN ? '.exe' : '';
// 文件名非法字符：Windows 限制更多，Linux/macOS 仅禁止路径分隔符。
const INVALID_NAME_RE = IS_WIN ? /[\\/:*?"<>|]/ : /\//;
const INVALID_NAME_DESC = IS_WIN ? '\\ / : * ? " < > |' : '/';

// Linux 编译产物统一放到项目内的隐藏目录，避免污染文件树与 clangd 索引。
const BUILD_DIR_NAME = '.cppeditor-build';

// ---------------------------------------------------------------------------
// 自定义 editor:// 协议：用于在渲染进程中安全地加载 web/ 前端脚本。
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

// ---------------------------------------------------------------------------
// 路径映射：editor://app/<path> 一律从应用根目录读取。
// 前端所需的 monaco（vs/）、vscode 协议库（vendor/）等资源均已内嵌于 web/，
// 因此这里只需一个兜底路由。
// ---------------------------------------------------------------------------
const ROUTES = [
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

function getClangdRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'clangd')
    : path.join(APP_ROOT, 'resources', 'clangd');
}

function getClangdPath() {
  const exeName = 'clangd' + EXE_SUFFIX;
  const root = getClangdRoot();
  const candidates = [
    path.join(root, 'bin', exeName),
    path.join(root, exeName),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

// 预装工具链目录：Windows 使用 MinGW，Linux 使用随应用分发的 GCC。
// 两个平台的目录布局保持一致：<root>/bin/g++、<root>/lib/gcc/<triple>/<ver> ...
function getToolchainRoot() {
  const dirName = IS_WIN ? 'mingw' : 'gcc';
  return app.isPackaged
    ? path.join(process.resourcesPath, dirName)
    : path.join(APP_ROOT, 'resources', dirName);
}

function compilerSource() {
  const c = appSettings.compile || {};
  return c.compilerSource === 'system' ? 'system' : 'bundled';
}

function systemCompilerAvailable() {
  return !!(findSystemCommand('g++') || findSystemCommand('gcc'));
}

// 只有用户选择了系统版本且系统里确实能找到编译器时才切换；
// 否则仍使用预装工具链，避免设置后编译 / clangd 突然不可用。
function useSystemCompiler() {
  return compilerSource() === 'system' && systemCompilerAvailable();
}

// 在 PATH 中查找可执行文件（Linux/macOS 会检查可执行权限）。
function findSystemCommand(name) {
  const exts = IS_WIN
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (IS_WIN) {
          if (fs.existsSync(candidate)) return candidate;
        } else {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {
        /* 继续查找 */
      }
    }
  }
  return null;
}

// 查找预装工具链中的 gcc/g++，兼容带版本号的可执行文件（如 g++-16）。
function findBundledTool(name) {
  const bin = path.join(getToolchainRoot(), 'bin');
  const exact = path.join(bin, name + EXE_SUFFIX);
  if (fs.existsSync(exact)) return exact;
  try {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const versioned = new RegExp('^' + escaped + '-\\d+(?:\\.\\d+)*(?:\\.exe)?$', IS_WIN ? 'i' : '');
    const entries = fs
      .readdirSync(bin)
      .filter((entry) => versioned.test(entry))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const entry of entries) {
      const candidate = path.join(bin, entry);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* 目录不存在 */
  }
  return null;
}

function ensureExecutable(filePath) {
  if (!filePath || IS_WIN || !path.isAbsolute(filePath)) return;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(filePath, 0o755);
    } catch {
      /* 无权限时交给 spawn 报错 */
    }
  }
}

function findVersionDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

// 推断工具链使用的 target triple。优先当前架构，同时扫描目录结构作为兜底。
function detectGccTriples(root) {
  const triples = new Set();
  const preferred = IS_WIN
    ? ['x86_64-w64-mingw32']
    : process.arch === 'arm64'
      ? ['aarch64-linux-gnu', 'aarch64-unknown-linux-gnu']
      : ['x86_64-linux-gnu', 'x86_64-pc-linux-gnu'];
  for (const triple of preferred) triples.add(triple);

  for (const base of [path.join(root, 'lib', 'gcc'), root]) {
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (/(?:linux|mingw|w64|darwin|android)/i.test(entry.name)) {
          triples.add(entry.name);
        }
      }
    } catch {
      /* 目录不存在 */
    }
  }
  return [...triples];
}

// 把 GCC 的 C++ 标准库 / 系统头文件目录加入 clangd 的搜索路径。
// 同时兼容 MinGW（lib/gcc/<triple>/<ver>/include/c++）和 Linux
// （include/c++/<ver>、lib/gcc/<triple>/<ver>/include）两种布局。
function addGccIncludeFlags(flags, root, triple, seen) {
  const pushIsystem = (dir) => {
    if (!dir) return;
    const normalized = dir.replace(/\\/g, '/');
    if (!fs.existsSync(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    flags.push('-isystem', normalized);
  };

  const cxxBase = path.join(root, 'include', 'c++');
  for (const version of findVersionDirs(cxxBase)) {
    pushIsystem(path.join(cxxBase, version));
    pushIsystem(path.join(cxxBase, version, triple));
    pushIsystem(path.join(cxxBase, version, 'backward'));
  }

  const gccBase = path.join(root, 'lib', 'gcc', triple);
  for (const version of findVersionDirs(gccBase)) {
    const include = path.join(gccBase, version, 'include');
    pushIsystem(path.join(include, 'c++'));
    pushIsystem(path.join(include, 'c++', triple));
    pushIsystem(path.join(include, 'c++', 'backward'));
    pushIsystem(include);
    pushIsystem(path.join(gccBase, version, 'include-fixed'));
  }

  pushIsystem(path.join(root, triple, 'include'));
  pushIsystem(path.join(root, 'include', triple));
  pushIsystem(path.join(root, 'include'));
}

/**
 * 计算 clangd 使用的头文件搜索路径与目标平台参数。
 *
 * 注意：这里不写死 -std。因为 -std=c++17 对 C 语言是非法参数
 * （Invalid argument '-std=c++17' not allowed with 'C'），而 fallbackFlags
 * 是全局的、无法按文件语言区分；-std 只能放进 compile_commands.json 的
 * 逐文件参数中（.c → -std=c11，.cpp → -std=c++17）。
 */
function buildBaseFlags() {
  // 用户选择系统 g++ 时，clangd 也按系统工具链解析头文件。
  if (useSystemCompiler()) return [];

  const root = getToolchainRoot();
  if (!fs.existsSync(root)) return [];

  const flags = [];
  const seen = new Set();
  for (const triple of detectGccTriples(root)) {
    addGccIncludeFlags(flags, root, triple, seen);
  }

  if (IS_WIN) {
    flags.unshift('--target=x86_64-w64-mingw32');
  } else if (findBundledTool('g++') || findBundledTool('gcc')) {
    flags.unshift('--gcc-toolchain=' + root.replace(/\\/g, '/'));
  }

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
// 编译器与 -std 按文件语言区分：.c 用 clang，.cpp 用 clang++；其余参数
// （语言标准、警告级别、自定义编译参数）取自设置。
function writeCompileCommands(projectDir) {
  try {
    const base = buildBaseFlags();
    let files = findSourceFiles(projectDir);
    if (!files.length) files = [path.join(projectDir, 'main.cpp')];
    const entries = files.map((file) => {
      const isC = path.extname(file).toLowerCase() === '.c';
      const compiler = isC ? 'clang' : 'clang++';
      return {
        directory: projectDir,
        file,
        arguments: [compiler, ...base, ...compileSettingsArgs(isC), file],
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

// 剪贴板中的文件是否为「剪切」（移动）。CF_HDROP 无剪切标志，
// 用本地标记区分：true 表示下次粘贴为移动而非复制。
let clipboardCut = false;
// Linux 下部分桌面环境对自定义剪贴板格式支持不一致，保留一份内存副本作为兜底。
let clipboardFiles = [];

function snapshotProjectFiles(dir) {
  const out = new Map();
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const name = ent.name;
      if (ent.isDirectory()) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'build' || name === 'out') continue;
        const fp = path.join(d, name).replace(/\\/g, '/');
        out.set(fp, { mtimeMs: 0, size: 0, isDirectory: true });
        walk(path.join(d, name), depth + 1);
      } else if (ent.isFile()) {
        if (path.extname(ent.name).toLowerCase() === '.exe') continue;
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

// ── 文件监听：原生 fs.watch recursive（Electron 41 / Node 22+ 支持）──
// fs.watch 事件不提供 mtime/size，需要 statSync 补充；新增 / 删除 / 修改
// 通过对比前后快照判定（与旧轮询逻辑兼容）。debounce 防止高频事件风暴。

const WATCH_DEBOUNCE_MS = 200;
const WATCH_SOURCE_EXTS = new Set(['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh', '.m', '.mm']);

function watchProject() {
  stopProjectWatcher();
  const dir = projectPath;
  if (!dir || !fs.existsSync(dir)) {
    emitLog('[watcher] skip, dir=' + dir);
    return;
  }
  let snapshot = snapshotProjectFiles(dir);
  writeCompileCommands(dir);

  let debounceTimer = null;

  const flushChanges = () => {
    debounceTimer = null;
    const next = snapshotProjectFiles(dir);
    const added = [];
    const removed = [];
    const modified = [];

    for (const [p, info] of next) {
      const prev = snapshot.get(p);
      if (!prev) added.push({ path: p, isDirectory: !!info.isDirectory });
      else if (prev.mtimeMs !== info.mtimeMs || prev.size !== info.size) modified.push({ path: p, isDirectory: !!info.isDirectory });
    }
    for (const [p, prevInfo] of snapshot) {
      if (!next.has(p)) removed.push({ path: p, isDirectory: !!(prevInfo && prevInfo.isDirectory) });
    }
    snapshot = next;
    if (projectWatcher) projectWatcher.snapshot = snapshot;

    if (!added.length && !removed.length && !modified.length) return;

    const sourceExts = new Set(WATCH_SOURCE_EXTS);
    const hasSourceChange = [...added, ...removed, ...modified].some((f) =>
      sourceExts.has(path.extname(typeof f === 'object' ? f.path : f).toLowerCase())
    );
    if (hasSourceChange) writeCompileCommands(dir);
    emitToRenderer('lsp:project-changed', { projectDir: dir, added, removed, modified });
  };

  let watcher;
  try {
    watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const ext = path.extname(filename).toLowerCase();
      if (ext === '.exe' || ext === '.o' || ext === '.tmp' || ext === '.swp') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushChanges, WATCH_DEBOUNCE_MS);
    });
  } catch (err) {
    emitLog('[watcher] fs.watch failed: ' + err.message + ', falling back to polling');
    watchProjectPolling(dir, snapshot, writeCompileCommands, emitToRenderer);
    return;
  }

  watcher.on('error', (err) => {
    emitLog('[watcher] error: ' + err.message);
  });

  projectWatcher = { watcher, snapshot, debounceTimer: null };
}

function watchProjectPolling(dir, initialSnapshot, writeFn, emitFn) {
  let snapshot = initialSnapshot;
  const timer = setInterval(() => {
    const next = snapshotProjectFiles(dir);
    if (setsEqual(next, snapshot)) return;
    const added = [];
    const removed = [];
    const modified = [];
    for (const [p, info] of next) {
      const prev = snapshot.get(p);
      if (!prev) added.push({ path: p, isDirectory: !!info.isDirectory });
      else if (prev.mtimeMs !== info.mtimeMs || prev.size !== info.size) modified.push({ path: p, isDirectory: !!info.isDirectory });
    }
    for (const p of snapshot.keys()) {
      if (!next.has(p)) {
        const prevInfo = snapshot.get(p);
        removed.push({ path: p, isDirectory: !!(prevInfo && prevInfo.isDirectory) });
      }
    }
    snapshot = next;
    if (projectWatcher) projectWatcher.snapshot = snapshot;
    const sourceExts = new Set(WATCH_SOURCE_EXTS);
    const hasSourceChange = [...added, ...removed, ...modified].some((f) =>
      sourceExts.has(path.extname(typeof f === 'object' ? f.path : f).toLowerCase())
    );
    if (hasSourceChange) writeFn(dir);
    emitFn('lsp:project-changed', { projectDir: dir, added, removed, modified });
  }, 1000);
  projectWatcher = { snapshot, timer };
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
    if (projectWatcher.watcher) {
      projectWatcher.watcher.close();
    }
    if (projectWatcher.timer) {
      clearInterval(projectWatcher.timer);
    }
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

  // 优先使用随应用分发的 clangd；预装版本缺失时回退到系统 PATH 中的 clangd，
  // 保证开发环境（尚未放置 resources/clangd）也能正常使用 LSP。
  let clangdPath = getClangdPath();
  if (!fs.existsSync(clangdPath)) {
    clangdPath = findSystemCommand('clangd') || clangdPath;
  }
  if (!fs.existsSync(clangdPath)) {
    emitStatus({
      state: 'error',
      message: '找不到 clangd，请确认 resources/clangd 目录存在，或安装系统 clangd: ' + clangdPath,
    });
    return {
      ok: false,
      message: '找不到 clangd 可执行文件: ' + clangdPath,
    };
  }
  ensureExecutable(clangdPath);

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
      fallbackFlags: clangdFallbackFlags(),
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
      const compileChanged = patch.compile && typeof patch.compile === 'object';
      // 分组做合并（partial update）：渲染端可只提交部分字段（如文件树宽度），
      // 不会覆盖分组内其它设置。设置窗口提交完整分组时结果与整体替换一致。
      for (const key of ['compile', 'editor', 'templates', 'shortcuts']) {
        if (patch[key] && typeof patch[key] === 'object') {
          appSettings[key] = { ...(appSettings[key] || {}), ...patch[key] };
        }
      }
      // 括号匹配设置已精简为单一 autoMatchBrackets 总开关：清理废弃的旧字段
      if (appSettings.editor && typeof appSettings.editor === 'object') {
        for (const k of ['autoClosingBrackets', 'autoClosingQuotes', 'bracketPairColorization', 'matchBrackets']) {
          delete appSettings.editor[k];
        }
      }
      persistSettings();
      // 编译相关设置变化：
      // - 有项目：重建 compile_commands.json。clangd 会自行监控该文件变化并重载索引，
      //   只需通知渲染端发 didChangeWatchedFiles 让它立即生效，无需重启。
      // - 无项目：clangd 用的是启动时传入的 fallback 参数，必须重启才能更新。
      if (compileChanged) {
        if (projectPath) {
          writeCompileCommands(projectPath);
          emitToRenderer('lsp:compile-db-updated', path.join(projectPath, 'compile_commands.json'));
        } else {
          emitToRenderer('lsp:restart');
        }
      }
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

  // 渲染进程 Ctrl+S（未命名标签页首次保存）：弹出「另存为」对话框自选目录与文件名。
  // 默认目录为项目根目录（未设置项目时用文档目录），默认文件名为「未命名」。
  // 「保存类型」下拉用与文件树右键「新建」一致的类型列表生成，默认类型排在最前。
  ipcMain.handle('save:save-as', async (_event, content, suggestedName) => {
    if (typeof content !== 'string') {
      return { ok: false, message: '要保存的内容无效' };
    }
    const win = BrowserWindow.getAllWindows()[0];
    const defaultDir = projectPath || app.getPath('documents');
    const defaultName = (typeof suggestedName === 'string' && suggestedName.trim())
      ? suggestedName.trim()
      : '未命名';
    // 默认类型是「文件」（无扩展名）时：Windows 的另存为对话框会用「保存类型」里第一个
    // 带真实扩展名的选项来给无扩展名文件名自动补全。只要列表里混着 .cpp/.c/.h 等具体
    // 类型，无论「文件」是否排在最前，Windows 都会跳到第二个 C++ 文件并补上 .cpp。
    // 因此这类保存只给通配符过滤器（文件和所有文件），什么都不会自动补全。
    const defKey = appSettings.editor && appSettings.editor.defaultNewFileType;
    let filters;
    if (defKey === 'plain') {
      filters = [
        { name: '文件', extensions: ['*'] },
        { name: '所有文件', extensions: ['*'] },
      ];
    } else {
      const saveFileTypes = [
        { name: '.cpp 文件', extensions: ['cpp'] },
        { name: '.c 文件', extensions: ['c'] },
        { name: '.h 文件', extensions: ['h'] },
        { name: '.in 文件', extensions: ['in'] },
        { name: '.out 文件', extensions: ['out'] },
        { name: '.ans 文件', extensions: ['ans'] },
        { name: '文件', extensions: ['*'] },
      ];
      const byKey = { cpp: 0, c: 1, h: 2, in: 3, out: 4, ans: 5, plain: 6 };
      const pick = byKey[defKey] != null ? byKey[defKey] : 0;
      filters = saveFileTypes
        .map((f, i) => ({ name: f.name, extensions: f.extensions, i }))
        .sort((a, b) => (a.i === pick ? -1 : b.i === pick ? 1 : 0))
        .map(({ name, extensions }) => ({ name, extensions }));
      filters.push({ name: '所有文件', extensions: ['*'] });
    }
    const result = await dialog.showSaveDialog(win, {
      title: '保存新文件',
      defaultPath: path.join(defaultDir, defaultName),
      buttonLabel: '保存',
      filters,
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    try {
      fs.writeFileSync(result.filePath, content, 'utf8');
      updateSnapshotEntry(result.filePath);
      // 保存到项目目录内时重建编译数据库（若缺省），供 clangd 索引
      if (projectPath && isWithin(projectPath, result.filePath)) {
        writeCompileCommands(projectPath);
      }
      return {
        ok: true,
        path: result.filePath,
        projectDir: projectPath || path.dirname(result.filePath),
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
      // Linux 编译输出目录不显示在文件树中
      if (entry.name === BUILD_DIR_NAME) continue;
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
  // 单文件一次性读取的字节上限：超过则拒绝整块读入，
  // 防止 V8 字符串上限（0x1fffffe8 ≈ 512MB）在 buf.toString 时抛
  // “Cannot create a string longer than 0x1fffffe8 characters”。
  // 渲染端对 >524288000 的非图片文件应作为“文件过大”展示，避免整块读入。
  const MAX_READ_FILE_BYTES = 512 * 1024 * 1024;

  ipcMain.handle('file:read', async (_event, filePath) => {
    try {
      const resolved = path.resolve(filePath);
      // 大文件前置保护：超过 V8 字符串上限（0x1fffffe8，约 512MB）前就拒绝，
      // 避免 readFile 整块读入内存后 toString 抛 'Cannot create a string longer than 0x1fffffe8 characters'。
      // 图片走 base64 也会整块进内存，同样设上限；渲染端据此显示"文件过大"占位而非崩溃。
      let size = 0;
      try {
        size = fs.statSync(resolved).size;
        if (size > MAX_READ_FILE_BYTES) {
          return { ok: true, path: resolved, ext: path.extname(resolved).toLowerCase(), tooLarge: true, size };
        }
      } catch {
        /* 无法 stat 时交给下面 readFile 重新报错 */
      }
      const buf = await fs.promises.readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      let binary = IMAGE_EXTS.has(ext);
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

  // ---------------------------------------------------------------------------
  // 文件树操作：复制 / 剪切 / 粘贴 / 重命名 / 删除 / 资源管理器定位 / 新建。
  // 剪贴板文件使用 Electron 的 CF_HDROP（FileNameW），与 Windows 资源管理器互通。
  // 所有操作仅允许作用于项目目录内。
  // ---------------------------------------------------------------------------
  ipcMain.handle('filetree:copy', async (_event, paths) => {
    const list = sanitizeTreePaths(paths);
    if (!list.length) return { ok: false, message: '没有可复制的文件' };
    const r = await clipboardWriteFiles(list);
    if (!r.ok) return { ok: false, message: '写入剪贴板失败: ' + r.message };
    clipboardCut = false;
    return { ok: true, count: list.length };
  });

  ipcMain.handle('filetree:cut', async (_event, paths) => {
    const list = sanitizeTreePaths(paths);
    if (!list.length) return { ok: false, message: '没有可剪切的文件' };
    const r = await clipboardWriteFiles(list);
    if (!r.ok) return { ok: false, message: '写入剪贴板失败: ' + r.message };
    clipboardCut = true;
    return { ok: true, count: list.length };
  });

  ipcMain.handle('filetree:paste', async (_event, destDir) => {
    try {
      if (!destDir || !fs.statSync(destDir).isDirectory()) {
        return { ok: false, message: '目标文件夹无效' };
      }
    } catch {
      return { ok: false, message: '目标文件夹无效' };
    }
    const read = await clipboardReadFiles();
    if (!read.ok) return { ok: false, message: '读取剪贴板失败: ' + read.message };
    const sources = read.paths;
    if (!sources || !sources.length) return { ok: false, message: '剪贴板中没有文件' };
    const results = [];
    let failed = 0;
    for (const src of sources) {
      let isDirectory;
      try {
        isDirectory = fs.statSync(src).isDirectory();
      } catch {
        results.push({ src, ok: false, message: '源文件不存在' });
        failed++;
        continue;
      }
      const dest = uniqueDestPath(destDir, path.basename(src));
      if (isWithin(src, dest)) {
        results.push({ src, ok: false, message: '不能将文件夹复制到其自身内部' });
        failed++;
        continue;
      }
      try {
        if (clipboardCut) movePath(src, dest);
        else copyPathRecursive(src, dest);
        results.push({ src, dest, isDirectory, moved: !!clipboardCut, ok: true });
      } catch (err) {
        results.push({ src, ok: false, message: err.message });
        failed++;
      }
    }
    // 剪切（移动）成功后清空剪贴板，避免重复粘贴；部分失败也放弃移动标记
    if (clipboardCut) {
      clipboardCut = false;
      if (failed === 0) {
        clipboard.clear();
        clipboardFiles = [];
      }
    }
    return { ok: failed === 0, results };
  });

  ipcMain.handle('filetree:rename', (_event, oldPath, newName) => {
    if (typeof newName !== 'string' || !newName.trim()) return { ok: false, message: '文件名不能为空' };
    newName = newName.trim();
    if (INVALID_NAME_RE.test(newName)) return { ok: false, message: '文件名包含非法字符: ' + INVALID_NAME_DESC };
    if (newName === '.' || newName === '..') return { ok: false, message: '文件名不合法' };
    if (!oldPath || !fs.existsSync(oldPath)) return { ok: false, message: '源文件不存在' };
    const isDirectory = fs.statSync(oldPath).isDirectory();
    const dest = path.join(path.dirname(oldPath), newName);
    if (fs.existsSync(dest)) return { ok: false, message: '已存在同名文件或文件夹' };
    try {
      fs.renameSync(oldPath, dest);
      return { ok: true, oldPath, newPath: dest, isDirectory };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('filetree:delete', async (_event, paths, opts) => {
    const list = sanitizeTreePaths(paths);
    // 永久删除：调用方显式要求，或设置中关闭了「移入回收站」。
    // setting:save 合并 patch 到 appSettings.editor，缺省视为 true（移入回收站）。
    const permanent =
      (opts && opts.permanent === true) ||
      (appSettings.editor && appSettings.editor.deleteToRecycleBin === false);
    const results = [];
    let failed = 0;
    for (const p of list) {
      if (!fs.existsSync(p)) {
        results.push({ path: p, ok: false, message: '文件不存在' });
        failed++;
        continue;
      }
      try {
        if (permanent) {
          fs.rmSync(p, { recursive: true, force: true });
        } else {
          // 优先移入回收站（可恢复），失败时退回直接删除
          await shell.trashItem(p);
        }
        results.push({ path: p, ok: true });
      } catch {
        try {
          fs.rmSync(p, { recursive: true, force: true });
          results.push({ path: p, ok: true });
        } catch (err) {
          results.push({ path: p, ok: false, message: err.message });
          failed++;
        }
      }
    }
    return { ok: failed === 0, results };
  });

  ipcMain.handle('filetree:reveal', (_event, p) => {
    if (!p || !fs.existsSync(p)) return { ok: false, message: '文件不存在' };
    shell.showItemInFolder(p);
    return { ok: true };
  });

  ipcMain.handle('filetree:open-file', (_event, p) => {
    if (!p || !fs.existsSync(p)) return { ok: false, message: '文件不存在' };
    shell.openPath(p);
    return { ok: true };
  });

  // 新建文件：内容由渲染端按模板替换好（$FILE_NAME$ / $cursor$）后传入
  ipcMain.handle('filetree:create-file', (_event, dir, name, content) => {
    if (typeof name !== 'string' || !name.trim()) return { ok: false, message: '文件名不能为空' };
    name = name.trim();
    if (INVALID_NAME_RE.test(name)) return { ok: false, message: '文件名包含非法字符: ' + INVALID_NAME_DESC };
    if (name === '.' || name === '..') return { ok: false, message: '文件名不合法' };
    if (!dir || !fs.existsSync(dir)) return { ok: false, message: '目标文件夹无效' };
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) return { ok: false, message: '已存在同名文件' };
    try {
      fs.writeFileSync(dest, typeof content === 'string' ? content : '', 'utf8');
      updateSnapshotEntry(dest);
      return { ok: true, path: dest };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('filetree:create-dir', (_event, dir, name) => {
    if (typeof name !== 'string' || !name.trim()) return { ok: false, message: '文件夹名不能为空' };
    name = name.trim();
    if (INVALID_NAME_RE.test(name)) return { ok: false, message: '文件夹名包含非法字符: ' + INVALID_NAME_DESC };
    if (name === '.' || name === '..') return { ok: false, message: '文件夹名不合法' };
    if (!dir || !fs.existsSync(dir)) return { ok: false, message: '目标文件夹无效' };
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) return { ok: false, message: '已存在同名文件夹' };
    try {
      fs.mkdirSync(dest);
      updateSnapshotEntry(dest);
      return { ok: true, path: dest };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  // 编辑器复制/粘贴/剪切用文本剪贴板。sandbox 预加载脚本中无 clipboard 模块，故经主进程读写。
  ipcMain.handle('clipboard:read-text', () => clipboard.readText());
  ipcMain.handle('clipboard:write-text', (_event, text) => {
    clipboard.writeText(text);
    return { ok: true };
  });
  ipcMain.handle('clipboard:copy-path', (_event, filePath) => {
    clipboard.writeText(filePath);
    return { ok: true };
  });
}

// 校验文件树操作路径：仅允许项目目录内的绝对路径，去重
function sanitizeTreePaths(paths) {
  if (!Array.isArray(paths)) return [];
  const out = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const r = path.resolve(p);
    if (!projectPath || !isWithin(projectPath, r)) continue;
    const key = IS_WIN ? r.toLowerCase() : r;
    if (out.some((x) => (IS_WIN ? x.toLowerCase() : x) === key)) continue;
    out.push(r);
  }
  return out;
}

// 目标目录下生成不冲突的路径：同名自动追加 " (1)"、" (2)"...
function uniqueDestPath(destDir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let cand = path.join(destDir, name);
  let i = 1;
  while (fs.existsSync(cand)) {
    cand = path.join(destDir, base + ' (' + i + ')' + ext);
    i++;
  }
  return cand;
}

function copyPathRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src)) {
      copyPathRecursive(path.join(src, ent), path.join(dest, ent));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function movePath(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // 跨磁盘分区时 rename 抛 EXDEV，退化为复制后删除
    if (err && err.code === 'EXDEV') {
      copyPathRecursive(src, dest);
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Windows 剪贴板文件（CF_HDROP / FileNameW）
// Electron 28 没有 readFilePaths/writeFilePaths，且 writeBuffer('FileNameW')
// 只是写入 text/uri-list 字符串，资源管理器无法识别为文件粘贴。
// 因此借助 PowerShell 的 System.Windows.Forms.Clipboard::SetFileDropList /
// GetFileDropList 读写真正的 CF_HDROP，与资源管理器完全互通（仅 Windows）。
// ---------------------------------------------------------------------------
const CLIP_SCRIPT_DIR = () => path.join(app.getPath('temp'), 'cppeditor-clip');

const WRITE_CLIP_PS1 = `param([string]$listFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$paths = Get-Content -LiteralPath $listFile -Encoding UTF8
$col = New-Object System.Collections.Specialized.StringCollection
foreach ($p in $paths) { if ($p -and -not [string]::IsNullOrWhiteSpace($p)) { [void]$col.Add($p) } }
if ($col.Count -gt 0) { [System.Windows.Forms.Clipboard]::SetFileDropList($col) }
Write-Output ('OK:' + $col.Count)`;

const READ_CLIP_PS1 = `$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $col = [System.Windows.Forms.Clipboard]::GetFileDropList()
  foreach ($p in $col) { Write-Output $p }
}`;

function runClipboardScript(scriptFile, args) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, ...(args || [])],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, message: (stderr || err.message || '').trim().split(/\r?\n/)[0] });
        else resolve({ ok: true, output: stdout || '' });
      }
    );
  });
}

function parseUriList(text) {
  const paths = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      paths.push(fileURLToPath(line));
    } catch {
      // 非 file:// URI 或普通路径：只接受绝对路径
      if (path.isAbsolute(line)) paths.push(line);
    }
  }
  return paths;
}

// 将文件路径列表写入系统剪贴板。Windows 使用 CF_HDROP（与资源管理器互通），
// Linux 使用标准 text/uri-list，并保留内存副本作为桌面环境兼容兜底。
async function clipboardWriteFiles(paths) {
  if (!IS_WIN) {
    try {
      const uriList = paths.map((p) => pathToFileURL(p).href).join('\r\n') + '\r\n';
      clipboard.writeBuffer('text/uri-list', Buffer.from(uriList, 'utf8'));
      clipboardFiles = [...paths];
      return { ok: true, count: paths.length };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  try {
    const dir = CLIP_SCRIPT_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const listFile = path.join(dir, 'list.txt');
    const scriptFile = path.join(dir, 'write.ps1');
    fs.writeFileSync(listFile, paths.join('\r\n'), 'utf8');
    if (!fs.existsSync(scriptFile)) fs.writeFileSync(scriptFile, WRITE_CLIP_PS1, 'utf8');
    const r = await runClipboardScript(scriptFile, ['-listFile', listFile]);
    if (!r.ok) return r;
    const m = /^OK:(\d+)/m.exec(r.output);
    return { ok: true, count: m ? Number(m[1]) : paths.length };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// 从系统剪贴板读取文件路径列表。返回 { ok, paths } / { ok:false, message }。
async function clipboardReadFiles() {
  if (!IS_WIN) {
    let paths = [];
    try {
      const buf = clipboard.readBuffer('text/uri-list');
      if (buf && buf.length) paths = parseUriList(buf.toString('utf8'));
    } catch {
      /* 剪贴板中没有该格式 */
    }
    if (!paths.length) paths = [...clipboardFiles];
    return { ok: true, paths };
  }

  try {
    const dir = CLIP_SCRIPT_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const scriptFile = path.join(dir, 'read.ps1');
    if (!fs.existsSync(scriptFile)) fs.writeFileSync(scriptFile, READ_CLIP_PS1, 'utf8');
    const r = await runClipboardScript(scriptFile);
    if (!r.ok) return { ok: false, message: r.message, paths: [] };
    const paths = r.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return { ok: true, paths };
  } catch (err) {
    return { ok: false, message: err.message, paths: [] };
  }
}

// ---------------------------------------------------------------------------
// 运行当前文件：用预装的 g++/gcc 编译 .cpp/.c，成功后启动编译产物。
// 设置中可选择改用系统 PATH 中的 g++/gcc；预装工具链始终随应用分发。
// ---------------------------------------------------------------------------
function getCompilerPath(name) {
  if (useSystemCompiler()) {
    const system = findSystemCommand(name);
    if (system) return system;
  }
  const bundled = findBundledTool(name);
  if (bundled) return bundled;
  // 预装版本缺失时回退系统 PATH
  return findSystemCommand(name) || name;
}

function getGxxPath() {
  return getCompilerPath('g++');
}

function getGccPath() {
  return getCompilerPath('gcc');
}

// 把空格分隔的参数字符串拆成数组（支持单/双引号包裹的含空格参数）
function splitArgs(str) {
  if (!str || typeof str !== 'string') return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

// 设置中的警告级别（0-4）→ 编译警告标志
const WARNING_LEVELS = [
  '-w',
  '-W',
  '-Wall',
  '-Wall -Wextra',
  '-Wall -Wextra -Wpedantic',
];

// 由设置拼出编译参数：语言标准 + 警告级别 + 用户自定义编译参数
function compileSettingsArgs(isC) {
  const c = appSettings.compile || {};
  const args = ['-std=' + (isC ? (c.languageStandardC || 'c11') : (c.languageStandardCpp || 'c++17'))];
  const warn = WARNING_LEVELS[Number(c.warningLevel)] || WARNING_LEVELS[2];
  args.push(...splitArgs(warn));
  args.push(...splitArgs(c.compilerCommand));
  return args;
}

// 由设置拼出链接参数（放在编译命令末尾）
function linkerSettingsArgs() {
  const c = appSettings.compile || {};
  return splitArgs(c.linkerCommand);
}

// clangd 的兜底编译参数（未命中 compile_commands.json 的文件使用，例如单独打开的
// 头文件）。基础头文件路径 + 设置中的警告级别/编译参数 + C++ 语言标准，保证头文件
// 的 __cplusplus 等宏与设置一致（.c 文件此时受标准限制，主场景是 C++）。
function clangdFallbackFlags() {
  const flags = buildBaseFlags();
  const c = appSettings.compile || {};
  flags.push(...splitArgs(WARNING_LEVELS[Number(c.warningLevel)] || WARNING_LEVELS[2]));
  flags.push(...splitArgs(c.compilerCommand));
  flags.push('-std=' + (c.languageStandardCpp || 'c++17'));
  return flags;
}

// 编译 / 运行子进程的环境变量：使用预装工具链时，把其 bin 和运行库目录
// 放到 PATH / LD_LIBRARY_PATH 最前面，确保能找到 libstdc++ 等动态库。
function compilerEnv(compilerPath) {
  const env = { ...process.env };
  const root = getToolchainRoot();
  if (!compilerPath || !path.isAbsolute(compilerPath) || !isWithin(root, compilerPath)) {
    return env;
  }

  const binDir = path.join(root, 'bin');
  env.PATH = binDir + path.delimiter + (env.PATH || '');

  if (!IS_WIN) {
    const libDirs = [path.join(root, 'lib'), path.join(root, 'lib64')];
    for (const triple of detectGccTriples(root)) {
      for (const version of findVersionDirs(path.join(root, 'lib', 'gcc', triple))) {
        libDirs.push(path.join(root, 'lib', 'gcc', triple, version));
      }
    }
    const existing = libDirs.filter((dir) => fs.existsSync(dir));
    const old = env.LD_LIBRARY_PATH;
    env.LD_LIBRARY_PATH = [...existing, old].filter(Boolean).join(path.delimiter);
  }
  return env;
}

// Linux 编译产物放到隐藏目录，避免出现在文件树中；Windows 保持 .exe 同目录。
function buildOutputPath(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  if (IS_WIN) return filePath.slice(0, filePath.length - ext.length) + '.exe';
  return path.join(dir, BUILD_DIR_NAME, path.basename(filePath, ext));
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

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function spawnDetached(command, args, options) {
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (ok && child) {
        try {
          child.unref();
        } catch {
          /* ignore */
        }
      }
      resolve(ok);
    };
    try {
      child = spawn(command, args, options);
    } catch {
      resolve(false);
      return;
    }
    child.once('spawn', () => finish(true));
    child.once('error', () => finish(false));
  });
}

function resolveTerminalCommand(command) {
  if (!command) return null;
  if (command.includes('/') || command.includes('\\')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  return findSystemCommand(command);
}

// Windows：经 cmd start 在新控制台窗口中运行 PowerShell 执行脚本，
// 前台运行 exe 并计时，结束后显示运行时间 + 按任意键继续。
function launchExeWindows(exePath, dir, srcPath, compilerPath) {
  try {
    const tmpDir = path.join(app.getPath('temp'), 'cppeditor-run');
    fs.mkdirSync(tmpDir, { recursive: true });
    const ps1Path = path.join(tmpDir, 'run-' + Date.now() + '.ps1');
    const esc = (s) => s.replace(/'/g, "''");
    // 标题用文件绝对路径，避免不同文件夹下的同名文件混淆
    const title = srcPath ? srcPath : exePath;
    const ps1 =
      "$ErrorActionPreference = 'Stop'\n" +
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" +
      "cmd /c chcp 65001 > $null\n" +
      "$exe = '" + esc(exePath) + "'\n" +
      "Set-Location '" + esc(dir) + "'\n" +
      "$Host.UI.RawUI.WindowTitle = '" + esc(title) + "'\n" +
      "$sw = [System.Diagnostics.Stopwatch]::StartNew()\n" +
      "& $exe\n" +
      "$code = $LASTEXITCODE\n" +
      "$sw.Stop()\n" +
      "Write-Host ''\n" +
      "Write-Host '--------------------------------'\n" +
      "Write-Host ('进程在{0:N3}秒后退出，返回值为{1}' -f $sw.Elapsed.TotalSeconds, $code)\n" +
      "cmd /c pause\n" +
      "exit $code\n";
    fs.writeFileSync(ps1Path, '\ufeff' + ps1, 'utf8');
    const cmdPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    // 注意：ps1Path 不在此处内嵌双引号。libuv 对含引号的参数会双写内部引号，
    // 导致 cmd 解析出错、ps1 无法执行；无引号的路径由 libuv 按需自动加引号。
    const child = spawn(
      cmdPath,
      ['/c', 'start', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
      {
        cwd: dir,
        env: compilerEnv(compilerPath),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    child.unref();
    // 清理历史临时脚本（保留刚创建的这个）
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        if (/^run-\d+\.ps1$/.test(f) && path.join(tmpDir, f) !== ps1Path) {
          fs.unlinkSync(path.join(tmpDir, f));
        }
      }
    } catch {
      /* ignore */
    }
  } catch (err) {
    return { ok: false, message: '启动程序失败: ' + err.message };
  }
  return { ok: true, exePath, message: '已启动: ' + exePath };
}

// Linux：自动选择一个可用的终端模拟器，在其中运行带计时 / 暂停的 bash 脚本。
// 若没有终端模拟器则明确报错，避免控制台程序在后台静默运行。
async function launchExeLinux(exePath, dir, srcPath, compilerPath) {
  const tmpDir = path.join(app.getPath('temp'), 'cppeditor-run');
  const scriptPath = path.join(tmpDir, 'run-' + Date.now() + '.sh');
  const title = srcPath ? srcPath : exePath;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const script =
      '#!/usr/bin/env bash\n' +
      'cd -- ' + shellQuote(dir) + ' || exit 1\n' +
      "printf '\\033]0;%s\\007' " + shellQuote(title) + '\n' +
      'start=$(date +%s%N)\n' +
      shellQuote(exePath) + '\n' +
      'code=$?\n' +
      'end=$(date +%s%N)\n' +
      "printf '\\n--------------------------------\\n'\n" +
      'awk -v s="$start" -v e="$end" -v c="$code" \'BEGIN { printf "进程在 %.3f 秒后退出，返回值为 %d\\n", (e-s)/1000000000, c }\'\n' +
      "printf '请按任意键继续...'\n" +
      'IFS= read -r -n 1 -s\n' +
      "printf '\\n'\n" +
      'exit "$code"\n';
    fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    ensureExecutable(scriptPath);
  } catch (err) {
    return { ok: false, message: '创建运行脚本失败: ' + err.message };
  }

  const candidates = [];
  // $TERMINAL 允许带参数，例如 TERMINAL="kitty --single-instance"。
  const envTerminal = splitArgs((process.env.TERMINAL || '').trim());
  if (envTerminal.length) {
    candidates.push({
      cmd: envTerminal[0],
      args: [...envTerminal.slice(1), '-e', 'bash', scriptPath],
    });
  }
  candidates.push(
    { cmd: 'x-terminal-emulator', args: ['-T', title, '-e', 'bash', scriptPath] },
    { cmd: 'gnome-terminal', args: ['--title', title, '--', 'bash', scriptPath] },
    { cmd: 'konsole', args: ['--title', title, '-e', 'bash', scriptPath] },
    { cmd: 'xfce4-terminal', args: ['--title', title, '--command', 'bash ' + shellQuote(scriptPath)] },
    { cmd: 'mate-terminal', args: ['--title', title, '-x', 'bash', scriptPath] },
    { cmd: 'tilix', args: ['--title', title, '-e', 'bash ' + shellQuote(scriptPath)] },
    { cmd: 'kitty', args: ['--title', title, 'bash', scriptPath] },
    { cmd: 'alacritty', args: ['--title', title, '-e', 'bash', scriptPath] },
    { cmd: 'xterm', args: ['-T', title, '-e', 'bash', scriptPath] }
  );

  for (const candidate of candidates) {
    const command = resolveTerminalCommand(candidate.cmd);
    if (!command) continue;
    const ok = await spawnDetached(command, candidate.args, {
      cwd: dir,
      env: compilerEnv(compilerPath),
      detached: true,
      stdio: 'ignore',
    });
    if (ok) {
      // 清理历史临时脚本（保留刚创建的这个）
      try {
        for (const f of fs.readdirSync(tmpDir)) {
          if (/^run-\d+\.sh$/.test(f) && f !== path.basename(scriptPath)) {
            fs.unlinkSync(path.join(tmpDir, f));
          }
        }
      } catch {
        /* ignore */
      }
      return { ok: true, exePath, message: '已启动: ' + exePath };
    }
  }

  return {
    ok: false,
    message: '未找到可用的终端模拟器（可安装 gnome-terminal / konsole / xterm，或设置 $TERMINAL）',
  };
}

function launchExecutable(exePath, dir, srcPath, compilerPath) {
  if (IS_WIN) return launchExeWindows(exePath, dir, srcPath, compilerPath);
  if (IS_LINUX) return launchExeLinux(exePath, dir, srcPath, compilerPath);

  try {
    const child = spawn(exePath, [], {
      cwd: dir,
      env: compilerEnv(compilerPath),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, exePath, message: '已启动: ' + exePath };
  } catch (err) {
    return { ok: false, message: '启动程序失败: ' + err.message };
  }
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
    ensureExecutable(compiler);
    const exePath = buildOutputPath(filePath);
    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(path.dirname(exePath), { recursive: true });
    } catch (err) {
      return { ok: false, message: '创建编译输出目录失败: ' + err.message };
    }
    // 编译前同步 compile_commands.json（当前项目存在时），确保 clangd 索引参数与本次编译一致
    if (projectPath && fs.existsSync(projectPath)) writeCompileCommands(projectPath);
    // 编译参数来自设置（语言标准/警告级别/自定义编译参数）+ 用户链接参数。
    // 不默认 -static：Windows 动态链接 mingw 运行时 DLL；Linux 使用预装 GCC 的
    // libstdc++，运行时由 compilerEnv() 提供 PATH / LD_LIBRARY_PATH。
    const args = [filePath, '-o', exePath, ...compileSettingsArgs(isC), ...linkerSettingsArgs()];

    let result;
    try {
      result = await runProcess(compiler, args, dir, compilerEnv(compiler));
    } catch (err) {
      return { ok: false, message: '无法启动编译器: ' + err.message };
    }
    if (result.code !== 0) {
      const output = (result.stderr || result.stdout || '').trim();
      return {
        ok: false,
        message: '编译失败' + (output ? ':\n' + output : ''),
        output,
      };
    }

    // 编译成功：g++ 的警告输出到 stderr，随返回值带给渲染进程在底部面板展示；
    // 警告不影响运行，直接启动程序，不再询问用户。
    const output = (result.stderr || result.stdout || '').trim();
    ensureExecutable(exePath);

    const launched = await launchExecutable(exePath, dir, filePath, compiler);
    return { ...launched, output };
  });
}

// ---------------------------------------------------------------------------
// 窗口与应用生命周期
// ---------------------------------------------------------------------------
function getWindowIcon() {
  const icon = path.join(APP_ROOT, 'build', 'icon.png');
  return fs.existsSync(icon) ? icon : undefined;
}

function createWindow() {
  let mainWindowState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 860
  });

  const e = appSettings.editor || {};
  const urlTheme = e.theme === 'light' ? 'light' : 'dark';
  const numParam = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const urlFont = numParam(e.fontSize, 14);
  const urlTreeFont = numParam(e.fileTreeFontSize, 14);
  const urlTreeWidth = numParam(e.fileTreeWidth, 300);

  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: urlTheme === 'light' ? '#fafafa' : '#1e1e1e',
    autoHideMenuBar: true,
    title: 'CppEditor',
    icon: getWindowIcon(),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindowState.manage(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 渲染完成后再显示窗口，避免启动时闪烁；超时兜底保证窗口始终能出现
  const showTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  }, 5000);
  mainWindow.once('ready-to-show', () => {
    clearTimeout(showTimer);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  mainWindow.loadURL(
    EDITOR_SCHEME + '://app/web/index.html?root=' + encodeURIComponent(APP_ROOT) +
    '&theme=' + urlTheme + '&fontSize=' + urlFont + '&treeFontSize=' + urlTreeFont +
    '&fileTreeWidth=' + urlTreeWidth
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

  // mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function createSettingWindow() {
  const urlTheme = appSettings.editor && appSettings.editor.theme === 'light' ? 'light' : 'dark';

  settingWindow = new BrowserWindow({
    width: 640,
    height: 620,
    minWidth: 520,
    minHeight: 560,
    show: false,
    backgroundColor: urlTheme === 'light' ? '#fafafa' : '#1e1e1e',
    autoHideMenuBar: true,
    title: '设置',
    icon: getWindowIcon(),
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

  const showTimer = setTimeout(() => {
    if (settingWindow && !settingWindow.isDestroyed()) settingWindow.show();
  }, 5000);
  settingWindow.once('ready-to-show', () => {
    clearTimeout(showTimer);
    if (settingWindow && !settingWindow.isDestroyed()) settingWindow.show();
  });

  settingWindow.loadURL(
      EDITOR_SCHEME + '://app/web/setting.html?root=' + encodeURIComponent(APP_ROOT) + '&theme=' + urlTheme
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

  // settingWindow.webContents.openDevTools({ mode: 'detach' });
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
