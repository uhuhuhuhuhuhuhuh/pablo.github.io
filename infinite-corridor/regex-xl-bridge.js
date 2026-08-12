const $ = (s) => document.querySelector(s);

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
    button.className = 'secondary';
    button.textContent = 'Open in XL';
    button.addEventListener('click', () => {
      const input = $('#xl-address-input');
      if (!input) return;
      input.value = address;
      document.querySelector('[data-tab="xl"]')?.click();
      requestAnimationFrame(() => $('#xl-load-address')?.click());
    });
    row.appendChild(button);
  });
}

const target = $('#regex-results');
if (target) {
  new MutationObserver(installOpenButtons).observe(target, { childList: true, subtree: true });
  installOpenButtons();
}
