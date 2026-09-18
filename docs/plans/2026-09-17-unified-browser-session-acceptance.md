# Backlight 单一会话与真实网页后台验收（2026-09-17）

**2026-09-18 产品决策修订（覆盖本文原“零窗口全程不上屏”要求）：** 用户允许真正零窗口冷启动创建第一个真实标签时窗口**出现一次**，换取后续 AI 与人工使用同一原标签/原文档。AppKit `active` 仍须全程为 false（不能抢前台），首次显示必须在第一个后台开页请求内有来源/窗口 ID/时长日志，随后完成最小化/隐藏；第二页及之后不得再次显示或创建第二窗口。若首次创建失败或原窗口丢失，同一浏览器会话的后台请求不得再次自行弹窗，须 fail-closed 并提示人工显式开窗。`hidden:true` 只保留显式 `windowless:true` 的不可接管协议模式，不能作为默认真实标签路径。其余内容/速率/页面身份验收门槛不降低。实现与隔离真机证据见 [任务 B 记录](2026-09-17-unified-browser-session-task-b.md)，根目录持续交接见 `/Users/jiangao/work/browser/MAINTAINER-HANDOFF.md`。本文以下带“无瞬显/全程 0 上屏”的旧句子按此修订理解。

## 0. 结论与边界

这不是小修：现在 closed/零窗口的 `/api/open` 创建 CDP `hidden:true` target（`type=other`，不在 Chrome 标签栏）；Dock 打开的是同一浏览器进程/profile 的普通窗口；`windowless-adopt` / `manual-window-create` 按 URL 再建 `type=page` 并关闭原 target。它保住了“不弹窗”，但不是同一网页的接管：页面重新请求，内存 JS、表单及滚动状态不保证保留，BrowserPilot 的 `chrome.tabs` 也不能把 hidden target 当作普通标签。现有 `manual-bg-check.mjs` 的 0 异常只证明窗口/应用可见性；它仅检查 target 存在，不证明网页完成加载或返回搜索结果。

本轮目标是建立诚实、可重复的证据链，并向“一个浏览器会话、一个默认受管窗口、真实标签复用”收敛。**不能**用复制 URL 后的新标签冒充原页面持续运行，也不能把单测/`Target.getTargets` 存活写作真机通过。此前“无瞬显”是旧约束；新约束允许**仅首次冷启动一次**可归因的短暂显示，要求页面身份始终不变，绝不能演变成每次打开后再最小化。

## 1. 并行任务与文件所有权

### A — 测试证据脚本（OpenCode CLI，root 工作目录）

只改 `/Users/jiangao/work/browser/manual-bg-check.mjs`，必要时新增该脚本的纯单测/说明文档；不改 daemon、BrowserPilot 源码或 live runtime。实现两阶段：`prepare` 在浏览器中打开真实搜索站点并记录证据，`verify` 在用户手动打开/切换状态后核对同一页面身份与内容。保留兼容的命令形式，但输出必须区分 `visibility-pass`、`content-pass`、`handoff-pass`、`incomplete`，不能再用一个“未采到异常状态”暗示整体通过。失败保留诊断日志，不删除用户页。

### B — 单一会话设计/实现（OpenCode CLI，Backlight 功能 worktree）

只改 `packages/daemon/`、必要的 `packages/tray/`/`packages/launcher/` 与该 worktree 中的设计说明/测试；**不改根目录测试脚本**，不改 BrowserPilot 源码、不部署 live runtime。先画出 closed、minimized、visible-inactive、visible-active 四态的页面/窗口归属及 Dock、启动台、菜单栏、API 四入口，再实现统一的会话协调。任何新页面优先复用既有受管窗口的真实标签。零窗口时仅允许**首次**建受管真实窗口并立即后台化；并发开页不得双建窗，失败后的同一会话不得再次自行弹窗。保持 BrowserPilot 作为独立扩展，兼容普通 `chrome.tabs`。

两任务各自给出改动摘要、测试结果、局限、文件列表、OpenCode session ID。不要并发修改同一文件。负责人最终审查并决定是否部署；代理不得擅自 stop/restart live Backlight、切换前台、merge/push 或清理 worktree。

## 2. 测试脚本必须采集的证据

每一站点分阶段记录（测试查询词可明文，cookie/token/个人网页内容不可记录）：

1. 请求前：起始四态、浏览器 PID/profile/窗口 ID、原有标签 ID，区分脚本新建与既有标签；`--mode=auto` 只是自动识别，不跳过任何验证。
2. 后台开页：API 响应的 target ID、CDP target 类型及 URL；页面主文档导航/响应状态或明确的导航失败；`document.readyState`、最终 URL、标题、可见文本长度、页面内查询词/搜索结果特征；识别空白页、验证码、网络错误页并报 `content-fail`/`blocked`，不得把存活误记为内容成功。
3. 后台运行：至少两个相隔数秒的页面内计数/时间戳或真实 rAF/timer/健康快照，说明采样方法和限制；`type=other` 与真实标签分别报告。不要仅凭 daemon 心跳或目标存在宣称不节流。
4. 前台转换：100 ms 左右持续记录 `/api/windows`、AppKit `active/hidden/onScreen`，明确异常归因与原始时间；脚本自己不得调用 show/login/activate。
5. 人工接管前后：保存目标 ID、内存 JS nonce、`performance.timeOrigin`、最终 URL/标题/内容摘要；用户通过 Dock 或启动台打开后，再读普通标签，核对是否**同一 target/同一文档**。若 URL 相同但 target/nonce 改变，标为 `handoff-fail: reloaded`，不得通过。
6. 使用 `--no-browserpilot` 时明确输出“插件未测”；若测试 BrowserPilot，必须有独立证据显示扩展在同一 profile、能列出和操作目标普通标签，不得拿 daemon CDP 成功代替。
7. 输出结构化 JSON/JSONL 和简洁中文摘要；每个子项有 pass/fail/incomplete 与原因；退出码非 0 对应失败或不完整；默认不泄漏私密页面内容，不关闭测试标签。

