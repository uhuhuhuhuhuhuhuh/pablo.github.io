function loadXlDeepLink() {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return;

  const params = new URLSearchParams(raw);
  if (params.get('tab') !== 'xl') return;

  const recipe = params.get('recipe') || '';
  if (!recipe.startsWith('ICXL1:') && !recipe.startsWith('ICFMT1:')) return;

  const tab = document.querySelector('[data-tab="xl"]');
  const input = document.querySelector('#xl-address-input');
  const loadButton = document.querySelector('#xl-load-address');
  if (!tab || !input || !loadButton) return;

  tab.click();
  input.value = recipe;
  loadButton.click();
}

import('./public-share-bootstrap.js?v=20260812ics1').catch(error => {
  console.error('Could not load Public Share:', error);
});

if (document.readyState === 'complete') loadXlDeepLink();
else window.addEventListener('load', loadXlDeepLink, { once: true });
