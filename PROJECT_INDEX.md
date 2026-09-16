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
- Dock 恢复：托盘仍按 PID/bundle 精确识别受管实例的 activate/unhide 并上报（`tray.auto.*`），但显式可见性闸门后自动请求只记录不显示（`show-skip`）；实际显示走托盘菜单/`bl show`/Launchpad，物理 Dock 点击由 macOS/Chromium 原生 reopen 承担。历史修复（忽略用户自己的 Chrome、品牌第二实例路由）保留；物理鼠标点击验收仍为待人工项。
- 人工接手：show 暂停 capture 的后续装定，支持最大化；后台打开新页不移动当前人工窗口；capture 增加取消和超时保护。capture 装定已不再操作窗口/应用可见性（见下），takeover 竞态不会留下窗口修复残留（`tests/capture-unit.ts`）。
- 扩展：原生 sidePanel 调试、指定扩展热重载、面板与网页通信、持久化示例；DevTools 通过 CDP 代理连接，修复初始消息丢失。侧栏显式绑定请求网页的 windowId，双窗口同扩展 3/3 无串窗（`tests/extension-dev-unit.ts` + `tests/extensions.ts`）。
- 观测：修复多条 rAF 调度链；区分原生帧率与补偿回调，不伪造 document.hidden。
- 最小化：查清“CDP 报告 minimized 但 AppKit 未真正最小化”的根因；应用隐藏时执行两次 normal→minimized 循环，`document.hidden === true`、三页持续轮询（`tests/usability.ts` 连续通过，证据含 target/windowId/bounds/native 状态）。假性 minimized（隐藏应用上报告可为假）在 `settleRepeat` 下强制恢复循环，重复 `/api/bg` 可修复（`tests/windows-unit.ts`）。
- 控制代际（last-intent-wins）：`collapseAll`/`restoreAll` 开启代际，`/api/bg` 在进入路由时（任何 await 前）就分配代际，延迟最小化步骤会校验；show/restore/launch/ext-dev/inspect 会作废在途 bg。native hide/unhide/activate 由每服务器队列按到达顺序串行化，临界区内重查代际：bg 先进 hide 则后到 show 的 unhide 排后执行，show 先进则旧 bg 跳过 hide。`tests/proxy-race-unit.ts` 3 个 API 级竞态用例覆盖 settle 中 show、setPaused(false) 挂起中 show、hide 在途时 show。
- 原生可见性：新增 `app-control unhide`（不抢焦点）；AppKit hide/unhide 异步生效，改为发出请求后用新进程校验状态并有界重试，show(activate:false) 与 bg 连续切换不再出现状态漂移。2026-09-16 新增只读 `app-control windows`（CGWindowList：窗口总数、on-screen layer-0 窗口数），用于真实验收交叉验证原生最小化。
- 窗口状态验收（2026-09-16，已按新机制复跑）：opt-in `test:window-state` 通过（隔离品牌化 Backlight.app，capture 保活开启）。`/api/bg` 在窗口仍可见时先以隐藏扩展页 pre-arm（无激活），随后最小化全程 CDP minimized / AppKit hidden / WindowServer on-screen=0；最小化观测窗口 timer 10.0/s、网络 4.0/s、shim 99.9/s、原生 99.9/s（`captureTargetId` 命中目标）、截图 17080B/21ms；`show --maximize` 恢复原生 99.7/s。该测试已改为**拒绝 settle 后任何一帧** on-screen/unhidden（旧版曾等待 capture 导致的瞬时显隐“稳定”后再断言，掩盖了 release blocker）。
- 捕获保活（2026-09-16 重构，修复 release blocker）：弃用 `getDisplayMedia`（macOS 上 `DisplayMediaAccessHandler` 对非 VISIBLE WebContents 直接返回 `CAPTURE_FROM_BACKGROUND_PAGE_ON_MAC`/InvalidStateError；其 Views picker 会激活应用并把窗口重新置前 ~0.4–1.5s）。改为 `BrowserManager` 始终加载内置 helper 扩展（`capture-extension.ts` 写入 `<home>/extensions/backlight-capture`，`--allowlisted-extension-id` 免 activeTab 调用），隐藏扩展页用 `chrome.tabCapture.getMediaStreamId` + `getUserMedia({chromeMediaSource:'tab'})` 建立 CapturerCount 豁免；`/api/bg` 在最小化前调用 `capture.prearm()`（仅对可见目标，全程无窗口/应用可见性操作），使最小化后捕获帧源已建立（真实帧 + CDP 截图可用）。`captureKeepAlive` 关时不装定；helper 始终加载因此可动态开关（无需重启浏览器）。`tests/capture-unit.ts` 断言装定路径**零** `Browser.*`/`Input.*`/`Target.activateTarget` 调用。
- 启动台入口（2026-09-16）：新增 `bl launcher install|status|uninstall` 与 `bl login`。启动器 `~/Applications/Backlight.app`（稳定 bundle id `dev.backlight.launcher`）点击后执行 runtime 快照里的 `backlight.js login`：确保 daemon → 选品牌引擎 `dev.backlight.browser`（隐藏于 `.../apps/Backlight.app`）→ 可见启动/复用默认 space → `restoreAll(maximize)` + activate，无终端窗口；日志在 `.../logs/launcher.log`。幂等：在途 login 共享 promise、CLI mkdir 启动锁 + daemon 单实例检查防双 daemon、已在运行的异引擎会话不终止；`--selftest/--print-config` 不启动 daemon/浏览器。runtime 快照（`.../runtime`，保留 pnpm 相对 symlink、裁剪 typescript/@types 后 2.7MB）使入口不依赖 worktree 路径；`launcher-unit.ts` 12 项确定性测试。已实测安装+替换三次、plutil/codesign/lsregister/mdfind/`--selftest` 全通过；物理点击+登录仍待人工验收（2026-09-16 观测到一次外部真实点击成功：daemon 启动、品牌引擎可见、窗口最大化）。
- Launcher 加固（reviewer follow-up，2026-09-16）：`runLogin` 对“受管会话正以其他引擎运行”只读判定、零副作用拒绝（不改 settings/humanMode/capture、不 maximize/activate/launch/kill），启动失败回滚 humanMode 与 capture 暂停；`installLauncher`/`installRuntime` 共用安装锁（owner pid/token、原子 rename 接管陈旧锁、不抢占存活 owner）；daemon 自持单实例锁直到 daemon.json 原子写入，重复实例退出而不是退回随机端口；`isOurLauncher` 只认精确 `dev.backlight.launcher`；runtime 快照新增 canonical realpath/dangling/源移除独立性断言。`single-instance-unit.ts` 用两个真实 daemon 竞态验证恰好一个存活。
- 窗口状态来源归因（2026-09-16）：新增有界隐私安全 `state-log.ts`（GET `/api/state-log`，URL/标题/cookie 不落盘）；`windows.ts` 记录 `control-intent`/窗口 before-after/branch/gen 与 `internal-native` 区间；`proxy.ts` 按 `source` 区分显式意图与 `tray.auto.*` 自动请求——自动 show 落在内部激活区间且最近显式意图为 bg 时返回 `ignored:internal-activation`（capture 重构后不再产生内部激活区间，门禁保留为防御）；`/api/status` 暴露 `intent/internal`。托盘所有请求带 source/observedAt；“打开控制台”改为 `POST /api/console`，在受管 Backlight 内复用/新建 dashboard 标签（未运行时 managed 可见启动），不再打开默认 Chrome。确定性测试：`state-log-unit` 5 项、`window-intent-unit` 6 项、`launcher-unit` LSUIElement 断言。原 `test:bg-rebound` 探针随 picker 机制移除；其“显式 show 优先”语义并入新探针。
- 意图 token 与四类来源（2026-09-16 审计跟进）：每次控制操作生成唯一 `token`，transition 带 `origin`（`explicit`/`auto`/`internal`/`unknown`）+ `source`/`route`/`requestId`/`gen`；`window-minimize`/`window-restore`/`window-corner`/`native-hide|unhide|activate` 先记 `requested` 再记实际 `after`/失败，找不到证据时 origin=unknown 且不编造 source。**显式可见性闸门（primary review blocker 修复）**：只有白名单控制面（`cli.`/`dashboard.`/`tray.menu.`/`test.`/`probe.`）才是 `explicit`；auto/unknown 的 `/api/show|restore` 在任何副作用前被拒（不 bump 代际、不 restore/unhide/activate），unknown 400、auto 200 `ignored=unverified-activation/internal-activation/explicit-in-flight`；非显式 `/api/launch`/`/api/open`/`/api/restart`/`extensions/dev` 强制后台首启，`inspect`/`extensions/dev` unknown 400 零副作用；`/json/new` 改为后台建 target；`native.persist` 纵深拒绝非 explicit native 操作。Dock 点击的 NSWorkspace 观测无法证明物理点击，保持隐藏并记 `show-skip`+native 证据，显式路径为托盘菜单/`bl show`/Launchpad。`window-intent-unit` 20 项确定性测试覆盖。
- CDP：`Cdp.send` 先注册 waiter 再发送，修复快速响应被丢弃导致的永久挂起；`tests/cdp-unit.ts` 3 个确定性测试。
- **验证状态（2026-09-13 19:47 CST，品牌化 Backlight）：`pnpm --filter @backlight/daemon test` 通过 —— 单元 25/25 + brand 11 项 + spike/supervisor/extensions/agent/background/usability 全部 PASS（32 条 PASS，无 FAIL）；6 条 `[Backlight acceptance]` 路径均为 `.../Backlight.app/...`，sha256 一致，无临时进程/目录遗留。**
- 本轮修复已全部提交（自 `6a4b097` capture 修复起，至本文档更新）。日常 daemon 不会自动加载源码，需用户下次安全重启后生效；不要在用户使用期间擅自终止其浏览器。

