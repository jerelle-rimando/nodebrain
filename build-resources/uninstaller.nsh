# NodeBrain uninstall cleanup — included by electron-builder (nsis.include).
#
# Uninstalling only removes the program folder by default. This asks what else
# to remove:
#   1. The downloaded local AI engine + model (%LOCALAPPDATA%\NodeBrain). A
#      cache, multi-GB, kept by default so a reinstall doesn't re-download it.
#   2. User data (%APPDATA%\NodeBrain + the vault secret in Credential
#      Manager): the database, stored credentials, recorded workflows, and the
#      per-site browser profiles with their session cookies. Kept by default;
#      removed only when the person ticks the box. It goes as one unit: the
#      database is unreadable without the vault secret kept beside it.
# And always removes things that are useless once the app is gone: Electron's
# rebuildable caches, the downloaded update installer, the launch-at-startup
# entry, and a leftover engine download zip.
#
# UPDATES MUST NEVER DELETE ANYTHING. Every update (auto-update or running a
# newer Setup over an existing install) runs the OLD uninstaller silently with
# --updated and /KEEP_APP_DATA (app-builder-lib templates/nsis/include/
# installUtil.nsh). Either flag means "this is an update": nothing below runs.
#
# Not touched: %USERPROFILE%\.ollama and %LOCALAPPDATA%\npm-cache — shared
# with a separately installed Ollama / Node.js, so we can't tell ours apart.
#
# Everything is behind BUILD_UNINSTALLER: this file is also included in the
# installer build, where unreferenced un.* functions and variables would be
# warnings (and electron-builder treats NSIS warnings as errors).

!ifdef BUILD_UNINSTALLER

!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh

Var nbIsUpdate          ; "1" = run as part of an update: do nothing
Var nbRemoveModel       ; "1" = remove %LOCALAPPDATA%\NodeBrain
Var nbRemoveUserData    ; "1" = remove %APPDATA%\NodeBrain + vault secret
Var nbModelSize         ; human-readable size, "" if the folder is absent
Var nbUserDataSize
Var nbModelCheckbox
Var nbUserDataCheckbox
Var nbLeftovers         ; paths that couldn't be removed, newline-separated

# ── Init: decide whether this is an update, before anything else ─────────────
!macro customUnInit
  StrCpy $nbIsUpdate "0"
  StrCpy $nbRemoveModel "0"
  StrCpy $nbRemoveUserData "0"
  StrCpy $nbLeftovers ""

  ${if} ${isUpdated}
    StrCpy $nbIsUpdate "1"
  ${endif}
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${ifNot} ${Errors}
    StrCpy $nbIsUpdate "1"
  ${endif}
  ClearErrors
!macroend

