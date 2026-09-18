# 任务 B：单一窗口真实标签路径（2026-09-17，第二轮产品取舍）

范围：`packages/daemon/`（会话/窗口协调、API、状态日志、单测与隔离探针）＋设计说明。
代理未改根 `manual-bg-check.mjs`、BrowserPilot、tray/launcher Swift，保留 worktree 全部既有
dirty 修改。**2026-09-18 负责人后续已将本功能代码更新到 live runtime 并重启（未 merge/push），
实际状态以根 `/Users/jiangao/work/browser/MAINTAINER-HANDOFF.md` 为准；本文件的“未部署”
只描述代理结束时的历史边界。**

## 1. 产品取舍与可行性结论

**新取舍（用户 2026-09-17）**：零窗口冷启动允许窗口**出现一次**，优先保证 AI 后台页与
后来人工打开是**同一受管真实窗口里的同一真实标签/同一文档**；不能反复弹窗、多窗口或
URL 克隆。该许可 **不等于** 每次后台开页都可抢前台。

**可行**（有隔离真机证据，见 §6）：

- 零窗口首次后台开页创建**一个真实 target**（`background:true`），Chrome 必须为它建第一个
  原生窗口；macOS 会让窗口上屏（实测在离屏角位置约 1s），但隔离探针中 **AppKit
  `active=false` 全程成立**，即不抢前台、不激活应用。
- 随后立即把该窗口设为后台：先 `HealthMonitor.refresh` 让新页进入健康快照，再用
  capture helper 在窗口仍可见时装定（可见装定才有真实帧），然后
  `Browser.setWindowBounds minimized` + `app-control hide` 有界校验。实测 settle 后
  15 个样本 0 违规（minimized + hidden）。
- 之后人工打开（Dock/启动台/菜单/`bl show`）恢复的是**同一个 windowId、同一个 targetId、
  同一份内存 JS（nonce/timeOrigin 不变）**；实测 `sameTargetAfterShow=true`、
  `sameDocumentAfterShow=true`、`pageTargetsAfterShow=1`。
- 同一会话内窗口丢失后，后台开页返回 **409**，不再创建第二个窗口（“不能反复弹窗”），
  除非人工显式开窗或调用方显式选择不可接管的 `windowless:true` 协议页。

**明确不做**：`newWindow:true`、`chrome.windows.create`、URL 克隆、每次后台开页都抢前台、
用 mock 冒充 macOS 证据。

## 2. 单一窗口路径：时机、后台化、触发面

状态存于 `managed-window.ts`（按 CDP 连接）：`managedWindow`（当前受管 windowId）、
`firstDisplayUsed`（一次性显示是否已用）。

后台开页 `POST /api/open`（`/api/launch` 带 URL 时同路径）：

1. **已有受管窗口**（`Browser.getWindowBounds` 可读）：只在该窗口
   `Target.createTarget({background:true})` 新增普通标签，绝不动窗口状态；若 Chrome 因
   创建标签而解除 AppKit hidden，则补 `hide` 并记 `native-hide/verified`。
2. **无受管窗口但存在窗口**：确定性采纳最老 windowId 为受管窗口（`managed-window/adopt`），
   再按 1 复用。
3. **零窗口且本会话未用过一次性显示**：记 `managed-window/create-requested` →
   **先 `markFirstDisplayUsed` 再发 `Target.createTarget`**（`background:true`）——
   create 是不可逆副作用，额度必须先消耗；解析 windowId 成功才登记，
   解析失败则关目标、记 `first-display-unresolved`、fail-closed（不会再次弹窗）→
   后台化（见下）→ 响应 `firstDisplay:true`。
4. **零窗口且一次性显示已用**：409 `managed window unavailable`，不创建任何东西；
   hint 指向人工 `bl show` / `login` 或 `{"windowless":true}`。
5. **`windowless:true`**（显式受限模式）：沿用协议级 hidden target（不建窗口、不可接管、
   BrowserPilot 不可见），响应 `takeover:false` + `adoption:'unsupported'`；**只在零窗口时
   执行后台 hide**，已有窗口的原生可见性不得改变，且创建前后窗口集合必须不变，否则关目标并失败。

**并发串行化**：`withWindowLock` 以 `ServerDeps`（即 daemon/manager 会话）为键，
`/api/open`（含冷启动 launch）、`/api/launch`（launch+开页）、`/api/show`/`login` 的
人工建窗+恢复（**含 `native.persist` unhide/activate**）都在同一临界区。
`firstDisplayUsed`/`managedWindow` 是读-改-写状态，双并发 `/api/open` 或 launch/open 并发
若不串行会双建窗口；同窗口开页也只允许一个在途。

