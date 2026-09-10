#!/bin/bash
# Build the Backlight Tray menu-bar app (LSUIElement, ad-hoc signed).
set -e
cd "$(dirname "$0")"
APP="build/Backlight Tray.app"
rm -rf build
mkdir -p "$APP/Contents/MacOS"
swiftc -O main.swift -o "$APP/Contents/MacOS/Backlight Tray"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Backlight Tray</string>
  <key>CFBundleIdentifier</key><string>dev.backlight.tray</string>
  <key>CFBundleName</key><string>Backlight Tray</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP" 2>/dev/null || true
echo "built: $PWD/$APP"
