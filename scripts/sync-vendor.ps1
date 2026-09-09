#!/usr/bin/env pwsh
# 复制 node_modules 中的 npm 包到 web/ 目录下，供 Electron 渲染进程离线使用
# 用法：npm run sync-vendor  或  .\scripts\sync-vendor.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Copy-Package($src, $dest, $label) {
    if (-not (Test-Path $src)) {
        Write-Error "找不到 $label 源目录: $src"
        exit 1
    }
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Copy-Item -Recurse -Force $src $dest
    $count = (Get-ChildItem -Recurse -File $dest).Count
    Write-Host "  $label : $count files -> $dest"
}

Write-Host "同步 npm 包到 web/ ..."

# monaco-editor: min/vs/ -> web/vs/
Copy-Package "$root\node_modules\monaco-editor\min\vs" "$root\web\vs" "monaco-editor"

# vscode-jsonrpc -> web/vendor/vscode-jsonrpc/
Copy-Package "$root\node_modules\vscode-jsonrpc" "$root\web\vendor\vscode-jsonrpc" "vscode-jsonrpc"

# vscode-languageserver-protocol -> web/vendor/vscode-languageserver-protocol/
Copy-Package "$root\node_modules\vscode-languageserver-protocol" "$root\web\vendor\vscode-languageserver-protocol" "vscode-languageserver-protocol"

# vscode-languageserver-types -> web/vendor/vscode-languageserver-types/
Copy-Package "$root\node_modules\vscode-languageserver-types" "$root\web\vendor\vscode-languageserver-types" "vscode-languageserver-types"

Write-Host "完成!"
