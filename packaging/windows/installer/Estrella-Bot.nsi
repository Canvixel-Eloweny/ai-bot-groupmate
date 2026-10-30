; Estrella Bot - per-user NSIS installer (P2)
; ASCII-only on purpose: NSIS source encoding is safest when it stays ASCII.
; The version and appId come from version.nsh, generated from package.json.

Unicode true
!include "version.nsh"
SetCompressor /SOLID lzma
Name "Estrella Bot"
OutFile "Estrella-Bot-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\Estrella-Bot"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "InstallLocation"
RequestExecutionLevel user
XPStyle on
BrandingText "Estrella Bot ${APP_VERSION}"

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"

!insertmacro GetParameters
!insertmacro GetOptions

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "Estrella Bot"
VIAddVersionKey "CompanyName" "Estrella Bot contributors"
VIAddVersionKey "FileDescription" "Estrella Bot installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Estrella Bot contributors"

!define MUI_ABORTWARNING
!define MUI_ICON "stage\launcher\estrella-bot-v5.ico"
!define MUI_UNICON "stage\launcher\estrella-bot-v5.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "estrella-bot-header.bmp"
!define MUI_FINISHPAGE_RUN "$SYSDIR\wscript.exe"
!define MUI_FINISHPAGE_RUN_FUNCTION "LaunchApp"

