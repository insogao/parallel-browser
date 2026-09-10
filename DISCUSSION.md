# Backlight（后台浏览器）技术方案讨论稿

> 目标读者：任何 AI / 浏览器内核专家。请基于下文**已实测的事实**回答文末的问题。
> 项目：对标 ego-lite 的「AI 后台浏览器」。约束：**不 fork Chromium 源码**（工程量原因），优先 macOS。

## 一、我们要什么

一个基于真实 Chrome/Chromium 的浏览器环境，人和 AI Agent 共用（复用登录态、扩展 100% 兼容）。核心体验：

1. **AI/用户打开的页面在"后台"全速运行**：rAF 不停、定时器满速、页面逻辑照常、截图随时可用
2. **完全不干扰用户**：不抢焦点、不弹窗、最好连一个像素都看不到
3. 插件开发测试一体化（已实现，与本题无关）
4. AI 指令可视化（已实现，与本题无关）

## 二、环境与已实测的硬事实（Chrome 152 / macOS 15 arm64）

以下全部是我们用 CDP + 自动化测试实测的结论，不是猜测：

1. **页面隐藏 → 原生 rAF 暂停**。最小化、被完全遮挡、后台标签，三种状态等价：`document.visibilityState='hidden'`，`requestAnimationFrame` 停摆（0/s），`Page.captureScreenshot` 拿不到新帧。
2. **定时器可以用启动参数保住**：`--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows` 三件套下，隐藏页面 setInterval(100ms) 稳定 10/s。但**没有任何参数能保住 rAF**。
3. **CDP 无法把窗口完全移出屏幕**：`Browser.setWindowBounds` 设 left=-30000 会被 Chrome 钳回。钳制规则实测：**窗口必须保留至少 ~40px 在屏幕可见区内**；left=-1199（窗口宽 1200，露 1px）可以生效。top 方向允许窗口垂出屏幕底边。
4. **帧泵（captureScreenshot 轮询）**：对简单页面（data: URL）有效——每次截图强制 BeginFrame，rAF 能维持 30~45/s。但对重量级页面（x.com 最小化）**永久挂起**（fromSurface:true 等新帧等不到）；`fromSurface:false` 能返回但要 4 秒。
5. **Page.startScreencast 不能驱动 rAF**（实测 1.5/s）。
6. **静音 WebAudio 不能保 rAF**：AudioContext state=running（gain 1e-6，加了 --autoplay-policy=no-user-gesture-required），rAF 依旧 1/s。音频豁免定时器节流，但不管帧调度。
7. **printToPDF 在最小化时可用**（106ms 返回），说明隐藏页面可以强制单次渲染，但没有持续的 rAF。
8. **rAF 垫片（JS 层）**：把 `window.requestAnimationFrame` 重写为「可见时走原生、隐藏时走 Worker 定时器泵（16ms）」，页面逻辑在最小化时能维持 15~60Hz（Worker 定时器也被 Chrome 的后台协同钳制，速率波动），且在 visibilitychange 瞬间要抢救在途的原生回调链，否则链条永久断裂。这是纯 JS 层，不产生真实帧。
9. **贴角模式（当前方案）**：把窗口移到屏幕左下角、只露 2px——Chrome 认为窗口可见 → **原生 rAF 60fps 满速、截图 70~300ms 真实返回、visibilityState=visible**，一切正常，代价是屏幕角落有一条 2px 的细线。
10. **ego-lite（对标对象）的做法**：直接 fork Chromium 源码改 UI，但实测它**没有**处理后台节流（运行参数里没有任何反节流开关），所以它的最小化体验和原版 Chrome 一样差。

## 三、我们尝试过并排除的路径（附失败原因）

| 路径 | 结果 |
|---|---|
| 启动参数禁节流 | 只保定时器，rAF 照停 |
| CDP 移窗口完全出屏 | 钳制弹回（必须留 ~40px） |
| `--window-position=-30000` | 创建时就被钳回屏幕内 |
| `--start-minimized` | Chrome 152 忽略 |
| screencast 泵 | 不驱动 rAF |
| captureScreenshot 泵 | 简单页有效；重量级页面永久挂起（fromSurface:true） |
| 静音音频保活 | 不影响帧调度 |
| AppleScript 移窗口 | AppleEvent 超时/权限提示，不可依赖 |
| 窗口缩到最小藏 Dock 后 | Chrome 最小 500×375，藏不住 |
| rAF 垫片（JS） | 可用但只是"逻辑存活"（15~60Hz 波动），无真实帧、截图问题不解决 |

## 四、当前折中方案及其问题（用户不满意的点）

**贴角模式**：窗口停在屏幕角落露 2px，其余全出屏。原生 60fps、真实截图、visibility 正常。

