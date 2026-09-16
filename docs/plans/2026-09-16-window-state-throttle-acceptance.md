# 窗口状态转移与后台限流验收计划

更新时间：2026-09-16。工作分支：`codex/window-state-throttle-test`（隔离 worktree）。本轮受主控校准：**真实验收改为显式 opt-in、一次性手工执行**，不进入 `test` / `test:integration` 默认链。

> ⚠️ **2026-09-16 更正**：下文「已执行的 GUI 验收结果（PASS，一次性）」记录的那次 PASS 是**无效的**。当时的验收在 capture setup 完成后等待窗口回到 minimized/hidden 再断言，放过了中间 1–3s 的瞬时显隐；`/var/folders/.../opencode/accept/live-bg.out` 的 live 证据显示显式 bg 后 t=1s onScreen=1、t=2s CDP normal、t=3s `hidden=false onScreen=2 capture=yes`、t=4s 才复归 minimized/hidden——即用户反馈的“收起后短暂弹出”，属 release blocker。已按下方「2026-09-16 release-blocker 修复」重构 capture 机制并复跑通过；该 PASS 段落仅作历史记录。

## 目标

用一个显式 opt-in 的真实验收，在隔离的品牌化 `Backlight.app` 上跑**一次**窗口状态序列 `可见/最大化 → 最小化 → 恢复/最大化`，并在同一个最小化观测窗口内用真实指标证明浏览器继续运行、未落入 Chromium 后台限流。六类信号必须**分开采集、分开标注**，不得互相冒充：

| 信号 | 来源 | 说明 |
| --- | --- | --- |
| CDP windowState | `Browser.getWindowBounds` | 监督器眼中的窗口状态 |
| AppKit 原生可见性 | `app-control state`（`NSRunningApplication.isHidden`）+ `app-control windows`（WindowServer on-screen 窗口数） | 窗口是否真的不在屏幕上 |
| document.visibilityState | 页面内 `RT.evaluate` 只读 | 由 Chromium 自己报告；注入脚本不得改写 |
| timer / 网络轮询 | `__blHealth.timer`、页面 fetch 计数、服务器端计数 | 证明事件循环与网络未被限流 |
| 补偿 rAF | `__blHealth.raf`（rAF shim，Worker/16ms timer） | 逻辑帧，**不是**原生帧 |
| 原生 compositor rAF | `__blHealth.native`（`__blNativeRaf`，未被 shim 替换） | capture 目标应保持高帧率；无 capture 时应接近 0 |

## 现状证据（实现前）

- 状态通道：`windows.ts` 的 `windowStates()/minimizeWindow()/restoreAll()`；`Browser.setWindowBounds` 的 `normal → minimized`（隐藏应用需两轮）。
- 健康通道：`inject.ts` 注入 `__blHealth.{raf,native,timer}` 与 rAF shim，明确区分补偿/原生；没有改写 `document.visibilityState`。
- 原生通道：`tools/app-control.swift` 的 `state/hide/unhide/activate/icon`；`native.ts` 用它做 hide/unhide 的有界校验。
- capture 保活：`capture.ts` 单目标 Tab Capture 豁免；`tests/probe-capture.ts`、`tests/supervisor.ts` 已验证最小化后原生帧率与截图。
- 已有 GUI 测试均通过 `backlight-fixture.ts` 使用品牌化 Backlight 隔离副本；默认链不含窗口状态转移 + 全通道联合验收。

## 缺口（本轮修复）

1. 没有带时间戳记录 `maximized → minimized → maximized` 并逐项对照 CDP / AppKit / DOM 的测试。
2. `app-control` 缺少“窗口是否真的在屏幕上”的原生探针。
3. `show --maximize` 在窗口最小化时把 `maximized` 紧跟在 `normal` 之后发送，被 CDP 拒绝（“restore it to normal state first”），且失败被静默计入 `restored`。
4. capture 保活 setup 把 `windowState: normal` 与停靠坐标合成一次调用；macOS 会忽略该次位置，窗口回到原位置并留在前台；且没有恢复 `bg` 的 AppKit 隐藏状态。
5. 没有一条确定性单元测试守卫“不伪造 document.visibilityState / document.hidden”。

## 本轮交付

