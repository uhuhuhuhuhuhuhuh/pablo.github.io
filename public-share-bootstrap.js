function activateShare(tab, panel) {
  document.querySelectorAll('.tabs [data-tab]').forEach(button => button.classList.remove('active'));
  document.querySelectorAll('main > .panel').forEach(section => section.classList.remove('active'));
  tab.classList.add('active');
  panel.classList.add('active');
}

function patchAboutCopy() {
  const about = document.querySelector('#panel-about .card.help');
  if (!about) return;
  for (const p of about.querySelectorAll('p')) {
    if (p.textContent.startsWith('Public Share can hide')) {
      p.innerHTML = 'Public Share uses a self-contained <code>ICS1</code> URL fragment. The reversible payload is carried by the link itself, with optional gzip compression, SHA-256 integrity, and a random throwaway salt so repeated shares of the same bytes can have different-looking URLs.';
    } else if (p.textContent.startsWith('Everything executes as JavaScript')) {
      p.textContent = 'Everything executes as JavaScript in the browser. GitHub Pages only serves static application files; self-contained share payloads live after the URL # fragment and are not sent to GitHub as part of the HTTP request.';
    }
  }
}

function installShareShell() {
  const nav = document.querySelector('.tabs');
  const main = document.querySelector('main');
  if (!nav || !main) return;

  patchAboutCopy();

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
    panel.innerHTML = '<div class="card"><div class="notice">Loading self-contained sharing…</div></div>';
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

  import('./public-share.js?v=20260812ics1').catch(error => {
    panel.innerHTML = `<div class="card"><div class="notice error">Could not load self-contained sharing: ${String(error.message || error)}</div></div>`;
  });
}

installShareShell();
