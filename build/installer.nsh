; Custom NSIS hooks for DSH Desktop.
;
; 1. The install directory is the user's decision. electron-builder emits the
;    directory page when allowToChangeInstallationDirectory is set; the app
;    itself does not care where it lives, because every writable path
;    (profiles, plugins, sessions, workspace, logs) is under %APPDATA% — never
;    next to the executable.
; 2. The choice has to survive an uninstall. electron-builder stores its own
;    InstallLocation under HKLM\Software\<app-guid>, and deletes that key
;    together with the uninstall entry — so re-installing after an uninstall
;    silently falls back to C:\Program Files and wipes the memory of where the
;    user wanted it. We keep a separate key and restore it in customInit.
;    /D=path on the command line still wins, so silent deployment is unaffected.
; 3. Uninstall must actually finish. The app spawns dsh as a child process using
;    the same executable image, so a running instance keeps files locked and the
;    uninstaller silently leaves junk behind. Kill it first — and remember that
;    customUnInstall runs *before* the files are removed, which is exactly why
;    the kill has to happen here.
; 4. User data is kept by default. Deleting profiles, plugins and sessions is a
;    deliberate choice, not a side effect of removing the program.

!macro customHeader
  ; The uninstaller build compiles this file too. Declaring a Var it never
  ; uses trips NSIS warning 6001, and electron-builder treats warnings as
  ; errors — so only declare it for the installer.
  !ifndef BUILD_UNINSTALLER
    Var dshLastInstallPath
  !endif
!macroend

!macro customInit
  ; Only a human picking from the UI gets the remembered path: in a silent
  ; install /D= has already been applied at this point and must not be undone.
  ${IfNot} ${Silent}
    ClearErrors
    ReadRegStr $dshLastInstallPath SHCTX "Software\DSH Desktop" "InstallPath"
    ClearErrors
    ${If} $dshLastInstallPath != ""
      StrCpy $INSTDIR $dshLastInstallPath
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ; "设置 → 应用" and Geek Uninstaller / Revo read InstallLocation from the
  ; Uninstall key to report where a program lives. electron-builder only writes
  ; it to its own key, which is why tools fall back to parsing UninstallString
  ; — that breaks the moment the user installs somewhere non-default.
  !ifdef UNINSTALL_REGISTRY_KEY
    WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
  !endif

  ; Remember the choice for the next install (see customInit).
  WriteRegStr SHCTX "Software\DSH Desktop" "InstallPath" "$INSTDIR"
!macroend

!macro customUnInstall
  ClearErrors
  ExecWait 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
  ; No matching process is a normal case, not an error worth aborting over.
  ClearErrors

  ; /SD IDNO matters: in a silent uninstall (Geek Uninstaller, winget,
  ; provisioning scripts) MessageBox is suppressed and would return an
  ; arbitrary default. With /SD the answer is explicitly "keep my data".
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否同时删除用户数据？$\r$\n$\r$\n包括：profile、插件、会话、工作区与日志。$\r$\n$\r$\n这些数据存放在 %APPDATA%\dsh-desktop，与安装位置无关。$\r$\n$\r$\n选择“否”将保留这些数据，日后重新安装后可继续使用。" \
    /SD IDNO IDNO keepData

  RMDir /r "$APPDATA\dsh-desktop"
  RMDir /r "$APPDATA\DSH Desktop"
  RMDir /r "$LOCALAPPDATA\dsh-desktop"
  RMDir /r "$LOCALAPPDATA\DSH Desktop"
  RMDir /r "$LOCALAPPDATA\dsh-desktop-updater"

  keepData:
  ClearErrors
!macroend
