# Backlight（后台浏览器）项目索引 · 交接文档

> **本文档是项目的唯一权威入口**。目标读者：接手开发的 AI 或工程师。
> 生成时间：2026-09-12。当前所有代码已提交至本地 git（无远端，GitHub 直连不通）。
> 用户已报告的待办问题集中在「第五节」，**P0 是 Dock 图标问题（用户当前最关心）**。

---

## 一、项目是什么

**Backlight（后台浏览器）**：一个对人和 AI Agent 都友好的浏览器监督器，基于「监督器 + 真实 Chromium 内核」架构（不是 fork，不碰用户的 Chrome 本体）。对标 ego-lite，反超点：

1. **页面在后台原生 60fps 满速运行**（最小化也满速，连 rAF 都是原生的）
2. **插件开发热重载**：改扩展源码自动重载，一条命令带插件直达目标网站
3. **AI 指令可视化**：页面光环 + 菜单栏托盘闪烁 + 活动流
4. **cookie/登录态一键导入**：从本机 Chrome 复制，实测 x.com 直接是登录态
5. **品牌化**（新）：`bl brand` 把浏览器变成用户自己的名字+logo，Dock 一眼区分

## 二、当前状态（截至交接）

- **全部测试 13 项通过**：`pnpm --filter @backlight/daemon test`（必须用 caffeinate，见第七节）
- 浏览器当前**未运行**（用户重启过电脑）；守护进程随任意 `bl` 命令自动拉起
- 品牌浏览器已生成：`~/Library/Application Support/Backlight/apps/Backlight.app`（bundle id `dev.backlight.browser`，引擎 Chrome for Testing 153）
- git 提交历史干净，夜间巡检（每小时）确认测试持续全绿

## 三、目录结构

```
/Users/gaoshizai/work/ego/
├── README.md               # 面向用户的完整文档（机制/用法）
├── PLAN.md                 # 夜间执行计划（含历史状态记录）
├── DISCUSSION.md           # 方案调研文档（当时的困惑，多数已解决）
├── PROJECT_INDEX.md        # 本文件
├── package.json            # pnpm monorepo 根
├── tools/
│   ├── winlist             # CGWindowList 工具（检测在屏窗口，测试用，二进制）
│   ├── winlist.swift       # 同上源码
│   └── genicon.swift       # 品牌图标生成器源码（Swift，备选方案）
└── packages/
    ├── daemon/             # 核心（Node 25 原生 TS 直接运行）
    │   ├── src/
    │   │   ├── index.ts    # 入口：组装所有模块 + 信号处理
    │   │   ├── browser.ts  # 浏览器生命周期（启动/open -g -j/重启/停止）、CfT 下载
    │   │   ├── capture.ts  # ★ capture keep-alive（后述，核心机制）
    │   │   ├── windows.ts  # ★ FramePumpSupervisor（collapse/restore/帧泵/贴角）
    │   │   ├── inject.ts   # ★ 健康计数器 + rAF 垫片 + 光环注入
    │   │   ├── proxy.ts    # CDP 代理(HTTP+WS 透传) + REST API + Dashboard
    │   │   ├── tap.ts      # CDP 指令打点分类（AI 活动检测）
    │   │   ├── brand.ts    # ★ 品牌化（PNG 编码器/icns/plist 补丁）
    │   │   ├── import.ts   # cookie/登录态导入
    │   │   ├── extensions.ts # 扩展注册表 + 热重载监听
    │   │   ├── cdp.ts      # 极简 CDP 客户端（flat 协议 + session）
    │   │   ├── store.ts / paths.ts / ports.ts / log.ts / activity.ts
    │   ├── tests/          # spike / supervisor / extensions / agent / background / import / brand / probe-capture
    │   └── package.json
    ├── cli/                # backlight (bl) 命令行
    └── tray/               # Swift 菜单栏托盘（main.swift + build.sh）
```

## 四、功能与用法速查

```bash
alias bl="node $(pwd)/packages/cli/bin/backlight.js"
bl launch https://x.com     # 后台启动（零弹窗零焦点）；--focus 强制弹出式
bl show / bl bg             # 恢复窗口显示 / 一键收起（原生最小化）
bl open <url> --with <扩展> # 带扩展开新页
bl ext add <目录> / ls / rm # 插件热重载开发循环
bl import --list / bl import [--profile X]   # 导入 Chrome cookie/登录态
bl brand --name X --icon logo.png            # 品牌化浏览器（见 BUG-1）
bl tray                     # 菜单栏托盘（AI 指令闪烁 + 激活自动还原窗口）
bl status / health / windows / activity / doctor / stop
```

