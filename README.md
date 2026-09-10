# Backlight · 后台浏览器

一个对人和 AI Agent 都友好的「后台浏览器」：**窗口最小化后页面照常满速运行**、**插件（Chrome 扩展）开发测试一体化**、**AI 指令实时可视化**。

对标 [ego-lite](https://github.com/citrolabs/ego-lite) 的产品体验，但架构不同：ego-lite 是 Chromium 源码 fork；Backlight 是**监督器 + 真实 Chromium 内核**——因此扩展兼容性 100%，且把 ego-lite 没有解决的两个痛点在架构层解决了。

## 它解决什么

| 痛点 | 常见浏览器/ego-lite | Backlight |
|---|---|---|
| 窗口最小化后页面停摆（rAF 暂停、动画/逻辑冻结、截图陈旧） | 存在（Chromium 后台节流） | ✅ 帧泵保活（下述） |
| 定时器后台降频（最慢 1 次/分钟） | 存在 | ✅ 启动参数禁用 |
| 插件开发要手动 chrome://extensions 加载、改代码要手动重载 | 存在 | ✅ `bl ext add` + 文件监听热重载 |
| 想在具体网站上测插件 | 同上，费劲 | ✅ `bl open <url> --with <插件>` 一条命令 |
| AI 操作浏览器时用户无感知 | 存在 | ✅ 页面光环脉冲 + 活动流 |

## 核心机制：帧泵（frame pump）

经实测（macOS，Chrome 152）：

- 最小化/遮挡/后台标签页 → Chromium 暂停 `requestAnimationFrame`（rAF），**没有任何启动参数能阻止这一点**
- `--disable-background-timer-throttling` 等参数只能保住定时器（已验证）
- CDP 无法把窗口移出屏幕（macOS 会钳制回屏幕内，实测）
- **但 `Page.captureScreenshot` 会强制出帧**，从而驱动 rAF

所以 Backlight 的监督器对所有「不可见」页面（最小化、被遮挡、后台标签）以 10fps（可调）做帧泵，实测效果：

| 状态 | rAF | 定时器 |
|---|---|---|
| 前台基线 | 60/s | 10/s |
| 最小化·无泵 | 0/s（冻结） | 10/s |
| **最小化·帧泵** | **30–45/s 稳定** | 10/s |
| 恢复前台 | 60/s | 10/s |

窗口行为完全原生（怎么最小化就怎么最小化），用户无感知差异。

已知限制：页面内 `document.visibilityState` 仍为 `hidden`，依赖 visibilitychange 暂停的逻辑（如部分视频自动暂停）不会被绕过——这是浏览器安全边界，帧泵不伪装可见性。

## 快速开始

```bash
pnpm install
alias bl="node $(pwd)/packages/cli/bin/backlight.js"

bl launch                 # 启动（首次会用本机 Chrome）
bl launch example.com     # 启动并打开网页
bl status                 # 状态
bl bg                     # 一键收起全部窗口到后台（页面满速继续）
bl restore                # 恢复窗口
bl health                 # 各标签页后台健康度（rAF/定时器实时速率）
bl stop
```

控制台（Dashboard）：`bl status` 里的端口，即 `http://127.0.0.1:9333/`——实时活动流 + 后台健康度表格。

## 插件开发循环

```bash
bl ext add ~/dev/my-extension            # 注册未打包扩展（读 manifest name）
bl launch --with my-extension            # 带插件启动
bl open taobao.com --with my-extension   # 带插件直达目标网站
# ... 修改扩展源码，保存后自动热重载（浏览器重启、标签恢复，约 3s）
bl ext ls
bl ext rm my-extension
```

说明：Google Chrome 136+ 出于安全忽略了 `--load-extension`。当检测到「品牌版 Chrome + 需要加载扩展」时，Backlight 会自动下载 **Chrome for Testing**（支持 `--load-extension`，内核与稳定版一致）并缓存到数据目录，也可用 `BACKLIGHT_DOWNLOAD_BASE_URL` 指定镜像。

## AI / Agent 接入

Backlight 内置 **CDP 代理**（默认 `127.0.0.1:9333`），任何会说 CDP 的工具即插即用：

```js
// Playwright
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
// Puppeteer
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333' })
```

代理是**字节级透传**（不解析 payload，只读方法名打点），对上层工具零干扰；同时：

- 每条 AI 指令（Input.* / Runtime.evaluate / Page.navigate / 截图…）→ 事件流广播（`ws://127.0.0.1:9333/activity`）+ Dashboard 活动面板
- 指令作用到的页面会闪一圈**青色光环**（可 `bl` 设置关闭：POST /api/settings `{halo:false}`）
- 指令被归因到具体标签页（flat session → targetId 映射）

## 架构

```
packages/
  daemon/   监督器：浏览器生命周期、帧泵、CDP 代理、活动总线、扩展管理、健康监测、Dashboard
  cli/      backlight (bl) 命令行
```

- **launcher**：探测本机 Chrome/Chromium/Edge/Brave；每个 space 一个受管 profile（登录态持久，对标 ego-lite 的 task space）
- **启动参数**：`--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`
- **帧泵监督器**：500ms 轮询健康快照，对不可见页面维持 10fps 帧泵
- **CDP 代理**：HTTP(/json/*，重写 webSocketDebuggerUrl) + WebSocket 透传 + tap 打点
- **健康监测**：向每个页面注入幂等计数器（rAF/timer/visibility），2s 采样，Dashboard 展示「满速/被节流」
- **扩展管理**：注册表 + chokidar 监听 + 防抖热重载（保留标签页）

数据目录：`~/Library/Application Support/Backlight/`（`BACKLIGHT_HOME` 可覆盖）。

## 测试（全程非侵入）

所有自动化测试的窗口只在开头基线阶段出现约 2 秒，其余时间处于最小化状态：

```bash
pnpm --filter @backlight/daemon test
# spike.ts        帧泵机制矩阵验证（对照实验）
# supervisor.ts   收起/泵/恢复/后台标签 e2e
# extensions.ts   插件注册→加载→内容脚本→热重载 e2e
# agent.ts        CDP 代理透明性 + 活动流 + 光环 e2e
```

## 路线图

- [ ] M4: 菜单栏托盘（AI 指令时图标闪烁、一键收起全局快捷键、Dock badge）
- [ ] M5: doctor 体检、多 space 管理、npm 全局安装打包
- [ ] Halo 样式自定义、帧泵自适应频率（多标签省电）

## License

MIT（本项目代码；浏览器本体使用用户已安装的 Chrome/Chromium，不做任何分发）