**复用路径的人工优先（P0 竞态修复）**：`openBackgroundTab` 不再仅凭创建前读到的
`wasHidden` 就 hide。它在 create 前快照 `controlGen`/`humanMode`，create 完成后用
**新鲜证据**决定是否 hide：

- 任一时刻 `humanMode=true` → `native-hide/skipped-human-takeover reason=human-mode`；
- 期间出现更新 generation（`/api/show`、`/api/login`、`/api/console`、inspect/dev 等）→
  `reason=newer-control-intent`；
- `appState` 不可读 → `reason=state-unknown`（不做原生操作，fail-safe）；
- 新鲜 `active=true`（Dock 激活应用）→ `reason=active-app`；
- 创建前该窗口为 minimized、创建后不再 minimized（后台 `background:true` 创建不会恢复
  最小化）→ `reason=restored-window`（Dock 非激活式恢复也能识别）。

命中任一条件则**不 hide、不关标签**，响应 `settled:false` + `settleReason`，标签仍在同窗口。
`settleFirstWindow` 在 collapseAll 之后、hide 之前增加同样的 `humanMode/gen/fresh.active/
state-unknown` 再校验。`/api/show`、`login` 的 restore+persist 已并入锁内，排在其后的后台
开页必然看到 `humanMode`/新 generation。

**后台化时序**（仅首次创建时执行，`settleFirstWindow`）：

```
managed-window/settle-requested
  → HealthMonitor.refresh（新 target 进入快照，visibility=visible）
  → CaptureKeepAlive.prearm（窗口仍可见时装定，之后最小化仍有真实帧）
  → FramePumpSupervisor.collapseAll（按 settings.collapseMode：minimize 或 2px corner；
    不 bump control generation，人工意图可随时 supersede）
  → app-control hide（有界校验 hidden）
  → managed-window/settled | settle-failed（记录 capture/windowState/cornered/appHidden）
```

- 若 `supervisor.humanMode=true`（人工 show/login 正在执行）→ `settle-skipped reason=human-mode`，
  绝不收掉用户刚要看的窗口；若期间有更新的人工 generation → `reason=superseded`。
- settle 失败不关闭页面、不伪造成功：响应 `settled:false` + `settleReason`，日志 `settle-failed`。

**可触发显示（上屏）的操作**：

| 操作 | 是否可显示 | 约束 |
| --- | --- | --- |
| 零窗口后台 `POST /api/open` / `POST /api/launch`（带 URL） | 仅本会话第一次（一次性） | 创建后立即后台化；不 activate/unhide；不设前台 |
| 之后同一窗口的后台开页 | 否 | 只加后台标签；若 Chrome 原生 unhide 则补 hide |
| 人工 `POST /api/show`（Dock 菜单/`bl show`）、`/api/login`（启动台）、`/api/console`、`/api/inspect`、`extensions/dev` | 是（explicit 来源） | `/api/login`、`/api/console`、`/api/inspect`、`extensions/dev` 需 explicit source |
| `POST /api/bg`、capture/健康探针、tray auto | 否 | auto 显示请求一律拒绝并记录 |
| 一次性显示已用且窗口丢失 | 否（后台路径 409） | 只能人工显式开窗或 `windowless:true` |

## 3. 四态 × 入口归属矩阵（实现后）

一个 daemon、一个受管默认 profile/space，所有入口同一 `session` id。

| 起始状态 | 窗口/标签归属 | 后台打开两个真实页 | Dock 点击（`tray.auto.*`） | 启动台/菜单显式打开 | 判定 |
| --- | --- | --- | --- | --- | --- |
| closed（0 窗口） | 首开后产生唯一受管窗口 | 第 1 页创建窗口（可上屏一次，active=false），后台化；第 2 页复用同窗口后台标签；两页均为真实 `type=page` target | OS 观察不构成人工点击 → 拒绝自动还原；窗口最小化时 Dock 由 macOS 原生恢复同一窗口 | 建/恢复同一窗口（不克隆隐藏页） | 真实标签、同文档：已由隔离真机探针证明；四态整体仍待用户目检 |
| minimized | 同一受管窗口（minimized） | 同窗口普通后台标签；create 引发原生 unhide 时补 hide | 拒绝自动还原；macOS 原生恢复的原标签即 AI 原页 | 恢复/最大化同一窗口 | 同文档 |
| visible-inactive | 同一受管窗口 | 同窗口普通后台标签，不抢焦点、不激活标签 | 拒绝自动激活 | 人工恢复同一窗口 | 同文档 |
| visible-active | 同一受管窗口 | 同窗口普通后台标签，不动当前激活标签 | 已在前台 | 已在前台 | 同文档 |

## 4. 状态日志与 API

`GET /api/state-log` 每条转移带 `session`，新增 `managed-window` 事件：

