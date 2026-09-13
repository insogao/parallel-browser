# Backlight usability implementation plan

**Goal:** Deliver the approved background browser, real extension side-panel development, human takeover and distinct branding on macOS.

**Architecture:** Retain the Node supervisor and managed Chromium profile. Keep background page creation separate from user window control. Use Chromium's extension APIs for real side panels and targeted extension reload, preserving page state wherever possible.

**Tech Stack:** Node native TypeScript, CDP, Chrome for Testing, Swift/AppKit.

User approved the design and direct execution on 2026-09-12; no further brainstorming gate.

1. Branding: reproduce original icon resource mismatch with fixture tests; inspect runtime resources, replace only app icons, remove global Dock restarts; verify generated bundle and live application icon.
2. Human takeover: fix tray PID matching, foreground/maximize the managed app, restore cornered windows regardless of collapse mode, suspend disruptive keep-alive setup during takeover; test background open leaves existing window geometry unchanged.
3. Extension development: add real side-panel launch and inspect endpoints/CLI/dashboard, a runnable fixture extension, targeted reload without browser restart, explicit fallback/errors; test page/side-panel messaging and new content-script versions.
4. Background reliability: test multiple pages loading and polling while minimized, preserve active page during human use, repair relevant capture/CDP failures identified by tests.
5. Delivery: run type checks, native tray build, appropriate integration suite, UI verification; update README/PROJECT_INDEX with measured capabilities and limits, commit reviewed changes locally.

Tests run against isolated BACKLIGHT_HOME directories and local fixture pages; no changes to the user's Chrome profile. Use caffeinate for native window tests and clean up test browsers.