- `packages/daemon/tests/window-state-throttle.ts`：opt-in 真实验收（一个序列，capture 保活开启），最后清理隔离 daemon/app/profile，SIGINT/SIGTERM 也走同一清理；`app-control`/`swiftc` 调用带 timeout，进程清理用精确 profile 路径匹配而非 `pkill -f` 正则。
- `packages/daemon/tests/window-state-samples.ts` + `window-state-throttle-unit.ts`：可复用采样辅助 + 纯单元验证（9 项）。
- `packages/daemon/package.json`：新增 `test:window-state` 独立命令；**未加入** `test` / `test:integration`。
- `tools/app-control.swift`：新增只读 `windows <pid>`（CGWindowList：窗口总数、on-screen layer-0 窗口数）。
- `src/windows.ts`：新增 `maximizeWindow`，先有界等待 `normal`（超时直接失败、不发 maximize）再发 maximize，并**校验最终为 maximized**；未验证成功或中途被 supersede 的恢复不计入 `restored`。
- `src/capture.ts` + `src/index.ts`：`normal` 生效后才发 park 位置、有界校验位置生效后才记录 parked；cleanup 不信任单次严格等值探针，按“恢复原位置 → 最小化”修复并有界验证 minimized（失败 warn）。新增 pid 绑定的 `appHidden`/`hideApp`/`unhideApp`（`index.ts` 注入 `browserAppState`/`hideBrowser`/`unhideBrowser`）：picker 解除隐藏后恢复 `bg` 语义；延迟 hide 期间发生 takeover 时补 unhide，人工接管最终可见。
- `tests/capture-unit.ts` / `windows-unit.ts`：新增确定性单元测试覆盖上述行为（延迟 normal/位置、hide 被 takeover 竞态、normal 超时不发 maximize、supersede 不计恢复）。

## 已执行的 GUI 验收结果（PASS，一次性）

**最终 capture 开启的单序列验收（2026-09-16，`14f5c13`）**：`pnpm --filter @backlight/daemon test:window-state` 退出码 0，隔离品牌化 Backlight.app（fixture sha256 `8ac78806…c3dc`）、临时 profile、随机端口，run 后无残留、9333 空闲。

- 最大化基线：`cdp=maximized`、AppKit hidden=false、on-screen≥1、DOM visible；timer 10.0/s、网络 3.9/s、shim rAF 100.2/s、原生 100.2/s。
- `/api/bg` 4.00s → CDP minimized 4.95s / DOM hidden 4.95s / on-screen=0 4.95s / AppKit hidden 5.84s。
- 最小化 + capture：`captureTargetId` 命中；CDP minimized / AppKit hidden / on-screen=0 全程；timer 10.1/s、网络 4.0/s、shim 100.0/s、原生 100.0/s；截图 17092B/27ms；DOM visibilityState 报 visible（capturer 语义，未伪造）。
- `show --maximize` 22.66s → 23.05s DOM/native 可见 → 24.08s CDP maximized/AppKit unhidden；恢复原生 100.2/s。

## 2026-09-16 release-blocker 修复（capture 机制重构）

### 根因（Chromium 源码 + 隔离 A/B 实测）

1. **macOS 硬门槛**：`chrome/browser/media/webrtc/display_media_access_handler.cc` 中 `getDisplayMedia` 在 macOS 上当 `web_contents->GetVisibility() != VISIBLE` 时直接以 `CAPTURE_FROM_BACKGROUND_PAGE_ON_MAC`（JS 侧 `InvalidStateError`）拒绝。隔离实测：窗口 minimized 时，即使 controller 是 active tab、有合成 click 也失败（`diag silent/click`，`InvalidStateError`）。因此旧实现必须先 `Browser.setWindowBounds normal` 取消最小化（窗口立即 on-screen，AppKit hidden 仍为 true）。
2. **Views picker 激活应用**：窗口 normal 后 auto-select 仍会创建并 `Show()` picker 窗口（`desktop_media_picker_views.cc` / `desktop_media_list_controller.cc` 异步 `AcceptSpecificSource`），macOS 上表现为 AppKit unhide + 窗口置前 ~0.4–1.5s（live-bg.out t=2–3s；隔离 A/B 同样复现 `hidden=false onScreen=2`）。清理再 minimize+hide 只是“事后恢复”，不是“从未可见”。
3. **隐藏装定的捕获无真实帧**：`chrome.tabCapture` 扩展路径没有 VISIBLE 门槛（可在最小化+隐藏时装定，rAF 保持 100/s），但实测窗口隐藏时装定只产生 rAF 豁免、不产生 captured frames，且 `Page.captureScreenshot` 默认与 `fromSurface:false` 都永久挂起；可见时装定后再最小化则截图 21–38ms、真实帧正常（`diag-shot` A/B）。

### 修复

