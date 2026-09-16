# Backlight 项目索引与交接

更新时间：2026-09-16。项目地址：<https://github.com/insogao/parallel-browser>。此文件是当前状态入口；PLAN.md、DISCUSSION.md 中的早期结论仅作历史参考。

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
- 人工接手：show 暂停 capture 的窗口操作，支持最大化；后台打开新页不移动当前人工窗口；capture 增加取消和超时保护。人工接手与 capture setup 竞态时，controller 不再停留在前台；用户竞态中选择的新标签保持不变（`tests/capture-unit.ts`）。
- 扩展：原生 sidePanel 调试、指定扩展热重载、面板与网页通信、持久化示例；DevTools 通过 CDP 代理连接，修复初始消息丢失。侧栏显式绑定请求网页的 windowId，双窗口同扩展 3/3 无串窗（`tests/extension-dev-unit.ts` + `tests/extensions.ts`）。
- 观测：修复多条 rAF 调度链；区分原生帧率与补偿回调，不伪造 document.hidden。
- 最小化：查清“CDP 报告 minimized 但 AppKit 未真正最小化”的根因；应用隐藏时执行两次 normal→minimized 循环，`document.hidden === true`、三页持续轮询（`tests/usability.ts` 连续通过，证据含 target/windowId/bounds/native 状态）。假性 minimized（隐藏应用上报告可为假）在 `settleRepeat` 下强制恢复循环，重复 `/api/bg` 可修复（`tests/windows-unit.ts`）。
- 控制代际（last-intent-wins）：`collapseAll`/`restoreAll` 开启代际，`/api/bg` 在进入路由时（任何 await 前）就分配代际，延迟最小化步骤会校验；show/restore/launch/ext-dev/inspect 会作废在途 bg。native hide/unhide/activate 由每服务器队列按到达顺序串行化，临界区内重查代际：bg 先进 hide 则后到 show 的 unhide 排后执行，show 先进则旧 bg 跳过 hide。`tests/proxy-race-unit.ts` 3 个 API 级竞态用例覆盖 settle 中 show、setPaused(false) 挂起中 show、hide 在途时 show。
- 原生可见性：新增 `app-control unhide`（不抢焦点）；AppKit hide/unhide 异步生效，改为发出请求后用新进程校验状态并有界重试，show(activate:false) 与 bg 连续切换不再出现状态漂移。2026-09-16 新增只读 `app-control windows`（CGWindowList：窗口总数、on-screen layer-0 窗口数），用于真实验收交叉验证原生最小化。
- 窗口状态验收（2026-09-16）：新增 opt-in `test:window-state`，在隔离品牌化 Backlight.app 上跑一个 `可见/最大化 → 最小化 → 恢复/最大化` 序列，分开采集 CDP windowState、AppKit hidden/WindowServer on-screen、`document.visibilityState`、timer、服务器网络轮询、补偿 rAF、原生 compositor rAF。**以下指标只来自一次 Phase A 运行（capture 保活关闭、frame pump 关闭），不代表 capture 开启的最终验收已通过**：最小化 10s 内 timer 10.0/s、网络轮询 4.0/s、shim rAF 58.5/s、原生 compositor rAF 0.0/s；恢复后原生 100.5/s。capture 开启的单序列真机验收仍 pending（见测试规范）。纯单元守卫“不伪造 visibilityState”与速率阈值区分（当前单元全部通过）。
- 窗口/捕获修复（2026-09-16）：`show --maximize` 在最小化窗口上先有界等待 `normal`（超时直接失败、不发 maximize）再 maximize 并校验结果，未验证成功或中途被更新的意图 supersede 都不计入 `restored`；capture 保活 setup 在 `normal` 生效后才发 park 位置，并有界校验位置实际生效后才记录 parked；cleanup 不再信任单次严格等值探针，按“恢复原位置 → 最小化”修复并有界验证，失败 warn。新增 pid 绑定的 `appHidden`/`hideApp`/`unhideApp` 依赖（`index.ts` 注入 `browserAppState`/`hideBrowser`/`unhideBrowser`）：picker 解除隐藏后恢复 `bg` 语义，若延迟 hide 期间发生 takeover 则补 unhide，人工接管最终可见。上述行为均有确定性单元覆盖；capture 真机复验仍 pending。
- CDP：`Cdp.send` 先注册 waiter 再发送，修复快速响应被丢弃导致的永久挂起；`tests/cdp-unit.ts` 3 个确定性测试。
- **验证状态（2026-09-13 19:47 CST，品牌化 Backlight）：`pnpm --filter @backlight/daemon test` 通过 —— 单元 25/25 + brand 11 项 + spike/supervisor/extensions/agent/background/usability 全部 PASS（32 条 PASS，无 FAIL）；6 条 `[Backlight acceptance]` 路径均为 `.../Backlight.app/...`，sha256 一致，无临时进程/目录遗留。**
- 本轮修复已全部提交（自 `6a4b097` capture 修复起，至本文档更新）。日常 daemon 不会自动加载源码，需用户下次安全重启后生效；不要在用户使用期间擅自终止其浏览器。

