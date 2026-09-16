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

func apiPost(_ path: String, body: String = "{}") {
  guard let url = URL(string: "http://127.0.0.1:\(daemonPort())\(path)") else { return }
  var req = URLRequest(url: url)
  req.httpMethod = "POST"
  req.setValue("application/json", forHTTPHeaderField: "Content-Type")
  req.httpBody = body.data(using: .utf8)
  URLSession.shared.dataTask(with: req) { _, _, _ in }.resume()
}

/// JSON body carrying the request provenance the daemon logs: a source label
/// (explicit menu action vs auto reconciliation) and, for auto reactions, the
/// notification timestamp so an internal capture activation can be attributed.
func requestBody(_ source: String, extra: [String: Any] = [:]) -> String {
  var body: [String: Any] = ["source": source]
  for (key, value) in extra { body[key] = value }
  guard let data = try? JSONSerialization.data(withJSONObject: body) else { return "{\"source\":\"\(source)\"}" }
  return String(data: data, encoding: .utf8) ?? "{}"
}

/// Brand artwork first (matches the app/Dock icon), SF Symbol as fallback if
/// the managed engine is not installed under this data root.
func brandImage() -> NSImage? {
  let candidates = [
    dataRoot + "/apps/Backlight.app/Contents/Resources/backlight.icns",
    dataRoot + "/apps/Backlight.app/Contents/Resources/app.icns",
  ]
  for path in candidates {
    if let image = NSImage(contentsOfFile: path) {
      image.size = NSSize(width: 18, height: 18)
      return image
    }
  }
  return nil
}

/// Activity marker on top of the brand artwork (small accent dot), so the
/// menu bar stays brand-consistent while still blinking for AI commands.
func activeBrandImage(_ base: NSImage?) -> NSImage? {
  guard let base else { return NSImage(systemSymbolName: "bolt.circle.fill", accessibilityDescription: "Backlight activity") }
  let size = NSSize(width: 18, height: 18)
  let image = NSImage(size: size)
  image.lockFocus()
  base.draw(in: NSRect(origin: .zero, size: size))
  NSColor.systemBlue.setFill()
  NSBezierPath(ovalIn: NSRect(x: 10, y: 10, width: 7, height: 7)).fill()
  image.unlockFocus()
  return image
}

func isManagedApp(_ app: NSRunningApplication, browser: [String: Any]) -> Bool {
  if let pid = browser["pid"] as? Int, Int(app.processIdentifier) == pid { return true }
  // A Dock launch can select a second instance of our branded .app. Route
  // that activation to the managed profile, never to/from the user's Chrome.
  guard app.bundleIdentifier == "dev.backlight.browser",
        let binary = browser["binary"] as? String,
        let range = binary.range(of: ".app/"),
        let bundlePath = app.bundleURL?.standardizedFileURL.path else { return false }
  let managedPath = String(binary[..<range.lowerBound]) + ".app"
  return URL(fileURLWithPath: managedPath).standardizedFileURL.path == bundlePath
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
  var checkingWindow = false
  var restoringUntil = Date.distantPast

  let idleIcon = brandImage() ?? NSImage(systemSymbolName: "circle.dashed", accessibilityDescription: "Backlight idle")
  lazy var activeIcon = activeBrandImage(brandImage())

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

    // User clicks the Dock icon of the managed browser → the daemon records
    // the OS observation as `tray.auto.*`, but an NSWorkspace activation does
    // not prove a physical click, so the daemon keeps the window hidden. The
    // explicit show paths are the tray menu, `bl show` and the launcher/login.
    for event in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didUnhideApplicationNotification] {
      let autoSource = event == NSWorkspace.didUnhideApplicationNotification ? "tray.auto.unhide" : "tray.auto.activate"
      NSWorkspace.shared.notificationCenter.addObserver(
        forName: event, object: nil, queue: .main
      ) { [weak self] note in
      guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
      let observedAt = Date().timeIntervalSince1970 * 1000
      apiGet("/api/status") { data in
        guard let data,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let browser = obj["browser"] as? [String: Any],
              browser["running"] as? Bool == true,
              let pid = browser["pid"] as? Int else { return }
        if isManagedApp(app, browser: browser) {
          DispatchQueue.main.async {
            // The daemon owns attribution and logs every auto request
            // (accepted or skipped: internal-activation / explicit-in-flight /
            // unverified-activation); posting unconditionally keeps every
            // OS-observed activation directly traceable instead of silently
            // dropped here.
            self?.restoringUntil = Date().addingTimeInterval(3)
            let activate = Int(app.processIdentifier) == pid
            apiPost("/api/show", body: requestBody(autoSource, extra: [
              "activate": !activate,
              "observedAt": observedAt,
            ]))
          }
        }
      }
      }
    }
    poll()
  }

  private func menuItem(_ title: String, _ action: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
    item.target = self
    return item
  }

  @objc func collapseAll(_ sender: Any) { apiPost("/api/bg", body: requestBody("tray.menu.bg")) }
  @objc func restoreAll(_ sender: Any) { apiPost("/api/show", body: requestBody("tray.menu.show")) }
  @objc func openDashboard(_ sender: Any) {
    // Open the dashboard in the managed Backlight browser via the daemon
    // (never the macOS default browser). Explicit action: may show a window
    // even in background mode, and launches the managed profile if stopped.
    apiPost("/api/console", body: requestBody("tray.menu.console"))
  }
  @objc func quit(_ sender: Any) { NSApp.terminate(self) }

  func menuNeedsUpdate(_ menu: NSMenu) {
    statusLine.title = browserRunning ? "浏览器: 后台运行中" : "浏览器: 未运行"
  }

  func poll() {
    // Status comes from the browser lifecycle, not the presence of AI events.
    // The daemon refuses auto show (an OS observation is not a verified click),
    // so the poll only re-hides a managed app whose windows are all minimized:
    // that keeps the app hidden so a later Dock click still emits
    // didUnhide/didActivate and stays traceable. Showing a window is an
    // explicit action via the tray menu / `bl show` / the launcher.
    apiGet("/api/status") { [weak self] data in
      guard let self else { return }
      let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
      let browser = obj?["browser"] as? [String: Any]
      let running = browser?["running"] as? Bool == true
      let pid = browser?["pid"] as? Int
      DispatchQueue.main.async {
        self.browserRunning = running
        guard running, let pid, let browser, !self.checkingWindow,
              Date() > self.restoringUntil,
              let frontmost = NSWorkspace.shared.frontmostApplication,
              isManagedApp(frontmost, browser: browser) else { return }
        guard Int(frontmost.processIdentifier) == pid else { return }
        self.checkingWindow = true
        apiGet("/api/windows") { [weak self] data in
          let result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
          let windows = result?["windows"] as? [[String: Any]] ?? []
          let allMinimized = !windows.isEmpty && windows.allSatisfy { $0["state"] as? String == "minimized" }
          DispatchQueue.main.async {
            self?.checkingWindow = false
            guard let self, Date() > self.restoringUntil else { return }
            if allMinimized {
              // --no-startup-window can suppress Chromium's ordinary reopen.
              // Hiding after the last minimize guarantees a later Dock click
              // emits didUnhide/didActivate, even if this app was already active.
              NSRunningApplication(processIdentifier: Int32(pid))?.hide()
            }
          }
        }
      }
    }
    apiGet("/api/activity?limit=1") { [weak self] data in
      guard let self, let data,
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let events = obj["events"] as? [[String: Any]], let last = events.last,
            let ts = last["ts"] as? Double else {
        return
      }
      let kind = last["kind"] as? String ?? ""
      DispatchQueue.main.async {
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