# ── Page: the two questions (replaces the uninstall welcome page) ────────────
# Function bodies live inside this macro so they compile after MUI2 is
# included (this file itself is included before the templates).
!macro customUnWelcomePage
  UninstPage custom un.nbCleanupPage un.nbCleanupPageLeave

  # Folder size as "2.4 GB" / "350 MB", or "" when the folder doesn't exist.
  # In: $0 = folder. Out: $0.
  Function un.nbFolderSize
    ${ifNot} ${FileExists} "$0\*.*"
      StrCpy $0 ""
      Return
    ${endif}
    ${GetSize} "$0" "/S=0M" $1 $2 $3
    ${if} $1 >= 1024
      IntOp $2 $1 * 10
      IntOp $2 $2 / 1024
      IntOp $3 $2 / 10
      IntOp $2 $2 % 10
      StrCpy $0 "$3.$2 GB"
    ${elseif} $1 < 1
      StrCpy $0 "less than 1 MB"
    ${else}
      StrCpy $0 "$1 MB"
    ${endif}
  FunctionEnd

  Function un.nbCleanupPage
    ${if} $nbIsUpdate == "1"
      Abort
    ${endif}

    !insertmacro nbUseCurrentUserShellContext
    StrCpy $0 "$LOCALAPPDATA\NodeBrain"
    Call un.nbFolderSize
    StrCpy $nbModelSize $0
    StrCpy $0 "$APPDATA\NodeBrain"
    Call un.nbFolderSize
    StrCpy $nbUserDataSize $0
    !insertmacro nbRestoreShellContext

    !insertmacro MUI_HEADER_TEXT "Uninstall ${PRODUCT_NAME}" "Choose what else to remove from this computer."

    nsDialogs::Create 1018
    Pop $R0
    ${if} $R0 == error
      Abort
    ${endif}

    ${NSD_CreateLabel} 0 0 100% 20u "${PRODUCT_NAME} will be removed. It also keeps some files outside the program folder. Tick anything you want removed too."
    Pop $R0

    ${if} $nbModelSize != ""
      ${NSD_CreateCheckbox} 0 28u 100% 12u "Remove the downloaded AI model and engine ($nbModelSize)"
      Pop $nbModelCheckbox
      ${NSD_CreateLabel} 12u 41u -12u 18u "Keep it if you might reinstall, so you don't have to download it again."
      Pop $R0
    ${else}
      StrCpy $nbModelCheckbox ""
      ${NSD_CreateLabel} 0 28u 100% 12u "No downloaded AI model or engine was found."
      Pop $R0
    ${endif}

    ${if} $nbUserDataSize != ""
      ${NSD_CreateCheckbox} 0 66u 100% 12u "Remove my workflows, saved passwords and site sign-ins ($nbUserDataSize)"
      Pop $nbUserDataCheckbox
      ${NSD_CreateLabel} 12u 79u -12u 34u "This includes the browser profiles ${PRODUCT_NAME} used for each site you recorded on, which hold your sign-in cookies for those sites. It can't be undone. Leave it unticked to keep everything for a reinstall."
      Pop $R0
    ${else}
      StrCpy $nbUserDataCheckbox ""
      ${NSD_CreateLabel} 0 66u 100% 12u "No workflows or saved data were found."
      Pop $R0
    ${endif}

    # Both unticked by default.
    nsDialogs::Show
  FunctionEnd

  Function un.nbCleanupPageLeave
    StrCpy $nbRemoveModel "0"
    StrCpy $nbRemoveUserData "0"
    ${if} $nbModelCheckbox != ""
      ${NSD_GetState} $nbModelCheckbox $R0
      ${if} $R0 == ${BST_CHECKED}
        StrCpy $nbRemoveModel "1"
      ${endif}
    ${endif}
    ${if} $nbUserDataCheckbox != ""
      ${NSD_GetState} $nbUserDataCheckbox $R0
      ${if} $R0 == ${BST_CHECKED}
        StrCpy $nbRemoveUserData "1"
      ${endif}
    ${endif}
  FunctionEnd

  # Removes $0 recursively; records it in $nbLeftovers if it's still there.
  Function un.nbRemoveDir
    ${ifNot} ${FileExists} "$0\*.*"
      Return
    ${endif}
    DetailPrint "Removing $0"
    RMDir /r "$0"
    ${if} ${FileExists} "$0\*.*"
      DetailPrint "Couldn't fully remove $0"
      StrCpy $nbLeftovers "$nbLeftovers$0$\r$\n"
    ${endif}
  FunctionEnd

  # Deletes HKCU Run values that launch this install's exe (Electron names the
  # value after the AppUserModelId, so match on the command instead of the
  # name), plus the matching Task Manager "startup approved" values.
  Function un.nbRemoveStartupEntry
    StrCpy $R2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrLen $R3 $R2
    StrCpy $R4 0
    ${do}
      ClearErrors
      EnumRegValue $R5 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $R4
      ${if} ${Errors}
      ${orIf} $R5 == ""
        ${break}
      ${endif}
      ReadRegStr $R6 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $R5
      # Commands are usually quoted: compare from after the opening quote.
      StrCpy $R7 $R6 1
      ${if} $R7 == '"'
        StrCpy $R6 $R6 "" 1
      ${endif}
      StrCpy $R6 $R6 $R3
      ${if} $R6 == $R2   ; StrCmp-based: case-insensitive
        DetailPrint "Removing launch-at-startup entry $R5"
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $R5
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" $R5
        # Same index now holds the next value.
      ${else}
        IntOp $R4 $R4 + 1
      ${endif}
    ${loop}
  FunctionEnd