## 测试规范

入口：`pnpm --filter @backlight/daemon test`，类型检查：`pnpm -r --if-present run check`。

单元测试为 `tests/*-unit.ts`（capture、windows、extension-dev、cdp、proxy、proxy-race、targets、raf、window-state 等）加 `tests/brand.ts`；当前 38/38 单元 + brand 通过。集成入口 `tests/agent.ts` 的每次 CDP 调用有 15s 上限，回归失败快速报错而非无限挂起；生产代码不设短超时。

窗口状态 + 全通道后台限流验收是**手工 opt-in**：`pnpm --filter @backlight/daemon test:window-state`。它只跑一个 `maximize → minimize → restore` 序列，会短暂操作隔离测试 Backlight 窗口，**不在** `test`/`test:integration` 默认链；真机结果由主控择机跑一次后记录（当前标记 pending）。

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
- packages/daemon/tests/：单元与 Backlight 集成验收（capture-unit、windows-unit、extension-dev-unit、cdp-unit、proxy-race-unit 覆盖本轮修复）。
- docs/development/2026-09-13.md：本轮开发记录。

## 能力边界与未完成项

- 普通后台网络轮询与单目标捕获保活是不同能力。当前 capture 同时只保活一个目标，不保证所有后台标签原生 60fps；页面自身也可依据隐藏状态停工。
- 角落（corner）模式下窗口几乎完全离屏，Chromium 不产生合成帧：默认 `Page.captureScreenshot` 可能永久等待，`fromSurface:false` 也不保证成功。后台截图请使用 capture keep-alive（spike 实测 57–78ms）或可见窗口；AI 客户端在后台截屏前应先恢复窗口或依赖捕获保活。
- 人工接手中断 capture setup（含 controller 已激活、或成功后暂停的竞态）时回到原网页；若用户已切换其它标签则保留用户选择。
- 应用隐藏时窗口需要两次 normal→minimized 循环才会真正隐藏（AppKit 与 CDP 状态语义差异）；应用可见时一次即可。
- capture 的 hide/unhide 不共享 proxy 的 native 可见性队列（该队列只串行化 API 触发的 hide/unhide/activate）。`setPaused(true)` 会等待进行中的 capture tick，cleanup 在 hide 完成后重查控制代际，若接管已开始则补 unhide，因此 `/api/show` 接管最终可见；但 capture 的 native 操作与 API 的 native 操作并发时没有全局串行保证。手动移动窗口或物理 Dock 点击恢复也建议经 `show` 路由（`restoreAll` + `native.persist`），不要与 capture setup 并发操作同一窗口。
- capture 保活 setup 会短暂 park/取消最小化窗口，macOS picker 也可能取消 AppKit 隐藏；已修复为恢复位置后再最小化并用 `hideApp` 再隐藏，但该修复的**真机 capture 最终验收尚未复跑**（pending：`test:window-state`）。最小化且无 capture 时原生 compositor rAF=0 已由 2026-09-16 一次真实运行证明。
- `document.visibilityState` 不做断言也不改写：capture 豁免下显示值由 Chromium 决定；补偿 rAF 只代表页面逻辑帧。
- sidePanel 调试会关闭并重新打开当前窗口面板，以准确定位目标；面板临时状态可能丢失，storage 数据保留。隐藏面板的 WebContents 会被复用，归属用 `chrome.windows.getCurrent()` 验证。
- 原始 CDP 客户端仍可操作窗口；AI 应尊重 status.control 的人工接手状态。
- Dock 真鼠标点击、复杂登录站点兼容性仍需补充验收；多窗口同扩展面板归属已由双窗口集成测试覆盖（3/3）。
- 不对 Chromium 重签名，避免破坏 JIT 权限。可执行文件内部保留引擎原名，应用品牌为 Backlight。
- Node 25 原生 TypeScript，禁止 enum/构造函数参数属性等需转换语法。
