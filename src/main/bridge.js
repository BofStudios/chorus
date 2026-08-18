const http = require('http');
const crypto = require('crypto');
const { getStore } = require('./store');
const db = require('./db');
const integrations = require('./integrations');
const github = require('./sources/github');
const readiness = require('./outreach/readiness');

// Local bridge for the Chrome extension.
//
// Bound to 127.0.0.1 only — never reachable from the network. Every route except
// /ping requires the pairing token, which the user copies out of the app once.
// The extension can only ever hand a candidate over; it cannot read campaigns,
// trigger research, or make the app send anything.

const PORT_RANGE = [7801, 7802, 7803, 7804, 7805];

let server = null;
let activePort = null;
let onUpdate = () => {};

function token() {
  const store = getStore();
  let value = store.getSecret('bridgeToken');
  if (!value) {
    value = crypto.randomBytes(16).toString('hex');
    store.setSecret('bridgeToken', value);
  }
  return value;
}

function rotateToken() {
  const store = getStore();
  store.setSecret('bridgeToken', '');
  return token();
}

function send(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function authorised(req) {
  const header = req.headers.authorization || '';
  const provided = header.replace(/^Bearer\s+/i, '').trim();
  const expected = token();
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function sanitiseCandidate(payload) {
  const login = String(payload.login || '').trim();
  if (!/^[\w-]{1,39}$/.test(login)) throw new Error('Invalid GitHub login.');

  const url = String(payload.url || '');
  if (url && !/^https:\/\/(www\.)?github\.com\//i.test(url)) throw new Error('Source URL must be on github.com.');

  return {
    login,
    url,
    context: String(payload.context || '').slice(0, 300),
    note: String(payload.note || '').slice(0, 300),
    addedAt: new Date().toISOString()
  };
}

// Rendered in the user's browser after the provider redirects back. Kept plain
// and self-closing so nobody is left staring at a blank tab.
function oauthPage({ ok, title, detail }) {
  const accent = ok ? '#3ddc91' : '#ff6b6b';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Chorus</title>
<style>
 body{margin:0;height:100vh;display:grid;place-items:center;background:#08090d;color:#eceef2;
      font:15px/1.6 "Segoe UI",system-ui,sans-serif}
 .card{max-width:420px;padding:32px;text-align:center}
 .dot{width:44px;height:44px;border-radius:50%;background:${accent}1f;border:1px solid ${accent};
      display:grid;place-items:center;margin:0 auto 18px;color:${accent};font-size:22px}
 h1{font-size:18px;margin:0 0 8px;font-weight:620}
 p{color:#9aa2b1;margin:0;font-size:13.5px}
 small{display:block;margin-top:18px;color:#656d7d;font-size:12px}
</style></head><body><div class="card">
 <div class="dot">${ok ? '✓' : '!'}</div>
 <h1>${title}</h1><p>${detail}</p>
 <small>You can close this tab and return to Chorus.</small>
</div></body></html>`;
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

async function handleOAuthCallback(url, res) {
  const providerId = url.pathname.split('/').filter(Boolean).pop();
  try {
    const result = await integrations.completeConnection({
      providerId,
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
      errorDescription: url.searchParams.get('error_description')
    });
    onUpdate();
    return sendHtml(
      res,
      200,
      oauthPage({
        ok: true,
        title: `${result.providerLabel} connected`,
        detail: result.username ? `Signed in as ${result.username}.` : 'The account is now available in Chorus.'
      })
    );
  } catch (error) {
    onUpdate();
    return sendHtml(
      res,
      400,
      oauthPage({
        ok: false,
        title: 'Could not finish connecting',
        detail: error.message || 'The authorisation failed.'
      })
    );
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${activePort}`);

  if (req.method === 'OPTIONS') return send(res, 204, {});

  // Unauthenticated: lets the extension detect the app without holding a token.
  if (url.pathname === '/ping') {
    return send(res, 200, { app: 'chorus', ok: true, paired: false });
  }

  // OAuth redirect target. Cannot carry the pairing token — the provider sends
  // the user here. It is guarded instead by the single-use `state` value, which
  // only this process could have generated.
  if (url.pathname.startsWith('/oauth/callback/')) {
    return handleOAuthCallback(url, res);
  }

  if (!authorised(req)) {
    return send(res, 401, { error: 'Pairing token missing or wrong. Copy it from Chorus → Settings → Extension.' });
  }

  if (url.pathname === '/verify') {
    return send(res, 200, { app: 'chorus', ok: true, paired: true, watchlist: db.watchlist().length });
  }

  if (url.pathname === '/candidate' && req.method === 'POST') {
    const body = await readBody(req);
    const candidate = sanitiseCandidate(body);
    const result = db.addToWatchlist(candidate);
    onUpdate();
    return send(res, result.added ? 201 : 200, {
      ok: true,
      added: result.added,
      duplicate: !result.added,
      contactedBefore: result.contactedBefore,
      total: db.watchlist().length
    });
  }

  if (url.pathname === '/watchlist' && req.method === 'GET') {
    return send(res, 200, { items: db.watchlist().slice(0, 50) });
  }

  // Judge someone's public repositories. Listing them needs no permission, so
  // this works with the research token and needs no GitHub OAuth app — the
  // extension only has to say whose profile you are looking at.
  if (url.pathname === '/repos/analyse' && req.method === 'POST') {
    const body = await readBody(req);
    const login = String(body.login || '').trim();
    if (!/^[\w-]{1,39}$/.test(login)) {
      return send(res, 400, { error: 'That is not a valid GitHub username.' });
    }

    try {
      const repos = await github.reposForReadiness(login, { limit: 30 });
      const suggestion = readiness.suggest(repos);
      return send(res, 200, { ok: true, login, ...suggestion });
    } catch (error) {
      return send(res, 502, {
        error:
          error.status === 404
            ? `GitHub has no user called ${login}.`
            : error.message || 'Could not read those repositories.'
      });
    }
  }

  return send(res, 404, { error: 'Unknown endpoint.' });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const instance = http.createServer((req, res) => {
      route(req, res).catch((error) => send(res, 400, { error: error.message }));
    });
    instance.on('error', reject);
    instance.listen(port, '127.0.0.1', () => resolve(instance));
  });
}

async function startBridge(notify) {
  if (server) return { port: activePort, token: token() };
  onUpdate = notify || (() => {});

  for (const port of PORT_RANGE) {
    try {
      server = await listen(port);
      activePort = port;
      // OAuth redirect URIs are built from the port we actually bound.
      integrations.setCallbackPort(port);
      return { port, token: token() };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No free port in ${PORT_RANGE[0]}–${PORT_RANGE[PORT_RANGE.length - 1]} for the extension bridge.`);
}

function stopBridge() {
  if (server) {
    server.close();
    server = null;
    activePort = null;
  }
}

function status() {
  return {
    running: Boolean(server),
    port: activePort,
    token: token(),
    watchlist: db.watchlist().length
  };
}

module.exports = { startBridge, stopBridge, status, rotateToken };
