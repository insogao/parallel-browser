// Backlight Launcher — Launchpad 入口
//
// 点击行为：读取 bundle 内的 launcher.json，然后以普通 CLI 路径执行
// `<node> <runtime>/packages/cli/bin/backlight.js login`。该命令会确保
// daemon 运行、确保使用品牌化 Backlight 引擎、启动或复用受管默认
// space/profile，并显示+最大化浏览器供人工登录。启动器本身不直接打开
// 隐藏引擎 app，也不会递归打开自己。
//
// 验证用：--print-config 输出 launcher.json；--selftest 校验 node/CLI/
// 引擎/日志目录是否存在，不启动 daemon 或浏览器。
import Foundation

let fm = FileManager.default
let bundleURL = Bundle.main.bundleURL
let configURL = bundleURL.appendingPathComponent("Contents/Resources/launcher.json")
let arguments = CommandLine.arguments

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(("Backlight launcher: " + message + "\n").data(using: .utf8)!)
  exit(2)
}

guard let configData = fm.contents(atPath: configURL.path),
      let config = (try? JSONSerialization.jsonObject(with: configData)) as? [String: Any] else {
  fail("missing or unreadable config at \(configURL.path)")
}

let logPath = (config["log"] as? String)
  ?? (NSHomeDirectory() + "/Library/Application Support/Backlight/logs/launcher.log")

/// O_APPEND so the launcher, the CLI child and repeated clicks never overwrite
/// each other's lines when they share the log file.
func openAppendHandle() -> FileHandle? {
  let fd = open(logPath, O_WRONLY | O_CREAT | O_APPEND, 0o644)
  guard fd >= 0 else { return nil }
  return FileHandle(fileDescriptor: fd, closeOnDealloc: false)
}

func appendLog(_ message: String) {
  let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
  guard let data = line.data(using: .utf8) else { return }
  let url = URL(fileURLWithPath: logPath)
  try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  if let handle = openAppendHandle() {
    handle.write(data)
    try? handle.close()
  } else {
    try? data.write(to: url, options: .atomic)
  }
}

func firstNodePath() -> String? {
  var candidates: [String] = []
  if let node = config["node"] as? String { candidates.append(node) }
  candidates.append(contentsOf: (config["nodeCandidates"] as? [String]) ?? [])
  candidates.append(contentsOf: ["/opt/homebrew/bin/node", "/usr/local/bin/node"])
  for candidate in candidates where fm.isExecutableFile(atPath: candidate) { return candidate }
  return nil
}

let cliPath = (config["cli"] as? String) ?? ""
let childArguments = (config["args"] as? [String]) ?? ["login"]
let enginePath = config["engine"] as? String

if arguments.contains("--print-config") {
  FileHandle.standardOutput.write(configData)
  exit(0)
}

if arguments.contains("--selftest") {
  var problems: [String] = []
  if firstNodePath() == nil {
    problems.append("node executable not found (config.node=\(config["node"] as? String ?? "?"))")
  }
  if !fm.isReadableFile(atPath: cliPath) {
    problems.append("cli not readable: \(cliPath)")
  }
  if let enginePath, !fm.fileExists(atPath: enginePath) {
    problems.append("engine missing: \(enginePath)")
  }
  do {
    try fm.createDirectory(at: URL(fileURLWithPath: logPath).deletingLastPathComponent(), withIntermediateDirectories: true)
  } catch {
    problems.append("log directory not writable: \(logPath)")
  }
  if problems.isEmpty {
    print("selftest ok: node=\(firstNodePath()!) cli=\(cliPath) engine=\(enginePath ?? "-") log=\(logPath)")
    exit(0)
  }
  print("selftest failed:\n- " + problems.joined(separator: "\n- "))
  exit(1)
}

guard let nodePath = firstNodePath() else {
  appendLog("error: no node executable found; tried \(config["node"] as? String ?? "?") and standard Homebrew paths")
  exit(1)
}
guard fm.isReadableFile(atPath: cliPath) else {
  appendLog("error: cli not readable: \(cliPath)")
  exit(1)
}

try? fm.createDirectory(at: URL(fileURLWithPath: logPath).deletingLastPathComponent(), withIntermediateDirectories: true)
if !fm.fileExists(atPath: logPath) { fm.createFile(atPath: logPath, contents: nil) }

appendLog("click: \(nodePath) \(cliPath) \(childArguments.joined(separator: " "))")

let process = Process()
process.executableURL = URL(fileURLWithPath: nodePath)
process.arguments = [cliPath] + childArguments
process.currentDirectoryURL = URL(fileURLWithPath: (config["home"] as? String) ?? NSHomeDirectory())
process.standardInput = FileHandle.nullDevice
if let logHandle = openAppendHandle() {
  process.standardOutput = logHandle
  process.standardError = logHandle
}

do {
  try process.run()
  appendLog("spawned pid \(process.processIdentifier); launcher exits")
  exit(0)
} catch {
  appendLog("error: failed to launch \(nodePath): \(error)")
  exit(1)
}
