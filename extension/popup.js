const REPO = 'https://github.com/BofStudios/chorus';
const RELEASES = `${REPO}/releases/latest`;

const statusEl = document.getElementById('status');
const sections = {
  ready: document.getElementById('ready'),
  pair: document.getElementById('pair'),
  install: document.getElementById('install')
};

function ask(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function show(which) {
  for (const [name, section] of Object.entries(sections)) section.hidden = name !== which;
}

function setStatus(text, tone) {
  statusEl.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = `dot ${tone || ''}`;
  statusEl.append(dot, document.createTextNode(text));
}

function relative(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function paintRecent() {
  const { sent = [] } = await chrome.storage.local.get('sent');
  const recent = document.getElementById('recent');
  recent.textContent = '';
  for (const item of sent.slice(0, 6)) {
    const row = document.createElement('div');
    const who = document.createElement('span');
    who.textContent = `@${item.login}${item.duplicate ? ' (already listed)' : ''}`;
    const when = document.createElement('span');
    when.textContent = relative(item.at);
    row.append(who, when);
    recent.appendChild(row);
  }
}

async function refresh() {
  const response = await ask({ type: 'connect' });
  const state = response?.data;

  if (state?.connected) {
    setStatus(`connected · port ${state.port}`, 'ok');
    show('ready');
    document.getElementById('count').innerHTML =
      `<b>${state.watchlist}</b> waiting in your watchlist`;
    paintRecent();
    return;
  }

  const reason = state?.reason || 'app-closed';

  if (reason === 'app-closed') {
    setStatus('desktop app not running', 'bad');
    show('install');
    return;
  }

  setStatus(reason === 'bad-token' ? 'pairing code rejected' : 'not paired yet', 'warn');
  show('pair');
}

document.getElementById('pairBtn').addEventListener('click', async () => {
  const token = document.getElementById('token').value.trim();
  const error = document.getElementById('pairErr');
  error.textContent = '';
  if (!token) {
    error.textContent = 'Paste the code from Chorus first.';
    return;
  }
  const response = await ask({ type: 'pair', token });
  if (!response?.ok || !response.data.connected) {
    error.textContent =
      response?.data?.reason === 'app-closed' ? 'Chorus is not running.' : 'That code was rejected.';
    return;
  }
  refresh();
});

document.getElementById('unpair').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token', 'port']);
  refresh();
});

// chorus:// is registered by the desktop app, so this focuses an already running
// window. If nothing handles it, the tab simply closes itself and nothing breaks.
function openDesktopApp() {
  chrome.tabs.create({ url: 'chorus://open', active: false }, (tab) => {
    if (chrome.runtime.lastError) return;
    setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 900);
  });
}

document.getElementById('openApp').addEventListener('click', () => {
  openDesktopApp();
  window.close();
});

document.getElementById('launch').addEventListener('click', () => {
  openDesktopApp();
  setTimeout(refresh, 2500);
});

document.getElementById('download').addEventListener('click', () => {
  chrome.tabs.create({ url: RELEASES });
});

document.getElementById('repo').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: REPO });
});

refresh();