!define MUI_PAGE_CUSTOMFUNCTION_PRE WelcomePre
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE LicensePre
!insertmacro MUI_PAGE_LICENSE "stage\LICENSE"
!define MUI_PAGE_CUSTOMFUNCTION_PRE DirectoryPre
!insertmacro MUI_PAGE_DIRECTORY
Page custom ComponentsPage ComponentsPageLeave
Page custom NapCatPage NapCatPageLeave
Page custom ImportPage ImportPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.UninstallDataPage un.UninstallDataPageLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; P7: every user-visible string lives in a LangString pair (EN + SimpChinese);
; the language chooser is MUI_LANGDLL_DISPLAY in .onInit (first page).
LangString CMP_TITLE ${LANG_ENGLISH} "Choose components"
LangString CMP_TITLE ${LANG_SIMPCHINESE} "选择组件"
LangString CMP_SUB ${LANG_ENGLISH} "Select shortcuts and optional components."
LangString CMP_SUB ${LANG_SIMPCHINESE} "选择快捷方式与可选组件。"
LangString CMP_DESKTOP ${LANG_ENGLISH} "Create a desktop shortcut"
LangString CMP_DESKTOP ${LANG_SIMPCHINESE} "创建桌面快捷方式"
LangString CMP_STARTMENU ${LANG_ENGLISH} "Create a Start menu shortcut"
LangString CMP_STARTMENU ${LANG_SIMPCHINESE} "创建开始菜单快捷方式"
LangString CMP_AUTOSTART ${LANG_ENGLISH} "Start Estrella Bot when I sign in"
LangString CMP_AUTOSTART ${LANG_SIMPCHINESE} "登录 Windows 时自动启动 Estrella Bot"
LangString CMP_UPGRADE_VERSION ${LANG_ENGLISH} "Installed version:"
LangString CMP_UPGRADE_VERSION ${LANG_SIMPCHINESE} "已安装版本："
LangString CMP_UPGRADE_BODY ${LANG_ENGLISH} "This is an in-place upgrade: your config, memory, plugins, persona and NapCat login state will be kept."
LangString CMP_UPGRADE_BODY ${LANG_SIMPCHINESE} "本次为覆盖升级：配置、记忆、插件、人格与 NapCat 登录态都会保留。"
LangString NAP_TITLE ${LANG_ENGLISH} "QQ protocol side (NapCat)"
LangString NAP_TITLE ${LANG_SIMPCHINESE} "QQ 协议端（NapCat）"
LangString NAP_SUB ${LANG_ENGLISH} "Estrella Bot does not ship NapCat. Choose where yours comes from."
LangString NAP_SUB ${LANG_SIMPCHINESE} "Estrella Bot 不内置 NapCat，请选择你的协议端从哪来。"
LangString NAP_INTRO ${LANG_ENGLISH} "NapCat is a separate program with its own licence, so it is not inside this installer. If you already have NapCat.Shell.zip - from the official releases page or from the Estrella Bot user group files - unzip it once and point this installer at the unzipped folder: the install then needs no Internet at all."
LangString NAP_INTRO ${LANG_SIMPCHINESE} "NapCat 是带自有许可的独立程序，因此不放在本安装器里。如果你已经有 NapCat.Shell.zip（官方发布页或 Estrella Bot 用户群文件），先解压一次，再让安装器指向解压出来的文件夹：整个过程完全不需要联网。"
LangString NAP_HAVE ${LANG_ENGLISH} "I already have a NapCat package on this computer"
LangString NAP_HAVE ${LANG_SIMPCHINESE} "我电脑上已经有 NapCat 的包"
LangString NAP_PICK ${LANG_ENGLISH} "Pick the unzipped folder..."
LangString NAP_PICK ${LANG_SIMPCHINESE} "选择已解压的文件夹…"
LangString NAP_HINT ${LANG_ENGLISH} "Pick the folder you unzipped NapCat.Shell.zip into (it must contain launcher-user.bat or NapCatWinBootMain.exe). Your original is copied, never moved or deleted. A .zip file itself is refused here on purpose: unzipping first is what keeps the install offline-safe."
LangString NAP_HINT ${LANG_SIMPCHINESE} "请选择解压 NapCat.Shell.zip 得到的文件夹（里面应有 launcher-user.bat 或 NapCatWinBootMain.exe）。你的原件只会被复制，不会被移动或删除。这里刻意不接受 .zip 文件：先解压才能保证离线安装可靠。"
LangString NAP_DL_SLOW ${LANG_ENGLISH} "No package handy - download it from GitHub now (about 35 MB; on a slow network this can take 10-20 minutes)"
LangString NAP_DL_SLOW ${LANG_SIMPCHINESE} "手上没有包 —— 现在从 GitHub 下载（约 35 MB；慢网可能要 10-20 分钟）"
LangString NAP_DL ${LANG_ENGLISH} "No package handy - download it now (never started in silent mode)"
LangString NAP_DL ${LANG_SIMPCHINESE} "手上没有包 —— 现在下载（静默安装永远不会走这条路）"
LangString DL_HINT ${LANG_ENGLISH} "Downloading NapCat (about 34 MB): please wait and do not close the installer..."
LangString DL_HINT ${LANG_SIMPCHINESE} "正在下载 NapCat（约 34 MB）：请稍候，不要关闭安装器…"
LangString DL_BANNER ${LANG_ENGLISH} "=== NapCat download starting (about 34 MB): progress and live speed print below; please wait, do not close the installer ==="
LangString DL_BANNER ${LANG_SIMPCHINESE} "=== 开始下载 NapCat（约 34 MB）：下方会持续显示进度与实时速度；请稍候，不要关闭安装器 ==="
LangString INST_SUB_RESTORE ${LANG_ENGLISH} "Installing Estrella Bot, please wait."
LangString INST_SUB_RESTORE ${LANG_SIMPCHINESE} "Estrella Bot 正在安装，请稍候。"
LangString NAP_MSG_EMPTY ${LANG_ENGLISH} "Tick the download box, or pick the unzipped NapCat folder you already have."
LangString NAP_MSG_EMPTY ${LANG_SIMPCHINESE} "请勾选联网下载，或选择你已经解压好的 NapCat 文件夹。"
LangString NAP_MSG_UNZIP ${LANG_ENGLISH} "Please unzip NapCat.Shell.zip first, then pick the unzipped folder (the one containing launcher-user.bat)."
LangString NAP_MSG_UNZIP ${LANG_SIMPCHINESE} "请先解压 NapCat.Shell.zip，然后选择解压出来的文件夹（里面有 launcher-user.bat 的那一层）。"
LangString NAP_MSG_NOFOLDER ${LANG_ENGLISH} "That folder does not exist. Pick the unzipped NapCat folder (the one containing launcher-user.bat)."
LangString NAP_MSG_NOFOLDER ${LANG_SIMPCHINESE} "这个文件夹不存在。请选择解压出来的 NapCat 文件夹（里面有 launcher-user.bat 的那一层）。"
LangString IMP_TITLE ${LANG_ENGLISH} "Import old data"
LangString IMP_TITLE ${LANG_SIMPCHINESE} "导入旧数据"
LangString IMP_SUB ${LANG_ENGLISH} "Optional. Old data is copied, never moved or deleted."
LangString IMP_SUB ${LANG_SIMPCHINESE} "可选。旧数据只复制，不移动、不删除。"
LangString IMP_LABEL ${LANG_ENGLISH} "If you used an older portable package, choose its folder. Config, data, plugins, persona and NapCat login state will be copied. Existing files are kept."
LangString IMP_LABEL ${LANG_SIMPCHINESE} "如果你用过旧的便携包，选择它的目录。配置、数据、插件、人格与 NapCat 登录态都会被复制；已存在的文件保留。"
LangString IMP_BROWSE ${LANG_ENGLISH} "Browse..."
LangString IMP_BROWSE ${LANG_SIMPCHINESE} "浏览…"
LangString ERR_RO ${LANG_ENGLISH} "The installation folder is not writable. Choose a folder under your user profile."
LangString ERR_RO ${LANG_SIMPCHINESE} "安装目录不可写。请选择用户目录下的文件夹。"
LangString ERR_STOP ${LANG_ENGLISH} "Could not stop the running app (exit $0). Close it and try again."
LangString ERR_STOP ${LANG_SIMPCHINESE} "无法停止正在运行的程序（退出码 $0）。请先关闭它再重试。"
LangString ERR_INSTALL ${LANG_ENGLISH} "Installation failed (exit $0). See $INSTDIR\versions\.txn.json and $UserRoot\update\logs."
LangString ERR_INSTALL ${LANG_SIMPCHINESE} "安装失败（退出码 $0）。见 $INSTDIR\versions\.txn.json 与 $UserRoot\update\logs。"
LangString ERR_BOOTSTRAP ${LANG_ENGLISH} "Estrella Bot was installed, but first-run setup failed (exit $0). Rerun this installer to retry."
LangString ERR_BOOTSTRAP ${LANG_SIMPCHINESE} "Estrella Bot 已安装，但首次配置失败（退出码 $0）。重新运行本安装器可重试。"
LangString ERR_NAPCAT_UNVERIFIED ${LANG_ENGLISH} "NapCat was installed from the file you picked, but its SHA-256 is not in our known-good list. It is recorded as unverified, so a later update will not overwrite it silently. Details: userdata\napcat\INSTALLED.json"
LangString ERR_NAPCAT_UNVERIFIED ${LANG_SIMPCHINESE} "NapCat 已从你选择的包装上，但它的 SHA-256 不在已知-good 清单里，已记为未验证，日后更新不会静默覆盖它。详情：userdata\napcat\INSTALLED.json"
LangString ERR_NAPCAT_SLOW ${LANG_ENGLISH} "NapCat was not installed: the download was too slow, so this installer stopped waiting instead of hanging. Estrella Bot itself is installed and works. Later: open the console, or rerun this installer and pick a NapCat.Shell.zip you already have."
LangString ERR_NAPCAT_SLOW ${LANG_SIMPCHINESE} "NapCat 没有装上：下载太慢，安装器选择停下等待而不是挂死。Estrella Bot 本体已装好可用。之后可在控制台里补，或重跑安装器并选择一个已解压好的 NapCat 包。"
LangString ERR_NAPCAT_REFUSED ${LANG_ENGLISH} "NapCat was not installed: the file or folder you picked was refused. Pick the folder that directly contains launcher-user.bat (not its parent, and not one of our own folders). Estrella Bot itself is installed and works."
LangString ERR_NAPCAT_REFUSED ${LANG_SIMPCHINESE} "NapCat 没有装上：你选择的文件或文件夹被拒绝。请选择直接包含 launcher-user.bat 的那一层文件夹（不要选它的上级，也不要选我们自己的目录）。Estrella Bot 本体已装好可用。"
LangString ERR_NAPCAT_FAILED ${LANG_ENGLISH} "NapCat was not installed: the download or placement did not finish. Estrella Bot itself is installed and works. Details: userdata\update\napcat-status.txt"
LangString ERR_NAPCAT_FAILED ${LANG_SIMPCHINESE} "NapCat 没有装上：下载或放置没有完成。Estrella Bot 本体已装好可用。详情：userdata\update\napcat-status.txt"
LangString ERR_NAPCAT_DONE_UNVERIFIED ${LANG_ENGLISH} "NapCat was installed from the folder you picked, but this copy has no official hash. It is recorded as unverified, so a later update will not overwrite it silently."
LangString ERR_NAPCAT_DONE_UNVERIFIED ${LANG_SIMPCHINESE} "NapCat 已用你选择的文件夹装好，但这份拷贝没有官方哈希。已记为未验证，日后更新不会静默覆盖它。"
LangString UN_TITLE ${LANG_ENGLISH} "Remove user data?"
LangString UN_TITLE ${LANG_SIMPCHINESE} "是否删除用户数据？"
LangString UN_SUB ${LANG_ENGLISH} "The default is to keep your config, chats and NapCat login."
LangString UN_SUB ${LANG_SIMPCHINESE} "默认保留你的配置、聊天记录与 NapCat 登录态。"
LangString UN_LABEL ${LANG_ENGLISH} "Estrella Bot keeps your configuration, data, plugins, persona and NapCat login state by default. They will survive this uninstall."
LangString UN_LABEL ${LANG_SIMPCHINESE} "Estrella Bot 默认保留配置、数据、插件、人格与 NapCat 登录态，卸载后它们仍在。"
LangString UN_CHECK ${LANG_ENGLISH} "Also delete all Estrella Bot user data (cannot be undone)"
LangString UN_CHECK ${LANG_SIMPCHINESE} "同时删除全部 Estrella Bot 用户数据（不可撤销）"
LangString UN_CONFIRM ${LANG_ENGLISH} "Delete all Estrella Bot user data? This cannot be undone."
LangString UN_CONFIRM ${LANG_SIMPCHINESE} "删除全部 Estrella Bot 用户数据？此操作不可撤销。"


