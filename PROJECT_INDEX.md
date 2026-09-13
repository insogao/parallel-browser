# Backlight 项目索引与交接

更新时间：2026-09-13。此文件是当前状态入口；PLAN.md、DISCUSSION.md 中的早期结论仅作历史参考。

## 用户要求（后续开发必须遵守）

1. AI 静默打开网页，最小化后仍能加载数据。
2. 在真实网页旁开发、调试扩展侧栏。
3. 用户点击 Backlight 可恢复窗口、最大化，接手登录或扫码。
4. 使用独立名称和图标。
5. **所有浏览器操作测试必须在 Backlight 内完成，禁止启动独立 Google Chrome / Chrome for Testing / Test 浏览器代替验收。**
6. 每轮开发记录改动、验证环境、结果和剩余问题。用户已授权直接开发，无需 brainstorming。

## 当前进度

- 图标：已替换运行时 app.icns，移除覆盖图标的 CFBundleIconName；用户已确认图标正确。运行中图标证据见 artifacts/backlight-running-icon.png。
- Dock 恢复：修复托盘忽略 dev.backlight.browser，以及同一品牌另一实例截获激活的问题；监听 activate/unhide，恢复被贴角或最小化的受管窗口。已在已安装 Backlight 上用 macOS open -a 重开路径验证恢复成功；未声称完成物理鼠标点击验收。
- 人工接手：show 暂停 capture 的窗口操作，支持最大化；后台打开新页不移动当前人工窗口；capture 增加取消和超时保护。
- 扩展：原生 sidePanel 调试、指定扩展热重载、面板与网页通信、持久化示例；DevTools 通过 CDP 代理连接，修复初始消息丢失。
- 观测：修复多条 rAF 调度链；区分原生帧率与补偿回调，不伪造 document.hidden。
- **验证状态：此前混用 Chrome/CfT 的全套测试虽通过，但不作为用户最新要求下的验收。Backlight 专用全套测试正在重跑，最终结果见开发记录。**
- 源码尚有本轮未提交改动。现有日常 daemon 不会自动加载源码修改，完整更新需要后续重启；不要在用户使用期间擅自终止其浏览器。

## 测试规范

入口：`pnpm --filter @backlight/daemon test`，类型检查：`pnpm -r --if-present run check`。

所有会启动浏览器的测试（含 probe）使用 `packages/daemon/tests/backlight-fixture.ts`：

- 只接受已安装的 `~/Library/Application Support/Backlight/apps/Backlight.app`，核验 bundle ID/name。
- APFS 克隆相同 Backlight.app 到各测试临时目录，校验可执行程序与图标 SHA256；名称、图标和程序保持一致，无 Chrome 回退。
- 使用独立资料目录，避免触碰用户标签页和登录态。单独应用路径避免日常托盘将验收实例的激活转发到日常实例。
- GUI 测试串行、由 caffeinate 保持唤醒。单元测试和品牌资源夹具不启动浏览器。
- 不得用旧测试日志替代新构建验收；日志需记录实际应用路径。

## 使用入口

```sh
node packages/cli/bin/backlight.js launch https://example.com
node packages/cli/bin/backlight.js show --maximize
node packages/cli/bin/backlight.js bg
node packages/cli/bin/backlight.js ext add examples/side-panel --name demo
node packages/cli/bin/backlight.js ext dev demo http://127.0.0.1:9333/demo
node packages/cli/bin/backlight.js targets
node packages/cli/bin/backlight.js inspect <targetId>
```

扩展名称以 `ext ls` 输出为准。Dashboard：http://127.0.0.1:9333/；用法详见 README.md 和 examples/side-panel/README.md。

## 关键文件

- packages/daemon/src/browser.ts、brand.ts：生命周期、品牌化。
- native.ts、tools/app-control.swift、packages/tray/main.swift：应用激活与 Dock 恢复。
- windows.ts、capture.ts、inject.ts：窗口、捕获保活、健康状态。
- extension-dev.ts、extensions.ts：原生侧栏与热重载。
- proxy.ts、cdp.ts：API、Dashboard、DevTools 代理。
- packages/daemon/tests/：单元与 Backlight 集成验收。
- docs/development/2026-09-13.md：本轮开发记录。

## 能力边界与未完成项

- 普通后台网络轮询与单目标捕获保活是不同能力。当前 capture 同时只保活一个目标，不保证所有后台标签原生 60fps；页面自身也可依据隐藏状态停工。
- 捕获建立需要短暂操作窗口；人工接手时暂停。仍需持续检查取消时标签选择是否自然。
- sidePanel 调试会关闭并重新打开当前窗口面板，以准确定位目标；面板临时状态可能丢失，storage 数据保留。
- 原始 CDP 客户端仍可操作窗口；AI 应尊重 status.control 的人工接手状态。
- Dock 真鼠标点击、多窗口同扩展面板归属、复杂登录站点兼容性仍需补充验收。
- 不对 Chromium 重签名，避免破坏 JIT 权限。可执行文件内部保留引擎原名，应用品牌为 Backlight。
- Node 25 原生 TypeScript，禁止 enum/构造函数参数属性等需转换语法。
