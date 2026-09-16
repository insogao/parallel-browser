import AppKit
import CoreGraphics

let args = CommandLine.arguments
guard args.count >= 3, let pid = Int32(args[2]),
      let app = NSRunningApplication(processIdentifier: pid) else {
  fputs("managed application is not running\n", stderr)
  exit(1)
}
switch args[1] {
case "state":
  print("{\"active\":\(app.isActive),\"hidden\":\(app.isHidden)}")
case "windows":
  // WindowServer truth for the managed pid. A truly minimized or hidden app
  // window is not on-screen; acceptance tests use this to cross-check CDP's
  // windowState without Accessibility permissions.
  let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
  var windowCount = 0
  var onScreenWindowCount = 0
  for window in list {
    guard (window[kCGWindowOwnerPID as String] as? Int32) == pid else { continue }
    windowCount += 1
    let onScreen = (window[kCGWindowIsOnscreen as String] as? Bool) == true
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    if onScreen && layer == 0 { onScreenWindowCount += 1 }
  }
  print("{\"windowCount\":\(windowCount),\"onScreenWindowCount\":\(onScreenWindowCount)}")
case "hide":
  if !app.isHidden { _ = app.hide() }
case "unhide":
  // Show the app without activating/focusing it.
  if app.isHidden { _ = app.unhide() }
case "activate":
  app.unhide()
  guard app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) else { exit(1) }
case "icon":
  guard args.count == 4, let image = app.icon,
        let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
  try png.write(to: URL(fileURLWithPath: args[3]))
default: exit(1)
}
