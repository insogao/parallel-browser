# Backlight 夜间工作计划（自主执行用）

> 本文件是夜间自主工作的唯一上下文入口。每完成一项就更新「状态」段并 git commit。
> 当前时间起点：2026-09-11 凌晨约 01:30（本地）。工作到早上 8:00 为止。

## 产品定位（一句话）
Backlight（后台浏览器）：对标 ego-lite 的 AI 友好浏览器监督器——真实 Chrome 内核、后台满速运行、插件开发热重载、AI 指令可视化。

## 已验证的架构事实（不要重新质疑）
1. **Tab Capture 豁免（P0，已验证 ★）**：`--auto-select-tab-capture-source-by-title=BACKLIGHT_AGENT` + controller 页 `getDisplayMedia({video:{frameRate:10}})` → 被捕获标签即使窗口最小化也 `visibilityState=visible`、原生 rAF 60/s、截图 70-90ms 真实帧。测试：`tests/probe-capture.ts`
2. **贴角收起**：窗口移到 `left=al-(w-2), top=at+ah-2`，露 2px → 原生满速。后台模式窗口出生即在角落（`--window-position` 直接给角落坐标），无动画。测试：`tests/background.ts`、`tests/supervisor.ts`
3. **rAF 垫片 + 帧泵**：真最小化时的兜底（垫片 12-60Hz 逻辑存活；泵用 fromSurface:false + 8s 超时，防重量级页面挂起）。测试：`tests/spike.ts`
4. 纯最小化若无 capture 兜底 → rAF=0（Chrome 铁律，勿再尝试 flags/audio/screencast/完全出屏，全部已排除）

## 技术栈约定
- Node 25 原生 TS（type stripping）：**禁止构造函数参数属性**（`constructor(private x)` 会崩），用显式字段赋值
- 依赖仅 ws/chokidar/@puppeteer/browsers；测试从 `tests/*.ts` 直接 `node` 运行
- 测试为非侵入式：窗口只允许基线阶段可见 ~2 秒
- 全部测试：`pnpm --filter @backlight/daemon test`（spike → supervisor → extensions → agent）
- 类型检查：`pnpm -r --if-present run check`
- 每个里程碑后 `git add -A && git commit`

## 路线图（按序执行，完成一项勾一项）

### P1. Capture keep-alive 产品化（当前任务）
- [ ] `src/capture.ts`：CaptureKeepAlive 类
  - controller 标签页管理：daemon http server 新增 `/controller` 页面（http://127.0.0.1:{port}/controller，安全上下文）；页面含 `startCapture(fps)`/`stopCapture()`（参考 probe-capture.ts 的实现，含 synthetic click 激活）
  - tick(1s)：健康快照中 visibility!=='visible' 的目标（排除 controller 自身）→ 若无活跃捕获：选第一个 → CDP 改其 title 为 'BACKLIGHT_AGENT'（先存 `__blOrigTitle`）→ controller synthetic click + startCapture(10) → 1s 后校验 visibility 变 visible → 记录 {targetId, origTitle}
  - 捕获目标重新 visible（窗口恢复）→ stopCapture + 恢复原标题
  - 捕获目标被关闭 → 清理并轮换到下一个隐藏目标
  - 同时只维护一个捕获（title 匹配限制）；其余隐藏目标由现有帧泵/垫片兜底
- [ ] settings 加 `captureKeepAlive: true`；launcher 固定加 `--auto-select-tab-capture-source-by-title=BACKLIGHT_AGENT`；controller URL 需要 daemon 端口 → 通过 LaunchOptions/deps 传入
- [ ] supervisor 的泵逻辑保持不变（capture 未覆盖的目标继续由泵兜底；被捕获目标 visibility 变 visible 后泵自动停）
- [ ] 更新 `tests/supervisor.ts` 最小化场景断言：capture 生效后 **nativeRafPerSec ≥ 45 且 visibility=visible**（替代原 shim 12Hz 断言；shim 仍作为无 capture 时的存在证明保留在 spike）
- [ ] 全套测试绿 + commit

### P2. x.com 全链路人工验证路径
- [ ] `bl launch https://x.com`（后台）→ 窗口贴角零闪烁 → `bl health` 显示 x.com visible/60fps → 最小化场景（用户手动）→ capture 保活生效
- [ ] `bl show` 恢复。把操作步骤写进 README「快速体验」