Var Upgrade
Var UserRoot
Var InstalledVersion
Var DesktopShortcut
Var StartMenuShortcut
Var AutoStart
Var InstallNapCat
Var NapcatMode
Var NapcatPath
Var ImportFrom
Var DeleteUserData
Var CheckDesktop
Var CheckStartMenu
Var CheckAutoStart
Var CheckHaveNapcat
Var CheckAutoNapcat
Var NapEdit
Var BtnNapFolder
Var ImportEdit
Var ImportBrowse
Var UpgradeNote
Var UpgradeNoteText
Var NoteY

Function .onInit
  !insertmacro MUI_LANGDLL_DISPLAY
  ; nsExec children (install-commit / bootstrap / stop) see this and ASCII-sanitise
  ; their stdout: the instfiles details view decodes child bytes with the system
  ; codepage, so UTF-8 Chinese there renders as mojibake on Chinese Windows (P9).
  System::Call 'kernel32::SetEnvironmentVariableW(w "ESTRELLA_NSIS", w "1")'
  SetShellVarContext current
  StrCpy $Upgrade 0
  StrCpy $DesktopShortcut 1
  StrCpy $StartMenuShortcut 1
  StrCpy $AutoStart 0
  ; P6: NapCat is not inside this installer (its own licence says so). Downloading it
  ; during install used to be the default, and it looked exactly like a frozen
  ; installer - NSIS cannot move the progress bar while an external process runs,
  ; while the package itself needs 13-20 minutes on a measured slow network.
  ; Default is now "skip"; the NapCat page offers three routes (zip / folder / download).
  StrCpy $NapcatMode "skip"
  StrCpy $NapcatPath ""
  StrCpy $ImportFrom ""
  StrCpy $DeleteUserData 0
  StrCpy $InstalledVersion "?"

  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
    StrCpy $Upgrade 1
    ReadRegStr $InstalledVersion HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "DisplayVersion"
    ${If} $InstalledVersion == ""
      StrCpy $InstalledVersion "?"
    ${EndIf}
  ${EndIf}

  ReadRegStr $UserRoot HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "UserRoot"
  ${If} $UserRoot == ""
    StrCpy $UserRoot "$LOCALAPPDATA\EstrellaBot\userdata"
  ${EndIf}

  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/NAPCATZIP" $R1
  ${IfNot} ${Errors}
    StrCpy $NapcatMode "zip"
    ; GetOptions returns "=value" (measured on makensis 3.13): drop the leading "=",
    ; then one pair of surrounding quotes, so /NAPCATZIP="C:\a b\c.zip" also works.
    StrCpy $R2 $R1 1
    ${If} $R2 == "="
      StrCpy $R1 $R1 "" 1
    ${EndIf}
    StrCpy $R2 $R1 1
    ${If} $R2 == "$\""
      StrCpy $R1 $R1 "" 1
      StrCpy $R1 $R1 -1
    ${EndIf}
    StrCpy $NapcatPath "$R1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/NAPCATFOLDER" $R1
  ${IfNot} ${Errors}
    StrCpy $NapcatMode "folder"
    ; GetOptions returns "=value" (measured on makensis 3.13): drop the leading "=",
    ; then one pair of surrounding quotes, so /NAPCATFOLDER="C:\a b\c.zip" also works.
    StrCpy $R2 $R1 1
    ${If} $R2 == "="
      StrCpy $R1 $R1 "" 1
    ${EndIf}
    StrCpy $R2 $R1 1
    ${If} $R2 == "$\""
      StrCpy $R1 $R1 "" 1
      StrCpy $R1 $R1 -1
    ${EndIf}
    StrCpy $NapcatPath "$R1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/NAPCATSKIP" $R1
  ${IfNot} ${Errors}
    StrCpy $NapcatMode "skip"
    StrCpy $NapcatPath ""
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/INSTALLNAPCAT" $R1
  ${IfNot} ${Errors}
    ; kept working for existing scripts: /INSTALLNAPCAT means "download it now"
    ${If} $NapcatMode == "skip"
      StrCpy $NapcatMode "auto"
    ${EndIf}
  ${EndIf}
  ; Do NOT add a silent-mode fallback here that forces $NapcatMode back to "skip":
  ; (1) a silent install never shows NapCatPage, so the default at the top already covers it;
  ; (2) it would overwrite an explicit /NAPCATZIP= or /NAPCATFOLDER= (VM test 2026-10-18:
  ;     /S /NAPCATZIP=<zip> finished with status SKIPPED{mode=skip} -- offline placement dead).
  ; check-nsi rejects any IfSilent instruction inside .onInit.
  ${If} $NapcatMode == "skip"
    StrCpy $InstallNapCat 0
  ${Else}
    StrCpy $InstallNapCat 1
  ${EndIf}
