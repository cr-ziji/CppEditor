; CppEditor 自定义 NSIS 脚本
;
; 1) 在选择安装目录之后插入一个"安装选项"页（4 个复选框，默认全部勾选）：
;    - 将 .c 文件关联到 CppEditor 打开
;    - 将 .cpp 文件关联到 CppEditor 打开
;    - 将 .h 文件关联到 CppEditor 打开
;    - 将 GCC (mingw) 的 bin 目录加入系统 PATH
; 2) 所有注册均基于用户选择的安装路径 $INSTDIR。
; 3) 卸载时自动移除文件关联与 PATH 条目。
;
; 关联图标统一使用应用图标：$INSTDIR\<应用名>.exe,0

; perMachine 安装不会自动引入 nsDialogs（multiUserUi.nsh 被跳过），此处显式引入。
; nsDialogs.nsh 自带 !ifndef NSDIALOGS_INCLUDED 保护，重复包含无副作用。
!include nsDialogs.nsh

; ---------- 复选框句柄与状态 ----------
!ifndef BUILD_UNINSTALLER
Var cppEdCBox
Var cppEdCppBox
Var cppEdHBox
Var cppEdPathBox
Var cppEdC
Var cppEdCpp
Var cppEdH
Var cppEdPath
!endif

; ---------- 默认行为：全部勾选（也用于静默安装） ----------
!macro customInit
  StrCpy $cppEdC "1"
  StrCpy $cppEdCpp "1"
  StrCpy $cppEdH "1"
  StrCpy $cppEdPath "1"
!macroend

; ---------- 在目录选择页之后插入选项页 ----------
!macro customPageAfterChangeDir
  Page custom cppEdPageCreate cppEdPageLeave
!macroend

!ifndef BUILD_UNINSTALLER
Function cppEdPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 16u "安装选项"
  Pop $0

  ${NSD_CreateCheckBox} 12u 30u 95% 14u "将 .c 文件关联到 CppEditor 打开"
  Pop $cppEdCBox
  ${If} $cppEdC == 1
    ${NSD_Check} $cppEdCBox
  ${EndIf}

  ${NSD_CreateCheckBox} 12u 48u 95% 14u "将 .cpp 文件关联到 CppEditor 打开"
  Pop $cppEdCppBox
  ${If} $cppEdCpp == 1
    ${NSD_Check} $cppEdCppBox
  ${EndIf}

  ${NSD_CreateCheckBox} 12u 66u 95% 14u "将 .h 文件关联到 CppEditor 打开"
  Pop $cppEdHBox
  ${If} $cppEdH == 1
    ${NSD_Check} $cppEdHBox
  ${EndIf}

  ${NSD_CreateCheckBox} 12u 84u 95% 14u "将 GCC 的 bin 目录加入系统 PATH（命令行可直接使用 gcc/g++）"
  Pop $cppEdPathBox
  ${If} $cppEdPath == 1
    ${NSD_Check} $cppEdPathBox
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function cppEdPageLeave
  ${NSD_GetState} $cppEdCBox $cppEdC
  ${NSD_GetState} $cppEdCppBox $cppEdCpp
  ${NSD_GetState} $cppEdHBox $cppEdH
  ${NSD_GetState} $cppEdPathBox $cppEdPath
FunctionEnd
!endif

; ---------- 扩展名关联 ----------
!macro CppEditorAssociateExt EXT PROGID DISPLAY
  ; 机器级（HKLM）
  ReadRegStr $0 HKLM "Software\Classes\.${EXT}" ""
  ${If} $0 != "${PROGID}"
    WriteRegStr HKLM "Software\Classes\.${EXT}" "${PROGID}_cppeditor_backup" "$0"
  ${EndIf}
  WriteRegStr HKLM "Software\Classes\.${EXT}" "" "${PROGID}"

  WriteRegStr HKLM "Software\Classes\${PROGID}" "" "${DISPLAY}"
  WriteRegStr HKLM "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKLM "Software\Classes\${PROGID}\shell" "" "open"
  WriteRegStr HKLM "Software\Classes\${PROGID}\shell\open" "" "Open with CppEditor"
  WriteRegStr HKLM "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; "打开方式"菜单可见性
  WriteRegStr HKLM "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.${EXT}\OpenWithProgids" "${PROGID}" ""

  ; 当前用户（HKCU 优先级高于 HKLM）
  ReadRegStr $0 HKCU "Software\Classes\.${EXT}" ""
  ${If} $0 != "${PROGID}"
    WriteRegStr HKCU "Software\Classes\.${EXT}" "${PROGID}_cppeditor_backup" "$0"
  ${EndIf}
  WriteRegStr HKCU "Software\Classes\.${EXT}" "" "${PROGID}"
!macroend

!macro CppEditorUnassociateExt EXT PROGID
  ReadRegStr $0 HKLM "Software\Classes\.${EXT}" ""
  ${If} $0 == "${PROGID}"
    ReadRegStr $1 HKLM "Software\Classes\.${EXT}" "${PROGID}_cppeditor_backup"
    WriteRegStr HKLM "Software\Classes\.${EXT}" "" "$1"
  ${EndIf}
  DeleteRegValue HKLM "Software\Classes\.${EXT}" "${PROGID}_cppeditor_backup"
  DeleteRegKey HKLM "Software\Classes\${PROGID}"
  DeleteRegValue HKLM "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.${EXT}\OpenWithProgids" "${PROGID}"

  ReadRegStr $0 HKCU "Software\Classes\.${EXT}" ""
  ${If} $0 == "${PROGID}"
    ReadRegStr $1 HKCU "Software\Classes\.${EXT}" "${PROGID}_cppeditor_backup"
    WriteRegStr HKCU "Software\Classes\.${EXT}" "" "$1"
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.${EXT}" "${PROGID}_cppeditor_backup"
!macroend

