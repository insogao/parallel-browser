# 窗口状态转移与后台限流验收计划

更新时间：2026-09-16。工作分支：`codex/window-state-throttle-test`（隔离 worktree）。本轮受主控校准：**真实验收改为显式 opt-in、一次性手工执行**，不进入 `test` / `test:integration` 默认链；2026-09-16 已按授权执行一次并通过（见下）。

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
```

## 环境与风险

- 本机无预装 Backlight.app/daemon；已按项目官方品牌流程（`ensureChromiumForExtensions` + `brandBundle`）生成 `~/Library/Application Support/Backlight/apps/Backlight.app`（CfT 153.0.8010.47）。品牌化本身不改引擎、不重签名。
- Node v22.22.0（README 验证环境为 Node 25）；`tsc --noEmit` 与原生 TS 运行均通过。
- capture picker 会短暂取消 AppKit 隐藏；`hideApp` 依赖已接入并有单元测试，且已由 2026-09-16 一次性真机验收确认（最小化+capture 全程 AppKit hidden、on-screen=0）。
- 若最终 GUI 验收失败，保留日志与证据，不降级断言。
