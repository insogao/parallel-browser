# Backlight 侧栏示例

在项目根目录执行：

```bash
node packages/cli/bin/backlight.js ext add "$PWD/examples/side-panel" --name demo
node packages/cli/bin/backlight.js ext dev demo http://127.0.0.1:9333/demo
```

“读取网页”通过内容脚本读取标题；“高亮标题”会修改目标网页的 h1；笔记使用 chrome.storage.local 自动保存。

示例匹配本机 HTTP 页面和 https://example.com。修改内容脚本后需刷新网页，修改侧栏后重新打开。调试入口见控制台的目标列表，或 `bl targets` / `bl inspect <targetId>`。
