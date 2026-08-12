function openRecipeInNewTab(address) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams();
  params.set('tab', 'xl');
  params.set('recipe', address);
  url.hash = params.toString();
  window.open(url.toString(), '_blank', 'noopener,noreferrer');
}

function installOpenButtons() {
  document.querySelectorAll('#regex-results article.regex-result').forEach(article => {
    if (article.dataset.xlBridge === '1') return;
    const code = article.querySelector('code[title]');
    const address = code?.getAttribute('title') || '';
    if (!address.startsWith('ICXL1:') && !address.startsWith('ICFMT1:')) return;
    article.dataset.xlBridge = '1';

    const row = article.querySelector('.button-row');
    if (!row) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Open XL in new tab';
    button.title = 'Open this recipe in a separate XL Objects tab';
    button.addEventListener('click', () => openRecipeInNewTab(address));
    row.appendChild(button);
  });
}

const target = document.querySelector('#regex-results');
if (target) {
  new MutationObserver(installOpenButtons).observe(target, { childList: true, subtree: true });
  installOpenButtons();
}
