// QQ-BOT-CONTROL —— 原生外壳
//
// 为什么需要它：真正的启动逻辑在 Contents/Resources/launcher.sh，但「可执行文件是
// 一个 bash 脚本」的 .app 在系统眼里不算应用（原来 Info.plist 里还标了 LSUIElement），
// 所以点 Dock 图标既不出图标也不弹跳，点了像没反应。
//
// 这层壳只做三件事，别的都不管：
//   1. 声明成普通应用（regular）→ Dock 出图标，系统按"应用启动"的规矩给它弹跳
//   2. 自己再弹三下（普通 App 的"跳跃"就是 requestUserAttention）
//   3. 把 launcher.sh 甩出去跑，等脚本报告「浏览器已经打开」后自己退出 ——
//      图标不会一直赖在 Dock 上
//
// 编译（改完这个文件要重跑，否则 .app 里还是旧的）：
//   swiftc -O -o "QQ-BOT-CONTROL.app/Contents/MacOS/launcher" scripts/launcher.swift
//
// 脚本必须 detach：本进程退出时不能被一起带走（下面用 nohup ... & 起）。

import AppKit

// 脚本位置从「可执行文件自己」推：Contents/MacOS/launcher → Contents/Resources/launcher.sh。
// 不用 Bundle.main.resourceURL，是因为直接从命令行跑这个二进制时它不是 bundle，
// 那样推出来的目录是 MacOS/，会找不到脚本。
let exeDir = URL(fileURLWithPath: CommandLine.arguments.first ?? "")
  .deletingLastPathComponent().resolvingSymlinksInPath()
let scriptPath = exeDir.deletingLastPathComponent()
  .appendingPathComponent("Resources").appendingPathComponent("launcher.sh").path

if !FileManager.default.isExecutableFile(atPath: scriptPath) {
  let msg = "找不到启动脚本：\(scriptPath)\n\n把 QQ-BOT-CONTROL.app 放回项目文件夹里再点一次。"
  let esc = msg.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
  p.arguments = ["-e", "display alert \"QQ-BOT-CONTROL 启动失败\" message \"\(esc)\""]
  try? p.run()
  p.waitUntilExit()
  exit(1)
}

// 脚本在「浏览器已打开」时创建这个文件；本进程看到它就收工。
// 放 /tmp 而不是项目里：项目目录可能被清理或只读，而这份标记本身就是一次性的。
let openedMarker = "/tmp/qqbot-control-opened"

let app = NSApplication.shared
// regular = 有 Dock 图标、算普通应用。accessory / 带 LSUIElement 的都不会弹跳。
app.setActivationPolicy(.regular)

func runScript() {
  try? FileManager.default.removeItem(atPath: openedMarker) // 清掉上一次留下的标记
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/bin/bash")
  p.arguments = ["-c", "nohup \"$1\" >/dev/null 2>&1 &", "bash", scriptPath]
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  try? p.run()
}

/// Dock 弹跳：一次请求 = 弹一下，弹三下就是"正在启动"的节奏
func bounce(times: Int) {
  guard times > 0 else { return }
  NSApp.requestUserAttention(.informationalRequest)
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.42) { bounce(times: times - 1) }
}

/// 等脚本把浏览器打开（最多 10 秒），然后退出 —— 图标在 Dock 上停留的时长
/// 正好等于「从点图标到页面出来」，和别的 App 一致。
func waitThenQuit(deadline: Date) {
  if FileManager.default.fileExists(atPath: openedMarker) || Date() > deadline {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { NSApp.terminate(nil) }
    return
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { waitThenQuit(deadline: deadline) }
}

final class Delegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    runScript()
    bounce(times: 3)
    waitThenQuit(deadline: Date().addingTimeInterval(10))
  }
}

let delegate = Delegate()
app.delegate = delegate
app.run()