| event/branch | 含义 | 关键 detail |
| --- | --- | --- |
| `managed-window/create-requested` | 零窗口一次性创建被批准 | `reason=zero-window-cold-start one-time-display=true` |
| `managed-window/created` | 窗口已建立并登记 | `windowId=… first-display=once` |
| `managed-window/reuse` | 复用同一受管窗口 | `same-window windowId=… firstDisplay=false` |
| `managed-window/adopt` | 采纳既有窗口/Human 窗口 | `existing-window` 或 `human-explicit-window` |
| `managed-window/first-display-unresolved` | create 已发生但 windowId 解析失败（额度已消耗，fail-closed） | `attempt=consumed state=unresolved` |
| `managed-window/rejected-placement` | 标签落到非受管窗口，已关闭该标签并失败 | `placed=… expected=…` |
| `managed-window/lost` | 受管窗口已不可读 | `window-gone` |
| `managed-window/refused` | 一次性显示已用，拒绝再弹 | `one-time-background-first-display-used` |
| `managed-window/settle-requested` | 开始后台化 | `capture-prearm,then-minimize+native-hide` |
| `managed-window/settled` | 后台化完成 | `capture=armed|none|failed windowState=… cornered=… appHidden=true` |
| `managed-window/settle-skipped` | 人工意图优先 | `reason=human-mode|superseded` |
| `managed-window/settle-failed` | 未能后台化（诚实报告） | 同上字段，appHidden 可能为 false |
| `native-hide/skipped-human-takeover` | 复用窗口时人工已接管，拒绝再 hide | `reason=human-mode|newer-control-intent|active-app|restored-window|state-unknown`，`after=visible` |

API：

- `POST /api/open`：响应 `{ ok, targetId, windowId, windowless:false, takeover:true,
  reusedWindow, firstDisplay, settled, [settleReason], session }`；零窗口一次性显示已用 → 409；
  `windowless:true` → hidden 协议页（`takeover:false` + capability）。
- `POST /api/launch`：背景 + URL 不再把 URL 交给 manager（避免 hidden 页），统一走
  `openManagedPage`，响应带 `windowId/firstDisplay/settled`；foreground 启动照旧并由路由登记
  受管窗口。
- `GET /api/status.session`：`{ id, space, pid, startedAt, managedWindowId, firstDisplayUsed,
  windowlessPages, takeover: 'real-window' | 'windowless-limited' | 'none' }`。
- `GET /api/capabilities.zeroWindowRealTab`：`{ supported:true, firstDisplay:'once-per-browser-session',
  sameWindowReuse:true, windowlessFallback:true, reason, evidence }`；`windowless.adoption`
  仍为 `unsupported`。
- 既有窗口放置校验：创建后的 target 必须落在创建前已存在的窗口，否则关闭该标签并失败
  （绝不产生第二窗口）。

## 5. 变更文件

- 新增 `packages/daemon/src/managed-window.ts`：受管 windowId、一次性显示、liveness、
  target→window 有界解析。
- `packages/daemon/src/proxy.ts`：`openManagedPage` / `openBackgroundTab` /
  `settleFirstWindow`，`ensureManualWindow` 登记人工窗口，`/api/open`、`/api/launch`、
  `/api/status`、`/api/capabilities` 更新；保留 windowless 显式模式与其拒绝日志。
- `packages/daemon/src/inject.ts`：`HealthMonitor.refresh()`（新窗口在可见时装定 capture 用）。
- `packages/daemon/src/browser.ts`：背景首启 URL 改为真实 target（原 hidden 页路径删除）；
  仅 restart 到达该路径，用户面后台开页统一走 managed-window 路由。
- `packages/daemon/src/window-open.ts`：能力 evidence 更新为真实标签取舍。
- 单测：新增 `tests/managed-window-unit.ts`（4 项）；`tests/window-intent-unit.ts` 37 项
  （重写/新增：冷启动唯一窗口+后台化时序、重复开页复用、窗口丢失 409 + 人工重建、
  windowless 显式模式、`windowless:false`、第二窗口拒绝、launch 同路径、capabilities、
  session 归属，以及 P0 修复的 5 项：并发 open 串行化、并发 launch+open 串行化、
  解析失败消耗额度、错误放置窗口拒绝、windowless 保持既有窗口可见性）；
  `tests/launcher-unit.ts` login stub 适配。
- 新增 opt-in 真机探针 `tests/probe-managed-window.ts`（不进默认链）。
- 本说明文档。

## 6. 测试结果

纯静态/单测：

```bash
pnpm -r --if-present run check            # daemon + cli tsc --noEmit，通过
pnpm --filter @backlight/daemon test:unit # 124 项：123 pass / 1 fail
```

