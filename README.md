# Backlight · 后台浏览器

Backlight 是 macOS 上的 Chromium 浏览器监督器：AI 可通过本机 CDP 接口静默创建网页，用户可以从 Dock 或菜单栏展开窗口，辅助登录、扫码和插件调试。浏览器使用独立 profile，不修改用户平常使用的 Chrome。

## 使用

需要 pnpm、支持原生 TypeScript 的 Node（本机验证版本 25）以及 macOS Swift 编译工具。

```bash
pnpm install
alias bl="node /Users/gaoshizai/work/ego/packages/cli/bin/backlight.js"
bl launch https://example.com    # 后台启动，自动启动菜单栏托盘
bl open https://example.org      # 开新页，保持已有窗口位置
bl show                         # 展开窗口、进入人工接管
bl show --maximize              # 展开并最大化
bl bg                           # 最小化、隐藏应用，继续后台运行
bl status
bl health
bl stop
```

也可以点击 Backlight 的 Dock 图标，或使用菜单栏的“恢复窗口显示”。点击会路由到受管浏览器：即使 macOS 激活了同一品牌应用的另一个实例，也会将真正运行网页的窗口显示出来。用户自己的 Google Chrome 不参与此路由。

控制台默认地址：[本机 Backlight 控制台](http://127.0.0.1:9333/)。包含窗口控制、扩展注册、侧栏开发、调试目标列表、后台健康度和活动记录。

## 真实侧栏开发

扩展需要在 manifest 中声明 `side_panel.default_path` 和 `sidePanel` 权限。示例位于 `examples/side-panel/`，支持读取网页、高亮标题和保存笔记。

```bash
bl ext add /Users/gaoshizai/work/ego/examples/side-panel --name demo
bl ext dev demo http://127.0.0.1:9333/demo
bl targets                     # 网页、扩展侧栏和后台脚本的 targetId
bl inspect <targetId>          # 在独立窗口调试所选目标
bl ext reload demo             # 只重载扩展
bl ext ls
bl ext rm demo
```

保存扩展文件后，Backlight 使用 Chromium 的 `Extensions.loadUnpacked` 更新该扩展，不重启浏览器、不刷新网页，保留网页中的未提交输入和扩展本地存储。内容脚本修改后需要手动刷新目标网页；侧栏重载后可再次执行 `ext dev`。错误会显示在控制台及活动记录中，不会偷偷改为重启浏览器。

`ext dev` 会重新打开指定窗口的原生侧栏，并使用一个短暂的后台扩展页面发起打开操作。因此扩展页面代码可能额外初始化一次；临时页面随后关闭。侧栏临时内存状态可能随重新打开丢失，持久笔记应放入 `chrome.storage`。

这些开发接口需要近期 Chromium / Chrome for Testing；已有 Google Chrome 实例不支持时会返回错误，请关闭后带扩展重新启动，或使用品牌化 CfT 引擎。

## AI 接入与后台边界

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
```

- 默认后台启动；REST `/api/open` 使用后台标签，不移动或展开用户正在使用的窗口。
- 最小化后的多标签网络加载、定时器轮询已通过本地端到端测试。
- 原生渲染捕获保活目前同时覆盖 **一个目标**。其他页面使用定时器与 rAF 逻辑调度兜底，不能保证所有标签的原生渲染都为 60fps。
- 健康面板分别报告逻辑帧率、原生帧率和定时器频率，不伪造 `document.visibilityState`。
- 人工接管会暂停新的捕获设置，避免后台控制器切换标签；现有捕获可继续。`GET /api/status` 的 `control` 字段为 `human` 或 `background`，Agent 应尊重该状态。CDP 通道仍是调试接口，不会自动阻止所有第三方 Agent 输入。
- 系统睡眠期间不承诺继续运行。网站自身的后台暂停逻辑、CSP 和认证行为也可能影响任务。

## 独立品牌

```bash
bl stop
bl brand --name Backlight                # 使用内置 B 图标
bl brand --name Backlight --icon logo.png # 自定义 PNG
bl launch https://example.com
```

品牌化复制 Chrome for Testing，替换应用图标、名称和 bundle id。移除 `CFBundleIconName` 对原有 Assets.car 图标的覆盖，并替换运行时 `app.icns`。不会重签浏览器或重启系统 Dock。

品牌浏览器有自己的登录存储，需要手动登录一次。`bl import --list` / `bl import` 是可选的本地 Chrome profile 导入；跨浏览器品牌的加密 cookie 不能保证可解密。

## 验证与结构

```bash
pnpm -r --if-present run check
pnpm --filter @backlight/daemon test       # 单元测试 + 串行原生浏览器集成测试
bash packages/tray/build.sh
```

所有浏览器测试仅使用已安装品牌化 Backlight.app 的相同构建副本（校验程序与图标 SHA256），不允许回退到 Google Chrome 或独立 Chrome for Testing。使用临时 profile 和独立应用路径隔离日常窗口；窗口测试由 caffeinate 包裹，部分阶段会短暂显示 Backlight 窗口。详细验收记录见 `docs/development/2026-09-13.md`。

- `packages/daemon/`：浏览器生命周期、CDP 代理、窗口恢复、捕获、健康度与开发接口。
- `packages/cli/`：`backlight` / `bl` 命令。
- `packages/tray/`：原生菜单栏与 Dock 激活处理。
- `tools/app-control.swift`：按受管 PID 激活、隐藏应用及读取运行图标。
- `PROJECT_INDEX.md`：交接入口、已验证状态与剩余边界。

实现参考：[Chromium Extensions CDP 接口](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/)、[原生 sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)。
