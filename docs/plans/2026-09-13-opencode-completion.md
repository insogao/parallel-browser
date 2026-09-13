# Backlight 后续开发任务清单

更新时间：2026-09-13。执行者：OpenCode（`opencode-go/deepseek-v4.1-flash`，reasoning variant `max`）。主控负责检查方向、复核实现和最终合并。

## 不可违反的约束

- 所有会启动浏览器的测试必须运行品牌化 `Backlight.app`。禁止启动 `/Applications/Google Chrome.app`、缓存目录中的裸 Chrome for Testing 或任何名为 Test 的替代浏览器。
- 使用 `tests/backlight-fixture.ts` 创建隔离的 Backlight 应用副本和临时 profile；该夹具必须校验 bundle ID、名称、图标和可执行文件摘要，不得回退其他浏览器。
- 不得停止、隐藏、移动或重启用户当前使用中的默认 Backlight daemon/browser（默认端口 9333）。集成测试只能使用临时 `BACKLIGHT_HOME` 和动态或专用测试端口。
- 保留当前技术架构：Node/TypeScript 监督器 + 品牌化 Chromium + Swift/AppKit 托盘。不得 fork Chromium，不得重签应用，不得改用户 Chrome profile。
- 每个行为修复必须先补能复现的测试，再修改实现。测试结果和剩余边界同步到 `PROJECT_INDEX.md` 与 `docs/development/2026-09-13.md`。
- 不提交临时日志、测试 profile、构建缓存或浏览器副本。不得声称物理鼠标点击已经自动化验证，除非确实完成该路径。

## 已完成（只需回归，不要重做）

- [x] 独立 Backlight 名称、bundle ID 和运行时图标；用户已确认图标正确。
- [x] 托盘识别品牌应用，监听 activate/unhide，路由到受管 PID，恢复最小化/贴角窗口。
- [x] `show --maximize` 人工接手；后台 `open` 不移动当前人工窗口。
- [x] capture 生命周期、超时和取消保护；不伪造 `document.visibilityState`。
- [x] rAF 单调度链和健康指标修复。
- [x] 原生 sidePanel 打开、扩展定向热重载、网页通信示例和持久 storage。
- [x] DevTools 通过 Backlight CDP 代理连接，初始 WebSocket 消息可缓冲。
- [x] 所有八个浏览器测试入口接入 `backlight-fixture.ts`；已证明日志中的实际应用路径均为 `.../Backlight.app/...`。
- [x] 品牌化 Backlight 中已通过：capture 原生约 60fps、截图约 60ms、真实 sidePanel、面板与页面通信、扩展热重载、DevTools、Agent 代理、后台启动。

## TODO 1：人工接手绝不能停留在 capture 控制器标签

当前风险：capture setup 已切到 controller 后收到 `setPaused(true)`，`finally` 因 `allowed()` 为 false 跳过目标网页恢复；`/api/show` 只恢复窗口，用户可能看到 controller。

要求：

1. 在 `tests/capture-unit.ts` 增加失败测试，覆盖 controller 已激活后发生人工接手。
2. 跟踪 capture setup 切换前的网页 target；取消时仅在 controller 仍是当前激活目标时恢复该网页，避免覆盖用户已经主动选择的新标签。
3. 清理操作必须有界、吞掉已关闭连接错误，不得重新最小化或移动人工窗口。
4. 原有 capture 单元测试全部通过，并记录新断言。

验收：人工接手返回前，controller 不处于前台；若用户在竞态中选择其他标签，则保留用户选择。

## TODO 2：原生侧栏必须绑定请求网页所在窗口

当前风险：先 bringToFront，再创建临时 extension bridge；若用户中途切换窗口，`chrome.tabs.getCurrent()` 可能返回另一个窗口，侧栏打开到错误窗口，但接口仍回报原请求 target。

要求：

1. 先用 `Browser.getWindowForTarget({targetId})` 获取请求网页的 `windowId`，后续 `chrome.sidePanel.close/open` 始终显式使用该 ID。
2. bridge 只用于提供 `userGesture`，不得用 bridge 自身的 incidental windowId 决定目标窗口。
3. 在返回结果前验证 SIDE_PANEL context 属于请求窗口；若 CDP/Extensions API 无法直接给出 windowId，设计可重复、不会选中其他窗口同扩展 panel 的归属验证。
4. 添加双窗口集成测试：两个 Backlight 窗口打开相同扩展，在人为改变焦点的情况下，请求 A 仍只打开/返回 A 的 panel。
5. 所有 session 和 bridge 在成功、失败、超时路径均关闭或 detach。

验收：重复 3 次双窗口测试无串窗；单窗口侧栏、通信、storage 和 DevTools 回归通过。

## TODO 3：修复 Backlight 专用 usability 测试的最小化失败

现象：2026-09-13 Backlight 专用集成重跑中，`tests/usability.ts` 在 `native minimize completes` 超时。日志显示 `/api/bg` 报告 collapsed，但 CDP windowState 未稳定到 minimized。

要求：

1. 先查明是 AppKit hide 与 CDP 状态语义、窗口 ID 变化、maximize→minimize 顺序，还是测试竞态；不得直接放宽断言掩盖问题。
2. 测试同时采集目标 target、windowId、bounds、NSRunningApplication hidden/active 状态，给出根因证据。
3. 修复后验证三页均保持最小化、`document.hidden === true` 且网络轮询持续增长。
4. 不允许操作默认端口 9333 的用户实例。

验收：`tests/usability.ts` 在品牌化 Backlight 中连续通过 3 次。

## TODO 4：收尾验证、文档与提交

执行顺序：

1. `pnpm -r --if-present run check`
2. `bash packages/tray/build.sh`
3. `pnpm --filter @backlight/daemon test:unit`
4. `pnpm --filter @backlight/daemon test:integration`
5. 再运行一次完整 `pnpm --filter @backlight/daemon test`
6. `git diff --check`

检查每个浏览器启动日志都有 `[Backlight acceptance]`，路径含 `Backlight.app`，摘要一致；执行后确认无临时测试 daemon/browser 遗留。更新文档中的准确测试时间、通过项、失败项及能力边界。完成一个逻辑修复做一个清晰提交，不要把临时日志提交入库。

最终交付报告应包含：提交列表、改动文件、精确测试命令和结果、仍未自动化的验收（例如物理 Dock 点击）、任何影响用户现有进程且需下次安全重启后生效的改动。
