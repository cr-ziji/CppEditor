#!/usr/bin/env node
'use strict';

// 复制 node_modules 中的前端依赖到 web/ 目录，供 Electron 渲染进程离线使用。
// 与 scripts/sync-vendor.ps1 功能一致，但可在 Windows / Linux / macOS 上运行。
// 用法：npm run sync-vendor

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function copyPackage(src, dest, label) {
  if (!fs.existsSync(src)) {
    console.error('找不到 ' + label + ' 源目录: ' + src);
    process.exitCode = 1;
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });

  let count = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else count++;
    }
  };
  walk(dest);
  console.log('  ' + label + ' : ' + count + ' files -> ' + dest);
}

console.log('同步 npm 包到 web/ ...');

copyPackage(
  path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs'),
  path.join(root, 'web', 'vs'),
  'monaco-editor'
);
copyPackage(
  path.join(root, 'node_modules', 'vscode-jsonrpc'),
  path.join(root, 'web', 'vendor', 'vscode-jsonrpc'),
  'vscode-jsonrpc'
);
copyPackage(
  path.join(root, 'node_modules', 'vscode-languageserver-protocol'),
  path.join(root, 'web', 'vendor', 'vscode-languageserver-protocol'),
  'vscode-languageserver-protocol'
);
copyPackage(
  path.join(root, 'node_modules', 'vscode-languageserver-types'),
  path.join(root, 'web', 'vendor', 'vscode-languageserver-types'),
  'vscode-languageserver-types'
);

if (process.exitCode) {
  console.error('同步失败。');
} else {
  console.log('完成!');
}
