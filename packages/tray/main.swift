// Backlight Tray — 菜单栏指示器
// 空闲: ◌ 虚线圈 | AI 指令活动: ⚡ 闪烁数秒
// 编译: bash build.sh

import AppKit

let fileManager = FileManager.default
let homeDir = FileManager.default.homeDirectoryForCurrentUser.path

var dataRoot = ProcessInfo.processInfo.environment["BACKLIGHT_HOME"]
  ?? homeDir + "/Library/Application Support/Backlight"

func daemonPort() -> Int {
  if let env = ProcessInfo.processInfo.environment["BACKLIGHT_PORT"], let p = Int(env) { return p }
  let path = dataRoot + "/daemon.json"
  if let data = fileManager.contents(atPath: path),
     let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
     let port = obj["port"] as? Int { return port }
  return 9333
}

func apiGet(_ path: String, completion: @escaping (Data?) -> Void) {
  guard let url = URL(string: "http://127.0.0.1:\(daemonPort())\(path)") else { return }
  URLSession.shared.dataTask(with: url) { data, _, _ in completion(data) }.resume()
}

func apiPost(_ path: String) {
  guard let url = URL(string: "http://127.0.0.1:\(daemonPort())\(path)") else { return }
  var req = URLRequest(url: url)
  req.httpMethod = "POST"
  URLSession.shared.dataTask(with: req) { _, _, _ in }.resume()
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  var statusItem: NSStatusItem!
  var statusLine: NSMenuItem!
  var lastActivityTsMs = 0.0
  var blinkUntil = Date.distantPast
  var pollTimer: Timer?
  var iconTimer: Timer?
  var blinkOn = false
  var browserRunning = false

  let idleIcon = NSImage(systemSymbolName: "circle.dashed", accessibilityDescription: "Backlight idle")
  let activeIcon = NSImage(systemSymbolName: "bolt.circle.fill", accessibilityDescription: "Backlight activity")

  func applicationDidFinishLaunching(_ note: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.image = idleIcon

    let menu = NSMenu()
    menu.delegate = self
    statusLine = NSMenuItem(title: "状态: 检查中…", action: nil, keyEquivalent: "")
    statusLine.isEnabled = false
    menu.addItem(statusLine)
    menu.addItem(.separator())

    menu.addItem(menuItem("收起全部到后台", #selector(collapseAll(_:))))
    menu.addItem(menuItem("恢复窗口显示", #selector(restoreAll(_:))))
    menu.addItem(menuItem("打开控制台", #selector(openDashboard(_:))))
    menu.addItem(.separator())
    menu.addItem(menuItem("退出托盘", #selector(quit(_:))))
    statusItem.menu = menu

    pollTimer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { _ in self.poll() }
    iconTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in self.updateIcon() }

    // 用户点击 Dock 里的浏览器图标（应用被激活）→ 自动还原被收起的窗口，
    // 让"辅助登录/查看进度"像普通浏览器一样自然。按 PID 精确匹配我们的实例，
    // 用户自己的 Chrome 被激活时不会误触发。
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard let self,
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
            app.bundleIdentifier?.lowercased().contains("chrom") == true else { return }
      apiGet("/api/status") { [weak self] data in
        guard let self, let data,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let browser = obj["browser"] as? [String: Any],
              browser["running"] as? Bool == true,
              let pid = browser["pid"] as? Int else { return }
        if pid == app.processIdentifier {
          DispatchQueue.main.async { self.restoreAll(NSApplication.shared) }
        }
      }
    }
  }

  private func menuItem(_ title: String, _ action: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
    item.target = self
    return item
  }

  @objc func collapseAll(_ sender: Any) { apiPost("/api/bg") }
  @objc func restoreAll(_ sender: Any) { apiPost("/api/show") }
  @objc func openDashboard(_ sender: Any) {
    if let url = URL(string: "http://127.0.0.1:\(daemonPort())") {
      NSWorkspace.shared.open(url)
    }
  }
  @objc func quit(_ sender: Any) { NSApp.terminate(self) }

  func menuNeedsUpdate(_ menu: NSMenu) {
    statusLine.title = browserRunning ? "浏览器: 后台运行中" : "浏览器: 未运行"
  }

  func poll() {
    apiGet("/api/activity?limit=1") { [weak self] data in
      guard let self, let data,
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let events = obj["events"] as? [[String: Any]], let last = events.last,
            let ts = last["ts"] as? Double else {
        DispatchQueue.main.async { self?.browserRunning = false }
        return
      }
      let kind = last["kind"] as? String ?? ""
      let isRunning = (obj["events"] != nil)
      DispatchQueue.main.async {
        self.browserRunning = isRunning
        if kind == "ai-command" && ts > self.lastActivityTsMs {
          self.lastActivityTsMs = ts
          self.blinkUntil = Date().addingTimeInterval(4)
        }
      }
    }
  }

  func updateIcon() {
    let active = Date() < blinkUntil
    if active {
      blinkOn.toggle()
      statusItem.button?.image = blinkOn ? activeIcon : idleIcon
    } else {
      statusItem.button?.image = idleIcon
    }
    statusItem.button?.appearsDisabled = !browserRunning
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // no Dock icon even when run from CLI
app.run()