FunctionEnd

Function WelcomePre
  ${If} $Upgrade == 1
    Abort
  ${EndIf}
FunctionEnd

Function LicensePre
  ${If} $Upgrade == 1
    Abort
  ${EndIf}
FunctionEnd

Function DirectoryPre
  ${If} $Upgrade == 1
    Abort
  ${EndIf}
FunctionEnd

Function ComponentsPage
  !insertmacro MUI_HEADER_TEXT "$(CMP_TITLE)" "$(CMP_SUB)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  StrCpy $NoteY 0
  ${If} $Upgrade == 1
    StrCpy $UpgradeNoteText "$(CMP_UPGRADE_VERSION) $InstalledVersion$\r$\n$(CMP_UPGRADE_BODY)"
    ${NSD_CreateLabel} 0 0 100% 34u "$UpgradeNoteText"
    Pop $UpgradeNote
    StrCpy $NoteY 48
  ${EndIf}

  ${NSD_CreateCheckbox} 0 $NoteY 100% 12u "$(CMP_DESKTOP)"
  Pop $CheckDesktop
  ${NSD_Check} $CheckDesktop
  IntOp $NoteY $NoteY + 16

  ${NSD_CreateCheckbox} 0 $NoteY 100% 12u "$(CMP_STARTMENU)"
  Pop $CheckStartMenu
  ${NSD_Check} $CheckStartMenu
  IntOp $NoteY $NoteY + 16

  ${NSD_CreateCheckbox} 0 $NoteY 100% 12u "$(CMP_AUTOSTART)"
  Pop $CheckAutoStart

  ${If} $Upgrade == 1
    GetDlgItem $0 $HWNDPARENT 3
    EnableWindow $0 0
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function ComponentsPageLeave
  ${NSD_GetState} $CheckDesktop $DesktopShortcut
  ${NSD_GetState} $CheckStartMenu $StartMenuShortcut
  ${NSD_GetState} $CheckAutoStart $AutoStart
