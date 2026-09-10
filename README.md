# Backlight · 后台浏览器

一个对人和 AI Agent 都友好的「后台浏览器」：**页面在后台以原生 60fps 满速运行（连 rAF 都是原生的）**、**插件开发测试一体化**、**AI 指令实时可视化**。

对标 [ego-lite](https://github.com/citrolabs/ego-lite) 的产品体验，但架构不同：ego-lite 是 Chromium 源码 fork；Backlight 是**监督器 + 真实 Chromium 内核**——因此扩展兼容性 100%，且把 ego-lite 没有解决的两个痛点在架构层解决了。

## 它解决什么

| 痛点 | 常见浏览器/ego-lite | Backlight |
|---|---|---|
| 最小化/后台后页面停摆（rAF 暂停、动画/逻辑冻结、截图陈旧） | 存在（Chromium 后台节流） | ✅ **Tab Capture 豁免**（原生 60fps）+ 贴角 + 垫片三层保活 |
| 定时器后台降频（最慢 1 次/分钟） | 存在 | ✅ 启动参数禁用 |
| 插件开发要手动 chrome://extensions 加载、改代码手动重载 | 存在 | ✅ `bl ext add` + 文件监听热重载 |
| 想在具体网站上测插件 | 同上，费劲 | ✅ `bl open <url> --with <插件>` 一条命令 |
| AI 操作浏览器时用户无感知 | 存在 | ✅ 页面光环 + 菜单栏托盘闪烁 + 活动流 |
| 登录态要从头登录 | 存在 | ✅ `bl import` 从本机 Chrome 导入 cookie/密码/填充数据 |

## 后台保活：三层机制（实测数据，macOS Chrome 152）

Chromium 会暂停"不可见"页面的 rAF。我们的分层方案：

1. **Tab Capture 豁免（主方案）**：Chromium 官方机制——被捕获的标签页直接上报 `visible`。启动参数 `--auto-select-tab-capture-source-by-title` + 常驻 controller 页的 `getDisplayMedia()` 触发。实测：**窗口最小化后原生 rAF 60fps、截图 70-90ms 真实帧**，页面可见性语义正常
2. **贴角收起**：`bl bg` 把窗口移到屏幕角落只露 2px——Chrome 仍视为可见，原生满速；`bl show` 恢复
3. **rAF 垫片 + 帧泵**（兜底）：垫片把隐藏页面的 rAF 重定向到 Worker 定时器（逻辑 12-60Hz 存活）；帧泵对轻量页面强制出帧

已知边界：被捕获标签的 DOM `visibilityState` 个别时序下仍可能读 `hidden`（rAF/截图不受影响）。

## 快速开始

```bash
pnpm install
alias bl="node $(pwd)/packages/cli/bin/backlight.js"

bl import                    # 一键导入本机 Chrome 的 cookie/登录态（选 profile）
bl launch https://x.com      # 后台启动 x.com —— 不弹窗、不抢焦点、已登录
bl show                      # 想看页面时恢复窗口
bl bg                        # 一键收起到后台（页面满速继续）
bl status / bl health        # 状态 / 各标签页后台健康度
bl tray                      # 菜单栏托盘（AI 指令时图标闪烁）
bl doctor                    # 环境体检
bl stop
```

控制台 Dashboard：`http://127.0.0.1:9333/`——实时活动流 + 后台健康度表格。

## 插件开发循环

```bash
bl ext add ~/dev/my-extension            # 注册未打包扩展（读 manifest name）
bl launch --with my-extension            # 带插件启动
bl open taobao.com --with my-extension   # 带插件直达目标网站
# ... 修改扩展源码，保存后自动热重载（浏览器重启、标签恢复，约 3s）
bl ext ls / bl ext rm my-extension
```

说明：Google Chrome 136+ 忽略 `--load-extension`。检测到「品牌版 Chrome + 需要加载扩展」时，Backlight 自动下载 **Chrome for Testing**（支持 `--load-extension`，内核与稳定版一致）。下载源可用 `BACKLIGHT_DOWNLOAD_BASE_URL` 指向镜像。

## AI / Agent 接入

内置 **CDP 代理**（默认 `127.0.0.1:9333`），字节级透传 + 指令打点：

```js
// Playwright
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
// Puppeteer
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333' })
```

每条 AI 指令（Input.* / Runtime.evaluate / Page.navigate / 截图…）→ 事件流广播（`ws://127.0.0.1:9333/activity`）+ Dashboard 活动面板 + 页面光环。指令被归因到具体标签页。

## 架构

```
packages/
  daemon/   监督器：浏览器生命周期、capture/贴角/垫片三层保活、CDP 代理、活动总线、扩展管理、健康监测、Dashboard
  cli/      backlight (bl) 命令行
  tray/     Swift 菜单栏托盘（swiftc 编译，无 Electron）
tools/      winlist（CGWindowList 检测在屏窗口，测试用）
```

数据目录：`~/Library/Application Support/Backlight/`（`BACKLIGHT_HOME` 可覆盖）。

## 测试（全程非侵入）

```bash
pnpm --filter @backlight/daemon test
# spike.ts        三层保活机制对照实验
# supervisor.ts   贴角/捕获/恢复 e2e
# extensions.ts   插件注册→加载→内容脚本→热重载 e2e
# agent.ts        CDP 代理透明性 + 活动流 + 光环 e2e
# background.ts   后台优先启动 e2e
# import.ts       cookie 导入 e2e
```

测试已用 `caffeinate` 包裹防止显示器睡眠影响结果；窗口只在基线阶段出现约 2 秒，其余时间最小化/贴角。

## 路线图

- [ ] 捕获后 DOM visibilityState 冻结（细节打磨）
- [ ] 多标签并发 capture（tabCapture 扩展或小 fork：给每个 Agent WebContents 持有 capture token）
- [ ] space 管理 UI、`snapshot` 内置命令、站点技能包（对标 ego-lite Skills）
- [ ] `npm i -g` 全局安装打包

## License

MIT（本项目代码；浏览器使用用户已安装的 Chrome/Chromium 或自动下载的 Chrome for Testing，不做任何分发）