用户（项目所有者）的反对意见：
1. 收起过程有可见的窗口移动/缩放动画（我们后来改为「出生时直接用 `--window-position` 定在角落 + 单次位置移动」，动画可以消除，但**角落那 2px 永远在**）
2. 从产品洁癖角度，"在屏幕上留一条 2px"本质是妥协，用户质疑：**是不是后台运行做不到，才用这种办法？**
3. 有一个未验证的担心：如果那 2px 恰好被 Dock 完全盖住，窗口会不会被判为"被完全遮挡"而重新暂停渲染？（遮挡判定的全覆盖规则 vs Dock 是特殊图层）

## 五、待讨论的问题（请逐条给结论）

**Q1（核心）：macOS 上有没有办法让 Chromium 以"完全不可见"的状态持续满速渲染？**
比如：特殊 window level、CGWindowList 不可见图层、登录窗口会话、私有 API……只要是稳定可行的，引入一条私有 API 我们也能接受（本地工具，不上架 App Store）。

**Q2：虚拟显示器方案**：macOS 上能否编程创建"虚拟/哑显示器"（如 BetterDisplay 的做法，不要 kext）？如果 Chrome 窗口"可见"于一个没人看的虚拟屏，是不是就是完美解（原生满速+完全不可见）？有没有不需要第三方常驻软件的实现？

**Q3：被系统捕获的窗口是否豁免遮挡节流？** 如果页面/我们的进程通过 `getDisplayMedia` 或系统 ScreenCaptureKit 捕获该 Chrome 窗口，Chromium 是否会因"窗口正在被捕获"而保持其帧生产？（Windows 的遮挡计算有捕获豁免；macOS 的 NSWindow occlusionState 路径是否同样豁免？）若成立，"自我捕获保活"可能是一个纯软件的完美解。请给出验证思路。

**Q4：CEF 的 offscreen rendering（OSR）**：CEF 窗口隐藏时 OSR 持续产帧是成熟能力。若我们把外壳从"spawn 系统 Chrome"换成"CEF 应用"，OSR + 隐藏窗口 = 完美后台。关键疑问：CEF 的 Chrome 扩展支持现状如何（MV3 content script / service worker / declarativeNetRequest / chrome.tabs）？能否达到"扩展测试 100% 兼容"的要求？

**Q5：Electron 的 `offscreen: true`** 同问：OSR 下隐藏窗口持续渲染已知可行，但扩展兼容是残缺的（无 declarativeNetRequest 等）。有没有让 Electron 使用完整 Chromium 扩展系统的工程手段？

**Q6：Chrome 对"正在被捕获/投影"的标签页有节流豁免**（比如 Chrome 自带的"标签页正在共享"状态）。有没有 CDP/策略层面的方式把任意标签标记为"捕获中"从而豁免？（`Browser.setDocumentContent`？`Page.startScreencast` 不行，已测。）

**Q7：多桌面/Space**：把窗口移到另一个 Space（用户看不到）在 macOS 上有没有不关 SIP、不装 yabai 的编程方法？移过去之后 Chromium 的遮挡判定如何（设计文档说"其他 Space = occluded"→ 会暂停，所以这条路可能本身就错，请确认）。

**Q8：如果未来允许小规模 fork Chromium**：要让"隐藏窗口持续产帧"，最小补丁是什么？是改 `RenderWidgetHostImpl::is_hidden` 的消费端（`WidgetScheduler` 的 BeginFrame 门控）、还是加一个 `--keep-rendering-hidden` 开关？大致涉及哪些文件（content/renderer? components/viz?），以便评估工作量。

**Q9：产品取舍建议**：在 Q1~Q7 都无解的前提下，"贴角 2px（满速）默认 + 纯最小化（垫片逻辑）可选"的双模式是否是合理的产品形态？还是宁可默认纯最小化、牺牲 rAF 真实帧（逻辑照跑、截图用 fromSurface:false/printToPDF 慢速兜底）？

**Q10：双实例架构**：一个可见实例给用户 + 一个 headless=new 实例给 AI，user-data-dir 不同、用 cookie 同步桥接。相比单实例贴角，这个方向的复杂度/体验如何评估？（Chrome 129+ 是否已有官方的多实例共享 profile 方案？）

## 六、硬约束重申

- 扩展（尤其 MV3 DNR、storage.sync、chrome.tabs）必须与 Chrome 行为 100% 一致 → 这是排除 Electron 自研壳的原因；CEF 路线的全部意义也取决于其扩展保真度
- 不分发 Google Chrome；可下载 Chrome for Testing / Chromium
- 单实例内"人用窗口 + Agent 后台页"共存、登录态共享是理想形态；能被更好架构替代也可以讨论
- 首选 macOS（Windows 的 CalculateNativeWinOcclusion 有现成豁免旗标，问题不大）
