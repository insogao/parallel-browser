import AppKit

let args = CommandLine.arguments
guard args.count >= 3, let pid = Int32(args[2]),
      let app = NSRunningApplication(processIdentifier: pid) else {
  fputs("managed application is not running\n", stderr)
  exit(1)
}
switch args[1] {
case "state":
  print("{\"active\":\(app.isActive),\"hidden\":\(app.isHidden)}")
case "hide":
  if !app.isHidden { _ = app.hide() }
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
