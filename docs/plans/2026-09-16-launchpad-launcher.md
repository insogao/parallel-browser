# macOS Launchpad 入口（Backlight 启动器）实现计划

更新时间：2026-09-16。工作分支：`codex/window-state-throttle-test`（隔离 worktree）。本轮交付一个可在 macOS Launchpad 中发现、点击后经 daemon 受管路径接管浏览器的独立启动器；**不**直接暴露或复制品牌化的隐藏引擎 app。

## 目标

1. 用户在 Launchpad 点击 Backlight 后：确保 daemon 运行 → 确保选中品牌化 Backlight 引擎 → 启动或复用受管默认 space/profile → 显示并最大化受管浏览器，供人工登录。
2. 连续/并发点击幂等：已在运行则只 focus/show/maximize，不产生未受管实例、不产生第二个 daemon。
3. 启动器安装在 `~/Applications/Backlight.app`（无需 sudo，Launchpad 可索引），与隐藏引擎 `~/Library/Application Support/Backlight/apps/Backlight.app` 的 bundle id/名称/路径均不冲突，也不会递归启动自己。
4. 启动器不依赖当前 worktree 绝对路径：`bl launcher install` 会把运行所需的最小快照安装到 `~/Library/Application Support/Backlight/runtime/`，启动器只调用该稳定路径。
5. 点击后无终端窗口；日志写入 `~/Library/Application Support/Backlight/logs/launcher.log`。

## 设计

- **启动器 app（`packages/launcher/main.swift`，Swift/Foundation）**：读取 bundle 内 `Contents/Resources/launcher.json`，以 `Process`（无 shell、参数数组，路径含空格安全）执行 `<node> <runtime>/packages/cli/bin/backlight.js login`，输出重定向到 launcher.log（`O_APPEND`，多进程追加不覆盖），随后立即退出。支持 `--print-config` 与 `--selftest`（只校验 node/CLI/引擎/日志目录，不启动 daemon/浏览器）。
- **安装/校验（`packages/daemon/src/launcher.ts`）**：
  - `findBrandedEngines()`：只认 bundle id `dev.backlight.browser` 且 executable 存在的 `.app`；`Backlight.app` 优先。
  - `selectBrandedEngineSetting()`：settings.browser 已是品牌引擎则 no-op；否则写入品牌引擎（仅改这一项，其余设置保持用户值）。
  - `installRuntime()`：复制 `packages/{cli,daemon,launcher,tray}`、`tools/app-control.swift`、`node_modules`（保留 pnpm 相对 symlink，过滤 typescript/@types 等仅开发依赖）到 staging，校验后整目录 rename 原子替换；manifest 记录版本与来源。
  - `buildLauncherApp()`：swiftc 编译、复用引擎 `backlight.icns`、写 Info.plist（稳定 bundle id `dev.backlight.launcher`）与 launcher.json、plutil 校验、ad-hoc codesign。
  - `installLauncher()`：先做“非本启动器拒绝覆盖”检查，再 staging 构建 + rename 替换（保留旧 bundle 直到新 bundle 就位），`lsregister -f` 注册；不触碰引擎 app。
  - `verifyLauncher()`：结构/plist/bundle id/executable/icon/runtime 目标/参数/引擎区分/`codesign --verify` 逐项报告；`bl launcher status` 以退出码体现。
- **点击路径（daemon）**：新增 `POST /api/login`（`packages/daemon/src/proxy.ts`）。选择品牌引擎 → 若浏览器未运行则 `launch({ focus: true })`（可见启动，默认 space）→ `restoreAll(maximize=true)` + 原生 activate。浏览器已在运行则只 show/maximize；**不**终止以其他引擎运行的活跃会话，只在返回 note 中说明。同一 server 内在途 login 共享一个 promise，重复/并发点击只启动一次。
- **单实例 daemon（`packages/daemon/src/single-instance.ts`）**：CLI `ensureDaemon()` 用 mkdir 锁串行化快速连续启动（15s 陈旧锁可接管），daemon 启动时若 daemon.json 指向存活进程则直接退出，避免双击产生两个 daemon。
- **CLI**：`bl login`（点击同路径）、`bl launcher install|status|uninstall`（安装/刷新、校验、移除；`--apps-dir` 供测试，`--purge` 同时删除 runtime）。

## 验收（非 GUI，已执行）

```bash
pnpm -r --if-present run check
pnpm --filter @backlight/daemon test:unit            # 56/56 + brand 11 项
node --test packages/daemon/tests/launcher-unit.ts   # 12 项确定性测试
git diff --check

node packages/cli/bin/backlight.js launcher install   # 安装/刷新（重复执行验证替换安全）
node packages/cli/bin/backlight.js launcher status
plutil -lint ~/Applications/Backlight.app/Contents/Info.plist
codesign --verify --verbose=2 ~/Applications/Backlight.app
lsregister -dump | grep dev.backlight.launcher
mdfind "kMDItemCFBundleIdentifier == 'dev.backlight.launcher'"
~/Applications/Backlight.app/Contents/MacOS/Backlight --selftest
```

确定性测试覆盖：bundle 构造/Info.plist/图标、launcher 目标与参数（`cli` 指向 runtime、`args=["login"]`）、含空格路径、安装幂等与原子替换、拒绝覆盖外来 app、引擎与启动器 bundle id/路径区分、runtime 快照（symlink/裁剪/重复安装/依赖可加载）、`/api/login` 行为（选引擎、launch 一次、并发共享、不杀异引擎会话）、单实例锁。

## 约束与剩余人工验收

- **物理 Launchpad 点击与真实登录**：不自动化。2026-09-16 13:25:59 CST 观察到一次由外部（非本实现会话）触发的真实点击：launcher.log 记录 `click: ... backlight.js login`，daemon 随即启动、品牌引擎以默认 space 可见启动并 `restored 1 window(s) maximized`。本会话未执行该点击，最终“点击 + 登录体验”仍标记待人工确认。
- 引擎/运行时不重签名（避免破坏 JIT）；启动器 ad-hoc 签名。
- runtime 快照随源码更新需重跑 `bl launcher install`；Node 路径在安装时记录（含 `/opt/homebrew/bin/node`、`/usr/local/bin/node` 回退）。
- 不覆盖任何非本启动器的 `~/Applications/Backlight.app`；replacement 前先读取并核验 bundle id。

## 禁止事项

- 不得把隐藏引擎 `apps/Backlight.app` 直接复制/暴露为启动台入口；不得让启动器指向引擎 app 或自己。
- 不得使用 sudo；不得覆盖无关用户 app；不得删除用户 runtime/引擎以外的数据。
- 不改变既有后台语义：`launchMode` 默认仍为 `background`、`collapseMode` 默认仍为 `minimize`、capture 保活不变。
- 没有实际执行的人工点击/登录，不得写成已验收。