FunctionEnd

; P6: the protocol side (NapCat) has its own licence, so it is not inside this
; installer. Three routes, and the fast one is first: a package the user already
; has works with no Internet at all, and the download route is bounded (it can be
; slow, but it can no longer hang).
Function NapCatPage
  ; Upgraders already have userdata\napcat - do not ask them again.
  ${If} $Upgrade == 1
    ${If} ${FileExists} "$UserRoot\napcat\*.*"
      Abort
    ${EndIf}
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(NAP_TITLE)" "$(NAP_SUB)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 40u "$(NAP_INTRO)"
  Pop $1

  ${NSD_CreateCheckbox} 0 46u 100% 12u "$(NAP_HAVE)"
  Pop $CheckHaveNapcat

  ${NSD_CreateText} 0 62u 56% 12u ""
  Pop $NapEdit
  ${NSD_CreateButton} 58% 62u 42% 12u "$(NAP_PICK)"
  Pop $BtnNapFolder
  ${NSD_OnClick} $BtnNapFolder NapPickFolderClick

  ${NSD_CreateLabel} 0 78u 100% 26u "$(NAP_HINT)"
  Pop $2

  ${If} $NapcatMode == "auto"
    ${NSD_CreateCheckbox} 0 108u 100% 24u "$(NAP_DL_SLOW)"
  ${Else}
    ${NSD_CreateCheckbox} 0 108u 100% 24u "$(NAP_DL)"
  ${EndIf}
  Pop $CheckAutoNapcat

  nsDialogs::Show