!macroend

# ── Uninstall section hook (runs after the app-running check) ────────────────
!macro customUnInstall
  ${if} $nbIsUpdate != "1"
    !insertmacro nbUseCurrentUserShellContext

    # Always: rebuildable / useless-once-uninstalled.
    StrCpy $0 "$APPDATA\NodeBrain\Cache"
    Call un.nbRemoveDir
    StrCpy $0 "$APPDATA\NodeBrain\Code Cache"
    Call un.nbRemoveDir
    StrCpy $0 "$APPDATA\NodeBrain\GPUCache"
    Call un.nbRemoveDir
    StrCpy $0 "$APPDATA\NodeBrain\DawnGraphiteCache"
    Call un.nbRemoveDir
    StrCpy $0 "$APPDATA\NodeBrain\DawnWebGPUCache"
    Call un.nbRemoveDir
    StrCpy $0 "$LOCALAPPDATA\nodebrain-updater"
    Call un.nbRemoveDir
    Delete "$TEMP\nodebrain-ollama-engine-*.zip"
    Call un.nbRemoveStartupEntry

    ${if} $nbRemoveModel == "1"
      # Stop NodeBrain's own engine (a crash can orphan it) so its files aren't
      # locked. Matched by path: an Ollama the person installed separately,
      # which NodeBrain may have been reusing, is left running.
      DetailPrint "Stopping the local AI engine"
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$d = Join-Path $$env:LOCALAPPDATA 'NodeBrain\'; Get-CimInstance Win32_Process | ? { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, 'OrdinalIgnoreCase') } | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
      Pop $R0
      Sleep 1000
      StrCpy $0 "$LOCALAPPDATA\NodeBrain"
      Call un.nbRemoveDir
    ${endif}

    ${if} $nbRemoveUserData == "1"
      # Close any Chrome/Edge window NodeBrain opened on a site profile, or
      # the profile's files stay locked.
      DetailPrint "Closing NodeBrain browser windows"
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$d = Join-Path $$env:APPDATA 'NodeBrain\data\browser-profiles'; Get-CimInstance Win32_Process | ? { $$_.CommandLine -and $$_.CommandLine.IndexOf($$d, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
      Pop $R0
      Sleep 1000
      StrCpy $0 "$APPDATA\NodeBrain"
      Call un.nbRemoveDir
      # keytar stores it as a generic credential named "<service>/<account>".
      DetailPrint "Removing the saved-password key from Windows Credential Manager"
      nsExec::Exec `"$SYSDIR\cmdkey.exe" /delete:NodeBrain/vault-secret`
      Pop $R0
    ${endif}

    !insertmacro nbRestoreShellContext
  ${endif}
!macroend

# ── After uninstall: list anything that couldn't be removed ──────────────────
!macro customUninstallPage
  UninstPage custom un.nbLeftoversPage

  Function un.nbLeftoversPage
    ${if} $nbLeftovers == ""
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "Some files are still here" "They were in use and couldn't be removed."
    nsDialogs::Create 1018
    Pop $R0
    ${if} $R0 == error
      Abort
    ${endif}
    ${NSD_CreateLabel} 0 0 100% 20u "Close any open NodeBrain or browser windows, restart your computer, then delete these folders yourself:"
    Pop $R0
    nsDialogs::CreateControl EDIT ${DEFAULT_STYLES}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0 24u 100% -24u "$nbLeftovers"
    Pop $R0
    nsDialogs::Show
  FunctionEnd
!macroend

# Electron keeps app data per user even for an all-users install, where NSIS's
# $APPDATA/$LOCALAPPDATA would otherwise point at ProgramData. Same approach as
# app-builder-lib's own DELETE_APP_DATA_ON_UNINSTALL block.
!macro nbUseCurrentUserShellContext
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
!macroend

!macro nbRestoreShellContext
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

!endif