对于百度/Bing 真实搜索：站点 DOM/反爬可能变化，按站点定制最小内容断言并记录拒绝原因；外部网络失败不能算浏览器功能通过。加纯单测覆盖成功、空白、404/导航失败、验证码、超时、URL 克隆后 target/nonce 变化、四态可见性、仅有 target 存活这些分支。不能用 mock 冒充真实站点验收。

## 3. 单一会话设计验收不变量

- **进程/profile**：一个受管 Backlight 引擎和 default profile；启动台、Dock、菜单、API 都指向它。外部原生 Chrome 不能被误用。重复点击不得产生第二实例/第二窗口。
- **窗口/标签**：有受管窗口时，后台开页只新建该窗口中的标签，不新建窗口；用户手动打开时仍看到同一标签和内存页面状态（不只是同一 URL）。脚本不得引发前台激活。
- **零窗口**：首次建真实标签可有**一次**可归因的短暂上屏，必须始终 `active=false` 且最终 minimized/hidden；响应/日志要有唯一 windowId、firstDisplay、settled 与耗时证据。第二个后台开页及之后不得再上屏或新建窗口；并发请求也只能使用一个受管窗口。人工打开后必须是原 target/文档。失败/窗口丢失后不得后台重弹；显式 `windowless:true` 则要标不可接管。
- **人工入口**：Dock、启动台、菜单栏都明确归因；物理点击与自动激活不能混淆。允许人主动显示，内部 capture/健康探针不得显示。
- **扩展**：BrowserPilot 可独立安装和运行；其目标是普通 `chrome.tabs`，不能依赖隐藏 target 的伪 tab。默认任务复用窗口，显式新窗口例外要有参数与日志。
- **数据**：同一页面接管前后保持目标 ID、内存 nonce、查询结果；若浏览器技术限制导致必然重载，应在 API 和产品文档中明确，不得称“无缝”。

## 4. 验收矩阵（每项分别有日志与结果）

| 起始状态 | 后台打开两个真实搜索页 | 人工 Dock 打开 | 启动台/菜单显式打开 | 判定 |
| --- | --- | --- | --- | --- |
| closed（0 窗口） | 第一页允许一次可归因短暂上屏但不激活；后台化后第二页复用同一窗口；两页都有可验证结果 | 单窗口、两原页/原文档 | 同理 | 检查一次性显示、最终隐藏、同页身份；未证明前不得 PASS |
| minimized | 保持最小化；同一窗口新增两标签，页面有数据 | 原标签可见 | 原标签可见 | 不得新建窗口或重载 |
| visible-inactive | 不抢焦点；同一窗口新增两标签 | 人主动激活后原标签 | 同理 | 无自动前台转换 |
| visible-active | 不额外建窗；同一窗口两标签 | 已在前台 | 已在前台 | URL/身份/内容一致 |

各状态重复两轮；Dock 与启动台入口应分别测试，不能把两者视作同一条路径。检查 `/api/state-log`、`/api/windows`、原生可见性、CDP targets 和脚本证据；BrowserPilot 单独做普通标签可见性/操作验收。若某站点反爬，换备用真实站点并保留失败证据；不能把空白或加载中判 PASS。

## 5. 自测与交付门槛

1. 代理先跑静态检查、纯单测、脚本 self-test/fixture；浏览器实现的 GUI/真实探针必须使用隔离 profile、端口、目录，不能碰 live 9333、用户默认 profile，也不能抢前台。脚本任务在本轮经用户允许，可有界访问 live 9333 验证真实百度/Bing 数据；两类测试不得混称。不能安全隔离时写 `not-run` 和原因。
2. 负责人审查 diff、边界、日志语义、失败路径和现有 dirty worktree 的保留情况。任何编译/测试失败必须列出，不得声称全绿。
3. 只有代码与脚本相互兼容、可复现自测通过，才在用户明确允许的测试环境部署。部署后先确认 daemon/API/扩展仍可用、零意外窗口；不替用户点击/打开 GUI。
4. 用户最终分别完成四态真实站点目检和 Dock/启动台接管；代理/负责人提供精确命令与结果目录。用户未确认前，状态只能是“待人工验收”，不得 merge/push。

## 6. 已知证据与反例

- `bg-check-B0dxB4`：210 样本均 0 窗口/0 active，只证明可见性；脚本没有采集网页内容。08:40:13/23 建 hidden target，08:40:37 Dock 接管按 URL 创建两个新普通 target，用户观察到重新加载，与代码一致。
- `bg-check-J8MJeP`（2026-09-18 live 旧 runtime）：百度/Bing 隐藏页各 HTTP 200、各 10 条结果，timer 约 4 Hz、rAF 约 100 Hz，239 窗口样本无上屏；只证明隐藏模式可取数/运行，不证明普通标签人工接管。首跑 `bg-check-bgj8Mp` 因导航尚未提交读到 `about:blank`，脚本已改为有界等待。
- 旧 `newWindow:true`、`chrome.windows.create({state:'minimized',focused:false})` 在本机产生多窗口或瞬显，不能再次以 mock 单测代替 macOS 真机证据。
- Chromium CDP 官方协议：`hidden` target 不在标签栏，不能与 `forTab/newWindow` 同时使用。此限制要求做产品层面取舍，而非简单增加日志或等待时间。