Dashboard：`http://127.0.0.1:9333/`。AI 接入：Playwright `connectOverCDP('http://127.0.0.1:9333')`。

## 五、待办问题（用户已报告，按优先级）

### BUG-1【P0】品牌化后 Dock 图标仍显示 "Chrome + Test 徽标"
- **现象**：用户重启电脑后图标依旧（tooltip 名字已是 "Backlight"，说明 plist 生效了，**只有图标没生效**）
- **已尝试并无效**：替换 CFBundleIconFile→backlight.icns（icns 本身已验证有效：iconutil 解包可见设计的圆环+B）；LS 强制注册（lsregister -f）；图标缓存服务重启（iconservicesagent）；killall Dock；改独立 Bundle ID（dev.backlight.browser）+ 重新注册；**重启电脑**
- **当前最强假设**：Chromium 在运行时用硬编码的资源名 `app.icns` 加载并 setApplicationIconImage，覆盖了 CFBundleIconFile 指向的文件
- **下一步（按序）**：
  1. `brand.ts` 的 brandBundle 里，写完 backlight.icns 后**把同目录 `app.icns` 的内容替换为 backlight.icns 的字节**（文件名保留）——已定位未实施
  2. 同样扫描并替换 `Contents/Frameworks/` 下 framework 里的 .icns（当前只查了浅层）
  3. 重新 `bl stop && bl brand && bl launch` 验证（工具：`tools/winlist` + `sips` 渲染 icns 抽帧自查；**注意：屏幕截图权限未授权给 ZCode helper，无法直接截屏**，需用户目视或用 icns 解包自查）
  4. 若仍无效 → Chromium 运行时绘制/强制图标坐实 → 只能 fork（给 Agent WebContents 顺便换图标）或接受现状（tooltip 名字已可区分）
- **关联文件**：`packages/daemon/src/brand.ts`（brandBundle）、`tests/brand.ts`
- **注意**：不要重签名（`codesign --deep` 会剥掉 helper 的 JIT entitlements → arm64 渲染器秒崩，浏览器自杀，已踩坑）

### BUG-2【P1】点击 Dock 图标"没反应"（用户报告）
- **已做**：collapseMode 默认改为**原生最小化**（765725b），Dock 点击天然恢复；托盘加了 NSWorkspace 激活监听（PID 匹配我们的实例才触发 POST /api/restore），已重建重启（2881306）
- **未验证**：用户上次报告在此修复之前。**下一步**：确认托盘在跑（`ps aux | grep "Backlight Tray"`，没有就 `bl tray`）→ 点 Dock 图标 → 窗口应在 ~1s 内还原
- **若仍无反应的排查方向**：托盘激活监听是否命中（加日志）；Chrome reopen 行为（全部窗口最小化时 reopen 会开新窗口——新窗口出现=体验达标）；`/api/restore` 手动 curl 是否生效
- **注意**：用户自己激活"他的 Chrome"不会误触发（PID 匹配）

### BUG-3【P2】捕获生效后 DOM visibilityState 冻结未生效
- 现象：捕获建立后 `document.visibilityState` 仍可能读 `hidden`（rAF 60fps 和截图不受影响，纯语义）
- engage 成功后有冻结注入代码（capture.ts，defineProperty document.visibilityState/hidden），但实测未生效，原因未查
- 排查方向：evaluate 所用 session 是否与页面当前 document 匹配；异常是否被静默吞掉

### BUG-4【P2】shim rAF 计数在 SPA 长会话出现异常大数值（如 4255/s）
- 原因未查（疑似多计数链累加或采样 dt 异常）。**nativeRafPerSec 才是真实帧率**，UI 已同时展示两者
- 方向：health bootstrap 防重入加固；或对 rafPerSec 做上限截断显示

### BUG-5【P3】多次启动后标签页重复累积（标签恢复机制）
- 现象：health 里出现 3 个同名 36氪 标签
- 方向：launch 时若已有同 URL 标签则复用（openOrReuse 语义）

### BUG-6【P3】capture 10fps 编码有 CPU 成本
- 方向：帧率降到 2-5（先验证豁免是否依赖 fps——大概率只看 capturer count，见 tests/probe-capture.ts）

### 增强（v0.2 候选，用户未催）
- 多标签并发 capture（tabCapture 扩展或小 fork：每个 Agent WebContents 持 capture token）
- space 管理 UI、`snapshot` 内置命令、站点技能包（对标 ego-lite Skills）、agent harness 自动装 skill
- `npm i -g` 打包、CFBundleExecutable 改名（完整品牌化，有风险未做）

