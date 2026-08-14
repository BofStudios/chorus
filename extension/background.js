// Service worker: owns the connection to the desktop app.
// The content script never talks to localhost directly — it asks for an action here.

const PORTS = [7801, 7802, 7803, 7804, 7805];

async function config() {
  const { token = '', port = null } = await chrome.storage.local.get(['token', 'port']);
  return { token, port };
}

async function request(port, path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Chorus replied ${res.status}.`);
  return json;
}

// Finds which port the app is on and confirms the token still works.
async function connect() {
  const { token } = await config();
  if (!token) return { connected: false, reason: 'no-token' };

  for (const port of PORTS) {
    try {
      const result = await request(port, '/verify', { token });
      await chrome.storage.local.set({ port });
      return { connected: true, port, watchlist: result.watchlist };
    } catch (error) {
      if (/token/i.test(error.message)) return { connected: false, reason: 'bad-token' };
      // Otherwise the app is simply not on this port; try the next one.
    }
  }
  return { connected: false, reason: 'app-closed' };
}

async function sendCandidate(payload) {
  const state = await connect();
  if (!state.connected) throw new Error(reasonText(state.reason));
  const { token } = await config();
  const result = await request(state.port, '/candidate', { token, method: 'POST', body: payload });

  const { sent = [] } = await chrome.storage.local.get('sent');
  sent.unshift({ login: payload.login, at: Date.now(), duplicate: result.duplicate });
  await chrome.storage.local.set({ sent: sent.slice(0, 20) });

  return result;
}

function reasonText(reason) {
  if (reason === 'no-token') return 'Not paired yet — open the extension and paste your pairing code.';
  if (reason === 'bad-token') return 'Pairing code rejected. Copy a fresh one from Chorus → Settings → Extension.';
  return 'Chorus is not running. Start the desktop app and try again.';
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const run = async () => {
    if (message.type === 'connect') return connect();
    if (message.type === 'send') return sendCandidate(message.payload);
    if (message.type === 'pair') {
      await chrome.storage.local.set({ token: message.token.trim() });
      return connect();
    }
    throw new Error('Unknown message.');
  };

  run()
    .then((data) => respond({ ok: true, data }))
    .catch((error) => respond({ ok: false, error: error.message }));

  return true; // keep the channel open for the async reply
});