; ---------- 系统 PATH ----------
; 卸载器中的函数必须以 "un." 为前缀，且未引用的 un. 函数会被当作警告（warningsAsErrors），
; 因此每个函数只在其被使用的构建中定义：
;   - cppEdAddGccBinToPath        仅在安装器中调用
;   - cppEdRemoveGccBinFromPath   仅在卸载器中调用
;   - cppEdStrRemoveSubstring     两个构建都用到（各自一份）

; 从 $0 中删除所有 $1 子串，结果写回 $0
!macro cppEdDefineStrRemoveSubstring FN_PREFIX
Function ${FN_PREFIX}cppEdStrRemoveSubstring
  StrLen $4 $1
  StrLen $6 $0
  StrCpy $5 ""
  StrCpy $3 0
  cppEdRemLoop:
    IntCmp $3 $6 cppEdRemDone
    StrCpy $7 $0 $4 $3
    StrCmp $7 $1 cppEdRemSkip
    StrCpy $7 $0 1 $3
    StrCpy $5 "$5$7"
    IntOp $3 $3 + 1
    Goto cppEdRemLoop
  cppEdRemSkip:
    IntOp $3 $3 + $4
    Goto cppEdRemLoop
  cppEdRemDone:
    StrCpy $0 $5
FunctionEnd
!macroend

!macro cppEdDefineRemoveGccBinFromPath FN_PREFIX
Function ${FN_PREFIX}cppEdRemoveGccBinFromPath
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ${If} $0 == ""
    Return
  ${EndIf}
  StrCpy $1 "$INSTDIR\resources\mingw\bin"
  StrCpy $2 $0
  Call ${FN_PREFIX}cppEdStrRemoveSubstring
  ${If} $0 == $2
    Return
  ${EndIf}

  StrCpy $1 "$INSTDIR\resources\mingw\bin;"
  Call ${FN_PREFIX}cppEdStrRemoveSubstring
  StrCpy $1 ";$INSTDIR\resources\mingw\bin"
  Call ${FN_PREFIX}cppEdStrRemoveSubstring
  StrCpy $1 ";;"
  Call ${FN_PREFIX}cppEdStrRemoveSubstring

  StrCpy $3 $0 1
  StrCmp $3 ";" 0 +3
  StrCpy $0 $0 "" 1
  StrLen $4 $0
  IntOp $4 $4 - 1
  StrCpy $3 $0 1 $4
  StrCmp $3 ";" 0 +3
  StrCpy $0 $0 $4

  ${If} $0 == ""
    DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ${Else}
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" $0
  ${EndIf}
  System::Call `user32::SendMessageTimeout(i 0xFFFF, i 0x001A, i 0, w "Environment", i 2, i 5000, *l .r2) i .r3`
FunctionEnd
!macroend

!ifdef BUILD_UNINSTALLER
  !insertmacro cppEdDefineStrRemoveSubstring "un."
  !insertmacro cppEdDefineRemoveGccBinFromPath "un."
!else
  !insertmacro cppEdDefineStrRemoveSubstring ""
!endif

!ifndef BUILD_UNINSTALLER
Function cppEdAddGccBinToPath
  StrCpy $1 "$INSTDIR\resources\mingw\bin"
  ${IfNot} ${FileExists} "$1"
    Return
  ${EndIf}
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ${If} $0 == ""
    StrCpy $0 "$1"
    Goto cppEdPathWrite
  ${EndIf}
  StrCpy $2 $0
  Call cppEdStrRemoveSubstring
  ${If} $0 != $2
    Return
  ${EndIf}
  StrCpy $0 "$2;$1"
  cppEdPathWrite:
  WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" $0
  System::Call `user32::SendMessageTimeout(i 0xFFFF, i 0x001A, i 0, w "Environment", i 2, i 5000, *l .r2) i .r3`
FunctionEnd
!endif

; ---------- 安装时 ----------
!macro customInstall
  ${If} $cppEdC == 1
    !insertmacro CppEditorAssociateExt "c" "C Source File" "C Source File"
  ${EndIf}
  ${If} $cppEdCpp == 1
    !insertmacro CppEditorAssociateExt "cpp" "C++ Source File" "C++ Source File"
  ${EndIf}
  ${If} $cppEdH == 1
    !insertmacro CppEditorAssociateExt "h" "C/C++ Header File" "C/C++ Header File"
  ${EndIf}

  ${If} $cppEdC == 1
  ${OrIf} $cppEdCpp == 1
  ${OrIf} $cppEdH == 1
    WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "${PRODUCT_NAME}"
    WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
    WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "ApplicationName" "${PRODUCT_NAME}"
    WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".c" ""
    WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".cpp" ""
    WriteRegStr HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".h" ""
  ${EndIf}

  ${If} $cppEdPath == 1
    Call cppEdAddGccBinToPath
  ${EndIf}

  System::Call "shell32::SHChangeNotify(i, i, i, i) (0x08000000, 0x1000, 0, 0)"
!macroend

; ---------- 卸载时 ----------
!macro customUnInstall
  !insertmacro CppEditorUnassociateExt "c" "C Source File"
  !insertmacro CppEditorUnassociateExt "cpp" "C++ Source File"
  !insertmacro CppEditorUnassociateExt "h" "C/C++ Header File"
  DeleteRegKey HKLM "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  Call un.cppEdRemoveGccBinFromPath
  System::Call "shell32::SHChangeNotify(i, i, i, i) (0x08000000, 0x1000, 0, 0)"
!macroend