FunctionEnd


Function NapPickFolderClick
  Pop $0
  nsDialogs::SelectFolderDialog "Select the unzipped NapCat folder (it must contain launcher-user.bat)" "$PROFILE\Downloads"
  Pop $1
  ${If} $1 != error
    ${NSD_SetText} $NapEdit $1
    ${NSD_SetState} $CheckHaveNapcat ${BST_CHECKED}
    ${NSD_SetState} $CheckAutoNapcat ${BST_UNCHECKED}
  ${EndIf}
FunctionEnd

Function NapCatPageLeave
  ; Custom pages are not created in silent mode: reading the controls here would
  ; read handles that were never made. .onInit and the /NAPCAT* switches decided it.
  ${If} ${Silent}
    Return
  ${EndIf}
  ${NSD_GetState} $CheckHaveNapcat $0
  ${NSD_GetState} $CheckAutoNapcat $1
  ${NSD_GetText} $NapEdit $NapcatPath
  StrCpy $NapcatMode "skip"
  ${If} $0 == ${BST_CHECKED}
    ${If} $NapcatPath == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(NAP_MSG_EMPTY)"
      Abort
    ${EndIf}
    ; P7: a .zip picked here is refused with guidance (unzip first) - the group-test
    ; feedback was that the zip button looked like a route but was not one people
    ; could finish. The silent /NAPCATZIP= switch still serves scripts.
    ; FileExists "<path>\*.*" is how a *directory* is tested in NSIS.
    StrCpy $2 $NapcatPath -4
    ${If} $2 == ".zip"
    ${OrIf} $2 == ".ZIP"
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(NAP_MSG_UNZIP)"
      Abort
    ${EndIf}
    ${If} $NapcatPath != ""
      ${IfNot} ${FileExists} "$NapcatPath\*.*"
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(NAP_MSG_NOFOLDER)"
        Abort
      ${EndIf}
      StrCpy $NapcatMode "folder"
    ${EndIf}
  ${ElseIf} $1 == ${BST_CHECKED}
    StrCpy $NapcatMode "auto"
  ${EndIf}

  ${If} $NapcatMode == "skip"
    StrCpy $InstallNapCat 0
  ${Else}
    StrCpy $InstallNapCat 1
  ${EndIf}
FunctionEnd

Function ImportPage
  ${If} $Upgrade == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(IMP_TITLE)" "$(IMP_SUB)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 30u "$(IMP_LABEL)"
  Pop $1

  ${NSD_CreateText} 0 38u 76% 12u ""
  Pop $ImportEdit

  ${NSD_CreateButton} 78% 38u 22% 14u "$(IMP_BROWSE)"
  Pop $ImportBrowse
  ${NSD_OnClick} $ImportBrowse ImportBrowseClick

  nsDialogs::Show
FunctionEnd

Function ImportBrowseClick
  Pop $0
  nsDialogs::SelectFolderDialog "Select the old Estrella Bot / portable folder" ""
  Pop $1
  ${If} $1 != error
    ${NSD_SetText} $ImportEdit $1
  ${EndIf}
FunctionEnd

Function ImportPageLeave
  ${NSD_GetText} $ImportEdit $ImportFrom
FunctionEnd

Function LaunchApp
  Exec 'wscript.exe "$INSTDIR\launcher\Estrella-Bot.vbs"'
FunctionEnd

