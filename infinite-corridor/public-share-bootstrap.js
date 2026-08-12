function activateShare(tab, panel) {
  document.querySelectorAll('.tabs [data-tab]').forEach(button => button.classList.remove('active'));
  document.querySelectorAll('main > .panel').forEach(section => section.classList.remove('active'));
  tab.classList.add('active');
  panel.classList.add('active');
}

function installShareShell() {
  const nav = document.querySelector('.tabs');
  const main = document.querySelector('main');
  if (!nav || !main) return;

  let tab = nav.querySelector('[data-tab="share"]');
  if (!tab) {
    tab = document.createElement('button');
    tab.dataset.tab = 'share';
    tab.textContent = 'Public Share';
    const about = nav.querySelector('[data-tab="about"]');
    nav.insertBefore(tab, about || null);
  }

  let panel = document.querySelector('#panel-share');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'panel-share';
    panel.className = 'panel';
    panel.innerHTML = '<div class="card"><div class="notice">Loading public sharing…</div></div>';
    const aboutPanel = document.querySelector('#panel-about');
    main.insertBefore(panel, aboutPanel || null);
  }

  tab.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    activateShare(tab, panel);
  });

  nav.querySelectorAll('[data-tab]:not([data-tab="share"])').forEach(button => {
    button.addEventListener('click', () => {
      tab.classList.remove('active');
      panel.classList.remove('active');
    });
  });

  import('./public-share.js?v=20260812share1').catch(error => {
    panel.innerHTML = `<div class="card"><div class="notice error">Could not load public sharing: ${String(error.message || error)}</div></div>`;
  });
}

installShareShell();