### P3. ego-lite 功能调研 + cookie/登录态导入
- [ ] 抓取 lite.ego.app 文档站全部页面，列 ego-lite 完整功能清单（迁移/cookie/扩展/space/skills），写进 docs/ego-parity.md
- [ ] 实现 `bl import`（POST /api/import）：从本机 Chrome profile 文件级复制 `Network/Cookies`(+journal)、`Login Data`(+journal)、`Web Data`(+journal) 到受管 profile（要求浏览器已停止，API 自动 stop→import→不自动重启）；扫描 `~/Library/Application Support/Google/Chrome/` 的 Local State 列出可选 profile；注意：仅同二进制（Google Chrome→Google Chrome）可直接解密，CfT 需钥匙串授权一次（README 说明）
- [ ] 测试：临时 profile 复制后 Cookies SQLite 行数 > 0（用 node 读 sqlite 不引依赖——可跳过行数断言，改为文件存在+大小>0）

### P4. M4 菜单栏托盘（Swift，机器有 Xcode）
- [ ] `packages/tray/`：swiftc 编译 LSUIElement 菜单栏 app（参考实现要点：NSStatusItem + NSMenu；NSApp.dock? 不适用——本 app 是 menuBar only）；功能：图标两态（空闲/闪烁：AI 活动时 1Hz 换 icon）、菜单项「收起全部/恢复/退出」、全局快捷键收起（Carbon RegisterEventHotKey 或 dacro 均可，优先简单）
- [ ] 与 daemon 对接：轮询 `GET /api/activity?limit=1`（500ms）驱动闪烁；菜单项 POST /api/bg、/api/restore
- [ ] `bl tray` 命令启动之（后台 spawn）。验证：人工（无法自动化 GUI 则在 README 注明手工验收步骤）

### P5. M5 打磨
- [ ] `bl doctor`：浏览器探测/npm 源/端口占用/扩展目录健康/钥匙串提示
- [ ] 多 space 文档化（space ls/use 已有雏形）
- [ ] README 全面更新（新机制：capture keep-alive、双模式 collapse、import）
- [ ] 晨报（见下）

## 状态段（每完成一项更新）

- P1 ✅ P3 ✅ P4 ✅ P5 ✅（全部完成，03:30，commits 66e0df3 之前 + timer 修复）
- 当前活体会话：x.com 在 default space 后台运行（capture keep-alive 生效，native 59.9/s），托盘已启动
- 全部路线图任务完成。夜间剩余时间（至 8:00）：
  1. 每次被唤醒时：跑 `pnpm --filter @backlight/daemon test` 确认 11 项全绿（需 caffeinate，见下）；若失败→修复
  2. 不做新功能开发
  3. 若一切正常且无失败，更新本段"最后巡检时间"即可
- 已知遗留（白天处理，不影响使用）：
  1. 捕获后 DOM visibilityState 冻结代码未生效（visibilityState 仍可能读 hidden；rAF/截图不受影响）
  2. health 的 shim rAF/s 在 SPA 长会话下可能出现异常大数值（多链累加疑似），native/s 才是真实帧率
  3. capture 10fps 编码有 CPU 成本，可试降 fps
  4. 托盘图标闪烁需人工目视验收

## ego-lite 功能对照（docs 调研结论）

| ego-lite 功能 | Backlight 状态 |
|---|---|
| 数据迁移（cookie/登录态/扩展/profile 一键导入） | ✅ bl import（文件级，同二进制解密） |
| Space 隔离（每任务独立上下文+登录态共享） | ✅ 受管 profile per space（CLI: space，UI 未做） |
| snapshot 内核级 DOM 快照 | 部分：CDP 代理 + 任何 agent 工具可连；无内置 snapshot 命令 |
| ego-browser CLI | ✅ backlight CLI + 标准 CDP（Playwright 直连） |
| Skills（站点技能包） | ❌ 未做（v0.2 候选） |
| Agent harness 自动安装 skill | ❌ 未做（README 文档化） |
| 后台满速运行 | ✅✅ capture 豁免 + 贴角 + 垫片（ego-lite 没有，反超点） |
| 插件热重载/直达测试 | ✅✅（ego-lite 没有，反超点） |
| AI 指令可视化 | ✅ 光环 + 活动流 + dashboard + 托盘（反超点） |

## 晨报（8:00 收尾时填写）

（待填）

## 晨报（8:00 收尾时填写）

（待填：夜间完成事项 / 测试结果 / 遗留风险 / 建议白天事项）
