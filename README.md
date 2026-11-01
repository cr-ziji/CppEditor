# CppEditor
更现代的c++编辑器

## 开发与构建

```bash
npm install
npm start          # 开发运行
npm run dist:win   # Windows 安装包（NSIS）
npm run dist:linux # Linux 安装包（AppImage / deb）
```

`npm install` 会自动执行 `scripts/sync-vendor.js`，把 Monaco、vscode-jsonrpc 等
前端依赖同步到 `web/`，Windows / Linux / macOS 均可使用。

## 工具链目录

预装工具链是 git 忽略的，构建前需要放到对应目录：

```
resources/
  clangd/            # 两个平台共用此目录，按构建平台放入对应二进制
    bin/clangd       # Linux
    bin/clangd.exe   # Windows
  mingw/             # Windows 预装 GCC（MinGW-w64）
    bin/g++.exe
    bin/gcc.exe
    ...
  gcc/               # Linux 预装 GCC
    bin/g++          # 也兼容 g++-16 等带版本号的文件名
    bin/gcc
    include/c++/...
    lib/gcc/<triple>/<version>/...
```

Linux 与 Windows 的工具链版本应保持一致（clangd / GCC 使用同一版本），
这样 `compile_commands.json`、诊断结果和编译行为在两个平台上统一。

应用默认使用预装工具链；在「设置 → 编译 → G++ 来源」中可以切换为系统
`PATH` 中的 `g++/gcc`。切换不会移除或影响随应用分发的预装工具链。

Linux 运行程序时会自动选择 `x-terminal-emulator`、`gnome-terminal`、`konsole`、
`xfce4-terminal`、`xterm` 等终端模拟器；也可以通过 `$TERMINAL` 指定。