- 内置 helper 扩展（`src/capture-extension.ts`，写入 `<BACKLIGHT_HOME>/extensions/backlight-capture`，`--allowlisted-extension-id` 基于 realpath 计算）在隐藏后台页用 `chrome.tabCapture.getMediaStreamId` + `getUserMedia({chromeMediaSource:'tab'})` 装定 CapturerCount 豁免；全程无窗口/应用可见性操作。helper 随每次受管启动加载（可动态开关 `captureKeepAlive`）。
- `/api/bg` 在 `collapseAll` **之前**调用 `capture.prearm()`：窗口仍可见时对当前可见页装定，随后最小化不再触发任何 capture 装定动作；截图/真实帧在最小化期间保持可用（旧机制的先决条件以无副作用方式满足）。
- `capture.ts` 删除 normal/park/activate/click/cleanup/hideApp 全部窗口与原生可见性路径；`tests/capture-unit.ts` 断言装定路径零 `Browser.*` / `Input.dispatchMouseEvent` / `Target.activateTarget`。

### 新验收口径与证据

- **任何一帧都不能复现**：`test:window-state` 改为从首个 minimized+hidden+onScreen=0 采样点起，之后每个采样都必须保持（不再等待 capture 完成后再断言）。
- **高频回归**：新增 opt-in `test:bg-invisibility`（`tests/bg-invisibility.ts`），`app-control visibility` 新增原子命令，~100ms 采样 AppKit hidden + WindowServer on-screen + CDP windowState，从 bg 前观察到 capture 装定后；settle 后任何 `hidden=false`/`on-screen>0`/`CDP≠minimized` 立即失败，并断言捕获目标原生 rAF 保持、显式 show 可用、state-log 无 `capture-window`/`internal-native`。
- 隔离真机结果（2026-09-16 本轮，两次独立运行）：`test:bg-invisibility` PASS（28/21 samples @~100ms，0 violations；capture 期间 native rAF 100/s；explicit show 后 100/s）。`test:window-state` PASS（基线 100.1/s；settle 后全程 minimized/hidden/onScreen=0；最小化+capture timer 10.0/s、网络 4.0/s、shim 99.9/s、原生 99.9/s、截图 17080B/21ms；show --maximize 恢复 99.7/s）。
- 纯单元：`pnpm --filter @backlight/daemon test:unit` 71/71 + brand 11 通过；集成链 supervisor/extensions/agent/background/usability PASS。**spike 的“minimized shim ≥12/s”断言在本机当前环境为 ~10.5/s，且用改动前的 `git stash` 旧代码复测同样 ~10.5/s，与本修复无关；该既有阈值未改动、未声称通过。**

**更早一次 Phase A（capture 关闭、frame pump 关闭）**：

- 最大化基线：`timer=10.2/s`、服务器轮询 `4.0/s`、`shimRaf=98.9/s`、`nativeRaf=98.9/s`。
- 最小化观测窗口 10s：`timer=10.0/s`、服务器轮询 `4.0/s`、`shimRaf=58.5/s`、`nativeRaf=0.0/s`；CDP/DOM/AppKit on-screen 全程 `minimized/hidden/0`。
- 转移时间戳：`/api/bg` 4.00s → CDP minimized 4.96s / DOM hidden 4.96s / native offscreen 4.96s / AppKit hidden 5.84s；`show --maximize` 15.95s → DOM visible 16.29s → CDP maximized 17.37s；恢复后 `nativeRaf=100.5/s`。
- 该轮随后在 capture 阶段失败：窗口停在 `normal` 且前台可见，由此定位并修复缺口；最小化无 capture 的 `nativeRaf=0.0/s` 对照仍有效。

红绿记录：`app-control windows` 未实现时真实验收在 “baseline must have a native on-screen window” 失败；实现后该断言通过。`show --maximize` 修复前，对应单元测试失败；修复后通过。Reviewer 加固的 4 项新单元在旧源码上全部失败（capture 异步 normal/延迟位置、hide 被 takeover 竞态；windows normal 超时不发 maximize、supersede 不计恢复），加固后全绿。第二轮 P1 的 2 项新单元（normal 后探针 reject/瞬时 reject）同样先红后绿；`windowTouched` 保证即使 park 未记录也会修复窗口。

## 人工验收（剩余）

以上 `test:window-state` 已按授权执行一次并通过；物理 Dock 点击与真实鼠标激活仍未自动化，保持待人工验收。

## 禁止事项

- 禁止启动 Google Chrome、裸 Chrome for Testing 或任何非 `backlight-fixture.ts` 路径的浏览器。
- 禁止停止/隐藏/移动/重启用户日常 daemon，禁止使用或连接 9333，禁止读用户 profile/登录态。
- 禁止伪造 `document.visibilityState` / `document.hidden`；禁止把补偿 rAF 写成原生帧率；禁止用截图成功冒充原生合成帧。
- 禁止为通过测试删除断言或把阈值降到失去意义。
- 物理 Dock 点击、真实鼠标激活未自动化，必须继续标记“待人工验收”。

## 验收标准（阈值与依据）

观测窗口：最小化后连续 10s，每 500ms 采样。

