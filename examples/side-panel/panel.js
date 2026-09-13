const $ = id => document.getElementById(id);
async function message(type) {
  try {
    const window = await chrome.windows.getCurrent();
    const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
    if (!tab) throw new Error('请选择一个网页');
    const result = await chrome.tabs.sendMessage(tab.id, { type });
    if (type === 'read-page') {
      $('page-title').textContent = result.title;
      $('page-url').textContent = result.url;
      $('result').textContent = `已读取 ${result.headings.length} 个标题。`;
    } else $('result').textContent = result.highlighted ? '网页标题已高亮。' : '这个网页没有一级标题。';
  } catch {
    $('result').textContent = '请打开本地演示页或 example.com。若刚重载扩展，请先刷新网页，让新的内容脚本生效。';
  }
}
$('read').onclick = () => message('read-page');
$('highlight').onclick = () => message('highlight-page');
chrome.storage.local.get('note').then(({ note }) => { $('note').value = note || ''; });
$('note').oninput = async () => {
  await chrome.storage.local.set({ note: $('note').value });
  $('saved').textContent = '已保存';
};