Section "Install"
  ClearErrors
  CreateDirectory "$INSTDIR"
  FileOpen $0 "$INSTDIR\.write-test" w
  IfErrors writeFail
  FileClose $0
  Delete "$INSTDIR\.write-test"
  Goto writeOk

  writeFail:
    MessageBox MB_ICONSTOP "$(ERR_RO)"
    Abort

  writeOk:
  SetOutPath "$INSTDIR\.stage-${APP_VERSION}"
  File /r "stage\*.*"

  ; Stop the running panel AND bot before replacing the shared runtime.
  nsExec::ExecToLog '"$INSTDIR\.stage-${APP_VERSION}\runtime\node\node.exe" "$INSTDIR\.stage-${APP_VERSION}\tools\stop.mjs" --install-root "$INSTDIR" --user-root "$UserRoot" --include-shell'
  Pop $0
  ${If} $0 != "0"
    IfSilent +2
    MessageBox MB_ICONSTOP "$(ERR_STOP)"
    SetErrorLevel 2
    ; Keep the stage on failure for diagnosis; the launcher cleans stale stages.
    Abort
  ${EndIf}

  nsExec::ExecToLog '"$INSTDIR\.stage-${APP_VERSION}\runtime\node\node.exe" "$INSTDIR\.stage-${APP_VERSION}\tools\install-commit.mjs" --install-root "$INSTDIR" --stage "$INSTDIR\.stage-${APP_VERSION}" --version "${APP_VERSION}" --user-root "$UserRoot" --import-from "$ImportFrom" --install-napcat "$InstallNapCat" --napcat-mode "$NapcatMode"'
  Pop $0
  ${If} $0 != "0"
    IfSilent +2
    MessageBox MB_ICONSTOP "$(ERR_INSTALL)"
    SetErrorLevel 2
    ; Keep the stage on failure for diagnosis; the launcher cleans stale stages.
    Abort
  ${EndIf}

  ; First-run config/migration/protocol side. Failure here is a warning, not a failed install.
  ; The NapCat route comes from the NapCat page: skip / zip / folder never touch the
  ; network; only "auto" downloads, and that download has its own time budget.
  ; P9: while that download runs the page looked frozen to group testers - the progress
  ; bar sits still for a long stretch. Say out loud (header subtitle + a banner line in
  ; the details view) that a download is in flight and how big it is.
  ${If} $NapcatMode == "auto"
    DetailPrint "$(DL_BANNER)"
    GetDlgItem $R0 $HWNDPARENT 1038
    SendMessage $R0 ${WM_SETTEXT} 0 "STR:$(DL_HINT)"
  ${EndIf}
  nsExec::ExecToLog '"$INSTDIR\runtime\node\node.exe" "$INSTDIR\tools\bootstrap.mjs" --install-root "$INSTDIR" --user-root "$UserRoot" --import-from "$ImportFrom" --install-napcat "$InstallNapCat" --napcat-mode "$NapcatMode" --napcat-src "$NapcatPath"'
  Pop $0
  ${If} $NapcatMode == "auto"
    GetDlgItem $R0 $HWNDPARENT 1038
    SendMessage $R0 ${WM_SETTEXT} 0 "STR:$(INST_SUB_RESTORE)"
  ${EndIf}
  ${If} $0 != "0"
    IfSilent +2
    MessageBox MB_ICONEXCLAMATION "$(ERR_BOOTSTRAP)"
  ${EndIf}

  ; One line of status so the outcome is not buried in the details view: the box used
  ; to sit still for many minutes here and looked exactly like a broken installer.
  ClearErrors
  StrCpy $R5 ""
  StrCpy $R6 ""
  FileOpen $0 "$UserRoot\update\napcat-status.txt" r
  IfErrors napcatStatusDone
  FileRead $0 $R5
  FileRead $0 $R7
  FileRead $0 $R6
  FileClose $0
  napcatStatusDone:
  ; 令牌清单的唯一真值在 tools/lib/napcat-local.mjs 的 NAPCAT_STATUS；
  ; check-wb §114 会把两边逐一对照 —— 少一个分支 = 那个失败完全静默。
  ; OK / SKIPPED 是**有意静默**（装好了 / 用户选了跳过）。
  ${If} $R5 == "MISMATCH"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(ERR_NAPCAT_UNVERIFIED)"
  ${ElseIf} $R5 == "SLOW"
    MessageBox MB_OK|MB_ICONINFORMATION "$(ERR_NAPCAT_SLOW)"
  ${ElseIf} $R5 == "REFUSED"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(ERR_NAPCAT_REFUSED)$\r$\n$\r$\n$R6"
  ${ElseIf} $R5 == "FAILED"
    MessageBox MB_OK|MB_ICONSTOP "$(ERR_NAPCAT_FAILED)$\r$\n$\r$\n$R6"
  ${ElseIf} $R5 == "UNVERIFIED"
    MessageBox MB_OK|MB_ICONINFORMATION "$(ERR_NAPCAT_DONE_UNVERIFIED)"
  ${EndIf}

  ; Delete once; file handles/Defender may block it, so retry after a second.
  RMDir /r "$INSTDIR\.stage-${APP_VERSION}"
  Sleep 1000
  RMDir /r "$INSTDIR\.stage-${APP_VERSION}"
  IfFileExists "$INSTDIR\.stage-${APP_VERSION}\*.*" stageStillThere
  Goto stageGone
  stageStillThere:
    nsExec::ExecToLog 'cmd /c rmdir /s /q "$INSTDIR\.stage-${APP_VERSION}"'
  stageGone:

  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; CreateShortCut uses the current SetOutPath as its working directory.
  SetOutPath "$INSTDIR"

  ${If} $DesktopShortcut == 1
    CreateShortCut "$DESKTOP\Estrella Bot.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher\Estrella-Bot.vbs"' "$INSTDIR\launcher\estrella-bot-v5.ico" 0
  ${EndIf}

  ${If} $StartMenuShortcut == 1
    CreateDirectory "$SMPROGRAMS\Estrella Bot"
    CreateShortCut "$SMPROGRAMS\Estrella Bot\Estrella Bot.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher\Estrella-Bot.vbs"' "$INSTDIR\launcher\estrella-bot-v5.ico" 0
    CreateShortCut "$SMPROGRAMS\Estrella Bot\Uninstall.lnk" "$INSTDIR\uninstall.exe"
  ${EndIf}

  ${If} $AutoStart == 1
    CreateShortCut "$SMSTARTUP\Estrella Bot.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher\Estrella-Bot.vbs"' "$INSTDIR\launcher\estrella-bot-v5.ico" 0
  ${EndIf}

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "DisplayName" "Estrella Bot"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "Publisher" "Estrella Bot contributors"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "DisplayIcon" "$INSTDIR\launcher\estrella-bot-v5.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "UserRoot" "$UserRoot"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "%u" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "EstimatedSize" $0
SectionEnd