- 唯一失败仍是**环境预存**：`launcher-unit.ts:345` 编译 Swift 时本机 CommandLineTools
  SDK/compiler 不匹配（`redefinition of module 'SwiftBridging'`，`import Foundation` 即复现），
  与本轮改动无关；未用 mock 掩盖。`managed-window-unit` 4/4、`window-intent-unit` 39/39。
- P0-1 并发测试做了红绿验证：临时关闭 `withWindowLock` 后两条并发测试均失败
  （双窗口/双 launch），恢复后通过。
- 复用路径人工优先做了红绿验证：临时取消 `openBackgroundTab` 的新鲜证据守卫后，
  “human show during in-flight open”与“Dock-style restore”两条确定性测试均失败
  （隐藏了人工窗口），恢复后通过。

隔离真机探针（有界，非默认链）：

```bash
caffeinate -dis node packages/daemon/tests/probe-managed-window.ts
```

结果 `ok:true`（2026-09-17，隔离 Backlight.app 副本 sha256 `8ac78806…c3dc`、临时
profile、随机端口 53732、直接 spawn，不经过 live daemon/9333/默认 profile）：

```json
{
  "firstDisplay": { "visibleSamples": 9, "activeSamples": 0, "samples": 10 },
  "settle": { "minimised": true, "hidden": true, "samples": 15, "violations": 0 },
  "identity": {
    "aliveWhileBackgrounded": true,
    "noncePreservedWhileBackgrounded": true,
    "sameTargetAfterShow": true,
    "sameDocumentAfterShow": true,
    "pageTargetsAfterShow": 1
  }
}
```

即：首窗上屏约 1s（离屏角、`active=false` 不抢前台）→ 最小化+隐藏 0 违规 →
后台期间 target/nonce 不变 → 模拟人工打开恢复同一 target/文档、无第二个窗口。
探针成功即清理临时目录与进程；无残留（已复核）。

## 7. 未解决限制

1. **首窗上屏可被用户看到一次**（本次实测约 1s、离屏角、不激活）。这是产品接受的取舍；
   若用户认为仍打扰，可把 `collapseMode` 调为 corner 或改用 `windowless:true`。
2. **窗口被用户关闭 = 真实标签与内存页一并消失**（真实标签语义，非 hidden target）。之后
   后台开页 409，需人工 `bl show`/启动台重建；daemon 不会为 AI 反复弹窗。重启同理
   （已用 `windowless-dropped` 显式报告）。
3. **capture 只保一个目标**：首个 settle 装定的目标有真实帧；后续同窗口后台标签依赖
   frame pump / rAF shim，与既有产品行为一致。
4. **四态真实站点与 Dock/启动台接管未由本轮执行**：daemon 级 GUI 链会用 `open -g -j -a`
   启动隔离 app 副本，而 live Backlight 正在运行，`open -a` 存在被 LaunchServices 归并到
   用户实例的风险，故标记 **not-run**（安全优先）；架构问题已由直接 spawn 的探针证明。
5. **`type=page` 判定**：放置校验依赖 `Browser.getWindowForTarget`；异常窗口一律关闭并
   失败，属 fail-closed。
6. **Dock 非激活且未恢复窗口的极端点击无法证伪**：守卫覆盖“app 变 active”与
   “窗口 minimized→normal”，两者都不发生时（罕见）仍会按后台契约 hide；`appState` 读不到
   时选择不 hide（fail-safe），以人工可见性优先。
7. **旧验收脚本仍需区分**：根 `manual-bg-check.mjs` 已于 2026-09-18
   适配一次性 first-display 能力，并经隔离真实百度/Bing 测试；但仓库内旧
   `test:bg-invisibility` 的 closed/零窗口断言仍以“首次后台开页全程 0 可见”为目标，
   不应直接拿它的旧口径判断新取舍。根脚本的 `visibility-pass` 也不能代替
   `content/sustained/handoff/BrowserPilot` 四项独立结论。
8. **第二个隐藏标签 rAF 未证明满速**：隔离真实搜索 `/Users/jiangao/work/browser/bg-check-cUICoV/`
   中百度与 Bing 都在同一真实窗口、内容各 10 条结果、timer 4Hz；但第二个 Bing 标签
   `document.visibilityState=hidden`，rAF 仅 13.4Hz，因此 `sustained-incomplete`、
   整体 exit 2。当前 capture 只保一个目标，不能把首标签的 rAF 证据推广给所有标签。

## 8. 证据边界

“同一窗口/同一真实标签/同文档”已有隔离真机证据；四态矩阵整体、Dock/启动台物理入口与
capture 真实帧仍属**待人工验收**，不得据本文档宣称全部 PASS。代理自身未触碰 live
runtime、9333、用户默认 profile、根 `manual-bg-check.mjs` 或 BrowserPilot；负责人后续已
独立部署 live，详情见根交接文件。