## 外部扩展集成（BrowserPilot，测试用，无硬耦合）

Backlight 不含 BrowserPilot 专属代码；BrowserPilot 是可独立分发的扩展，这里只做通用宿主与 macOS 集成测试场。2026-09-16 实测现状：

- 通用扩展注册表 + 热加载：`extensions.json` 持久化，`GET /api/extensions` 返回 `runtime[]`（id/name/version/path/enabled）；`Extensions.loadUnpacked` 重载不重启浏览器。当前 `runtime[0]` = BrowserPilot `nnollghpaggbcdkkgoieneffnlijinio` 0.1.0，`enabled=true`，加载路径为 BrowserPilot worktree 的 `dist/`。
- profile 级 native host：默认 profile `<Backlight home>/spaces/default/profile/NativeMessagingHosts/com.browserpilot.browseragent.json` 指向 BrowserPilot worktree 的 `native-host/dist/host-mac.sh`；host 为品牌浏览器子进程并监听 127.0.0.1:47001。注册/连接在未重启浏览器的情况下生效（`npm run client -- ping '{}' --no-launch` → `pong: true`，在 BrowserPilot worktree 内执行）。
- 验证入口：`curl -s http://127.0.0.1:9333/api/extensions`；`npm run client -- ping '{}' --no-launch`；`npm run client -- list_templates '{}' --no-launch`（后两者只连运行中的 host，不会拉起浏览器）。
- 缺口：host 注册按 user-data-dir 作用域，新 Backlight space 的 profile 需对该目录重跑 `--only-user-data-dir` 注册；worktree 移动/删除会同时破坏已加载扩展与 host wrapper 指向，合并后需重新 `bl ext add`/reload 并按新路径注册。
- 口径：BrowserPilot 仅 3 个编译内置模板（search、gemini-ask、chatgpt-ask）开箱即用，其余 registry 包需运行时 install/sync；不得写成“已全部安装/验证”。