Function un.onInit
  SetShellVarContext current
  StrCpy $DeleteUserData 0
  ReadRegStr $UserRoot HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "UserRoot"
  ${If} $UserRoot == ""
    StrCpy $UserRoot "$LOCALAPPDATA\EstrellaBot\userdata"
  ${EndIf}

  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/DELETEUSERDATA" $R1
  ${IfNot} ${Errors}
    StrCpy $DeleteUserData 1
  ${EndIf}
FunctionEnd

Function un.UninstallDataPage
  !insertmacro MUI_HEADER_TEXT "$(UN_TITLE)" "$(UN_SUB)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 34u "$(UN_LABEL)"
  Pop $1

  ${NSD_CreateCheckbox} 0 44u 100% 24u "$(UN_CHECK)"
  Pop $2

  nsDialogs::Show
FunctionEnd

Function un.UninstallDataPageLeave
  ${NSD_GetState} $2 $DeleteUserData
FunctionEnd

Section "Uninstall"
  ReadRegStr $UserRoot HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot" "UserRoot"
  ${If} $UserRoot == ""
    StrCpy $UserRoot "$LOCALAPPDATA\EstrellaBot\userdata"
  ${EndIf}

  ; Prefer the JS stop chain when the runtime is intact; the PowerShell fallback
  ; below still works if the program folder is damaged.
  IfFileExists "$INSTDIR\runtime\node\node.exe" 0 +4
    nsExec::ExecToLog '"$INSTDIR\runtime\node\node.exe" "$INSTDIR\tools\stop.mjs" --install-root "$INSTDIR" --user-root "$UserRoot" --stop-napcat --include-shell'
    Pop $0

  SetOutPath "$TEMP"
  File "uninstall-stop.ps1"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\uninstall-stop.ps1" "$INSTDIR" "$UserRoot"'
  Pop $0
  Delete "$TEMP\uninstall-stop.ps1"

  Delete "$DESKTOP\Estrella Bot.lnk"
  Delete "$SMPROGRAMS\Estrella Bot\Estrella Bot.lnk"
  Delete "$SMPROGRAMS\Estrella Bot\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Estrella Bot"
  Delete "$SMSTARTUP\Estrella Bot.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Estrella-Bot"

  ${If} $DeleteUserData == 1
    ${If} ${FileExists} "$UserRoot\.estrellabot-user-root"
      ${If} $UserRoot != "$PROFILE"
      ${AndIf} $UserRoot != "$WINDIR"
        StrLen $0 $UserRoot
        ${If} $0 > 3
          IfSilent doDataDelete
          MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(UN_CONFIRM)" IDNO skipDataDelete
          doDataDelete:
          RMDir /r "$UserRoot"
          skipDataDelete:
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  RMDir /r "$INSTDIR"
  Sleep 1000
  RMDir /r "$INSTDIR"
  IfFileExists "$INSTDIR\*.*" uninstallStillThere
  Goto uninstallGone
  uninstallStillThere:
    nsExec::ExecToLog 'cmd /c rmdir /s /q "$INSTDIR"'
  uninstallGone:
SectionEnd