## 六、已验证的架构事实（**不要重新踩坑**，全部实测）

1. **隐藏页面 rAF 必停**：最小化/遮挡/后台标签 → visibilityState=hidden、原生 rAF=0。`--disable-background-timer-throttling` 三件套只保定时器，**没有任何参数保 rAF**。screencast、静音 WebAudio、`open -j`、完全出屏（被钳制，必须留 ≥40px）全部无效，勿再尝试
2. **★ Tab Capture 豁免（核心机制）**：被捕获的 WebContents 上报 `kVisible`——最小化时原生 rAF 60fps、截图 70-90ms 真实帧、visibilityState 可冻结为 visible。触发链：launch 参数 `--auto-select-tab-capture-source-by-title=BACKLIGHT_AGENT` + `--blink-settings=displayCaptureRequiresUserGesture=false`（绕手势）+ 常驻 controller 页（daemon 自带 `/controller` 路由）`getDisplayMedia({video:{frameRate}})`。**限制**：发起方必须是活跃可见标签（隐藏发起会 InvalidStateError）→ capture.ts engage 时先激活 controller 再捕获再切回；单 magic title → 同时只保活一个目标；**捕获流跨最小化持久**
3. **贴角**：窗口必须留 ~40px 在屏；留 2px 可生效且原生满速。当前 collapseMode 默认 `minimize`（原生最小化 + capture），corner 是 fallback
4. **启动模式**：background（默认）= `open -g -j`（无实例时）+ `--no-startup-window` + `--window-position=<角落>`（出生即贴角，**visible 模式严禁走 open -g -j，会永久隐藏**——踩过）；实例已运行则直接 spawn
5. **cookie 导入**：文件级复制（Network/Cookies、Login Data、Web Data）。macOS 钥匙串密钥按应用区分 → **仅同二进制可解密**（Google Chrome→Google Chrome ✓；CfT/品牌引擎需手动登录）
6. **CfT 下载**：`@puppeteer/browsers`，共享缓存 `~/Library/Caches/Backlight/browsers`，主源失败自动切 npmmirror。Google 存储 CDN 时好时坏
7. **品牌化**：复制 CfT.app → 改名/图标（生成器：纯 JS PNG 编码 + sips/iconutil）/独立 bundle id `dev.backlight.browser` → lsregister -f + killall Dock。**绝不 re-sign**（--deep 剥 JIT entitlements → 渲染器崩）
8. **Chrome 136+ 忽略 --load-extension** → 带扩展启动自动换 CfT 引擎

## 七、开发规约（踩过的坑）

1. **Node 25 原生 TS（strip 模式）**：禁止构造函数参数属性（`constructor(private x)` 直接崩），用显式字段赋值；禁止 enum/namespace
2. **测试**：`pnpm --filter @backlight/daemon test`（串行 6 个文件）。**必须 caffeinate**（显示器睡眠会污染所有窗口可见性断言——已用 `caffeinate -dis` 包裹）。非侵入设计：窗口只允许基线阶段可见 ~2 秒。测试从 `packages/daemon/` 目录跑（内部用相对路径 spawn daemon）
3. **屏幕截图权限未授权**给 ZCode helper——GUI 验证用 `tools/winlist`（窗口位置）、icns 解包、health API 代替；需要用户目视的明确列出
4. **网络**：GitHub 直连不通（勿 push/clone）；npmjs/npmmirror/googleapis 时通时断（下载有镜像回退）
5. **不要动用户自己的 Chrome**：只操作 `~/Library/Application Support/Backlight/` 下的受管实例
6. 每完成一个任务：`pnpm -r --if-present run check` + 相关测试 + git commit

## 八、验收标准速查

- **后台满速**：最小化状态下目标 nativeRafPerSec ≥ 45（health API），截图 < 3s 且非陈旧帧（tests/supervisor.ts）
- **后台启动零打扰**：启动全程 winlist 探测无窗口出现在 left ≥ 0 区域（tools/winlist）
- **插件循环**：改 manifest 版本 → ≤20s 热重载生效 → 新 content script 版本运行（tests/extensions.ts）
- **capture 豁免**：tests/probe-capture.ts 的 AB 对照（无捕获 0/s，有捕获 60/s）

## 九、晨报遗留（夜间自动化 08:11 报告摘要）

夜间全部计划任务完成；13 测试全绿持续确认；自动化已自毁。遗留即本文件第五节内容。
