// genicon — 生成 Backlight 品牌图标（圆角深色底 + 品牌色圆环 + 首字母）
// 用法: genicon --text B --out icon_1024.png [--size 1024]
// 编译: swiftc -O genicon.swift -o genicon

import AppKit

var text = "B"
var outPath = "icon_1024.png"
var size = 1024

var args = Array(CommandLine.arguments.dropFirst())
while let a = args.first {
  args.removeFirst()
  switch a {
  case "--text": text = args.isEmpty ? text : args.removeFirst()
  case "--out": outPath = args.isEmpty ? outPath : args.removeFirst()
  case "--size": size = args.isEmpty ? size : Int(args.removeFirst()) ?? size
  default: break
  }
}

let s = CGFloat(size)
let image = NSImage(size: NSSize(width: s, height: s))
image.lockFocus()

// dark rounded-square background
let bg = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s), xRadius: s * 0.18, yRadius: s * 0.18)
NSColor(calibratedRed: 0.043, green: 0.059, blue: 0.078, alpha: 1).setFill()
bg.fill()

// cyan ring (the Backlight motif)
let ring = NSBezierPath()
ring.appendArc(withCenter: NSPoint(x: s / 2, y: s / 2), radius: s * 0.30,
               startAngle: 0, endAngle: 360, clockwise: true)
ring.lineWidth = s * 0.055
NSColor(calibratedRed: 0.216, green: 0.784, blue: 1, alpha: 1).setStroke()
ring.stroke()

// soft inner ring
let ring2 = NSBezierPath()
ring2.appendArc(withCenter: NSPoint(x: s / 2, y: s / 2), radius: s * 0.225,
                startAngle: 0, endAngle: 360, clockwise: true)
ring2.lineWidth = s * 0.012
NSColor(calibratedRed: 0.216, green: 0.784, blue: 1, alpha: 0.45).setStroke()
ring2.stroke()

// brand initial
let letter = String(text.prefix(1)).uppercased()
let font = NSFont.systemFont(ofSize: s * 0.34, weight: .bold)
let attrs: [NSAttributedString.Key: Any] = [
  .font: font,
  .foregroundColor: NSColor.white,
]
let str = NSAttributedString(string: letter, attributes: attrs)
let bounds = str.bounds(with: NSRect(x: 0, y: 0, width: s, height: s))
str.draw(at: NSPoint(x: s / 2 - bounds.width / 2, y: s / 2 - bounds.height / 2 - s * 0.02))

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
  fputs("genicon: failed to encode PNG\n")
  exit(1)
}
try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath)")
