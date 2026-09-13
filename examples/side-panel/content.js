chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type === 'read-page') {
    reply({ title: document.title, url: location.href, headings: [...document.querySelectorAll('h1,h2')].map(el => el.textContent.trim()) });
  }
  if (message.type === 'highlight-page') {
    const heading = document.querySelector('h1');
    if (heading) { heading.style.background = '#b9f3d8'; heading.style.color = '#163d35'; heading.style.borderRadius = '8px'; }
    reply({ highlighted: !!heading });
  }
});
