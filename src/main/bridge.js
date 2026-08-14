const http = require('http');
const crypto = require('crypto');
const { getStore } = require('./store');
const db = require('./db');

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

async function route(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${activePort}`);

  if (req.method === 'OPTIONS') return send(res, 204, {});

  // Unauthenticated: lets the extension detect the app without holding a token.
  if (url.pathname === '/ping') {
    return send(res, 200, { app: 'chorus', ok: true, paired: false });
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