| 指标 | 阈值 | 依据 |
| --- | --- | --- |
| CDP windowState | 观测窗口内始终 `minimized` | 监督器最小化必须稳定 |
| AppKit `hidden` / WindowServer on-screen | 窗口内始终 `hidden=true`、on-screen layer-0 = 0 | 原生可见性必须与 CDP 一致；CGWindowList 是窗口服务器真实判定 |
| `document.visibilityState` | 只报告不断言 | capture 豁免下由 Chromium 决定；不得伪造 |
| 网络轮询（服务器端） | ≥ 2 次/s（标称 4 次/s） | Chromium 隐藏页 timer 默认钳到 ~1 次/s；≥2 明确高于限流态 |
| `__blHealth.timer` | ≥ 5 次/s（标称 10 次/s） | 同上，限流态 ≤1/s |
| 补偿 rAF `__blHealth.raf` | ≥ 25 帧/s（标称 ~60） | shim 失效且原生暂停时会掉到 ~0；只标注为逻辑帧 |
| 原生 compositor rAF（capture 目标） | ≥ 0.7 × 可见基线 | 复用 supervisor e2e 的 0.75 ratio 并留余量；限流态接近 0 |
| 最小化 + capture 截图 | 3s 内返回且 >5KB | 复用 supervisor 的真实帧契约 |
| 可见/恢复基线原生 rAF | ≥ 30 帧/s | 本机可见基线实测 ~99–101 帧/s，阈值留繁忙余量 |
| 恢复/最大化 | 所有通道在 20s 内转回 | 恢复路径必须可重复；未验证的 maximize 不计成功 |

补充：无 capture 时 `nativeRaf≈0` 与 `shimRaf≈58/s` 的对照由 2026-09-16 Phase A 运行证明；本轮生产修复不改变该路径。

## 精确命令

```bash
# 纯静态/单元（日常允许）
pnpm -r --if-present run check
pnpm --filter @backlight/daemon test:unit
node --test packages/daemon/tests/capture-unit.ts packages/daemon/tests/windows-unit.ts packages/daemon/tests/window-state-throttle-unit.ts
git diff --check

# 已执行的真实 GUI 验收（一次性，勿加入默认链；会短暂操作隔离测试窗口）
pnpm --filter @backlight/daemon test:window-state

# 显式 bg 不可见性高频回归（一次性 opt-in；~100ms 原生采样拒绝任何瞬显）
pnpm --filter @backlight/daemon test:bg-invisibility
```

## 环境与风险

- 本机无预装 Backlight.app/daemon；已按项目官方品牌流程（`ensureChromiumForExtensions` + `brandBundle`）生成 `~/Library/Application Support/Backlight/apps/Backlight.app`（CfT 153.0.8010.47）。品牌化本身不改引擎、不重签名。
- Node v22.22.0（README 验证环境为 Node 25）；`tsc --noEmit` 与原生 TS 运行均通过。
- capture picker 会短暂取消 AppKit 隐藏；`hideApp` 依赖已接入并有单元测试，且已由 2026-09-16 一次性真机验收确认（最小化+capture 全程 AppKit hidden、on-screen=0）。
- 若最终 GUI 验收失败，保留日志与证据，不降级断言。

## 2026-09-16 follow-up：隐藏后台重启 fail-closed（取代“复建后 repair hide”）

严格采样（从 `/api/restart` 请求前开始、覆盖 PID 变化）证明 warm reopen/复建标签路径无法零瞬显：旧实现的请求窗内 12/41 个样本 visible（新 pid unhidden → onScreen=2 → repair hide）。因此：

- 隐藏（或可见性不可读）时的 plain/automatic 后台重启在停止进程之前被拒绝：`POST /api/restart` 返回 409 `{restarted:false,deferred:true,reason:"hidden-restart-unsafe"|"hidden-state-unknown"}`，pid/端口/标签页会话保留，state-log 记 `restart/branch=deferred/after=unchanged` + source/route/requestId + 原因；不再有 spawn-then-hide。
- 显式 visible restart（explicit source + `focus:true`/`keepVisible:true`/`background:false`）与 show/login 保持可用；tabCapture 与冷启动首启的 verified hidden 结束语义不变。
- 扩展热重载继续 `Extensions.loadUnpacked`，不重启浏览器（`extension-dev-unit` 断言零 stop/restart）；`restartIfRunning` 同规则。
- launch 失败（debug endpoint/CDP/verified hide）会清理已 spawn 进程，不留未跟踪可见进程。
- `test:bg-invisibility` 的重启段现在是：请求前起采样 → 断言 409 deferred 与零 visible 样本 → 断言会话保留 → 显式 visible restart 覆盖 PID 变化 → 隐藏 `/api/open` 严格采样 → 冷启动首启诊断（瞬态记录，不假装为零）。