## 测试规范

入口：`pnpm --filter @backlight/daemon test`，类型检查：`pnpm -r --if-present run check`。

单元测试为 `tests/*-unit.ts`（capture、windows、extension-dev、cdp、proxy、proxy-race、state-log、window-intent、targets、raf、window-state、launcher、single-instance 等）加 `tests/brand.ts`；当前 85/85 单元 + brand 11 项通过。集成入口 `tests/agent.ts` 的每次 CDP 调用有 15s 上限，回归失败快速报错而非无限挂起；生产代码不设短超时。

窗口状态 + 全通道后台限流验收是**手工 opt-in**：`pnpm --filter @backlight/daemon test:window-state`。它只跑一个 `maximize → minimize → restore` 序列，会短暂操作隔离测试 Backlight 窗口，**不在** `test`/`test:integration` 默认链；每个采样点都拒绝 settle 后的 on-screen/unhidden 复现。

显式 bg 不可见性回归探针同样是**手工 opt-in**：`pnpm --filter @backlight/daemon test:bg-invisibility`。临时 `BACKLIGHT_HOME` + 随机端口 + 隔离 Backlight.app，`app-control visibility` 以 ~100ms 高频原子采样 AppKit hidden + WindowServer on-screen + CDP windowState，从 `/api/bg` 请求前一直观察到 capture 装定后：settle 后任何 hidden=false 或 on-screen>0 即失败，并断言捕获目标原生 rAF 保持（无静默降级）与显式 show 可用；不启动托盘、不触碰 9333。原 `test:bg-rebound` 已由该探针取代。

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
node packages/cli/bin/backlight.js login          # 启动台点击的同路径
node packages/cli/bin/backlight.js bg
node packages/cli/bin/backlight.js ext add examples/side-panel --name demo
node packages/cli/bin/backlight.js ext dev demo http://127.0.0.1:9333/demo
node packages/cli/bin/backlight.js targets
node packages/cli/bin/backlight.js inspect <targetId>
node packages/cli/bin/backlight.js launcher install|status|uninstall
```

扩展名称以 `ext ls` 输出为准。Dashboard：http://127.0.0.1:9333/；用法详见 README.md 和 examples/side-panel/README.md。

## 关键文件

- packages/daemon/src/browser.ts、brand.ts：生命周期、品牌化。
- packages/daemon/src/launcher.ts、packages/launcher/main.swift：Launchpad 入口的安装/校验、runtime 快照与点击目标。
- packages/daemon/src/single-instance.ts：daemon 单实例与启动锁。
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
- capture 装定不再做任何窗口/应用可见性操作（无 park、无 un-minimize、无 unhide、无 tab 激活），因此与 proxy 的 native 可见性队列没有交叉面；`/api/bg` 的 pre-arm 只在窗口仍可见时执行，`setPaused(true)` 等待在途 tick 完成。手动移动窗口或物理 Dock 点击恢复仍建议经 `show` 路由（`restoreAll` + `native.persist`）。
- capture 帧源只在**窗口可见时**装定：`chrome.tabCapture` 在窗口隐藏状态下装定会给 rAF 豁免但不产生真实帧/截图。`/api/bg` 因此在最小化前 pre-arm；手动 Dock 最小化（无 `/api/bg`）只能得到隐藏装定（原生 rAF 保活、截图退化为 frame pump `fromSurface:false`）。无 capture 时最小化原生 compositor rAF=0 由 `test:window-state` 与 Phase A 证据覆盖。
- 引擎回退：品牌化 Google Chrome（M136+）忽略 `--load-extension` 时，若无法切换到 CfT 则禁用 capture 保活并 warn，隐藏页改用 frame pump/rAF shim，不会回退到会显隐窗口的 getDisplayMedia。helper 扩展始终随受管启动加载，`captureKeepAlive` 可动态开关。
- `document.visibilityState` 不做断言也不改写：capture 豁免下显示值由 Chromium 决定；补偿 rAF 只代表页面逻辑帧。
- sidePanel 调试会关闭并重新打开当前窗口面板，以准确定位目标；面板临时状态可能丢失，storage 数据保留。隐藏面板的 WebContents 会被复用，归属用 `chrome.windows.getCurrent()` 验证。
- 原始 CDP 客户端仍可操作窗口；AI 应尊重 status.control 的人工接手状态。
- Dock 真鼠标点击、复杂登录站点兼容性仍需补充验收；多窗口同扩展面板归属已由双窗口集成测试覆盖（3/3）。
- Launchpad 入口需 `bl launcher install` 安装/刷新（runtime 快照随源码更新）；物理点击与真实登录为人工验收项（2026-09-16 观测到一次外部真实点击成功进入最大化接管，未由实现会话执行）。已在运行的异引擎受管会话不会被 `login` 强制切换，需先 `bl stop` 再点击。
- runtime 快照内的 Node 路径在安装时记录并带 Homebrew 回退；Node/引擎被移动后重跑 `bl launcher install` 即可修复。
- 2026-09-16 follow-up 的 `/api/login` 零副作用拒绝与 daemon 单实例加固需要 daemon 下次启动才生效；已在运行的旧 daemon 仍按旧逻辑处理（本轮未重启用户会话）。
- 本轮窗口来源归因、`/api/console`、托盘 source/品牌图标与启动器 LSUIElement 已写入稳定 runtime 快照（原子刷新，live pid 未变），但 **live daemon/tray 进程仍是旧内存代码**：需按当日开发记录的“生效条件与安全步骤”在用户方便时整体重启 daemon 并退出旧 tray 后生效；旧组合下“打开控制台”仍可能走默认浏览器，旧 tray 的自动 show 仍无 source/归属门禁。
- 自动 show 门禁保留基于 `internal-native` 区间的归属逻辑（单元覆盖），但 capture 重构后不再产生该区间；若未来重新引入内部原生激活，门禁仍可生效。
- 意图归因边界（2026-09-16 审计跟进 + primary review blocker 修复）：显式可见性闸门后，无 source 的 `/api/show` 返回 400 零副作用（`ignored=unverified-source`），`tray.auto.*` 返回 200 但保持隐藏（`show-skip`，附当前原生证据）；只有白名单控制面（`cli.`/`dashboard.`/`tray.menu.`/`test.`/`probe.`）的 source 才被视为 explicit。调用方自报 source 只是可记录的 provenance，不是人类点击证明。非显式 `/api/launch`/`/api/open`/`/api/restart`/`extensions/dev` 一律后台首启，`inspect`/`extensions/dev` unknown 400。旧 runtime/旧调用方不带 source 时行为会退化，需 `bl launcher install` + daemon 重启后整体升级。托盘 `poll` 不再发自动 show（corner/第二实例），只保留“全部最小化时 hide”的保持隐藏动作，该动作由 tray 进程直接执行、不进 daemon state-log（发生在窗口已最小化时，不产生可见状态；记录为残余）。物理 Dock 点击的显示改由 macOS/Chromium 原生 reopen 承担，daemon 不再放大，最终体验待人工验收。原始 CDP WebSocket 与 `/json/activate` 仍是高权限面（与“原始 CDP 客户端可操作窗口”的既有边界一致）。pending 意图仅在内存中，daemon 崩溃重启即可清除。
- 启动器已设 `LSUIElement=true` 抑制点击时短暂重复 Dock 图标；LaunchServices/Spotlight 索引已自动验证，Launchpad 图标可见性与物理点击仍待人工验收。
- 不对 Chromium 重签名，避免破坏 JIT 权限。可执行文件内部保留引擎原名，应用品牌为 Backlight。
- Node 25 原生 TypeScript，禁止 enum/构造函数参数属性等需转换语法。
